import { describe, expect, it, vi } from "vitest";
import {
  addModelUsage,
  createFileScanTaskRuntime,
  createInitialTaskSnapshot,
  createRouteRegistry,
  createWorkflowRegistry,
  demoAgents,
  getAgentSystemPrompt,
  getWorkbenchWorkflow,
  listWorkbenchWorkflows,
  normalizeTaskProgress,
  validateSynthesisConclusion,
  TASK_PROGRESS_ITEM_STATUSES,
  TASK_PROGRESS_STATUSES,
  type WorkbenchWorkflow,
} from "./index";
import { initialToolDescriptors } from "@javis/tools";
import type {
  FileOrganizationExecution,
  FileOrganizationPlan,
  BrowserTool,
  CommanderTool,
  CodeTool,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  TextFileWritePlan,
  TextFileWriteResult,
  WebSource,
} from "@javis/tools";
import type { TaskSnapshot } from "./index";
import { isTextWriteGoal } from "./text-write-flow";
import { isVisionGoal } from "./vision-flow";

function subscribeToRuntime(runtime: ReturnType<typeof createFileScanTaskRuntime>) {
  const snapshots: TaskSnapshot[] = [];
  const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
  return { snapshots, unsubscribe };
}

function createPassingVerifierTool() {
  return {
    check: vi.fn(async () => ({
      status: "pass" as const,
      summary: "Fixture evidence verified.",
      detail: "Fixture verifier accepted the workflow evidence.",
    })),
  };
}

async function waitForStatus(
  snapshots: TaskSnapshot[],
  status: TaskSnapshot["status"],
): Promise<TaskSnapshot> {
  await vi.waitFor(() => {
    expect(snapshots[snapshots.length - 1]?.status).toBe(status);
  });
  return snapshots[snapshots.length - 1] as TaskSnapshot;
}

describe("task progress contract", () => {
  it("normalizes a complete user-facing progress value", () => {
    expect(TASK_PROGRESS_STATUSES).toEqual([
      "running",
      "completed",
      "completed_with_warnings",
      "failed",
    ]);
    expect(TASK_PROGRESS_ITEM_STATUSES).toEqual([
      "queued",
      "running",
      "verifying",
      "completed",
      "blocked",
      "failed",
    ]);

    expect(normalizeTaskProgress({
      title: "  Trend collection  ",
      status: "completed_with_warnings",
      currentAction: "  Preparing the partial report  ",
      completedItems: 2,
      totalItems: 3,
      items: [
        {
          id: "  weibo  ",
          label: "  Weibo  ",
          status: "completed",
          detail: "  20 verified items  ",
          completedCount: 20,
          expectedCount: 20,
          sourceUrl: "  https://example.test/weibo  ",
        },
        {
          id: "xiaohongshu",
          label: "Xiaohongshu",
          status: "blocked",
          detail: "Access control 300012",
        },
      ],
    })).toEqual({
      title: "Trend collection",
      status: "completed_with_warnings",
      currentAction: "Preparing the partial report",
      completedItems: 2,
      totalItems: 3,
      items: [
        {
          id: "weibo",
          label: "Weibo",
          status: "completed",
          detail: "20 verified items",
          completedCount: 20,
          expectedCount: 20,
          sourceUrl: "https://example.test/weibo",
        },
        {
          id: "xiaohongshu",
          label: "Xiaohongshu",
          status: "blocked",
          detail: "Access control 300012",
        },
      ],
    });
  });

  it("rejects malformed progress instead of leaking loose values into the UI", () => {
    const base = {
      title: "Trend collection",
      status: "running",
      currentAction: "Collecting sources",
      completedItems: 0,
      totalItems: 1,
      items: [{ id: "source", label: "Source", status: "queued" }],
    };

    expect(normalizeTaskProgress({ ...base, status: "waiting" })).toBeUndefined();
    expect(normalizeTaskProgress({ ...base, completedItems: 2 })).toBeUndefined();
    expect(normalizeTaskProgress({
      ...base,
      items: [{ ...base.items[0], completedCount: 21, expectedCount: 20 }],
    })).toBeUndefined();
    expect(normalizeTaskProgress({
      ...base,
      items: [base.items[0], base.items[0]],
    })).toBeUndefined();
  });

  it("allows a terminal progress value without a current action", () => {
    expect(normalizeTaskProgress({
      title: "Trend collection",
      status: "completed",
      completedItems: 1,
      totalItems: 1,
      items: [{ id: "source", label: "Source", status: "completed" }],
    })).toEqual({
      title: "Trend collection",
      status: "completed",
      completedItems: 1,
      totalItems: 1,
      items: [{ id: "source", label: "Source", status: "completed" }],
    });
  });

  it("keeps task progress optional for initial and legacy snapshots", () => {
    const legacyCompatibleSnapshot: TaskSnapshot = createInitialTaskSnapshot();

    expect(legacyCompatibleSnapshot.taskProgress).toBeUndefined();
    expect(normalizeTaskProgress(legacyCompatibleSnapshot.taskProgress)).toBeUndefined();
  });
});

