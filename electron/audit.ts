import * as fs from 'fs';
import * as path from 'path';
import { logDir } from './paths';

// File-backed audit log for security-relevant IPC events. JSONL so each line
// is independently parseable; appended via fs.appendFileSync so a crash
// mid-event still produces a complete previous record.
//
// Design notes:
// - Each audit entry has timestamp + event type + minimal context. Sender
//   URL is logged on rejections; session IDs on destructive operations.
// - The log directory is created with mode 0o700 explicitly (not via the
//   umask default) so headless reindex paths that hit audit.ts before
//   main.ts ensureDirs() still get a tight perms posture.
// - File creation uses an atomic O_CREAT|O_WRONLY open with mode 0o600 so
//   the existsSync→chmodSync TOCTOU window is closed.
// - Initialization is only marked complete once chmod / rotation succeed,
//   so a transient failure doesn't permanently disable hardening.
// - 10 MB rotation cap keeps the log inspectable and bounds disk use.
// - Any string fields that may contain attacker-influenced content
//   (e.g. validation error messages) are passed through `sanitizeString`
//   which escapes control characters before serialization, blocking log
//   injection of fake JSONL lines.

let initialized = false;

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
// Rotation depth: 3 historical generations + the live file = up to 40 MB
// total retention. A higher cap would trade disk for forensic depth in the
// rare scenario where an attacker is rapidly probing the IPC channel and
// generating a flood of `ipc.rejected` entries. Each generation is the
// next-most-recent slice of events.
const ROTATION_GENERATIONS = 3;

function auditLogPath(): string {
  return path.join(logDir(), 'audit.log');
}

function ensureLogFile(): boolean {
  if (initialized) return true;
  const dir = logDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    // Non-fatal: continue trying to write.
  }
  const file = auditLogPath();
  try {
    // Atomic create-or-open with restrictive mode. If the file already
    // exists, mode is not applied here — chmodSync below tightens it.
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
    fs.chmodSync(file, 0o600);
    initialized = true;
    return true;
  } catch {
    // Leave initialized=false so the next call retries. Returning false
    // tells the caller to skip the write rather than risk an exception
    // bubbling out of the IPC handler.
    return false;
  }
}

function rotateIfLarge() {
  try {
    const st = fs.statSync(auditLogPath());
    if (st.size <= MAX_LOG_BYTES) return;

    // Rotate generations top-down: .2 → .3, .1 → .2, live → .1. Drop the
    // oldest. unlinkSync / renameSync errors on individual generations are
    // swallowed so a partial rotation still lands the most recent slice.
    const oldest = `${auditLogPath()}.${ROTATION_GENERATIONS}`;
    try { fs.unlinkSync(oldest); } catch {}
    for (let i = ROTATION_GENERATIONS - 1; i >= 1; i--) {
      const src = `${auditLogPath()}.${i}`;
      const dst = `${auditLogPath()}.${i + 1}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {}
    }
    fs.renameSync(auditLogPath(), `${auditLogPath()}.1`);
    // Re-create the live file with restrictive perms.
    const fd = fs.openSync(auditLogPath(), fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
    fs.chmodSync(auditLogPath(), 0o600);
  } catch {
    // Stat failure or rename failure is non-fatal.
  }
}

// Escape control characters so attacker-influenced content can't inject
// fake JSONL lines via embedded \n, NUL, etc. JSON.stringify handles most
// of this when we serialize the whole record, but the `error` field is
// pre-stringified text so we sanitize it explicitly before nesting it in
// the JSON object. \u-escape every C0 control + DEL.
function sanitizeString(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

export type AuditEvent =
  | { type: 'ipc.rejected'; channel: string; sender?: string }
  | { type: 'ipc.invoked'; channel: string; sender?: string; sessionId?: string; cwd?: string }
  // ipc.read is a lighter event type for read-only channels (list, search,
  // reindex). Logged so a forensic analyst can answer "what was exposed
  // when?" without flooding the log with every UI refresh — write-side
  // events (ipc.invoked, session.*, scheduler.*) remain the high-signal trail.
  | { type: 'ipc.read'; channel: string; sender?: string }
  | { type: 'ipc.error'; channel: string; sender?: string; error: string }
  | { type: 'scheduler.install'; platform: string; ok: boolean; cancelled?: boolean }
  | { type: 'scheduler.uninstall'; platform: string; ok: boolean; cancelled?: boolean }
  | { type: 'session.delete'; sessionId: string }
  | { type: 'session.restore'; sessionId: string }
  | { type: 'session.purge'; sessionId: string };

export function audit(event: AuditEvent) {
  try {
    if (!ensureLogFile()) return;
    rotateIfLarge();
    // Sanitize free-form string fields that may carry attacker content.
    const safeEvent: AuditEvent = { ...event };
    if (safeEvent.type === 'ipc.error') {
      safeEvent.error = sanitizeString(safeEvent.error);
    }
    if ('sender' in safeEvent && typeof safeEvent.sender === 'string') {
      safeEvent.sender = sanitizeString(safeEvent.sender);
    }
    if ('cwd' in safeEvent && typeof safeEvent.cwd === 'string') {
      safeEvent.cwd = sanitizeString(safeEvent.cwd);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safeEvent }) + '\n';
    fs.appendFileSync(auditLogPath(), line, { mode: 0o600 });
  } catch {
    // Never let logging break the IPC handler.
  }
}
