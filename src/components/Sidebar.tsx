import { useState } from 'react';
import type { ProjectGroup, SessionRow } from '../types';
import { relativeTime, shortId, projectName } from '../lib/format';
import TrashView from './TrashView';

export type SidebarTab = 'sessions' | 'trash';

interface Props {
  tab: SidebarTab;
  onTabChange: (t: SidebarTab) => void;
  groups: ProjectGroup[];
  trashed: SessionRow[];
  selectedId: string | null;
  onSelect: (s: SessionRow) => void;
  onResume: (s: SessionRow) => void;
  query: string;
  onQuery: (q: string) => void;
  onReindex: () => void;
}

export default function Sidebar({
  tab,
  onTabChange,
  groups,
  trashed,
  selectedId,
  onSelect,
  onResume,
  query,
  onQuery,
  onReindex,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Reclaude</h1>
        <div className="toolbar">
          <input
            className="search"
            placeholder={tab === 'sessions' ? 'Search sessions…' : 'Search disabled in Trash'}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            disabled={tab !== 'sessions'}
          />
          <button className="icon-btn" title="Reindex now" onClick={onReindex}>
            ↻
          </button>
        </div>
        <div className="tabs">
          <button
            className={`tab ${tab === 'sessions' ? 'active' : ''}`}
            onClick={() => onTabChange('sessions')}
          >
            Sessions
          </button>
          <button
            className={`tab ${tab === 'trash' ? 'active' : ''}`}
            onClick={() => onTabChange('trash')}
          >
            Trash {trashed.length > 0 && `(${trashed.length})`}
          </button>
        </div>
      </div>

      {tab === 'sessions' ? (
        <div className="tree">
          {groups.length === 0 ? (
            <div className="tree-empty">No sessions found.</div>
          ) : (
            groups.map((g) => {
              const isCollapsed = collapsed[g.cwd];
              const orphan = !g.exists_on_disk;
              return (
                <div className="project" key={g.cwd}>
                  <div
                    className="project-row"
                    title={g.cwd}
                    onClick={() => setCollapsed((p) => ({ ...p, [g.cwd]: !p[g.cwd] }))}
                  >
                    <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="project-name">{projectName(g.cwd)}</span>
                    {orphan && <span className="badge">orphaned</span>}
                    <span className="count">{g.sessions.length}</span>
                  </div>
                  {!isCollapsed &&
                    g.sessions.map((s) => (
                      <div
                        key={s.id}
                        className={`session ${selectedId === s.id ? 'selected' : ''}`}
                        onClick={() => onSelect(s)}
                        onDoubleClick={() => onResume(s)}
                        title={s.id}
                      >
                        <div className="session-line1">
                          <span className="session-id">{shortId(s.id)}</span>
                          <span className="session-time">{relativeTime(s.last_ts)}</span>
                        </div>
                        <div className="session-preview">
                          {s.preview || `${s.msg_count} messages`}
                        </div>
                      </div>
                    ))}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <TrashView trashed={trashed} selectedId={selectedId} onSelect={onSelect} />
      )}
    </aside>
  );
}
