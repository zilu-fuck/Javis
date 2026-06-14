import { describe, expect, it } from "vitest";
import type { DatabaseValue, DesktopDatabase } from "./desktop-database";
import {
  DEFAULT_SANDBOX_SETTINGS,
  WORKSPACE_SETTINGS_MIGRATIONS,
  createWorkspaceSettingsRepository,
  sanitizeSandboxSettings,
} from "./workspace-settings-persistence";

describe("workspace sandbox settings persistence", () => {
  it("declares the workspace settings table migration", () => {
    expect(WORKSPACE_SETTINGS_MIGRATIONS).toEqual([
      expect.objectContaining({
        id: "workspace-settings-v1-table",
        sql: expect.stringContaining("CREATE TABLE IF NOT EXISTS workspace_settings"),
      }),
    ]);
  });

  it("round-trips sandbox settings by workspace", async () => {
    const database = createMemoryWorkspaceSettingsDatabase();
    const repository = createWorkspaceSettingsRepository(database);

    await repository.saveSandboxSettings("E:/Javis", {
      mode: "read_only",
      networkAccess: true,
      writableRoots: ["src"],
      protectedPaths: [".git", ".env"],
    });

    await expect(repository.getSandboxSettings("E:/Javis")).resolves.toEqual({
      mode: "read_only",
      networkAccess: true,
      writableRoots: ["src"],
      protectedPaths: [".git", ".env"],
    });
    await expect(repository.getSandboxSettings("F:/Other")).resolves.toEqual(
      DEFAULT_SANDBOX_SETTINGS,
    );
  });

  it("sanitizes malformed persisted sandbox settings", () => {
    expect(sanitizeSandboxSettings({ mode: "full_access_manual" })).toEqual(
      DEFAULT_SANDBOX_SETTINGS,
    );
    expect(
      sanitizeSandboxSettings({
        mode: "workspace_write",
        networkAccess: false,
        writableRoots: [" src ", "", 1],
        protectedPaths: [".git", null],
      }),
    ).toEqual({
      mode: "workspace_write",
      networkAccess: false,
      writableRoots: ["src"],
      protectedPaths: [".git"],
    });
  });
});

function createMemoryWorkspaceSettingsDatabase() {
  const rows = new Map<string, string>();
  const database: DesktopDatabase = {
    async execute(_sql: string, values: DatabaseValue[] = []) {
      const workspaceId = String(values[0] ?? "");
      const key = String(values[1] ?? "");
      const value = String(values[2] ?? "");
      rows.set(`${workspaceId}\0${key}`, value);
    },
    async select<T extends Record<string, unknown>>(_sql: string, values: DatabaseValue[] = []) {
      const workspaceId = String(values[0] ?? "");
      const key = String(values[1] ?? "");
      const value = rows.get(`${workspaceId}\0${key}`);
      return value === undefined ? [] : ([{ value }] as unknown as T[]);
    },
  };
  return database;
}
