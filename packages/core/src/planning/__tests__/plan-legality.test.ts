import { describe, expect, it } from "vitest";
import type { CommanderPlanResultT } from "../schema";
import {
  applyDeterministicPlanRepairs,
  buildCommanderPlanTemplateSkeleton,
  detectCommanderPlanIntents,
  findSensitiveToolInputKeys,
  hasPathTraversalSegment,
  isAbsolutePathLike,
  PLAN_CONTEXT_KEY_PATTERN,
  scanRawPlanOutputText,
} from "../plan-legality";

describe("detectCommanderPlanIntents", () => {
  it("detects persistence intent in Chinese goals", () => {
    for (const goal of [
      "统计微博热搜并保存到文件",
      "统计微博热搜并整理成文件",
      "把结果写入报告.md",
      "生成一份趋势报告并落盘",
      "将分析结果导出为 markdown 文件",
      "把今天的榜单存档",
    ]) {
      expect(detectCommanderPlanIntents(goal).write, goal).toBe(true);
    }
  });

  it("detects persistence intent in English goals", () => {
    for (const goal of [
      "save the result to a file",
      "write a report about the repo",
      "export the findings as a markdown file",
      "persist the summary",
    ]) {
      expect(detectCommanderPlanIntents(goal).write, goal).toBe(true);
    }
  });

  it("treats document production as write intent", () => {
    expect(detectCommanderPlanIntents("写一份项目分析报告").write).toBe(true);
    expect(detectCommanderPlanIntents("create a report on weekly trends").write).toBe(true);
    expect(detectCommanderPlanIntents("更新 README 中的安装步骤").write).toBe(true);
    expect(detectCommanderPlanIntents("edit the project document").write).toBe(true);
  });

  it("detects answer-only goals as having no write intent", () => {
    for (const goal of [
      "总结今天微博热搜榜前20",
      "review the project",
      "inspect the repository",
      "what does this function do",
      "采集三个来源的趋势并对比",
      "帮我找到文件并打开",
      "报告错误给负责人",
      "向我报告进度",
      "report this bug to the team",
      "explain the Redux store",
      "explain this export function",
      "这个 README.md 是做什么的",
    ]) {
      expect(detectCommanderPlanIntents(goal).write, goal).toBe(false);
    }
  });

  it("detects statistics and retrieval intents independently", () => {
    const statistics = detectCommanderPlanIntents("统计本周提交数量");
    expect(statistics.statistics).toBe(true);
    const retrieval = detectCommanderPlanIntents("搜索仓库中的入口文件");
    expect(retrieval.retrieval).toBe(true);
    expect(retrieval.statistics).toBe(false);
  });

  it("detects export intent as a stronger write intent", () => {
    const intents = detectCommanderPlanIntents("export the data as csv");
    expect(intents.export).toBe(true);
    expect(intents.write).toBe(true);
  });

  it("detects project understanding without treating it as desktop interaction", () => {
    const intents = detectCommanderPlanIntents(
      "检查当前项目的目录结构，并报告主要模块和明显风险。",
    );
    expect(intents.projectUnderstanding).toBe(true);
    expect(intents.desktopInteraction).toBe(false);
    expect(intents.write).toBe(false);
  });

  it("allows an explicit File Explorer project-inspection request", () => {
    const intents = detectCommanderPlanIntents(
      "使用文件资源管理器查看当前项目的目录结构。",
    );
    expect(intents.projectUnderstanding).toBe(true);
    expect(intents.desktopInteraction).toBe(true);
  });

  it("does not classify ordinary code review as project-structure understanding", () => {
    const intents = detectCommanderPlanIntents("review the current repository diff");
    expect(intents.projectUnderstanding).toBe(false);
    expect(intents.desktopInteraction).toBe(false);
  });
});