describe("createFileScanTaskRuntime", () => {
  it("creates a consistent idle snapshot for all built-in agents", () => {
    const snapshot = createInitialTaskSnapshot();

    expect(snapshot.status).toBe("created");
    expect(snapshot.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      peakContextTokens: 0,
      modelCalls: 0,
      byAgentKind: [],
    });
    expect(snapshot.agents.map((agent) => agent.id)).toEqual([
      "agent-commander",
      "agent-file",
      "agent-shell",
      "agent-code",
      "agent-language-reviewer",
      "agent-security-reviewer",
      "agent-build-fix",
      "agent-test-runner",
      "agent-doc-updater",
      "agent-explorer",
      "agent-perf-analyzer",
      "agent-refactor",
      "agent-research",
      "agent-computer",
      "agent-scheduler",
      "agent-verifier",
      "agent-vision",
      "agent-workspace",
      "agent-page-agent",
    ]);
    expect(snapshot.agents.every((agent) => agent.status === "queued")).toBe(true);
    const researchScore = snapshot.agents.find((agent) => agent.id === "agent-research")?.capabilityScore;
    const codeScore = snapshot.agents.find((agent) => agent.id === "agent-code")?.capabilityScore;
    expect(researchScore).toMatchObject({
      status: "ready",
      qaPassed: true,
      liveVerified: true,
    });
    expect(codeScore).toMatchObject({
      status: "usable",
      qaPassed: true,
      liveVerified: false,
    });
  });

  it("accepts injected capability verification for idle snapshots", () => {
    const snapshot = createInitialTaskSnapshot({
      capabilityVerification: {
        qaPassedAgentKinds: [],
        liveVerifiedAgentKinds: [],
        recentFailureRateByAgentKind: { research: 1 },
      },
    });

    const researchScore = snapshot.agents.find((agent) => agent.id === "agent-research")?.capabilityScore;

    expect(researchScore?.qaPassed).toBe(false);
    expect(researchScore?.liveVerified).toBe(false);
    expect(researchScore?.recentFailureRate).toBe(1);
    expect(researchScore?.gaps).toContain("recent tool failure rate is 100%");
  });

  it("provides bilingual system prompts for built-in agents", () => {
    const commander = demoAgents.find((agent) => agent.kind === "commander");

    expect(commander?.systemPrompt.en).toContain("Commander");
    expect(commander && getAgentSystemPrompt(commander, "zh-CN")).toContain("指挥官");
  });

  it("attaches project entry metadata to emitted task snapshots", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      chatTool: {
        complete: vi.fn(async () => ({ text: "Done." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("summarize something", {
      mode: "project",
      workspacePath: "E:/Javis",
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.originMode).toBe("project");
    expect(finalSnapshot.workspacePath).toBe("E:/Javis");

    unsubscribe();
    runtime.dispose();
  });

  it("passes the selected workspace into Commander planning without asking for it again", async () => {
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "分析当前项目",
      reasoning: "工作区已经由运行时提供，可以直接读取项目证据。",
      steps: [{
        id: "scan-project",
        title: "扫描当前项目文件",
        assignedAgentKind: "file",
        capability: "file_scan",
        requiredCapabilities: ["file_scan"],
        dependsOn: [] as string[],
        successCriteria: "已读取当前工作区的项目文件。",
      }],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      commanderTool: { plan: commanderPlan },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("扫描工作区中的 Markdown 文档", {
      mode: "project",
      workspacePath: "E:/MAIMAI_BOT",
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: "E:/MAIMAI_BOT",
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(finalSnapshot.workspacePath).toBe("E:/MAIMAI_BOT");
    expect(finalSnapshot.askUserQuestion).toBeUndefined();

    unsubscribe();
    runtime.dispose();
  });

  it("answers a project-mode greeting directly without a clarification card", async () => {
    // Project/agent mode keeps originMode=project (no chat downgrade), but a
    // pure casual greeting should not open Commander askUser clarification.
    const commanderPlan = vi.fn(async () => ({
      title: "Clarification needed",
      reasoning: "Should not run for casual greetings.",
      steps: [{
        id: "ask-scope",
        title: "What should I plan first?",
        assignedAgentKind: "commander",
        toolName: "commander.askUser",
        requiredCapabilities: [],
        dependsOn: [] as string[],
        successCriteria: "The user's intended project scope is clear.",
      }],
    }));
    const chatComplete = vi.fn(async () => ({ text: "Hello, I am Javis." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      chatTool: {
        complete: chatComplete,
      },
      commanderTool: {
        plan: commanderPlan,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u4f60\u597d", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).not.toHaveBeenCalled();
    expect(chatComplete).toHaveBeenCalledTimes(1);
    expect(finalSnapshot.commanderMessage).toBe("Hello, I am Javis.");
    expect(finalSnapshot.askUserQuestion).toBeUndefined();
    // Agent-mode direct response must not use the chat-mode ceiling banner.
    expect(finalSnapshot.commanderMessage.includes("\u6ca1\u6709\u542f\u52a8\u5de5\u4f5c\u6d41")).toBe(false);
    expect(finalSnapshot.logs.some((log) =>
      (log.detail ?? "").includes("Chat mode: single-agent")
    )).toBe(false);
    expect(finalSnapshot.logs.some((log) =>
      (log.detail ?? "").includes("Agent mode: Commander direct response")
    )).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("keeps complex project-mode work on Commander DAG", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Architecture plan",
      reasoning: "Needs a multi-step architecture workflow.",
      steps: [
        {
          id: "scan-files",
          title: "Scan files",
          assignedAgentKind: "file",
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Project files are scanned.",
        },
      ],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      chatTool: {
        complete: vi.fn(async () => ({ text: "chat fallback" })),
      },
      commanderTool: {
        plan: commanderPlan,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Analyze four projects and generate an architecture plan", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledTimes(1);
    expect(finalSnapshot.logs.find((log) => log.title === "route_decided")?.detail)
      .toContain('"routeLevel":"L3"');

    unsubscribe();
    runtime.dispose();
  });

  it("routes source-backed project understanding through Commander-selected evidence and review agents", async () => {
    const goal = "帮我看看这个项目有哪些模块，有没有明显风险。";
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async (request) => {
      const codeAgent = request.availableAgents.find((agent) => agent.kind === "code");
      const verifierAgent = request.availableAgents.find((agent) => agent.kind === "verifier");

      expect(codeAgent?.allowedToolNames).toContain("code.inspectWorkspace");
      expect(codeAgent?.allowedToolNames).toContain("code.searchRepository");
      expect(verifierAgent?.allowedToolNames).toContain("verifier.check");
      return {
        title: "理解项目",
        reasoning: "Commander 决定先让 Code Agent 收集实际代码证据，再让 Verifier 审查证据，最后自然总结。",
        steps: [{
          id: "inspect-workspace",
          title: "盘点工作区目录与模块线索",
          assignedAgentKind: "code",
          toolName: "code.inspectWorkspace",
          executionMode: "direct_tool_call" as const,
          toolInput: { maxDepth: 3, maxEntries: 400 },
          requiredCapabilities: ["workspace_inspect"],
          dependsOn: [] as string[],
          outputContextKey: "workspaceEvidence",
          successCriteria: "Code Agent 收集到有界目录、模块候选、清单文件和风险指示。",
        }, {
          id: "search-repository",
          title: "检索实际代码结构",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          executionMode: "direct_tool_call" as const,
          toolInput: { goal, knownTerms: ["main", "src", "config"] },
          requiredCapabilities: ["code_search"],
          dependsOn: ["inspect-workspace"] as string[],
          outputContextKey: "repoEvidence",
          successCriteria: "Code Agent 收集到入口、模块和配置证据。",
        }, {
          id: "review-repository-evidence",
          title: "审查代码证据是否足够支撑结论",
          assignedAgentKind: "verifier",
          toolName: "verifier.check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["inspect-workspace", "search-repository"] as string[],
          inputContextKeys: ["workspaceEvidence", "repoEvidence"],
          outputContextKey: "reviewReport",
          successCriteria: "Verifier 给出 pass/warn/fail 和缺失证据说明。",
        }, {
          id: "summarize-project-understanding",
          title: "输出自然语言项目理解结论",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: ["synthesis"],
          dependsOn: ["inspect-workspace", "search-repository", "review-repository-evidence"] as string[],
          inputContextKeys: ["workspaceEvidence", "repoEvidence", "reviewReport"],
          outputContextKey: "finalAnswer",
          successCriteria: "Commander 只向用户展示自然语言结论和风险提示。",
        }],
      };
    });
    const inspectWorkspaceForSourceUnderstanding = vi.fn<NonNullable<CodeTool["inspectWorkspace"]>>(async () => ({
      workspacePath: "E:/Javis",
      entries: [
        { name: "apps", relativePath: "apps", isDir: true, depth: 1 },
        { name: "packages", relativePath: "packages", isDir: true, depth: 1 },
        { name: "package.json", relativePath: "package.json", isDir: false, depth: 1 },
      ],
      topLevelDirectories: ["apps", "packages"],
      moduleCandidates: ["apps", "packages"],
      manifests: ["package.json"],
      ignoredDirectories: [],
      riskIndicators: [],
      truncated: false,
    }));
    const searchRepository = vi.fn<NonNullable<CodeTool["searchRepository"]>>(async () => ({
      actualFound: [{
        path: "src/main.ts",
        line: 1,
        excerpt: "export function main() {}",
        matchedTerms: ["main"],
      }],
      inferred: ["入口在 src/main.ts。"],
      needsConfirmation: [],
      keyFiles: ["src/main.ts"],
      relatedTestFiles: [],
      testFileCandidates: [],
      clusters: [],
      attempts: [],
    }));
    const verifierCheck = vi.fn(async () => ({
      status: "pass" as const,
      summary: "代码证据足够支撑项目功能结论。",
      detail: "repoEvidence 包含入口文件和模块线索。",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      chatTool: {
        complete: vi.fn(async () => ({ text: "chat fallback" })),
      },
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({
          message: "这个项目的主入口在 src/main.ts；代码证据足够支撑项目功能结论。",
        })),
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        inspectWorkspace: inspectWorkspaceForSourceUnderstanding,
        searchRepository,
      },
      verifierTool: {
        check: verifierCheck,
      },
      availableToolDescriptors: initialToolDescriptors,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start(goal);

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledTimes(1);
    expect(inspectWorkspaceForSourceUnderstanding).toHaveBeenCalledWith({
      maxDepth: 3,
      maxEntries: 400,
    });
    expect(searchRepository).toHaveBeenCalledWith({
      goal,
      knownTerms: ["main", "src", "config"],
      entryFile: undefined,
      priorityPaths: undefined,
      maxAttempts: undefined,
      maxKeyFiles: undefined,
    });
    expect(finalSnapshot.logs.find((log) => log.title === "route_decided")?.detail)
      .toContain('"routeLevel":"L3"');
    expect(finalSnapshot.repoSearchReport?.keyFiles).toEqual(["src/main.ts"]);
    expect(verifierCheck).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "review-repository-evidence",
      successCriteria: "Verifier 给出 pass/warn/fail 和缺失证据说明。",
      evidence: expect.arrayContaining([
        expect.objectContaining({ label: "Handoff artifact: workspaceEvidence" }),
        expect.objectContaining({ label: "Handoff artifact: repoEvidence" }),
      ]),
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(finalSnapshot.commanderMessage).toContain("这个项目的主入口在 src/main.ts");
    expect(finalSnapshot.commanderMessage).not.toContain("assignedAgentKind");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "inspect-workspace",
      "search-repository",
      "review-repository-evidence",
      "summarize-project-understanding",
    ]);
    expect(finalSnapshot.handoffReport?.handoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contextKey: "workspaceEvidence",
        producedByStepId: "inspect-workspace",
        consumedByStepIds: ["review-repository-evidence", "summarize-project-understanding"],
      }),
      expect.objectContaining({
        contextKey: "repoEvidence",
        producedByStepId: "search-repository",
        consumedByStepIds: ["review-repository-evidence", "summarize-project-understanding"],
      }),
      expect.objectContaining({
        contextKey: "reviewReport",
        producedByStepId: "review-repository-evidence",
        consumedByStepIds: ["summarize-project-understanding"],
      }),
    ]));

    unsubscribe();
    runtime.dispose();
  });

  it("keeps Commander model command errors out of the main user message", async () => {
    const rawError = "invalid args `request` for command `complete_model_prompt`: missing field `prompt`";
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      commanderTool: {
        plan: vi.fn(async () => {
          throw new Error(rawError);
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Build a wallpaper video browser", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.userFacingError).toBe(
      "模型请求参数不完整。请重试当前任务；如果仍失败，请检查模型配置并更新应用。",
    );
    expect(finalSnapshot.commanderMessage).toBe(finalSnapshot.userFacingError);
    expect(finalSnapshot.commanderMessage).not.toContain("complete_model_prompt");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain(rawError);

    unsubscribe();
    runtime.dispose();
  });

  it("keeps Commander JSON parse errors out of the main user message", async () => {
    const rawError = "Model response did not contain a JSON object.";
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      commanderTool: {
        plan: vi.fn(async () => {
          throw new Error(rawError);
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Build a wallpaper video browser", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.userFacingError).toBe(
      "计划生成失败：模型没有返回可执行的结构化计划。请重试，或补充目标、路径和平台等关键信息。",
    );
    expect(finalSnapshot.commanderMessage).toBe(finalSnapshot.userFacingError);
    expect(finalSnapshot.commanderMessage).not.toContain("JSON object");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain(rawError);

    unsubscribe();
    runtime.dispose();
  });

  it("does not show English askUser questions for Chinese project goals", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      commanderTool: {
        plan: vi.fn(async () => ({
          title: "Build player",
          reasoning: "Need clarification.",
          steps: [{
            id: "ask-tech-stack",
            title: "What is your preferred technology stack?",
            assignedAgentKind: "commander",
            toolName: "commander.askUser",
            choices: ["Python + PyQt", "JavaScript + Electron", "Rust + Tauri"],
            requiredCapabilities: [],
            dependsOn: [],
            successCriteria: "Technology stack is selected.",
          }],
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u6211\u60f3\u505a\u4e00\u4e2a\u672c\u5730\u89c6\u9891\u58c1\u7eb8\u64ad\u653e\u5668", { mode: "project" });

    const waitingSnapshot = await waitForStatus(snapshots, "waiting_info");

    expect(waitingSnapshot.askUserQuestion?.question).toBe("请先补充一个关键信息，方便我继续规划。");
    expect(waitingSnapshot.askUserQuestion?.choices).toBeUndefined();

    unsubscribe();
    runtime.dispose();
  });

  it("skips ReAct for direct_tool_call Commander DAG steps", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Direct file scan",
      reasoning: "The file capability is explicit.",
      steps: [{
        id: "scan-files",
        title: "Scan files",
        assignedAgentKind: "file",
        toolName: "file.scanMarkdownDocuments",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"],
        dependsOn: [] as string[],
        executionMode: "direct_tool_call" as const,
        successCriteria: "Files scanned.",
      }],
    }));
    const scanMarkdownDocuments = vi.fn(async () => []);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan markdown documents", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(scanMarkdownDocuments).toHaveBeenCalledOnce();

    unsubscribe();
    runtime.dispose();
  });

  it("uses ReAct only for react executionMode Commander DAG steps", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Exploratory file scan",
      reasoning: "The agent should choose the tool.",
      steps: [{
        id: "scan-files",
        title: "Scan files",
        assignedAgentKind: "file",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"],
        dependsOn: [] as string[],
        executionMode: "react" as const,
        successCriteria: "Files scanned.",
      }],
    }));
    const scanMarkdownDocuments = vi.fn(async () => [{
      path: "E:/Javis/README.md",
      modifiedAt: "2026-06-07T00:00:00.000Z",
      sizeBytes: 10,
      heading: "Readme",
      excerpt: "Project readme.",
    }]);
    const createAgentRuntime = vi.fn<import("./index").AgentRuntimeFactory>(({ toolGateway }) => ({
      run(definition, request) {
        const result = (async () => {
          const toolResult = await toolGateway.execute({
            taskId: request.taskId,
            runId: request.runId,
            agentKind: definition.kind,
            toolName: "file.scanMarkdownDocuments",
            input: {},
            signal: request.signal,
          });
          return toolResult.status === "success"
            ? {
                status: "completed" as const,
                output: toolResult.output,
                stepResult: {
                  status: "completed" as const,
                  output: toolResult.output,
                  evidence: [],
                  assumptions: [],
                  unresolvedQuestions: [],
                },
                metrics: {
                  backend: "langchain" as const,
                  status: "completed" as const,
                  durationMs: 5,
                  modelCalls: 1,
                  toolCalls: 1,
                },
              }
            : {
                status: "failed" as const,
                reason: toolResult.reason ?? "Tool failed.",
                stepResult: {
                  status: "failed" as const,
                  evidence: [],
                  assumptions: [],
                  unresolvedQuestions: [],
                  error: toolResult.reason ?? "Tool failed.",
                },
                metrics: {
                  backend: "langchain" as const,
                  status: "failed" as const,
                  durationMs: 5,
                  modelCalls: 1,
                  toolCalls: 1,
                },
              };
        })();
        return {
          result,
          cancel: vi.fn(),
          events: (async function* (): AsyncGenerator<import("./index").AgentEvent> {
            yield { type: "run.started", runId: request.runId };
            const settled = await result;
            yield settled.status === "completed"
              ? { type: "run.completed", result: settled }
              : { type: "run.failed", reason: settled.reason ?? "Runtime failure." };
          })(),
        };
      },
    }));
    const getAgentRuntimeBackend = vi.fn(() => "langchain" as const);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
      getAgentRuntimeBackend,
      createAgentRuntime,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan markdown documents", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(scanMarkdownDocuments).toHaveBeenCalledOnce();
    expect(getAgentRuntimeBackend).toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("uses runtime-configured Agent max rounds for ReAct steps", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Long ReAct step",
      reasoning: "The agent needs more than four rounds.",
      steps: [{
        id: "long-react",
        title: "Run several observations",
        assignedAgentKind: "file",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"],
        dependsOn: [] as string[],
        executionMode: "react" as const,
        successCriteria: "The fifth decision can complete.",
      }],
    }));
    const scanMarkdownDocuments = vi.fn(async () => [{
      path: "E:/Javis/empty-scan-marker.md",
      modifiedAt: "2026-07-12T00:00:00.000Z",
      sizeBytes: 0,
      heading: "No matching documents",
      excerpt: "The scan completed and found no requested content.",
    }]);
    const createAgentRuntime = vi.fn<import("./index").AgentRuntimeFactory>(({ toolGateway }) => ({
      run(definition, request) {
        const result = (async () => {
          const toolResult = await toolGateway.execute({
            taskId: request.taskId,
            runId: request.runId,
            agentKind: definition.kind,
            toolName: "file.scanMarkdownDocuments",
            input: {},
            signal: request.signal,
          });
          return toolResult.status === "success"
            ? {
                status: "completed" as const,
                output: toolResult.output,
                stepResult: {
                  status: "completed" as const,
                  output: toolResult.output,
                  evidence: [],
                  assumptions: [],
                  unresolvedQuestions: [],
                },
                metrics: {
                  backend: "langchain" as const,
                  status: "completed" as const,
                  durationMs: 5,
                  modelCalls: 1,
                  toolCalls: 1,
                },
              }
            : {
                status: "failed" as const,
                reason: toolResult.reason ?? "Tool failed.",
                stepResult: {
                  status: "failed" as const,
                  evidence: [],
                  assumptions: [],
                  unresolvedQuestions: [],
                  error: toolResult.reason ?? "Tool failed.",
                },
              };
        })();
        return {
          result,
          cancel: vi.fn(),
          events: (async function* (): AsyncGenerator<import("./index").AgentEvent> {
            yield { type: "run.started", runId: request.runId };
            const settled = await result;
            yield settled.status === "completed"
              ? { type: "run.completed", result: settled }
              : { type: "run.failed", reason: settled.reason ?? "Runtime failure." };
          })(),
        };
      },
    }));
    const getAgentRuntimeBackend = vi.fn(() => "langchain" as const);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { agentMaxIterations: 8 },
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
      getAgentRuntimeBackend,
      createAgentRuntime,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan markdown documents with more rounds", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(scanMarkdownDocuments).toHaveBeenCalledTimes(1);

    unsubscribe();
    runtime.dispose();
  });

  it("completes direct_response Commander DAG steps without capability dispatch or ReAct", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Direct response",
      reasoning: "The answer can be synthesized directly.",
      steps: [{
        id: "answer-directly",
        title: "Answer directly",
        assignedAgentKind: "commander",
        dependsOn: [] as string[],
        executionMode: "direct_response" as const,
        successCriteria: "The user gets a direct answer.",
      }],
    }));
    const synthesize = vi.fn(async () => ({ message: "Here is the direct answer." }));
    const scanMarkdownDocuments = vi.fn(async () => []);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan, synthesize },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("answer this directly", {
      mode: "project",
      modelImages: ["data:image/png;base64,AA=="],
    });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      images: ["data:image/png;base64,AA=="],
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      images: ["data:image/png;base64,AA=="],
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("falls through unmatched L2 tool tasks to Commander instead of chat when Commander is available", async () => {
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Commander handles unmatched L2",
      reasoning: "The router found tool intent, but no deterministic legacy tool is available, so Commander should plan the answer.",
      steps: [{
        id: "synthesize-answer",
        title: "Synthesize answer",
        assignedAgentKind: "commander",
        dependsOn: [] as string[],
        executionMode: "direct_response" as const,
        requiredCapabilities: ["synthesis"],
        successCriteria: "The user receives a natural answer.",
      }],
    }));
    const synthesize = vi.fn(async () => ({ message: "Here is the direct answer." }));
    const chatComplete = vi.fn(async () => ({ text: "Chat should not answer this." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete: chatComplete },
      commanderTool: { plan: commanderPlan, synthesize },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("search local notes about scheduler routing");
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.logs.find((log) => log.title === "route_decided")?.detail)
      .toContain('"routeLevel":"L2"');
    expect(commanderPlan).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalled();
    expect(chatComplete).not.toHaveBeenCalled();
    expect(finalSnapshot.commanderMessage).toBe("Here is the direct answer.");

    unsubscribe();
    runtime.dispose();
  });

  it("describes the product multi-agent workflow blueprints", () => {
    const workflows = listWorkbenchWorkflows();

    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "read-current-project",
      "research-trending-topics",
      "plan-spring-boot-project",
      "find-local-document",
      "daily-reminder",
      "scan-workspace-documents",
      "browser-research",
      "browser-test",
      "pdf-organization",
      "code-review",
      "computer-use",
    ]);
    expect(getWorkbenchWorkflow("read-current-project")?.participatingAgentKinds).toEqual([
      "commander",
      "file",
      "shell",
      "code",
      "verifier",
    ]);
    expect(getWorkbenchWorkflow("find-local-document")?.participatingAgentKinds).toContain("computer");
    expect(getWorkbenchWorkflow("daily-reminder")?.steps).toContainEqual(expect.objectContaining({
      agentKind: "scheduler",
      permissionLevel: "confirmed_write",
    }));
    expect(getWorkbenchWorkflow("browser-research")?.safetyNotes).toContain(
      "Click/type/evaluate/runTest operations require confirmed-write approval.",
    );
    expect(getWorkbenchWorkflow("browser-test")?.safetyNotes).toContain(
      "Browser test execution requires confirmed-write approval.",
    );
    expect(getWorkbenchWorkflow("computer-use")?.currentSupport).toBe("partial");
    expect(getWorkbenchWorkflow("computer-use")?.steps).toContainEqual(expect.objectContaining({
      id: "execute-actions",
      permissionLevel: "confirmed_write",
    }));
  });

  it("aggregates model usage by task and agent kind", () => {
    const first = addModelUsage(undefined, "commander", {
      inputTokens: 100.8,
      outputTokens: 20.2,
    });
    const second = addModelUsage(first, "commander", {
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 20,
    });
    const final = addModelUsage(second, "research", {
      inputTokens: 30,
      outputTokens: 10,
    });

    expect(final).toEqual({
      inputTokens: 135,
      outputTokens: 37,
      totalTokens: 180,
      peakContextTokens: 120,
      modelCalls: 3,
      byAgentKind: [
        {
          agentKind: "commander",
          inputTokens: 105,
          outputTokens: 27,
          totalTokens: 140,
          modelCalls: 2,
        },
        {
          agentKind: "research",
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
          modelCalls: 1,
        },
      ],
    });
  });

  it("sums prefix-cache reads and writes only once a provider reports them", () => {
    const withoutCache = addModelUsage(undefined, "commander", {
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(withoutCache.cacheReadTokens).toBeUndefined();
    expect(withoutCache.cacheWriteTokens).toBeUndefined();

    const withCache = addModelUsage(withoutCache, "commander", {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 150,
    });
    expect(withCache.cacheReadTokens).toBe(150);
    expect(withCache.cacheWriteTokens).toBeUndefined();

    const anthropicWrite = addModelUsage(withCache, "commander", {
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 120,
    });
    expect(anthropicWrite.cacheReadTokens).toBe(200);
    expect(anthropicWrite.cacheWriteTokens).toBe(120);
  });

  it("keeps the measured usage paired with its actual model window", () => {
    const mostUtilized = addModelUsage(undefined, "commander", {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      model: "small-model",
      contextWindowTokens: 100,
    });
    const lowerUtilization = addModelUsage(mostUtilized, "verifier", {
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
      model: "large-model",
      contextWindowTokens: 1_000,
    });

    expect(lowerUtilization.contextUsedTokens).toBe(60);
    expect(lowerUtilization.contextWindowTokens).toBe(100);
  });

  it("routes project inspection goals through the project and shell tools", async () => {
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "typecheck", command: "pnpm -r typecheck" }],
      recommendedStartCommand: undefined,
      recommendedTestCommand: "pnpm typecheck",
    };
    const commands: ShellCommandOutput[] = [];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => {
          const output = {
            command: [request.program, ...request.args].join(" "),
            cwd: "E:/Javis",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
          commands.push(output);
          return output;
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test project environment");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.project).toEqual(project);
    expect(commands.map((command) => command.command)).toContain("pnpm typecheck");
    expect(finalSnapshot.verificationSummary).toContain("verified");

    unsubscribe();
    runtime.dispose();
  });

  it("executes the read-current-project workflow from the workflow blueprint", async () => {
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Model planned project read",
      reasoning: "Collect repository evidence, verify it, and synthesize the result.",
      steps: [
        {
          id: "inspect-project",
          title: "Inspect project structure",
          assignedAgentKind: "code",
          toolName: "code.inspectWorkspace",
          executionMode: "direct_tool_call" as const,
          toolInput: { maxDepth: 3, maxEntries: 400 },
          requiredCapabilities: ["workspace_inspect"],
          dependsOn: [] as string[],
          outputContextKey: "projectEvidence",
          successCriteria: "Repository-backed project evidence is collected.",
        },
        {
          id: "verify-project",
          title: "Verify project evidence",
          assignedAgentKind: "verifier",
          toolName: "verifier.check",
          executionMode: "direct_tool_call" as const,
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["inspect-project"],
          inputContextKeys: ["projectEvidence"],
          outputContextKey: "verifiedProjectEvidence",
          successCriteria: "Repository evidence is independently verified.",
        },
        {
          id: "answer-project",
          title: "Answer with verified findings",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: ["synthesis"],
          dependsOn: ["verify-project"],
          inputContextKeys: ["projectEvidence", "verifiedProjectEvidence"],
          outputContextKey: "finalAnswer",
          successCriteria: "The verified project summary is returned in chat.",
        },
      ],
    }));
    const inspectWorkspace = vi.fn<NonNullable<CodeTool["inspectWorkspace"]>>(async () => ({
      workspacePath: "E:/Javis",
      entries: [
        { name: "apps", relativePath: "apps", isDir: true, depth: 1 },
        { name: "packages", relativePath: "packages", isDir: true, depth: 1 },
        { name: "package.json", relativePath: "package.json", isDir: false, depth: 1 },
      ],
      topLevelDirectories: ["apps", "packages"],
      moduleCandidates: ["apps", "packages"],
      manifests: ["package.json"],
      ignoredDirectories: [],
      riskIndicators: [],
      truncated: false,
    }));
    const scanMarkdownDocuments = vi.fn(async () => []);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the summary." })),
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        inspectWorkspace,
      },
      fileTool: { scanMarkdownDocuments },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Model planned project read");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "inspect-project",
      "verify-project",
      "answer-project",
    ]);
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);
    expect(inspectWorkspace).toHaveBeenCalledOnce();
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "inspect this project",
    }), expect.objectContaining({ onUsage: expect.any(Function) }));

    unsubscribe();
    runtime.dispose();
  });

  it("keeps auto-mode L2 goals on Commander DAG when Commander is available", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Commander planned text write",
      reasoning: "Commander decides which agent handles the write request.",
      steps: [{
        id: "commander-summarize",
        title: "Summarize requested write",
        assignedAgentKind: "commander",
        toolName: "commander.synthesize",
        requiredCapabilities: [],
        dependsOn: [] as string[],
        successCriteria: "The request has a user-facing response.",
      }],
    }));
    const synthesize = vi.fn(async () => ({ message: "Here is the direct answer." }));
    const planWriteText = vi.fn(async () => createTextWritePlan("reports/search.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
        synthesize,
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
        planWriteText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write the AI news summary to reports/search.md");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "write the AI news summary to reports/search.md",
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(planWriteText).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Commander planned text write");

    unsubscribe();
    runtime.dispose();
  });

  it("routes Computer Use DAG steps through the loop with confirmed-write approval", async () => {
    const approveAction = vi.fn(async (_action, approvalId: string, taskId: string) => ({
      approvalId,
      taskId,
    }));
    const computerUseLoopRunner = vi.fn(async ({ approveAction: requestApproval }) => {
      const approval = await requestApproval({
        tool: "computer.click",
        params: { x: 120, y: 240, button: "left" },
      });
      return [{
        stepIndex: 0,
        observation: "A target button is visible.",
        action: { tool: "computer.click", params: { x: 120, y: 240, button: "left" } },
        target: "Click target button",
        confidence: "high",
        result: approval,
      }];
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: vi.fn(async () => ({
          title: "Use desktop",
          reasoning: "The goal requires desktop interaction.",
          steps: [{
            id: "use-desktop",
            title: "Use the desktop",
            assignedAgentKind: "computer",
            capability: "desktop_input" as const,
            requiredCapabilities: ["desktop_input"],
            dependsOn: [],
            successCriteria: "The desktop action completes.",
          }],
        })),
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      computerTool: {
        searchLocalDocuments: vi.fn(async () => []),
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        listWindows: vi.fn(async () => ({ windows: [] })),
        inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
        focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => ({ x: 120, y: 240, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
        keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
        scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
        invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
        setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
        wait: vi.fn(async () => ({ waited: 0 })),
        openPath: vi.fn(async () => ({ opened: true })),
        approveAction,
      },
      computerUseLoopRunner,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("点击桌面上的按钮。");
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");
    expect(permissionSnapshot.conversationMessages?.some((message) =>
      message.kind === "permission_request" &&
      message.permissionRequest?.id === permissionSnapshot.permissionRequest?.id
    )).toBe(true);
    expect(permissionSnapshot.permissionRequest?.title).toBeTruthy();

    runtime.resolvePermission("approved", permissionSnapshot.permissionRequest?.id);
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(computerUseLoopRunner).toHaveBeenCalledOnce();
    expect(approveAction).toHaveBeenCalledWith(
      { tool: "computer.click", params: { x: 120, y: 240, button: "left" }, riskLevel: "navigate" },
      permissionSnapshot.permissionRequest?.id,
      finalSnapshot.id,
      false,
    );
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("falls back to a deterministic Computer Use plan when Commander returns non-JSON", async () => {
    const computerUseLoopRunner = vi.fn(async () => [{
      stepIndex: 0,
      observation: "Desktop is visible.",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "done",
      confidence: "high",
    }]);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: vi.fn(async () => {
          throw new Error("Model response did not contain a JSON object.");
        }),
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      computerTool: {
        searchLocalDocuments: vi.fn(async () => []),
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        listWindows: vi.fn(async () => ({ windows: [] })),
        inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
        focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
        keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
        scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
        invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
        setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
        wait: vi.fn(async () => ({ waited: 0 })),
        openPath: vi.fn(async () => ({ opened: true })),
        approveAction: vi.fn(async (_action, approvalId: string, taskId: string) => ({ approvalId, taskId })),
      },
      computerUseLoopRunner,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u7528\u684c\u9762\u81ea\u52a8\u5316\u6253\u5f00 QQ\uff0c\u627e\u5230 \u51e4\u96cf-\u5927\u806a\u660e\uff0c\u5e76\u51c6\u5907\u53d1\u9001\u6d88\u606f\uff1a sb");
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(computerUseLoopRunner).toHaveBeenCalledOnce();
    expect(finalSnapshot.title).toBeTruthy();
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual(["computer-use-loop"]);

    unsubscribe();
    runtime.dispose();
  });

  it("does not route Computer Use goals with screenshot evidence text to Vision", async () => {
    const computerUseLoopRunner = vi.fn(async () => [{
      stepIndex: 0,
      observation: "QQ is visible.",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "message prepared",
      confidence: "high",
    }]);
    const commanderPlan = vi.fn(async () => ({
      title: "Prepare QQ message",
      reasoning: "Commander delegates desktop interaction to Computer Agent.",
      steps: [{
        id: "prepare-qq-message",
        title: "Prepare QQ message",
        assignedAgentKind: "computer",
        capability: "desktop_input" as const,
        requiredCapabilities: ["desktop_input"],
        dependsOn: [] as string[],
        successCriteria: "The QQ message is prepared before sending.",
      }],
    }));
    const visionAnalyze = vi.fn(async () => ({ description: "", objects: [] }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Unknown." })),
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      visionTool: {
        analyze: visionAnalyze,
        describe: vi.fn(async () => ({ description: "" })),
        extractText: vi.fn(async () => ({ text: "", confidence: 0 })),
      },
      computerTool: {
        searchLocalDocuments: vi.fn(async () => []),
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        listWindows: vi.fn(async () => ({ windows: [] })),
        inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
        focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
        keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
        scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
        invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
        setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
        wait: vi.fn(async () => ({ waited: 0 })),
        openPath: vi.fn(async () => ({ opened: true })),
        approveAction: vi.fn(async (_action, approvalId: string, taskId: string) => ({ approvalId, taskId })),
      },
      computerUseLoopRunner,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("用 Javis 的 computerUse 操控 QQ，找到联系人“凤雏-大聪明”，在聊天输入框输入消息“你好”，截图记录过程。", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledOnce();
    expect(visionAnalyze).not.toHaveBeenCalled();
    expect(computerUseLoopRunner).toHaveBeenCalledOnce();
    expect(finalSnapshot.title).toBe("Prepare QQ message");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual(["prepare-qq-message"]);

    unsubscribe();
    runtime.dispose();
  });

  it("blocks explicit Computer Use goals from chat mode", async () => {
    const computerUseLoopRunner = vi.fn(async () => [{
      stepIndex: 0,
      observation: "QQ is visible.",
      action: { tool: "computer.wait", params: { ms: 0 } },
      target: "message prepared",
      confidence: "high",
    }]);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      computerTool: {
        searchLocalDocuments: vi.fn(async () => []),
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        listWindows: vi.fn(async () => ({ windows: [] })),
        inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
        focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
        keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
        scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
        invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
        setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
        wait: vi.fn(async () => ({ waited: 0 })),
        openPath: vi.fn(async () => ({ opened: true })),
        approveAction: vi.fn(async (_action, approvalId: string, taskId: string) => ({ approvalId, taskId })),
      },
      computerUseLoopRunner,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start(
      "\u7528\u684c\u9762\u81ea\u52a8\u5316\u6253\u5f00 QQ\uff0c\u627e\u5230 \u51e4\u96cf-\u5927\u806a\u660e\uff0c\u5e76\u51c6\u5907\u53d1\u9001\u6d88\u606f\uff1a sb",
      { mode: "chat" },
    );
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(computerUseLoopRunner).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("已拦截");
    expect(finalSnapshot.commanderMessage).toContain("聊天模式");
    expect(finalSnapshot.commanderMessage).toContain("Agent 模式");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual(["chat-mode-boundary"]);

    unsubscribe();
    runtime.dispose();
  });

  it("routes project-mode goals through auto routing to project workflow", async () => {
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "test", command: "pnpm test" }],
      recommendedStartCommand: "pnpm dev",
      recommendedTestCommand: "pnpm test",
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async () => ({
          command: "pnpm --version",
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        })),
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
      },
      verifierTool: {
        check: vi.fn(async () => ({
          status: "pass" as const,
          summary: "ok",
          detail: "ok",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    // "inspect this project" matches isReadCurrentProjectGoal, goes through
    // auto routing -> project workflow (not forced, not short-circuited).
    runtime.start("inspect this project", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Read current project");
    expect(finalSnapshot.project).toEqual(project);

    unsubscribe();
    runtime.dispose();
  });

  it("routes project-mode inputs through legacy routing when Commander is unavailable", async () => {
    const complete = vi.fn(async () => ({ text: "Hello! How can I help?" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("hello", { mode: "project" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(complete).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Answered");

    unsubscribe();
    runtime.dispose();
  });

  it("routes reminder goals through the approved Scheduler tool", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Model planned reminder",
      reasoning: "Use the Scheduler to create a durable daily reminder.",
      steps: [
        {
          id: "create-reminder",
          title: "Create daily reminder",
          assignedAgentKind: "scheduler",
          toolName: "scheduler.createTask",
          toolInput: {
            name: "Daily reminder",
            goal: "test",
            schedule: { type: "daily", value: "08:00" },
            nextRunAt: "2026-07-29T08:00:00+08:00",
          },
          capability: "schedule_create" as const,
          requiredCapabilities: ["schedule_create"] as string[],
          executionMode: "direct_tool_call" as const,
          dependsOn: [] as string[],
          successCriteria: "Reminder is persisted.",
        },
      ],
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createTask = vi.fn(async (_draft: any) => ({
      name: "test",
      goal: "test",
      schedule: { type: "daily" as const, value: "08:00" },
      nextRunAt: new Date().toISOString(),
      id: "st-test",
      enabled: true,
    })) as any;
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Unknown." })),
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      schedulerTool: {
        createTask,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("remind me every day at 8");

    await vi.waitFor(() => {
      expect(snapshots.some((snapshot) => snapshot.permissionRequest?.status === "pending")).toBe(true);
    });
    const permissionSnapshot = snapshots.find((snapshot) =>
      snapshot.permissionRequest?.status === "pending"
    );
    runtime.resolvePermission("approved", permissionSnapshot?.permissionRequest?.id);

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Model planned reminder");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "create-reminder",
    ]);
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);
    expect(createTask).toHaveBeenCalledOnce();
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "remind me every day at 8",
    }), expect.objectContaining({ onUsage: expect.any(Function) }));

    unsubscribe();
    runtime.dispose();
  });

  it("executes research trending workflow with search and fetch tools", async () => {
    const searchWeb = vi.fn(async () => [
      {
        url: "https://example.com/trend",
        title: "Trend",
        excerpt: "Search excerpt",
        fetchedAt: "2026-05-25T00:00:00.000Z",
        provider: "fixture",
      },
    ]);
    const fetchWebSource = vi.fn(async () => ({
      url: "https://example.com/trend",
      title: "Trend details",
      excerpt: "Fetched detail excerpt",
      fetchedAt: "2026-05-25T00:01:00.000Z",
      provider: "fixture",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      webTool: {
        searchWeb,
        fetchWebSource,
      },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("latest trending topics");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(searchWeb).toHaveBeenCalled();
    expect(fetchWebSource).toHaveBeenCalledWith({ url: "https://example.com/trend" });
    expect(finalSnapshot.sources).toHaveLength(1);
    expect(finalSnapshot.researchReport?.rows[0]?.sourceUrl).toBe("https://example.com/trend");
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("does not route search-backed research through disabled web.search", async () => {
    const searchWeb = vi.fn(async () => [
      {
        url: "https://example.com/trend",
        title: "Trend",
        excerpt: "Search excerpt",
        fetchedAt: "2026-05-25T00:00:00.000Z",
        provider: "fixture",
      },
    ]);
    const fetchWebSource = vi.fn(async () => ({
      url: "https://example.com/trend",
      title: "Trend details",
      excerpt: "Fetched detail excerpt",
      fetchedAt: "2026-05-25T00:01:00.000Z",
      provider: "fixture",
    }));
    const commanderPlan = vi.fn(async (request) => {
      expect(request.availableTools?.some((tool: { name: string }) => tool.name === "web.search")).toBe(false);
      return {
        title: "Answer without search",
        reasoning: "Search is disabled.",
        steps: [{
          id: "answer",
          title: "Answer without search",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: [],
          dependsOn: [] as string[],
          successCriteria: "User gets a bounded answer.",
        }],
      };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      webTool: {
        searchWeb,
        fetchWebSource,
      },
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the direct answer." })),
      },
      availableToolDescriptors: initialToolDescriptors.filter((descriptor) => descriptor.name !== "web.search"),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("latest trending topics");

    await waitForStatus(snapshots, "completed");

    expect(searchWeb).not.toHaveBeenCalled();
    expect(fetchWebSource).not.toHaveBeenCalled();
    expect(commanderPlan).toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("does not expose code.searchRepository unless the runtime code tool implements it", async () => {
    const commanderPlan = vi.fn(async (request) => {
      expect(request.availableTools?.some((tool: { name: string }) => tool.name === "code.searchRepository")).toBe(false);
      const codeAgent = request.availableAgents.find((agent: { kind: string }) => agent.kind === "code");
      expect(codeAgent?.allowedToolNames).not.toContain("code.searchRepository");
      return {
        title: "Answer without repository search",
        reasoning: "Repository search is unavailable.",
        steps: [{
          id: "answer",
          title: "Answer without repository search",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: [],
          dependsOn: [] as string[],
          successCriteria: "User gets a bounded answer.",
        }],
      };
    });
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      codeTool,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the direct answer." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("search the current repository for agent memory code");

    await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("exposes code.searchRepository when the runtime code tool implements it", async () => {
    const commanderPlan = vi.fn(async (request) => {
      expect(request.availableTools?.some((tool: { name: string }) => tool.name === "code.searchRepository")).toBe(true);
      const codeAgent = request.availableAgents.find((agent: { kind: string }) => agent.kind === "code");
      expect(codeAgent?.allowedToolNames).toContain("code.searchRepository");
      return {
        title: "Repository search available",
        reasoning: "Repository search can be delegated.",
        steps: [{
          id: "answer",
          title: "Repository search available",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: [],
          dependsOn: [] as string[],
          successCriteria: "User gets a bounded answer.",
        }],
      };
    });
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository: vi.fn(async () => ({
        actualFound: [],
        inferred: [],
        needsConfirmation: [],
        keyFiles: [],
        relatedTestFiles: [],
        testFileCandidates: [],
        clusters: [],
        attempts: [],
      })),
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
      codeTool,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the direct answer." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("search the current repository for agent memory code");

    await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("executes local document workflow with the Computer tool", async () => {
    const searchLocalDocuments = vi.fn(async () => [
      {
        name: "finance-report.pdf",
        path: "C:/Users/me/Documents/finance-report.pdf",
        isDir: false,
        sizeBytes: 1200,
        modifiedAt: "2026-05-24T00:00:00.000Z",
        extension: "pdf",
      },
    ]);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
        classifyDocuments: vi.fn(async () => []),
      },
      computerTool: {
        searchLocalDocuments,
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        listWindows: vi.fn(async () => ({ windows: [] })),
        inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
        focusWindow: vi.fn(async () => ({ focused: true, title: "" })),
        moveMouse: vi.fn(async () => ({ x: 0, y: 0 })),
        click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
        keyCombo: vi.fn(async () => ({ combo: "", executed: true })),
        scroll: vi.fn(async () => ({ x: 0, y: 0, delta: 0 })),
        invokeUi: vi.fn(async () => ({ invoked: true, matchedName: "", matchedAutomationId: "" })),
        setUiValue: vi.fn(async () => ({ set: true, matchedName: "", matchedAutomationId: "" })),
        wait: vi.fn(async () => ({ waited: 0 })),
        openPath: vi.fn(async () => ({ opened: true })),
        approveAction: vi.fn(async () => ({ approvalId: "test-approval" })),
      },
      verifierTool: {
        check: vi.fn(async () => ({ status: "pass" as const, summary: "verified", detail: "All checks passed." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("find local finance document on my computer");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(searchLocalDocuments).toHaveBeenCalled();
    // Commander-synthesize steps are handled separately at the workflow level,
    // not executed as individual steps 鈥?they may appear as "skipped".
    const executedSteps = finalSnapshot.plan.filter(
      (step) => !step.id.includes("commander-synthesize"),
    );
    expect(executedSteps.every((step) => step.status === "completed")).toBe(true);
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("combines multiple recommended workflow blueprints in the generic executor", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("remind me every day at 8 and find local document on my computer");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toContain("Combined workflow");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "find-local-document:parse-query",
      "find-local-document:search-computer",
      "find-local-document:rank-results",
      "daily-reminder:parse-schedule",
      "daily-reminder:persist-reminder",
      "daily-reminder:verify-reminder",
      "scan-workspace-documents:scan-documents",
      "scan-workspace-documents:classify-documents",
      "scan-workspace-documents:verify-scan",
      "scan-workspace-documents:commander-synthesize",
    ]);
    expect(finalSnapshot.plan.find((step) => step.id === "daily-reminder:persist-reminder")?.status).toBe("skipped");
    expect(finalSnapshot.commanderMessage).toContain("daily-reminder:persist-reminder");
    expect(finalSnapshot.verificationSummary).toContain("Verifier tool is unavailable.");

    unsubscribe();
    runtime.dispose();
  });

  it("marks project inspection failed when an allowlisted check fails", async () => {
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "typecheck", command: "pnpm -r typecheck" }],
      recommendedStartCommand: undefined,
      recommendedTestCommand: "pnpm typecheck",
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: request.program === "pnpm" && request.args[0] === "typecheck" ? 1 : 0,
          stdout: "",
          stderr: request.program === "pnpm" && request.args[0] === "typecheck" ? "failed" : "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test project environment");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Project environment check failed");
    expect(finalSnapshot.verificationSummary).toContain("failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.title).toBe("verification.failed");

    unsubscribe();
    runtime.dispose();
  });

  it("routes code review goals through a diff preview and read-only verification", async () => {
    const preview = {
      workspacePath: "E:/Javis",
      changedFiles: ["packages/core/src/index.ts", "packages/ui/src/index.tsx"],
      diffStat: "2 files changed, 10 insertions(+), 4 deletions(-)",
      diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => preview),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.codeReviewPreview).toEqual(preview);
    expect(finalSnapshot.commands).toHaveLength(1);
    expect(finalSnapshot.commands?.[0]?.command).toBe("git diff --check");
    expect(finalSnapshot.verificationSummary).toContain("git diff --check passed");
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated in the degraded code-review path");

    unsubscribe();
    runtime.dispose();
  });

  it("routes code review read-only verification through WorkspaceRuntime when provided", async () => {
    const preview = {
      workspacePath: "E:/Javis",
      changedFiles: ["packages/core/src/index.ts"],
      diffStat: "1 file changed, 1 insertion(+)",
      diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
    };
    const shellRunReadOnlyCommand = vi.fn(async () => {
      throw new Error("shell fallback should not run when workspaceRuntime is provided");
    });
    const workspaceExecute = vi.fn(async (request) => ({
      command: [request.program, ...request.args].join(" "),
      cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => preview),
      },
      shellTool: {
        runReadOnlyCommand: shellRunReadOnlyCommand,
      },
      workspaceRuntime: {
        kind: "sandbox",
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
        execute: workspaceExecute,
        readFile: vi.fn(),
        listFiles: vi.fn(),
        createSnapshot: vi.fn(),
        diff: vi.fn(),
        dispose: vi.fn(),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.commands?.[0]?.cwd).toBe("E:/Javis/.codex-tmp/javis-sandboxes/task-runtime");
    expect(workspaceExecute).toHaveBeenCalledWith({
      program: "git",
      args: ["diff", "--check"],
      cwd: undefined,
      permissionLevel: "read",
    });
    expect(shellRunReadOnlyCommand).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("keeps degraded code review read-only when a legacy proposal callback is present", async () => {
    const preview = {
      workspacePath: "E:/Javis",
      changedFiles: ["packages/core/src/index.ts"],
      diffStat: "1 file changed, 2 insertions(+)",
      diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
    };
    const proposedEdit = {
      proposalId: "proposal-1",
      workspacePath: "E:/Javis",
      summary: "Tighten the code review completion message.",
      changedFiles: ["packages/core/src/index.ts"],
      patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      patchHash: "fnv1a-19fcfa54",
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 340,
      },
    };
    const applyProposedEdit = vi.fn(async () => ({
      applied: true,
      workspacePath: proposedEdit.workspacePath,
      changedFiles: proposedEdit.changedFiles,
      message: "Applied patch in test.",
    }));
    const proposeEdit = vi.fn(async () => proposedEdit);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => preview),
        proposeEdit,
        applyProposedEdit,
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(proposeEdit).not.toHaveBeenCalled();
    expect(applyProposedEdit).not.toHaveBeenCalled();
    expect(finalSnapshot.codeProposedEdit).toBeUndefined();
    expect(finalSnapshot.codeApplyResult).toBeUndefined();
    expect(finalSnapshot.commands).toHaveLength(1);
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated");
    expect(finalSnapshot.plan.find((step) => step.id === "step-propose-code-edit")?.status)
      .toBe("skipped");
    expect(finalSnapshot.plan.find((step) => step.id === "step-apply-code-edit")?.status)
      .toBe("skipped");

    unsubscribe();
    runtime.dispose();
  });

  it("does not enter the workspace apply path from degraded code review", async () => {
    const preview = {
      workspacePath: "E:/Javis",
      changedFiles: ["packages/core/src/index.ts"],
      diffStat: "1 file changed, 2 insertions(+)",
      diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
    };
    const proposedEdit = {
      proposalId: "proposal-1",
      workspacePath: "E:/Javis",
      summary: "Tighten the code review completion message.",
      changedFiles: ["packages/core/src/index.ts"],
      patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      patchHash: "fnv1a-19fcfa54",
    };
    const createSnapshot = vi.fn(async () => ({
      runtimeKind: "sandbox" as const,
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
      snapshotId: "snapshot-1",
      createdAt: "2026-06-17T00:00:00.000Z",
    }));
    const diff = vi.fn(async () => ({
      root: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
      unifiedDiff: "",
      changedFiles: [{ path: "packages/core/src/index.ts", change: "modified" as const }],
    }));
    const applyProposedEdit = vi.fn(async () => ({
      applied: true,
      workspacePath: proposedEdit.workspacePath,
      changedFiles: proposedEdit.changedFiles,
      message: "Applied patch in test.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => preview),
        proposeEdit: vi.fn(async () => proposedEdit),
        applyProposedEdit,
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
      workspaceRuntime: {
        kind: "sandbox",
        root: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
        execute: vi.fn(async (request) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-runtime",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
        readFile: vi.fn(),
        listFiles: vi.fn(),
        createSnapshot,
        diff,
        dispose: vi.fn(),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.codeApplyResult).toBeUndefined();
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(applyProposedEdit).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("does not request a patch approval in degraded code review", async () => {
    const proposedEdit = {
      proposalId: "proposal-1",
      workspacePath: "E:/Javis",
      summary: "Tighten the code review completion message.",
      changedFiles: ["packages/core/src/index.ts"],
      patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      patchHash: "fnv1a-19fcfa54",
    };
    const applyProposedEdit = vi.fn(async () => ({
      applied: true,
      workspacePath: proposedEdit.workspacePath,
      changedFiles: proposedEdit.changedFiles,
      message: "Should not run.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
        proposeEdit: vi.fn(async () => proposedEdit),
        applyProposedEdit,
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(applyProposedEdit).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated");

    unsubscribe();
    runtime.dispose();
  });

  it("ignores legacy proposal safety callbacks in degraded code review", async () => {
    const applyProposedEdit = vi.fn(async () => ({
      applied: true,
      workspacePath: "E:/Javis",
      changedFiles: ["packages/core/src/index.ts"],
      message: "Should not run.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
        proposeEdit: vi.fn(async () => ({
          proposalId: "proposal-1",
          workspacePath: "E:/Javis",
          summary: "Tighten the code review completion message.",
          changedFiles: ["packages/core/src/index.ts"],
          patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
          patchHash: "fnv1a-wrong",
        })),
        applyProposedEdit,
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Code review completed");
    expect(applyProposedEdit).not.toHaveBeenCalled();
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated");

    unsubscribe();
    runtime.dispose();
  });

  it("does not invoke a legacy proposal backend after verification", async () => {
    const proposeEdit = vi.fn(async () => {
      throw new Error("provider returned invalid proposal");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
        proposeEdit,
        applyProposedEdit: vi.fn(async () => ({
          applied: true,
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          message: "Should not run.",
        })),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(proposeEdit).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Code review completed");
    expect(finalSnapshot.commanderMessage).toBeTruthy();
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated");

    unsubscribe();
    runtime.dispose();
  });

  it("does not consume legacy apply results in degraded code review", async () => {
    const proposedEdit = {
      proposalId: "proposal-1",
      workspacePath: "E:/Javis",
      summary: "Tighten the code review completion message.",
      changedFiles: ["packages/core/src/index.ts"],
      patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
      patchHash: "fnv1a-19fcfa54",
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
        proposeEdit: vi.fn(async () => proposedEdit),
        applyProposedEdit: vi.fn(async () => ({
          applied: true,
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts", "packages/core/src/other.ts"],
          message: "Applied extra file.",
        })),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Code review completed");
    expect(finalSnapshot.verificationSummary).toContain("no patch was generated");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps denied code review permissions as a read-only no-op", async () => {
    const runReadOnlyCommand = vi.fn(async (request: ShellCommandRequest) => ({
      command: [request.program, ...request.args].join(" "),
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
      },
      shellTool: {
        runReadOnlyCommand,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("denied");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(runReadOnlyCommand).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("denied");
    expect(finalSnapshot.verificationSummary).toContain("no read-only verification command was executed");

    unsubscribe();
    runtime.dispose();
  });

  it("skips Code Agent proposal steps when diff verification fails", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: ["packages/core/src/index.ts"],
          diffStat: "1 file changed",
          diff: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
        })),
        proposeEdit: vi.fn(async () => ({
          proposalId: "proposal-1",
          workspacePath: "E:/Javis",
          summary: "Should not run.",
          changedFiles: ["packages/core/src/index.ts"],
          patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
          patchHash: "fnv1a-19fcfa54",
        })),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 1,
          stdout: "",
          stderr: "whitespace error",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.plan.find((step) => step.id === "step-verify-code")?.status).toBe("failed");
    expect(finalSnapshot.plan.find((step) => step.id === "step-propose-code-edit")?.status).toBe("skipped");
    expect(finalSnapshot.plan.find((step) => step.id === "step-apply-code-edit")?.status).toBe("skipped");

    unsubscribe();
    runtime.dispose();
  });

  it("skips follow-up Code Agent steps when diff preview fails", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      codeTool: {
        inspectRepository: vi.fn(async () => {
          throw new Error("git status failed");
        }),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.plan.find((step) => step.id === "step-inspect-code")?.status).toBe("failed");
    expect(finalSnapshot.plan.find((step) => step.id === "step-review-code")?.status).toBe("skipped");
    expect(finalSnapshot.plan.find((step) => step.id === "step-verify-code")?.status).toBe("skipped");
    expect(finalSnapshot.plan.find((step) => step.id === "step-propose-code-edit")?.status).toBe("skipped");
    expect(finalSnapshot.plan.find((step) => step.id === "step-apply-code-edit")?.status).toBe("skipped");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps denied PDF organization permissions as a no-op", async () => {
    const executePdfOrganization = vi.fn(async () => createExecution([]));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => createPdfPlan(),
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("denied");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("denied");
    expect(finalSnapshot.verificationSummary).toContain("no write operation was executed");

    unsubscribe();
    runtime.dispose();
  });

  it("executes exactly the approved PDF dry-run operations", async () => {
    const plan = createPdfPlan();
    const executePdfOrganization = vi.fn(async (operations: PlannedPathOperation[]) =>
      createExecution(operations),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => plan,
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).toHaveBeenCalledWith(
      plan.dryRun.affectedPaths,
      plan.approvalId,
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.fileOrganizationExecution?.movedCount).toBe(1);
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps denied text file writes as a no-op", async () => {
    const writeText = vi.fn(async () => createTextWriteResult("notes.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# Search results\n\nNo results were found.\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => createTextWritePlan("notes.md"),
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write the search results to notes.md");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("denied");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(writeText).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("denied");
    expect(finalSnapshot.verificationSummary).toContain("no write operation was executed");

    unsubscribe();
    runtime.dispose();
  });

  it("writes exactly the approved text content", async () => {
    const plan = createTextWritePlan("summary.md");
    const generatedContent = "# AI news summary\n\nGenerated by the configured model.\n";
    const writeText = vi.fn(async (request: { targetPath: string; content: string }) =>
      createTextWriteResult(request.targetPath, request.content.length),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool(generatedContent),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => plan,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("把这份总结保存成 summary.md。");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: "summary.md",
        content: generatedContent,
      }),
      plan.approvalId,
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");
    // Verification now reports what actually ran: nothing independent here.
    expect(finalSnapshot.verificationSummary).toContain("未独立验证");
    expect(finalSnapshot.documents).toContainEqual(expect.objectContaining({
      path: "summary.md",
      heading: "AI news summary",
      sizeBytes: generatedContent.length,
    }));
    const finalMessages = finalSnapshot.conversationMessages ?? [];
    expect(finalMessages.some((message) =>
      message.kind === "permission_request" &&
      message.permissionRequest?.id === finalSnapshot.permissionRequest?.id,
    )).toBe(true);
    expect(finalMessages[finalMessages.length - 1]).toMatchObject({
      role: "assistant",
      content: finalSnapshot.commanderMessage,
    });

    unsubscribe();
    runtime.dispose();
  });

  it("uses Chinese text and registers the generated Markdown artifact for Chinese goals", async () => {
    const content = "# \u65f6\u5149\u4fee\u590d\u5e08\n\n\u6545\u4e8b\u6b63\u6587。\n";
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool(content),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => createTextWritePlan("\u65f6\u5149\u4fee\u590d\u5e08.md"),
        writeText: async (request) => createTextWriteResult(request.targetPath, request.content.length),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4，\u4fdd\u5b58\u4e3a\u65f6\u5149\u4fee\u590d\u5e08.md", {
      mode: "project",
      taskId: "task-chinese-text-write",
    });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");

    expect(permissionSnapshot.title).toBe("\u6587\u672c\u6587\u4ef6\u5199\u5165\u9700\u8981\u6388\u6743");
    expect(permissionSnapshot.permissionRequest).toMatchObject({
      title: "\u6279\u51c6\u6587\u672c\u6587\u4ef6\u5199\u5165",
      reason: expect.stringContaining("\u9700\u8981\u4f60\u7684\u660e\u786e\u6388\u6743"),
    });
    runtime.resolvePermission("approved");
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("\u6587\u672c\u6587\u4ef6\u5df2\u5199\u5165");
    // The message now carries the verification result as well.
    expect(finalSnapshot.commanderMessage).toContain("\u6587\u4ef6\u4ee3\u7406\u5df2\u5c06\u5185\u5bb9\u5199\u5165 \u65f6\u5149\u4fee\u590d\u5e08.md。");
    expect(finalSnapshot.documents).toContainEqual(expect.objectContaining({
      path: "\u65f6\u5149\u4fee\u590d\u5e08.md",
      heading: "\u65f6\u5149\u4fee\u590d\u5e08",
      purpose: "\u6839\u636e\u7528\u6237\u7684\u6587\u672c\u6587\u4ef6\u8bf7\u6c42\u751f\u6210。",
    }));
    // The completion log now reports the verification outcome as well, so assert
    // the stable part instead of one exact sentence.
    expect(
      finalSnapshot.logs.some((log) => log.userMessage?.includes("\u6587\u672c\u6587\u4ef6\u5df2\u5199\u5165")),
    ).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("generates requested file content with the model before project-mode approval", async () => {
    const plan = createTextWritePlan("\u96fe\u6e2f.md");
    const firstSection = `# \u96fe\u6e2f\n\n${"\u591c\u8272\u4e2d\u7684\u6d77\u6f6e\u7f13\u6162\u62cd\u6253\u77f3\u5cb8\u3002".repeat(300)}`;
    const secondSection = "\u6668\u5149\u91cc\u7684\u6e14\u706b\u9010\u6e10\u6d88\u5931\u3002".repeat(600);
    const generatedContent = `${firstSection}\n\n${secondSection}\n`;
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Should not run",
      reasoning: "Text write goals must use the dedicated approval flow.",
      steps: [{
        id: "write-story",
        title: "Write story",
        assignedAgentKind: "file",
        toolName: "file.writeText",
        requiredCapabilities: [],
        dependsOn: [] as string[],
        successCriteria: "The story is written.",
      }],
    }));
    const writeText = vi.fn(async (request: { targetPath: string; content: string }) =>
      createTextWriteResult(request.targetPath, request.content.length),
    );
    const planWriteText = vi.fn(async (request: { targetPath: string; content: string }) => {
      expect(request.targetPath).toBe("\u96fe\u6e2f.md");
      expect(request.content).toBe(generatedContent);
      expect(request.content).not.toContain("Generated from request");
      expect(request.content).not.toContain("## Notes");
      return plan;
    });
    const complete = vi.fn()
      // The Commander decides the artifact contract before any content is written.
      .mockResolvedValueOnce({
        text: JSON.stringify({ format: "md", fileName: "\u96fe\u6e2f.md", requirements: [] }),
      })
      .mockResolvedValueOnce({ text: firstSection })
      .mockResolvedValueOnce({ text: secondSection });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
      commanderTool: {
        plan: commanderPlan,
      },
      availableToolDescriptors: initialToolDescriptors,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc710000\u5b57\u5de6\u53f3\u7684\u77ed\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("You decide the artifact contract"),
      expect.objectContaining({ temperature: 0 }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Fully perform the requested writing task"),
      expect.objectContaining({ useMaxOutputTokens: true }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("Continue the document below"),
      expect.objectContaining({ useMaxOutputTokens: true }),
    );
    expect(planWriteText).toHaveBeenCalledTimes(1);
    expect(permissionSnapshot.permissionRequest?.level).toBe("confirmed_write");
    expect(permissionSnapshot.permissionRequest?.dryRun.operation).toBe("Write text file");
    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: "\u96fe\u6e2f.md", content: generatedContent }),
      plan.approvalId,
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(3);
    // Transparency: every model call leaves one readable ledger line naming the
    // phase that asked for it, so the task log answers "what did the AI do".
    const modelCallLogs = finalSnapshot.logs.filter((log) => log.title === "agent.model_call");
    expect(modelCallLogs).toHaveLength(3);
    expect(modelCallLogs.map((log) => log.detail?.split(" ")[0])).toEqual([
      "artifact-contract",
      "content-generation",
      "content-continuation",
    ]);
    expect(modelCallLogs.map((log) => log.detail?.split(" ")[0])).toEqual([
      "artifact-contract",
      "content-generation",
      "content-continuation",
    ]);
    const finalMessages = finalSnapshot.conversationMessages ?? [];
    expect(finalMessages.some((message) => message.kind === "permission_request")).toBe(true);
    expect(finalMessages[finalMessages.length - 1]).toMatchObject({
      role: "assistant",
      content: finalSnapshot.commanderMessage,
    });

    unsubscribe();
    runtime.dispose();
  });

  it("streams generated file content before requesting write approval", async () => {
    const complete = vi.fn(async (prompt: string) => {
      if (prompt.includes("You decide the artifact contract")) {
        return { text: JSON.stringify({ format: "md", fileName: "visible-draft.md", requirements: [] }) };
      }
      return { text: "fallback should not run" };
    });
    let streamOptions: { maxTokens?: number; useMaxOutputTokens?: boolean } | undefined;
    async function* stream(
      _prompt: string,
      options?: { maxTokens?: number; useMaxOutputTokens?: boolean },
    ) {
      streamOptions = options;
      yield { text: "# Visible draft\n\n" };
      yield { text: "The story appears while it is being written." };
    }
    const eventBus = createTaskEventBus();
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      eventBus,
      chatTool: { complete, stream },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => createTextWritePlan("visible-draft.md"),
        writeText: vi.fn(async () => createTextWriteResult("visible-draft.md")),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write a story and save it as visible-draft.md", {
      mode: "project",
      taskId: "task-streamed-text-write",
    });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");

    // The decision is the only non-streaming call; content must still stream.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0]?.[0])).toContain("You decide the artifact contract");
    expect(streamOptions).toMatchObject({ useMaxOutputTokens: true });
    expect(streamOptions?.maxTokens).toBeUndefined();
    expect(snapshots.some((item) =>
      item.isStreaming && item.streamingText?.includes("Visible draft")
    )).toBe(true);
    expect(permissionSnapshot.permissionRequest?.status).toBe("pending");
    expect(permissionSnapshot.tokenUsage?.modelCalls).toBe(2);

    runtime.resolvePermission("denied");
    await waitForStatus(snapshots, "completed");
    unsubscribe();
    runtime.dispose();
  });

  it("continues a length-truncated stream before requesting write approval", async () => {
    const complete = vi.fn(async (prompt: string) => {
      if (prompt.includes("You decide the artifact contract")) {
        return { text: JSON.stringify({ format: "md", fileName: "streamed-story.md", requirements: [] }) };
      }
      return { text: "fallback should not run" };
    });
    let streamCallCount = 0;
    async function* stream(
      _prompt: string,
      options?: { onFinish?: (finishReason?: string) => void },
    ) {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        yield { text: `# \u591c\u6e2f\n\n${"\u6f6e".repeat(4_100)}` };
        options?.onFinish?.("length");
        return;
      }
      yield { text: "\u5929\u4eae\u65f6，\u4ed6\u7ec8\u4e8e\u56de\u5230\u4e86\u5bb6。" };
      options?.onFinish?.("stop");
    }
    const planWriteText = vi.fn(async () => createTextWritePlan("streamed-story.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      eventBus: createTaskEventBus(),
      chatTool: { complete, stream },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText: vi.fn(async () => createTextWriteResult("streamed-story.md")),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc74000\u5b57\u7684\u5c0f\u8bf4，\u4fdd\u5b58\u4e3a streamed-story.md", {
      mode: "project",
      taskId: "task-truncated-streamed-text-write",
    });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");

    expect(streamCallCount).toBe(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0]?.[0])).toContain("You decide the artifact contract");
    expect(planWriteText).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("\u5929\u4eae\u65f6，\u4ed6\u7ec8\u4e8e\u56de\u5230\u4e86\u5bb6。"),
      }),
      "task-truncated-streamed-text-write",
    );
    expect(permissionSnapshot.permissionRequest?.status).toBe("pending");
    expect(permissionSnapshot.tokenUsage?.modelCalls).toBe(3);

    runtime.resolvePermission("denied");
    await waitForStatus(snapshots, "completed");
    unsubscribe();
    runtime.dispose();
  });

  it("continues a truncated stream without inventing a length target", async () => {
    const prompts: string[] = [];
    async function* stream(
      prompt: string,
      options?: { onFinish?: (finishReason?: string) => void },
    ) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield { text: "# \u65e0\u5b57\u6570\u9650\u5236\u7684\u6545\u4e8b\n\n\u6545\u4e8b\u4ece\u8fd9\u91cc\u5f00\u59cb。" };
        options?.onFinish?.("length");
        return;
      }
      yield { text: "\u8fd9\u662f\u5b8c\u6574\u7684\u7ed3\u5c3e。" };
      options?.onFinish?.("stop");
    }
    const planWriteText = vi.fn(async () => createTextWritePlan("open-ended-story.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      eventBus: createTaskEventBus(),
      chatTool: {
        complete: vi.fn(async () => ({ text: "fallback should not run" })),
        stream,
      },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText: vi.fn(async () => createTextWriteResult("open-ended-story.md")),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4，\u4fdd\u5b58\u4e3a open-ended-story.md", {
      mode: "project",
      taskId: "task-open-ended-streamed-text-write",
    });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("without introducing an arbitrary length target");
    expect(planWriteText).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("\u8fd9\u662f\u5b8c\u6574\u7684\u7ed3\u5c3e。") }),
      "task-open-ended-streamed-text-write",
    );
    expect(permissionSnapshot.permissionRequest?.status).toBe("pending");

    runtime.resolvePermission("denied");
    await waitForStatus(snapshots, "completed");
    unsubscribe();
    runtime.dispose();
  });

  it("does not request approval when every streamed continuation is truncated", async () => {
    let streamCallCount = 0;
    async function* stream(
      _prompt: string,
      options?: { onFinish?: (finishReason?: string) => void },
    ) {
      streamCallCount += 1;
      yield { text: "\u672a\u5b8c\u6210\u7684\u6b63\u6587".repeat(300) };
      options?.onFinish?.("length");
    }
    const planWriteText = vi.fn(async () => createTextWritePlan("truncated-story.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      eventBus: createTaskEventBus(),
      chatTool: {
        complete: vi.fn(async () => ({ text: "fallback should not run" })),
        stream,
      },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText: vi.fn(async () => createTextWriteResult("truncated-story.md")),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc74000\u5b57\u7684\u5c0f\u8bf4，\u4fdd\u5b58\u4e3a truncated-story.md", {
      mode: "project",
      taskId: "task-exhausted-truncated-stream",
    });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(streamCallCount).toBe(8);
    expect(planWriteText).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest).toBeUndefined();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail)
      .toContain("remained truncated after 8 model call(s)");

    unsubscribe();
    runtime.dispose();
  });

  it("uses a numbered filename when an inferred text-write target already exists", async () => {
    const content = "# New story\n\nComplete content.\n";
    const planWriteText = vi.fn(async (request: { targetPath: string; content: string }) => {
      if (request.targetPath === "new-story.md") {
        throw new Error(
          "Text write target already exists; overwriting is not supported in v1.",
        );
      }
      return createTextWritePlan(request.targetPath);
    });
    const writeText = vi.fn(async (request: { targetPath: string; content: string }) =>
      createTextWriteResult(request.targetPath, request.content.length),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool(content),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(planWriteText.mock.calls.map(([request]) => request.targetPath)).toEqual([
      "new-story.md",
      "new-story-2.md",
    ]);
    expect(permissionSnapshot.permissionRequest?.dryRun.affectedPaths[0]?.target)
      .toContain("new-story-2.md");
    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: "new-story-2.md", content }),
      expect.any(String),
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("does not silently rename an explicit text-write target", async () => {
    const planWriteText = vi.fn(async () => {
      throw new Error(
        "Text write target already exists; overwriting is not supported in v1.",
      );
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# New story\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText: vi.fn(),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write a story and save it as notes.md", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(planWriteText).toHaveBeenCalledTimes(1);
    expect(planWriteText).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: "notes.md" }),
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.permissionRequest).toBeUndefined();

    unsubscribe();
    runtime.dispose();
  });

  it("does not preview or approve a text write when the model returns empty content", async () => {
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete: vi.fn(async () => ({ text: "   " })) },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("文本内容生成失败");
    expect(finalSnapshot.permissionRequest).toBeUndefined();
    // One contract decision plus the generation call that returned nothing.
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(2);
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("does not request write approval when the text-generation model is missing", async () => {
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.permissionRequest).toBeUndefined();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain("configured text-generation model");
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("does not request write approval when text generation rejects", async () => {
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete: vi.fn(async () => { throw new Error("model unavailable"); }) },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.permissionRequest).toBeUndefined();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("model unavailable");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(1);
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("does not revive a cancelled text write after model generation finishes", async () => {
    let resolveGeneration!: (result: { text: string }) => void;
    let markGenerationStarted!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      markGenerationStarted = resolve;
    });
    const complete = vi.fn(() => {
      markGenerationStarted();
      return new Promise<{ text: string }>((resolve) => {
        resolveGeneration = resolve;
      });
    });
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc710000\u5b57\u7684\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", {
      mode: "project",
      taskId: "task-cancelled-text-write",
    });
    await generationStarted;
    runtime.stopTask();
    await waitForStatus(snapshots, "cancelled");

    resolveGeneration({ text: `# \u8fdf\u5230\u7684\u6b63\u6587\n\n${"\u8fd9\u6bb5\u5185\u5bb9\u4e0d\u5e94\u8fdb\u5165\u5199\u5165\u9884\u89c8\u3002".repeat(1000)}` });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.status).toBe("cancelled");
    expect(finalSnapshot?.permissionRequest).toBeUndefined();
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(snapshots.some((item) => item.status === "waiting_permission")).toBe(false);

    unsubscribe();
    runtime.dispose();
  });

  it("cancels a text write during initial planning without starting content generation", async () => {
    const complete = vi.fn(async (prompt: string) => {
      if (prompt.includes("You decide the artifact contract")) {
        return { text: JSON.stringify({ format: "md", fileName: "cancelled.md", requirements: [] }) };
      }
      return { text: "# Content" };
    });
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 30,
      chatTool: { complete },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", {
      mode: "project",
      taskId: "task-cancelled-before-generation",
    });
    runtime.stopTask();
    await waitForStatus(snapshots, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(snapshots[snapshots.length - 1]?.status).toBe("cancelled");
    // Planning legitimately asks the Commander to decide the artifact contract, so
    // cancellation must prevent content generation rather than every model call.
    expect(
      complete.mock.calls.some((call) =>
        String(call[0]).includes("Fully perform the requested writing task"),
      ),
    ).toBe(false);
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("defers cancellation after native write execution starts", async () => {
    let resolveWrite!: (result: TextFileWriteResult) => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const plan = createTextWritePlan("javis-output.md");
    const writeText = vi.fn(() => {
      markWriteStarted();
      return new Promise<TextFileWriteResult>((resolve) => {
        resolveWrite = resolve;
      });
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# Complete content\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => plan,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", {
      mode: "project",
      taskId: "task-cancelled-during-native-write",
    });
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");
    await writeStarted;
    expect(runtime.getSnapshot()).toMatchObject({
      id: "task-cancelled-during-native-write",
      status: "running",
      permissionRequest: { level: "confirmed_write", status: "approved" },
    });
    expect(runtime.getSnapshot().plan).toContainEqual(
      expect.objectContaining({ id: "step-write-text", status: "running" }),
    );
    runtime.stopTask();
    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.commanderMessage).toContain("cannot be cancelled safely");
    });

    resolveWrite(createTextWriteResult("javis-output.md"));
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(finalSnapshot.title).toBe("文本文件已写入");
    expect(snapshots.some((item) =>
      item.id === "task-cancelled-during-native-write" && item.status === "cancelled"
    )).toBe(false);
    expect(finalSnapshot.verificationSummary).toContain("未独立验证");

    unsubscribe();
    runtime.dispose();
  });

  it("queues the latest request instead of replacing an active native write", async () => {
    let resolveWrite!: (result: TextFileWriteResult) => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const complete = vi.fn(async (prompt: string) => {
      if (prompt.includes("You decide the artifact contract")) {
        return { text: JSON.stringify({ format: "md", fileName: "javis-output.md", requirements: [] }) };
      }
      return { text: "# Complete content" };
    });
    const writeText = vi.fn(() => {
      markWriteStarted();
      return new Promise<TextFileWriteResult>((resolve) => {
        resolveWrite = resolve;
      });
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => createTextWritePlan("javis-output.md"),
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", {
      mode: "project",
      taskId: "task-native-write",
    });
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");
    await writeStarted;

    runtime.start("replacement question", { mode: "chat", taskId: "task-replacement" });
    runtime.start("same id replacement", { mode: "chat", taskId: "task-native-write" });

    expect(runtime.getSnapshot().id).toBe("task-native-write");
    expect(runtime.getSnapshot().status).toBe("running");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledTimes(1);

    resolveWrite(createTextWriteResult("javis-output.md"));
    await vi.waitFor(() => {
      expect(complete).toHaveBeenCalledTimes(3);
      expect(runtime.getSnapshot()).toMatchObject({
        id: "task-native-write",
        userGoal: "same id replacement",
        status: "completed",
      });
    });

    expect(snapshots.some((item) => item.id === "task-replacement")).toBe(false);

    unsubscribe();
    runtime.dispose();
  });

  it("fails and unlocks the task when native write reports cancellation", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("native write cancelled");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# Complete content\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => createTextWritePlan("javis-output.md"),
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", {
      mode: "project",
      taskId: "task-native-cancel-error",
    });
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");
    const failedSnapshot = await waitForStatus(snapshots, "failed");

    expect(failedSnapshot.logs[failedSnapshot.logs.length - 1]?.detail).toBe("native write cancelled");
    runtime.start("follow-up", { mode: "chat", taskId: "task-after-native-cancel" });
    const followUpSnapshot = await waitForStatus(snapshots, "completed");
    expect(followUpSnapshot.id).toBe("task-after-native-cancel");

    unsubscribe();
    runtime.dispose();
  });

  it("does not preview or approve incomplete long-form content after the call limit", async () => {
    const complete = vi.fn(async (
      prompt: string,
      _options?: {
        maxTokens?: number;
        useMaxOutputTokens?: boolean;
        temperature?: number;
        locale?: string;
      },
    ) => {
      if (prompt.includes("You decide the artifact contract")) {
        return { text: JSON.stringify({ format: "md", fileName: "javis-output.md", requirements: [] }) };
      }
      return { text: "\u4e0d\u8db3\u7684\u6b63\u6587" };
    });
    const planWriteText = vi.fn(async () => createTextWritePlan("javis-output.md"));
    const writeText = vi.fn(async () => createTextWriteResult("javis-output.md"));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: { complete },
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u5199\u4e00\u7bc7100000\u5b57\u7684\u5c0f\u8bf4\uff0c\u4fdd\u5b58\u4e3a md \u6587\u4ef6", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(complete).toHaveBeenCalledTimes(9);
    // The contract decision is the one call without a max-output budget; the eight
    // content calls (initial + continuations) must all keep it.
    const contentCalls = complete.mock.calls.filter(
      (call) => !String(call[0]).includes("You decide the artifact contract"),
    );
    expect(contentCalls).toHaveLength(8);
    expect(contentCalls.every((call) => call[1]?.useMaxOutputTokens === true)).toBe(true);
    expect(finalSnapshot.permissionRequest).toBeUndefined();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain("Generated content is incomplete");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(9);
    expect(planWriteText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("lets Commander plan research-backed text file writes with Research evidence before approval", async () => {
    const goal = "\u5e2e\u6211\u62c9\u53d6\u5fae\u535a\u70ed\u641c\u524d20\u7684\u6570\u636e\uff0c\u4fdd\u5b58\u4e3amd\u6587\u4ef6\uff0c\u6587\u4ef6\u540d\u4ee5\u65e5\u671f\u52a0\u5fae\u535a\u70ed\u641c\u7684\u683c\u5f0f\uff0c\u5b58\u653e\u5728\u5f53\u524d\u76ee\u5f55\u4e0b";
    const targetPath = "2026-07-09-\u5fae\u535a\u70ed\u641c.md";
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async (request) => {
      const toolNames = (request.availableTools ?? []).map((tool) => tool.name);
      expect(toolNames).toContain("trend.fetchHotList");
      expect(toolNames).toContain("file.writeText");
      return {
        title: "Weibo hot list report",
        reasoning: "Research evidence is needed before writing the markdown file.",
        steps: [
          {
            id: "fetch-weibo-hotlist",
            title: "Fetch Weibo hot list",
            assignedAgentKind: "research",
            toolName: "trend.fetchHotList",
            requiredCapabilities: ["trend_fetch"],
            dependsOn: [] as string[],
            toolInput: { provider: "weibo", limit: 20 },
            outputContextKey: "weiboHotList",
            successCriteria: "The top Weibo hot list items are collected.",
          },
          {
            id: "write-report",
            title: "Write markdown report",
            assignedAgentKind: "file",
            toolName: "file.writeText",
            requiredCapabilities: [],
            dependsOn: ["fetch-weibo-hotlist"],
            inputContextKeys: ["weiboHotList"],
            toolInput: { targetPath },
            successCriteria: "The markdown file is written from collected evidence.",
          },
        ],
      };
    });
    const navigate = vi.fn<BrowserTool["navigate"]>(async (request) => ({
      url: request.url,
      title: "Weibo",
      status: 200,
      loadState: "load",
    }));
    const getContent = vi.fn<BrowserTool["getContent"]>(async () => ({
      url: "https://weibo.com/ajax/side/hotSearch",
      title: "Weibo hot search",
      content: JSON.stringify({
        data: {
          realtime: [
            { word: "\u8bdd\u9898\u4e00", raw_hot: 123456, label_name: "\u70ed" },
            { word: "\u8bdd\u9898\u4e8c", raw_hot: 65432 },
          ],
        },
      }),
    }));
    const browserTool: BrowserTool = {
      navigate,
      getContent,
      screenshot: vi.fn(async () => ({ dataUrl: "data:image/png;base64,test", width: 1, height: 1 })),
      click: vi.fn(async (request) => ({ selector: request.selector, clicked: true })),
      type: vi.fn(async (request) => ({ selector: request.selector, typed: true, value: request.text })),
      evaluate: vi.fn(async () => ({ result: "{}", type: "json" })),
      runTest: vi.fn(async () => ({ passed: true, exitCode: 0, stdout: "", stderr: "", duration: 1 })),
    };
    const planWriteText = vi.fn(async (request: { targetPath: string; content: string }) => {
      expect(request.targetPath).toBe(targetPath);
      expect(request.content).toContain("\u8bdd\u9898\u4e00");
      expect(request.content).toContain("\u8bdd\u9898\u4e8c");
      expect(request.content).toContain("| 1 |");
      expect(request.content).not.toContain("Generated from request");
      return createTextWritePlan(request.targetPath);
    });
    const writeText = vi.fn(async (request: { targetPath: string; content: string }) =>
      createTextWriteResult(request.targetPath, request.content.length),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText,
        writeText,
      },
      browserTool,
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Unknown." })),
      },
      availableToolDescriptors: initialToolDescriptors,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start(goal, { mode: "project" });
    const permissionSnapshot = await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(commanderPlan).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalled();
    expect(planWriteText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath }),
      "write-approval-1",
      expect.stringMatching(/^task-/),
    );
    expect(permissionSnapshot.plan.map((step) => step.assignedAgentKind)).toEqual(["research", "file"]);
    expect(finalSnapshot.researchReport?.rows[0]?.claim).toContain("\u8bdd\u9898\u4e00");
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved text writes failed when execution throws", async () => {
    const plan = createTextWritePlan("reports/search.md");
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# AI news summary\n\nModel-generated content.\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => plan,
        writeText: vi.fn(async () => {
          throw new Error("Target file changed after approval.");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write the AI news summary to reports/search.md");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Text file write failed");
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe(
      "Target file changed after approval.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved text writes failed when execution tool is missing", async () => {
    const plan = createTextWritePlan("reports/search.md");
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      chatTool: createTextContentChatTool("# AI news summary\n\nModel-generated content.\n"),
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => plan,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write the AI news summary to reports/search.md");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Text file write failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe(
      "Text write execution tool is not available.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("does not route vague document organization requests to text writes", () => {
    expect(isTextWriteGoal("organize project documents")).toBe(false);
    expect(isTextWriteGoal("write the search results to reports/search.md")).toBe(true);
  });

  it("detects HTML/page create goals as text writes", () => {
    expect(isTextWriteGoal("创建一个 HTML，内容是: SVG 绘制一个鹈鹕骑自行车的 2D 动画。")).toBe(true);
    expect(isTextWriteGoal("create an HTML page with a parrot animation")).toBe(true);
    expect(isTextWriteGoal("帮我对比这两个方案")).toBe(false);
  });

  it("routes image questions to Vision Agent", async () => {
    const analyze = vi.fn(async () => ({
      description: "A chart is visible.",
      objects: ["chart"],
      answer: "This image shows a chart.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: async () => [] },
      visionTool: {
        analyze,
        describe: vi.fn(async () => ({ description: "A chart is visible." })),
        extractText: vi.fn(async () => ({ text: "", confidence: 0 })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("璇嗗埆 data:image/png;base64,abcd 杩欏紶鍥剧墖");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(analyze).toHaveBeenCalledWith({
      imagePath: "data:image/png;base64,abcd",
      question: expect.stringContaining("璇嗗埆"),
    });
    expect(finalSnapshot.commanderMessage).toBe("This image shows a chart.");
    expect(finalSnapshot.verificationSummary).toContain("Vision Agent");

    unsubscribe();
    runtime.dispose();
  });

  it("does not route vague recognition requests to Vision Agent", () => {
    expect(isVisionGoal("identify this project's issue")).toBe(false);
    expect(isVisionGoal("identify the intent of this code")).toBe(false);
    expect(isVisionGoal("identify this image")).toBe(true);
  });

  it("fails image analysis goals without an image path", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: async () => [] },
      visionTool: {
        analyze: vi.fn(async () => ({ description: "", objects: [] })),
        describe: vi.fn(async () => ({ description: "" })),
        extractText: vi.fn(async () => ({ text: "", confidence: 0 })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("identify this image");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Image analysis failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain("image path");
    expect(finalSnapshot.plan.find((step) => step.id === "step-parse-image")?.status).toBe("failed");
    expect(finalSnapshot.plan.find((step) => step.id === "step-analyze-image")?.status).toBe("skipped");
    expect(finalSnapshot.agents.find((agent) => agent.id === "agent-commander")?.status).toBe("failed");
    expect(finalSnapshot.agents.find((agent) => agent.id === "agent-vision")?.status).toBe("cancelled");

    unsubscribe();
    runtime.dispose();
  });

  it("routes vision goals through Commander DAG when Commander is available", async () => {
    const describe = vi.fn(async () => ({
      description: "A sunset over mountains.",
    }));
    const plan = vi.fn(async () => ({
      title: "Analyze image",
      reasoning: "Commander delegates image analysis to Vision Agent.",
      steps: [{
        id: "describe-image",
        title: "Describe image",
        assignedAgentKind: "vision",
        toolName: "vision.describe",
        toolInput: { imagePath: "data:image/png;base64,abcd", detail: "detailed" },
        capability: "image_describe",
        requiredCapabilities: ["image_describe"],
        dependsOn: [],
        successCriteria: "The image is described.",
      }],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: async () => [] },
      visionTool: {
        analyze: vi.fn(async () => ({ description: "", objects: [] })),
        describe,
        extractText: vi.fn(async () => ({ text: "", confidence: 0 })),
      },
      commanderTool: {
        plan,
        synthesize: vi.fn(async () => ({ message: "OK" })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("describe this image data:image/png;base64,abcd");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    // Vision goal is intercepted BEFORE Commander DAG 鈥?plan never called.
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "describe this image data:image/png;base64,abcd",
    }), expect.objectContaining({ onUsage: expect.any(Function) }));
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "data:image/png;base64,abcd" }),
    );
    expect(finalSnapshot.status).toBe("completed");
    expect(finalSnapshot.title).toBe("Analyze image");

    unsubscribe();
    runtime.dispose();
  });

  it("vision flow verifies with verifierTool when available", async () => {
    const analyze = vi.fn(async () => ({
      description: "A cat sitting on a table.",
      objects: ["cat", "table"],
      answer: "There is a cat.",
    }));
    const check = vi.fn(async () => ({
      status: "pass" as const,
      summary: "Vision result is valid and complete.",
      detail: "Analysis returned description, objects, and answer.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: async () => [] },
      visionTool: {
        analyze,
        describe: vi.fn(async () => ({ description: "" })),
        extractText: vi.fn(async () => ({ text: "", confidence: 0 })),
      },
      verifierTool: { check },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("data:image/png;base64,abcd 鍒嗘瀽杩欏紶鍥剧墖");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "step-verify-vision",
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "log", label: "Vision analysis result" }),
        ]),
      }),
    );
    expect(finalSnapshot.verificationSummary).toContain("pass");
    expect(finalSnapshot.verificationSummary).toContain("Vision result is valid");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved PDF organization failed when execution reports failures", async () => {
    const plan = createPdfPlan();
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => plan,
        executePdfOrganization: vi.fn(async (operations: PlannedPathOperation[]) => ({
          attemptedCount: operations.length,
          movedCount: 0,
          skippedCount: 0,
          failedCount: operations.length,
          results: operations.map((operation) => ({
            source: operation.source,
            target: operation.target,
            status: "failed" as const,
            message: "Move failed in test.",
          })),
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization completed with failures");
    expect(finalSnapshot.fileOrganizationExecution?.failedCount).toBe(1);
    expect(finalSnapshot.verificationSummary).toContain("failed");

    unsubscribe();
    runtime.dispose();
  });

  it("falls back to document scan for general local file goals", async () => {
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/README.md",
        modifiedAt: "1000",
        sizeBytes: 42,
        heading: "Javis",
        excerpt: "Project README",
      },
    ];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => documents),
      },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "scan-documents",
      "classify-documents",
      "verify-scan",
      "commander-synthesize",
    ]);
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("does not route general Chinese organizing language to PDF or document scan", async () => {
    const planPdfOrganization = vi.fn(async () => createPdfPlan());
    const scanMarkdownDocuments = vi.fn(async () => []);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments,
        planPdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("\u6574\u7406\u601d\u8def");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(planPdfOrganization).not.toHaveBeenCalled();
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBeTruthy();
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("routes casual Chinese chat input to general chat when available", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "Hello, I am Javis." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("浣犲ソ");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("浣犲ソ", expect.objectContaining({
      temperature: 0.7,
      locale: "zh-CN",
      systemPrompt: expect.stringContaining("不要把推测写成事实"),
      messages: [],
    }));
    expect(finalSnapshot.title).toBeTruthy();
    expect(finalSnapshot.commanderMessage).toBe("Hello, I am Javis.");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(1);
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("dispatches a confident workspace route before the chat-mode fast path", async () => {
    const routeRegistry = createRouteRegistry();
    routeRegistry.register("workspace.demo.triage", "workspace.demo.triage-flow", () => ({
      route: "workspace.demo.triage",
      score: 5,
      threshold: 4,
      signals: ["incident-triage"],
    }));
    const workflowRegistry = createWorkflowRegistry();
    const workflow: WorkbenchWorkflow = {
      id: "workspace.demo.triage-flow",
      title: "Workspace incident triage",
      triggerExamples: ["triage incident"],
      goal: "Classify incident evidence.",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "file", "verifier"],
      steps: [{
        id: "classify-documents",
        title: "Classify incident evidence",
        agentKind: "file",
        input: "Incident details",
        output: "Incident classification",
        permissionLevel: "read",
        dependsOn: [],
        canRunInParallel: false,
      }],
      currentSupport: "implemented",
      safetyNotes: ["Read-only workflow."],
    };
    workflowRegistry.register(workflow);
    const complete = vi.fn(async () => ({ text: "Chat fallback should not run." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      routeRegistry,
      workflowRegistry,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("triage incident", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const routeLog = finalSnapshot.logs.find((log) => log.title === "route_decided");
    expect(complete).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Workspace incident triage");
    expect(routeLog && JSON.parse(routeLog.detail).customRoute).toMatchObject({
      route: "workspace.demo.triage",
      workflowId: "workspace.demo.triage-flow",
      score: 5,
      threshold: 4,
    });

    unsubscribe();
    runtime.dispose();
  });

  it("keeps chat-mode safety boundaries ahead of a matching workspace route", async () => {
    const routeRegistry = createRouteRegistry();
    routeRegistry.register("workspace.demo.desktop", "workspace.demo.desktop-flow", () => ({
      route: "workspace.demo.desktop",
      score: 5,
      threshold: 4,
      signals: ["desktop-request"],
    }));
    const workflowRegistry = createWorkflowRegistry();
    workflowRegistry.register({
      id: "workspace.demo.desktop-flow",
      title: "Workspace desktop flow",
      triggerExamples: ["操控桌面打开 QQ"],
      goal: "Inspect a desktop request.",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", "file", "verifier"],
      steps: [],
      currentSupport: "implemented",
      safetyNotes: ["Read-only test workflow."],
    });
    const complete = vi.fn(async () => ({ text: "Chat fallback should not run." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      routeRegistry,
      workflowRegistry,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("操控桌面打开 QQ", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    expect(finalSnapshot.title).toBe("已拦截");
    expect(finalSnapshot.commanderMessage).toContain("聊天模式");
    expect(complete).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("blocks project workflow requests from chat mode", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "Answering as chat" }));
    const inspectProject = vi.fn(async () => ({
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
      projectTool: { inspectProject },
      shellTool: {
        runReadOnlyCommand: vi.fn(async () => ({
          command: "pnpm --version",
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(complete).not.toHaveBeenCalled();
    expect(inspectProject).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Blocked");
    expect(finalSnapshot.commanderMessage).toContain("Project / Agent mode");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual(["chat-mode-boundary"]);

    unsubscribe();
    runtime.dispose();
  });

  it("allows planning discussion in chat mode", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "Let's discuss the plan." }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("帮我讨论一下这个项目方案的利弊", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(complete).toHaveBeenCalled();
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("已回答");
    expect(finalSnapshot.commanderMessage).toBe("Let's discuss the plan.");

    unsubscribe();
    runtime.dispose();
  });

  it("allows browser-backed information lookup from chat mode", async () => {
    const searchWeb = vi.fn(async () => [
      {
        url: "https://example.test/source",
        title: "Source",
        excerpt: "Search evidence contains enough grounded source text.",
        fetchedAt: "2026-06-16T00:00:00.000Z",
        provider: "fixture",
      },
    ]);
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched source",
      excerpt: "Fetched evidence contains enough grounded source text.",
      fetchedAt: "2026-06-16T00:01:00.000Z",
      provider: "fixture",
    }));
    const complete = vi.fn(async () => ({ text: "chat fallback" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
      verifierTool: createPassingVerifierTool(),
      webTool: {
        searchWeb,
        fetchWebSource,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("用浏览器查信息：Javis 最新资料", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(complete).not.toHaveBeenCalled();
    expect(searchWeb).toHaveBeenCalledWith({
      query: "Javis 最新资料",
      maxResults: 3,
    });
    expect(fetchWebSource).toHaveBeenCalledWith({ url: "https://example.test/source" });
    expect(finalSnapshot.plan.map((step) => step.id)).not.toEqual(["chat-mode-boundary"]);
    expect(finalSnapshot.researchReport?.rows[0]?.sourceUrl).toBe("https://example.test/source");

    unsubscribe();
    runtime.dispose();
  });

  it("continues general chat with the existing task id and prior messages", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "Second answer" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("second question", {
      taskId: "task-existing",
      priorMessages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "First answer" },
      ],
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.id).toBe("task-existing");
    expect(complete).toHaveBeenCalledWith("second question", expect.objectContaining({
      temperature: 0.7,
      locale: "en",
      systemPrompt: expect.stringMatching(/prior user\/assistant messages[\s\S]*do not present guesses as facts/),
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "First answer" },
      ],
    }));
    expect(finalSnapshot.conversationMessages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "Second answer" },
    ]);

    unsubscribe();
    runtime.dispose();
  });

  it("fetches the most recent conversational URL for a short current-page question", async () => {
    const searchWeb = vi.fn(async () => []);
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Current page",
      excerpt: "The current page explains a source-backed research workflow in enough detail.",
      fetchedAt: "2026-07-26T00:00:00.000Z",
      provider: "fixture",
    }));
    const complete = vi.fn(async () => ({ text: "chat fallback" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
      webTool: { searchWeb, fetchWebSource },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("这个网页讲啥", {
      mode: "chat",
      priorMessages: [
        { role: "user", content: "先看 https://example.test/older" },
        { role: "assistant", content: "当前页面：https://example.test/current" },
      ],
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    expect(searchWeb).not.toHaveBeenCalled();
    expect(fetchWebSource).toHaveBeenCalledWith({ url: "https://example.test/current" });
    expect(complete).not.toHaveBeenCalled();
    expect(finalSnapshot.researchReport?.rows[0]?.sourceUrl).toBe("https://example.test/current");

    unsubscribe();
    runtime.dispose();
  });

  it("asks for a URL instead of searching an unresolved current-page reference", async () => {
    const searchWeb = vi.fn(async () => []);
    const fetchWebSource = vi.fn();
    const complete = vi.fn(async () => ({ text: "chat fallback" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
      webTool: { searchWeb, fetchWebSource },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("这个网页讲啥", { mode: "chat" });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    expect(searchWeb).not.toHaveBeenCalled();
    expect(fetchWebSource).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("需要网页链接");
    expect(finalSnapshot.commanderMessage).toContain("网页链接");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps cumulative usage when a follow-up reuses the same task id", async () => {
    const complete = vi.fn(async () => complete.mock.calls.length === 1
      ? {
          text: "First answer",
          tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        }
      : {
          text: "Second answer",
          tokenUsage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
        });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("first question", { mode: "chat", taskId: "task-continued" });
    const first = await waitForStatus(snapshots, "completed");
    expect(first.tokenUsage).toMatchObject({ totalTokens: 12, modelCalls: 1 });

    const followUpStart = snapshots.length;
    runtime.start("second question", {
      mode: "chat",
      taskId: "task-continued",
      priorMessages: first.conversationMessages,
    });
    const second = await waitForStatus(snapshots, "completed");

    const followUpSnapshots = snapshots.slice(followUpStart)
      .filter((snapshot) => snapshot.id === "task-continued");
    expect(followUpSnapshots.length).toBeGreaterThan(0);
    expect(followUpSnapshots.every((snapshot) =>
      (snapshot.tokenUsage?.totalTokens ?? 0) >= 12 &&
      (snapshot.tokenUsage?.modelCalls ?? 0) >= 1
    )).toBe(true);
    expect(second.tokenUsage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      modelCalls: 2,
    });

    unsubscribe();
    runtime.dispose();
  });

  it("records usage from a model call that fails after returning usage", async () => {
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async (_request, observer) => {
      observer?.onUsage?.({
        inputTokens: 40,
        outputTokens: 6,
        totalTokens: 46,
      });
      throw new Error("planner response was invalid");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      commanderTool: { plan: commanderPlan },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect the project", { mode: "project", taskId: "task-failed-usage" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.tokenUsage).toMatchObject({
      inputTokens: 40,
      outputTokens: 6,
      totalTokens: 46,
      modelCalls: 1,
    });

    unsubscribe();
    runtime.dispose();
  });

  it("windows long chat context for the model while preserving the full conversation timeline", async () => {
    let prompt = "";
    let options: { systemPrompt?: string; messages?: Array<{ role: "user" | "assistant"; content: string }> } | undefined;
    const priorMessages = Array.from({ length: 130 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "oldest-message-should-be-omitted" : `message-${index}`,
    }));
    const complete = vi.fn(async (nextPrompt: string, nextOptions?: typeof options) => {
      prompt = nextPrompt;
      options = nextOptions;
      return { text: "Answer after long context" };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue the thread", {
      mode: "chat",
      taskId: "task-long-chat",
      priorMessages,
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(prompt).toBe("continue the thread");
    // P1-7: the omission notice rides as a trailing message; the chat system
    // prompt stays byte-stable for the whole session.
    expect(options?.systemPrompt).not.toContain("earlier message(s) were omitted");
    expect(options?.messages?.[options.messages.length - 1]?.content).toContain(
      "10 earlier message(s) were omitted",
    );
    expect(options?.messages?.[options.messages.length - 2]?.content).toBe("message-129");
    expect(options?.messages?.some((message) => message.content === "oldest-message-should-be-omitted")).toBe(false);
    expect(finalSnapshot.conversationMessages).toHaveLength(132);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("oldest-message-should-be-omitted");
    expect(finalSnapshot.conversationMessages?.[130]).toEqual({
      role: "user",
      content: "continue the thread",
    });

    unsubscribe();
    runtime.dispose();
  });

  it("passes a normal-sized turn through unchanged", async () => {
    let prompt = "";
    const complete = vi.fn(async (nextPrompt: string) => {
      prompt = nextPrompt;
      return { text: "ok" };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextWindowTokens: 32_000 },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("解释一下这个函数的作用", { mode: "chat", taskId: "task-normal-turn" });
    await waitForStatus(snapshots, "completed");

    expect(prompt).toBe("解释一下这个函数的作用");

    unsubscribe();
    runtime.dispose();
  });

  it("recovers general chat from context overflow with summary plus recent messages", async () => {
    let recoveredMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    let recoveredProbeKey: string | undefined;
    let summaryCallOptions: {
      systemPrompt?: string;
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    } | undefined;
    const priorMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "old-raw-detail-should-be-summarized" : `context-message-${index}`,
    }));
    const complete = vi.fn(async (
      nextPrompt: string,
      options?: {
        messages?: Array<{ role: "user" | "assistant"; content: string }>;
        systemPrompt?: string;
        cacheProbeKey?: string;
      },
    ) => {
      if (complete.mock.calls.length === 1) {
        throw new Error("maximum context length exceeded");
      }
      if (nextPrompt.includes("Summarize this earlier Javis conversation")) {
        // P1-8: the summary call must warm-replay the same system prompt and
        // the earlier window turns instead of re-framing them as inline data.
        summaryCallOptions = options;
        return { text: "- Earlier discussion established a stable API constraint." };
      }
      recoveredMessages = options?.messages ?? [];
      recoveredProbeKey = options?.cacheProbeKey;
      return { text: "Recovered answer" };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue after overflow", {
      mode: "chat",
      taskId: "task-chat-context-recovery",
      priorMessages,
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(complete).toHaveBeenCalledTimes(3);
    expect(summaryCallOptions?.systemPrompt).toContain("You are Javis");
    expect(summaryCallOptions?.messages?.some((message) => message.content === "old-raw-detail-should-be-summarized")).toBe(true);
    expect(summaryCallOptions?.messages?.some((message) => message.content === "context-message-13")).toBe(false);
    // P1-9: the recovered conversation starts a fresh probe scope so the
    // expected compaction break does not surface as a diagnostic.
    expect(recoveredProbeKey).toBe("chat:task-chat-context-recovery:recovered");
    expect(recoveredMessages[0]?.content).toContain("Earlier conversation summary:");
    expect(recoveredMessages[0]?.content).toContain("stable API constraint");
    expect(recoveredMessages.some((message) => message.content === "context-message-13")).toBe(true);
    expect(recoveredMessages.some((message) => message.content.includes("old-raw-detail-should-be-summarized"))).toBe(false);
    expect(finalSnapshot.commanderMessage).toBe("Recovered answer");
    expect(finalSnapshot.conversationMessages).toHaveLength(16);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("old-raw-detail-should-be-summarized");

    unsubscribe();
    runtime.dispose();
  });

  it("does not recover general chat for non-context model errors", async () => {
    const complete = vi.fn(async () => {
      throw new Error("provider offline");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("fail normally", {
      mode: "chat",
      taskId: "task-chat-non-context-error",
      priorMessages: [{ role: "user", content: "previous" }],
    });

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(finalSnapshot.logs.some((log) => log.detail.includes("provider offline"))).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("uses the short context strategy for model prompts without truncating the timeline", async () => {
    let prompt = "";
    let options: { systemPrompt?: string; messages?: Array<{ role: "user" | "assistant"; content: string }> } | undefined;
    const priorMessages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "short-context-oldest-message" : `short-message-${index}`,
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextStrategy: "short" },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: {
        complete: vi.fn(async (nextPrompt: string, nextOptions?: typeof options) => {
          prompt = nextPrompt;
          options = nextOptions;
          return { text: "Short context answer" };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue briefly", {
      mode: "chat",
      taskId: "task-short-context",
      priorMessages,
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(prompt).toBe("continue briefly");
    expect(options?.systemPrompt).not.toContain("earlier message(s) were omitted");
    expect(options?.messages?.[options.messages.length - 1]?.content).toContain(
      "10 earlier message(s) were omitted",
    );
    expect(options?.messages?.[options.messages.length - 2]?.content).toBe("short-message-49");
    expect(options?.messages?.some((message) => message.content === "short-context-oldest-message")).toBe(false);
    expect(finalSnapshot.conversationMessages).toHaveLength(52);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("short-context-oldest-message");

    unsubscribe();
    runtime.dispose();
  });

  it("caps an individual history message to a small model context budget", async () => {
    let modelMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextStrategy: "long", contextWindowTokens: 1_024 },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: {
        complete: vi.fn(async (_prompt, options) => {
          modelMessages = options?.messages ?? [];
          return { text: "bounded" };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue", {
      mode: "chat",
      priorMessages: [{ role: "user", content: "中".repeat(2_000) }],
    });

    await waitForStatus(snapshots, "completed");

    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0]?.content).toContain(" ... ");
    expect([...(modelMessages[0]?.content ?? "")].length).toBeLessThanOrEqual(819);

    unsubscribe();
    runtime.dispose();
  });

  it("does not admit an over-budget newest message for a one-token context", async () => {
    let modelMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextStrategy: "long", contextWindowTokens: 1 },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: {
        complete: vi.fn(async (_prompt, options) => {
          modelMessages = options?.messages ?? [];
          return { text: "bounded" };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue", {
      mode: "chat",
      priorMessages: [{ role: "user", content: "oversized history" }],
    });

    await waitForStatus(snapshots, "completed");

    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0]?.content).toBe("o");

    unsubscribe();
    runtime.dispose();
  });

  it("drops an assistant reply when its user turn falls outside the context window", async () => {
    let modelMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextStrategy: "long", contextWindowTokens: 16 },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: {
        complete: vi.fn(async (_prompt, options) => {
          modelMessages = options?.messages ?? [];
          return { text: "bounded" };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue", {
      mode: "chat",
      priorMessages: [
        { role: "user", content: "u".repeat(100) },
        { role: "assistant", content: "orphaned reply" },
      ],
    });

    await waitForStatus(snapshots, "completed");

    // P1-7: the per-turn omission notice rides as the only history item;
    // the orphaned assistant reply itself stays out of the window.
    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0]?.content).toContain("2 earlier message(s) were omitted");

    unsubscribe();
    runtime.dispose();
  });

  it("passes windowed follow-up context into Commander DAG planning", async () => {
    const priorMessages = Array.from({ length: 130 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "oldest-project-message" : `project-message-${index}`,
    }));
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Follow-up plan",
      reasoning: "Use context from the existing task.",
      steps: [{
        id: "answer-follow-up",
        title: "Answer the follow-up",
        assignedAgentKind: "commander",
        executionMode: "direct_response" as const,
        dependsOn: [] as string[],
        successCriteria: "The follow-up is answered.",
      }],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the direct answer." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("continue that project task", {
      mode: "project",
      taskId: "task-project-context",
      priorMessages,
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const planRequest = commanderPlan.mock.calls[0]?.[0];

    expect(planRequest?.priorMessages).toHaveLength(120);
    expect(planRequest?.omittedPriorMessageCount).toBe(10);
    expect(planRequest?.priorMessages?.[0]?.content).toBe("project-message-10");
    expect(planRequest?.priorMessages?.[planRequest.priorMessages.length - 1]?.content).toBe("project-message-129");
    expect(finalSnapshot.conversationMessages).toHaveLength(132);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("oldest-project-message");

    unsubscribe();
    runtime.dispose();
  });

  it("recovers Commander DAG planning from context overflow with localized summary plus recent messages", async () => {
    const priorMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "old-project-detail-should-be-summarized" : `project-context-${index}`,
    }));
    const summarize = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("请压缩总结下面这段较早的 Javis 对话");
      return { text: "- Earlier project context requires preserving audit logs." };
    });
    const commanderPlan = vi.fn<CommanderTool["plan"]>(async () => {
      if (commanderPlan.mock.calls.length === 1) {
        throw new Error("prompt is too long for context length");
      }
      return {
        title: "Recovered follow-up plan",
        reasoning: "Use recovered context.",
        steps: [{
          id: "answer-follow-up",
          title: "Answer the follow-up",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          dependsOn: [] as string[],
          successCriteria: "The follow-up is answered.",
        }],
      };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete: summarize },
      commanderTool: {
        plan: commanderPlan,
        synthesize: vi.fn(async () => ({ message: "Here is the direct answer." })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("继续这个项目任务并保留上下文", {
      mode: "project",
      taskId: "task-project-context-recovery",
      priorMessages,
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const recoveredRequest = commanderPlan.mock.calls[1]?.[0];

    expect(commanderPlan).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(recoveredRequest?.omittedPriorMessageCount).toBe(0);
    expect(recoveredRequest?.priorMessages?.[0]?.content).toContain("Earlier conversation summary:");
    expect(recoveredRequest?.priorMessages?.[0]?.content).toContain("preserving audit logs");
    expect(recoveredRequest?.priorMessages?.some((message) => message.content === "project-context-13")).toBe(true);
    expect(recoveredRequest?.priorMessages?.some((message) => message.content === "old-project-detail-should-be-summarized")).toBe(false);
    expect(finalSnapshot.conversationMessages).toHaveLength(16);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("old-project-detail-should-be-summarized");

    unsubscribe();
    runtime.dispose();
  });

  it("strips inline image data attachments from runtime conversation snapshots", async () => {
    const complete = vi.fn(async () => ({ text: "done" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("describe this", {
      mode: "chat",
      displayAttachments: ["data:image/png;base64,AA=="],
      modelImages: ["data:image/png;base64,AA=="],
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.conversationMessages?.[0]?.attachments).toBeUndefined();
    expect(complete).toHaveBeenCalledWith("describe this", expect.objectContaining({
      images: ["data:image/png;base64,AA=="],
    }));

    unsubscribe();
    runtime.dispose();
  });

  it("continues workflow tasks with the existing task id and prior messages", async () => {
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/README.md",
        modifiedAt: "2026-05-25T00:00:00.000Z",
        sizeBytes: 100,
        heading: "Javis",
        excerpt: "README",
      },
    ];
    const scanMarkdownDocuments = vi.fn(async () => documents);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments,
        classifyDocuments: vi.fn(async () => []),
      },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents", {
      taskId: "task-existing",
      priorMessages: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "First result" },
      ],
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.id).toBe("task-existing");
    expect(finalSnapshot.conversationMessages).toEqual([
      { role: "user", content: "first request" },
      { role: "assistant", content: "First result" },
      { role: "user", content: "Find Markdown documents" },
      {
        role: "assistant",
        content: "Scan workspace documents completed.",
      },
    ]);

    unsubscribe();
    runtime.dispose();
  });

  it("marks general chat failed when the configured model is unavailable", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => {
      throw new Error("missing model settings");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("how do I start this?");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
    expect(finalSnapshot.commanderMessage).toBeTruthy();
    // E2 changed this deliberately: the old message was the generic
    // "model request failed". The classification now names the cause and the fix,
    // which is the whole point of the change.
    expect(finalSnapshot.userFacingError).toContain("No model is configured");
    // E2b: the message says what broke; the guidance says what to do about it, and the
    // failure surface renders those actions as buttons.
    expect(finalSnapshot.failureGuidance).toBeDefined();
    expect(finalSnapshot.failureGuidance?.actions.length).toBeGreaterThan(0);
    expect(finalSnapshot.failureGuidance?.kind).toBe("model_unconfigured");
    expect(finalSnapshot.failureGuidance?.actions).toContain("open_settings");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain(
      "missing model settings",
    );
    expect(finalSnapshot.status).toBe("failed");

    unsubscribe();
    runtime.dispose();
  });

  it("scans documents for explicit Chinese document scan goal", async () => {
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/README.md",
        modifiedAt: "2026-05-25T00:00:00.000Z",
        sizeBytes: 100,
        heading: "Javis",
        excerpt: "README",
      },
    ];
    const scanMarkdownDocuments = vi.fn(async () => documents);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan workspace documents");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(scanMarkdownDocuments).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Scan workspace documents");
    expect(finalSnapshot.plan.map((step) => [step.id, step.status])).toEqual([
      ["scan-documents", "completed"],
      ["classify-documents", "completed"],
      ["verify-scan", "completed"],
      ["commander-synthesize", "completed"],
    ]);

    unsubscribe();
    runtime.dispose();
  });

  it("includes the fix plan and conversation-first architecture docs in document scan results", async () => {
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/docs/JAVIS_FIX_PLAN.md",
        modifiedAt: "2026-06-07T00:00:00.000Z",
        sizeBytes: 48_000,
        heading: "Javis Fix Plan",
        excerpt: "Phase 1/2/3 stability, timeline, productization, and interaction quality plan.",
      },
      {
        path: "E:/Javis/docs/JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md",
        modifiedAt: "2026-06-07T00:00:00.000Z",
        sizeBytes: 32_000,
        heading: "Javis Conversation-first Agent Architecture",
        excerpt: "Conversation-first routing with L1 direct chat, L2 single agent, and L3 Commander DAG.",
      },
    ];
    const scanMarkdownDocuments = vi.fn(async () => documents);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      verifierTool: createPassingVerifierTool(),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents");

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const documentSnapshot = snapshots.find((snapshot) => snapshot.documents?.length === 2);

    expect(scanMarkdownDocuments).toHaveBeenCalledOnce();
    expect(documentSnapshot?.documents?.map((document) => document.path)).toEqual([
      "E:/Javis/docs/JAVIS_FIX_PLAN.md",
      "E:/Javis/docs/JAVIS_CONVERSATION_FIRST_ARCHITECTURE.md",
    ]);
    expect(documentSnapshot?.documents?.map((document) => document.heading)).toEqual([
      "Javis Fix Plan",
      "Javis Conversation-first Agent Architecture",
    ]);
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("marks document scan failed when the file tool rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => {
          throw new Error("scan failed");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Scan workspace documents");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("scan failed");

    unsubscribe();
    runtime.dispose();
  });

  it("completes PDF organization as a no-op when no PDFs are found", async () => {
    const executePdfOrganization = vi.fn(async () => createExecution([]));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => ({
          approvalId: "approval-empty",
          directoryPath: "C:/Users/example/Downloads",
          fileCount: 0,
          dryRun: {
            operation: "Organize PDF files by filename topic",
            affectedPaths: [],
            riskSummary: "Preview only.",
            reversible: true,
          },
        }),
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).not.toHaveBeenCalled();
    expect(finalSnapshot.fileOrganizationPlan?.fileCount).toBe(0);
    expect(finalSnapshot.verificationSummary).toContain("no PDF files were found");

    unsubscribe();
    runtime.dispose();
  });

  it("marks PDF preview failed when the dry-run tool rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: vi.fn(async () => {
          throw new Error("preview failed");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization preview failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("preview failed");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved PDF organization failed when execution tool is missing", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => createPdfPlan(),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization execution unavailable");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe(
      "file.executePdfOrganization is not configured.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("builds source-backed reports for user-provided research URLs", async () => {
    const sources: Record<string, WebSource> = {
      "https://example.test/alpha": {
        url: "https://example.test/alpha",
        title: "Alpha source",
        excerpt: "Alpha evidence excerpt.",
        fetchedAt: "2026-05-23T00:00:00.000Z",
      },
      "https://example.test/beta": {
        url: "https://example.test/beta",
        title: "Beta source",
        excerpt: "Beta evidence excerpt.",
        fetchedAt: "2026-05-23T00:00:00.000Z",
      },
    };
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => sources[url] as WebSource);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/alpha and https://example.test/beta");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(fetchWebSource).toHaveBeenCalledTimes(2);
    expect(finalSnapshot.researchReport?.rows).toHaveLength(2);
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "Only 2 source(s) were provided; the MVP scenario expects at least 3 for a full comparison report.",
    );
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "No search provider was used because source URLs were provided directly.",
    );
    expect(finalSnapshot.verificationSummary).toContain("report claims include source evidence");

    unsubscribe();
    runtime.dispose();
  });

  it("builds source-backed reports from configured search results", async () => {
    const sourceUrls = [
      "https://example.test/alpha",
      "https://example.test/beta",
      "https://example.test/gamma",
    ];
    const searchWeb = vi.fn(async () =>
      sourceUrls.map((url, index) => ({
        url,
        title: `Search result ${index + 1}`,
        excerpt: `Search excerpt ${index + 1}.`,
        fetchedAt: "2026-05-23T00:00:00.000Z",
        provider: "test-search",
      })),
    );
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: `Fetched ${url}`,
      excerpt: `Fetched evidence for ${url}.`,
      fetchedAt: "2026-05-23T00:00:00.000Z",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
        searchWeb,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research Javis search integration");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(searchWeb).toHaveBeenCalledWith({
      query: "Research Javis search integration",
      maxResults: 3,
    });
    expect(fetchWebSource).toHaveBeenCalledTimes(3);
    expect(finalSnapshot.researchReport?.rows).toHaveLength(3);
    expect(finalSnapshot.researchReport?.summary).toContain("via test-search");
    expect(finalSnapshot.researchReport?.summary).toContain("compares the available sources");
    expect(finalSnapshot.researchReport?.unknowns).not.toContain(
      "Automated public web search is not integrated yet; add URLs manually for broader coverage.",
    );
    expect(finalSnapshot.sources?.map((source) => source.provider)).toEqual([
      "test-search",
      "test-search",
      "test-search",
    ]);
    expect(finalSnapshot.verificationSummary).toContain("searched sources include URL and excerpt");

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when no sources are found", async () => {
    const fetchWebSource = vi.fn(async () => {
      throw new Error("fetch should not run");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
        searchWeb: vi.fn(async () => []),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research a topic with no public sources");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research search returned no sources");
    expect(fetchWebSource).not.toHaveBeenCalled();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain("0 source");

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when the search provider rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          excerpt: "unused",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
        searchWeb: vi.fn(async () => {
          throw new Error("search unavailable");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Search for public sources about Javis");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research search failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("search unavailable");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps successful searched sources when one fetch fails", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/alpha",
            title: "Alpha",
            excerpt: "Alpha candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "github-cli",
          },
          {
            url: "https://example.test/missing",
            title: "Missing",
            excerpt: "Missing candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "github-cli",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => {
          if (url.includes("missing")) {
            throw new Error("source unavailable");
          }
          return {
            url,
            title: "Alpha source",
            excerpt: "Alpha fetched evidence.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
          };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research partial source failures");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.sources).toHaveLength(1);
    expect(finalSnapshot.sources?.[0]?.provider).toBe("github-cli");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 searched source candidate(s) could not be fetched.",
    );
    expect(finalSnapshot.logs.some((log) => log.title.includes("web.fetchSource failed"))).toBe(true);
    expect(finalSnapshot.verificationSummary).toContain("1 searched source fetch(es) failed");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps fetched provider metadata when search candidates omit provider", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/alpha",
            title: "Alpha",
            excerpt: "Alpha candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Alpha source",
          excerpt: "Alpha fetched evidence.",
          fetchedAt: "2026-05-23T00:00:00.000Z",
          provider: "agent-chrome",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research provider fallback");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.sources?.[0]?.provider).toBe("agent-chrome");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "Only 1 source(s) were fetched from search results; product research expects at least 3 for a full comparison report.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when searched sources lack excerpt evidence", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/weak",
            title: "Weak",
            excerpt: "Weak candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "agent-chrome",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Weak source",
          excerpt: "",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research weak searched sources");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source verification failed");
    expect(finalSnapshot.sources?.[0]?.provider).toBe("agent-chrome");
    expect(finalSnapshot.researchReport?.summary).toContain("via agent-chrome");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 source(s) did not return enough text evidence.",
    );
    expect(finalSnapshot.verificationSummary).toContain("failed: 0/1 searched sources");

    unsubscribe();
    runtime.dispose();
  });

  it("marks research source collection failed when a provided URL cannot be fetched", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async () => {
          throw new Error("source unavailable");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/missing");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source collection failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("source unavailable");

    unsubscribe();
    runtime.dispose();
  });

  it("marks research verification failed when fetched sources lack excerpt evidence", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Weak source",
          excerpt: "",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/weak");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source verification failed");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 source(s) did not return enough text evidence.",
    );
    expect(finalSnapshot.verificationSummary).toContain("failed: 0/1 sources");

    unsubscribe();
    runtime.dispose();
  });

  // P0-1/P0-4 Commander DAG: askUser and replan tests

  it("surfaces Commander-to-sub-agent dispatch in project-mode conversation snapshots", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Scan files",
      reasoning: "Commander will delegate file scanning.",
      steps: [{
        id: "scan-files",
        title: "Scan project documents",
        assignedAgentKind: "file",
        toolName: "file.scanMarkdownDocuments",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"] as string[],
        dependsOn: [] as string[],
        executionMode: "direct_tool_call" as const,
        successCriteria: "Documents are scanned.",
      }],
    }));
    const scanDocs = vi.fn(async () => [{
      path: "E:/Javis/README.md",
      modifiedAt: "2026-06-10T00:00:00.000Z",
      sizeBytes: 100,
      heading: "Javis",
      excerpt: "Project readme.",
    }]);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan the project documents", {
      mode: "project",
      taskId: "task-project-dispatch-visible",
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const dispatchSnapshot = snapshots.find((snapshot) =>
      snapshot.commanderMessage.includes("Commander dispatched: File Agent") &&
      snapshot.logs.some((log) =>
        log.agentId === "agent-file" &&
        log.userMessage?.includes("Queued by Commander"),
      ),
    );

    expect(finalSnapshot.status).toBe("completed");
    expect(dispatchSnapshot).toBeDefined();
    expect(dispatchSnapshot?.conversationMessages?.some((message) =>
      message.role === "user" &&
      message.content === "scan the project documents",
    )).toBe(true);
    expect(dispatchSnapshot?.agents.find((agent) => agent.id === "agent-file")?.status).toBe("queued");

    unsubscribe();
    runtime.dispose();
  });

  it("handles askUser as the only step by recursing with clarification", async () => {
    // Phase 1: Commander returns an askUser-only plan.
    // Phase 1.5: askUser fires, answer triggers recursive call.
    // The recursive call's Commander returns a capability-tagged plan.
    let planCallCount = 0;
    const commanderPlan = vi.fn(async () => {
      planCallCount += 1;
      if (planCallCount === 1) {
        return {
          title: "Clarification needed",
          reasoning: "Goal is ambiguous.",
          steps: [{
            id: "ask",
            title: "What file?",
            assignedAgentKind: "commander",
            toolName: "commander.askUser",
            requiredCapabilities: [],
            dependsOn: [],
            successCriteria: "Clarified.",
          }],
        };
      }
      return {
        title: "Scan after clarification",
        reasoning: "User clarified the file path.",
        steps: [{
          id: "scan",
          title: "Scan files",
          assignedAgentKind: "file",
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Documents scanned.",
        }],
      };
    });
    const scanDocs = vi.fn(async () => [{
      path: "E:/test/README.md",
      modifiedAt: "2026-05-31T00:00:00.000Z",
      sizeBytes: 100,
      heading: "Test",
      excerpt: "A test file.",
    }]);
    const appendedEnvelopes: Array<import("./runtime-event-envelope").RuntimeEventEnvelope> = [];
    const savedCheckpoints: Array<import("./workflow-checkpoint").WorkflowCheckpoint> = [];

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
      runtimeEventSink: {
        append: async (envelope) => {
          appendedEnvelopes.push(envelope);
        },
      },
      checkpointSink: {
        save: async (checkpoint) => {
          savedCheckpoints.push(checkpoint);
        },
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan that file");

    // After the first plan, askUser should fire
    await vi.waitFor(() => {
      expect(snapshots.some((s) => s.askUserQuestion?.question === "What file?")).toBe(true);
    });

    // Answer the question to trigger the recursive re-plan
    const askSnapshot = snapshots.find((s) => s.askUserQuestion?.id);
    expect(askSnapshot).toBeDefined();
    const askQuestionId = askSnapshot!.askUserQuestion!.id;
    expect(askSnapshot?.conversationMessages?.some((message) =>
      message.kind === "ask_user_question" &&
      message.askUserQuestion?.id === askQuestionId
    )).toBe(true);
    runtime.respondToAskUser("E:/test", askQuestionId);

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const finalMessages = finalSnapshot.conversationMessages ?? [];
    const answeredQuestionMessage = finalMessages.find((message) =>
      message.kind === "ask_user_question" &&
      message.askUserQuestion?.id === askQuestionId
    );

    expect(planCallCount).toBe(2);
    expect(finalSnapshot.title).toBe("Scan after clarification");
    expect(finalSnapshot.status).toBe("completed");
    expect(answeredQuestionMessage?.askUserQuestion?.status).toBe("answered");
    expect(answeredQuestionMessage?.askUserQuestion?.answer).toBe("E:/test");
    expect(answeredQuestionMessage?.askUserQuestion?.resolvedAt).toBeDefined();
    expect(finalMessages.filter((message) =>
      message.role === "user" &&
      message.content === "E:/test"
    )).toHaveLength(1);
    expect(finalMessages[finalMessages.length - 1]).toMatchObject({
      role: "assistant",
    });
    expect(finalMessages[finalMessages.length - 2]).toMatchObject({
      role: "user",
      content: "E:/test",
    });
    const logs = snapshots.flatMap((snapshot) => snapshot.logs);
    expect(logs.some((log) => log.title === "waiting_model" && log.detail.includes("commander.plan"))).toBe(true);
    expect(logs.some((log) => log.title === "waiting_user" && log.detail.includes("askUser"))).toBe(true);
    expect(logs.some((log) => log.title === "waiting_tool" && log.detail.includes("tool dispatch scan"))).toBe(true);
    expect(appendedEnvelopes.some((envelope) =>
      (envelope.payload as { kind?: string }).kind === "ask_user.responded"
    )).toBe(true);
    expect(appendedEnvelopes.some((envelope) =>
      (envelope.payload as { kind?: string; stepId?: string }).kind === "step.completed" &&
      (envelope.payload as { stepId?: string }).stepId === "scan"
    )).toBe(true);
    expect(savedCheckpoints.some((checkpoint) =>
      checkpoint.workflowSnapshot.steps.some((step) => step.id === "scan")
    )).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("handles askUser with dependencies via inline Phase 2 handling", async () => {
    // Commander plan: file_scan -> commander.askUser (depends on file_scan).
    // Phase 1.5 skips askUser (dependsOn not empty).
    // Phase 2: file_scan executes, then askUser fires inline.
    const commanderPlan = vi.fn(async () => ({
      title: "Scan then ask",
      reasoning: "Scan first, then clarify.",
      steps: [
        {
          id: "scan",
          title: "Scan files",
          assignedAgentKind: "file",
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Documents scanned.",
        },
        {
          id: "ask",
          title: "Which file to use?",
          assignedAgentKind: "commander",
          toolName: "commander.askUser",
          requiredCapabilities: [],
          dependsOn: ["scan"] as string[],
          successCriteria: "Clarified.",
        },
      ],
    }));
    const scanDocs = vi.fn(async () => [{
      path: "E:/test/a.md",
      modifiedAt: "2026-05-31T00:00:00.000Z",
      sizeBytes: 50,
      heading: "A",
      excerpt: "File A.",
    }]);

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("scan then pick one");

    // scan step should complete, then askUser fires
    await vi.waitFor(() => {
      const hasAskUser = snapshots.some((s) => s.askUserQuestion?.question === "Which file to use?");
      const scanCompleted = snapshots.some((s) =>
        s.plan.some((p) => p.id === "scan" && p.status === "completed"),
      );
      expect(hasAskUser).toBe(true);
      expect(scanCompleted).toBe(true);
    });

    // Answer the question
    const askSnapshot = snapshots.find((s) => s.askUserQuestion?.id);
    runtime.respondToAskUser("a.md", askSnapshot!.askUserQuestion!.id);

    const finalSnapshot = await waitForStatus(snapshots, "completed");
    const finalMessages = finalSnapshot.conversationMessages ?? [];

    expect(finalSnapshot.status).toBe("completed");
    expect(finalSnapshot.plan.every((s) => s.status === "completed")).toBe(true);
    expect(finalMessages.filter((message) =>
      message.role === "user" &&
      message.content === "a.md"
    )).toHaveLength(1);

    unsubscribe();
    runtime.dispose();
  });

  it("recovers from step failure via Commander replan", async () => {
    // Commander plan: step that fails -> replan generates recovery step.
    const commanderPlan = vi.fn(async () => ({
      title: "Test plan",
      reasoning: "Test.",
      steps: [{
        id: "bad-step",
        title: "This will fail",
        assignedAgentKind: "file",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"] as string[],
        dependsOn: [] as string[],
        successCriteria: "Should fail.",
      }],
    }));
    const scanDocs = vi.fn(async () => {
      throw new Error("Scan failed: permission denied");
    });
    const scanUserDocs = vi.fn(async () => {
      throw new Error("Fallback scan failed: permission denied");
    });

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: {
        scanMarkdownDocuments: scanDocs,
        scanUserDocuments: scanUserDocs,
      },
      replanDag: vi.fn(async () => ({
        title: "Recovery plan",
        reasoning: "Try alternative.",
        steps: [{
          id: "recovery-step",
          title: "Scan with different approach",
          assignedAgentKind: "file",
          toolName: "file.scanUserDocuments",
          toolInput: { query: "markdown" },
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Scan retried.",
        }],
      })),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test failure replan");

    // Task will fail because the alternative recovery scan also throws,
    // but the replan itself should be visible in logs before final failure.
    await vi.waitFor(() => {
      const hasReplanLog = snapshots.some((s) =>
        s.logs.some((l) => l.detail?.includes("Recovery for bad-step")),
      );
      expect(hasReplanLog).toBe(true);
    });

    const finalSnapshot = snapshots[snapshots.length - 1]!;
    const replanLog = finalSnapshot.logs.find(
      (l) => l.detail?.includes("Recovery for bad-step"),
    );
    expect(replanLog).toBeDefined();
    expect(finalSnapshot.logs.some((log) => log.title === "replan_started")).toBe(true);
    expect(finalSnapshot.logs.some((log) => log.title === "waiting_model" && log.detail.includes("commander.replan"))).toBe(true);

    unsubscribe();
    runtime.dispose();
  });

  it("stops on step failure when runtime failure recovery is disabled", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "No recovery",
      reasoning: "Stop on failure.",
      steps: [{
        id: "bad-step",
        title: "This will fail",
        assignedAgentKind: "file",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"] as string[],
        dependsOn: [] as string[],
        successCriteria: "Should fail.",
      }],
    }));
    const scanDocs = vi.fn(async () => {
      throw new Error("Scan failed: permission denied");
    });
    const replanDag = vi.fn(async () => ({
      title: "Recovery plan",
      reasoning: "Should not be used.",
      steps: [{
        id: "recovery-step",
        title: "Scan with different approach",
        assignedAgentKind: "file",
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"] as string[],
        dependsOn: [] as string[],
        successCriteria: "Scan retried.",
      }],
    }));

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { failureRecoveryEnabled: false },
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
      replanDag,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test no failure replan", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(replanDag).not.toHaveBeenCalled();
    expect(finalSnapshot.logs.some((log) => log.title === "replan_started")).toBe(false);
    expect(finalSnapshot.logs.some((log) => log.detail?.includes("Recovery for bad-step"))).toBe(false);

    unsubscribe();
    runtime.dispose();
  });

  it("expires askUser waits using the runtime user-wait timeout", async () => {
    vi.useFakeTimers();
    const commanderPlan = vi.fn(async () => ({
      title: "Clarification needed",
      reasoning: "Goal is ambiguous.",
      steps: [{
        id: "ask",
        title: "What file?",
        assignedAgentKind: "commander",
        toolName: "commander.askUser",
        requiredCapabilities: [],
        dependsOn: [] as string[],
        successCriteria: "Clarified.",
      }],
    }));

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { userWaitTimeoutMs: 60_000 },
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    try {
      runtime.start("scan that file", { mode: "project" });

      await waitForStatus(snapshots, "waiting_info");
      await vi.advanceTimersByTimeAsync(60_000);
      const finalSnapshot = await waitForStatus(snapshots, "failed");

      expect(finalSnapshot.askUserQuestion).toBeUndefined();
      expect(finalSnapshot.logs.some((log) =>
        log.title === "timeout" &&
        log.detail.includes("60000ms")
      )).toBe(true);
    } finally {
      unsubscribe();
      runtime.dispose();
      vi.useRealTimers();
    }
  });
});

