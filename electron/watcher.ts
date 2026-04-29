import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import { claudeProjectsDir } from './paths';
import { reindexFile } from './indexer';
import { purgeSession, isSessionTrashed } from './db';

let watcher: FSWatcher | null = null;
let pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 250;
// Cap on the in-flight queue size. A process rapidly creating .jsonl files
// in ~/.claude/projects/ would otherwise grow this Set unboundedly until
// the debounce timer fires. 10 000 events between flushes is well beyond
// any legitimate workload.
const MAX_PENDING = 10_000;

export function startWatcher(onChange: () => void) {
  if (watcher) return;
  if (!fs.existsSync(claudeProjectsDir)) return;

  watcher = chokidar.watch(claudeProjectsDir, {
    ignoreInitial: true,
    depth: 2,
    // Reject symlinks: any other process running as the user could plant a
    // symlink in ~/.claude/projects pointing outside, and we'd index that
    // file as if it were a Claude session. Chokidar's default is true.
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });

  const flush = () => {
    timer = null;
    const files = Array.from(pending);
    pending.clear();
    let touched = false;
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (fs.existsSync(f)) {
        if (reindexFile(f)) touched = true;
      } else {
        const id = path.basename(f).replace(/\.jsonl$/, '');
        // Skip sessions we soft-deleted ourselves — the unlink event here is
        // our own rename into the trash dir; the row has `deleted_at` set
        // and must remain so the Trash view can show it.
        if (isSessionTrashed(id)) continue;
        purgeSession(id);
        touched = true;
      }
    }
    if (touched) onChange();
  };

  const queue = (p: string) => {
    if (pending.size >= MAX_PENDING) return;
    pending.add(p);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  watcher.on('add', queue);
  watcher.on('change', queue);
  watcher.on('unlink', queue);
}

export function stopWatcher() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
  }
}
