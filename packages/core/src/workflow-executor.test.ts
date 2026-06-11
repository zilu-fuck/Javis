import { describe, expect, it, vi } from "vitest";
import { encodeMcpToolServerName, initialToolDescriptors, type BrowserTool, type CodeTool, type CommanderTool, type ComputerTool, type FileTool, type GitTool, type McpTool, type MemoryTool, type ProjectTool, type SchedulerTool, type ShellTool, type ToolDescriptor, type TrendTool, type VerifierTool, type WorkspaceTool } from "@javis/tools";
import { createInitialTaskSnapshot, type TaskSnapshot } from "./index";
import { createSharedTaskContext } from "./shared-context";
import { executeCapabilityStep, runCommanderDagTask, runGenericWorkbenchWorkflow, runReadCurrentProjectWorkflow } from "./workflow-executor";
import type { ReActDecisionRequest } from "./agent-react-decider";

function createTestController(options: { withPermissionHandler?: boolean } = {}) {
  let snapshot = createInitialTaskSnapshot();
  const emitted: TaskSnapshot[] = [];
  const permissionHandlers = new Map<string, ((decision: string) => void | Promise<void>)>();
  return {
    emitted,
    permissionHandlers,
    controller: {
      emit(nextSnapshot: TaskSnapshot) {
        snapshot = nextSnapshot;
        emitted.push(nextSnapshot);
      },
      getSnapshot() {
        return snapshot;
      },
      async wait() {},
      ...(options.withPermissionHandler
        ? {
          setPendingPermissionHandler: vi.fn((requestId: string, handler: ((decision: string) => void | Promise<void>) | undefined) => {
            if (handler) {
              permissionHandlers.set(requestId, handler);
            } else {
              permissionHandlers.delete(requestId);
            }
          }),
        }
        : {}),
    },
  };
}

async function waitForPermissionHandler(
  permissionHandlers: Map<string, ((decision: string) => void | Promise<void>)>,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const entry = [...permissionHandlers.entries()][0];
    if (entry) {
      return entry;
    }
    await Promise.resolve();
  }
  throw new Error("permission handler was not registered");
}

function createBrowserTool(overrides: Partial<BrowserTool> = {}): BrowserTool {
  return {
    navigate: vi.fn(async () => ({ url: "https://example.test", title: "", status: 200, loadState: "load" })),
    screenshot: vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      capturedAt: "2026-06-08T00:00:00.000Z",
    })),
    getContent: vi.fn(async () => ({ content: "", url: "https://example.test", title: "" })),
    click: vi.fn(async () => ({ selector: "button", clicked: true })),
    type: vi.fn(async () => ({ selector: "input", typed: true, value: "" })),
    evaluate: vi.fn(async () => ({ result: "", type: "undefined" })),
    runTest: vi.fn(async () => ({ passed: true, exitCode: 0, stdout: "", stderr: "", duration: 1 })),
    ...overrides,
  };
}

describe("runCommanderDagTask observability", () => {
  it("emits an explicit sub-agent dispatch snapshot after Commander planning", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Scan files",
        reasoning: "Commander will delegate file scanning.",
        steps: [{
          id: "scan-files",
          title: "Scan project documents",
          assignedAgentKind: "file",
          capability: "file_scan",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Documents are scanned.",
        }],
      })),
    };
    const fileTool: FileTool = {
      scanMarkdownDocuments: vi.fn(async () => []),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      fileTool,
      taskId: "task-observe-subagent",
      userGoal: "scan the project documents",
    });

    const dispatchSnapshot = emitted.find((snapshot) =>
      snapshot.commanderMessage.includes("Commander dispatched: File Agent") &&
      snapshot.logs.some((log) =>
        log.agentId === "agent-file" &&
        log.userMessage?.includes("Queued by Commander"),
      ),
    );
    expect(dispatchSnapshot).toBeDefined();
    expect(dispatchSnapshot?.agents.find((agent) => agent.id === "agent-file")?.status).toBe("queued");
  });

  it("filters code.searchRepository out of Commander planning when the code tool omits it", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        expect(request.availableTools?.some((tool) => tool.name === "code.searchRepository")).toBe(false);
        const codeAgent = request.availableAgents.find((agent) => agent.kind === "code");
        expect(codeAgent?.allowedToolNames).not.toContain("code.searchRepository");
        return {
          title: "No repository search",
          reasoning: "Repository search is not runtime-available.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response" as const,
            requiredCapabilities: [],
            dependsOn: [],
            successCriteria: "User receives an answer.",
          }],
        };
      }),
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
    };
    const { controller } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-plan-without-repo-search",
      userGoal: "search the repository for memory code",
    });

    expect(commanderTool.plan).toHaveBeenCalled();
  });

  it("stores code.searchRepository output on the task snapshot", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Search repository",
        reasoning: "Commander will ask Code Agent to collect repository evidence.",
        steps: [{
          id: "search-repo",
          title: "Search repository",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "find memory code", knownTerms: ["memory"] },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          successCriteria: "Repository evidence is collected.",
        }],
      })),
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository: vi.fn(async () => ({
        actualFound: [{
          path: "packages/core/src/memory.ts",
          line: 8,
          excerpt: "export interface AgentMemory {}",
          matchedTerms: ["memory"],
        }],
        inferred: ["Memory code lives under packages/core."],
        needsConfirmation: ["No test file was found in the first search pass."],
        keyFiles: ["packages/core/src/memory.ts"],
        relatedTestFiles: [],
        testFileCandidates: ["packages/core/src/memory.test.ts"],
        clusters: [{
          id: "packages/core",
          label: "packages/core",
          paths: ["packages/core/src/memory.ts"],
          resultCount: 1,
          score: 2,
          topTerms: ["memory"],
        }],
        attempts: [{
          id: "term-memory",
          query: "memory",
          reason: "Search known term.",
        }],
      })),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-repo-search-snapshot",
      userGoal: "search the repository for memory code",
    });

    const snapshotWithReport = emitted.find((snapshot) => snapshot.repoSearchReport);
    expect(snapshotWithReport?.repoSearchReport?.keyFiles).toEqual(["packages/core/src/memory.ts"]);
    expect(codeTool.searchRepository).toHaveBeenCalledWith({
      goal: "find memory code",
      knownTerms: ["memory"],
      entryFile: undefined,
      priorityPaths: undefined,
      maxAttempts: undefined,
      maxKeyFiles: undefined,
    });
  });

  it("filters code.traceCallChain out of Commander planning when the code tool omits it", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        expect(request.availableTools?.some((tool) => tool.name === "code.traceCallChain")).toBe(false);
        const codeAgent = request.availableAgents.find((agent) => agent.kind === "code");
        expect(codeAgent?.allowedToolNames).not.toContain("code.traceCallChain");
        return {
          title: "No trace",
          reasoning: "Trace is not runtime-available.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response" as const,
            requiredCapabilities: [],
            dependsOn: [],
            successCriteria: "User receives an answer.",
          }],
        };
      }),
    };
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
    const { controller } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-plan-without-trace",
      userGoal: "trace a UI call chain",
    });

    expect(commanderTool.plan).toHaveBeenCalled();
  });

  it("stores code.traceCallChain output on the task snapshot", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Trace call chain",
        reasoning: "Commander will ask Code Agent to collect trace evidence.",
        steps: [{
          id: "trace-repo",
          title: "Trace repository call chain",
          assignedAgentKind: "code",
          toolName: "code.traceCallChain",
          toolInput: { goal: "trace task launch", target: "runTask", entrypoints: ["TaskPanel"] },
          requiredCapabilities: ["code_trace"],
          dependsOn: [],
          successCriteria: "Trace evidence is collected.",
        }],
      })),
    };
    const traceCallChain = vi.fn<NonNullable<CodeTool["traceCallChain"]>>(async () => ({
      target: "runTask",
      direction: "bidirectional",
      actualFound: [{
        path: "packages/ui/src/TaskPanel.tsx",
        line: 42,
        excerpt: "onClick={() => runTask(goal)}",
        matchedTerms: ["runTask"],
      }],
      nodes: [{
        id: "target:runtask",
        label: "runTask",
        kind: "target",
        symbol: "runTask",
        score: 100,
      }],
      edges: [],
      moduleLinks: [],
      symbolGraph: {
        nodes: [],
        edges: [],
      },
      inferred: [],
      needsConfirmation: ["No candidate call-chain edges could be inferred from the current evidence."],
      keyFiles: ["packages/ui/src/TaskPanel.tsx"],
      attempts: [{
        id: "trace-target",
        query: "runTask",
        reason: "exact target from trace request",
      }],
    }));
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      traceCallChain,
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-trace-snapshot",
      userGoal: "trace task launch",
    });

    const snapshotWithReport = emitted.find((snapshot) => snapshot.repoTraceReport);
    expect(snapshotWithReport?.repoTraceReport?.keyFiles).toEqual(["packages/ui/src/TaskPanel.tsx"]);
    expect(traceCallChain).toHaveBeenCalledWith({
      goal: "trace task launch",
      target: "runTask",
      entrypoints: ["TaskPanel"],
      workspaceModulePrefixes: undefined,
      direction: undefined,
      maxDepth: undefined,
      maxEdges: undefined,
      knownTerms: undefined,
      maxAttempts: undefined,
    });
  });

  it("attaches a serializable handoff report to the final Commander DAG snapshot", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Handoff report task",
        reasoning: "Commander will pass repository evidence to a synthesis step.",
        steps: [{
          id: "collect-evidence",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "find launch code" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "repoEvidence",
          successCriteria: "Repository evidence is collected.",
        }, {
          id: "summarize-evidence",
          title: "Summarize evidence",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: ["synthesis"],
          dependsOn: ["collect-evidence"],
          inputContextKeys: ["repoEvidence"],
          outputContextKey: "summary",
          successCriteria: "Summary uses repository evidence.",
        }],
      })),
      synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
        message: "Evidence summarized.",
      })),
    };
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
        keyFiles: ["packages/core/src/index.ts"],
        relatedTestFiles: [],
        testFileCandidates: [],
        clusters: [],
        attempts: [],
      })),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-handoff-report",
      userGoal: "summarize launch code",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.handoffReport).toMatchObject({
      status: "needs_attention",
      missingInputContextKeys: [],
      unconsumedOutputContextKeys: ["summary"],
    });
    expect(finalSnapshot?.handoffReport?.handoffs).toEqual([
      expect.objectContaining({
        contextKey: "repoEvidence",
        producedByStepId: "collect-evidence",
        consumedByStepIds: ["summarize-evidence"],
        status: "available",
      }),
      expect.objectContaining({
        contextKey: "summary",
        producedByStepId: "summarize-evidence",
        consumedByStepIds: [],
        status: "unconsumed",
      }),
    ]);
  });

  it("attaches a recovery report when Commander replans after a step failure", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Recovery report task",
        reasoning: "Commander will recover from a failed repository search.",
        steps: [{
          id: "collect-evidence",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "find launch code" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "repoEvidence",
          successCriteria: "Repository evidence is collected.",
        }],
      })),
      synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
        message: "Recovered with alternate evidence.",
      })),
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository: vi.fn(async () => {
        throw new Error("HTTP 503 from repository search provider");
      }),
    };
    const replanDag = vi.fn(async () => ({
      title: "Recovery plan",
      reasoning: "Use a direct synthesis step with partial evidence.",
      steps: [{
        id: "recover-with-partial-evidence",
        title: "Recover with partial evidence",
        assignedAgentKind: "commander",
        executionMode: "direct_response" as const,
        requiredCapabilities: ["synthesis"],
        dependsOn: ["collect-evidence"],
        outputContextKey: "recoverySummary",
        successCriteria: "Recovery summary names the degraded evidence path.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-recovery-report",
      userGoal: "summarize launch code",
      replanDag,
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(replanDag).toHaveBeenCalledOnce();
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.recoveryReport).toMatchObject({
      status: "recovered",
      failureCount: 1,
      recoveredCount: 1,
      unrecoveredCount: 0,
      abandonedStepIds: ["collect-evidence"],
      replannedStepIds: ["recover-with-partial-evidence"],
      attempts: [expect.objectContaining({
        failedStepId: "collect-evidence",
        failureKind: "network",
        replanAttempted: true,
        replanStatus: "planned",
        abandonedFailedStep: true,
        recoveryStepIds: ["recover-with-partial-evidence"],
      })],
    });
  });
});

