import { ipcMain, BrowserWindow } from 'electron';
import { listProjectsWithSessions, listTrashedSessions, searchSessions, getSession } from './db';
import { reindexAll } from './indexer';
import { openInTerminal, newSessionInProject } from './terminal';
import { softDelete, restore, purgeNow } from './trash';
import { schedulerInstalled, installScheduler, uninstallScheduler } from './scheduler';

export function registerIpc(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('sessions:list', () => listProjectsWithSessions());

  ipcMain.handle('sessions:listTrashed', () => listTrashedSessions());

  ipcMain.handle('sessions:search', (_e, q: string) => searchSessions(q));

  ipcMain.handle('sessions:openInTerminal', async (_e, id: string) => {
    const session = getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    return openInTerminal(session.cwd, id);
  });

  ipcMain.handle('sessions:newInProject', async (_e, cwd: string) => {
    return newSessionInProject(cwd);
  });

  ipcMain.handle('sessions:delete', async (_e, id: string) => {
    return softDelete(id);
  });

  ipcMain.handle('sessions:restore', async (_e, id: string) => {
    return restore(id);
  });

  ipcMain.handle('sessions:purge', async (_e, id: string) => {
    return purgeNow(id);
  });

  ipcMain.handle('sessions:reindex', async () => {
    const result = await reindexAll();
    const w = getWindow();
    if (w) w.webContents.send('sessions:changed');
    return result;
  });

  ipcMain.handle('scheduler:status', () => ({ installed: schedulerInstalled() }));
  ipcMain.handle('scheduler:install', () => installScheduler());
  ipcMain.handle('scheduler:uninstall', () => uninstallScheduler());
}
