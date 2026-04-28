import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

export const homedir = os.homedir();

// Claude Code stores all project sessions here on every platform.
export const claudeProjectsDir = path.join(homedir, '.claude', 'projects');

// userData lives in:
//   macOS:   ~/Library/Application Support/Reclaude
//   Windows: %APPDATA%/Reclaude
//   Linux:   ~/.config/Reclaude
export function userDataDir(): string {
  return app.getPath('userData');
}

export function dbPath(): string {
  return path.join(userDataDir(), 'index.db');
}

export function trashDir(): string {
  return path.join(userDataDir(), 'trash');
}

export function logDir(): string {
  return path.join(userDataDir(), 'logs');
}

export function launchAgentPlistPath(): string {
  return path.join(homedir, 'Library', 'LaunchAgents', 'com.reclaude.indexer.plist');
}
