import { app } from 'electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchAgentPlistPath, logDir } from './paths';
import { assertSchedulerSafePath } from './validation';

// Absolute paths to system schedulers. Using the binary name alone would
// resolve via the ambient PATH, so a user with `~/bin/launchctl` (or a
// hijacked PATH entry) could redirect privileged scheduler operations to
// a malicious binary. These locations are part of the OS image on every
// supported platform.
const LAUNCHCTL = '/bin/launchctl';
const SYSTEMCTL = '/usr/bin/systemctl';
// schtasks lives under SystemRoot, which is typically C:\Windows. We
// resolve via the SystemRoot env var with a sane default; if SystemRoot
// is unset (extremely unusual) fall back to the C:\Windows convention.
const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');

// Each platform exposes the same surface: install / uninstall / installed.
// macOS: launchd. Windows: schtasks. Linux: systemd user units.
//
// Security notes:
//   - The plist / unit / task command embeds process.execPath and
//     app.getAppPath(). Both are Electron-controlled but if the install
//     path contains a quote or newline (unusual but possible) the embedded
//     string would break the unit. assertSchedulerSafePath() rejects those
//     up-front rather than producing a malformed unit.
//   - The macOS template is the embedded DEFAULT_PLIST_TEMPLATE constant
//     ONLY. Reading from <appPath>/resources/launchagent.plist is removed:
//     in dev mode that path is repo-controlled, and any process running
//     as the user could swap the file before install fires.

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
  const electronPath = assertSchedulerSafePath(process.execPath, 'electronPath');
  const appPath = assertSchedulerSafePath(app.getAppPath(), 'appPath');
  const logDirSafe = assertSchedulerSafePath(logDir(), 'logDir');

  const plist = DEFAULT_PLIST_TEMPLATE.replace('__ELECTRON_PATH__', xmlEscape(electronPath))
    .replace('__APP_PATH__', xmlEscape(appPath))
    .replace(/__LOG_DIR__/g, xmlEscape(logDirSafe));

  const dest = launchAgentPlistPath();
  if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plist, { encoding: 'utf8', mode: 0o600 });
  // Re-chmod in case the file pre-existed with looser perms.
  try { fs.chmodSync(dest, 0o600); } catch {}

  const uid = (process.getuid && process.getuid()) || 0;
  // bootstrap is the modern launchctl call; bootout for uninstall.
  spawnSync(LAUNCHCTL, ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  const r = spawnSync(LAUNCHCTL, ['bootstrap', `gui/${uid}`, dest], { stdio: 'pipe' });
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
  spawnSync(LAUNCHCTL, ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return { ok: true };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  const r = spawnSync(SCHTASKS, ['/Query', '/TN', WIN_TASK_NAME], { stdio: 'pipe' });
  return r.status === 0;
}

function installWin(): { ok: true } {
  const electronPath = assertSchedulerSafePath(process.execPath, 'electronPath');
  const appPath = assertSchedulerSafePath(app.getAppPath(), 'appPath');
  // /TR receives a single string. We pass each path wrapped in plain double
  // quotes; assertSchedulerSafePath has already rejected any path containing
  // a `"` or shell metachars. spawnSync uses argv-array so no parent shell
  // re-parses /TR's value.
  const cmd = `"${electronPath}" "${appPath}" --reindex --no-window`;
  const r = spawnSync(
    SCHTASKS,
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
  spawnSync(SCHTASKS, ['/Delete', '/TN', WIN_TASK_NAME, '/F'], { stdio: 'ignore' });
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
  const electronPath = assertSchedulerSafePath(process.execPath, 'electronPath');
  const appPath = assertSchedulerSafePath(app.getAppPath(), 'appPath');
  // systemd ExecStart: each token is space-separated. Wrap path tokens in
  // double quotes so spaces are tolerated. assertSchedulerSafePath has
  // already rejected paths containing `"`, NUL, newline, $ or backtick.
  const service = `[Unit]
Description=Reclaude Indexer

[Service]
Type=oneshot
Environment=RECLAUDE_HEADLESS=1
ExecStart="${electronPath}" "${appPath}" --reindex --no-window
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
  fs.writeFileSync(systemdServicePath(), service, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(systemdTimerPath(), timer, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(systemdServicePath(), 0o600); } catch {}
  try { fs.chmodSync(systemdTimerPath(), 0o600); } catch {}
  spawnSync(SYSTEMCTL, ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const r = spawnSync(SYSTEMCTL, ['--user', 'enable', '--now', 'reclaude-indexer.timer'], {
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    throw new Error(`systemctl enable failed: ${r.stderr?.toString() ?? ''}`);
  }
  return { ok: true };
}

function uninstallLinux(): { ok: true } {
  spawnSync(SYSTEMCTL, ['--user', 'disable', '--now', 'reclaude-indexer.timer'], {
    stdio: 'ignore',
  });
  if (fs.existsSync(systemdTimerPath())) fs.unlinkSync(systemdTimerPath());
  if (fs.existsSync(systemdServicePath())) fs.unlinkSync(systemdServicePath());
  spawnSync(SYSTEMCTL, ['--user', 'daemon-reload'], { stdio: 'ignore' });
  return { ok: true };
}
