import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Validation helpers. Used at every IPC entry and at the JSONL parse seam
// to keep attacker-influenced strings out of shell commands and FS sinks.

// Session IDs derive from JSONL filenames (path.basename minus .jsonl).
// Real Claude Code IDs are UUIDv4. Allow that plus a defensive superset
// of "filesystem-safe, no shell metas, no leading dash" so we don't
// accidentally reject legacy rows while still blocking argument injection.
const SAFE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export function isSafeId(s: unknown): s is string {
  return typeof s === 'string' && SAFE_ID_RE.test(s);
}

export function assertSafeId(s: unknown, label = 'id'): string {
  if (!isSafeId(s)) {
    throw new Error(
      `Invalid ${label}: must match ${SAFE_ID_RE} (got ${typeof s === 'string' ? JSON.stringify(s.slice(0, 64)) : typeof s})`,
    );
  }
  return s;
}

// Reject paths containing NUL or newline. Length cap at 4096 covers PATH_MAX
// on every supported OS. Absolute-path requirement matches the existing
// fs.existsSync(cwd) check in terminal.ts and prevents path-traversal-style
// inputs from reaching the launcher.
const MAX_PATH_LEN = 4096;

export function isSafeAbsolutePath(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > MAX_PATH_LEN) return false;
  if (s.includes('\0') || s.includes('\n') || s.includes('\r')) return false;
  return path.isAbsolute(s);
}

export function assertSafeAbsolutePath(s: unknown, label = 'path'): string {
  if (!isSafeAbsolutePath(s)) {
    throw new Error(
      `Invalid ${label}: must be an absolute path under ${MAX_PATH_LEN} chars with no NUL or newline`,
    );
  }
  return s;
}

// Resolve a path with on-disk symlinks followed. When the path itself
// doesn't exist (e.g. the destination of a future rename), walks up to the
// nearest existing ancestor, realpath-resolves THAT, and re-appends the
// missing suffix. Without the ancestor resolution, a symlinked base like
// macOS `/tmp` → `/private/tmp` would resolve fine on the existing-side
// but the non-existent target side would skip realpath and end up
// lexically rooted at `/tmp` — the prefix-match would falsely fail.
// Same discipline as isCwdInSafeRoot at validation.ts:148, just extended
// to handle paths that haven't been created yet.
function safeResolve(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // Path doesn't exist — walk up until we find an existing ancestor,
    // realpath that, then re-append the trailing components verbatim.
    const parts = absolute.split(path.sep);
    const tail: string[] = [];
    while (parts.length > 1) {
      tail.unshift(parts.pop()!);
      const ancestor = parts.join(path.sep) || path.sep;
      try {
        const realAncestor = fs.realpathSync(ancestor);
        return path.join(realAncestor, ...tail);
      } catch {
        // keep walking up
      }
    }
    // Nothing exists on this path at all — return the lexical form.
    return absolute;
  }
}

// Containment check for any path derived from the DB or directory entries.
// Resolves both sides (following symlinks where the path exists) and
// confirms target lives under base (or is base itself). Use before
// fs.renameSync, fs.unlinkSync, fs.mkdirSync on any path that traces back
// to user-influenced data.
export function assertWithin(base: string, target: string, label = 'path'): string {
  const resolvedBase = safeResolve(base);
  const resolvedTarget = safeResolve(target);
  const baseWithSep = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(baseWithSep)) {
    throw new Error(
      `Refused ${label}: resolved path ${resolvedTarget} is outside ${resolvedBase}`,
    );
  }
  return resolvedTarget;
}

