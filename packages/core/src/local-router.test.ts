import { describe, expect, it } from "vitest";
import { createRouteLog, routeMessage, scoreComplexity } from "./local-router";

describe("local-router", () => {
  it.each(["你好", "hello", "继续", "简单解释一下这个概念"])(
    "routes simple chat to L1: %s",
    (input) => {
      expect(routeMessage(input)).toMatchObject({
        level: "L1",
        mode: "direct_chat",
      });
    },
  );

  it.each(["总结这个文件", "查一下这个资料", "search React docs"])(
    "routes single tool-like tasks to L2: %s",
    (input) => {
      expect(routeMessage(input)).toMatchObject({
        level: "L2",
        mode: "single_agent_task",
      });
    },
  );

  it("routes complex architecture work to L3", () => {
    expect(routeMessage("分析四个项目并生成架构方案")).toMatchObject({
      level: "L3",
      mode: "commander_dag",
    });
  });

  it("scores explicit multi-step requests as complex", () => {
    const result = scoreComplexity("先读取文件，然后分析差异，最后生成重构方案");

    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.reasons).toContain("explicit_multi_step");
  });

  it("creates compact route logs", () => {
    const decision = routeMessage("总结这个文件");
    const log = createRouteLog("task-1", "总结这个文件".repeat(20), decision);

    expect(log).toMatchObject({
      runId: "task-1",
      routeLevel: "L2",
      mode: "single_agent_task",
      complexityScore: decision.score,
      escalated: false,
      downgraded: false,
    });
    expect(log.inputPreview.length).toBeLessThanOrEqual(80);
  });
});
