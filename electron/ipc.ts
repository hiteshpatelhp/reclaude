import { ipcMain, BrowserWindow, dialog, IpcMainInvokeEvent, app } from 'electron';
import * as path from 'path';
import * as url from 'url';
import { listProjectsWithSessions, listTrashedSessions, searchSessions, getSession } from './db';
import { reindexAll } from './indexer';
import { openInTerminal, newSessionInProject } from './terminal';
import { softDelete, restore, purgeNow } from './trash';
import { schedulerInstalled, installScheduler, uninstallScheduler } from './scheduler';
import { assertSafeId, assertSafeTerminalCwd } from './validation';
import { audit } from './audit';

// In dev we serve from Vite (http://localhost:5173). In packaged builds we
// load file://.../dist/index.html. Reject any IPC call whose sender frame
// does not match the expected URL — protects against accidental
// webview/iframe embedding and (per ARCH-TRUST-001) prevents any other
// file:// page that might be loaded in the future from invoking IPC.
function expectedPackagedUrl(): string {
  // dist-electron/ipc.js → dist-electron → repo-root → dist/index.html
  // packaged ASAR layout puts the renderer at <appPath>/dist/index.html.
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  // url.pathToFileURL handles drive letters on Windows and percent-encoding.
  return url.pathToFileURL(indexPath).toString();
}

function isExpectedSender(event: IpcMainInvokeEvent): boolean {
  const senderUrl = event.senderFrame?.url ?? '';
  if (!senderUrl) return false;
  // Strip fragment and query before comparing — Electron sometimes appends
  // a trailing `/` so we normalize that too.
  const cleaned = senderUrl.split('#')[0].split('?')[0].replace(/\/$/, '');
  if (app.isPackaged) {
    return cleaned === expectedPackagedUrl().replace(/\/$/, '');
  }
  // Dev mode: exact-match only. The earlier `startsWith('http://localhost:5173/')`
  // would have accepted any sub-path under the Vite origin, which is sound
  // in current usage but lets a future regression introduce a non-root frame
  // unnoticed. Pin to `http://localhost:5173` (root) and `http://localhost:5173/index.html`
  // (Vite's served entry); reject anything else.
  return cleaned === 'http://localhost:5173' || cleaned === 'http://localhost:5173/index.html';
}

function guard(event: IpcMainInvokeEvent, channel: string) {
  if (!isExpectedSender(event)) {
    const senderUrl = event.senderFrame?.url ?? '<none>';
    audit({ type: 'ipc.rejected', channel, sender: senderUrl });
    // Generic error to the renderer — full sender URL stays in the audit log.
    throw new Error(`IPC ${channel} rejected: unauthorized sender`);
  }
}

// Wrap a handler so the full error surface stays in audit + main-process
// console, while a sanitized message is what reaches the renderer toast.
// Domain errors thrown from validation / not-found paths are passed through
// since they encode user-visible state ("Session X not found"). System
// errors (spawnSync failures, fs errors, raw stderr from launchctl) are
// flattened to a generic message keyed off the channel.
type AnyHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any | Promise<any>;
function wrap(channel: string, handler: AnyHandler): AnyHandler {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (e) {
      const sender = event.senderFrame?.url ?? '<none>';
      const msg = e instanceof Error ? e.message : String(e);
      audit({ type: 'ipc.error', channel, sender, error: msg });
      // Re-throw a sanitized error. Validation / not-found / unauthorized
      // messages are user-facing state; system errors get flattened to a
      // generic message keyed off the channel. Validation messages with
      // "Invalid <field>: …" are stripped to their field label so an
      // attacker-controlled value (e.g. a JSONL cwd containing shell
      // metacharacters) cannot reach the renderer toast verbatim.
      if (msg.startsWith('Invalid ')) {
        // Keep only "Invalid <label>" (everything before the first colon).
        const labelOnly = msg.split(':')[0];
        throw new Error(labelOnly);
      }
      if (
        msg.includes('not found') ||
        msg.includes('not in trash') ||
        msg.includes('already in trash') ||
        msg.includes('orphaned') ||
        msg.includes('unauthorized sender')
      ) {
        throw e;
      }
      // Hide system-level details (paths, stderr) from the renderer.
      console.error(`[ipc:${channel}]`, e);
      throw new Error(`Operation failed (${channel}). See logs for details.`);
    }
  };
}

async function confirmDestructive(parent: BrowserWindow | null, message: string, detail: string): Promise<boolean> {
  const win = parent ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Continue'],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
    noLink: true,
  };
  const r = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return r.response === 1;
}