function createPdfPlan(): FileOrganizationPlan {
  return {
    approvalId: "approval-1",
    directoryPath: "C:/Users/example/Downloads",
    fileCount: 1,
    dryRun: {
      operation: "Organize PDF files by filename topic",
      affectedPaths: [
        {
          source: "C:/Users/example/Downloads/paper.pdf",
          target: "C:/Users/example/Downloads/Research/paper.pdf",
          action: "move",
        },
      ],
      riskSummary: "Preview only.",
      reversible: true,
    },
  };
}

function createExecution(operations: PlannedPathOperation[]): FileOrganizationExecution {
  return {
    attemptedCount: operations.length,
    movedCount: operations.length,
    skippedCount: 0,
    failedCount: 0,
    results: operations.map((operation) => ({
      source: operation.source,
      target: operation.target,
      status: "moved",
      message: "Moved in test.",
    })),
  };
}

// Streaming pipeline tests

function createTextWritePlan(targetPath: string): TextFileWritePlan {
  return {
    approvalId: "write-approval-1",
    targetPath,
    action: "create",
    byteCount: 24,
    contentHash: "fnv1a-test",
    dryRun: {
      operation: "Write text file",
      affectedPaths: [
        {
          source: "",
          target: targetPath,
          action: "create",
        },
      ],
      riskSummary: "Preview only.",
      reversible: true,
    },
  };
}

