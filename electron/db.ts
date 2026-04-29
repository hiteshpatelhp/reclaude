import Database = require('better-sqlite3');
import * as fs from 'fs';
import * as path from 'path';
import { dbPath, userDataDir } from './paths';

type DB = ReturnType<typeof Database>;

let db: DB | null = null;

export function getDb(): DB {
  if (!db) throw new Error('DB not initialised; call initDb() first');
  return db;
}

export function initDb(): DB {
  if (db) return db;
  if (!fs.existsSync(userDataDir())) fs.mkdirSync(userDataDir(), { recursive: true, mode: 0o700 });

  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Tighten perms on the DB file (and the WAL/SHM siblings created alongside)
  // so other local users can't read session previews. Best-effort: errors are
  // swallowed so we don't block app startup if perms cannot be set.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(dbPath() + suffix, 0o600); } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      cwd TEXT PRIMARY KEY,
      encoded_dir TEXT NOT NULL,
      exists_on_disk INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      encoded_dir TEXT NOT NULL,
      file_path TEXT NOT NULL,
      first_ts INTEGER,
      last_ts INTEGER,
      msg_count INTEGER DEFAULT 0,
      preview TEXT,
      version TEXT,
      git_branch TEXT,
      file_mtime INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      deleted_at INTEGER,
      trash_path TEXT
    );

    CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS sessions_last_ts_idx ON sessions(last_ts DESC);
    CREATE INDEX IF NOT EXISTS sessions_deleted_idx ON sessions(deleted_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      id UNINDEXED, preview, cwd, git_branch
    );
  `);

  return db;
}

export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
}

export interface SessionRow {
  id: string;
  cwd: string;
  encoded_dir: string;
  file_path: string;
  first_ts: number | null;
  last_ts: number | null;
  msg_count: number;
  preview: string | null;
  version: string | null;
  git_branch: string | null;
  file_mtime: number;
  file_size: number;
  deleted_at: number | null;
  trash_path: string | null;
}

export interface ProjectGroup {
  cwd: string;
  encoded_dir: string;
  exists_on_disk: boolean;
  sessions: SessionRow[];
}

export function listTrashedSessions(): SessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all() as SessionRow[];
}

export function listProjectsWithSessions(): ProjectGroup[] {
  const d = getDb();
  const projects = d
    .prepare(`SELECT cwd, encoded_dir, exists_on_disk FROM projects ORDER BY cwd`)
    .all() as Array<{ cwd: string; encoded_dir: string; exists_on_disk: number }>;

  const sessionsByCwd = d
    .prepare(
      `SELECT * FROM sessions
       WHERE deleted_at IS NULL
       ORDER BY cwd, COALESCE(last_ts, 0) DESC`,
    )
    .all() as SessionRow[];

  const map = new Map<string, SessionRow[]>();
  for (const s of sessionsByCwd) {
    if (!map.has(s.cwd)) map.set(s.cwd, []);
    map.get(s.cwd)!.push(s);
  }

  return projects
    .filter((p) => map.has(p.cwd))
    .map((p) => ({
      cwd: p.cwd,
      encoded_dir: p.encoded_dir,
      exists_on_disk: !!p.exists_on_disk,
      sessions: map.get(p.cwd) ?? [],
    }));
}

export function getSession(id: string): SessionRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
}

const FTS_MAX_QUERY_LEN = 256;
const FTS_MAX_TOKENS = 10;

export function searchSessions(query: string): SessionRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Cap query size — pathological queries (very long tokens, many `*`
  // prefixes) make FTS5 expensive. UI inputs are well under this; programmatic
  // callers get a hard ceiling.
  if (trimmed.length > FTS_MAX_QUERY_LEN) return [];
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > FTS_MAX_TOKENS) return [];
  // FTS5 escape: wrap each token in quotes for safety.
  const ftsQuery = tokens
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
  const ids = getDb()
    .prepare(`SELECT id FROM sessions_fts WHERE sessions_fts MATCH ? LIMIT 200`)
    .all(ftsQuery) as Array<{ id: string }>;
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT * FROM sessions WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY last_ts DESC`,
    )
    .all(...ids.map((r) => r.id)) as SessionRow[];
}

