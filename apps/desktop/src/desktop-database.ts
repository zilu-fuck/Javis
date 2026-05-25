export interface DesktopDatabase {
  execute(sql: string, bindValues?: DatabaseValue[]): Promise<void>;
  select<T extends Record<string, unknown>>(
    sql: string,
    bindValues?: DatabaseValue[],
  ): Promise<T[]>;
}

export type DatabaseValue = string | number | boolean | null;

export interface DesktopDatabaseMigration {
  id: string;
  sql: string;
}

export async function runDesktopDatabaseMigrations(
  database: DesktopDatabase,
  migrations: DesktopDatabaseMigration[],
): Promise<void> {
  await database.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const appliedRows = await database.select<{ id: string }>(
    "SELECT id FROM schema_migrations",
  );
  const appliedIds = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    await database.execute(migration.sql);
    await database.execute(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      [migration.id, new Date().toISOString()],
    );
  }
}
