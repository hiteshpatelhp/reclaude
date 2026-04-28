import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { initDb, closeDb } from './db';
import { reindexAll } from './indexer';
import { startWatcher, stopWatcher } from './watcher';
import { registerIpc } from './ipc';
import { purgeExpiredTrash } from './trash';
import { logDir, userDataDir } from './paths';

const isHeadless =
  process.argv.includes('--reindex') ||
  process.argv.includes('--no-window') ||
  process.env.RECLAUDE_HEADLESS === '1';

let mainWindow: BrowserWindow | null = null;

function ensureDirs() {
  for (const d of [userDataDir(), logDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function runHeadlessReindex() {
  ensureDirs();
  initDb();
  try {
    const result = await reindexAll();
    console.log(
      `[reclaude] reindex complete: ${result.scanned} files, ${result.updated} updated, ${result.added} new`,
    );
    purgeExpiredTrash();
  } finally {
    closeDb();
  }
}

app.whenReady().then(async () => {
  ensureDirs();

  if (isHeadless) {
    await runHeadlessReindex();
    app.quit();
    return;
  }

  initDb();
  registerIpc(() => mainWindow);

  // Background tasks
  reindexAll().catch((e) => console.error('[reindex]', e));
  purgeExpiredTrash();
  startWatcher(() => {
    if (mainWindow) mainWindow.webContents.send('sessions:changed');
  });

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isHeadless && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopWatcher();
  closeDb();
});
