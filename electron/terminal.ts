import { spawn } from 'child_process';
import * as fs from 'fs';

// Returns a shell-safe single-quoted string.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildResumeCommand(cwd: string, sessionId: string): string {
  return `cd ${shq(cwd)} && claude --resume ${shq(sessionId)}`;
}

function buildNewCommand(cwd: string): string {
  return `cd ${shq(cwd)} && claude`;
}

export async function openInTerminal(cwd: string, sessionId: string): Promise<void> {
  if (!fs.existsSync(cwd)) {
    throw new Error(
      `Project directory not found on disk: ${cwd}. Session is orphaned and cannot be resumed without recreating the directory.`,
    );
  }
  const cmd = buildResumeCommand(cwd, sessionId);
  return runInTerminal(cmd);
}

export async function newSessionInProject(cwd: string): Promise<void> {
  if (!fs.existsSync(cwd)) throw new Error(`Project directory not found: ${cwd}`);
  return runInTerminal(buildNewCommand(cwd));
}

function runInTerminal(command: string): Promise<void> {
  if (process.platform === 'darwin') return runMac(command);
  if (process.platform === 'win32') return runWin(command);
  return runLinux(command);
}

function runMac(command: string): Promise<void> {
  // AppleScript embeds the command as a single-quoted string literal.
  // Escape backslashes and double quotes for AppleScript.
  const asEscaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"
  activate
  do script "${asEscaped}"
end tell`;
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exit ${code}`))));
  });
}

function runWin(command: string): Promise<void> {
  // Prefer Windows Terminal (`wt`); fall back to cmd.exe.
  return new Promise((resolve, reject) => {
    const tryWt = spawn('wt.exe', ['cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    tryWt.on('error', () => {
      const cmd = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      cmd.on('error', reject);
      cmd.unref();
      resolve();
    });
    tryWt.unref();
    resolve();
  });
}

function runLinux(command: string): Promise<void> {
  // Try a sequence of terminals. First match wins.
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', `bash -lc ${shq(command + '; exec bash')}`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `${command}; exec bash`]],
    ['konsole', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ['xfce4-terminal', ['-e', `bash -lc ${shq(command + '; exec bash')}`]],
    ['xterm', ['-e', `bash -lc ${shq(command + '; exec bash')}`]],
  ];
  return new Promise((resolve, reject) => {
    const tryNext = (i: number) => {
      if (i >= candidates.length) return reject(new Error('No terminal emulator found'));
      const [bin, args] = candidates[i];
      const p = spawn(bin, args, { detached: true, stdio: 'ignore' });
      p.on('error', () => tryNext(i + 1));
      p.unref();
      // We can't easily verify success; assume it worked if no immediate error.
      setTimeout(resolve, 200);
    };
    tryNext(0);
  });
}