describe("executeCapabilityStep repository search dispatch", () => {
  it("dispatches code.searchRepository when the code tool implements it", async () => {
    const context = createSharedTaskContext({
      userGoal: "find memory implementation",
      taskId: "task-repo-search",
    });
    const searchRepository = vi.fn<NonNullable<CodeTool["searchRepository"]>>(async () => ({
      actualFound: [{
        path: "packages/core/src/memory.ts",
        line: 12,
        excerpt: "export function searchMemory() {}",
        matchedTerms: ["memory"],
      }],
      inferred: ["Memory implementation is in core."],
      needsConfirmation: [],
      keyFiles: ["packages/core/src/memory.ts"],
      relatedTestFiles: [],
      testFileCandidates: ["packages/core/src/memory.test.ts"],
      clusters: [],
      attempts: [{
        id: "term-memory",
        query: "memory",
        reason: "Search known term.",
      }],
    }));
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository,
    };

    const result = await executeCapabilityStep(
      {
        id: "search-repo",
        title: "Search repository",
        assignedAgentKind: "code",
        capability: "code_search",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        toolInput: { goal: "find memory implementation", knownTerms: ["memory"], maxKeyFiles: 3 },
        outputContextKey: "repoSearch",
        successCriteria: "Repository search evidence is collected.",
      },
      context,
      { codeTool },
    );

    expect(result.toolName).toBe("code.searchRepository");
    expect(searchRepository).toHaveBeenCalledWith({
      goal: "find memory implementation",
      knownTerms: ["memory"],
      entryFile: undefined,
      priorityPaths: undefined,
      maxAttempts: undefined,
      maxKeyFiles: 3,
    });
    expect(context.get("repoSearch")).toMatchObject({
      keyFiles: ["packages/core/src/memory.ts"],
    });
  });

  it("does not dispatch code.searchRepository when the code tool omits it", async () => {
    const context = createSharedTaskContext({
      userGoal: "find memory implementation",
      taskId: "task-repo-search-missing",
    });
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
    };

    await expect(executeCapabilityStep(
      {
        id: "search-repo",
        title: "Search repository",
        assignedAgentKind: "code",
        capability: "code_search",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        successCriteria: "Repository search evidence is collected.",
      },
      context,
      { codeTool },
    )).rejects.toThrow(/No tool registered for capability "code_search"/);
  });

  it("dispatches code.traceCallChain when the code tool implements it", async () => {
    const context = createSharedTaskContext({
      userGoal: "trace task launch",
      taskId: "task-trace",
    });
    const traceCallChain = vi.fn<NonNullable<CodeTool["traceCallChain"]>>(async () => ({
      target: "runTask",
      direction: "forward",
      actualFound: [],
      nodes: [],
      edges: [],
      moduleLinks: [],
      symbolGraph: {
        nodes: [],
        edges: [],
      },
      inferred: [],
      needsConfirmation: [],
      keyFiles: ["packages/core/src/workflow-executor.ts"],
      attempts: [],
    }));
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      traceCallChain,
    };

    const result = await executeCapabilityStep(
      {
        id: "trace-repo",
        title: "Trace repository",
        assignedAgentKind: "code",
        capability: "code_trace",
        requiredCapabilities: ["code_trace"],
        dependsOn: [],
        toolInput: { goal: "trace task launch", target: "runTask", direction: "forward", maxEdges: 4 },
        outputContextKey: "repoTrace",
        successCriteria: "Repository trace evidence is collected.",
      },
      context,
      { codeTool },
    );

    expect(result.toolName).toBe("code.traceCallChain");
    expect(traceCallChain).toHaveBeenCalledWith({
      goal: "trace task launch",
      target: "runTask",
      entrypoints: undefined,
      workspaceModulePrefixes: undefined,
      direction: "forward",
      maxDepth: undefined,
      maxEdges: 4,
      knownTerms: undefined,
      maxAttempts: undefined,
    });
    expect(context.get("repoTrace")).toMatchObject({
      keyFiles: ["packages/core/src/workflow-executor.ts"],
    });
  });
});

describe("executeCapabilityStep trend dispatch", () => {
  it("dispatches trend.fetchHotList for structured hot-list research", async () => {
    const context = createSharedTaskContext({
      userGoal: "总结今天微博热搜榜前20",
      taskId: "task-trend-fetch",
    });
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 20,
      complete: true,
      warnings: [],
      diagnostics: [{
        provider: "mirror",
        sourceUrl: "https://example.test/mirror",
        requestedLimit: 20,
        startedAt: "2026-06-10T00:00:00.000Z",
        finishedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 0,
        status: "failed",
        httpStatus: 503,
        errorKind: "http",
        error: "HTTP 503",
      }, {
        provider: "weibo",
        sourceUrl: "https://weibo.com/ajax/side/hotSearch",
        requestedLimit: 20,
        startedAt: "2026-06-10T00:00:00.000Z",
        finishedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 0,
        status: "completed",
        httpStatus: 200,
        itemCount: 1,
      }],
      items: [{
        rank: 1,
        title: "AI 新闻",
        hotScore: 123,
      }],
    }));

    const result = await executeCapabilityStep(
      {
        id: "fetch-hot-list",
        title: "Fetch Weibo hot list",
        assignedAgentKind: "research",
        capability: "trend_fetch",
        requiredCapabilities: ["trend_fetch"],
        dependsOn: [],
        toolInput: { provider: "weibo", limit: 20 },
        outputContextKey: "hotList",
        successCriteria: "Structured hot list is collected.",
      },
      context,
      { trendTool: { fetchHotList } },
    );

    expect(result.toolName).toBe("trend.fetchHotList");
    expect(fetchHotList).toHaveBeenCalledWith({
      provider: "weibo",
      fallbackProviders: undefined,
      limit: 20,
    });
    expect(context.get("hotList")).toMatchObject({
      provider: "weibo",
      expectedCount: 20,
    });
  });

  it("does not expose trend.fetchHotList when the trend tool is missing", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        expect(request.availableTools?.some((tool) => tool.name === "trend.fetchHotList")).toBe(false);
        const researchAgent = request.availableAgents.find((agent) => agent.kind === "research");
        expect(researchAgent?.allowedToolNames).not.toContain("trend.fetchHotList");
        return {
          title: "No trend tool",
          reasoning: "Trend fetch is not runtime-available.",
          steps: [{
            id: "answer",
            title: "Answer directly",
            assignedAgentKind: "commander",
            executionMode: "direct_response" as const,
            requiredCapabilities: [],
            dependsOn: [],
            successCriteria: "User receives an answer.",
          }],
        };
      }),
    };
    const { controller } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      taskId: "task-trend-filter",
      userGoal: "总结今天微博热搜榜前20",
    });

    expect(commanderTool.plan).toHaveBeenCalled();
  });
});

