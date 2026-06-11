import { describe, expect, it } from "vitest";
import {
  createGoalEvaluationFromDecision,
  createGoalEvent,
  createGoalState,
} from "@javis/core";
import type { DatabaseValue } from "./desktop-database";
import {
  GOAL_EVENT_MIGRATIONS,
  createGoalTimelineRepository,
  loadGoalEvaluationForTaskFromDatabase,
  loadGoalEvaluationsFromDatabase,
  loadGoalEventsFromDatabase,
  saveGoalEvaluationToDatabase,
  saveGoalEventToDatabase,
} from "./goal-event-persistence";

describe("goal event persistence", () => {
  it("exports event and evaluation migrations", () => {
    expect(GOAL_EVENT_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "001_goal_events",
      "002_goal_events_goal_created_index",
      "003_goal_evaluations",
      "004_goal_evaluations_goal_created_index",
      "005_goal_evaluations_goal_task_index",
    ]);
  });

  it("saves, loads, and clears Goal timeline events and evaluations", async () => {
    const database = createMemoryGoalTimelineDatabase();
    const repository = createGoalTimelineRepository(database);
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      now: "2026-06-09T00:00:00.000Z",
    });
    const event = createGoalEvent({
      id: "event-1",
      goalId: goal.id,
      taskId: "task-1",
      type: "evaluated",
      message: "Verifier requested another run.",
      createdAt: "2026-06-09T00:01:00.000Z",
    });
    const evaluation = createGoalEvaluationFromDecision(
      goal,
      { id: "task-1" },
      {
        status: "continue",
        confidence: "high",
        satisfiedCriteria: ["Persistence"],
        unsatisfiedCriteria: ["UI"],
        evidence: ["Database row saved"],
        completedChecks: ["Persistence"],
        nextPrompt: "Build UI timeline",
        reason: "UI remains.",
      },
      { id: "eval-1", createdAt: "2026-06-09T00:02:00.000Z" },
    );

    await repository.appendEvent(event);
    await repository.saveEvaluation(evaluation);

    expect(await repository.listEvents(goal.id)).toEqual([event]);
    expect(await repository.listEvaluations(goal.id)).toEqual([evaluation]);
    expect(await repository.getEvaluationForTask(goal.id, "task-1")).toEqual(evaluation);

    await repository.clearEvents(goal.id);
    await repository.clearEvaluations(goal.id);

    expect(await repository.listEvents(goal.id)).toEqual([]);
    expect(await repository.listEvaluations(goal.id)).toEqual([]);
  });

  it("ignores malformed persisted JSON", async () => {
    const database = createMemoryGoalTimelineDatabase();
    database.events.set("bad-event", { goal_id: "goal-1", event_json: "{bad", created_at: "x" });
    database.evaluations.set("bad-eval", { goal_id: "goal-1", task_id: "task-1", evaluation_json: "{bad", created_at: "x" });

    expect(await loadGoalEventsFromDatabase(database, "goal-1")).toEqual([]);
    expect(await loadGoalEvaluationsFromDatabase(database, "goal-1")).toEqual([]);
    expect(await loadGoalEvaluationForTaskFromDatabase(database, "goal-1", "task-1")).toBeNull();
  });

  it("keeps direct database helpers aligned with repository behavior", async () => {
    const database = createMemoryGoalTimelineDatabase();
    const goal = createGoalState({
      id: "goal-1",
      objective: "Ship Goal mode",
      now: "2026-06-09T00:00:00.000Z",
    });
    const event = createGoalEvent({
      id: "event-1",
      goalId: goal.id,
      type: "created",
      createdAt: "2026-06-09T00:01:00.000Z",
    });
    const evaluation = createGoalEvaluationFromDecision(
      goal,
      { id: "task-1" },
      { status: "complete", confidence: "high", completedChecks: ["Done"] },
      { id: "eval-1", createdAt: "2026-06-09T00:02:00.000Z" },
    );

    expect(await saveGoalEventToDatabase(database, event)).toEqual(event);
    expect(await saveGoalEvaluationToDatabase(database, evaluation)).toEqual(evaluation);
    expect(await loadGoalEventsFromDatabase(database, goal.id)).toEqual([event]);
    expect(await loadGoalEvaluationForTaskFromDatabase(database, goal.id, "task-1")).toEqual(evaluation);
  });

  it("loads the newest limited timeline rows in chronological display order", async () => {
    const database = createMemoryGoalTimelineDatabase();
    const goal = createGoalState({
      id: "goal-1",
      objective: "Long-running Goal",
      now: "2026-06-09T00:00:00.000Z",
    });
    for (let index = 1; index <= 5; index += 1) {
      await saveGoalEventToDatabase(database, createGoalEvent({
        id: `event-${index}`,
        goalId: goal.id,
        type: "continued",
        createdAt: `2026-06-09T00:0${index}:00.000Z`,
      }));
      await saveGoalEvaluationToDatabase(database, createGoalEvaluationFromDecision(
        goal,
        { id: `task-${index}` },
        { status: "continue", confidence: "medium", evidence: [`evidence-${index}`] },
        { id: `eval-${index}`, createdAt: `2026-06-09T00:0${index}:30.000Z` },
      ));
    }

    expect((await loadGoalEventsFromDatabase(database, goal.id, 3)).map((event) => event.id)).toEqual([
      "event-3",
      "event-4",
      "event-5",
    ]);
    expect((await loadGoalEvaluationsFromDatabase(database, goal.id, 2)).map((evaluation) => evaluation.id)).toEqual([
      "eval-4",
      "eval-5",
    ]);
  });
});

