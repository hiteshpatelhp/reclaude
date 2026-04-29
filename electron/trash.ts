import * as fs from 'fs';
import * as path from 'path';
import { trashDir, claudeProjectsDir } from './paths';
import {
  getSession,
  markDeleted,
  markRestored,
  listExpiredTrash,
  purgeSession,
} from './db';
import { assertWithin } from './validation';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function ensureTrashDir() {
  const d = trashDir();
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  } else {
    // Tighten perms even if the dir pre-existed under a looser umask.
    try { fs.chmodSync(d, 0o700); } catch {}
  }
  return d;
}

export function softDelete(id: string): { ok: true; trashPath: string } {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (session.deleted_at) throw new Error(`Session ${id} already in trash`);

  const tDir = ensureTrashDir();
  const ts = Date.now();
  // assertWithin re-resolves and confirms the result is under tDir even
  // if `id` is somehow tampered with at the DB layer.
  const trashPath = assertWithin(tDir, path.join(tDir, `${ts}-${id}.jsonl`), 'trashPath');

  // Source must live under ~/.claude/projects/ — anywhere else is a sign
  // the DB row has been tampered with or a symlink was indexed. Use
  // assertWithin (which now calls safeResolve / fs.realpathSync) so that
  // a tampered DB row containing `..` segments or a symlink target outside
  // the projects dir is rejected — a raw startsWith on the unresolved
  // string accepted both bypasses.
  assertWithin(claudeProjectsDir, session.file_path, 'softDelete file_path');

  if (!fs.existsSync(session.file_path)) {
    // File already gone; just mark deleted in DB.
    markDeleted(id, trashPath);
    return { ok: true, trashPath };
  }
  fs.renameSync(session.file_path, trashPath);
  markDeleted(id, trashPath);
  return { ok: true, trashPath };
}

export function restore(id: string): { ok: true; restoredTo: string } {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (!session.deleted_at || !session.trash_path)
    throw new Error(`Session ${id} is not in trash`);
  if (!fs.existsSync(session.trash_path))
    throw new Error(`Trashed file no longer exists: ${session.trash_path}`);

  // Confirm the trashed file lives under our trash dir, not somewhere else.
  assertWithin(trashDir(), session.trash_path, 'session.trash_path');

  // Reconstruct the original location from file_path. Reject if it would
  // resolve outside ~/.claude/projects/ — defends against tampered DB rows
  // or symlinks indexed at original-write time.
  const target = assertWithin(claudeProjectsDir, session.file_path, 'restore target');

  // Ensure the parent dir exists (still under claudeProjectsDir).
  const targetDir = path.dirname(target);
  assertWithin(claudeProjectsDir, targetDir, 'restore targetDir');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  // If something else now occupies the path, append a suffix.
  let finalTarget = target;
  if (fs.existsSync(finalTarget)) {
    finalTarget = finalTarget.replace(/\.jsonl$/, `.restored-${Date.now()}.jsonl`);
    assertWithin(claudeProjectsDir, finalTarget, 'restore finalTarget');
  }
  fs.renameSync(session.trash_path, finalTarget);
  markRestored(id, finalTarget);
  return { ok: true, restoredTo: finalTarget };
}

export function purgeNow(id: string): { ok: true } {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (!session.deleted_at) throw new Error(`Session ${id} is not in trash`);
  if (session.trash_path && fs.existsSync(session.trash_path)) {
    // Refuse to unlink anything outside our trash dir.
    try {
      assertWithin(trashDir(), session.trash_path, 'purgeNow trash_path');
      fs.unlinkSync(session.trash_path);
    } catch (e) {
      console.warn('[trash] failed to unlink', session.trash_path, e);
    }
  }
  purgeSession(id);
  return { ok: true };
}

export function purgeExpiredTrash() {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const expired = listExpiredTrash(cutoff);
  for (const row of expired) {
    try {
      if (fs.existsSync(row.trash_path)) {
        // Same containment check: only unlink files inside our trash dir.
        assertWithin(trashDir(), row.trash_path, 'purgeExpired trash_path');
        fs.unlinkSync(row.trash_path);
      }
    } catch (e) {
      console.warn('[trash] purge failed for', row.trash_path, e);
    }
    purgeSession(row.id);
  }
}
