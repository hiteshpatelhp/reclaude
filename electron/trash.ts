import * as fs from 'fs';
import * as path from 'path';
import { trashDir } from './paths';
import {
  getSession,
  markDeleted,
  markRestored,
  listExpiredTrash,
  purgeSession,
} from './db';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function ensureTrashDir() {
  const d = trashDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

export function softDelete(id: string): { ok: true; trashPath: string } {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (session.deleted_at) throw new Error(`Session ${id} already in trash`);

  const tDir = ensureTrashDir();
  const ts = Date.now();
  const trashPath = path.join(tDir, `${ts}-${id}.jsonl`);

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

  // Original location is reconstructed from file_path; ensure dir exists.
  const targetDir = path.dirname(session.file_path);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  // If something else now occupies the path, append a suffix.
  let target = session.file_path;
  if (fs.existsSync(target)) {
    target = target.replace(/\.jsonl$/, `.restored-${Date.now()}.jsonl`);
  }
  fs.renameSync(session.trash_path, target);
  markRestored(id, target);
  return { ok: true, restoredTo: target };
}

export function purgeNow(id: string): { ok: true } {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  if (!session.deleted_at) throw new Error(`Session ${id} is not in trash`);
  if (session.trash_path && fs.existsSync(session.trash_path)) {
    try {
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
      if (fs.existsSync(row.trash_path)) fs.unlinkSync(row.trash_path);
    } catch (e) {
      console.warn('[trash] purge failed for', row.trash_path, e);
    }
    purgeSession(row.id);
  }
}
