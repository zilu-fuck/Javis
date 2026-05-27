import { useCallback, useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  deletePersistedWorkspacePath,
  getPersistedWorkspacePaths,
  loadWorkspaceSession,
  persistWorkspaceForTaskStatus,
  type WorkspaceSession,
  type WorkspaceSessionRepository,
} from "./workspace-session";
import type { TaskSnapshot } from "@javis/core";
import { removeRecentWorkspacePath } from "./recent-workspaces";

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
          .persistCompletedWorkspace(current.recentWorkspacePaths, completedWorkspacePath, status)
          .catch(() => {
            persistWorkspaceForTaskStatus(
              storage,
              current.recentWorkspacePaths,
              completedWorkspacePath,
              status,
            );
          });
      } else {
        persistWorkspaceForTaskStatus(
          storage,
          current.recentWorkspacePaths,
          completedWorkspacePath,
          status,
        );
      }
      return {
        ...current,
        recentWorkspacePaths,
      };
    });
  }, [repositoryRef, storage]);

  const useWorkspacePath = useCallback((path: string) => {
    setWorkspaceSession((current) => ({
      ...current,
      workspacePath: path.trim(),
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
      const recentWorkspacePaths = repository
        ? removeRecentWorkspacePath(current.recentWorkspacePaths, path)
        : deletePersistedWorkspacePath(storage, current.recentWorkspacePaths, path);
      if (repository) {
        void repository
          .deleteWorkspacePath(current.recentWorkspacePaths, path)
          .catch(() => {
            deletePersistedWorkspacePath(storage, current.recentWorkspacePaths, path);
          });
      }
      return {
        workspacePath:
          current.workspacePath.toLocaleLowerCase() === path.trim().toLocaleLowerCase()
            ? recentWorkspacePaths[0] ?? ""
            : current.workspacePath,
        recentWorkspacePaths,
      };
    });
  }, [repositoryRef, storage]);

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
