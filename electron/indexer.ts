import * as fs from 'fs';
import * as path from 'path';
import { claudeProjectsDir } from './paths';
import {
  knownFileFingerprint,
  upsertProject,
  upsertSession,
  SessionRow,
  getDb,
} from './db';
import { isSafeId, isSafeAbsolutePath, clampString, assertWithin } from './validation';

const TAIL_BYTES = 8 * 1024;
const HEAD_BYTES = 16 * 1024;

// Reject JSONL files larger than 50 MB before parsing — prevents a
// malicious JSONL drop from making countLines() (which scans the full file)
// turn every chokidar event into a multi-second read.
const MAX_INDEXABLE_SIZE = 50 * 1024 * 1024;

// Caps on user-influenced strings that survive into the DB. Stop a malicious
// JSONL from filling the row with megabytes of text.
const MAX_BRANCH_LEN = 256;
const MAX_VERSION_LEN = 64;
const MAX_CWD_LEN = 4096;

interface ParsedHeader {
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  firstTs?: number;
}

interface ParsedTail {
  lastTs?: number;
  preview?: string;
}

function readHead(filePath: string, bytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(filePath: string, fileSize: number, bytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = Math.max(0, fileSize - bytes);
    const len = fileSize - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function safeParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseTimestamp(t: unknown): number | undefined {
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

// Validation seam. Strings from the JSONL header are attacker-influenced
// (anything running as the user can drop a file into ~/.claude/projects).
// Drop fields that fail; the row will fall back to safe defaults.
function parseHead(text: string): ParsedHeader {
  const out: ParsedHeader = {};
  const lines = text.split('\n');
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const obj = safeParse(raw);
    if (!obj) continue;
    if (!out.sessionId && isSafeId(obj.sessionId)) out.sessionId = obj.sessionId;
    if (!out.cwd && typeof obj.cwd === 'string' && obj.cwd.length <= MAX_CWD_LEN
        && !obj.cwd.includes('\0') && !obj.cwd.includes('\n') && !obj.cwd.includes('\r')) {
      out.cwd = obj.cwd;
    }
    if (!out.version) {
      const v = clampString(obj.version, MAX_VERSION_LEN);
      if (v) out.version = v;
    }
    if (!out.gitBranch) {
      const b = clampString(obj.gitBranch, MAX_BRANCH_LEN);
      if (b) out.gitBranch = b;
    }
    const ts = parseTimestamp(obj.timestamp);
    if (ts && (!out.firstTs || ts < out.firstTs)) out.firstTs = ts;
    if (out.sessionId && out.cwd && out.firstTs) break;
  }
  return out;
}

function extractText(obj: any): string | undefined {
  if (!obj || typeof obj !== 'object') return;
  const m = obj.message;
  if (!m) return;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim()) {
        return c.text;
      }
    }
  }
}

function parseTail(text: string): ParsedTail {
  const out: ParsedTail = {};
  // Walk lines from end to start, looking for a user-message text and last timestamp.
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeParse(lines[i]);
    if (!obj) continue;
    if (!out.lastTs) {
      const ts = parseTimestamp(obj.timestamp);
      if (ts) out.lastTs = ts;
    }
    if (!out.preview) {
      const role = obj.message?.role ?? obj.role;
      if (role === 'user' || role === 'assistant') {
        const t = extractText(obj);
        if (t) out.preview = t.replace(/\s+/g, ' ').slice(0, 240);
      }
    }
    if (out.lastTs && out.preview) break;
  }
  return out;
}

function countLines(filePath: string): number {
  // Lightweight line count via byte scan; avoids JSON parse.
  let count = 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) count++;
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

