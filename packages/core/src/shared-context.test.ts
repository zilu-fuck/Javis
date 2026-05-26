import { describe, expect, it } from "vitest";
import { CONTEXT_KEYS, createSharedTaskContext } from "./shared-context";

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

  it("resolves the preprocessed input context key for later flow consumption", () => {
    const context = createSharedTaskContext();
    const key = context.resolveKey(CONTEXT_KEYS.PREPROCESSED_INPUT, "zh-CN");

    context.set(key, { intent: "技术解释" });

    expect(key).toBe("预处理输入");
    expect(context.get<{ intent: string }>(key)?.intent).toBe("技术解释");
  });
});
