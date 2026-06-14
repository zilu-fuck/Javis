import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const WORKSPACE_SETTINGS_TABLE_NAME = "workspace_settings";

export const WORKSPACE_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
)
`.trim();

export const WORKSPACE_SETTINGS_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "workspace-settings-v1-table",
    sql: WORKSPACE_SETTINGS_SCHEMA_SQL,
  },
];

export interface WorkspaceSandboxSettings {
  mode: "read_only" | "workspace_write";
  networkAccess: boolean;
  writableRoots: string[];
  protectedPaths: string[];
}

export const DEFAULT_SANDBOX_SETTINGS: WorkspaceSandboxSettings = {
  mode: "workspace_write",
  networkAccess: false,
  writableRoots: ["."],
  protectedPaths: [
    ".git",
    ".codex",
    ".agents",
    ".claude",
    ".env",
    ".env.local",
    ".env.production",
  ],
};

const SANDBOX_SETTINGS_KEY = "sandbox";

export interface WorkspaceSettingsRepository {
  getSandboxSettings(workspaceId: string): Promise<WorkspaceSandboxSettings>;
  saveSandboxSettings(
    workspaceId: string,
    settings: WorkspaceSandboxSettings,
  ): Promise<WorkspaceSandboxSettings>;
}

export function createWorkspaceSettingsRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): WorkspaceSettingsRepository {
  return {
    async getSandboxSettings(workspaceId) {
      return loadSandboxSettings(database, workspaceId);
    },

    async saveSandboxSettings(workspaceId, settings) {
      return saveSandboxSettings(database, workspaceId, settings);
    },
  };
}

export async function loadSandboxSettings(
  database: Pick<DesktopDatabase, "select">,
  workspaceId: string,
): Promise<WorkspaceSandboxSettings> {
  const rows = await database.select<{ value: string }>(
    `SELECT value FROM ${WORKSPACE_SETTINGS_TABLE_NAME} WHERE workspace_id = ? AND key = ?`,
    [workspaceId, SANDBOX_SETTINGS_KEY],
  );
  if (rows.length === 0) {
    return DEFAULT_SANDBOX_SETTINGS;
  }
  try {
    return sanitizeSandboxSettings(JSON.parse(rows[0]!.value));
  } catch {
    return DEFAULT_SANDBOX_SETTINGS;
  }
}

export async function saveSandboxSettings(
  database: Pick<DesktopDatabase, "execute">,
  workspaceId: string,
  settings: WorkspaceSandboxSettings,
): Promise<WorkspaceSandboxSettings> {
  const updatedAt = new Date().toISOString();
  const value = JSON.stringify(settings);
  await database.execute(
    `INSERT OR REPLACE INTO ${WORKSPACE_SETTINGS_TABLE_NAME} (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    [workspaceId, SANDBOX_SETTINGS_KEY, value, updatedAt],
  );
  return settings;
}

export function sanitizeSandboxSettings(value: unknown): WorkspaceSandboxSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_SANDBOX_SETTINGS;
  }
  const record = value as Record<string, unknown>;
  const mode =
    record.mode === "read_only" || record.mode === "workspace_write"
      ? record.mode
      : DEFAULT_SANDBOX_SETTINGS.mode;
  return {
    mode,
    networkAccess:
      typeof record.networkAccess === "boolean"
        ? record.networkAccess
        : DEFAULT_SANDBOX_SETTINGS.networkAccess,
    writableRoots: sanitizeStringArray(
      record.writableRoots,
      DEFAULT_SANDBOX_SETTINGS.writableRoots,
    ),
    protectedPaths: sanitizeStringArray(
      record.protectedPaths,
      DEFAULT_SANDBOX_SETTINGS.protectedPaths,
    ),
  };
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

export async function deleteWorkspaceSettings(
  database: Pick<DesktopDatabase, "execute">,
  workspaceId: string,
): Promise<void> {
  await database.execute(
    `DELETE FROM ${WORKSPACE_SETTINGS_TABLE_NAME} WHERE workspace_id = ? AND key = ?`,
    [workspaceId, SANDBOX_SETTINGS_KEY],
  );
}
