export function relativeTime(ms: number | null): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function projectName(cwd: string): string {
  if (!cwd) return '(unknown)';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
