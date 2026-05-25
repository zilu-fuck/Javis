import { describe, expect, it } from "vitest";
import {
  runDesktopDatabaseMigrations,
  type DatabaseValue,
  type DesktopDatabase,
} from "./desktop-database";

describe("desktop database migrations", () => {
  it("runs unapplied migrations once", async () => {
    const database = createMemoryDatabase(["existing"]);

    await runDesktopDatabaseMigrations(database, [
      { id: "existing", sql: "CREATE TABLE existing_table (id TEXT)" },
      { id: "next", sql: "CREATE TABLE next_table (id TEXT)" },
    ]);

    expect(database.executedSql).toEqual([
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      "CREATE TABLE next_table (id TEXT)",
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    ]);
    expect(database.bindValues[0]).toEqual(["next", expect.any(String)]);
  });
});

function createMemoryDatabase(appliedIds: string[]) {
  const executedSql: string[] = [];
  const bindValues: DatabaseValue[][] = [];
  const database: DesktopDatabase & {
    executedSql: string[];
    bindValues: DatabaseValue[][];
  } = {
    executedSql,
    bindValues,
    async execute(sql, values = []) {
      executedSql.push(sql);
      if (values.length > 0) {
        bindValues.push(values);
      }
    },
    async select<T extends Record<string, unknown>>() {
      return appliedIds.map((id) => ({ id }) as unknown as T);
    },
  };
  return database;
}