describe("scanRawPlanOutputText", () => {
  it("flags markdown fences", () => {
    const issues = scanRawPlanOutputText('```json\n{"title":"x"}\n```');
    expect(issues.map((issue) => issue.kind)).toContain("markdown_fence");
  });

  it("flags prose outside the JSON object", () => {
    const issues = scanRawPlanOutputText('Sure! Here is your plan:\n{"title":"x","steps":[]}\nHope that helps.');
    expect(issues.map((issue) => issue.kind)).toContain("prose_outside_json");
  });

  it("flags missing JSON object", () => {
    const issues = scanRawPlanOutputText("no json at all");
    expect(issues.map((issue) => issue.kind)).toContain("prose_outside_json");
  });

  it("flags an incomplete JSON object", () => {
    const issues = scanRawPlanOutputText('{"title":"x","steps":[{"id":"a"');
    expect(issues.map((issue) => issue.kind)).toContain("prose_outside_json");
  });

  it("flags control characters", () => {
    const issues = scanRawPlanOutputText('{"title":"badtitle"}');
    expect(issues.map((issue) => issue.kind)).toContain("control_characters");
  });

  it("flags absolute target paths", () => {
    const issues = scanRawPlanOutputText('{"toolInput":{"targetPath":"E:/workspace/out.md"}}');
    expect(issues.map((issue) => issue.kind)).toContain("absolute_target_path");
  });

  it("flags traversal target paths", () => {
    const issues = scanRawPlanOutputText('{"toolInput":{"targetPath":"../escape.md"}}');
    expect(issues.map((issue) => issue.kind)).toContain("traversal_target_path");
  });

  it("flags secret-looking values", () => {
    const issues = scanRawPlanOutputText('{"toolInput":{"apiKey":"sk-1234567890abcdef"}}');
    expect(issues.map((issue) => issue.kind)).toContain("secret_like_value");
  });

  it("returns no issues for clean JSON", () => {
    const issues = scanRawPlanOutputText('{"title":"ok","reasoning":"fine","steps":[]}');
    expect(issues).toEqual([]);
  });
});

describe("path lexical helpers", () => {
  it("recognizes absolute paths", () => {
    expect(isAbsolutePathLike("E:/workspace/a.md")).toBe(true);
    expect(isAbsolutePathLike("E:\\workspace\\a.md")).toBe(true);
    expect(isAbsolutePathLike("/usr/local/a.md")).toBe(true);
    expect(isAbsolutePathLike("\\\\server\\share\\a.md")).toBe(true);
    expect(isAbsolutePathLike("~/a.md")).toBe(true);
    expect(isAbsolutePathLike("reports/a.md")).toBe(false);
  });

  it("recognizes traversal segments", () => {
    expect(hasPathTraversalSegment("../a.md")).toBe(true);
    expect(hasPathTraversalSegment("reports/../a.md")).toBe(true);
    expect(hasPathTraversalSegment("reports\\..\\a.md")).toBe(true);
    expect(hasPathTraversalSegment("reports/a..md")).toBe(false);
  });
});

