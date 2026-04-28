import type { SessionRow } from '../types';
import { relativeTime, projectName, shortId } from '../lib/format';

interface Props {
  trashed: SessionRow[];
  selectedId: string | null;
  onSelect: (s: SessionRow) => void;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default function TrashView({ trashed, selectedId, onSelect }: Props) {
  if (trashed.length === 0) {
    return <div className="tree-empty">Trash is empty.</div>;
  }
  return (
    <div className="trash-list">
      {trashed.map((s) => {
        const deletedAt = s.deleted_at ?? 0;
        const purgeAt = deletedAt + SEVEN_DAYS_MS;
        const remainingMs = purgeAt - Date.now();
        const remaining =
          remainingMs <= 0
            ? 'purging soon'
            : remainingMs < 24 * 60 * 60 * 1000
              ? `${Math.floor(remainingMs / 3_600_000)}h left`
              : `${Math.floor(remainingMs / 86_400_000)}d left`;
        return (
          <div
            key={s.id}
            className={`trash-item ${selectedId === s.id ? 'selected' : ''}`}
            onClick={() => onSelect(s)}
            title={s.id}
          >
            <div className="id">{shortId(s.id)}</div>
            <div className="meta">
              {projectName(s.cwd)} · deleted {relativeTime(deletedAt)} · {remaining}
            </div>
            {s.preview && <div className="preview">{s.preview}</div>}
          </div>
        );
      })}
    </div>
  );
}
