import type { TaskSnapshot } from "@javis/core";
import {
  loadRecentWorkspacePaths,
  removeRecentWorkspacePath,
  saveRecentWorkspacePaths,
  upsertRecentWorkspacePath,
} from "./recent-workspaces";

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

export interface WorkspaceSession {
  workspacePath: string;
  recentWorkspacePaths: string[];
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