describe("context key and secret helpers", () => {
  it("accepts camelCase and step:<id> context keys", () => {
    for (const key of ["userGoal", "uiEvidence", "verificationResult", "step:fetch-data"]) {
      expect(PLAN_CONTEXT_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it("rejects malformed context keys", () => {
    for (const key of ["UI Evidence", "1stKey", "step:", "has space", "中文键", "fetch-data"]) {
      expect(PLAN_CONTEXT_KEY_PATTERN.test(key), key).toBe(false);
    }
  });

  it("finds secret-looking toolInput keys", () => {
    expect(findSensitiveToolInputKeys({ apiKey: "sk-abcdef123456", goal: "x" })).toEqual(["apiKey"]);
    expect(findSensitiveToolInputKeys({ password: "hunter2" })).toEqual(["password"]);
    expect(findSensitiveToolInputKeys({ goal: "harmless" })).toEqual([]);
    expect(findSensitiveToolInputKeys(undefined)).toEqual([]);
  });
});

describe("buildCommanderPlanTemplateSkeleton", () => {
  it("emits the preset fill-in skeleton with default arrays", () => {
    const skeleton = JSON.parse(buildCommanderPlanTemplateSkeleton()) as Record<string, unknown>;
    expect(skeleton).toHaveProperty("title", "");
    expect(skeleton).toHaveProperty("reasoning", "");
    expect(skeleton).toHaveProperty("executionPolicy", {});
    const steps = skeleton.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: "",
      assignedAgentKind: "",
      executionMode: "",
      primaryCapability: "",
      toolName: "",
      requiredCapabilities: [],
      dependsOn: [],
      inputContextKeys: [],
      outputContextKey: "",
      toolInput: {},
      successCriteria: "",
    });
  });
});

describe("applyDeterministicPlanRepairs", () => {
  function makePlan(steps: Array<Record<string, unknown>>): CommanderPlanResultT {
    return {
      title: "t",
      reasoning: "r",
      steps: steps as NonNullable<CommanderPlanResultT["steps"]>,
    };
  }

  it("coerces step ids to kebab-case and rewrites dependsOn", () => {
    const { plan, repairs } = applyDeterministicPlanRepairs(makePlan([
      { id: "Fetch Data", title: "a", assignedAgentKind: "research", successCriteria: "s" },
      { id: "verify_data", title: "b", assignedAgentKind: "verifier", dependsOn: ["Fetch Data"], successCriteria: "s" },
    ]));
    expect(plan.steps![0]?.id).toBe("fetch-data");
    expect(plan.steps![1]?.id).toBe("verify-data");
    expect(plan.steps![1]?.dependsOn).toEqual(["fetch-data"]);
    expect(repairs.length).toBeGreaterThan(0);
  });

  it("deduplicates repeated step ids", () => {
    const { plan } = applyDeterministicPlanRepairs(makePlan([
      { id: "scan", title: "a", assignedAgentKind: "file", successCriteria: "s" },
      { id: "scan", title: "b", assignedAgentKind: "file", successCriteria: "s" },
    ]));
    expect(plan.steps![0]?.id).toBe("scan");
    expect(plan.steps![1]?.id).toBe("scan-2");
  });

  it("fills missing step ids with step-N", () => {
    const { plan } = applyDeterministicPlanRepairs(makePlan([
      { title: "no id", assignedAgentKind: "commander", successCriteria: "s" },
    ]));
    expect(plan.steps![0]?.id).toBe("step-1");
  });

  it("normalizes executionMode synonyms and drops unknown values", () => {
    const { plan, repairs } = applyDeterministicPlanRepairs(makePlan([
      { id: "a1", title: "a", assignedAgentKind: "code", executionMode: "Tool", successCriteria: "s" },
      { id: "a2", title: "b", assignedAgentKind: "commander", executionMode: "answer", successCriteria: "s" },
      { id: "a3", title: "c", assignedAgentKind: "code", executionMode: "teleport", successCriteria: "s" },
    ]));
    expect(plan.steps![0]?.executionMode).toBe("direct_tool_call");
    expect(plan.steps![1]?.executionMode).toBe("direct_response");
    expect(plan.steps![2]?.executionMode).toBeUndefined();
    expect(repairs.some((note) => note.includes("teleport"))).toBe(true);
  });

  it("pins file.writeText steps to direct_tool_call", () => {
    const { plan } = applyDeterministicPlanRepairs(makePlan([
      {
        id: "write-out",
        title: "write",
        assignedAgentKind: "file",
        toolName: "file.writeText",
        executionMode: "react",
        successCriteria: "s",
      },
    ]));
    expect(plan.steps![0]?.executionMode).toBe("direct_tool_call");
  });

  it("relativizes absolute write targets inside the workspace", () => {
    const { plan, repairs } = applyDeterministicPlanRepairs(
      makePlan([
        {
          id: "write-out",
          title: "write",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          toolInput: { targetPath: "E:/workspace/reports/out.md" },
          successCriteria: "s",
        },
      ]),
      { workspacePath: "E:/workspace" },
    );
    expect(plan.steps![0]?.toolInput?.targetPath).toBe("reports/out.md");
    expect(repairs.some((note) => note.includes("relativized"))).toBe(true);
  });

  it("leaves out-of-workspace and traversal targets for the validator", () => {
    const { plan, repairs } = applyDeterministicPlanRepairs(
      makePlan([
        {
          id: "write-out",
          title: "write",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          toolInput: { targetPath: "C:/other/out.md" },
          successCriteria: "s",
        },
        {
          id: "write-escape",
          title: "write",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          toolInput: { targetPath: "../escape.md" },
          successCriteria: "s",
        },
      ]),
      { workspacePath: "E:/workspace" },
    );
    expect(plan.steps![0]?.toolInput?.targetPath).toBe("C:/other/out.md");
    expect(plan.steps![1]?.toolInput?.targetPath).toBe("../escape.md");
    expect(repairs.some((note) => note.includes("relativized"))).toBe(false);
  });

  it("strips control characters from string fields", () => {
    const { plan, repairs } = applyDeterministicPlanRepairs(makePlan([
      { id: "ok-id", title: "badtitle", assignedAgentKind: "code", successCriteria: "done" },
    ]));
    expect(plan.steps![0]?.title).toBe("badtitle");
    expect(repairs.some((note) => note.includes("control characters"))).toBe(true);
  });

  it("returns plans without steps unchanged", () => {
    const plan: CommanderPlanResultT = { title: "t", reasoning: "r" };
    const { plan: result, repairs } = applyDeterministicPlanRepairs(plan);
    expect(result).toBe(plan);
    expect(repairs).toEqual([]);
  });
});
