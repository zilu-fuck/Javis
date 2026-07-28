import { initialToolDescriptors } from "@javis/tools";
import { describe, expect, it } from "vitest";
import { demoAgents } from "../../agents";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import { compileCommanderPlan } from "../commander-plan-compiler";
import {
  inferCommanderRouteRequirements,
  resolveCommanderRouteAvailability,
} from "../commander-route-contract";
import { detectCommanderPlanIntents } from "../plan-legality";

const availableAgents = demoAgents.map((agent) => ({
  kind: agent.kind,
  allowedToolNames: agent.allowedToolNames,
}));

describe("Commander route contract", () => {
  it.each([
    ["上次那个性能问题后来怎么样了？", "workspace", ["memory.search"]],
    ["之前那个 bug 最后怎么处理的？", "workspace", ["memory.search"]],
    ["测试现在能过吗？", "test-runner", ["shell.runWorkspaceCommand"]],
    ["构建现在能过吗？", "test-runner", ["shell.runWorkspaceCommand"]],
    ["TypeScript 这块写得规范吗？", "language-reviewer", []],
    ["帮我看看现在的 Node 和 pnpm 版本。", "shell", ["shell.runReadOnlyCommand"]],
    ["README 和代码对得上吗？", "doc-updater", []],
    ["README 过时的地方帮我改一下。", "doc-updater", ["file.writeText"]],
    ["最近 AI 工具有啥新闻？", "research", ["web.search"]],
    ["这个网页讲啥？", "page-agent", []],
    ["看看桌面上有什么。", "computer", ["computer.screenshot"]],
    ["帮我找一下最近的截图。", "computer", ["file.scanUserImages"]],
    ["帮我找一下电脑里的报销模板。", "computer", ["computer.searchLocalDocuments"]],
    ["明天下午三点提醒我开会。", "scheduler", ["scheduler.createTask"]],
    ["有哪些工作区？", "workspace", ["workspace.list"]],
    ["删掉测试工作区。", "workspace", ["workspace.delete"]],
    ["帮我把这些 PDF 按月份整理一下。", "file", ["file.planPdfOrganization", "file.executePdfOrganization"]],
    ["把这份总结保存成 summary.md。", "file", ["file.writeText"]],
    ["把这些改动提交一下，再开个草稿 PR。", "code", ["git.createCommit", "git.createPullRequest"]],
    ["在这个 PR 里留言“已经修好”。", "code", ["git.commentPullRequest"]],
  ])("maps %s to %s", (userGoal, agentKind, toolNames) => {
    const route = inferCommanderRouteRequirements(userGoal)
      .find((item) => item.agentKind === agentKind);

    expect(route, userGoal).toBeDefined();
    expect([
      ...(route?.requiredToolNames ?? []),
      ...(route?.requiredAnyToolNames ?? []),
    ], userGoal).toEqual(expect.arrayContaining(toolNames));
  });

  it("keeps continuation work with the subject specialist instead of treating it as recall-only", () => {
    const routes = inferCommanderRouteRequirements("继续分析上次的性能问题。");
    expect(routes.map((route) => route.agentKind)).toContain("perf-analyzer");
    expect(routes.map((route) => route.reason)).not.toContain("prior_work_recall_intent");
  });

  it("does not treat reporting a bug as file persistence", () => {
    expect(inferCommanderRouteRequirements("报告这个 bug 给团队。")
      .some((route) => route.requiredToolNames.includes("file.writeText")))
      .toBe(false);
  });

  it("does not infer web research from a topic word used only in an output filename", () => {
    const routes = inferCommanderRouteRequirements(
      "write a short story and save it as E:/测试/微博热搜.md",
    );
    expect(routes.map((route) => route.agentKind)).not.toContain("research");
    expect(routes.map((route) => route.agentKind)).toContain("file");
  });

  it("marks a recall route unavailable when memory.search is disabled", () => {
    const requirements = inferCommanderRouteRequirements("What did we decide last time?");
    const availability = resolveCommanderRouteAvailability(
      requirements,
      availableAgents,
      initialToolDescriptors.filter((tool) => tool.name !== "memory.search"),
    );

    expect(availability).toEqual([
      expect.objectContaining({
        available: false,
        missingToolNames: ["memory.search"],
      }),
    ]);
  });

  it.each([
    "测试现在能过吗？",
    "TypeScript 这块写得规范吗？",
    "最近 AI 工具有啥新闻？",
    "看看桌面上有什么。",
    "明天下午三点提醒我开会。",
    "有哪些工作区？",
    "把这份总结保存成 summary.md。",
    "把这些改动提交一下，再开个草稿 PR。",
  ])("rejects a Commander-only completion for %s", (userGoal) => {
    const result = compileCommanderPlan(makeCompileInput(userGoal, commanderOnlyPlan()));
    expect(result.ok, userGoal).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((item) =>
        item.code === "MISSING_REQUIRED_AGENT_ROUTE" ||
        item.code === "MISSING_REQUIRED_ROUTE_TOOL"
      ), userGoal).toBe(true);
    }
  });

  it("accepts Workspace memory recall when the route is available", () => {
    const userGoal = "上次那个性能问题后来怎么样了？";
    const result = compileCommanderPlan(makeCompileInput(userGoal, {
      title: "回顾上次工作",
      reasoning: "先检索任务记忆。",
      steps: [{
        id: "recall-memory",
        title: "搜索任务记忆",
        assignedAgentKind: "workspace",
        toolName: "memory.search",
        requiredCapabilities: ["memory_search"],
        executionMode: "direct_tool_call",
        dependsOn: [],
        inputContextKeys: ["userGoal"],
        successCriteria: "找到与上次性能问题相关的记录。",
      }],
    }));

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  });

  it("accepts a Page Agent browser route as public trend research", () => {
    const userGoal = "采集三个公开来源的趋势榜单";
    const result = compileCommanderPlan(makeCompileInput(userGoal, {
      title: "采集公开趋势",
      reasoning: "Page Agent 读取公开榜单页面。",
      steps: [{
        id: "collect-trends",
        title: "读取公开趋势榜单",
        assignedAgentKind: "page-agent",
        primaryCapability: "browser_navigate",
        requiredCapabilities: ["browser_navigate"],
        executionMode: "react",
        dependsOn: [],
        successCriteria: "返回可验证的公开页面证据。",
      }],
    }));

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  });

  it("accepts Doc Updater file.writeText as the file persistence route", () => {
    const userGoal = "调研最近 AI 趋势并保存为 Markdown 报告";
    const result = compileCommanderPlan(makeCompileInput(userGoal, {
      title: "调研并保存趋势报告",
      reasoning: "Research 采集资料，Doc Updater 写入报告。",
      steps: [{
        id: "research-trends",
        title: "调研最近 AI 趋势",
        assignedAgentKind: "research",
        toolName: "web.search",
        requiredCapabilities: ["web_search"],
        executionMode: "direct_tool_call",
        dependsOn: [],
        toolInput: { query: "最近 AI 趋势" },
        outputContextKey: "researchEvidence",
        successCriteria: "返回可验证的趋势资料。",
      }, {
        id: "write-report",
        title: "写入 Markdown 报告",
        assignedAgentKind: "doc-updater",
        toolName: "file.writeText",
        requiredCapabilities: ["file_execute"],
        executionMode: "direct_tool_call",
        dependsOn: ["research-trends"],
        inputContextKeys: ["researchEvidence"],
        toolInput: { targetPath: "reports/ai-trends.md" },
        outputContextKey: "writeResult",
        successCriteria: "经批准后写入工作区报告。",
      }, {
        id: "verify-report",
        title: "验证报告",
        assignedAgentKind: "verifier",
        toolName: "verifier.check",
        requiredCapabilities: ["evidence_check"],
        executionMode: "direct_tool_call",
        dependsOn: ["write-report"],
        inputContextKeys: ["writeResult"],
        successCriteria: "报告写入结果可验证。",
      }],
    }));

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  });
});

function commanderOnlyPlan(): CommanderDagPlan {
  return {
    title: "直接回答",
    reasoning: "由 Commander 直接总结。",
    steps: [{
      id: "answer",
      title: "直接回答",
      assignedAgentKind: "commander",
      toolName: "commander.synthesize",
      requiredCapabilities: ["synthesis"],
      executionMode: "direct_response",
      dependsOn: [],
      inputContextKeys: ["userGoal"],
      successCriteria: "回答用户问题。",
    }],
  };
}

function makeCompileInput(userGoal: string, plan: CommanderDagPlan) {
  return {
    plan,
    userGoal,
    availableAgents,
    availableTools: initialToolDescriptors,
    supportedApprovalGatedTools: initialToolDescriptors
      .filter((tool) => tool.permissionLevel === "confirmed_write")
      .map((tool) => tool.name),
    preloadedContextKeys: ["userGoal", "taskId", "imagePath"],
    planIntents: detectCommanderPlanIntents(userGoal),
  };
}
