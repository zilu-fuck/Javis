import { describe, expect, it } from "vitest";
import { createSharedTaskContext } from "./shared-context";

describe("createSharedTaskContext", () => {
  it("stores typed values and exposes a serializable snapshot", () => {
    const context = createSharedTaskContext({ taskId: "task-1" });

    context.set("fileScan", { count: 2 });

    expect(context.has("taskId")).toBe(true);
    expect(context.get<{ count: number }>("fileScan")?.count).toBe(2);
    expect(context.snapshot()).toEqual({
      taskId: "task-1",
      fileScan: { count: 2 },
    });

    context.clear();

    expect(context.has("taskId")).toBe(false);
    expect(context.snapshot()).toEqual({});
  });
});
