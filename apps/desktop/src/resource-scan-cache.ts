import type { DesktopDatabase, DesktopDatabaseMigration, DatabaseValue } from "./desktop-database";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResourceCacheEntry {
  kind: string;
  path: string;
  name: string;
  source: string;
  sourceRootId?: string;
  sourceRootPath: string;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
  scannedAt: string;
}

export interface ResourceCacheRepository {
  /** Replace all entries for a kind + sourceRootId combination. */
  replaceForRoot(kind: string, sourceRootId: string, entries: ResourceCacheEntry[]): Promise<void>;
  /** Delete all entries for a specific kind + sourceRootId. */
  deleteForRoot(kind: string, sourceRootId: string): Promise<void>;
  /** Delete all entries for a specific kind. */
  deleteForKind(kind: string): Promise<void>;
  /** Get all entries for a kind, ordered by modified_at desc. */
  getByKind(kind: string): Promise<ResourceCacheEntry[]>;
  /** Clear all resource cache. */
  clearAll(): Promise<void>;
}

// ── Migration ────────────────────────────────────────────────────────────────

const RESOURCE_FILE_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_file_cache (
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_root_id TEXT,
  source_root_path TEXT NOT NULL,
  size_bytes INTEGER,
  modified_at TEXT,
  extension TEXT,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (kind, path)
)
`.trim();

const RESOURCE_FILE_CACHE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_resource_cache_kind_root
  ON resource_file_cache (kind, source_root_id)
`.trim();

export const RESOURCE_FILE_CACHE_MIGRATION: DesktopDatabaseMigration = {
  id: "006_resource_file_cache",
  sql: RESOURCE_FILE_CACHE_SCHEMA_SQL,
};

export const RESOURCE_FILE_CACHE_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "007_resource_file_cache_index",
  sql: RESOURCE_FILE_CACHE_INDEX_SQL,
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createResourceCacheRepository(
  database: DesktopDatabase,
): ResourceCacheRepository {
  const exec = async (sql: string, bindValues: DatabaseValue[] = []) => {
    await database.execute(sql, bindValues);
  };

  function parseRow(row: Record<string, unknown>): ResourceCacheEntry {
    return {
      kind: String(row.kind ?? ""),
      path: String(row.path ?? ""),
      name: String(row.name ?? ""),
      source: String(row.source ?? ""),
      sourceRootId: typeof row.source_root_id === "string" ? row.source_root_id : undefined,
      sourceRootPath: String(row.source_root_path ?? ""),
      sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : undefined,
      modifiedAt: typeof row.modified_at === "string" ? row.modified_at : undefined,
      extension: typeof row.extension === "string" ? row.extension : undefined,
      scannedAt: String(row.scanned_at ?? ""),
    };
  }

  return {
    async replaceForRoot(kind, sourceRootId, entries) {
      const now = new Date().toISOString();

      await exec("BEGIN TRANSACTION");
      try {
        await exec(
          "DELETE FROM resource_file_cache WHERE kind = ? AND source_root_id = ?",
          [kind, sourceRootId],
        );
        for (const e of entries) {
          await exec(
            `INSERT OR REPLACE INTO resource_file_cache
               (kind, path, name, source, source_root_id, source_root_path,
                size_bytes, modified_at, extension, scanned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              kind,
              e.path,
              e.name,
              e.source,
              e.sourceRootId ?? null,
              e.sourceRootPath,
              e.sizeBytes ?? null,
              e.modifiedAt ?? null,
              e.extension ?? null,
              now,
            ],
          );
        }
        await exec("COMMIT");
      } catch (error) {
        await exec("ROLLBACK");
        throw error;
      }
    },

    async deleteForRoot(kind, sourceRootId) {
      await exec(
        "DELETE FROM resource_file_cache WHERE kind = ? AND source_root_id = ?",
        [kind, sourceRootId],
      );
    },

    async deleteForKind(kind) {
      await exec("DELETE FROM resource_file_cache WHERE kind = ?", [kind]);
    },

    async getByKind(kind) {
      const rows = await database.select<Record<string, unknown>>(
        `SELECT * FROM resource_file_cache
         WHERE kind = ?
         ORDER BY modified_at DESC`,
        [kind],
      );
      return rows.map(parseRow);
    },

    async clearAll() {
      await exec("DELETE FROM resource_file_cache");
    },
  };
}
