import { describe, expect, it } from "vitest";
import {
  RECENT_WORKSPACES_LIMIT,
  RECENT_WORKSPACES_SCHEMA_MIGRATION,
  RECENT_WORKSPACES_SCHEMA_MIGRATIONS,
  RECENT_WORKSPACES_SCHEMA_SQL,
  RECENT_WORKSPACES_SORT_ORDER_INDEX_MIGRATION,
  RECENT_WORKSPACES_SORT_ORDER_INDEX_SQL,
  RECENT_WORKSPACES_STORAGE_KEY,
  RECENT_WORKSPACES_STORAGE_VERSION,
  createRecentWorkspacesRepository,
  importRecentWorkspacePathsFromLocalStorage,
  loadRecentWorkspacePaths,
  loadRecentWorkspacePathsFromDatabase,
  loadRecentWorkspacePathsWithStorageFallback,
  removeRecentWorkspacePath,
  saveRecentWorkspacePaths,
  normalizeWorkspacePath,
  upsertRecentWorkspacePath,
} from "./recent-workspaces";
import type { DatabaseValue, DesktopDatabase } from "./desktop-database";

describe("recent workspace persistence", () => {
  it("loads sanitized recent workspace paths", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify([" E:/Javis ", "", 42, "E:/Javis", "F:/Other"]),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual(["E:/Javis", "F:/Other"]);
  });

  it("normalizes Windows verbatim workspace paths", () => {
    expect(normalizeWorkspacePath("\\\\?\\E:\\Javis")).toBe("E:/Javis");
    expect(
      loadRecentWorkspacePaths(createStorage(["\\\\?\\E:\\Javis", "E:\\Javis"])),
    ).toEqual(["E:/Javis"]);
  });

  it("loads versioned recent workspace storage envelopes", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        version: RECENT_WORKSPACES_STORAGE_VERSION,
        paths: [" E:/Javis ", "", 42, "F:/Other"],
      }),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual(["E:/Javis", "F:/Other"]);
  });

  it("ignores recent workspace storage envelopes from unknown versions", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        version: RECENT_WORKSPACES_STORAGE_VERSION + 1,
        paths: ["E:/Javis"],
      }),
    );

    expect(loadRecentWorkspacePaths(storage)).toEqual([]);
  });

  it("upserts paths at the front without case-insensitive duplicates", () => {
    const paths = upsertRecentWorkspacePath(["E:/Javis", "F:/Other"], "e:/javis");

    expect(paths).toEqual(["e:/javis", "F:/Other"]);
  });

  it("upserts verbatim Windows paths without duplicating the same workspace", () => {
    const paths = upsertRecentWorkspacePath(["E:/Javis", "F:/Other"], "\\\\?\\E:\\Javis");

    expect(paths).toEqual(["E:/Javis", "F:/Other"]);
  });

  it("saves only the configured limit", () => {
    const storage = createMemoryStorage();
    const paths = Array.from({ length: RECENT_WORKSPACES_LIMIT + 2 }, (_, index) =>
      `E:/Project-${index}`,
    );

    const saved = saveRecentWorkspacePaths(storage, paths);

    expect(saved).toHaveLength(RECENT_WORKSPACES_LIMIT);
    expect(loadRecentWorkspacePaths(storage)).toHaveLength(RECENT_WORKSPACES_LIMIT);
  });

  it("removes recent workspace paths case-insensitively", () => {
    const paths = removeRecentWorkspacePath(["E:/Javis", "F:/Other"], "e:/javis");

    expect(paths).toEqual(["F:/Other"]);
  });

  it("exposes SQLite-ready recent workspace schema migration SQL", () => {
    expect(RECENT_WORKSPACES_SCHEMA_MIGRATION).toEqual({
      id: "001_recent_workspaces",
      sql: RECENT_WORKSPACES_SCHEMA_SQL,
    });
    expect(RECENT_WORKSPACES_SORT_ORDER_INDEX_MIGRATION).toEqual({
      id: "002_recent_workspaces_sort_order_index",
      sql: RECENT_WORKSPACES_SORT_ORDER_INDEX_SQL,
    });
    expect(RECENT_WORKSPACES_SCHEMA_MIGRATIONS).toEqual([
      RECENT_WORKSPACES_SCHEMA_MIGRATION,
      RECENT_WORKSPACES_SORT_ORDER_INDEX_MIGRATION,
    ]);
    expect(RECENT_WORKSPACES_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS recent_workspaces");
    expect(RECENT_WORKSPACES_SCHEMA_SQL).toContain("sort_order INTEGER NOT NULL");
    expect(RECENT_WORKSPACES_SORT_ORDER_INDEX_SQL).toContain(
      "CREATE INDEX IF NOT EXISTS idx_recent_workspaces_sort_order",
    );
  });

  it("persists recent workspaces through the async repository", async () => {
    const repository = createRecentWorkspacesRepository(createMemoryRecentWorkspacesDatabase());

    const saved = await repository.save([" E:/Javis ", "e:/javis", "F:/Other"]);
    const upserted = await repository.upsert("G:/Next");
    const removed = await repository.remove("f:/other");

    expect(saved).toEqual(["E:/Javis", "F:/Other"]);
    expect(upserted).toEqual(["G:/Next", "E:/Javis", "F:/Other"]);
    expect(removed).toEqual(["G:/Next", "E:/Javis"]);
  });

  it("imports legacy localStorage workspaces into SQLite and removes the legacy key", async () => {
    const storage = createMemoryStorage();
    const database = createMemoryRecentWorkspacesDatabase();
    storage.setItem(
      RECENT_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        version: RECENT_WORKSPACES_STORAGE_VERSION,
        paths: ["E:/Javis", "F:/Other"],
      }),
    );

    const imported = await importRecentWorkspacePathsFromLocalStorage(
      database,
      storage,
      "2026-05-27T00:00:00.000Z",
    );

    expect(imported).toEqual(["E:/Javis", "F:/Other"]);
    expect(await loadRecentWorkspacePathsFromDatabase(database)).toEqual([
      "E:/Javis",
      "F:/Other",
    ]);
    expect(storage.getItem(RECENT_WORKSPACES_STORAGE_KEY)).toBeNull();
  });

  it("falls back to localStorage when the recent workspace repository fails", async () => {
    const storage = createMemoryStorage();
    storage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(["E:/Javis"]));
    const failingRepository = {
      async list() {
        throw new Error("unavailable");
      },
    };

    await expect(
      loadRecentWorkspacePathsWithStorageFallback(failingRepository, storage),
    ).resolves.toEqual(["E:/Javis"]);
    await expect(
      loadRecentWorkspacePathsWithStorageFallback(null, storage),
    ).resolves.toEqual(["E:/Javis"]);
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

function createStorage(paths: string[]): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const storage = createMemoryStorage();
  storage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(paths));
  return storage;
}

function createMemoryRecentWorkspacesDatabase(initialRows: RecentWorkspaceRow[] = []) {
  const rows = [...initialRows];
  const database: DesktopDatabase & {
    rows: RecentWorkspaceRow[];
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

interface RecentWorkspaceRow {
  path: string;
  sort_order: number;
  updated_at: string;
}
