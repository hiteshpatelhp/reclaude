import { app } from 'electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchAgentPlistPath, logDir } from './paths';

// Each platform exposes the same surface: install / uninstall / installed.
// macOS: launchd. Windows: schtasks. Linux: systemd user units.

export function schedulerInstalled(): boolean {
  if (process.platform === 'darwin') return fs.existsSync(launchAgentPlistPath());
  if (process.platform === 'win32') return winTaskInstalled();
  return systemdUnitInstalled();
}

export function installScheduler(): { ok: true } {
  if (process.platform === 'darwin') return installMac();
  if (process.platform === 'win32') return installWin();
  return installLinux();
}

export function uninstallScheduler(): { ok: true } {
  if (process.platform === 'darwin') return uninstallMac();
  if (process.platform === 'win32') return uninstallWin();
  return uninstallLinux();
}

// ---------- macOS / launchd ----------

function installMac(): { ok: true } {
  const electronPath = process.execPath;
  const appPath = app.getAppPath();
  const plistTemplatePath = path.join(appPath, 'resources', 'launchagent.plist');
  let template: string;
  if (fs.existsSync(plistTemplatePath)) {
    template = fs.readFileSync(plistTemplatePath, 'utf8');
  } else {
    template = DEFAULT_PLIST_TEMPLATE;
  }
  const plist = template
    .replace('__ELECTRON_PATH__', electronPath)
    .replace('__APP_PATH__', appPath)
    .replace(/__LOG_DIR__/g, logDir());

  const dest = launchAgentPlistPath();
  if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plist, 'utf8');

  const uid = (process.getuid && process.getuid()) || 0;
  // bootstrap is the modern launchctl call; bootout for uninstall.
  spawnSync('launchctl', ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, dest], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed (${r.status}): ${r.stderr?.toString() ?? ''}`,
    );
  }
  return { ok: true };
}

function uninstallMac(): { ok: true } {
  const dest = launchAgentPlistPath();
  const uid = (process.getuid && process.getuid()) || 0;
  spawnSync('launchctl', ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return { ok: true };
}

const DEFAULT_PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.reclaude.indexer</string>
  <key>ProgramArguments</key>
  <array>
    <string>__ELECTRON_PATH__</string>
    <string>__APP_PATH__</string>
    <string>--reindex</string>
    <string>--no-window</string>
  </array>
  <key>StartInterval</key>
  <integer>10800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/indexer.out.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/indexer.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RECLAUDE_HEADLESS</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;

// ---------- Windows / schtasks ----------

const WIN_TASK_NAME = 'ReclaudeIndexer';

function winTaskInstalled(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', WIN_TASK_NAME], { stdio: 'pipe' });
  return r.status === 0;
}

function installWin(): { ok: true } {
  const electronPath = process.execPath;
  const appPath = app.getAppPath();
  const cmd = `\\"${electronPath}\\" \\"${appPath}\\" --reindex --no-window`;
  const r = spawnSync(
    'schtasks',
    [
      '/Create',
      '/SC',
      'HOURLY',
      '/MO',
      '3',
      '/TN',
      WIN_TASK_NAME,
      '/TR',
      cmd,
      '/F',
    ],
    { stdio: 'pipe' },
  );
  if (r.status !== 0) {
    throw new Error(`schtasks /Create failed: ${r.stderr?.toString() ?? ''}`);
  }
  return { ok: true };
}

function uninstallWin(): { ok: true } {
  spawnSync('schtasks', ['/Delete', '/TN', WIN_TASK_NAME, '/F'], { stdio: 'ignore' });
  return { ok: true };
}

// ---------- Linux / systemd user units ----------

function systemdServicePath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'reclaude-indexer.service');
}
function systemdTimerPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'reclaude-indexer.timer');
}

function systemdUnitInstalled(): boolean {
  return fs.existsSync(systemdServicePath()) && fs.existsSync(systemdTimerPath());
}

function installLinux(): { ok: true } {
  const electronPath = process.execPath;
  const appPath = app.getAppPath();
  const service = `[Unit]
Description=Reclaude Indexer

[Service]
Type=oneshot
Environment=RECLAUDE_HEADLESS=1
ExecStart=${electronPath} ${appPath} --reindex --no-window
`;
  const timer = `[Unit]
Description=Run Reclaude Indexer every 3 hours

[Timer]
OnBootSec=2min
OnUnitActiveSec=3h
Unit=reclaude-indexer.service

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(systemdServicePath()), { recursive: true });
  fs.writeFileSync(systemdServicePath(), service, 'utf8');
  fs.writeFileSync(systemdTimerPath(), timer, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'reclaude-indexer.timer'], {
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    throw new Error(`systemctl enable failed: ${r.stderr?.toString() ?? ''}`);
  }
  return { ok: true };
}

function uninstallLinux(): { ok: true } {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'reclaude-indexer.timer'], {
    stdio: 'ignore',
  });
  if (fs.existsSync(systemdTimerPath())) fs.unlinkSync(systemdTimerPath());
  if (fs.existsSync(systemdServicePath())) fs.unlinkSync(systemdServicePath());
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  return { ok: true };
}
