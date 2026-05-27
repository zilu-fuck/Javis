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

function directInvoke(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error("Tauri IPC not ready — __TAURI_INTERNALS__ missing");
  }
  return internals.invoke(command, args ?? {});
}

async function retryInvoke(
  command: string,
  args?: Record<string, unknown>,
  maxRetries = 150,
  delayMs = 100,
): Promise<unknown> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await directInvoke(command, args);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

export function invokeDesktopDatabase(
  _moduleInvoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): DesktopDatabase {
  return {
    async execute(sql, bindValues = []) {
      await retryInvoke("db_execute", { sql, bindValues });
    },
    async select<T extends Record<string, unknown>>(sql: string, bindValues: DatabaseValue[] = []) {
      const rows = await retryInvoke("db_select", { sql, bindValues });
      return (rows as T[]) ?? [];
    },
  };
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
