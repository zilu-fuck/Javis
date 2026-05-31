import { describe, expect, it } from "vitest";
import {
  deletePersistedWorkspacePath,
  createWorkspaceSessionRepository,
  getCompletedTaskWorkspacePath,
  loadWorkspaceSession,
  loadWorkspaceSessionWithStorageFallback,
  persistWorkspaceForTaskStatus,
} from "./workspace-session";
import { RECENT_WORKSPACES_STORAGE_KEY } from "./recent-workspaces";
import type { DatabaseValue, DesktopDatabase } from "./desktop-database";

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
      " \\\\?\\E:\\Javis ",
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
          workspacePath: "\\\\?\\E:\\Javis",
          packageManager: "pnpm",
          scripts: [],
        },
      }),
    ).toBe("E:/Javis");
  });

  it("falls back past empty completed task workspace metadata", () => {
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
        workspacePath: "",
        codeProposedEdit: {
          proposalId: "proposal-1",
          workspacePath: "\\\\?\\E:\\Javis",
          summary: "Update project entry handling.",
          changedFiles: [],
          patch: "",
          patchHash: "fnv1a-test",
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

  it("persists workspace sessions through the async recent workspace repository", async () => {
    const database = createMemoryWorkspaceSessionDatabase();
    const repository = createWorkspaceSessionRepository(database);

    const saved = await repository.save({
      workspacePath: "G:/Current",
      recentWorkspacePaths: [" \\\\?\\E:\\Javis ", "e:/javis", "F:/Other"],
    });
    const loaded = await repository.load();

    expect(saved).toEqual({
      workspacePath: "G:/Current",
      recentWorkspacePaths: ["G:/Current", "E:/Javis", "F:/Other"],
    });
    expect(loaded).toEqual(saved);
    expect(database.rows.map((row) => row.path)).toEqual(["G:/Current", "E:/Javis", "F:/Other"]);
  });

  it("imports existing localStorage workspace session into the repository", async () => {
    const storage = createMemoryStorage();
    const repository = createWorkspaceSessionRepository(
      createMemoryWorkspaceSessionDatabase(),
    );
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify(["E:/Javis", "F:/Other"]),
    );

    const imported = await repository.importFromLocalStorage(storage);
    const loaded = await repository.load();

    expect(imported).toEqual({
      workspacePath: "E:/Javis",
      recentWorkspacePaths: ["E:/Javis", "F:/Other"],
    });
    expect(loaded).toEqual(imported);
    expect(storage.getItem(RECENT_WORKSPACES_STORAGE_KEY)).toBeNull();
  });

  it("falls back to localStorage when workspace repository loading fails", async () => {
    const storage = createMemoryStorage();
    storage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(["E:/Javis"]));
    const failingRepository = {
      async load() {
        throw new Error("unavailable");
      },
    };

    await expect(
      loadWorkspaceSessionWithStorageFallback(failingRepository, storage),
    ).resolves.toEqual({
      workspacePath: "E:/Javis",
      recentWorkspacePaths: ["E:/Javis"],
    });
    await expect(
      loadWorkspaceSessionWithStorageFallback(null, storage),
    ).resolves.toEqual({
      workspacePath: "E:/Javis",
      recentWorkspacePaths: ["E:/Javis"],
    });
  });
});

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryWorkspaceSessionDatabase() {
  const rows: WorkspaceSessionRow[] = [];
  const database: DesktopDatabase & {
    rows: WorkspaceSessionRow[];
  } = {
    rows,
    async execute(sql: string, values: DatabaseValue[] = []) {
      if (sql.startsWith("DELETE FROM recent_workspaces")) {
        rows.splice(0, rows.length);
        return;
      }
      if (!sql.startsWith("INSERT INTO recent_workspaces")) {
        return;
      }
      const row = {
        path: String(values[0]),
        sort_order: Number(values[1]),
        updated_at: String(values[2]),
      };
      const existingIndex = rows.findIndex((entry) => entry.path === row.path);
      if (existingIndex >= 0) {
        rows[existingIndex] = row;
      } else {
        rows.push(row);
      }
    },
    async select<T extends Record<string, unknown>>(_sql: string, values: DatabaseValue[] = []) {
      const limit = Number(values[0]);
      return [...rows]
        .sort(
          (left, right) =>
            left.sort_order - right.sort_order ||
            right.updated_at.localeCompare(left.updated_at),
        )
        .slice(0, limit)
        .map((row) => ({ path: row.path }) as unknown as T);
    },
  };
  return database;
}

interface WorkspaceSessionRow {
  path: string;
  sort_order: number;
  updated_at: string;
}