describe("runCommanderDagTask Git stage dispatch", () => {
  it("waits for confirmed-write approval before staging explicit paths", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Stage selected files",
        reasoning: "Commander will ask Code Agent to stage selected files.",
        steps: [{
          id: "stage-selected",
          title: "Stage selected files",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          toolInput: { paths: ["README.md"] },
          requiredCapabilities: ["git_stage"],
          dependsOn: [],
          successCriteria: "Selected files staged after approval.",
        }],
      })),
    };
    const planStageFiles = vi.fn<NonNullable<GitTool["planStageFiles"]>>(async () => ({
      approvalId: "approval-stage-1",
      preview: {
        workspaceRoot: "E:/Javis",
        files: [{
          path: "README.md",
          indexStatus: " ",
          worktreeStatus: "M",
          action: "stage",
          contentHash: "hash-1",
        }],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md",
        dryRun: {
          operation: "git.stageFiles",
          affectedPaths: [{ source: "README.md", target: "Git index", action: "stage" }],
          riskSummary: "Stages selected files in the Git index.",
          reversible: true,
        },
      },
    }));
    const executeStageFiles = vi.fn<NonNullable<GitTool["executeStageFiles"]>>(async () => ({
      workspacePath: "E:/Javis",
      stagedPaths: ["README.md"],
      fileCount: 1,
      staged: true,
      output: "",
    }));
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planStageFiles, executeStageFiles },
      taskId: "task-git-stage",
      userGoal: "stage README.md",
    });

    const [requestId, handler] = await waitForPermissionHandler(permissionHandlers);
    expect(requestId).toBe("approval-stage-1");
    expect(executeStageFiles).not.toHaveBeenCalled();
    expect(emitted.find((snapshot) => snapshot.permissionRequest?.title === "Approve Git stage"))
      .toBeDefined();

    await handler("approved");
    await runPromise;

    expect(planStageFiles).toHaveBeenCalledWith({
      paths: ["README.md"],
      taskId: "task-git-stage",
    });
    expect(executeStageFiles).toHaveBeenCalledWith({
      approvalId: "approval-stage-1",
      paths: ["README.md"],
      taskId: "task-git-stage",
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted)).toContain("Staged 1 file(s): README.md.");
  });

  it("completes as a no-op when Git stage approval is denied", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Stage selected files",
        reasoning: "Commander will ask Code Agent to stage selected files.",
        steps: [{
          id: "stage-selected",
          title: "Stage selected files",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          toolInput: { paths: ["README.md"] },
          requiredCapabilities: ["git_stage"],
          dependsOn: [],
          successCriteria: "Selected files staged after approval.",
        }],
      })),
    };
    const planStageFiles = vi.fn<NonNullable<GitTool["planStageFiles"]>>(async () => ({
      approvalId: "approval-stage-denied",
      preview: {
        workspaceRoot: "E:/Javis",
        files: [{
          path: "README.md",
          indexStatus: " ",
          worktreeStatus: "M",
          action: "stage",
          contentHash: "hash-1",
        }],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md",
        dryRun: {
          operation: "git.stageFiles",
          affectedPaths: [{ source: "README.md", target: "Git index", action: "stage" }],
          riskSummary: "Stages selected files in the Git index.",
          reversible: true,
        },
      },
    }));
    const executeStageFiles = vi.fn<NonNullable<GitTool["executeStageFiles"]>>(async () => {
      throw new Error("executeStageFiles should not be called");
    });
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planStageFiles, executeStageFiles },
      taskId: "task-git-stage-denied",
      userGoal: "stage README.md",
    });

    const [, handler] = await waitForPermissionHandler(permissionHandlers);
    await handler("denied");
    await runPromise;

    expect(executeStageFiles).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted)).toContain("Git stage was denied; no files were staged.");
  });
});

describe("runCommanderDagTask Git commit dispatch", () => {
  it("waits for approval before creating a selected-path commit", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Commit selected files",
        reasoning: "Commander will ask Code Agent to commit selected files.",
        steps: [{
          id: "commit-selected",
          title: "Commit selected files",
          assignedAgentKind: "code",
          toolName: "git.createCommit",
          toolInput: {
            message: "Commit README update",
            paths: ["README.md"],
          },
          requiredCapabilities: ["git_commit"],
          dependsOn: [],
          successCriteria: "Selected files committed after approval.",
        }],
      })),
    };
    const planCommit = vi.fn<NonNullable<GitTool["planCommit"]>>(async () => ({
      approvalId: "approval-commit-1",
      preview: {
        workspaceRoot: "E:/Javis",
        branch: "feature/test",
        message: "Commit README update",
        files: [{
          path: "README.md",
          indexStatus: " ",
          worktreeStatus: "M",
          action: "modify",
          contentHash: "hash-1",
        }],
        diffStat: " README.md | 1 +",
        diff: "diff --git a/README.md b/README.md",
        dryRun: {
          operation: "git.createCommit",
          affectedPaths: [{ source: "README.md", target: "README.md", action: "modify" }],
          riskSummary: "Creates a local Git commit for selected paths.",
          reversible: false,
        },
      },
    }));
    const executeCommit = vi.fn<NonNullable<GitTool["executeCommit"]>>(async () => ({
      workspacePath: "E:/Javis",
      branch: "feature/test",
      commitHash: "1234567890abcdef",
      subject: "Commit README update",
      fileCount: 1,
      committed: true,
      output: "",
    }));
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planCommit, executeCommit },
      taskId: "task-git-commit",
      userGoal: "commit README.md",
    });

    const [requestId, handler] = await waitForPermissionHandler(permissionHandlers);
    expect(requestId).toBe("approval-commit-1");
    expect(executeCommit).not.toHaveBeenCalled();
    expect(emitted.find((snapshot) => snapshot.permissionRequest?.title === "Approve Git commit"))
      .toBeDefined();

    await handler("approved");
    await runPromise;

    expect(planCommit).toHaveBeenCalledWith({
      message: "Commit README update",
      paths: ["README.md"],
      taskId: "task-git-commit",
    });
    expect(executeCommit).toHaveBeenCalledWith({
      approvalId: "approval-commit-1",
      message: "Commit README update",
      paths: ["README.md"],
      taskId: "task-git-commit",
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted)).toContain("Created commit 1234567890ab for 1 file(s): Commit README update.");
  });
});

describe("runCommanderDagTask Git pull request dispatch", () => {
  it("waits for approval before creating a draft pull request", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Create pull request",
        reasoning: "Commander will ask Code Agent to create a draft pull request.",
        steps: [{
          id: "create-pr",
          title: "Create draft pull request",
          assignedAgentKind: "code",
          toolName: "git.createPullRequest",
          toolInput: {
            title: "Add README update",
            body: "Summarizes the README update.",
            baseBranch: "main",
            draft: true,
          },
          requiredCapabilities: ["git_pr_create"],
          dependsOn: [],
          successCriteria: "Draft pull request created after approval.",
        }],
      })),
    };
    const planCreatePullRequest = vi.fn<NonNullable<GitTool["planCreatePullRequest"]>>(async () => ({
      approvalId: "approval-pr-1",
      preview: {
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        title: "Add README update",
        body: "Summarizes the README update.",
        baseBranch: "main",
        headBranch: "feature/readme",
        headCommit: "1234567890abcdef",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/javis.git",
        draft: true,
        dryRun: {
          operation: "git.createPullRequest",
          affectedPaths: [{ source: "feature/readme", target: "main", action: "create_pr" }],
          riskSummary: "Creates a draft GitHub pull request.",
          reversible: false,
        },
      },
    }));
    const executeCreatePullRequest = vi.fn<NonNullable<GitTool["executeCreatePullRequest"]>>(async () => ({
      workspacePath: "E:/Javis",
      provider: "github-cli",
      url: "https://github.com/example/javis/pull/12",
      title: "Add README update",
      baseBranch: "main",
      headBranch: "feature/readme",
      draft: true,
      created: true,
      output: "https://github.com/example/javis/pull/12",
    }));
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planCreatePullRequest, executeCreatePullRequest },
      taskId: "task-git-pr",
      userGoal: "create a PR",
    });

    const [requestId, handler] = await waitForPermissionHandler(permissionHandlers);
    expect(requestId).toBe("approval-pr-1");
    expect(executeCreatePullRequest).not.toHaveBeenCalled();
    expect(emitted.find((snapshot) => snapshot.permissionRequest?.title === "Approve Git pull request"))
      .toBeDefined();

    await handler("approved");
    await runPromise;

    expect(planCreatePullRequest).toHaveBeenCalledWith({
      title: "Add README update",
      body: "Summarizes the README update.",
      baseBranch: "main",
      draft: true,
      taskId: "task-git-pr",
    });
    expect(executeCreatePullRequest).toHaveBeenCalledWith({
      approvalId: "approval-pr-1",
      title: "Add README update",
      body: "Summarizes the README update.",
      baseBranch: "main",
      draft: true,
      taskId: "task-git-pr",
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted))
      .toContain("Created draft pull request https://github.com/example/javis/pull/12 from feature/readme to main.");
  });
});

