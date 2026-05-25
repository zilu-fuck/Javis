import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SESSION_DEFAULT_ID,
  WORKSPACE_SESSION_SCHEMA_MIGRATION,
  WORKSPACE_SESSION_SCHEMA_MIGRATIONS,
  WORKSPACE_SESSION_SCHEMA_SQL,
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

  it("exposes SQLite-ready workspace session schema migration SQL", () => {
    expect(WORKSPACE_SESSION_SCHEMA_MIGRATION).toEqual({
      id: "001_workspace_session",
      sql: WORKSPACE_SESSION_SCHEMA_SQL,
    });
    expect(WORKSPACE_SESSION_SCHEMA_MIGRATIONS).toEqual([
      WORKSPACE_SESSION_SCHEMA_MIGRATION,
    ]);
    expect(WORKSPACE_SESSION_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS workspace_session",
    );
    expect(WORKSPACE_SESSION_SCHEMA_SQL).toContain(
      "recent_workspace_paths_json TEXT NOT NULL",
    );
  });

  it("persists workspace sessions through the async repository", async () => {
    const database = createMemoryWorkspaceSessionDatabase();
    const repository = createWorkspaceSessionRepository(database);

    const saved = await repository.save({
      workspacePath: "",
      recentWorkspacePaths: [" E:/Javis ", "e:/javis", "F:/Other"],
    });
    const loaded = await repository.load();

    expect(saved).toEqual({
      workspacePath: "E:/Javis",
      recentWorkspacePaths: ["E:/Javis", "F:/Other"],
    });
    expect(loaded).toEqual(saved);
    expect(database.row?.id).toBe(WORKSPACE_SESSION_DEFAULT_ID);
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

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryWorkspaceSessionDatabase() {
  const database: DesktopDatabase & {
    row: WorkspaceSessionRow | null;
  } = {
    row: null,
    async execute(sql: string, values: DatabaseValue[] = []) {
      if (!sql.startsWith("INSERT INTO workspace_session")) {
        return;
      }
      this.row = {
        id: String(values[0]),
        workspace_path: String(values[1]),
        recent_workspace_paths_json: String(values[2]),
        updated_at: String(values[3]),
      };
    },
    async select<T extends Record<string, unknown>>() {
      if (!this.row) {
        return [];
      }
      return [
        {
          workspace_path: this.row.workspace_path,
          recent_workspace_paths_json: this.row.recent_workspace_paths_json,
        } as unknown as T,
      ];
    },
  };
  return database;
}

interface WorkspaceSessionRow {
  id: string;
  workspace_path: string;
  recent_workspace_paths_json: string;
  updated_at: string;
}
