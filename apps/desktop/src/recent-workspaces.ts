import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const RECENT_WORKSPACES_STORAGE_KEY = "javis.recentWorkspaces.v1";
export const RECENT_WORKSPACES_LIMIT = 8;
export const RECENT_WORKSPACES_STORAGE_VERSION = 1;
export const RECENT_WORKSPACES_TABLE_NAME = "recent_workspaces";
export const RECENT_WORKSPACES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recent_workspaces (
  path TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)
`.trim();
export const RECENT_WORKSPACES_SORT_ORDER_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_recent_workspaces_sort_order
ON recent_workspaces (sort_order ASC)
`.trim();
export const RECENT_WORKSPACES_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "001_recent_workspaces",
  sql: RECENT_WORKSPACES_SCHEMA_SQL,
};
export const RECENT_WORKSPACES_SORT_ORDER_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "002_recent_workspaces_sort_order_index",
  sql: RECENT_WORKSPACES_SORT_ORDER_INDEX_SQL,
};
export const RECENT_WORKSPACES_SCHEMA_MIGRATIONS: DesktopDatabaseMigration[] = [
  RECENT_WORKSPACES_SCHEMA_MIGRATION,
  RECENT_WORKSPACES_SORT_ORDER_INDEX_MIGRATION,
];

type RecentWorkspaceReadStorage = Pick<Storage, "getItem">;
type RecentWorkspaceWriteStorage = Pick<Storage, "setItem">;
type RecentWorkspaceMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export interface RecentWorkspacesRepository {
  list(): Promise<string[]>;
  save(paths: string[]): Promise<string[]>;
  upsert(path: string): Promise<string[]>;
  remove(path: string): Promise<string[]>;
  importFromLocalStorage(storage: RecentWorkspaceMigrationStorage): Promise<string[]>;
}

export function loadRecentWorkspacePaths(storage: RecentWorkspaceReadStorage): string[] {
  try {
    const raw = storage.getItem(RECENT_WORKSPACES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const paths = parseRecentWorkspaceEntries(JSON.parse(raw));
    if (!paths) {
      return [];
    }

    return sanitizeWorkspacePaths(paths).slice(0, RECENT_WORKSPACES_LIMIT);
  } catch {
    return [];
  }
}

export function saveRecentWorkspacePaths(
  storage: RecentWorkspaceWriteStorage,
  paths: string[],
): string[] {
  const nextPaths = sanitizeWorkspacePaths(paths).slice(0, RECENT_WORKSPACES_LIMIT);
  try {
    storage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(nextPaths));
  } catch {
    // Workspace history should never block task execution.
  }
  return nextPaths;
}

export function upsertRecentWorkspacePath(paths: string[], path: string): string[] {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedPath) {
    return paths;
  }
  const normalizedKey = normalizedPath.toLocaleLowerCase();
  return [
    normalizedPath,
    ...paths.filter((entry) => normalizeWorkspacePath(entry).toLocaleLowerCase() !== normalizedKey),
  ].slice(0, RECENT_WORKSPACES_LIMIT);
}

export function removeRecentWorkspacePath(paths: string[], path: string): string[] {
  const normalizedKey = normalizeWorkspacePath(path).toLocaleLowerCase();
  if (!normalizedKey) {
    return paths;
  }
  return paths.filter((entry) => normalizeWorkspacePath(entry).toLocaleLowerCase() !== normalizedKey);
}

export function createRecentWorkspacesRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): RecentWorkspacesRepository {
  return {
    async list() {
      return loadRecentWorkspacePathsFromDatabase(database);
    },

    async save(paths) {
      return saveRecentWorkspacePathsToDatabase(database, paths);
    },

    async upsert(path) {
      const current = await loadRecentWorkspacePathsFromDatabase(database);
      return saveRecentWorkspacePathsToDatabase(
        database,
        upsertRecentWorkspacePath(current, path),
      );
    },

    async remove(path) {
      const current = await loadRecentWorkspacePathsFromDatabase(database);
      return saveRecentWorkspacePathsToDatabase(
        database,
        removeRecentWorkspacePath(current, path),
      );
    },

    async importFromLocalStorage(storage) {
      return importRecentWorkspacePathsFromLocalStorage(database, storage);
    },
  };
}

export async function loadRecentWorkspacePathsFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<string[]> {
  const rows = await database.select<{ path: string }>(
    `SELECT path FROM ${RECENT_WORKSPACES_TABLE_NAME} ORDER BY sort_order ASC, updated_at DESC LIMIT ?`,
    [RECENT_WORKSPACES_LIMIT],
  );
  return sanitizeWorkspacePaths(rows.map((row) => row.path)).slice(0, RECENT_WORKSPACES_LIMIT);
}

export async function saveRecentWorkspacePathsToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  paths: string[],
  updatedAt = new Date().toISOString(),
): Promise<string[]> {
  const nextPaths = sanitizeWorkspacePaths(paths).slice(0, RECENT_WORKSPACES_LIMIT);
  await database.execute(`DELETE FROM ${RECENT_WORKSPACES_TABLE_NAME}`);
  for (const [index, path] of nextPaths.entries()) {
    await database.execute(
      `INSERT INTO ${RECENT_WORKSPACES_TABLE_NAME} (path, sort_order, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at`,
      recentWorkspaceBindValues(path, index, updatedAt),
    );
  }
  return nextPaths;
}

export async function importRecentWorkspacePathsFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: RecentWorkspaceMigrationStorage,
  updatedAt = new Date().toISOString(),
): Promise<string[]> {
  const hasLegacyValue = storage.getItem(RECENT_WORKSPACES_STORAGE_KEY) !== null;
  const importedPaths = loadRecentWorkspacePaths(storage);
  if (importedPaths.length > 0) {
    const saved = await saveRecentWorkspacePathsToDatabase(database, importedPaths, updatedAt);
    removeLegacyRecentWorkspaceStorage(storage);
    return saved;
  }

  const currentPaths = await loadRecentWorkspacePathsFromDatabase(database);
  if (hasLegacyValue) {
    removeLegacyRecentWorkspaceStorage(storage);
  }
  return currentPaths;
}

export async function loadRecentWorkspacePathsWithStorageFallback(
  repository: Pick<RecentWorkspacesRepository, "list"> | null | undefined,
  storage: RecentWorkspaceReadStorage,
): Promise<string[]> {
  if (!repository) {
    return loadRecentWorkspacePaths(storage);
  }
  try {
    return await repository.list();
  } catch {
    return loadRecentWorkspacePaths(storage);
  }
}

function recentWorkspaceBindValues(
  path: string,
  sortOrder: number,
  updatedAt: string,
): DatabaseValue[] {
  return [path, sortOrder, updatedAt];
}

function removeLegacyRecentWorkspaceStorage(storage: RecentWorkspaceMigrationStorage): void {
  try {
    storage.removeItem(RECENT_WORKSPACES_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block SQLite startup.
  }
}

export function sanitizeWorkspacePaths(value: unknown[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const path = normalizeWorkspacePath(entry);
    if (!path) {
      continue;
    }
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    paths.push(path);
  }

  return paths;
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("//?/UNC/")) {
    return `//${normalized.slice("//?/UNC/".length)}`;
  }
  if (normalized.startsWith("//?/")) {
    return normalized.slice("//?/".length);
  }

  return normalized;
}

function parseRecentWorkspaceEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    isRecord(value) &&
    value.version === RECENT_WORKSPACES_STORAGE_VERSION &&
    Array.isArray(value.paths)
  ) {
    return value.paths;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
