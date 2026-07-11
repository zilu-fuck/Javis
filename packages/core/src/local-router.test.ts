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

  it("routes source-backed project understanding to L3 Commander", () => {
    const input = "\u544a\u8bc9\u6211\u8fd9\u4e2a\u9879\u76ee\u662f\u5e72\u561b\u7684, \u4e0d\u8981\u5149\u770breadme, \u8981\u7ed3\u5408\u5b9e\u9645\u4ee3\u7801\u60c5\u51b5";
    const decision = routeMessage(input);

    expect(decision).toMatchObject({
      level: "L3",
      mode: "commander_dag",
    });
    expect(decision.reasons).toContain("codebase_understanding_intent");
  });

  it("routes specialist agent requests to L3 Commander", () => {
    const decision = routeMessage("\u8bf7\u5b89\u5168\u5ba1\u67e5\u8fd9\u4e2a TypeScript \u9879\u76ee, \u5e76\u68c0\u67e5\u6743\u9650\u6f0f\u6d1e");

    expect(decision).toMatchObject({
      level: "L3",
      mode: "commander_dag",
    });
    expect(decision.reasons).toContain("specialist_agent_intent");
    expect(decision.reasons).toContain("security_review_intent");
    expect(decision.reasons).toContain("language_review_intent");
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
