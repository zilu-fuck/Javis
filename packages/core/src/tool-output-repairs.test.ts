import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TOOL_OUTPUT_REPAIR_RECORDS,
  TOOL_OUTPUT_REPAIRS_CONTEXT_KEY,
  appendContextToolOutputRepairs,
  listToolOutputRepairs,
  recordToolOutputRepair,
  resetToolOutputRepairs,
  summarizeToolOutputRepairs,
} from "./tool-output-repairs";

beforeEach(() => {
  resetToolOutputRepairs();
});

describe("tool output repair log", () => {
  it("records repairs with their tool, task and step", () => {
    recordToolOutputRepair({
      toolName: "code.searchRepository",
      taskId: "task-1",
      stepId: "search",
      repairs: ["Tool code.searchRepository output.actualFound[1].line: coerced \"27\" to integer"],
    });
    const records = listToolOutputRepairs();
    expect(records).toHaveLength(1);
    expect(records[0].toolName).toBe("code.searchRepository");
    expect(records[0].taskId).toBe("task-1");
    expect(records[0].stepId).toBe("search");
    expect(records[0].recordedAt).toBeTruthy();
  });

  it("filters by task and tool", () => {
    recordToolOutputRepair({ toolName: "a.b", taskId: "task-1", repairs: ["x"] });
    recordToolOutputRepair({ toolName: "a.b", taskId: "task-2", repairs: ["y"] });
    recordToolOutputRepair({ toolName: "c.d", taskId: "task-1", repairs: ["z"] });
    expect(listToolOutputRepairs({ taskId: "task-1" })).toHaveLength(2);
    expect(listToolOutputRepairs({ toolName: "c.d" })).toHaveLength(1);
    expect(listToolOutputRepairs({ taskId: "task-1", toolName: "c.d" })).toHaveLength(1);
    expect(listToolOutputRepairs({ taskId: "task-9" })).toHaveLength(0);
  });

  it("stays bounded and drops the oldest entries first", () => {
    for (let index = 0; index < MAX_TOOL_OUTPUT_REPAIR_RECORDS + 25; index += 1) {
      recordToolOutputRepair({ toolName: "t", repairs: [`note-${index}`] });
    }
    const records = listToolOutputRepairs();
    expect(records).toHaveLength(MAX_TOOL_OUTPUT_REPAIR_RECORDS);
    expect(records[0].repairs[0]).toBe("note-25");
    expect(records[records.length - 1].repairs[0]).toBe(`note-${MAX_TOOL_OUTPUT_REPAIR_RECORDS + 24}`);
  });

  it("copies the repairs array so later mutation cannot rewrite history", () => {
    const repairs = ["first"];
    recordToolOutputRepair({ toolName: "t", repairs });
    repairs.push("second");
    expect(listToolOutputRepairs()[0].repairs).toEqual(["first"]);
  });

  it("summarises counts per tool for the repair-rate metric", () => {
    recordToolOutputRepair({ toolName: "a.b", repairs: ["one", "two"] });
    recordToolOutputRepair({ toolName: "a.b", repairs: ["three"] });
    recordToolOutputRepair({ toolName: "c.d", repairs: ["four"] });
    const summary = summarizeToolOutputRepairs();
    expect(summary.total).toBe(3);
    expect(summary.totalNotes).toBe(4);
    expect(summary.byTool).toEqual({ "a.b": 2, "c.d": 1 });
    expect(summary.lastRecordedAt).toBeTruthy();
  });

  it("reports an empty summary before anything is recorded", () => {
    expect(summarizeToolOutputRepairs()).toEqual({ total: 0, totalNotes: 0, byTool: {} });
  });
});

describe("tool output repairs in SharedTaskContext", () => {
  function createContext() {
    const values = new Map<string, unknown>();
    return {
      values,
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
      set<T>(key: string, value: T): void {
        values.set(key, value);
      },
    };
  }

  it("accumulates into the artifact context key", () => {
    const context = createContext();
    appendContextToolOutputRepairs(context, { toolName: "a.b", repairs: ["one"] });
    appendContextToolOutputRepairs(context, { stepId: "s2", toolName: "c.d", repairs: ["two"] });
    const stored = context.get<Array<{ toolName: string; repairs: string[] }>>(
      TOOL_OUTPUT_REPAIRS_CONTEXT_KEY,
    );
    expect(stored).toHaveLength(2);
    expect(stored?.[1]).toMatchObject({ stepId: "s2", toolName: "c.d" });
  });

  it("keeps only the newest entries in a long task", () => {
    const context = createContext();
    for (let index = 0; index < 40; index += 1) {
      appendContextToolOutputRepairs(context, { toolName: "t", repairs: [`n-${index}`] });
    }
    const stored = context.get<Array<{ repairs: string[] }>>(TOOL_OUTPUT_REPAIRS_CONTEXT_KEY);
    expect(stored).toHaveLength(20);
    expect(stored?.[0].repairs[0]).toBe("n-20");
  });
});
