import { describe, expect, it } from "vitest";
import { createGoalState, type GoalState } from "@javis/core";
import type { DatabaseValue } from "./desktop-database";
import {
  CURRENT_GOAL_MIGRATIONS,
  CURRENT_GOAL_STORAGE_KEY,
  createCurrentGoalRepository,
  importCurrentGoalFromLocalStorage,
  loadCurrentGoal,
  loadCurrentGoalFromDatabase,
  saveCurrentGoal,
  saveCurrentGoalToDatabase,
} from "./goal-persistence";

describe("current goal persistence", () => {
  it("exports the current goal schema migration", () => {
    expect(CURRENT_GOAL_MIGRATIONS).toHaveLength(1);
    expect(CURRENT_GOAL_MIGRATIONS[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS current_goal");
  });

  it("saves and loads sanitized localStorage goal state", () => {
    const storage = createMemoryStorage();
    const goal = createGoal("goal-local");

    expect(saveCurrentGoal(storage, goal)?.id).toBe("goal-local");
    expect(loadCurrentGoal(storage)?.objective).toBe("Finish Goal MVP");

    saveCurrentGoal(storage, null);

    expect(loadCurrentGoal(storage)).toBeNull();
    expect(storage.getItem(CURRENT_GOAL_STORAGE_KEY)).toBeNull();
  });

  it("saves, loads, and clears the database row through the repository", async () => {
    const database = createMemoryGoalDatabase();
    const repository = createCurrentGoalRepository(database);
    const goal = createGoal("goal-db");

    await repository.save(goal);

    expect(await repository.load()).toEqual(goal);

    await repository.clear();

    expect(await repository.load()).toBeNull();
  });

  it("imports localStorage into the database when the database is empty", async () => {
    const database = createMemoryGoalDatabase();
    const storage = createMemoryStorage();
    const goal = createGoal("goal-imported");
    saveCurrentGoal(storage, goal);

    const imported = await importCurrentGoalFromLocalStorage(database, storage);

    expect(imported).toEqual(goal);
    expect(await loadCurrentGoalFromDatabase(database)).toEqual(goal);
    expect(storage.getItem(CURRENT_GOAL_STORAGE_KEY)).toBeNull();
  });

  it("keeps the database goal when both stores have values", async () => {
    const database = createMemoryGoalDatabase();
    const storage = createMemoryStorage();
    const databaseGoal = createGoal("goal-db");
    const legacyGoal = createGoal("goal-legacy");
    await saveCurrentGoalToDatabase(database, databaseGoal);
    saveCurrentGoal(storage, legacyGoal);

    const imported = await importCurrentGoalFromLocalStorage(database, storage);

    expect(imported).toEqual(databaseGoal);
    expect(await loadCurrentGoalFromDatabase(database)).toEqual(databaseGoal);
    expect(storage.getItem(CURRENT_GOAL_STORAGE_KEY)).toBeNull();
  });
});

function createGoal(id: string): GoalState {
  return createGoalState({
    id,
    objective: "Finish Goal MVP",
    acceptanceCriteria: ["Persist state", "Continue until verified"],
    workspacePath: "E:/Javis",
    now: "2026-06-09T00:00:00.000Z",
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function createMemoryGoalDatabase() {
  const rows = new Map<string, { goal_json: string; updated_at: string }>();
  return {
    rows,
    async execute(sql: string, values: DatabaseValue[] = []) {
      const normalized = sql.trim().toLowerCase();
      if (normalized.startsWith("insert into current_goal")) {
        rows.set(String(values[0]), {
          goal_json: String(values[1]),
          updated_at: String(values[2]),
        });
      } else if (normalized.startsWith("delete from current_goal")) {
        rows.delete(String(values[0]));
      }
    },
    async select<T>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
      const normalized = sql.trim().toLowerCase();
      if (!normalized.startsWith("select goal_json from current_goal")) {
        return [];
      }
      const row = rows.get(String(values[0]));
      return row ? [{ goal_json: row.goal_json } as T] : [];
    },
  };
}