function createMemoryGoalTimelineDatabase() {
  const events = new Map<string, { goal_id: string; event_json: string; created_at: string }>();
  const evaluations = new Map<string, { goal_id: string; task_id: string; evaluation_json: string; created_at: string }>();
  return {
    events,
    evaluations,
    async execute(sql: string, values: DatabaseValue[] = []) {
      const normalized = sql.trim().toLowerCase();
      if (normalized.startsWith("insert into goal_events")) {
        events.set(String(values[0]), {
          goal_id: String(values[1]),
          created_at: String(values[5]),
          event_json: String(values[6]),
        });
        return;
      }
      if (normalized.startsWith("insert into goal_evaluations")) {
        evaluations.set(String(values[0]), {
          goal_id: String(values[1]),
          task_id: String(values[2]),
          created_at: String(values[4]),
          evaluation_json: String(values[5]),
        });
        return;
      }
      if (normalized.startsWith("delete from goal_events")) {
        for (const [id, row] of events) {
          if (row.goal_id === values[0]) events.delete(id);
        }
        return;
      }
      if (normalized.startsWith("delete from goal_evaluations")) {
        for (const [id, row] of evaluations) {
          if (row.goal_id === values[0]) evaluations.delete(id);
        }
      }
    },
    async select<T>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
      const normalized = sql.trim().toLowerCase();
      if (normalized.startsWith("select event_json from goal_events")) {
        return Array.from(events.values())
          .filter((row) => row.goal_id === values[0])
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, Number(values[1] ?? 200))
          .map((row) => ({ event_json: row.event_json }) as T);
      }
      if (
        normalized.startsWith("select evaluation_json from goal_evaluations") &&
        normalized.includes("and task_id")
      ) {
        return Array.from(evaluations.values())
          .filter((row) => row.goal_id === values[0] && row.task_id === values[1])
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, 1)
          .map((row) => ({ evaluation_json: row.evaluation_json }) as T);
      }
      if (normalized.startsWith("select evaluation_json from goal_evaluations")) {
        return Array.from(evaluations.values())
          .filter((row) => row.goal_id === values[0])
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, Number(values[1] ?? 100))
          .map((row) => ({ evaluation_json: row.evaluation_json }) as T);
      }
      return [];
    },
  };
}
