import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listTrashed: () => ipcRenderer.invoke('sessions:listTrashed'),
  search: (q: string) => ipcRenderer.invoke('sessions:search', q),
  openInTerminal: (id: string) => ipcRenderer.invoke('sessions:openInTerminal', id),
  newSessionInProject: (cwd: string) => ipcRenderer.invoke('sessions:newInProject', cwd),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  restoreSession: (id: string) => ipcRenderer.invoke('sessions:restore', id),
  purgeSession: (id: string) => ipcRenderer.invoke('sessions:purge', id),
  reindex: () => ipcRenderer.invoke('sessions:reindex'),
  schedulerStatus: () => ipcRenderer.invoke('scheduler:status'),
  schedulerInstall: () => ipcRenderer.invoke('scheduler:install'),
  schedulerUninstall: () => ipcRenderer.invoke('scheduler:uninstall'),
  onSessionsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('sessions:changed', listener);
    return () => ipcRenderer.removeListener('sessions:changed', listener);
  },
};

contextBridge.exposeInMainWorld('reclaude', api);

export type ReclaudeApi = typeof api;
