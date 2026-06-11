import { sanitizeGoalState, type GoalState } from "@javis/core";
import type { DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const CURRENT_GOAL_STORAGE_KEY = "javis.currentGoal.v1";
export const CURRENT_GOAL_TABLE_NAME = "current_goal";
export const CURRENT_GOAL_ROW_ID = "current";

export const CURRENT_GOAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS current_goal (
  id TEXT PRIMARY KEY,
  goal_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`.trim();

export const CURRENT_GOAL_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "001_current_goal",
  sql: CURRENT_GOAL_SCHEMA_SQL,
};

export const CURRENT_GOAL_MIGRATIONS: DesktopDatabaseMigration[] = [
  CURRENT_GOAL_SCHEMA_MIGRATION,
];

type CurrentGoalReadStorage = Pick<Storage, "getItem">;
type CurrentGoalWriteStorage = Pick<Storage, "setItem" | "removeItem">;
type CurrentGoalMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

export interface CurrentGoalRepository {
  load(): Promise<GoalState | null>;
  save(goal: GoalState | null): Promise<GoalState | null>;
  clear(): Promise<void>;
  importFromLocalStorage(storage: CurrentGoalMigrationStorage): Promise<GoalState | null>;
}

export function loadCurrentGoal(storage: CurrentGoalReadStorage): GoalState | null {
  try {
    const raw = storage.getItem(CURRENT_GOAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return sanitizeGoalState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveCurrentGoal(
  storage: CurrentGoalWriteStorage,
  goal: GoalState | null,
): GoalState | null {
  const sanitized = goal ? sanitizeGoalState(goal) : null;
  try {
    if (sanitized) {
      storage.setItem(CURRENT_GOAL_STORAGE_KEY, JSON.stringify(sanitized));
    } else {
      storage.removeItem(CURRENT_GOAL_STORAGE_KEY);
    }
  } catch {
    // Goal persistence should not block the live task loop.
  }
  return sanitized;
}

export function createCurrentGoalRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): CurrentGoalRepository {
  return {
    async load() {
      return loadCurrentGoalFromDatabase(database);
    },
    async save(goal) {
      if (!goal) {
        await clearCurrentGoalFromDatabase(database);
        return null;
      }
      return saveCurrentGoalToDatabase(database, goal);
    },
    async clear() {
      await clearCurrentGoalFromDatabase(database);
    },
    async importFromLocalStorage(storage) {
      return importCurrentGoalFromLocalStorage(database, storage);
    },
  };
}

export async function loadCurrentGoalWithStorageFallback(
  repository: Pick<CurrentGoalRepository, "load"> | null | undefined,
  storage: CurrentGoalReadStorage,
): Promise<GoalState | null> {
  if (!repository) {
    return loadCurrentGoal(storage);
  }
  try {
    return await repository.load();
  } catch {
    return loadCurrentGoal(storage);
  }
}

export async function loadCurrentGoalFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<GoalState | null> {
  const rows = await database.select<{ goal_json: string }>(
    `SELECT goal_json FROM ${CURRENT_GOAL_TABLE_NAME} WHERE id = ? LIMIT 1`,
    [CURRENT_GOAL_ROW_ID],
  );
  const raw = rows[0]?.goal_json;
  if (!raw) {
    return null;
  }
  try {
    return sanitizeGoalState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveCurrentGoalToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  goal: GoalState,
): Promise<GoalState | null> {
  const sanitized = sanitizeGoalState(goal);
  if (!sanitized) {
    await clearCurrentGoalFromDatabase(database);
    return null;
  }
  await database.execute(
    `INSERT INTO ${CURRENT_GOAL_TABLE_NAME} (id, goal_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal_json = excluded.goal_json,
       updated_at = excluded.updated_at`,
    [CURRENT_GOAL_ROW_ID, JSON.stringify(sanitized), sanitized.updatedAt],
  );
  return sanitized;
}

export async function clearCurrentGoalFromDatabase(
  database: Pick<DesktopDatabase, "execute">,
): Promise<void> {
  await database.execute(`DELETE FROM ${CURRENT_GOAL_TABLE_NAME} WHERE id = ?`, [CURRENT_GOAL_ROW_ID]);
}

export async function importCurrentGoalFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: CurrentGoalMigrationStorage,
): Promise<GoalState | null> {
  const current = await loadCurrentGoalFromDatabase(database);
  if (current) {
    storage.removeItem(CURRENT_GOAL_STORAGE_KEY);
    return current;
  }

  const legacyGoal = loadCurrentGoal(storage);
  if (!legacyGoal) {
    return null;
  }
  const saved = await saveCurrentGoalToDatabase(database, legacyGoal);
  storage.removeItem(CURRENT_GOAL_STORAGE_KEY);
  return saved;
}
