import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as url from 'url';
import { initDb, closeDb } from './db';
import { reindexAll } from './indexer';
import { startWatcher, stopWatcher } from './watcher';
import { registerIpc } from './ipc';
import { purgeExpiredTrash } from './trash';
import { logDir, userDataDir } from './paths';

// Resolve the exact file:// URL of the packaged renderer entry point.
// Used by both the IPC sender check (in ipc.ts) and the will-navigate
// guard below — they must match so that the navigation surface is no
// broader than the IPC surface.
function packagedRendererUrl(): string {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  return url.pathToFileURL(indexPath).toString();
}

const isHeadless =
  process.argv.includes('--reindex') ||
  process.argv.includes('--no-window') ||
  process.env.RECLAUDE_HEADLESS === '1';

let mainWindow: BrowserWindow | null = null;

function ensureDirs() {
  for (const d of [userDataDir(), logDir()]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    // Tighten perms even if the directory pre-existed with looser modes.
    try { fs.chmodSync(d, 0o700); } catch {}
  }
}

function installCsp() {
  // Strict CSP for packaged builds, relaxed for dev so Vite HMR works.
  // Header form (vs <meta>) lets us serve the same index.html in both modes
  // without committing dev-only directives to the bundled HTML.
  const prodCsp =
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'";
  const devCsp =
    "default-src 'self' http://localhost:5173 ws://localhost:5173; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173; " +
    "style-src 'self' 'unsafe-inline' http://localhost:5173; " +
    "img-src 'self' data: http://localhost:5173; " +
    "font-src 'self' data: http://localhost:5173; " +
    "connect-src 'self' http://localhost:5173 ws://localhost:5173; " +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "frame-ancestors 'none'";

  const csp = app.isPackaged ? prodCsp : devCsp;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
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
      sandbox: true,
      webviewTag: false,
    },
  });

  // Refuse to open new windows or navigate away from our origin. The
  // packaged check pins the exact dist/index.html URL — accepting any
  // file:// URL would let a future XSS regression navigate the renderer
  // to an attacker-written file:///tmp/evil.html. The dev branch only
  // accepts the Vite HMR origin; file:// is never legitimate in dev.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const expectedRenderer = packagedRendererUrl();
  mainWindow.webContents.on('will-navigate', (e, navUrl) => {
    const cleaned = navUrl.split('#')[0].split('?')[0];
    const allowed = app.isPackaged
      ? cleaned === expectedRenderer
      : navUrl.startsWith('http://localhost:5173/');
    if (!allowed) e.preventDefault();
  });

  // DevTools is opt-in via env var even in dev so a stray packaged binary
  // run with NODE_ENV=development cannot expose it. The original gate
  // (process.env.NODE_ENV === 'development') was spoofable from a launcher.
  const isDev = !app.isPackaged;
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    if (process.env.RECLAUDE_DEVTOOLS !== '0') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
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
      `[reclaude] reindex complete: ${result.scanned} files, ${result.updated} updated, ${result.added} new, ${result.skipped} skipped`,
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

  installCsp();
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