function createTextWriteResult(targetPath: string, byteCount = 24): TextFileWriteResult {
  return {
    targetPath,
    action: "create",
    byteCount,
    status: "written",
    message: "Written in test.",
  };
}

function createTextContentChatTool(content: string) {
  return {
    complete: vi.fn(async () => ({
      text: content,
      tokenUsage: { inputTokens: 12, outputTokens: 24, totalTokens: 36 },
    })),
  };
}

import { createTaskEventBus } from "./task-event-bus";

describe("completeGeneralChat streaming pipeline", () => {
  it("routes from the original user text instead of untrusted enriched context", async () => {
    const complete = vi.fn(async (prompt: string) => ({ text: `answered:${prompt}`, tokenUsage: undefined }));
    const fetchWebSource = vi.fn(async () => ({
      url: "https://example.test",
      excerpt: "This source should not be fetched for a greeting.",
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }));
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: { complete },
      webTool: { fetchWebSource },
    });
    const { snapshots } = subscribeToRuntime(runtime);
    const enrichedGoal = "hello\n\n[untrusted document] research https://example.test";

    runtime.start(enrichedGoal, {
      mode: "chat",
      taskId: "task-routing-goal",
      routingGoal: "hello",
    });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });
    expect(complete).toHaveBeenCalledWith(enrichedGoal, expect.any(Object));
    expect(fetchWebSource).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("routes simple L1 chat through l1 streaming without Commander or ReAct", async () => {
    let streamOptions: { streamMode?: "default" | "l1"; timeoutMs?: number } | undefined;
    let streamPrompt = "";
    const commanderPlan = vi.fn();
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "fallback", tokenUsage: undefined })),
      stream: vi.fn(async function* (
        prompt: string,
        options?: { streamMode?: "default" | "l1"; timeoutMs?: number },
      ) {
        streamPrompt = prompt;
        streamOptions = options;
        yield { text: "Hi" };
      }),
    };

    const eventBus = createTaskEventBus();
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      commanderTool: { plan: commanderPlan as any },
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("hello", { taskId: "task-l1-stream" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    expect(mockChatTool.stream).toHaveBeenCalledOnce();
    expect(streamOptions?.streamMode).toBe("l1");
    expect(streamOptions?.timeoutMs).toBe(90_000);
    expect(mockChatTool.complete).not.toHaveBeenCalled();
    expect(commanderPlan).not.toHaveBeenCalled();
    expect(streamPrompt).not.toContain("Output must match this JSON Schema");
    expect(streamPrompt).not.toContain("Available tools:");
    expect(streamPrompt).not.toContain("ReAct");
    expect(snapshots[snapshots.length - 1]?.commanderMessage).toBe("Hi");

    runtime.dispose();
  });

  it("recovers streaming general chat context overflow with summary plus recent messages", async () => {
    let finalMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const priorMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "old-stream-detail-should-be-summarized" : `stream-context-${index}`,
    }));
    const mockChatTool = {
      complete: vi.fn(async (prompt: string, options?: { skipAgentMemory?: boolean; skipSkillContext?: boolean }) => {
        if (prompt.includes("Summarize this earlier Javis conversation")) {
          expect(options).toMatchObject({
            skipAgentMemory: true,
            skipSkillContext: true,
            timeoutMs: 90_000,
          });
          return { text: "- Earlier stream context requires preserving user constraints.", tokenUsage: undefined };
        }
        return { text: "Recovered stream answer", tokenUsage: undefined };
      }),
      stream: vi.fn(async function* (
        _prompt: string,
        options?: { messages?: Array<{ role: "user" | "assistant"; content: string }> },
      ) {
        const messages = options?.messages ?? [];
        if (!messages.some((message) => message.content.includes("Earlier conversation summary:"))) {
          throw new Error("maximum context length exceeded");
        }
        finalMessages = messages;
        yield { text: "Recovered stream answer" };
      }),
    };

    const eventBus = createTaskEventBus();
    const streamEvents: Array<{ kind: string; error?: string }> = [];
    eventBus.on((event) => {
      if (event.kind === "agent.chunk_start" || event.kind === "agent.chunk_end") {
        streamEvents.push({
          kind: event.kind,
          error: event.kind === "agent.chunk_end" ? event.error : undefined,
        });
      }
    });
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("continue streamed thread", {
      mode: "chat",
      taskId: "task-stream-context-recovery",
      priorMessages,
    });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(mockChatTool.stream).toHaveBeenCalledTimes(2);
    expect(mockChatTool.complete).toHaveBeenCalledTimes(1);
    expect(finalMessages[0]?.content).toContain("Earlier conversation summary:");
    expect(finalMessages[0]?.content).toContain("preserving user constraints");
    expect(finalMessages.some((message) => message.content === "stream-context-13")).toBe(true);
    expect(finalMessages.some((message) => message.content.includes("old-stream-detail-should-be-summarized"))).toBe(false);
    expect(finalSnapshot?.commanderMessage).toBe("Recovered stream answer");
    expect(finalSnapshot?.conversationMessages?.[0]?.content).toBe("old-stream-detail-should-be-summarized");
    expect(finalSnapshot?.isStreaming).toBe(false);
    expect(finalSnapshot?.streamingText).toBeUndefined();
    expect(streamEvents).toEqual([
      { kind: "agent.chunk_start", error: undefined },
      { kind: "agent.chunk_end", error: "context overflow" },
      { kind: "agent.chunk_start", error: undefined },
      { kind: "agent.chunk_end", error: undefined },
    ]);

    runtime.dispose();
  });

  it("keeps partial UI content and user-facing error when general chat model calls fail", async () => {
    const mockChatTool = {
      complete: vi.fn(async () => {
        throw new Error("API key rejected");
      }),
    };
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("hello", { taskId: "task-model-failure" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("failed");
    }, { timeout: 3000 });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.commanderMessage).toBeTruthy();
    expect(finalSnapshot?.userFacingError).toMatch(/authentication failed|API key|model request failed/i);
    expect(finalSnapshot?.logs.some((log) => log.userMessage === finalSnapshot.userFacingError)).toBe(true);

    runtime.dispose();
  });

  it("streams LLM output through eventBus and accumulates streamingText in snapshot", async () => {
    const chunks = ["Hello", " world", "!"];

    // Use a plain async generator 鈥?vi.fn wrapping can interfere with
    // async iterable protocol detection.
    async function* mockStream() {
      for (const text of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { text };
      }
    }

    const mockChatTool = {
      complete: vi.fn(async () => ({ text: chunks.join(""), tokenUsage: undefined })),
      stream: mockStream,
    };

    const eventBus = createTaskEventBus();
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test streaming", { mode: "chat", taskId: "task-stream-test" });

    // Wait for completion with a generous timeout
    await vi.waitFor(() => {
      const last = snapshots[snapshots.length - 1];
      expect(last?.status).toBe("completed");
    }, { timeout: 5000 });

    // Verify streaming took the streaming path (not fallback)
    expect(mockChatTool.complete).not.toHaveBeenCalled();

    // Check that streaming snapshots were emitted during the run
    const streamingSnapshots = snapshots.filter(
      (s) => s.streamingText != null && s.streamingText.length > 0,
    );
    expect(streamingSnapshots.length).toBeGreaterThan(0);

    const lastStreaming = streamingSnapshots[streamingSnapshots.length - 1];
    expect(lastStreaming?.streamingText?.length).toBeGreaterThan(0);
    expect(lastStreaming?.streamingAgentKind).toBe("commander");

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.commanderMessage).toBe("Hello world!");

    runtime.dispose();
  });

  it("fails streamed general chat when the provider reports output truncation", async () => {
    const complete = vi.fn(async () => ({ text: "fallback should not run" }));
    const mockChatTool = {
      complete,
      stream: async function* (
        _prompt: string,
        options?: { onFinish?: (finishReason?: string) => void },
      ) {
        yield { text: "Partial answer" };
        options?.onFinish?.("length");
      },
    };
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus: createTaskEventBus(),
    });
    const { snapshots } = subscribeToRuntime(runtime);

    runtime.start("test truncated stream", { mode: "chat", taskId: "task-truncated-stream" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("failed");
    }, { timeout: 3000 });
    expect(complete).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshots[snapshots.length - 1]?.logs ?? []))
      .toContain("Model response was truncated (length)");

    runtime.dispose();
  });

  it("fails non-streaming general chat when the provider reports output truncation", async () => {
    const complete = vi.fn(async () => ({
      text: "Partial answer",
      finishReason: "max_tokens",
    }));
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: { complete },
    });
    const { snapshots } = subscribeToRuntime(runtime);

    runtime.start("test truncated completion", { mode: "chat", taskId: "task-truncated-completion" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("failed");
    }, { timeout: 3000 });
    expect(JSON.stringify(snapshots[snapshots.length - 1]?.logs ?? []))
      .toContain("Model response was truncated (max_tokens)");

    runtime.dispose();
  });

  it("falls back to non-streaming when eventBus is not provided", async () => {
    const streamSpy = vi.fn();
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "fallback response", tokenUsage: undefined })),
      stream: streamSpy,
    };

    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test fallback", { mode: "chat", taskId: "task-fallback-test" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    expect(mockChatTool.complete).toHaveBeenCalled();
    expect(mockChatTool.stream).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it("falls back to complete() when stream is not available", async () => {
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "no-stream response", tokenUsage: undefined })),
      // stream is absent
    };

    const eventBus = createTaskEventBus();
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test no stream", { mode: "chat", taskId: "task-nostream-test" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    expect(mockChatTool.complete).toHaveBeenCalled();

    runtime.dispose();
  });

  it("falls back to complete() on stream failure", async () => {
    async function* brokenStream() {
      yield { text: "partial" };
      throw new Error("stream broken");
    }
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "recovered after stream failure", tokenUsage: undefined })),
      stream: brokenStream,
    };

    const eventBus = createTaskEventBus();
    const streamEvents: Array<{ kind: string; fullText?: string; error?: string }> = [];
    eventBus.on((event) => {
      if (event.kind === "agent.chunk_end") {
        streamEvents.push(event);
      }
    });
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test stream failure", { mode: "chat", taskId: "task-failure-test" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    // Should have recovered via complete()
    expect(mockChatTool.complete).toHaveBeenCalled();
    expect(streamEvents).toContainEqual(expect.objectContaining({
      kind: "agent.chunk_end",
      fullText: "partial",
      error: "stream failed",
    }));
    const final = snapshots[snapshots.length - 1];
    expect(final?.commanderMessage).toBe("recovered after stream failure");

    runtime.dispose();
  });

  it("streams native reasoning as a separate segment before the answer", async () => {
    async function* reasoningStream() {
      yield { text: "", reasoning: "Let me think" };
      yield { text: "", reasoning: " more" };
      yield { text: "Final answer" };
    }
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "unused" })),
      stream: reasoningStream,
    };

    const eventBus = createTaskEventBus();
    const events: Array<Record<string, unknown>> = [];
    eventBus.on((event) => {
      if (event.kind === "agent.reasoning_chunk") {
        events.push({ kind: event.kind, text: event.text });
      } else if (event.kind === "agent.reasoning_chunk_end") {
        events.push({ kind: event.kind, fullText: event.fullText, error: event.error });
      } else if (event.kind === "agent.chunk") {
        events.push({ kind: event.kind, text: event.text });
      } else if (event.kind === "agent.chunk_end") {
        events.push({ kind: event.kind, fullText: event.fullText, error: event.error });
      } else if (
        event.kind === "agent.chunk_start" ||
        event.kind === "agent.reasoning_chunk_start"
      ) {
        events.push({ kind: event.kind });
      }
    });
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test reasoning stream", { mode: "chat", taskId: "task-reasoning-stream-test" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    // The reasoning segment opens lazily with the first reasoning delta and
    // closes as soon as the answer starts; reasoning never mixes into the
    // visible answer text.
    expect(events).toEqual([
      { kind: "agent.chunk_start" },
      { kind: "agent.reasoning_chunk_start" },
      { kind: "agent.reasoning_chunk", text: "Let me think" },
      { kind: "agent.reasoning_chunk", text: " more" },
      { kind: "agent.reasoning_chunk_end", fullText: "Let me think more", error: undefined },
      { kind: "agent.chunk", text: "Final answer" },
      { kind: "agent.chunk_end", fullText: "Final answer", error: undefined },
    ]);
    expect(snapshots[snapshots.length - 1]?.commanderMessage).toBe("Final answer");

    runtime.dispose();
  });

  it("keeps streamed usage when stream and fallback both fail", async () => {
    const mockChatTool = {
      complete: vi.fn(async () => {
        throw new Error("fallback failed");
      }),
      stream: vi.fn(async function* (
        _prompt: string,
        options?: {
          onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
        },
      ) {
        options?.onUsage?.({ inputTokens: 9, outputTokens: 1, totalTokens: 10 });
        throw new Error("stream failed");
      }),
    };
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus: createTaskEventBus(),
    });
    const { snapshots } = subscribeToRuntime(runtime);

    runtime.start("test failed usage accounting", {
      mode: "chat",
      taskId: "task-failed-usage-accounting",
    });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("failed");
    }, { timeout: 3000 });

    expect(mockChatTool.complete).toHaveBeenCalledOnce();
    expect(snapshots[snapshots.length - 1]?.tokenUsage).toMatchObject({
      inputTokens: 9,
      outputTokens: 1,
      totalTokens: 10,
      modelCalls: 1,
    });

    runtime.dispose();
  });

  it("does not let a replaced chat task cancel the new task", async () => {
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let callCount = 0;
    const complete = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        resolveFirstStarted();
        await new Promise(() => {});
      }
      return { text: "Second answer", tokenUsage: undefined };
    });
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: { complete },
    });
    const { snapshots } = subscribeToRuntime(runtime);

    runtime.start("first question", { mode: "chat", taskId: "task-first" });
    await firstStarted;
    runtime.start("second question", { mode: "chat", taskId: "task-second" });

    await vi.waitFor(() => {
      const last = snapshots[snapshots.length - 1];
      expect(last?.id).toBe("task-second");
      expect(last?.status).toBe("completed");
    }, { timeout: 3000 });

    const final = snapshots[snapshots.length - 1];
    expect(final?.commanderMessage).toBe("Second answer");
    expect(snapshots.some((snapshot) =>
      snapshot.id === "task-second" && snapshot.status === "cancelled"
    )).toBe(false);

    runtime.dispose();
  });

  it("handles cancellation mid-stream gracefully", async () => {
    async function* hangingStream() {
      yield { text: "chunk1 " };
      yield { text: "chunk2 " };
      // Stream would continue but cancellation stops it
      await new Promise(() => {}); // never resolves
    }
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "should not be called", tokenUsage: undefined })),
      stream: hangingStream,
    };

    const eventBus = createTaskEventBus();
    const runtime = createFileScanTaskRuntime({
      fileTool: undefined as any,
      chatTool: mockChatTool,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("test cancel", { mode: "chat", taskId: "task-cancel-test" });

    // Wait for at least one streaming snapshot
    await vi.waitFor(() => {
      expect(snapshots.some((s) => s.isStreaming)).toBe(true);
    }, { timeout: 3000 });

    // Simulate cancellation
    eventBus.emit({
      kind: "agent.chunk_end",
      taskId: "task-cancel-test",
      agentKind: "commander",
      fullText: "",
      error: "cancelled",
    });

    // Should have a cancelled/error state
    const afterCancel = snapshots[snapshots.length - 1];
    expect(afterCancel?.isStreaming).toBe(false);

    runtime.dispose();
  });
});

