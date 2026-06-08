import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import type { DatabaseValue } from "./desktop-database";

// ── Types ────────────────────────────────────────────────────────────────────

export type ResourceKind = "documents" | "images";

export interface ResourceScanRoot {
  id: string;
  path: string;
  label?: string;
  kinds: ResourceKind[];
  enabled: boolean;
  source: "default" | "custom";
  createdAt: string;
}

export interface ResourceScanRootRepository {
  getAll(): Promise<ResourceScanRoot[]>;
  getByKind(kind: ResourceKind): Promise<ResourceScanRoot[]>;
  upsert(root: ResourceScanRoot): Promise<void>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

// ── Default roots ────────────────────────────────────────────────────────────

export function buildDefaultRoots(homeDir: string): ResourceScanRoot[] {
  const now = new Date().toISOString();
  return [
    {
      id: "default-desktop",
      path: `${homeDir}\\Desktop`,
      label: "桌面",
      kinds: ["documents", "images"],
      enabled: true,
      source: "default",
      createdAt: now,
    },
    {
      id: "default-documents",
      path: `${homeDir}\\Documents`,
      label: "文档",
      kinds: ["documents"],
      enabled: true,
      source: "default",
      createdAt: now,
    },
    {
      id: "default-downloads",
      path: `${homeDir}\\Downloads`,
      label: "下载",
      kinds: ["documents", "images"],
      enabled: true,
      source: "default",
      createdAt: now,
    },
    {
      id: "default-pictures",
      path: `${homeDir}\\Pictures`,
      label: "图片",
      kinds: ["images"],
      enabled: true,
      source: "default",
      createdAt: now,
    },
  ];
}

// ── Default kinds per extension ──────────────────────────────────────────────

export const DOC_EXTENSIONS = [
  "docx", "doc", "txt", "pdf", "xlsx", "xls", "csv", "pptx", "ppt", "md", "rtf", "odt",
];

export const IMAGE_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "svg",
];

// ── Migration ────────────────────────────────────────────────────────────────

const RESOURCE_SCAN_ROOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_scan_roots (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  label TEXT,
  kinds_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL
)
`.trim();

export const RESOURCE_SCAN_ROOTS_MIGRATION: DesktopDatabaseMigration = {
  id: "005_resource_scan_roots",
  sql: RESOURCE_SCAN_ROOTS_SCHEMA_SQL,
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createResourceScanRootRepository(
  database: DesktopDatabase,
): ResourceScanRootRepository {
  const exec = async (sql: string, bindValues: DatabaseValue[] = []) => {
    await database.execute(sql, bindValues);
  };

  function parseRow(row: Record<string, unknown>): ResourceScanRoot {
    let kinds: ResourceKind[] = [];
    try {
      const parsed = JSON.parse(String(row.kinds_json ?? "[]"));
      if (Array.isArray(parsed)) kinds = parsed;
    } catch { /* keep empty */ }

    return {
      id: String(row.id ?? ""),
      path: String(row.path ?? ""),
      label: typeof row.label === "string" ? row.label : undefined,
      kinds,
      enabled: Boolean(row.enabled),
      source: (String(row.source ?? "custom")) as "default" | "custom",
      createdAt: String(row.created_at ?? new Date().toISOString()),
    };
  }

  return {
    async getAll() {
      const rows = await database.select<Record<string, unknown>>(
        "SELECT * FROM resource_scan_roots ORDER BY source DESC, created_at ASC",
      );
      return rows.map(parseRow);
    },

    async getByKind(kind) {
      const rows = await database.select<Record<string, unknown>>(
        "SELECT * FROM resource_scan_roots WHERE enabled = 1 ORDER BY source DESC, created_at ASC",
      );
      return rows.map(parseRow).filter((r) => r.kinds.includes(kind));
    },

    async upsert(root) {
      await exec(
        `INSERT OR REPLACE INTO resource_scan_roots
           (id, path, label, kinds_json, enabled, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          root.id,
          root.path,
          root.label ?? null,
          JSON.stringify(root.kinds),
          root.enabled ? 1 : 0,
          root.source,
          root.createdAt,
        ],
      );
    },

    async remove(id) {
      await exec("DELETE FROM resource_scan_roots WHERE id = ?", [id]);
    },

    async setEnabled(id, enabled) {
      await exec("UPDATE resource_scan_roots SET enabled = ? WHERE id = ?", [
        enabled ? 1 : 0,
        id,
      ]);
    },
  };
}