describe("runCommanderDagTask Git pull request comment dispatch", () => {
  it("waits for approval before commenting on a pull request", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Comment on pull request",
        reasoning: "Commander will ask Code Agent to comment after approval.",
        steps: [{
          id: "comment-pr",
          title: "Comment on pull request",
          assignedAgentKind: "code",
          toolName: "git.commentPullRequest",
          toolInput: {
            pullRequest: "12",
            body: "Looks good after the latest changes.",
          },
          requiredCapabilities: ["git_pr_comment"],
          dependsOn: [],
          successCriteria: "Pull request comment posted after approval.",
        }],
      })),
    };
    const planCommentPullRequest = vi.fn<NonNullable<GitTool["planCommentPullRequest"]>>(async () => ({
      approvalId: "approval-pr-comment-1",
      preview: {
        workspaceRoot: "E:/Javis",
        provider: "github-cli",
        pullRequest: "12",
        body: "Looks good after the latest changes.",
        remoteUrl: "https://github.com/example/javis.git",
        dryRun: {
          operation: "git.commentPullRequest",
          affectedPaths: [{ source: "12", target: "https://github.com/example/javis.git", action: "comment_pr" }],
          riskSummary: "Posts a GitHub pull request comment.",
          reversible: false,
        },
      },
    }));
    const executeCommentPullRequest = vi.fn<NonNullable<GitTool["executeCommentPullRequest"]>>(async () => ({
      workspacePath: "E:/Javis",
      provider: "github-cli",
      pullRequest: "12",
      commented: true,
      output: "https://github.com/example/javis/pull/12#issuecomment-1",
    }));
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planCommentPullRequest, executeCommentPullRequest },
      taskId: "task-git-pr-comment",
      userGoal: "comment on a PR",
    });

    const [requestId, handler] = await waitForPermissionHandler(permissionHandlers);
    expect(requestId).toBe("approval-pr-comment-1");
    expect(executeCommentPullRequest).not.toHaveBeenCalled();
    expect(emitted.find((snapshot) => snapshot.permissionRequest?.title === "Approve Git pull request comment"))
      .toBeDefined();

    await handler("approved");
    await runPromise;

    expect(planCommentPullRequest).toHaveBeenCalledWith({
      pullRequest: "12",
      body: "Looks good after the latest changes.",
      taskId: "task-git-pr-comment",
    });
    expect(executeCommentPullRequest).toHaveBeenCalledWith({
      approvalId: "approval-pr-comment-1",
      pullRequest: "12",
      body: "Looks good after the latest changes.",
      taskId: "task-git-pr-comment",
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted)).toContain("Posted pull request comment on 12.");
  });
});