// Free-form text validation for fields like gitBranch, version, preview.
// We don't constrain content (these surface to the UI), only cap length to
// stop a pathological JSONL from filling the DB.
export function clampString(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

// Reject paths containing characters that would break our scheduler unit
// files or task command lines on any platform. Used in scheduler.ts before
// embedding electronPath / appPath into plist / systemd / schtasks strings.
//
// `%` is rejected because Windows schtasks /TR expands `%VAR%` at task
// execution time. `'` is rejected because it would break some shell-quoting
// edge cases on POSIX systems if the path is ever lifted out of the argv
// array. The remaining set (\0 \n \r " ` $) covers C-string boundaries,
// shell variable expansion, and command substitution.
export function assertSchedulerSafePath(p: string, label: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN) {
    throw new Error(`Invalid ${label}: empty or oversized`);
  }
  if (/[\0\n\r"'`$%]/.test(p)) {
    throw new Error(`Invalid ${label}: contains characters that cannot be safely embedded in a scheduler unit (\\0 \\n \\r \\" \\' \` $ %)`);
  }
  return p;
}

// Stricter variant of isSafeAbsolutePath for paths that flow into a shell
// (osascript do-script, bash -lc). Blocks shell metacharacters that are
// safe in argv but would be misinterpreted if the path is concatenated into
// a command string. Use at terminal launcher entry points; defense-in-depth
// over POSIX shq() since shq's correctness depends on the input lacking NUL.
const SHELL_META_RE = /[\0\n\r"'`$&;|<>\\(){}[\]*?!#~^]/;
export function assertShellSafePath(s: unknown, label = 'path'): string {
  const p = assertSafeAbsolutePath(s, label);
  if (SHELL_META_RE.test(p)) {
    throw new Error(`Invalid ${label}: contains shell metacharacters`);
  }
  return p;
}

// Allowlist of root directories from which a `cwd` may legitimately come.
// Used at IPC seams (sessions:openInTerminal, sessions:newInProject) to
// reject attacker-crafted JSONL pointing at /etc, /System, /sbin, etc.
//
// Permissive by design — covers home directories, common mount points
// (/Volumes on macOS, /mnt and /media on Linux), opt installs, and tmp dirs
// so that legitimate non-home project layouts work. Anything outside this
// list (system directories, application bundles, kernel pseudo-fs) is
// rejected.
function safeCwdRoots(): string[] {
  const roots: string[] = [os.homedir(), os.tmpdir(), '/tmp', '/workspace'];
  if (process.platform === 'darwin') {
    roots.push('/Volumes', '/opt', '/Users');
  } else if (process.platform === 'linux') {
    roots.push('/mnt', '/media', '/opt', '/srv', '/home');
  } else if (process.platform === 'win32') {
    // Enumerate every drive letter A–Z. Past restriction to C–G rejected
    // legitimate sessions on USB or network drives (H:, Z:, …). Per-root
    // existence is checked at realpath time below, so non-existent letters
    // are simply skipped.
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
      const letter = String.fromCharCode(code);
      roots.push(`${letter}:\\Users`);
      roots.push(`${letter}:\\Projects`);
      roots.push(`${letter}:\\dev`);
      roots.push(`${letter}:\\workspace`);
    }
  }
  return roots;
}

// Resolve all symlinks before doing the prefix check. `path.resolve` only
// normalises `..` segments — it does NOT follow on-disk symlinks. Without
// `fs.realpathSync` an attacker-planted symlink under one of the safe
// roots (e.g. `/opt/escape` → `/etc`) would let a crafted JSONL `cwd`
// pass the allowlist while pointing at sensitive system paths. ENOENT on
// the input reaches this function only if the cwd does not exist on disk,
// which terminal launch would fail anyway — return false.
export function isCwdInSafeRoot(p: string): boolean {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    return false;
  }
  for (const root of safeCwdRoots()) {
    let r: string;
    try {
      r = fs.realpathSync(root);
    } catch {
      // Root doesn't exist on this host; skip.
      continue;
    }
    if (process.platform === 'win32') {
      const a = resolved.toLowerCase();
      const rLower = r.toLowerCase();
      if (a === rLower) return true;
      if (a.startsWith(rLower + path.sep.toLowerCase())) return true;
    } else {
      if (resolved === r) return true;
      if (resolved.startsWith(r + path.sep)) return true;
    }
  }
  return false;
}

export function assertCwdInSafeRoot(p: unknown, label = 'cwd'): string {
  const validated = assertSafeAbsolutePath(p, label);
  if (!isCwdInSafeRoot(validated)) {
    throw new Error(
      `Invalid ${label}: path is not under a recognized user-data root (home, /Volumes, /mnt, /media, /opt, /tmp). Refusing to launch terminal at sensitive system path.`,
    );
  }
  return validated;
}

// Combined gate for paths that flow into the terminal launcher. Calls
// assertCwdInSafeRoot which itself chains:
//   1) assertSafeAbsolutePath — absolute, length-capped, no NUL/newline/CR
//   2) isCwdInSafeRoot — fs.realpathSync resolution then prefix check
//      against the home/Volumes/mnt/opt/tmp allowlist. The realpath step
//      is what blocks the `/opt/escape→/etc` symlink-bypass class.
//
// We deliberately do NOT chain assertShellSafePath here. The terminal
// launcher uses POSIX shq() (which wraps cwd in single quotes; `(`, `)`,
// `&`, etc. are literal inside `'...'`) on macOS, argv-array spawn on
// Linux and Windows (no shell parse at all), and an AppleScript escape
// stage that handles `\` and `"`. Adding a SHELL_META_RE check here
// would reject legitimate paths like `~/My Project (v2)/` for no
// security benefit — `(` and `)` cannot break the established escape
// chain. assertShellSafePath remains exported above for any future
// caller that DOES embed a path in a non-shq, non-argv context.
export function assertSafeTerminalCwd(p: unknown, label = 'cwd'): string {
  return assertCwdInSafeRoot(p, label);
}
