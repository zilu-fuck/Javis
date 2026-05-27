import type { TaskSnapshot } from "@javis/core";
import {
  importRecentWorkspacePathsFromLocalStorage,
  loadRecentWorkspacePathsFromDatabase,
  loadRecentWorkspacePaths,
  removeRecentWorkspacePath,
  normalizeWorkspacePath,
  sanitizeWorkspacePaths,
  saveRecentWorkspacePathsToDatabase,
  saveRecentWorkspacePaths,
  upsertRecentWorkspacePath,
} from "./recent-workspaces";
import type { DesktopDatabase } from "./desktop-database";

type WorkspaceReadStorage = Pick<Storage, "getItem">;
type WorkspaceWriteStorage = Pick<Storage, "setItem">;
type WorkspaceMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export interface WorkspaceSession {
  workspacePath: string;
  recentWorkspacePaths: string[];
}

export interface WorkspaceSessionRepository {
  load(): Promise<WorkspaceSession>;
  save(session: WorkspaceSession): Promise<WorkspaceSession>;
  persistCompletedWorkspace(
    currentPaths: string[],
    workspacePath: string,
    taskStatus: TaskSnapshot["status"],
  ): Promise<WorkspaceSession>;
  deleteWorkspacePath(currentPaths: string[], workspacePath: string): Promise<WorkspaceSession>;
  importFromLocalStorage(storage: WorkspaceMigrationStorage): Promise<WorkspaceSession>;
}

export function loadWorkspaceSession(storage: WorkspaceReadStorage): WorkspaceSession {
  const recentWorkspacePaths = loadRecentWorkspacePaths(storage);
  return {
    workspacePath: recentWorkspacePaths[0] ?? "",
    recentWorkspacePaths,
  };
}

export function persistWorkspaceForTaskStatus(
  storage: WorkspaceWriteStorage,
  currentPaths: string[],
  workspacePath: string,
  taskStatus: TaskSnapshot["status"],
): string[] {
  if (taskStatus !== "completed") {
    return currentPaths;
  }

  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (!normalizedWorkspacePath) {
    return currentPaths;
  }

  return saveRecentWorkspacePaths(
    storage,
    upsertRecentWorkspacePath(currentPaths, normalizedWorkspacePath),
  );
}

export function getCompletedTaskWorkspacePath(task: TaskSnapshot): string {
  if (task.status !== "completed") {
    return "";
  }

  return normalizeWorkspacePath(task.project?.workspacePath ?? task.codeReviewPreview?.workspacePath ?? "");
}

export function deletePersistedWorkspacePath(
  storage: WorkspaceWriteStorage,
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
      const recentWorkspacePaths = await loadRecentWorkspacePathsFromDatabase(database);
      return sanitizeWorkspaceSession({
        workspacePath: recentWorkspacePaths[0] ?? "",
        recentWorkspacePaths,
      });
    },

    async save(session) {
      const sanitized = sanitizeWorkspaceSession(session);
      const nextRecentWorkspacePaths = sanitized.workspacePath
        ? upsertRecentWorkspacePath(sanitized.recentWorkspacePaths, sanitized.workspacePath)
        : sanitized.recentWorkspacePaths;
      const savedRecentWorkspacePaths = await saveRecentWorkspacePathsToDatabase(
        database,
        nextRecentWorkspacePaths,
      );
      return sanitizeWorkspaceSession({
        workspacePath: sanitized.workspacePath || savedRecentWorkspacePaths[0] || "",
        recentWorkspacePaths: savedRecentWorkspacePaths,
      });
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
      const savedPaths = await saveRecentWorkspacePathsToDatabase(
        database,
        session.recentWorkspacePaths,
      );
      return sanitizeWorkspaceSession({
        workspacePath: session.workspacePath,
        recentWorkspacePaths: savedPaths,
      });
    },

    async deleteWorkspacePath(currentPaths, workspacePath) {
      const recentWorkspacePaths = removeRecentWorkspacePath(currentPaths, workspacePath);
      const session = sanitizeWorkspaceSession({
        workspacePath: recentWorkspacePaths[0] ?? "",
        recentWorkspacePaths,
      });
      const savedPaths = await saveRecentWorkspacePathsToDatabase(
        database,
        session.recentWorkspacePaths,
      );
      return sanitizeWorkspaceSession({
        workspacePath: session.workspacePath,
        recentWorkspacePaths: savedPaths,
      });
    },

    async importFromLocalStorage(storage) {
      const recentWorkspacePaths = await importRecentWorkspacePathsFromLocalStorage(
        database,
        storage,
      );
      return sanitizeWorkspaceSession({
        workspacePath: recentWorkspacePaths[0] ?? "",
        recentWorkspacePaths,
      });
    },
  };
}

export async function loadWorkspaceSessionWithStorageFallback(
  repository: Pick<WorkspaceSessionRepository, "load"> | null | undefined,
  storage: WorkspaceReadStorage,
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

export function getPersistedWorkspacePaths(
  currentPaths: string[],
  workspacePath: string,
  taskStatus: TaskSnapshot["status"],
): string[] {
  if (taskStatus !== "completed") {
    return sanitizeWorkspacePaths(currentPaths);
  }

  return upsertRecentWorkspacePath(currentPaths, workspacePath);
}

function sanitizeWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
  const recentWorkspacePaths = sanitizeWorkspacePaths(session.recentWorkspacePaths);
  const workspacePath = normalizeWorkspacePath(session.workspacePath);
  const activeWorkspacePath = workspacePath || recentWorkspacePaths[0] || "";
  return {
    workspacePath: activeWorkspacePath,
    recentWorkspacePaths,
  };
}
