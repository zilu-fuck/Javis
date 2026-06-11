import type { ClassifiedFile } from "@javis/core";
import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

const APP_CLASSIFICATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_classifications (
  app_path TEXT PRIMARY KEY NOT NULL,
  category TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  classified_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai'
)
`.trim();

const APP_CLASSIFICATIONS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_app_classifications_cat
  ON app_classifications (category)
`.trim();

export const APP_CLASSIFICATIONS_MIGRATION: DesktopDatabaseMigration = {
  id: "008_app_classifications",
  sql: APP_CLASSIFICATIONS_SCHEMA_SQL,
};

export const APP_CLASSIFICATIONS_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "009_app_classifications_index",
  sql: APP_CLASSIFICATIONS_INDEX_SQL,
};

export const APP_CLASSIFICATION_MIGRATIONS: DesktopDatabaseMigration[] = [
  APP_CLASSIFICATIONS_MIGRATION,
  APP_CLASSIFICATIONS_INDEX_MIGRATION,
];

export interface AppClassificationRecord {
  appPath: string;
  category: string;
  tags: string[];
  confidence: number;
  classifiedAt: string;
  source: "ai" | "manual";
}

export interface AppClassificationRepository {
  getAll(): Promise<AppClassificationRecord[]>;
  upsertClassifications(classified: ClassifiedFile[], source?: "ai" | "manual"): Promise<void>;
  getCategoryStats(): Promise<{ category: string; count: number }[]>;
}

export function createAppClassificationRepository(
  database: DesktopDatabase,
): AppClassificationRepository {
  const exec = async (sql: string, bindValues: DatabaseValue[] = []) => {
    await database.execute(sql, bindValues);
  };

  return {
    async getAll() {
      const rows = await database.select<Record<string, unknown>>(
        `SELECT app_path, category, tags_json, confidence, classified_at, source
         FROM app_classifications
         ORDER BY classified_at DESC`,
      );
      return rows.map(parseAppClassificationRow);
    },

    async upsertClassifications(classified, source = "ai") {
      const now = new Date().toISOString();
      await exec("BEGIN TRANSACTION");
      try {
        for (const item of classified) {
          await exec(
            `INSERT OR REPLACE INTO app_classifications
               (app_path, category, tags_json, confidence, classified_at, source)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              item.path,
              item.category,
              JSON.stringify(item.tags ?? []),
              item.confidence,
              now,
              source,
            ],
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
         FROM app_classifications
         GROUP BY category
         ORDER BY count DESC`,
      );
      return rows.map((row) => ({
        category: String(row.category ?? ""),
        count: Number(row.count ?? 0),
      }));
    },
  };
}

function parseAppClassificationRow(row: Record<string, unknown>): AppClassificationRecord {
  const tagsRaw = typeof row.tags_json === "string" ? row.tags_json : "[]";
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(tagsRaw);
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    // Keep empty tags.
  }

  return {
    appPath: String(row.app_path ?? ""),
    category: String(row.category ?? ""),
    tags,
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
    classifiedAt: String(row.classified_at ?? ""),
    source: row.source === "manual" ? "manual" : "ai",
  };
}
