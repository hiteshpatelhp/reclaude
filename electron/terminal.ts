import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { assertSafeId, assertSafeTerminalCwd } from './validation';

// All inputs that flow into a shell or AppleScript must be validated by the
// caller (see ipc.ts). Defense-in-depth: terminal.ts re-validates here so
// future callers (headless mode, plugins) cannot bypass the IPC seam.

// Absolute paths to system terminal-launching binaries on each platform.
// Using bare names would resolve via the ambient PATH — a user with a
// poisoned PATH (`~/bin/osascript` shadowing the real one) could redirect
// the launch to a malicious binary. The scheduler.ts module already follows
// this discipline (LAUNCHCTL/SYSTEMCTL/SCHTASKS); these constants extend it
// to the interactive terminal launcher.
const OSASCRIPT = '/usr/bin/osascript';
const CMD_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
// Windows Terminal lives under each user's LocalAppData. Falls back to
// `wt.exe` (PATH-resolved) only when LOCALAPPDATA is absent — exotic and
// non-default. Linux terminal emulators remain PATH-resolved by design:
// there is no canonical absolute location for x-terminal-emulator etc.
function wtExePath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    return path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  }
  return 'wt.exe';
}

// Returns a shell-safe single-quoted POSIX string. Correct for bash, zsh,
// dash. NOT correct for cmd.exe — Windows uses argv-based spawn below.
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
  // assertSafeTerminalCwd does two things in order:
  // 1) assertSafeAbsolutePath — absolute, no NUL/newline, length-capped
  // 2) isCwdInSafeRoot via fs.realpathSync — resolves symlinks before
  //    prefix-matching the allowlist, blocking /opt/escape→/etc tricks
  // SHELL_META_RE is deliberately NOT applied here — see the rationale
  // documented at validation.ts (assertSafeTerminalCwd doc comment).
  // The shq() + AppleScript escape chain in runMac, plus argv-array spawn
  // on Linux/Windows, is sufficient for the current invocation pattern;
  // chaining assertShellSafePath would reject legitimate paths such as
  // `~/My Project (v2)/` for no security gain.
  assertSafeTerminalCwd(cwd, 'cwd');
  assertSafeId(sessionId, 'sessionId');
  if (!fs.existsSync(cwd)) {
    // Do not embed `cwd` in the user-visible message — the path is
    // attacker-influenced (originates from JSONL) and the wrap() layer in
    // ipc.ts passes "not found" / "orphaned" messages through verbatim to
    // the renderer toast. Full detail goes to the audit log via wrap()'s
    // ipc.error event.
    console.error('[terminal] openInTerminal: cwd not found on disk', cwd);
    throw new Error(
      'Project directory not found on disk. Session is orphaned and cannot be resumed without recreating the directory.',
    );
  }
  return runInTerminal(cwd, sessionId, false);
}

export async function newSessionInProject(cwd: string): Promise<void> {
  assertSafeTerminalCwd(cwd, 'cwd');
  if (!fs.existsSync(cwd)) {
    console.error('[terminal] newSessionInProject: cwd not found on disk', cwd);
    throw new Error('Project directory not found.');
  }
  return runInTerminal(cwd, undefined, true);
}

function runInTerminal(cwd: string, sessionId: string | undefined, newSession: boolean): Promise<void> {
  if (process.platform === 'darwin') return runMac(cwd, sessionId, newSession);
  if (process.platform === 'win32') return runWin(cwd, sessionId, newSession);
  return runLinux(cwd, sessionId, newSession);
}

function runMac(cwd: string, sessionId: string | undefined, newSession: boolean): Promise<void> {
  // POSIX bash command. cwd and sessionId have been regex-validated, so
  // shq() output is bytewise-safe; the AppleScript escape stage handles
  // any backslash or double-quote that survives.
  const command = newSession ? buildNewCommand(cwd) : buildResumeCommand(cwd, sessionId!);
  const asEscaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"
  activate
  do script "${asEscaped}"
end tell`;
  return new Promise((resolve, reject) => {
    const p = spawn(OSASCRIPT, ['-e', script], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exit ${code}`))));
  });
}

function runWin(cwd: string, sessionId: string | undefined, newSession: boolean): Promise<void> {
  // Argv-based: `wt.exe -d <cwd> claude [--resume <id>]`. Each token is its
  // own argv entry, so cmd.exe never shell-parses cwd or sessionId.
  // Falls back to `cmd.exe /c start "Reclaude" /D <cwd> cmd /k claude ...`
  // which uses /D to set the starting directory and passes the program
  // name + args without a single concatenated command string.
  //
  // Promise contract: resolve once the spawn has been initiated and the
  // child unref'd. The 'error' handler must NOT race with the synchronous
  // resolve(); we use a `settled` flag and a microtask defer so that an
  // early-arriving error (e.g. wt.exe ENOENT) routes to the fallback
  // before the outer promise completes.
  const claudeArgs = newSession ? ['claude'] : ['claude', '--resume', sessionId!];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const tryWt = spawn(wtExePath(), ['-d', cwd, ...claudeArgs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    tryWt.unref();
    tryWt.on('error', () => {
      // wt.exe missing — fall back to cmd.exe /c start.
      const cmd = spawn(
        CMD_EXE,
        ['/c', 'start', 'Reclaude', '/D', cwd, CMD_EXE, '/k', ...claudeArgs],
        { detached: true, stdio: 'ignore', windowsHide: false },
      );
      cmd.unref();
      cmd.on('error', (e) => finish(() => reject(e)));
      // Best-effort success once the child has had a tick to spawn.
      setTimeout(() => finish(() => resolve()), 200);
    });
    // If wt.exe spawned without error, succeed after a short tick.
    setTimeout(() => finish(() => resolve()), 200);
  });
}

function runLinux(cwd: string, sessionId: string | undefined, newSession: boolean): Promise<void> {
  // Pass cwd via spawn's `cwd` option (no shell concat). The bash command
  // run inside the terminal references env vars, never substituted strings.
  const env = {
    ...process.env,
    RECLAUDE_SID: sessionId ?? '',
  };
  const bashCmd = newSession
    ? 'claude; exec bash'
    : 'claude --resume "$RECLAUDE_SID"; exec bash';

  // All candidates use argv-array form. Each token is a separate argv
  // entry, so the terminal emulator never re-shell-parses bashCmd. Earlier
  // versions used a single-string `-e` form for xfce4-terminal that
  // depended on hand-rolled single-quote escaping; that pattern has been
  // removed because it inverted the trust model the other entries use.
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', bashCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', bashCmd]],
    ['konsole', ['-e', 'bash', '-lc', bashCmd]],
    ['xfce4-terminal', ['-x', 'bash', '-lc', bashCmd]],
    ['xterm', ['-e', 'bash', '-lc', bashCmd]],
  ];
  return new Promise((resolve, reject) => {
    const tryNext = (i: number) => {
      if (i >= candidates.length) return reject(new Error('No terminal emulator found'));
      const [bin, args] = candidates[i];
      const p = spawn(bin, args, { detached: true, stdio: 'ignore', cwd, env });
      p.on('error', () => tryNext(i + 1));
      p.unref();
      // Best-effort success signal — assume it worked if no immediate error.
      setTimeout(resolve, 200);
    };
    tryNext(0);
  });
}
