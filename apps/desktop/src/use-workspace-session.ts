import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  deletePersistedWorkspacePath,
  loadWorkspaceSession,
  persistWorkspaceForTaskStatus,
} from "./workspace-session";
import type { TaskSnapshot } from "@javis/core";

export function useWorkspaceSessionControls(storage: Storage) {
  const [workspaceSession, setWorkspaceSession] = useState(() =>
    loadWorkspaceSession(storage),
  );

  const persistWorkspaceForTask = useCallback((
    status: TaskSnapshot["status"],
    completedWorkspacePath: string,
  ) => {
    setWorkspaceSession((current) => ({
      ...current,
      recentWorkspacePaths: persistWorkspaceForTaskStatus(
        storage,
        current.recentWorkspacePaths,
        completedWorkspacePath,
        status,
      ),
    }));
  }, [storage]);

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
      const recentWorkspacePaths = deletePersistedWorkspacePath(
        storage,
        current.recentWorkspacePaths,
        path,
      );
      return {
        workspacePath:
          current.workspacePath.toLocaleLowerCase() === path.trim().toLocaleLowerCase()
            ? recentWorkspacePaths[0] ?? ""
            : current.workspacePath,
        recentWorkspacePaths,
      };
    });
  }, [storage]);

  return {
    browseWorkspacePath,
    deleteRecentWorkspacePath,
    persistWorkspaceForTask,
    useWorkspacePath,
    workspaceSession,
  };
}
