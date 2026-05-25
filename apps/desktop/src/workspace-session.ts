import type { TaskSnapshot } from "@javis/core";
import {
  loadRecentWorkspacePaths,
  removeRecentWorkspacePath,
  saveRecentWorkspacePaths,
  upsertRecentWorkspacePath,
} from "./recent-workspaces";
import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

export interface WorkspaceSession {
  workspacePath: string;
  recentWorkspacePaths: string[];
}

export const WORKSPACE_SESSION_TABLE_NAME = "workspace_session";
export const WORKSPACE_SESSION_DEFAULT_ID = "default";
export const WORKSPACE_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_session (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  recent_workspace_paths_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`.trim();
export const WORKSPACE_SESSION_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "001_workspace_session",
  sql: WORKSPACE_SESSION_SCHEMA_SQL,
};
export const WORKSPACE_SESSION_SCHEMA_MIGRATIONS: DesktopDatabaseMigration[] = [
  WORKSPACE_SESSION_SCHEMA_MIGRATION,
];

export interface WorkspaceSessionRepository {
  load(): Promise<WorkspaceSession>;
  save(session: WorkspaceSession): Promise<WorkspaceSession>;
  persistCompletedWorkspace(
    currentPaths: string[],
    workspacePath: string,
    taskStatus: TaskSnapshot["status"],
  ): Promise<WorkspaceSession>;
  deleteWorkspacePath(currentPaths: string[], workspacePath: string): Promise<WorkspaceSession>;
  importFromLocalStorage(storage: WorkspaceStorage): Promise<WorkspaceSession>;
}

export function loadWorkspaceSession(storage: WorkspaceStorage): WorkspaceSession {
  const recentWorkspacePaths = loadRecentWorkspacePaths(storage);
  return {
    workspacePath: recentWorkspacePaths[0] ?? "",
    recentWorkspacePaths,
  };
}

export function persistWorkspaceForTaskStatus(
  storage: WorkspaceStorage,
  currentPaths: string[],
  workspacePath: string,
  taskStatus: TaskSnapshot["status"],
): string[] {
  if (taskStatus !== "completed") {
    return currentPaths;
  }

  const normalizedPath = workspacePath.trim();
  if (!normalizedPath) {
    return currentPaths;
  }

  return saveRecentWorkspacePaths(
    storage,
    upsertRecentWorkspacePath(currentPaths, normalizedPath),
  );
}

export function getCompletedTaskWorkspacePath(task: TaskSnapshot): string {
  if (task.status !== "completed") {
    return "";
  }

  return task.project?.workspacePath ?? task.codeReviewPreview?.workspacePath ?? "";
}

export function deletePersistedWorkspacePath(
  storage: WorkspaceStorage,
  currentPaths: string[],
  workspacePath: string,
): string[] {
  return saveRecentWorkspacePaths(
    storage,
    removeRecentWorkspacePath(currentPaths, workspacePath),
  );
}

export function createWorkspaceSessionRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): WorkspaceSessionRepository {
  return {
    async load() {
      return loadWorkspaceSessionRow(database);
    },

    async save(session) {
      const sanitized = sanitizeWorkspaceSession(session);
      await saveWorkspaceSessionRow(database, sanitized);
      return sanitized;
    },

    async persistCompletedWorkspace(currentPaths, workspacePath, taskStatus) {
      const recentWorkspacePaths = getPersistedWorkspacePaths(
        currentPaths,
        workspacePath,
        taskStatus,
      );
      const session = sanitizeWorkspaceSession({
        workspacePath: recentWorkspacePaths[0] ?? "",
        recentWorkspacePaths,
      });
      await saveWorkspaceSessionRow(database, session);
      return session;
    },

    async deleteWorkspacePath(currentPaths, workspacePath) {
      const recentWorkspacePaths = removeRecentWorkspacePath(currentPaths, workspacePath);
      const session = sanitizeWorkspaceSession({
        workspacePath: recentWorkspacePaths[0] ?? "",
        recentWorkspacePaths,
      });
      await saveWorkspaceSessionRow(database, session);
      return session;
    },

    async importFromLocalStorage(storage) {
      const importedSession = loadWorkspaceSession(storage);
      if (importedSession.recentWorkspacePaths.length === 0) {
        return loadWorkspaceSessionRow(database);
      }
      await saveWorkspaceSessionRow(database, importedSession);
      return importedSession;
    },
  };
}

export async function loadWorkspaceSessionWithStorageFallback(
  repository: Pick<WorkspaceSessionRepository, "load"> | null | undefined,
  storage: WorkspaceStorage,
): Promise<WorkspaceSession> {
  if (!repository) {
    return loadWorkspaceSession(storage);
  }
  try {
    return await repository.load();
  } catch {
    return loadWorkspaceSession(storage);
  }
}

function getPersistedWorkspacePaths(
  currentPaths: string[],
  workspacePath: string,
  taskStatus: TaskSnapshot["status"],
): string[] {
  if (taskStatus !== "completed") {
    return sanitizeWorkspacePaths(currentPaths);
  }

  return upsertRecentWorkspacePath(currentPaths, workspacePath);
}

async function loadWorkspaceSessionRow(
  database: Pick<DesktopDatabase, "select">,
): Promise<WorkspaceSession> {
  const rows = await database.select<{
    workspace_path: string;
    recent_workspace_paths_json: string;
  }>(
    `SELECT workspace_path, recent_workspace_paths_json FROM ${WORKSPACE_SESSION_TABLE_NAME} WHERE id = ? LIMIT 1`,
    [WORKSPACE_SESSION_DEFAULT_ID],
  );
  const row = rows[0];
  if (!row) {
    return { workspacePath: "", recentWorkspacePaths: [] };
  }

  return sanitizeWorkspaceSession({
    workspacePath: row.workspace_path,
    recentWorkspacePaths: parseWorkspacePathArray(row.recent_workspace_paths_json),
  });
}

async function saveWorkspaceSessionRow(
  database: Pick<DesktopDatabase, "execute">,
  session: WorkspaceSession,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  const sanitized = sanitizeWorkspaceSession(session);
  await database.execute(
    `INSERT INTO ${WORKSPACE_SESSION_TABLE_NAME} (id, workspace_path, recent_workspace_paths_json, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  workspace_path = excluded.workspace_path,
  recent_workspace_paths_json = excluded.recent_workspace_paths_json,
  updated_at = excluded.updated_at`,
    workspaceSessionBindValues(sanitized, updatedAt),
  );
}

function workspaceSessionBindValues(
  session: WorkspaceSession,
  updatedAt: string,
): DatabaseValue[] {
  return [
    WORKSPACE_SESSION_DEFAULT_ID,
    session.workspacePath,
    JSON.stringify(session.recentWorkspacePaths),
    updatedAt,
  ];
}

function sanitizeWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
  const recentWorkspacePaths = sanitizeWorkspacePaths(session.recentWorkspacePaths);
  const workspacePath = session.workspacePath.trim();
  const activeWorkspacePath = workspacePath || recentWorkspacePaths[0] || "";
  return {
    workspacePath: activeWorkspacePath,
    recentWorkspacePaths,
  };
}

function sanitizeWorkspacePaths(paths: unknown[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const entry of paths) {
    if (typeof entry !== "string") {
      continue;
    }
    const path = entry.trim();
    if (!path) {
      continue;
    }
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sanitized.push(path);
  }

  return sanitized;
}

function parseWorkspacePathArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? sanitizeWorkspacePaths(parsed) : [];
  } catch {
    return [];
  }
}
