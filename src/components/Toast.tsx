import { useEffect } from 'react';

interface Props {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  ttlMs?: number;
}

export default function Toast({ message, actionLabel, onAction, onDismiss, ttlMs = 5000 }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, ttlMs);
    return () => clearTimeout(t);
  }, [onDismiss, ttlMs]);

  return (
    <div className="toast">
      <span>{message}</span>
      {actionLabel && onAction && (
        <button onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
