import { describe, expect, it, vi } from "vitest";
import {
  addModelUsage,
  createFileScanTaskRuntime,
  createInitialTaskSnapshot,
  demoAgents,
  getAgentSystemPrompt,
  getWorkbenchWorkflow,
  listWorkbenchWorkflows,
} from "./index";
import { initialToolDescriptors } from "@javis/tools";
import type {
  FileOrganizationExecution,
  FileOrganizationPlan,
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

async function waitForStatus(
  snapshots: TaskSnapshot[],
  status: TaskSnapshot["status"],
): Promise<TaskSnapshot> {
  await vi.waitFor(() => {
    expect(snapshots[snapshots.length - 1]?.status).toBe(status);
  });
  return snapshots[snapshots.length - 1] as TaskSnapshot;
}

describe("createFileScanTaskRuntime", () => {
  it("creates a consistent idle snapshot for all built-in agents", () => {
    const snapshot = createInitialTaskSnapshot();

    expect(snapshot.status).toBe("created");
    expect(snapshot.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
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
      "agent-browser",
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

  it("routes simple project-mode chat through Commander clarification", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Clarification needed",
      reasoning: "Project mode should ask before planning ambiguous work.",
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

    runtime.start("浣犲ソ", { mode: "project" });

    const waitingSnapshot = await waitForStatus(snapshots, "waiting_info");

    expect(commanderPlan).toHaveBeenCalledTimes(1);
    expect(chatComplete).not.toHaveBeenCalled();
    expect(waitingSnapshot.askUserQuestion?.question).toBe("请先补充一个关键信息，方便我继续规划。");
    expect(waitingSnapshot.conversationMessages?.some((message) =>
      message.kind === "ask_user_question" &&
      message.askUserQuestion?.question === "请先补充一个关键信息，方便我继续规划。"
    )).toBe(true);
    expect(waitingSnapshot.logs.some((log) => log.title === "route_decided")).toBe(true);
    expect(waitingSnapshot.logs.find((log) => log.title === "route_decided")?.detail)
      .toContain('"routeLevel":"L1"');

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
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"],
        dependsOn: [] as string[],
        executionMode: "direct_tool_call" as const,
        successCriteria: "Files scanned.",
      }],
    }));
    const scanMarkdownDocuments = vi.fn(async () => []);
    const reactDecideNext = vi.fn(async () => ({
      status: "failed" as const,
      reason: "should not run",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
      reactDecideNext,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(scanMarkdownDocuments).toHaveBeenCalledOnce();
    expect(reactDecideNext).not.toHaveBeenCalled();

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
    const reactDecideNext = vi.fn(async (request) => {
      if (request.observations.length === 0) {
        return {
          status: "continue" as const,
          toolName: "file.scanMarkdownDocuments",
          reason: "scan first",
        };
      }
      return {
        status: "completed" as const,
        reason: "scan complete",
        output: request.observations[0]?.output,
      };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
      reactDecideNext,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(reactDecideNext).toHaveBeenCalled();
    expect(scanMarkdownDocuments).toHaveBeenCalledOnce();

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
    const scanMarkdownDocuments = vi.fn(async () => []);
    let decisions = 0;
    const reactDecideNext = vi.fn(async () => {
      decisions += 1;
      return decisions < 5
        ? {
            status: "continue" as const,
            toolName: "file.scanMarkdownDocuments",
            reason: "need another observation",
          }
        : {
            status: "completed" as const,
            reason: "enough observations",
          };
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { agentMaxIterations: 8 },
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan },
      reactDecideNext,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project with more rounds", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(reactDecideNext).toHaveBeenCalledTimes(5);
    expect(scanMarkdownDocuments).toHaveBeenCalledTimes(4);

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
    const reactDecideNext = vi.fn();
    const scanMarkdownDocuments = vi.fn(async () => []);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      commanderTool: { plan: commanderPlan, synthesize },
      reactDecideNext,
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("answer this directly", { mode: "project" });
    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.status).toBe("completed");
    expect(synthesize).toHaveBeenCalled();
    expect(reactDecideNext).not.toHaveBeenCalled();
    expect(scanMarkdownDocuments).not.toHaveBeenCalled();

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
      "Click/type/evaluate/runTest operations require confirmed-write approval; upload remains disabled until upload approvals are implemented.",
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
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/docs/README.md",
        modifiedAt: "2026-05-25T00:00:00.000Z",
        sizeBytes: 100,
        heading: "Javis",
        excerpt: "Project documentation",
      },
    ];
    const commanderPlan = vi.fn(async () => ({
      title: "Model planned project read",
      reasoning: "Use File Agent to scan documents for a read-only project pass.",
      steps: [
        {
          id: "scan-files",
          title: "Scan files",
          assignedAgentKind: "file",
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Markdown documents are scanned.",
        },
      ],
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => documents),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Model planned project read");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "scan-files",
    ]);
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "inspect this project",
    }));

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

    runtime.start("click the desktop button");
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

  it("routes supported workflow blueprints through concrete generic workflow tools", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Model planned reminder",
      reasoning: "Use the Scheduler to create a durable daily reminder.",
      steps: [
        {
          id: "parse-schedule",
          title: "Parse schedule",
          assignedAgentKind: "commander",
          capability: "planning" as const,
          requiredCapabilities: ["planning"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Reminder intent is parsed.",
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

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Model planned reminder");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "parse-schedule",
    ]);
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "commander-dag",
      userGoal: "remind me every day at 8",
    }));

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
    expect(finalSnapshot.verificationSummary).toContain("blueprint executed through the DAG executor");

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
    expect(finalSnapshot.verificationSummary).toContain("no Code Agent edit backend is configured");

    unsubscribe();
    runtime.dispose();
  });

  it("requires confirmed-write approval before applying a proposed Code Agent patch", async () => {
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
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Review code changes");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");
    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.permissionRequest?.title).toBe(
        "Approve Code Agent patch application",
      );
    });
    expect(applyProposedEdit).not.toHaveBeenCalled();
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(applyProposedEdit).toHaveBeenCalledWith(proposedEdit, {
      approvalId: expect.stringMatching(/^task-\d+-apply-permission$/),
      taskId: expect.stringMatching(/^task-\d+$/),
    });
    expect(finalSnapshot.codeProposedEdit).toEqual(proposedEdit);
    expect(finalSnapshot.codeApplyResult?.applied).toBe(true);
    expect(finalSnapshot.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
      modelCalls: 1,
      byAgentKind: [
        {
          agentKind: "code",
          inputTokens: 1200,
          outputTokens: 340,
          totalTokens: 1540,
          modelCalls: 1,
        },
      ],
    });
    expect(finalSnapshot.commands).toHaveLength(2);
    expect(finalSnapshot.verificationSummary).toContain("approved Code Agent patch applied");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps denied Code Agent patch proposals as a no-op", async () => {
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
    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.permissionRequest?.title).toBe(
        "Approve Code Agent patch application",
      );
    });
    runtime.resolvePermission("denied");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(applyProposedEdit).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("denied");
    expect(finalSnapshot.verificationSummary).toContain("no write operation was executed");

    unsubscribe();
    runtime.dispose();
  });

  it("refuses Code Agent patch proposals when the patch hash does not match", async () => {
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

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Code Agent patch proposal failed safety check");
    expect(applyProposedEdit).not.toHaveBeenCalled();

    unsubscribe();
    runtime.dispose();
  });

  it("reports Code Agent proposal backend failures separately from verification failures", async () => {
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

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(proposeEdit).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Code Agent patch proposal failed");
    expect(finalSnapshot.commanderMessage).toBeTruthy();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain(
      "provider returned invalid proposal",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("refuses Code Agent apply results that include unapproved files", async () => {
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
    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.permissionRequest?.title).toBe(
        "Approve Code Agent patch application",
      );
    });
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Code Agent patch result failed safety check");
    expect(finalSnapshot.verificationSummary).toContain("unapproved file");

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
    const plan = createTextWritePlan("reports/search.md");
    const writeText = vi.fn(async (request: { targetPath: string; content: string }) =>
      createTextWriteResult(request.targetPath, request.content.length),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planWriteText: async () => plan,
        writeText,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("write the AI news summary to reports/search.md");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(writeText).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: "reports/search.md",
        content: expect.stringContaining("#"),
      }),
      plan.approvalId,
      expect.stringMatching(/^task-/),
    );
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");
    expect(finalSnapshot.verificationSummary).toContain("was written");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved text writes failed when execution throws", async () => {
    const plan = createTextWritePlan("reports/search.md");
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
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

  it("routes vision goals directly to runVisionTask before Commander DAG", async () => {
    const describe = vi.fn(async () => ({
      description: "A sunset over mountains.",
    }));
    const plan = vi.fn(async () => ({
      title: "Should not be called",
      reasoning: "",
      steps: [],
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
    expect(plan).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "data:image/png;base64,abcd" }),
    );
    expect(finalSnapshot.status).toBe("completed");
    expect(finalSnapshot.title).toBe("Image described");

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
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("浣犲ソ"), {
      maxTokens: 1200,
      temperature: 0.7,
      locale: "zh-CN",
    });
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("不要把推测写成事实"), expect.any(Object));
    expect(finalSnapshot.title).toBeTruthy();
    expect(finalSnapshot.commanderMessage).toBe("Hello, I am Javis.");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(1);
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("forces general chat mode even when the goal looks like project work", async () => {
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

    expect(complete).toHaveBeenCalled();
    expect(inspectProject).not.toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Answered");

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
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("first question"), {
      maxTokens: 1200,
      temperature: 0.7,
      locale: "en",
    });
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("do not present guesses as facts"), expect.any(Object));
    expect(finalSnapshot.conversationMessages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "Second answer" },
    ]);

    unsubscribe();
    runtime.dispose();
  });

  it("windows long chat context for the model while preserving the full conversation timeline", async () => {
    let prompt = "";
    const priorMessages = Array.from({ length: 130 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "oldest-message-should-be-omitted" : `message-${index}`,
    }));
    const complete = vi.fn(async (nextPrompt: string) => {
      prompt = nextPrompt;
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

    expect(prompt).toContain("(10 earlier message(s) omitted)");
    expect(prompt).not.toContain("oldest-message-should-be-omitted");
    expect(prompt).toContain("message-129");
    expect(finalSnapshot.conversationMessages).toHaveLength(132);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("oldest-message-should-be-omitted");
    expect(finalSnapshot.conversationMessages?.[130]).toEqual({
      role: "user",
      content: "continue the thread",
    });

    unsubscribe();
    runtime.dispose();
  });

  it("recovers general chat from context overflow with summary plus recent messages", async () => {
    let recoveredPrompt = "";
    const priorMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "old-raw-detail-should-be-summarized" : `context-message-${index}`,
    }));
    const complete = vi.fn(async (nextPrompt: string) => {
      if (complete.mock.calls.length === 1) {
        throw new Error("maximum context length exceeded");
      }
      if (nextPrompt.includes("Summarize this earlier Javis conversation")) {
        return { text: "- Earlier discussion established a stable API constraint." };
      }
      recoveredPrompt = nextPrompt;
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
    expect(recoveredPrompt).toContain("Earlier conversation summary:");
    expect(recoveredPrompt).toContain("stable API constraint");
    expect(recoveredPrompt).toContain("context-message-13");
    expect(recoveredPrompt).not.toContain("old-raw-detail-should-be-summarized");
    expect(recoveredPrompt).not.toContain("earlier message(s) omitted");
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
    const priorMessages = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 0 ? "short-context-oldest-message" : `short-message-${index}`,
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      runtimeConfig: { contextStrategy: "short" },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      chatTool: {
        complete: vi.fn(async (nextPrompt: string) => {
          prompt = nextPrompt;
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

    expect(prompt).toContain("(10 earlier message(s) omitted)");
    expect(prompt).not.toContain("short-context-oldest-message");
    expect(prompt).toContain("short-message-49");
    expect(finalSnapshot.conversationMessages).toHaveLength(52);
    expect(finalSnapshot.conversationMessages?.[0]?.content).toBe("short-context-oldest-message");

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
      commanderTool: { plan: commanderPlan },
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
      commanderTool: { plan: commanderPlan },
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
    });

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.conversationMessages?.[0]?.attachments).toBeUndefined();

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
    expect(finalSnapshot.userFacingError).toContain("model request failed");
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
        capability: "file_scan" as const,
        requiredCapabilities: ["file_scan"] as string[],
        dependsOn: [] as string[],
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

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
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

    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: { plan: commanderPlan },
      fileTool: { scanMarkdownDocuments: scanDocs },
      replanDag: vi.fn(async () => ({
        title: "Recovery plan",
        reasoning: "Try alternative.",
        steps: [{
          id: "recovery-step",
          title: "Scan with different approach",
          assignedAgentKind: "file",
          capability: "file_scan" as const,
          requiredCapabilities: ["file_scan"] as string[],
          dependsOn: [] as string[],
          successCriteria: "Scan retried.",
        }],
      })),
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test failure replan");

    // Task will fail (recovery also fails since scanDocs always throws),
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

import { createTaskEventBus } from "./task-event-bus";

describe("completeGeneralChat streaming pipeline", () => {
  it("routes simple L1 chat through l1 streaming without Commander or ReAct", async () => {
    let streamOptions: { streamMode?: "default" | "l1" } | undefined;
    let streamPrompt = "";
    const commanderPlan = vi.fn();
    const reactDecideNext = vi.fn();
    const mockChatTool = {
      complete: vi.fn(async () => ({ text: "fallback", tokenUsage: undefined })),
      stream: vi.fn(async function* (prompt: string, options?: { streamMode?: "default" | "l1" }) {
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
      reactDecideNext,
      eventBus,
    });

    const { snapshots } = subscribeToRuntime(runtime);
    runtime.start("hello", { taskId: "task-l1-stream" });

    await vi.waitFor(() => {
      expect(snapshots[snapshots.length - 1]?.status).toBe("completed");
    }, { timeout: 3000 });

    expect(mockChatTool.stream).toHaveBeenCalledOnce();
    expect(streamOptions?.streamMode).toBe("l1");
    expect(mockChatTool.complete).not.toHaveBeenCalled();
    expect(commanderPlan).not.toHaveBeenCalled();
    expect(reactDecideNext).not.toHaveBeenCalled();
    expect(streamPrompt).not.toContain("Output must match this JSON Schema");
    expect(streamPrompt).not.toContain("Available tools:");
    expect(streamPrompt).not.toContain("ReAct");
    expect(snapshots[snapshots.length - 1]?.commanderMessage).toBe("Hi");

    runtime.dispose();
  });

  it("recovers streaming general chat context overflow with summary plus recent messages", async () => {
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
          });
          return { text: "- Earlier stream context requires preserving user constraints.", tokenUsage: undefined };
        }
        return { text: "Recovered stream answer", tokenUsage: undefined };
      }),
      stream: vi.fn(async function* (prompt: string) {
        if (!prompt.includes("Earlier conversation summary:")) {
          throw new Error("maximum context length exceeded");
        }
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
    const finalPrompt = mockChatTool.stream.mock.calls[1]?.[0] ?? "";
    expect(mockChatTool.stream).toHaveBeenCalledTimes(2);
    expect(mockChatTool.complete).toHaveBeenCalledTimes(1);
    expect(finalPrompt).toContain("Earlier conversation summary:");
    expect(finalPrompt).toContain("preserving user constraints");
    expect(finalPrompt).toContain("stream-context-13");
    expect(finalPrompt).not.toContain("old-stream-detail-should-be-summarized");
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
    expect(finalSnapshot?.userFacingError).toContain("model request failed");
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