export function registerIpc(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('sessions:list', wrap('sessions:list', (e) => {
    guard(e, 'sessions:list');
    audit({ type: 'ipc.read', channel: 'sessions:list', sender: e.senderFrame?.url });
    return listProjectsWithSessions();
  }));

  ipcMain.handle('sessions:listTrashed', wrap('sessions:listTrashed', (e) => {
    guard(e, 'sessions:listTrashed');
    audit({ type: 'ipc.read', channel: 'sessions:listTrashed', sender: e.senderFrame?.url });
    return listTrashedSessions();
  }));

  ipcMain.handle('sessions:search', wrap('sessions:search', (e, q: string) => {
    guard(e, 'sessions:search');
    if (typeof q !== 'string') throw new Error('Invalid search query: must be a string');
    audit({ type: 'ipc.read', channel: 'sessions:search', sender: e.senderFrame?.url });
    return searchSessions(q);
  }));

  ipcMain.handle('sessions:openInTerminal', wrap('sessions:openInTerminal', async (e, id: string) => {
    guard(e, 'sessions:openInTerminal');
    assertSafeId(id, 'sessionId');
    const session = getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    // Audit before the spawn so a crash mid-launch still leaves a trail.
    audit({ type: 'ipc.invoked', channel: 'sessions:openInTerminal', sessionId: id });
    return openInTerminal(session.cwd, id);
  }));

  ipcMain.handle('sessions:newInProject', wrap('sessions:newInProject', async (e, cwd: string) => {
    guard(e, 'sessions:newInProject');
    // assertSafeTerminalCwd: absolute path + symlink-resolved allowlist
    // (fs.realpathSync) — see validation.ts doc comment for the
    // assertShellSafePath non-chaining rationale.
    const validatedCwd = assertSafeTerminalCwd(cwd, 'cwd');
    audit({ type: 'ipc.invoked', channel: 'sessions:newInProject', cwd: validatedCwd });
    return newSessionInProject(validatedCwd);
  }));

  ipcMain.handle('sessions:delete', wrap('sessions:delete', async (e, id: string) => {
    guard(e, 'sessions:delete');
    assertSafeId(id, 'sessionId');
    audit({ type: 'session.delete', sessionId: id });
    return softDelete(id);
  }));

  ipcMain.handle('sessions:restore', wrap('sessions:restore', async (e, id: string) => {
    guard(e, 'sessions:restore');
    assertSafeId(id, 'sessionId');
    audit({ type: 'session.restore', sessionId: id });
    return restore(id);
  }));

  ipcMain.handle('sessions:purge', wrap('sessions:purge', async (e, id: string) => {
    guard(e, 'sessions:purge');
    assertSafeId(id, 'sessionId');
    audit({ type: 'session.purge', sessionId: id });
    return purgeNow(id);
  }));

  ipcMain.handle('sessions:reindex', wrap('sessions:reindex', async (e) => {
    guard(e, 'sessions:reindex');
    audit({ type: 'ipc.invoked', channel: 'sessions:reindex', sender: e.senderFrame?.url });
    const result = await reindexAll();
    const w = getWindow();
    if (w) w.webContents.send('sessions:changed');
    return result;
  }));

  ipcMain.handle('scheduler:status', wrap('scheduler:status', (e) => {
    guard(e, 'scheduler:status');
    audit({ type: 'ipc.read', channel: 'scheduler:status', sender: e.senderFrame?.url });
    return { installed: schedulerInstalled() };
  }));

  ipcMain.handle('scheduler:install', wrap('scheduler:install', async (e) => {
    guard(e, 'scheduler:install');
    const ok = await confirmDestructive(
      getWindow(),
      'Install Reclaude background indexer?',
      'A background task will run every 3 hours under your account to keep the session index up to date. You can remove it at any time from the Reclaude UI.',
    );
    if (!ok) {
      audit({ type: 'scheduler.install', platform: process.platform, ok: false, cancelled: true });
      return { ok: false, cancelled: true };
    }
    const result = installScheduler();
    audit({ type: 'scheduler.install', platform: process.platform, ok: true });
    return result;
  }));

  ipcMain.handle('scheduler:uninstall', wrap('scheduler:uninstall', async (e) => {
    guard(e, 'scheduler:uninstall');
    const ok = await confirmDestructive(
      getWindow(),
      'Uninstall Reclaude background indexer?',
      'The 3-hourly background reindex will be removed. New sessions will only be picked up when Reclaude is open.',
    );
    if (!ok) {
      audit({ type: 'scheduler.uninstall', platform: process.platform, ok: false, cancelled: true });
      return { ok: false, cancelled: true };
    }
    const result = uninstallScheduler();
    audit({ type: 'scheduler.uninstall', platform: process.platform, ok: true });
    return result;
  }));
}
