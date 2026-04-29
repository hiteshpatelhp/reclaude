// Cross-platform `clean` — removes build outputs so the next `npm run dev`
// or `npm run build` starts from a known-good state. Avoids stale
// dist-electron/*.js files surviving from a prior version of the source
// (which has been a real source of confusion: a prior security review
// flagged a vulnerability in dist-electron/scheduler.js that no longer
// existed in electron/scheduler.ts because the dev had not rebuilt).
//
// Uses fs.rmSync with `recursive: true, force: true` so it succeeds even
// when the targets don't exist. Node 14+ has rmSync; we target Node 20+ in
// engines, so it's always available.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const targets = ['dist', 'dist-electron'];

let removed = 0;
for (const t of targets) {
  const p = path.join(repoRoot, t);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('[clean] removed', p);
    removed++;
  }
}
if (removed === 0) {
  console.log('[clean] nothing to remove');
}