export function upsertProject(cwd: string, encoded_dir: string, exists: boolean) {
  getDb()
    .prepare(
      `INSERT INTO projects(cwd, encoded_dir, exists_on_disk, last_seen)
       VALUES(?, ?, ?, strftime('%s','now') * 1000)
       ON CONFLICT(cwd) DO UPDATE SET
         encoded_dir = excluded.encoded_dir,
         exists_on_disk = excluded.exists_on_disk,
         last_seen = excluded.last_seen`,
    )
    .run(cwd, encoded_dir, exists ? 1 : 0);
}

export function upsertSession(s: SessionRow) {
  getDb()
    .prepare(
      `INSERT INTO sessions(
         id, cwd, encoded_dir, file_path, first_ts, last_ts, msg_count, preview,
         version, git_branch, file_mtime, file_size, deleted_at, trash_path
       ) VALUES(@id, @cwd, @encoded_dir, @file_path, @first_ts, @last_ts, @msg_count,
                @preview, @version, @git_branch, @file_mtime, @file_size, @deleted_at, @trash_path)
       ON CONFLICT(id) DO UPDATE SET
         cwd = excluded.cwd,
         encoded_dir = excluded.encoded_dir,
         file_path = excluded.file_path,
         first_ts = excluded.first_ts,
         last_ts = excluded.last_ts,
         msg_count = excluded.msg_count,
         preview = excluded.preview,
         version = excluded.version,
         git_branch = excluded.git_branch,
         file_mtime = excluded.file_mtime,
         file_size = excluded.file_size`,
    )
    .run(s);

  // FTS upsert: delete + insert.
  getDb().prepare(`DELETE FROM sessions_fts WHERE id = ?`).run(s.id);
  getDb()
    .prepare(`INSERT INTO sessions_fts(id, preview, cwd, git_branch) VALUES(?, ?, ?, ?)`)
    .run(s.id, s.preview ?? '', s.cwd, s.git_branch ?? '');
}

export function markDeleted(id: string, trashPath: string) {
  const ts = Date.now();
  getDb()
    .prepare(`UPDATE sessions SET deleted_at = ?, trash_path = ? WHERE id = ?`)
    .run(ts, trashPath, id);
  getDb().prepare(`DELETE FROM sessions_fts WHERE id = ?`).run(id);
}

export function markRestored(id: string, restoredFilePath: string) {
  const row = getSession(id);
  if (!row) return;
  getDb()
    .prepare(
      `UPDATE sessions SET deleted_at = NULL, trash_path = NULL, file_path = ? WHERE id = ?`,
    )
    .run(restoredFilePath, id);
  getDb()
    .prepare(`INSERT INTO sessions_fts(id, preview, cwd, git_branch) VALUES(?, ?, ?, ?)`)
    .run(id, row.preview ?? '', row.cwd, row.git_branch ?? '');
}

export function listExpiredTrash(olderThanMs: number) {
  return getDb()
    .prepare(
      `SELECT id, trash_path, deleted_at FROM sessions
       WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .all(olderThanMs) as Array<{ id: string; trash_path: string; deleted_at: number }>;
}

export function purgeSession(id: string) {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function knownFileFingerprint(id: string): { mtime: number; size: number } | undefined {
  return getDb()
    .prepare(`SELECT file_mtime AS mtime, file_size AS size FROM sessions WHERE id = ?`)
    .get(id) as { mtime: number; size: number } | undefined;
}

export function isSessionTrashed(id: string): boolean {
  const row = getDb()
    .prepare(`SELECT deleted_at FROM sessions WHERE id = ?`)
    .get(id) as { deleted_at: number | null } | undefined;
  return !!row && row.deleted_at != null;
}