import { createDeltaReducer } from "./delta-reducer";

describe("delta-reducer streaming metadata", () => {
  it("tracks streamingAgentKind and clears on completion", () => {
    const initial = createInitialTaskSnapshot();
    const reducer = createDeltaReducer(initial);

    // Start streaming
    let snapshot = reducer.apply({
      kind: "agent.chunk_start",
      taskId: "t1",
      agentKind: "verifier",
    });
    expect(snapshot.isStreaming).toBe(true);
    expect(snapshot.streamingAgentKind).toBe("verifier");
    expect(snapshot.streamingText).toBe("");

    // Add chunks
    snapshot = reducer.apply({
      kind: "agent.chunk",
      taskId: "t1",
      agentKind: "verifier",
      text: "checking",
    });
    expect(snapshot.streamingText).toBe("checking");

    snapshot = reducer.apply({
      kind: "agent.chunk",
      taskId: "t1",
      agentKind: "verifier",
      text: " evidence",
    });
    expect(snapshot.streamingText).toBe("checking evidence");

    // End streaming
    snapshot = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "t1",
      agentKind: "verifier",
      fullText: "checking evidence",
    });
    expect(snapshot.isStreaming).toBe(false);
    expect(snapshot.streamingText).toBeUndefined();
    expect(snapshot.verificationSummary).toBe("checking evidence");
  });

  it("accumulates commander text during streaming", () => {
    const initial = createInitialTaskSnapshot();
    const reducer = createDeltaReducer(initial);

    reducer.apply({
      kind: "agent.chunk_start",
      taskId: "t2",
      agentKind: "commander",
    });

    reducer.apply({
      kind: "agent.chunk",
      taskId: "t2",
      agentKind: "commander",
      text: "Based on the ",
    });
    reducer.apply({
      kind: "agent.chunk",
      taskId: "t2",
      agentKind: "commander",
      text: "evidence, ",
    });
    const snapshot = reducer.apply({
      kind: "agent.chunk",
      taskId: "t2",
      agentKind: "commander",
      text: "the project is healthy.",
    });

    expect(snapshot.streamingText).toBe("Based on the evidence, the project is healthy.");
    expect(snapshot.isStreaming).toBe(true);

    const final = reducer.apply({
      kind: "agent.chunk_end",
      taskId: "t2",
      agentKind: "commander",
      fullText: "Based on the evidence, the project is healthy.",
    });
    expect(final.commanderMessage).toBe("Based on the evidence, the project is healthy.");
    expect(final.isStreaming).toBe(false);
  });
});

