import type { SessionRow } from '../types';
import { relativeTime, projectName } from '../lib/format';

interface Props {
  session: SessionRow | null;
  onResume: (s: SessionRow) => void;
  onNewInProject: (cwd: string) => void;
  onDelete: (s: SessionRow) => void;
  onRestore: (s: SessionRow) => void;
  onPurge: (s: SessionRow) => void;
}

export default function DetailPane({
  session,
  onResume,
  onNewInProject,
  onDelete,
  onRestore,
  onPurge,
}: Props) {
  if (!session) {
    return (
      <main className="detail">
        <div className="detail-empty">Double-click a session in the sidebar to resume.</div>
      </main>
    );
  }

  const cwdExists = !!session.cwd;
  const isTrashed = session.deleted_at != null;

  return (
    <main className="detail">
      <div className="detail-header">
        <h2>{session.id}</h2>
        <div className="subtitle">
          {projectName(session.cwd)} · {session.msg_count} messages ·{' '}
          {isTrashed
            ? `deleted ${relativeTime(session.deleted_at)}`
            : `last activity ${relativeTime(session.last_ts)}`}
        </div>
      </div>

      <div className="detail-actions">
        {isTrashed ? (
          <>
            <button className="btn" onClick={() => onRestore(session)}>
              Restore
            </button>
            <button
              className="btn danger"
              style={{ marginLeft: 'auto' }}
              onClick={() => onPurge(session)}
            >
              Delete permanently…
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => onResume(session)} disabled={!cwdExists}>
              Resume in Terminal
            </button>
            <button
              className="btn secondary"
              onClick={() => onNewInProject(session.cwd)}
              disabled={!cwdExists}
            >
              New session here
            </button>
            <button
              className="btn danger"
              style={{ marginLeft: 'auto' }}
              onClick={() => onDelete(session)}
            >
              Delete…
            </button>
          </>
        )}
      </div>

      <div className="detail-body">
        <div className="kv">
          <div className="k">Session ID</div>
          <div className="v">{session.id}</div>
          <div className="k">Project (cwd)</div>
          <div className="v">{session.cwd}</div>
          <div className="k">Encoded dir</div>
          <div className="v">{session.encoded_dir}</div>
          <div className="k">Git branch</div>
          <div className="v">{session.git_branch || '—'}</div>
          <div className="k">Claude version</div>
          <div className="v">{session.version || '—'}</div>
          <div className="k">First activity</div>
          <div className="v">
            {session.first_ts ? new Date(session.first_ts).toLocaleString() : '—'}
          </div>
          <div className="k">Last activity</div>
          <div className="v">
            {session.last_ts ? new Date(session.last_ts).toLocaleString() : '—'}
          </div>
          {isTrashed && (
            <>
              <div className="k">Deleted at</div>
              <div className="v">
                {session.deleted_at ? new Date(session.deleted_at).toLocaleString() : '—'}
              </div>
              <div className="k">Trash path</div>
              <div className="v">{session.trash_path || '—'}</div>
            </>
          )}
          <div className="k">Original path</div>
          <div className="v">{session.file_path}</div>
          <div className="k">File size</div>
          <div className="v">{(session.file_size / 1024).toFixed(1)} KB</div>
          <div className="k">Last preview</div>
          <div className="v">{session.preview || '—'}</div>
        </div>
      </div>
    </main>
  );
}