export interface ReindexResult {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

// Derive a session id from the JSONL filename; reject anything that doesn't
// pass our safe-id regex. Returning undefined causes the caller to skip.
function idFromFilename(name: string): string | undefined {
  const stem = name.replace(/\.jsonl$/, '');
  return isSafeId(stem) ? stem : undefined;
}

export async function reindexAll(): Promise<ReindexResult> {
  const result: ReindexResult = { scanned: 0, added: 0, updated: 0, unchanged: 0, skipped: 0 };

  if (!fs.existsSync(claudeProjectsDir)) {
    return result;
  }

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  const tx = getDb().transaction(() => {
    for (const pd of projectDirs) {
      if (!pd.isDirectory()) continue;
      // Reject symlinked project directories — a symlink pointing outside
      // claudeProjectsDir would let us index arbitrary files.
      if (pd.isSymbolicLink && pd.isSymbolicLink()) continue;
      const encodedDir = pd.name;
      let projectPath: string;
      try {
        projectPath = assertWithin(
          claudeProjectsDir,
          path.join(claudeProjectsDir, encodedDir),
          'projectPath',
        );
      } catch {
        result.skipped++;
        continue;
      }

      // Defense in depth: even with the assertWithin check, reject if the
      // entry on disk is now a symlink (TOCTOU between readdir and stat).
      try {
        const lst = fs.lstatSync(projectPath);
        if (lst.isSymbolicLink()) {
          result.skipped++;
          continue;
        }
      } catch {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
      if (!jsonlFiles.length) continue;

      let projectCwd: string | undefined;

      for (const f of jsonlFiles) {
        result.scanned++;
        let filePath: string;
        try {
          filePath = assertWithin(projectPath, path.join(projectPath, f.name), 'filePath');
        } catch {
          result.skipped++;
          continue;
        }
        const id = idFromFilename(f.name);
        if (!id) {
          result.skipped++;
          continue;
        }

        let stat: fs.Stats;
        try {
          // lstat first — refuse to follow symlinks.
          const lst = fs.lstatSync(filePath);
          if (lst.isSymbolicLink()) {
            result.skipped++;
            continue;
          }
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }

        // Size gate: refuse to fully scan absurdly large JSONL files.
        if (stat.size > MAX_INDEXABLE_SIZE) {
          result.skipped++;
          continue;
        }

        const known = knownFileFingerprint(id);
        if (known && known.mtime === stat.mtimeMs && known.size === stat.size) {
          result.unchanged++;
          continue;
        }

        // Stage 2: parse head + tail.
        const head = readHead(filePath, Math.min(HEAD_BYTES, stat.size));
        const headParsed = parseHead(head);
        const tail = readTail(
          filePath,
          stat.size,
          Math.min(TAIL_BYTES, stat.size),
        );
        const tailParsed = parseTail(tail);
        const msgCount = countLines(filePath);

        // Use parsed cwd only if it passed validation in parseHead.
        const cwd = headParsed.cwd ?? '';
        if (cwd && !projectCwd) projectCwd = cwd;

        const row: SessionRow = {
          id,
          cwd: cwd || encodedDir, // fallback so we can still display orphans
          encoded_dir: encodedDir,
          file_path: filePath,
          first_ts: headParsed.firstTs ?? null,
          last_ts: tailParsed.lastTs ?? headParsed.firstTs ?? null,
          msg_count: msgCount,
          preview: tailParsed.preview ?? null,
          version: headParsed.version ?? null,
          git_branch: headParsed.gitBranch ?? null,
          file_mtime: stat.mtimeMs,
          file_size: stat.size,
          deleted_at: null,
          trash_path: null,
        };
        upsertSession(row);
        if (known) result.updated++;
        else result.added++;
      }

      if (projectCwd) {
        const exists = isSafeAbsolutePath(projectCwd) && fs.existsSync(projectCwd);
        upsertProject(projectCwd, encodedDir, exists);
      } else {
        // No cwd parsed; treat the encoded_dir as the project key.
        upsertProject(encodedDir, encodedDir, false);
      }
    }
  });

  tx();
  return result;
}

export function reindexFile(filePath: string): boolean {
  // Defense in depth: this function is called from the chokidar watcher,
  // so the path arrived from a file event in claudeProjectsDir. Containment
  // + symlink check + size gate must all pass before we read the file.
  let safePath: string;
  try {
    safePath = assertWithin(claudeProjectsDir, filePath, 'reindexFile filePath');
  } catch {
    return false;
  }
  const encodedDir = path.basename(path.dirname(safePath));
  const id = idFromFilename(path.basename(safePath));
  if (!id) return false;
  let stat: fs.Stats;
  try {
    const lst = fs.lstatSync(safePath);
    if (lst.isSymbolicLink()) return false;
    stat = fs.statSync(safePath);
  } catch {
    return false;
  }
  if (stat.size > MAX_INDEXABLE_SIZE) return false;
  filePath = safePath;
  const head = readHead(filePath, Math.min(HEAD_BYTES, stat.size));
  const headParsed = parseHead(head);
  const tail = readTail(filePath, stat.size, Math.min(TAIL_BYTES, stat.size));
  const tailParsed = parseTail(tail);
  const msgCount = countLines(filePath);
  const cwd = headParsed.cwd ?? encodedDir;
  upsertSession({
    id,
    cwd,
    encoded_dir: encodedDir,
    file_path: filePath,
    first_ts: headParsed.firstTs ?? null,
    last_ts: tailParsed.lastTs ?? headParsed.firstTs ?? null,
    msg_count: msgCount,
    preview: tailParsed.preview ?? null,
    version: headParsed.version ?? null,
    git_branch: headParsed.gitBranch ?? null,
    file_mtime: stat.mtimeMs,
    file_size: stat.size,
    deleted_at: null,
    trash_path: null,
  });
  upsertProject(cwd, encodedDir, isSafeAbsolutePath(cwd) && fs.existsSync(cwd));
  return true;
}