describe("executeCapabilityStep permissions", () => {
  it("dispatches allowlisted dynamic MCP subtools from descriptor metadata", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      toolName: "delete_file",
      arguments: { query: "demo" },
    });
    const serverName = "filesystem";
    const source = "javis";
    const toolName = `mcp.${encodeMcpToolServerName(`${source}:${serverName}`)}.tool.${encodeMcpToolServerName("search")}`;

    const result = await executeCapabilityStep(
      {
        id: "mcp-call",
        title: "Call MCP",
        assignedAgentKind: "commander",
        toolName,
        requiredCapabilities: ["local_search"],
        inputContextKeys: ["toolName", "arguments"],
        outputContextKey: "mcpResult",
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: toolName,
          permissionLevel: "read",
          summary: "Search filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: serverName,
            mcpSource: source,
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        }],
      },
    );

    expect(result.toolName).toBe(toolName);
    expect(result.output).toEqual({ ok: true });
    expect(context.get("mcpResult")).toEqual({ ok: true });
    expect(mcpCall).toHaveBeenCalledWith({
      serverName,
      source,
      action: "callTool",
      toolName: "search",
      arguments: { query: "demo" },
      input: {
        toolName: "search",
        arguments: { query: "demo" },
      },
    });
  });

  it("skips MCP listTools descriptors when dispatching by capability", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      arguments: { query: "demo" },
    });
    const serverName = "filesystem";
    const source = "javis";
    const encodedServer = encodeMcpToolServerName(`${source}:${serverName}`);
    const subtoolName = `mcp.${encodedServer}.tool.${encodeMcpToolServerName("search")}`;

    const result = await executeCapabilityStep(
      {
        id: "mcp-capability-call",
        title: "Search with MCP",
        assignedAgentKind: "commander",
        requiredCapabilities: ["local_search"],
        capability: "local_search",
        inputContextKeys: ["arguments"],
        outputContextKey: "mcpResult",
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [
          {
            name: `mcp.${encodedServer}.listTools`,
            permissionLevel: "read",
            summary: "Discovery only: list filesystem MCP tools.",
            capabilityTags: ["local_search"],
            ownerAgentKinds: ["commander"],
            metadata: {
              mcpServerName: serverName,
              mcpSource: source,
              mcpAction: "listTools",
            },
          },
          {
            name: subtoolName,
            permissionLevel: "read",
            summary: "Search filesystem MCP.",
            capabilityTags: ["local_search"],
            ownerAgentKinds: ["commander"],
            metadata: {
              mcpServerName: serverName,
              mcpSource: source,
              mcpAction: "callTool",
              mcpToolName: "search",
            },
          },
        ],
      },
    );

    expect(result.toolName).toBe(subtoolName);
    expect(mcpCall).toHaveBeenCalledWith({
      serverName,
      source,
      action: "callTool",
      toolName: "search",
      arguments: { query: "demo" },
      input: {
        toolName: "search",
        arguments: { query: "demo" },
      },
    });
  });

  it("dispatches encoded dynamic MCP subtools to the original server and source", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      arguments: { query: "demo" },
    });
    const serverName = "@scope/filesystem server";
    const source = "codex";
    const mcpToolName = "search_docs";
    const toolName = `mcp.${encodeMcpToolServerName(`${source}:${serverName}`)}.tool.${encodeMcpToolServerName(mcpToolName)}`;

    await executeCapabilityStep(
      {
        id: "mcp-call-encoded",
        title: "Call encoded MCP",
        assignedAgentKind: "commander",
        toolName,
        requiredCapabilities: ["local_search"],
        inputContextKeys: ["arguments"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: toolName,
          permissionLevel: "read",
          summary: "Search docs MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: serverName,
            mcpSource: source,
            mcpAction: "callTool",
            mcpToolName,
          },
        }],
      },
    );

    expect(mcpCall).toHaveBeenCalledWith(expect.objectContaining({
      serverName,
      source,
      action: "callTool",
      toolName: mcpToolName,
      arguments: { query: "demo" },
    }));
  });

  it("passes literal toolInput object as MCP subtool arguments", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({});
    const toolName = `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("search")}`;

    await executeCapabilityStep(
      {
        id: "mcp-call-input",
        title: "Call MCP with input",
        assignedAgentKind: "commander",
        toolName,
        toolInput: {
          query: "demo",
        },
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: toolName,
          permissionLevel: "read",
          summary: "Search filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        }],
      },
    );

    expect(mcpCall).toHaveBeenCalledWith(expect.objectContaining({
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      toolName: "search",
      arguments: { query: "demo" },
    }));
  });

  it("unwraps nested input object as MCP subtool arguments", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      input: { query: "demo", limit: 3 },
    });
    const toolName = `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("search")}`;

    await executeCapabilityStep(
      {
        id: "mcp-call-nested-input",
        title: "Call MCP with nested input",
        assignedAgentKind: "commander",
        toolName,
        inputContextKeys: ["input"],
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: toolName,
          permissionLevel: "read",
          summary: "Search filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        }],
      },
    );

    expect(mcpCall).toHaveBeenCalledWith(expect.objectContaining({
      serverName: "filesystem",
      source: "javis",
      action: "callTool",
      toolName: "search",
      arguments: { query: "demo", limit: 3 },
    }));
  });

  it("unwraps parameters object as MCP subtool arguments", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      parameters: { query: "demo", limit: 5 },
    });
    const toolName = `mcp.${encodeMcpToolServerName("javis:filesystem")}.tool.${encodeMcpToolServerName("search")}`;

    await executeCapabilityStep(
      {
        id: "mcp-call-parameters",
        title: "Call MCP with parameters",
        assignedAgentKind: "commander",
        toolName,
        inputContextKeys: ["parameters"],
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: toolName,
          permissionLevel: "read",
          summary: "Search filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        }],
      },
    );

    expect(mcpCall).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { query: "demo", limit: 5 },
    }));
  });

  it("rejects generic MCP callTool descriptors without allowlisted tool metadata", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      toolName: "search",
      arguments: { query: "demo" },
    });

    await expect(executeCapabilityStep(
      {
        id: "mcp-call-generic",
        title: "Call generic MCP",
        assignedAgentKind: "commander",
        toolName: "mcp.filesystem.callTool",
        requiredCapabilities: ["local_search"],
        inputContextKeys: ["toolName", "arguments"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: "mcp.filesystem.callTool",
          permissionLevel: "read",
          summary: "Call filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
        }],
      },
    )).rejects.toThrow("missing allowlisted mcpToolName metadata");

    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("rejects generic MCP callTool descriptors even when metadata names a tool", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({
      arguments: { query: "demo" },
    });

    await expect(executeCapabilityStep(
      {
        id: "mcp-call-generic-with-metadata",
        title: "Call generic MCP",
        assignedAgentKind: "commander",
        toolName: "mcp.filesystem.callTool",
        requiredCapabilities: ["local_search"],
        inputContextKeys: ["arguments"],
        dependsOn: [],
        successCriteria: "MCP result is returned.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: "mcp.filesystem.callTool",
          permissionLevel: "read",
          summary: "Call filesystem MCP.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpAction: "callTool",
            mcpToolName: "search",
          },
        }],
      },
    )).rejects.toThrow("must encode the allowlisted mcpToolName");

    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("does not dispatch tools for non-owner agents", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const context = createSharedTaskContext({});

    await expect(
      executeCapabilityStep(
        {
          id: "wrong-owner",
          title: "Wrong owner",
          assignedAgentKind: "commander",
          toolName: "file.scanMarkdownDocuments",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Should not run.",
        },
        context,
        {
          fileTool: { scanMarkdownDocuments },
        },
      ),
    ).rejects.toThrow("not owned by agent commander");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
  });

  it("does not dispatch explicit toolName steps when the tool descriptor is disabled", async () => {
    const search = vi.fn<NonNullable<MemoryTool["search"]>>(async () => []);
    const context = createSharedTaskContext({
      query: "prior decision",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "disabled-memory",
          title: "Search memory",
          assignedAgentKind: "commander",
          toolName: "memory.search",
          requiredCapabilities: ["memory_search"],
          dependsOn: [],
          inputContextKeys: ["query"],
          successCriteria: "Memory searched.",
        },
        context,
        {
          memoryTool: { search },
        },
        {
          availableToolDescriptors: [],
        },
      ),
    ).rejects.toThrow("Tool memory.search is not available.");

    expect(search).not.toHaveBeenCalled();
  });

  it("does not resolve capability-only steps through disabled tool descriptors", async () => {
    const search = vi.fn<NonNullable<MemoryTool["search"]>>(async () => []);
    const context = createSharedTaskContext({
      query: "prior decision",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "disabled-memory-capability",
          title: "Search memory",
          assignedAgentKind: "commander",
          capability: "memory_search",
          requiredCapabilities: ["memory_search"],
          dependsOn: [],
          inputContextKeys: ["query"],
          successCriteria: "Memory searched.",
        },
        context,
        {
          memoryTool: { search },
        },
        {
          availableToolDescriptors: [],
        },
      ),
    ).rejects.toThrow('No tool registered for capability "memory_search"');

    expect(search).not.toHaveBeenCalled();
  });

  it("does not resolve capability-only steps to tools owned by another agent", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const context = createSharedTaskContext({});

    await expect(
      executeCapabilityStep(
        {
          id: "wrong-capability-owner",
          title: "Wrong capability owner",
          assignedAgentKind: "commander",
          capability: "file_scan",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Should not run.",
        },
        context,
        {
          fileTool: { scanMarkdownDocuments },
        },
      ),
    ).rejects.toThrow('owned by agent "commander"');

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
  });

  it("dispatches read and preview descriptors that are exposed to Commander DAG plans", async () => {
    const planPdfOrganization = vi.fn<NonNullable<FileTool["planPdfOrganization"]>>(async () => ({
      approvalId: "preview-1",
      directoryPath: "Downloads",
      fileCount: 0,
      dryRun: {
        operation: "plan_pdf_organization",
        affectedPaths: [],
        riskSummary: "No files.",
        reversible: true,
      },
    }));
    const runReadOnlyCommand = vi.fn<ShellTool["runReadOnlyCommand"]>(async () => ({
      command: "git status --short",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const followCandidateLinks = vi.fn<NonNullable<BrowserTool["followCandidateLinks"]>>(async () => ({
      followed: [],
      skipped: 0,
    }));
    const list = vi.fn<WorkspaceTool["list"]>(async () => []);
    const scaffold = vi.fn<NonNullable<WorkspaceTool["scaffold"]>>(async () => ({ id: "demo-workspace" }));

    await executeCapabilityStep(
      {
        id: "plan-pdf",
        title: "Plan PDFs",
        assignedAgentKind: "file",
        toolName: "file.planPdfOrganization",
        requiredCapabilities: ["file_scan"],
        dependsOn: [],
        inputContextKeys: ["taskId"],
        successCriteria: "PDF plan created.",
      },
      createSharedTaskContext({ taskId: "task-1" }),
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          planPdfOrganization,
        },
      },
    );

    await executeCapabilityStep(
      {
        id: "shell-status",
        title: "Run git status",
        assignedAgentKind: "code",
        toolName: "shell.runReadOnlyCommand",
        requiredCapabilities: ["shell_readonly"],
        dependsOn: [],
        inputContextKeys: ["program", "args"],
        successCriteria: "Command completed.",
      },
      createSharedTaskContext({ program: "git", args: ["status", "--short"] }),
      {
        shellTool: { runReadOnlyCommand },
      },
    );

    await executeCapabilityStep(
      {
        id: "follow-links",
        title: "Follow links",
        assignedAgentKind: "browser",
        toolName: "browser.followCandidateLinks",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["candidateLinks", "maxFollow"],
        successCriteria: "Links followed.",
      },
      createSharedTaskContext({ candidateLinks: [], maxFollow: 2 }),
      {
        browserTool: createBrowserTool({ followCandidateLinks }),
      },
    );

    await executeCapabilityStep(
      {
        id: "workspace-list",
        title: "List workspaces",
        assignedAgentKind: "workspace",
        toolName: "workspace.list",
        requiredCapabilities: ["workspace_list"],
        dependsOn: [],
        successCriteria: "Workspaces listed.",
      },
      createSharedTaskContext({}),
      {
        workspaceTool: { list, scaffold, create: vi.fn(), delete: vi.fn() },
      },
    );

    await executeCapabilityStep(
      {
        id: "workspace-scaffold",
        title: "Scaffold workspace",
        assignedAgentKind: "workspace",
        toolName: "workspace.scaffold",
        requiredCapabilities: ["workspace_scaffold"],
        dependsOn: [],
        inputContextKeys: ["description"],
        successCriteria: "Workspace scaffolded.",
      },
      createSharedTaskContext({ description: "knowledge workspace" }),
      {
        workspaceTool: { list, scaffold, create: vi.fn(), delete: vi.fn() },
      },
    );

    expect(planPdfOrganization).toHaveBeenCalledWith("task-1");
    expect(runReadOnlyCommand).toHaveBeenCalledWith({
      program: "git",
      args: ["status", "--short"],
      workspacePath: undefined,
    });
    expect(followCandidateLinks).toHaveBeenCalledWith({
      candidateLinks: [],
      urlPattern: undefined,
      maxFollow: 2,
    });
    expect(list).toHaveBeenCalledWith();
    expect(scaffold).toHaveBeenCalledWith("knowledge workspace");
  });

  it("dispatches explicit user image scans through the FileTool contract", async () => {
    const scanUserImages = vi.fn<NonNullable<FileTool["scanUserImages"]>>(async () => [{
      name: "photo.png",
      path: "C:/Users/example/Pictures/photo.png",
      isDir: false,
      extension: "png",
    }]);
    const context = createSharedTaskContext({ maxResults: 3 });

    const result = await executeCapabilityStep(
      {
        id: "scan-images",
        title: "Scan images",
        assignedAgentKind: "computer",
        toolName: "file.scanUserImages",
        requiredCapabilities: ["image_scan"],
        dependsOn: [],
        inputContextKeys: ["maxResults"],
        outputContextKey: "images",
        successCriteria: "Images scanned.",
      },
      context,
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          scanUserImages,
        },
      },
    );

    expect(scanUserImages).toHaveBeenCalledWith({ maxResults: 3 });
    expect(result.toolName).toBe("file.scanUserImages");
    expect(context.get("images")).toEqual(result.output);
  });

  it("dispatches local memory search through the MemoryTool contract", async () => {
    const search = vi.fn<MemoryTool["search"]>(async () => [{
      id: "mem-1",
      fact: "Javis keeps Agent memory local.",
      kind: "design_principle",
      tags: ["memory"],
      confidence: 0.95,
      importance: 5,
      updatedAt: 1_700_000_000_000,
    }]);
    const context = createSharedTaskContext({
      query: "previous memory decision",
      scopeType: "workspace",
      scopeId: "workspace:abc",
      limit: 3,
    });

    const result = await executeCapabilityStep(
      {
        id: "search-memory",
        title: "Search memory",
        assignedAgentKind: "commander",
        toolName: "memory.search",
        requiredCapabilities: ["memory_search"],
        dependsOn: [],
        inputContextKeys: ["query", "scopeType", "scopeId", "limit"],
        outputContextKey: "memoryResults",
        successCriteria: "Relevant memory was searched.",
      },
      context,
      {
        memoryTool: { search },
      },
    );

    expect(search).toHaveBeenCalledWith({
      query: "previous memory decision",
      tags: undefined,
      kind: undefined,
      scopeType: "workspace",
      scopeId: "workspace:abc",
      limit: 3,
    });
    expect(result.toolName).toBe("memory.search");
    expect(context.get("memoryResults")).toEqual(result.output);
  });

  it("forwards optional browser request parameters through explicit tool dispatch", async () => {
    const navigate = vi.fn<BrowserTool["navigate"]>(async () => ({
      url: "https://example.test",
      title: "",
      status: 200,
      loadState: "load",
    }));
    const screenshot = vi.fn<BrowserTool["screenshot"]>(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
      capturedAt: "2026-06-08T00:00:00.000Z",
    }));
    const getContent = vi.fn<BrowserTool["getContent"]>(async () => ({
      content: "",
      url: "https://example.test",
      title: "",
    }));
    const browserTool = createBrowserTool({ navigate, screenshot, getContent });

    await executeCapabilityStep(
      {
        id: "navigate",
        title: "Navigate",
        assignedAgentKind: "browser",
        toolName: "browser.navigate",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["url", "waitForSelector", "timeoutMs"],
        successCriteria: "Navigated.",
      },
      createSharedTaskContext({
        url: "https://example.test",
        waitForSelector: "main",
        timeoutMs: 5000,
      }),
      { browserTool },
    );

    await executeCapabilityStep(
      {
        id: "screenshot",
        title: "Screenshot",
        assignedAgentKind: "browser",
        toolName: "browser.screenshot",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["selector", "fullPage", "format", "quality"],
        successCriteria: "Screenshot captured.",
      },
      createSharedTaskContext({
        selector: "#hero",
        fullPage: true,
        format: "jpeg",
        quality: 80,
      }),
      { browserTool },
    );

    await executeCapabilityStep(
      {
        id: "content",
        title: "Content",
        assignedAgentKind: "browser",
        toolName: "browser.getContent",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        inputContextKeys: ["selector", "format", "maxLength"],
        successCriteria: "Content extracted.",
      },
      createSharedTaskContext({
        selector: "article",
        format: "markdown",
        maxLength: 1234,
      }),
      { browserTool },
    );

    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test",
      waitForSelector: "main",
      timeoutMs: 5000,
    });
    expect(screenshot).toHaveBeenCalledWith({
      selector: "#hero",
      fullPage: true,
      format: "jpeg",
      quality: 80,
    });
    expect(getContent).toHaveBeenCalledWith({
      selector: "article",
      format: "markdown",
      maxLength: 1234,
    });
  });

  it("dispatches explicit installed app scans through the FileTool contract", async () => {
    const scanInstalledApps = vi.fn<NonNullable<FileTool["scanInstalledApps"]>>(async () => [{
      name: "Calculator",
      path: "C:/Windows/System32/calc.exe",
    }]);
    const context = createSharedTaskContext({});

    const result = await executeCapabilityStep(
      {
        id: "scan-apps",
        title: "Scan apps",
        assignedAgentKind: "computer",
        toolName: "file.scanInstalledApps",
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        outputContextKey: "apps",
        successCriteria: "Apps scanned.",
      },
      context,
      {
        fileTool: {
          scanMarkdownDocuments: vi.fn(async () => []),
          scanInstalledApps,
        },
      },
    );

    expect(scanInstalledApps).toHaveBeenCalledWith();
    expect(result.toolName).toBe("file.scanInstalledApps");
    expect(context.get("apps")).toEqual(result.output);
  });

  it("dispatches explicit desktop UI inspection through the ComputerTool contract", async () => {
    const inspectUi = vi.fn<ComputerTool["inspectUi"]>(async () => ({
      tree: "Window > Button",
      nodeCount: 2,
    }));
    const context = createSharedTaskContext({ windowHandle: 42, maxDepth: 4 });

    const result = await executeCapabilityStep(
      {
        id: "inspect-ui",
        title: "Inspect UI tree",
        assignedAgentKind: "computer",
        toolName: "computer.inspectUi",
        requiredCapabilities: ["desktop_ui_tree"],
        dependsOn: [],
        inputContextKeys: ["windowHandle", "maxDepth"],
        outputContextKey: "uiTree",
        successCriteria: "UI tree inspected.",
      },
      context,
      {
        computerTool: {
          searchLocalDocuments: vi.fn(async () => []),
          listDirectory: vi.fn(async () => []),
          screenshot: vi.fn(async () => ({
            dataUrl: "data:image/png;base64,AA==",
            width: 1,
            height: 1,
            capturedAt: "2026-06-08T00:00:00.000Z",
          })),
          listWindows: vi.fn(async () => ({ windows: [] })),
          inspectUi,
          focusWindow: vi.fn(),
          moveMouse: vi.fn(),
          click: vi.fn(),
          type: vi.fn(),
          keyCombo: vi.fn(),
          scroll: vi.fn(),
          invokeUi: vi.fn(),
          setUiValue: vi.fn(),
          wait: vi.fn(async () => ({ waited: 1 })),
          openPath: vi.fn(async () => ({ opened: true })),
        },
      },
    );

    expect(inspectUi).toHaveBeenCalledWith({ windowHandle: 42, maxDepth: 4, maxNodes: undefined });
    expect(result.toolName).toBe("computer.inspectUi");
    expect(context.get("uiTree")).toEqual(result.output);
  });

  it("does not dispatch explicit confirmed-write tools without Core approval", async () => {
    const writeText = vi.fn();
    const context = createSharedTaskContext({
      targetPath: "notes.txt",
      content: "hello",
      approvalId: "renderer-supplied",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "write-notes",
          title: "Write notes",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          requiredCapabilities: ["file_execute"],
          dependsOn: [],
          inputContextKeys: ["targetPath", "content", "approvalId"],
          successCriteria: "File written.",
        },
        context,
        {
          fileTool: {
            scanMarkdownDocuments: vi.fn(async () => []),
            writeText,
          },
        },
      ),
    ).rejects.toThrow("requires confirmed_write approval");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not dispatch capability-resolved confirmed-write tools without Core approval", async () => {
    const writeText = vi.fn();
    const context = createSharedTaskContext({
      targetPath: "notes.txt",
      content: "hello",
      approvalId: "renderer-supplied",
    });

    await expect(
      executeCapabilityStep(
        {
          id: "write-notes",
          title: "Write notes",
          assignedAgentKind: "file",
          capability: "file_execute",
          requiredCapabilities: ["file_execute"],
          dependsOn: [],
          inputContextKeys: ["targetPath", "content", "approvalId"],
          successCriteria: "File written.",
        },
        context,
        {
          fileTool: {
            scanMarkdownDocuments: vi.fn(async () => []),
            writeText,
          },
        },
      ),
    ).rejects.toThrow("requires confirmed_write approval");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("records daily-reminder confirmed-write steps as unsupported instead of creating tasks", async () => {
    const createTask = vi.fn<SchedulerTool["createTask"]>(async (draft) => ({
      ...draft,
      id: "scheduled-task-1",
      enabled: true,
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      schedulerTool: { createTask },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-daily-reminder-test",
      userGoal: "remind me every day at 8",
      workflowId: "daily-reminder",
    });

    expect(createTask).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "persist-reminder")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("persist-reminder");
  });

  it("uses the structured trend tool for hot-list research workflows", async () => {
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 20,
      complete: true,
      warnings: [],
      diagnostics: [{
        provider: "mirror",
        sourceUrl: "https://example.test/mirror",
        requestedLimit: 20,
        startedAt: "2026-06-10T00:00:00.000Z",
        finishedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 0,
        status: "failed",
        httpStatus: 503,
        errorKind: "http",
        error: "HTTP 503",
      }, {
        provider: "weibo",
        sourceUrl: "https://weibo.com/ajax/side/hotSearch",
        requestedLimit: 20,
        startedAt: "2026-06-10T00:00:00.000Z",
        finishedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 0,
        status: "completed",
        httpStatus: 200,
        itemCount: 2,
      }],
      items: [
        { rank: 1, title: "AI 新闻", hotScore: 123 },
        { rank: 2, title: "第二条", hotScore: 99 },
      ],
    }));
    const fetchWebSource = vi.fn(async (request: { url: string }) => ({
      url: request.url,
      title: "detail",
      excerpt: "detail",
      fetchedAt: "2026-06-10T00:00:01.000Z",
      provider: "fixture",
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      trendTool: { fetchHotList },
      webTool: { fetchWebSource },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-weibo-hot-list",
      userGoal: "总结今天微博热搜榜前20",
      workflowId: "research-trending-topics",
    });

    expect(fetchHotList).toHaveBeenCalledWith({
      provider: "weibo",
      fallbackProviders: undefined,
      limit: 20,
    });
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.researchReport?.title).toBe("Weibo trend top 20");
    expect(finalSnapshot?.researchReport?.rows.map((row) => row.claim)).toEqual([
      "1. AI 新闻",
      "2. 第二条",
    ]);
    expect(finalSnapshot?.researchReport?.rows[0]?.sourceProvider).toBe("weibo");
    expect(finalSnapshot?.researchReport?.summary).toContain("Diagnostics: 1 completed, 1 failed.");
    expect(finalSnapshot?.researchReport?.unknowns).toContain("Trend provider mirror failed: HTTP 503; HTTP 503");
  });

  it("records browser-test confirmed-write steps as unsupported instead of running tests", async () => {
    const runTest = vi.fn<NonNullable<BrowserTool["runTest"]>>(async () => ({
      passed: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      duration: 1,
    }));
    const browserTool: BrowserTool = {
      navigate: vi.fn(async () => ({ url: "https://example.test", title: "", status: 200, loadState: "load" })),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
      getContent: vi.fn(async () => ({ content: "", url: "https://example.test", title: "" })),
      click: vi.fn(async () => ({ selector: "button", clicked: true })),
      type: vi.fn(async () => ({ selector: "input", typed: true, value: "" })),
      evaluate: vi.fn(async () => ({ result: "", type: "undefined" })),
      runTest,
    };
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      browserTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-browser-test",
      userGoal: "run playwright tests",
      workflowId: "browser-test",
    });

    expect(runTest).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "run-tests")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("run-tests");
  });

  it("records generic computer-use confirmed-write steps as unsupported instead of pretending completion", async () => {
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
    };
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-computer-use",
      userGoal: "open calculator",
      workflowId: "computer-use",
    });

    expect(computerTool.click).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.plan.find((step) => step.id === "execute-actions")?.status).toBe("skipped");
    expect(finalSnapshot?.commanderMessage).toContain("execute-actions");
  });

  it("passes enabled tool descriptors into Commander DAG planning and refuses disabled returned tools", async () => {
    const search = vi.fn<NonNullable<MemoryTool["search"]>>(async () => []);
    const commanderTool: CommanderTool = {
      plan: vi.fn(async (request) => {
        expect(request.availableTools?.some((tool: { name: string }) => tool.name === "memory.search")).toBe(false);
        return {
          title: "Disabled memory",
          reasoning: "Planner should not use memory.",
          steps: [{
            id: "search-memory",
            title: "Search memory anyway",
            assignedAgentKind: "commander",
            toolName: "memory.search",
            requiredCapabilities: ["memory_search"],
            dependsOn: [],
            inputContextKeys: ["userGoal"],
            successCriteria: "Memory searched.",
          }],
        };
      }),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      memoryTool: { search },
      taskId: "task-disabled-memory-dag",
      userGoal: "search prior memory",
      availableToolDescriptors: [],
    });

    expect(search).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    expect(JSON.stringify(emitted)).toContain("Tool memory.search is not available");
  });

  it("does not let read-current-project bypass a disabled file scan descriptor", async () => {
    const scanMarkdownDocuments = vi.fn<FileTool["scanMarkdownDocuments"]>(async () => []);
    const inspectProject = vi.fn<ProjectTool["inspectProject"]>(async () => ({
      workspacePath: "E:/Javis",
      scripts: [],
    }));
    const runReadOnlyCommand = vi.fn<ShellTool["runReadOnlyCommand"]>(async () => ({
      command: "git status --short",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const { controller, emitted } = createTestController();

    await runReadCurrentProjectWorkflow({
      controller,
      fileTool: { scanMarkdownDocuments },
      projectTool: { inspectProject },
      shellTool: { runReadOnlyCommand },
      taskId: "task-disabled-file-scan-read-project",
      userGoal: "read current project",
      availableToolDescriptors: initialToolDescriptors.filter(
        (descriptor) => descriptor.name !== "file.scanMarkdownDocuments",
      ),
    });

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(JSON.stringify(emitted)).toContain("Tool file.scanMarkdownDocuments is not available");
  });

  it("allows Commander DAG plans to use enabled dynamic MCP descriptors", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async ({ availableAgents }: Parameters<CommanderTool["plan"]>[0]) => {
        expect(availableAgents.find((agent) => agent.kind === "commander")?.allowedToolNames)
          .toContain("mcp.filesystem.listTools");
        return {
          title: "List MCP tools",
          reasoning: "Use the enabled MCP server.",
          steps: [{
            id: "list-mcp-tools",
            title: "List filesystem MCP tools",
            assignedAgentKind: "commander",
            toolName: "mcp.filesystem.listTools",
            requiredCapabilities: ["local_search"],
            dependsOn: [],
            successCriteria: "MCP tools are listed.",
          }],
        };
      }),
    };
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({
      tools: [{ name: "read_file" }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      mcpTool: { call: mcpCall },
      taskId: "task-dynamic-mcp",
      userGoal: "list filesystem MCP tools",
      availableToolDescriptors: [{
        name: "mcp.filesystem.listTools",
        permissionLevel: "read",
        summary: "List filesystem MCP tools.",
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
      }],
    });

    expect(mcpCall).toHaveBeenCalledWith({
      serverName: "filesystem",
      action: "listTools",
      toolName: undefined,
      arguments: undefined,
      input: {},
      timeoutMs: 5_000,
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
  });

  it("caps MCP subtools exposed to ReAct decisions", async () => {
    const encodedServer = encodeMcpToolServerName("javis:filesystem");
    const hiddenToolName = `mcp.${encodedServer}.tool.${encodeMcpToolServerName("read_08")}`;
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "React with MCP",
        reasoning: "Use a local search capability.",
        steps: [{
          id: "react-search",
          title: "Search with available MCP tools",
          assignedAgentKind: "commander",
          capability: "local_search",
          executionMode: "react" as const,
          dependsOn: [],
          successCriteria: "Search is complete.",
        }],
      })),
    };
    const reactRequests: ReActDecisionRequest[] = [];
    const reactDecideNext = vi.fn(async (request: ReActDecisionRequest) => {
      reactRequests.push(request);
      return {
        status: "completed" as const,
        reason: "Tool list inspected.",
        output: { ok: true },
      };
    });
    const descriptors = Array.from({ length: 12 }, (_, index): ToolDescriptor => {
      const tool = `read_${String(index).padStart(2, "0")}`;
      return {
        name: `mcp.${encodedServer}.tool.${encodeMcpToolServerName(tool)}`,
        permissionLevel: "read",
        summary: `Read MCP item ${index}.`,
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
        metadata: {
          mcpServerName: "filesystem",
          mcpSource: "javis",
          mcpAction: "callTool",
          mcpToolName: tool,
        },
      };
    });
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      reactDecideNext,
      taskId: "task-react-mcp-cap",
      userGoal: "search with MCP",
      availableToolDescriptors: [
        {
          name: `mcp.${encodedServer}.listTools`,
          permissionLevel: "read",
          summary: "Discovery only: list filesystem MCP tools.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "listTools",
          },
        },
        ...descriptors,
      ],
    });

    expect(reactRequests).toHaveLength(1);
    expect(reactRequests[0].availableTools.map((tool) => tool.name)).toEqual([
      `mcp.${encodedServer}.listTools`,
      ...descriptors.slice(0, 8).map((descriptor) => descriptor.name),
    ]);
    expect(reactRequests[0].availableTools.some((tool) => tool.name === hiddenToolName)).toBe(false);
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
  });

  it("redacts image data URLs from computer-use step summaries", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.invokeUi",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
    };
    const { controller, emitted } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-summary-redaction",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ onStep }) => {
        const step = {
          stepIndex: 0,
          screenshotDataUrl: "data:image/png;base64,SCREEN_SHOULD_NOT_SURVIVE==",
          observation: "Saw data:image/png;base64,OBS_SHOULD_NOT_SURVIVE==",
          action: {
            tool: "computer.invokeUi",
            params: {
              selector: {
                windowHandle: 42,
                name: "Save data:image/png;base64,SELECTOR_SHOULD_NOT_SURVIVE==",
              },
            },
          },
          target: "Target data:image/png;base64,TARGET_SHOULD_NOT_SURVIVE==",
          confidence: "high",
          error: "Failed data:image/png;base64,ERROR_SHOULD_NOT_SURVIVE==",
          trace: {
            startedAt: "2026-06-08T00:00:00.000Z",
            localVision: {
              observationId: "obs-1",
              screenshotId: "shot-1",
              enabled: true,
              used: false,
              mode: "disabled",
              detectionCount: 0,
              promptCandidateCount: 0,
              fullScreenshotVlmCalled: true,
              cropVlmCalled: false,
              fullScreenshotVlmSkipped: false,
              consecutiveTimeouts: 2,
              consecutiveErrors: 0,
              consecutiveActionFailures: 0,
              disabledReason: "timeout",
              selectedCandidateSource: ["uia", "yolo"],
              actionType: "computer.invokeUi",
              actionRisk: "medium",
              actionSucceeded: false,
              fallbackReason: "uia_missing",
            },
          },
        };
        onStep?.(step);
        return [step];
      },
    });

    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("SHOULD_NOT_SURVIVE");
    expect(serialized).toContain("[redacted:image data URL:");
    expect(serialized).toContain("本地视觉：disabled");
    expect(serialized).toContain("检测 0");
    expect(serialized).toContain("候选 0");
    expect(serialized).toContain("连续超时 2");
    expect(serialized).toContain("已禁用：timeout");
    const computerTraceStep = emitted
      .flatMap((snapshot) => snapshot.executionTrace?.steps ?? [])
      .find((traceStep) => traceStep.stepId === "use-computer:computer-1");
    expect(computerTraceStep).toEqual(expect.objectContaining({
      agentKind: "computer",
      toolName: "computer.invokeUi",
      status: "failed",
      localVision: expect.objectContaining({
        mode: "disabled",
        detectionCount: 0,
        promptCandidateCount: 0,
        fullScreenshotVlmCalled: true,
        cropVlmCalled: false,
        fullScreenshotVlmSkipped: false,
        consecutiveTimeouts: 2,
        disabledReason: "timeout",
        selectedCandidateSource: ["uia", "yolo"],
        actionType: "computer.invokeUi",
        actionRisk: "medium",
        actionSucceeded: false,
        fallbackReason: "uia_missing",
      }),
    }));
  });

  it("stores sanitized Computer Use steps in shared workflow context", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation and verify context.",
        steps: [
          {
            id: "use-computer",
            title: "Use computer",
            assignedAgentKind: "computer",
            toolName: "computer.type",
            requiredCapabilities: ["computer_use"],
            outputContextKey: "computerResult",
            dependsOn: [],
            successCriteria: "Use the target UI.",
          },
          {
            id: "verify-context",
            title: "Verify computer context",
            assignedAgentKind: "verifier",
            toolName: "verifier.check",
            requiredCapabilities: ["verification"],
            inputContextKeys: ["computerResult"],
            dependsOn: ["use-computer"],
            successCriteria: "Computer context is sanitized.",
          },
        ],
      })),
    };
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "sanitized",
      detail: "Computer context was sanitized.",
    }));
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
    };
    const { controller } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      verifierTool: { check: verifierCheck },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-context-redaction",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ onStep }) => {
        const step = {
          stepIndex: 0,
          screenshotDataUrl: "data:image/png;base64,SCREEN_SHOULD_NOT_SURVIVE==",
          observation: "Saw data:image/png;base64,OBS_SHOULD_NOT_SURVIVE==",
          action: {
            tool: "computer.type",
            params: {
              text: "secret typed text",
              clearBefore: true,
            },
          },
          target: "Target data:image/png;base64,TARGET_SHOULD_NOT_SURVIVE==",
          confidence: "high",
          result: {
            note: "Result data:image/png;base64,RESULT_SHOULD_NOT_SURVIVE==",
          },
          trace: {
            startedAt: "2026-06-08T00:00:00.000Z",
          },
        };
        onStep?.(step);
        return [step];
      },
    });

    expect(verifierCheck).toHaveBeenCalledOnce();
    const serializedVerifierInput = JSON.stringify(verifierCheck.mock.calls[0]?.[0]);
    expect(serializedVerifierInput).not.toContain("data:image");
    expect(serializedVerifierInput).not.toContain("SHOULD_NOT_SURVIVE");
    expect(serializedVerifierInput).not.toContain("secret typed text");
    expect(serializedVerifierInput).toContain("[redacted:image data URL:");
    expect(serializedVerifierInput).toContain("[redacted:17 chars]");
  });

  it("redacts image data URLs from computer-use permission summaries", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.click",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-computer-permission-redaction" })),
    };
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });
    const denyNextPermission = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const handler = [...permissionHandlers.values()][0];
        if (handler) {
          await handler("denied");
          return;
        }
        await Promise.resolve();
      }
      throw new Error("permission handler was not registered");
    };

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-permission-redaction",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ approveAction }) => {
        const approval = approveAction({
          tool: "computer.click",
          params: {
            x: "data:image/png;base64,X_SHOULD_NOT_SURVIVE==",
            y: "data:image/png;base64,Y_SHOULD_NOT_SURVIVE==",
          },
        });
        await denyNextPermission();
        await approval;
        return [];
      },
    });

    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("X_SHOULD_NOT_SURVIVE");
    expect(serialized).not.toContain("Y_SHOULD_NOT_SURVIVE");
    expect(serialized).toContain("[redacted:image data URL:");
  });

  it("forces single-action approval when the computer-use loop marks an action fresh-only", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.click",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const approveAction = vi.fn<NonNullable<ComputerTool["approveAction"]>>(async (
      _action,
      approvalId,
      taskId,
      sessionWide,
    ) => ({ approvalId, taskId, sessionWide }));
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
      approveAction,
    };
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-fresh-only",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ approveAction }) => {
        const approval = approveAction(
          { tool: "computer.click", params: { x: 10, y: 20 } },
          { requiresFreshApproval: true, screenshotDataUrl: "data:image/png;base64,PREVIEW==" },
        );
        for (let attempt = 0; attempt < 10; attempt++) {
          const handler = [...permissionHandlers.values()][0];
          if (handler) {
            await handler("approved_always");
            break;
          }
          await Promise.resolve();
        }
        await approval;
        return [];
      },
    });

    const permissionSnapshot = emitted.find((snapshot) => snapshot.permissionRequest);
    expect(permissionSnapshot?.permissionRequest?.allowAlways).toBe(false);
    expect(permissionSnapshot?.permissionRequest?.writeRiskLevel).toBe("dangerous");
    expect(permissionSnapshot?.permissionRequest?.screenshotDataUrl).toBe("data:image/png;base64,PREVIEW==");
    expect(approveAction).toHaveBeenCalledWith(
      { tool: "computer.click", params: { x: 10, y: 20 } },
      permissionSnapshot?.permissionRequest?.id,
      "task-computer-fresh-only",
      false,
    );
  });

  it("uses the computer-use loop approval timeout for permission cleanup", async () => {
    vi.useFakeTimers();
    try {
      const commanderTool: CommanderTool = {
        plan: vi.fn(async () => ({
          title: "Computer use",
          reasoning: "Use computer automation.",
          steps: [{
            id: "use-computer",
            title: "Use computer",
            assignedAgentKind: "computer",
            toolName: "computer.click",
            requiredCapabilities: ["computer_use"],
            dependsOn: [],
            successCriteria: "Use the target UI.",
          }],
        })),
      };
      const computerTool: ComputerTool = {
        searchLocalDocuments: vi.fn(async () => []),
        listDirectory: vi.fn(async () => []),
        screenshot: vi.fn(async () => ({
          dataUrl: "data:image/png;base64,AA==",
          width: 1,
          height: 1,
          capturedAt: "2026-06-08T00:00:00.000Z",
        })),
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
        approveAction: vi.fn(async (_action, approvalId, taskId, sessionWide) => ({
          approvalId,
          taskId,
          sessionWide,
        })),
      };
      const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

      const runPromise = runCommanderDagTask({
        controller,
        commanderTool,
        computerTool,
        fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
        taskId: "task-computer-approval-timeout",
        userGoal: "use the computer",
        computerUseLoopRunner: async ({ approveAction }) => {
          const approval = approveAction(
            { tool: "computer.click", params: { x: 10, y: 20 } },
            { timeoutMs: 25 },
          );
          const approvalRejection = expect(approval).rejects.toThrow("timed out");
          await waitForPermissionHandler(permissionHandlers);
          await vi.advanceTimersByTimeAsync(25);
          await approvalRejection;
          return [];
        },
      });

      await runPromise;

      expect(permissionHandlers.size).toBe(0);
      expect(emitted.some((snapshot) =>
        snapshot.logs.some((log) =>
          log.title === "timeout" &&
          log.detail?.includes("Computer Use approval timed out")
        )
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows task-level approval for non-sensitive Computer Use setUiValue actions", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.setUiValue",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const approveAction = vi.fn<NonNullable<ComputerTool["approveAction"]>>(async (
      _action,
      approvalId,
      taskId,
      sessionWide,
    ) => ({ approvalId, taskId, sessionWide }));
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
      approveAction,
    };
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-set-value-lease",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ approveAction }) => {
        const approval = approveAction({
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "firstName", name: "First name" },
            value: "Alice",
          },
        });
        for (let attempt = 0; attempt < 10; attempt++) {
          const handler = [...permissionHandlers.values()][0];
          if (handler) {
            await handler("approved_always");
            break;
          }
          await Promise.resolve();
        }
        await approval;
        return [];
      },
    });

    const permissionSnapshot = emitted.find((snapshot) => snapshot.permissionRequest);
    expect(permissionSnapshot?.permissionRequest?.allowAlways).not.toBe(false);
    expect(permissionSnapshot?.permissionRequest?.writeRiskLevel).toBe("risky");
    expect(approveAction).toHaveBeenCalledWith(
      {
        tool: "computer.setUiValue",
        params: {
          selector: { windowHandle: 42, automationId: "firstName", name: "First name" },
          value: "Alice",
        },
      },
      permissionSnapshot?.permissionRequest?.id,
      "task-computer-set-value-lease",
      true,
    );
  });

  it("forces single-action approval for sensitive Computer Use setUiValue actions", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.setUiValue",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const approveAction = vi.fn<NonNullable<ComputerTool["approveAction"]>>(async (
      _action,
      approvalId,
      taskId,
      sessionWide,
    ) => ({ approvalId, taskId, sessionWide }));
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
      approveAction,
    };
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-set-value-sensitive",
      userGoal: "use the computer",
      computerUseLoopRunner: async ({ approveAction }) => {
        const approval = approveAction({
          tool: "computer.setUiValue",
          params: {
            selector: { windowHandle: 42, automationId: "notes", name: "Notes" },
            value: "sk-demo-secret",
          },
        });
        for (let attempt = 0; attempt < 10; attempt++) {
          const handler = [...permissionHandlers.values()][0];
          if (handler) {
            await handler("approved_always");
            break;
          }
          await Promise.resolve();
        }
        await approval;
        return [];
      },
    });

    const permissionSnapshot = emitted.find((snapshot) => snapshot.permissionRequest);
    expect(permissionSnapshot?.permissionRequest?.allowAlways).toBe(false);
    expect(approveAction).toHaveBeenCalledWith(
      {
        tool: "computer.setUiValue",
        params: {
          selector: { windowHandle: 42, automationId: "notes", name: "Notes" },
          value: "sk-demo-secret",
        },
      },
      permissionSnapshot?.permissionRequest?.id,
      "task-computer-set-value-sensitive",
      false,
    );
  });

  it("redacts image data URLs when the computer-use runner throws directly", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Computer use",
        reasoning: "Use computer automation.",
        steps: [{
          id: "use-computer",
          title: "Use computer",
          assignedAgentKind: "computer",
          toolName: "computer.click",
          requiredCapabilities: ["computer_use"],
          dependsOn: [],
          successCriteria: "Use the target UI.",
        }],
      })),
    };
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory: vi.fn(async () => []),
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
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
      approveAction: vi.fn(async () => ({ approvalId: "approval-1", taskId: "task-computer-throw-redaction" })),
    };
    const { controller, emitted } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-computer-throw-redaction",
      userGoal: "use the computer",
      computerUseLoopRunner: async () => {
        throw new Error("runner failed data:image/png;base64,THROWN_SHOULD_NOT_SURVIVE==");
      },
    });

    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("THROWN_SHOULD_NOT_SURVIVE");
    expect(serialized).toContain("[redacted:image data URL:");
  });
});
