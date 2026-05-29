import type { ClassifiedFile } from "@javis/core";
import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import type { FileEntry } from "./local-knowledge";

// ── Schema migrations ────────────────────────────────────────────────────────

const FILE_SCAN_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_scan_cache (
  path TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  modified_at TEXT,
  extension TEXT,
  scanned_at TEXT NOT NULL
)
`.trim();

const FILE_SCAN_CACHE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_file_scan_cache_ext
  ON file_scan_cache (extension)
`.trim();

const FILE_CLASSIFICATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_classifications (
  file_path TEXT PRIMARY KEY NOT NULL,
  category TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  classified_at TEXT NOT NULL,
  model_id TEXT
)
`.trim();

const FILE_CLASSIFICATIONS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_file_classifications_cat
  ON file_classifications (category)
`.trim();

export const FILE_SCAN_CACHE_MIGRATION: DesktopDatabaseMigration = {
  id: "001_file_scan_cache",
  sql: FILE_SCAN_CACHE_SCHEMA_SQL,
};

export const FILE_SCAN_CACHE_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "002_file_scan_cache_index",
  sql: FILE_SCAN_CACHE_INDEX_SQL,
};

export const FILE_CLASSIFICATIONS_MIGRATION: DesktopDatabaseMigration = {
  id: "003_file_classifications",
  sql: FILE_CLASSIFICATIONS_SCHEMA_SQL,
};

export const FILE_CLASSIFICATIONS_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "004_file_classifications_index",
  sql: FILE_CLASSIFICATIONS_INDEX_SQL,
};

export const FILE_CLASSIFICATION_MIGRATIONS: DesktopDatabaseMigration[] = [
  FILE_SCAN_CACHE_MIGRATION,
  FILE_SCAN_CACHE_INDEX_MIGRATION,
  FILE_CLASSIFICATIONS_MIGRATION,
  FILE_CLASSIFICATIONS_INDEX_MIGRATION,
];

// ── Repository types ──────────────────────────────────────────────────────────

export interface ScanCacheEntry extends FileEntry {
  scannedAt: string;
}

export interface ScanCacheWithClassification extends ScanCacheEntry {
  category?: string;
  tagsJson?: string;
  tags?: string[];
  confidence?: number;
}

export interface FileClassificationRepository {
  /** Batch upsert scanned files + purge stale entries in a single transaction. */
  replaceScanCache(files: FileEntry[]): Promise<void>;

  /** Get all cached files with LEFT JOIN classification data. */
  getScanCache(): Promise<ScanCacheWithClassification[]>;

  /** Get cached files that have no classification record. */
  getUnclassifiedFiles(): Promise<ScanCacheEntry[]>;

  /** Clear all scan cache entries. */
  clearScanCache(): Promise<void>;

  /** Upsert a batch of classification results. */
  upsertClassificationsBatch(classified: ClassifiedFile[]): Promise<void>;

  /** Get count per category from classifications. */
  getCategoryStats(): Promise<{ category: string; count: number }[]>;

  /** Remove classification records whose file no longer exists in scan_cache. */
  cleanupOrphanClassifications(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createFileClassificationRepository(
  database: DesktopDatabase,
): FileClassificationRepository {
  const exec = async (sql: string, bindValues: DatabaseValue[] = []) => {
    await database.execute(sql, bindValues);
  };

  return {
    async replaceScanCache(files: FileEntry[]) {
      const now = new Date().toISOString();

      await exec("BEGIN TRANSACTION");
      try {
        for (const f of files) {
          await exec(
            `INSERT OR REPLACE INTO file_scan_cache
               (path, name, is_dir, size_bytes, modified_at, extension, scanned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              f.path,
              f.name,
              f.isDir ? 1 : 0,
              f.sizeBytes ?? null,
              f.modifiedAt ?? null,
              f.extension ?? null,
              now,
            ],
          );
        }

        // Purge entries from previous scans (different scanned_at)
        await exec("DELETE FROM file_scan_cache WHERE scanned_at <> ?", [now]);
        await exec("COMMIT");
      } catch (error) {
        await exec("ROLLBACK");
        throw error;
      }
    },

    async getScanCache() {
      const rows = await database.select<Record<string, unknown>>(
        `SELECT c.*, fc.category, fc.tags_json, fc.confidence
         FROM file_scan_cache c
         LEFT JOIN file_classifications fc ON c.path = fc.file_path
         WHERE c.is_dir = 0
         ORDER BY c.modified_at DESC`,
      );
      return rows.map(parseScanRow);
    },

    async getUnclassifiedFiles() {
      const rows = await database.select<Record<string, unknown>>(
        `SELECT c.*
         FROM file_scan_cache c
         LEFT JOIN file_classifications fc ON c.path = fc.file_path
         WHERE fc.file_path IS NULL AND c.is_dir = 0
         ORDER BY c.modified_at DESC`,
      );
      return rows.map((row) => ({
        name: String(row.name ?? ""),
        path: String(row.path ?? ""),
        isDir: Boolean(row.is_dir),
        sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : undefined,
        modifiedAt: typeof row.modified_at === "string" ? row.modified_at : undefined,
        extension: typeof row.extension === "string" ? row.extension : undefined,
        scannedAt: String(row.scanned_at ?? ""),
      }));
    },

    async clearScanCache() {
      await exec("DELETE FROM file_scan_cache");
    },

    async upsertClassificationsBatch(classified: ClassifiedFile[]) {
      const now = new Date().toISOString();

      await exec("BEGIN TRANSACTION");
      try {
        for (const c of classified) {
          await exec(
            `INSERT OR REPLACE INTO file_classifications
               (file_path, category, tags_json, confidence, classified_at, model_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [c.path, c.category, JSON.stringify(c.tags), c.confidence, now, null],
          );
        }
        await exec("COMMIT");
      } catch (error) {
        await exec("ROLLBACK");
        throw error;
      }
    },

    async getCategoryStats() {
      const rows = await database.select<Record<string, unknown>>(
        `SELECT category, COUNT(*) as count
         FROM file_classifications
         GROUP BY category
         ORDER BY count DESC`,
      );
      return rows.map((row) => ({
        category: String(row.category ?? ""),
        count: Number(row.count ?? 0),
      }));
    },

    async cleanupOrphanClassifications() {
      await exec(
        `DELETE FROM file_classifications
         WHERE file_path NOT IN (SELECT path FROM file_scan_cache)`,
      );
    },
  };
}

function parseScanRow(row: Record<string, unknown>): ScanCacheWithClassification {
  const tagsRaw = typeof row.tags_json === "string" ? row.tags_json : "[]";
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(tagsRaw);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // Keep empty tags
  }

  return {
    name: String(row.name ?? ""),
    path: String(row.path ?? ""),
    isDir: Boolean(row.is_dir),
    sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : undefined,
    modifiedAt: typeof row.modified_at === "string" ? row.modified_at : undefined,
    extension: typeof row.extension === "string" ? row.extension : undefined,
    scannedAt: String(row.scanned_at ?? ""),
    category: typeof row.category === "string" ? row.category : undefined,
    tagsJson: typeof row.tags_json === "string" ? row.tags_json : undefined,
    tags,
    confidence: typeof row.confidence === "number" ? row.confidence : undefined,
  };
}
