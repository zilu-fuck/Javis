import { describe, expect, it } from "vitest";
import {
  deletePersistedWorkspacePath,
  getCompletedTaskWorkspacePath,
  loadWorkspaceSession,
  persistWorkspaceForTaskStatus,
} from "./workspace-session";
import { RECENT_WORKSPACES_STORAGE_KEY } from "./recent-workspaces";

describe("workspace session persistence", () => {
  it("restores the first recent workspace as the active workspace", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify(["E:/Javis", "F:/Other"]),
    );

    expect(loadWorkspaceSession(storage)).toEqual({
      workspacePath: "E:/Javis",
      recentWorkspacePaths: ["E:/Javis", "F:/Other"],
    });
  });

  it("persists completed workspaces for restart recovery", () => {
    const storage = createMemoryStorage();
    const recent = persistWorkspaceForTaskStatus(
      storage,
      [],
      " E:/Javis ",
      "completed",
    );

    expect(recent).toEqual(["E:/Javis"]);
    expect(loadWorkspaceSession(storage).workspacePath).toBe("E:/Javis");
  });

  it("does not persist failed workspace attempts", () => {
    const storage = createMemoryStorage();
    const recent = persistWorkspaceForTaskStatus(
      storage,
      ["E:/Javis"],
      "Z:/Missing",
      "failed",
    );

    expect(recent).toEqual(["E:/Javis"]);
    expect(loadWorkspaceSession(storage).recentWorkspacePaths).toEqual([]);
  });

  it("deletes recent workspaces from storage", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify(["E:/Javis", "F:/Other"]),
    );

    const recent = deletePersistedWorkspacePath(
      storage,
      ["E:/Javis", "F:/Other"],
      "e:/javis",
    );

    expect(recent).toEqual(["F:/Other"]);
    expect(loadWorkspaceSession(storage).recentWorkspacePaths).toEqual(["F:/Other"]);
  });

  it("uses completed project evidence as a restart workspace path", () => {
    expect(
      getCompletedTaskWorkspacePath({
        id: "task-1",
        title: "Project environment inspected",
        userGoal: "Inspect project",
        status: "completed",
        commanderMessage: "Done",
        plan: [],
        agents: [],
        logs: [],
        project: {
          workspacePath: "E:/Javis",
          packageManager: "pnpm",
          scripts: [],
        },
      }),
    ).toBe("E:/Javis");
  });

  it("ignores workspace evidence from incomplete tasks", () => {
    expect(
      getCompletedTaskWorkspacePath({
        id: "task-1",
        title: "Project environment inspected",
        userGoal: "Inspect project",
        status: "failed",
        commanderMessage: "Failed",
        plan: [],
        agents: [],
        logs: [],
        project: {
          workspacePath: "Z:/Missing",
          packageManager: "unknown",
          scripts: [],
        },
      }),
    ).toBe("");
  });
});

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
