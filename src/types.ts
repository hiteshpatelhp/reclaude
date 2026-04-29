export interface SessionRow {
  id: string;
  cwd: string;
  encoded_dir: string;
  file_path: string;
  first_ts: number | null;
  last_ts: number | null;
  msg_count: number;
  preview: string | null;
  version: string | null;
  git_branch: string | null;
  file_mtime: number;
  file_size: number;
  deleted_at: number | null;
  trash_path: string | null;
}

export interface ProjectGroup {
  cwd: string;
  encoded_dir: string;
  exists_on_disk: boolean;
  sessions: SessionRow[];
}

declare global {
  interface Window {
    reclaude: {
      platform: NodeJS.Platform;
      listSessions(): Promise<ProjectGroup[]>;
      listTrashed(): Promise<SessionRow[]>;
      search(q: string): Promise<SessionRow[]>;
      openInTerminal(id: string): Promise<void>;
      newSessionInProject(cwd: string): Promise<void>;
      deleteSession(id: string): Promise<{ ok: true; trashPath: string }>;
      restoreSession(id: string): Promise<{ ok: true; restoredTo: string }>;
      purgeSession(id: string): Promise<{ ok: true }>;
      reindex(): Promise<{ scanned: number; added: number; updated: number; unchanged: number; skipped?: number }>;
      schedulerStatus(): Promise<{ installed: boolean }>;
      schedulerInstall(): Promise<{ ok: true } | { ok: false; cancelled: true }>;
      schedulerUninstall(): Promise<{ ok: true } | { ok: false; cancelled: true }>;
      onSessionsChanged(cb: () => void): () => void;
    };
  }
}
