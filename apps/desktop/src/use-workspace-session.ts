import { useCallback, useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getPersistedWorkspacePaths,
  loadWorkspaceSession,
  type WorkspaceSession,
  type WorkspaceSessionRepository,
} from "./workspace-session";
import type { TaskSnapshot } from "@javis/core";
import { normalizeWorkspacePath, removeRecentWorkspacePath } from "./recent-workspaces";

export function useWorkspaceSessionControls(
  storage: Storage,
  repositoryRef?: RefObject<WorkspaceSessionRepository | null>,
) {
  const [workspaceSession, setWorkspaceSession] = useState(() =>
    loadWorkspaceSession(storage),
  );

  const persistWorkspaceForTask = useCallback((
    status: TaskSnapshot["status"],
    completedWorkspacePath: string,
  ) => {
    setWorkspaceSession((current) => {
      const recentWorkspacePaths = getPersistedWorkspacePaths(
        current.recentWorkspacePaths,
        completedWorkspacePath,
        status,
      );
      const repository = repositoryRef?.current;
      if (repository) {
        void repository
          .persistCompletedWorkspace(current.recentWorkspacePaths, completedWorkspacePath, status);
      }
      return {
        ...current,
        recentWorkspacePaths,
      };
    });
  }, [repositoryRef]);

  const useWorkspacePath = useCallback((path: string) => {
    setWorkspaceSession((current) => ({
      ...current,
      workspacePath: normalizeWorkspacePath(path),
    }));
  }, []);

  const browseWorkspacePath = useCallback(async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "Select Javis workspace",
    });
    if (typeof selectedPath === "string") {
      useWorkspacePath(selectedPath);
    }
  }, [useWorkspacePath]);

  const deleteRecentWorkspacePath = useCallback((path: string) => {
    setWorkspaceSession((current) => {
      const repository = repositoryRef?.current;
      const normalizedPath = normalizeWorkspacePath(path);
      const recentWorkspacePaths = removeRecentWorkspacePath(current.recentWorkspacePaths, normalizedPath);
      if (repository) {
        void repository
          .deleteWorkspacePath(current.recentWorkspacePaths, normalizedPath);
      }
      return {
        workspacePath:
          normalizeWorkspacePath(current.workspacePath).toLocaleLowerCase() === normalizedPath.toLocaleLowerCase()
            ? recentWorkspacePaths[0] ?? ""
            : current.workspacePath,
        recentWorkspacePaths,
      };
    });
  }, [repositoryRef]);

  const replaceWorkspaceSession = useCallback((session: WorkspaceSession) => {
    setWorkspaceSession(session);
  }, []);

  return {
    browseWorkspacePath,
    deleteRecentWorkspacePath,
    persistWorkspaceForTask,
    replaceWorkspaceSession,
    useWorkspacePath,
    workspaceSession,
  };
}
