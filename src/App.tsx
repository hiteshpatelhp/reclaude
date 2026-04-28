import { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar, { SidebarTab } from './components/Sidebar';
import DetailPane from './components/DetailPane';
import ConfirmModal from './components/ConfirmModal';
import Toast from './components/Toast';
import type { ProjectGroup, SessionRow } from './types';

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

type Confirm =
  | { kind: 'delete'; session: SessionRow }
  | { kind: 'purge'; session: SessionRow }
  | null;

export default function App() {
  const [tab, setTab] = useState<SidebarTab>('sessions');
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [trashed, setTrashed] = useState<SessionRow[]>([]);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SessionRow[] | null>(null);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const load = useCallback(async () => {
    const [g, t] = await Promise.all([
      window.reclaude.listSessions(),
      window.reclaude.listTrashed(),
    ]);
    setGroups(g);
    setTrashed(t);
  }, []);

  useEffect(() => {
    load();
    const off = window.reclaude.onSessionsChanged(() => load());
    return off;
  }, [load]);

  // Clear selection when switching tabs so the detail pane stays in sync.
  useEffect(() => {
    setSelected(null);
  }, [tab]);

  // Debounced search (sessions tab only).
  useEffect(() => {
    if (tab !== 'sessions') {
      setSearchHits(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const hits = await window.reclaude.search(trimmed);
      setSearchHits(hits);
    }, 150);
    return () => clearTimeout(t);
  }, [query, tab]);

  const displayedGroups = useMemo<ProjectGroup[]>(() => {
    if (!searchHits) return groups;
    const cwdMeta = new Map(groups.map((g) => [g.cwd, g]));
    const byCwd = new Map<string, SessionRow[]>();
    for (const s of searchHits) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
      byCwd.get(s.cwd)!.push(s);
    }
    return Array.from(byCwd.entries()).map(([cwd, sessions]) => {
      const meta = cwdMeta.get(cwd);
      return {
        cwd,
        encoded_dir: meta?.encoded_dir ?? sessions[0].encoded_dir,
        exists_on_disk: meta?.exists_on_disk ?? false,
        sessions,
      };
    });
  }, [searchHits, groups]);

  const handleResume = useCallback(async (s: SessionRow) => {
    try {
      await window.reclaude.openInTerminal(s.id);
      setToast({ message: `Resuming ${s.id.slice(0, 8)} in Terminal…` });
    } catch (e: any) {
      setToast({ message: `Resume failed: ${e.message}` });
    }
  }, []);

  const handleNewInProject = useCallback(async (cwd: string) => {
    try {
      await window.reclaude.newSessionInProject(cwd);
      setToast({ message: `Opening new session in ${cwd}…` });
    } catch (e: any) {
      setToast({ message: `Failed: ${e.message}` });
    }
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!confirm || confirm.kind !== 'delete') return;
    const s = confirm.session;
    setConfirm(null);
    try {
      await window.reclaude.deleteSession(s.id);
      if (selected?.id === s.id) setSelected(null);
      await load();
      setToast({
        message: `Moved ${s.id.slice(0, 8)} to trash`,
        actionLabel: 'Undo',
        onAction: async () => {
          await window.reclaude.restoreSession(s.id);
          await load();
          setToast({ message: `Restored ${s.id.slice(0, 8)}` });
        },
      });
    } catch (e: any) {
      setToast({ message: `Delete failed: ${e.message}` });
    }
  }, [confirm, selected, load]);

  const handleConfirmPurge = useCallback(async () => {
    if (!confirm || confirm.kind !== 'purge') return;
    const s = confirm.session;
    setConfirm(null);
    try {
      await window.reclaude.purgeSession(s.id);
      if (selected?.id === s.id) setSelected(null);
      await load();
      setToast({ message: `Permanently deleted ${s.id.slice(0, 8)}` });
    } catch (e: any) {
      setToast({ message: `Purge failed: ${e.message}` });
    }
  }, [confirm, selected, load]);

  const handleRestore = useCallback(
    async (s: SessionRow) => {
      try {
        await window.reclaude.restoreSession(s.id);
        await load();
        setToast({ message: `Restored ${s.id.slice(0, 8)}` });
        setSelected(null);
      } catch (e: any) {
        setToast({ message: `Restore failed: ${e.message}` });
      }
    },
    [load],
  );

  const handleReindex = useCallback(async () => {
    setToast({ message: 'Reindexing…' });
    const r = await window.reclaude.reindex();
    await load();
    setToast({
      message: `Reindex done: ${r.scanned} scanned, ${r.added} new, ${r.updated} updated`,
    });
  }, [load]);

  return (
    <div className="app">
      <Sidebar
        tab={tab}
        onTabChange={setTab}
        groups={displayedGroups}
        trashed={trashed}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        onResume={handleResume}
        query={query}
        onQuery={setQuery}
        onReindex={handleReindex}
      />
      <DetailPane
        session={selected}
        onResume={handleResume}
        onNewInProject={handleNewInProject}
        onDelete={(s) => setConfirm({ kind: 'delete', session: s })}
        onRestore={handleRestore}
        onPurge={(s) => setConfirm({ kind: 'purge', session: s })}
      />
      {confirm?.kind === 'delete' && (
        <ConfirmModal
          title="Delete session?"
          body={`Session ${confirm.session.id.slice(0, 8)}… will be moved to Reclaude's trash and permanently deleted after 7 days. You can restore it from the Trash tab.`}
          confirmLabel="Delete"
          danger
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'purge' && (
        <ConfirmModal
          title="Permanently delete session?"
          body={`Session ${confirm.session.id.slice(0, 8)}… will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete forever"
          danger
          onConfirm={handleConfirmPurge}
          onCancel={() => setConfirm(null)}
        />
      )}
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