describe("validateSynthesisConclusion evidence guard", () => {
  it("accepts an explanatory uncertainty answer when evidence is empty", () => {
    // Reproduced from a real qwen3.8-flash synthesis answer that previously
    // failed the full-match uncertainty pattern and failed the whole
    // direct_response step ("Evidence-bound Commander synthesis was
    // unavailable").
    const message =
      "目前缺少关于“你”具体指代对象、可用工具或任务上下文的证据，因此无法确定你能做什么。" +
      "你可以提供目标、场景或可用资源，我再据此说明你能完成哪些事情。";
    expect(validateSynthesisConclusion({ message }, {})).toMatchObject({ message });
  });

  it("accepts an English uncertainty answer that leads with missing evidence", () => {
    const message =
      "I don't have enough evidence to determine what you can do. " +
      "Please provide your goal, context, or available resources and I will answer from them.";
    expect(validateSynthesisConclusion({ message }, {})).toMatchObject({ message });
  });

  it("still rejects capability claims made without any evidence", () => {
    const message = "我可以帮你做工作区结构分析、代码搜索与调用、网页检索和定时任务。";
    expect(validateSynthesisConclusion({ message }, {})).toBeUndefined();
  });

  it("still applies clause checks to uncertainty-led answers when evidence exists", () => {
    const evidence = { workspaceSummary: "Rust Tauri desktop app" };
    const message =
      "目前缺少完整证据，无法确定全部细节。" +
      "The warehouse orbits Jupiter at 42 percent capacity every third moon.";
    expect(validateSynthesisConclusion({ message }, evidence)).toBeUndefined();
  });
});
