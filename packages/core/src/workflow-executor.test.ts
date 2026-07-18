import { describe, expect, it, vi } from "vitest";
import { encodeMcpToolServerName, initialToolDescriptors, type BrowserTool, type CodeTool, type CommanderTool, type ComputerTool, type FileTool, type GitTool, type McpTool, type MemoryTool, type ProjectTool, type SchedulerTool, type ShellTool, type ToolDescriptor, type TrendTool, type VerifierTool, type WebTool, type WorkspaceTool } from "@javis/tools";
import { createArtifactEnvelope, computePlanHash, createAgentRegistry, createDefaultAgentRegistry, createInitialTaskSnapshot, demoAgents, type Agent, type RuntimeEventEnvelope, type TaskSnapshot, type WorkflowCheckpoint } from "./index";
import { createSharedTaskContext } from "./shared-context";
import { createWorkflowRegistry } from "./workflow-registry";
import type { WorkbenchWorkflow } from "./workflows";
import { executeCapabilityStep, isReadCurrentProjectGoal, runCommanderDagTask, runGenericWorkbenchWorkflow, runReadCurrentProjectWorkflow, SUPPORTED_APPROVAL_GATED_TOOLS } from "./workflow-executor";
import type { ReActDecisionRequest } from "./agent-react-decider";
import type { WorkspaceRuntime } from "./workspace-runtime";

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
  for (let attempt = 0; attempt < 100; attempt++) {
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

describe("isReadCurrentProjectGoal", () => {
  it("recognizes source-backed project understanding requests", () => {
    const goal = "\u544a\u8bc9\u6211\u8fd9\u4e2a\u9879\u76ee\u662f\u5e72\u561b\u7684, \u4e0d\u8981\u5149\u770breadme, \u8981\u7ed3\u5408\u5b9e\u9645\u4ee3\u7801\u60c5\u51b5";

    expect(isReadCurrentProjectGoal(goal)).toBe(true);
  });
});

function createTestWorkspaceRuntime(
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  const root = "E:/Javis/.codex-tmp/javis-sandboxes/task-1";
  return {
    kind: "sandbox",
    root,
    readFile: vi.fn(),
    listFiles: vi.fn(),
    execute: vi.fn(async (request) => ({
      command: [request.program, ...request.args].join(" "),
      cwd: root,
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
    createSnapshot: vi.fn(),
    diff: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function createRuntimeEventEnvelopeForTest(
  taskId: string,
  runId: string,
  sequence: number,
  payload: unknown,
): RuntimeEventEnvelope {
  return {
    eventId: `evt-${runId}-${sequence}`,
    eventVersion: 1,
    sequence,
    taskId,
    runId,
    workflowId: "commander-dag",
    correlationId: `corr-${runId}`,
    occurredAt: "2026-06-16T00:00:00.000Z",
    recordedAt: "2026-06-16T00:00:00.001Z",
    payload,
  };
}

describe("runCommanderDagTask observability", () => {
  it("includes dynamically registered agents in Commander runtime snapshots", async () => {
    const registry = createDefaultAgentRegistry();
    const customAgent: Agent = {
      id: "agent-custom-reviewer",
      kind: "code",
      displayName: "Custom Reviewer",
      description: "Workspace-provided review agent",
      allowedToolNames: [],
      modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
      systemPrompt: { en: "You review evidence.", zhCN: "Review evidence." },
    };
    registry.register(customAgent);
    try {
      const { controller, emitted } = createTestController();
      await runCommanderDagTask({
        controller,
        commanderTool: {
          plan: vi.fn<CommanderTool["plan"]>(async () => ({
            title: "Custom code review",
            reasoning: "The workspace-provided code agent handles this step.",
            steps: [{
              id: "custom-review",
              title: "Review the requested evidence",
              assignedAgentKind: "code",
              requiredCapabilities: [],
              dependsOn: [],
              executionMode: "direct_response",
              successCriteria: "A review response is produced.",
            }],
          })),
          synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
            message: "Here is the direct answer.",
          })),
        },
        verifierTool: {
          check: vi.fn(async () => ({
            status: "pass" as const,
            summary: "Custom review completed.",
            detail: "The custom agent produced a response.",
          })),
        },
        taskId: "task-dynamic-agent-snapshot",
        userGoal: "inspect the project",
      });

      const customSnapshots = emitted
        .map((snapshot) => snapshot.agents.find((agent) => agent.id === customAgent.id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
      expect(customSnapshots.length).toBeGreaterThan(0);
      expect(customSnapshots.some((agent) => agent.status === "completed")).toBe(true);
      expect(emitted.some((snapshot) =>
        snapshot.agents.some((agent) => agent.id === "agent-code" && agent.status === "completed"),
      )).toBe(false);
    } finally {
      registry.unregister(customAgent.id);
    }
  });

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
    expect(emitted.some((snapshot) =>
      snapshot.commanderMessage ===
        'Commander is monitoring File Agent on "Scan project documents". Progress: 0/1.',
    )).toBe(true);
    expect(emitted.some((snapshot) =>
      snapshot.commanderMessage ===
        'File Agent completed "Scan project documents" and returned the result to Commander. Progress: 1/1.',
    )).toBe(true);
  });

  it("propagates the durable run id onto emitted Commander snapshots", async () => {
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
      taskId: "task-run-id",
      userGoal: "scan the project documents",
    });

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.some((snapshot) => snapshot.runId?.startsWith("run-task-run-id-"))).toBe(true);
  });

  it("forwards runtime events and checkpoints to durable sinks", async () => {
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
    const { controller } = createTestController();
    const appendedEnvelopes: Array<import("./runtime-event-envelope").RuntimeEventEnvelope> = [];
    const savedCheckpoints: Array<import("./workflow-checkpoint").WorkflowCheckpoint> = [];

    await runCommanderDagTask({
      controller,
      commanderTool,
      fileTool,
      taskId: "task-durable-sinks",
      userGoal: "scan the project documents",
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

    expect(appendedEnvelopes.length).toBeGreaterThan(0);
    expect(appendedEnvelopes[0].taskId).toBe("task-durable-sinks");
    expect(appendedEnvelopes[0].payload).toMatchObject({ kind: "task.created" });
    expect(appendedEnvelopes.some((e) => (e.payload as { kind?: string }).kind === "step.completed")).toBe(true);

    expect(savedCheckpoints.length).toBeGreaterThan(0);
    const finalCheckpoint = savedCheckpoints[savedCheckpoints.length - 1];
    expect(finalCheckpoint.taskId).toBe("task-durable-sinks");
    expect(finalCheckpoint.workflowSnapshot.steps.some((s) => s.id === "scan-files")).toBe(true);
    const completedEnvelope = appendedEnvelopes.find(
      (envelope) => (envelope.payload as { kind?: string }).kind === "step.completed",
    );
    const completedCheckpoint = savedCheckpoints.find(
      (checkpoint) => checkpoint.eventSequence === completedEnvelope?.sequence,
    );
    expect(completedCheckpoint?.completedStepIds).toContain("scan-files");
    expect(completedCheckpoint?.pendingStepIds).not.toContain("scan-files");
  });

  it("waits for runtime event persistence before checkpoint persistence", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Serialize persistence",
        reasoning: "Commander will emit a single durable event.",
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
    const { controller } = createTestController();
    const order: string[] = [];

    await runCommanderDagTask({
      controller,
      commanderTool,
      fileTool,
      taskId: "task-durable-order",
      userGoal: "scan the project documents",
      runtimeEventSink: {
        append: async () => {
          order.push("event");
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      },
      checkpointSink: {
        save: async () => {
          order.push("checkpoint");
        },
      },
    });

    expect(order.indexOf("event")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("checkpoint")).toBeGreaterThan(order.indexOf("event"));
  });

  it("fails closed when the runtime event sink rejects a write", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Persist runtime events",
        reasoning: "Commander will persist the step lifecycle.",
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
    const persistedKinds: string[] = [];
    let rejected = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { controller, emitted } = createTestController();

    try {
      await runCommanderDagTask({
        controller,
        commanderTool,
        fileTool,
        taskId: "task-runtime-event-sink-failure",
        userGoal: "scan the project documents",
        runtimeEventSink: {
          append: async (envelope) => {
            const kind = String((envelope.payload as { kind?: string }).kind ?? "unknown");
            if (kind === "step.completed" && !rejected) {
              rejected = true;
              throw new Error("runtime event database is unavailable");
            }
            persistedKinds.push(kind);
          },
        },
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(rejected).toBe(true);
    expect(emitted.some((snapshot) => snapshot.status === "completed")).toBe(false);
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    expect(emitted[emitted.length - 1]?.commanderMessage).toContain(
      "Durable persistence failed in runtime-event-sink",
    );
    expect(persistedKinds).toContain("task.failed");
  });

  it("fails closed when the checkpoint sink rejects a write", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Persist checkpoints",
        reasoning: "Commander will persist the completed step state.",
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
    const persistedKinds: string[] = [];
    let rejected = false;
    let successfulCheckpointWrites = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { controller, emitted } = createTestController();

    try {
      await runCommanderDagTask({
        controller,
        commanderTool,
        fileTool,
        taskId: "task-checkpoint-sink-failure",
        userGoal: "scan the project documents",
        runtimeEventSink: {
          append: async (envelope) => {
            persistedKinds.push(String((envelope.payload as { kind?: string }).kind ?? "unknown"));
          },
        },
        checkpointSink: {
          save: async (checkpoint) => {
            if (checkpoint.completedStepIds.includes("scan-files") && !rejected) {
              rejected = true;
              throw new Error("checkpoint database is unavailable");
            }
            successfulCheckpointWrites += 1;
          },
        },
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(rejected).toBe(true);
    expect(successfulCheckpointWrites).toBeGreaterThan(0);
    expect(emitted.some((snapshot) => snapshot.status === "completed")).toBe(false);
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    expect(emitted[emitted.length - 1]?.commanderMessage).toContain(
      "Durable persistence failed in checkpoint-sink",
    );
    expect(persistedKinds).toContain("task.failed");
  });

  it("continues resumed runtime events on the checkpoint runId and sequence", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Resume sequence task",
        reasoning: "Commander will resume from a durable checkpoint.",
        steps: [{
          id: "summarize-evidence",
          title: "Summarize evidence",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: ["synthesis"],
          dependsOn: [],
      outputContextKey: "summary",
      successCriteria: "Summary is written.",
    }],
  })),
  synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
        message: "Resumed cleanly.",
      })),
    };
    const checkpoint: WorkflowCheckpoint = {
      taskId: "task-resume-sequence",
      runId: "run-task-resume-sequence-old",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: "plan-sha256-seed",
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Resume sequence task",
        triggerExamples: [],
        goal: "resume sequence",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: [{
          id: "summarize-evidence",
          title: "Summarize evidence",
          agentKind: "commander" as const,
          input: "Summarize evidence",
          output: "Summary is written.",
          permissionLevel: "read" as const,
          dependsOn: [],
          canRunInParallel: true,
          requiredCapabilities: ["synthesis" as const],
          outputContextKey: "summary",
        }],
      },
      completedStepIds: [],
      abandonedStepIds: [],
      pendingStepIds: ["summarize-evidence"],
      runningStepIds: [],
      contextSnapshot: {},
      approvalRequestIds: [],
      eventSequence: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    checkpoint.planHash = computePlanHash(checkpoint.workflowSnapshot.steps);
    const events: RuntimeEventEnvelope[] = [
      createRuntimeEventEnvelopeForTest("task-resume-sequence", checkpoint.runId, 1, {
        kind: "task.created",
        taskId: "task-resume-sequence",
      }),
      createRuntimeEventEnvelopeForTest("task-resume-sequence", checkpoint.runId, 2, {
        kind: "task.waiting",
        taskId: "task-resume-sequence",
      }),
      // The event log can be ahead of the checkpoint when the process crashes
      // between event persistence and checkpoint persistence.
      createRuntimeEventEnvelopeForTest("task-resume-sequence", checkpoint.runId, 3, {
        kind: "step.progress",
        taskId: "task-resume-sequence",
        stepId: "summarize-evidence",
      }),
    ];
    const appendedEnvelopes: RuntimeEventEnvelope[] = [];
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      taskId: "task-resume-sequence",
      userGoal: "resume sequence",
      runtimeEventSink: {
        append: async (envelope) => {
          appendedEnvelopes.push(envelope);
        },
      },
      resumeFromCheckpoint: { checkpoint, events },
    });

    expect(emitted[0]?.runId).toBe(checkpoint.runId);
    expect(appendedEnvelopes.length).toBeGreaterThan(0);
    expect(appendedEnvelopes[0]?.runId).toBe(checkpoint.runId);
    expect(appendedEnvelopes[0]?.sequence).toBe(4);
    expect(appendedEnvelopes.every((envelope) => envelope.runId === checkpoint.runId)).toBe(true);
    expect(appendedEnvelopes.every((envelope, index) => envelope.sequence === index + 4)).toBe(true);
  });

  it("fails closed when a regenerated Commander plan does not match the checkpoint", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Changed resume task",
        reasoning: "The regenerated plan changed after restart.",
        steps: [{
          id: "changed-step",
          title: "Changed step",
          assignedAgentKind: "commander",
          executionMode: "direct_response" as const,
          requiredCapabilities: ["synthesis"],
          dependsOn: [],
          successCriteria: "Changed output is written.",
        }],
      })),
      synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
        message: "This must not execute.",
      })),
    };
    const checkpointSteps = [{
      id: "original-step",
      title: "Original step",
      agentKind: "commander" as const,
      input: "Original step",
      output: "Original output is written.",
      permissionLevel: "read" as const,
      dependsOn: [],
      canRunInParallel: true,
      requiredCapabilities: ["synthesis" as const],
    }];
    const checkpoint: WorkflowCheckpoint = {
      taskId: "task-resume-mismatch",
      runId: "run-task-resume-mismatch-old",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: computePlanHash(checkpointSteps),
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Original resume task",
        triggerExamples: [],
        goal: "resume mismatch",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: checkpointSteps,
      },
      completedStepIds: [],
      abandonedStepIds: [],
      pendingStepIds: ["original-step"],
      runningStepIds: [],
      contextSnapshot: {},
      approvalRequestIds: [],
      eventSequence: 0,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      taskId: checkpoint.taskId,
      userGoal: "resume mismatch",
      resumeFromCheckpoint: { checkpoint, events: [] },
    });

    expect(commanderTool.synthesize).not.toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.logs.some((log) =>
      log.detail.includes("does not match the compiled Commander DAG plan")
    )).toBe(true);
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

  it("filters unavailable runtime tools out of Commander DAG planning", async () => {
    const unavailableToolNames = [
      "web.search",
      "web.fetchSource",
      "browser.navigate",
      "verifier.check",
      "scheduler.createTask",
      "workspace.list",
      "shell.runReadOnlyCommand",
      "file.scanMarkdownDocuments",
      "code.inspectRepository",
      "computer.screenshot",
      "memory.search",
    ];
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        const toolNames = new Set((request.availableTools ?? []).map((tool) => tool.name));
        for (const toolName of unavailableToolNames) {
          expect(toolNames.has(toolName)).toBe(false);
        }
        for (const agent of request.availableAgents) {
          for (const toolName of unavailableToolNames) {
            expect(agent.allowedToolNames).not.toContain(toolName);
          }
        }
        expect(toolNames.has("commander.plan")).toBe(true);
        return {
          title: "Only Commander tools",
          reasoning: "No worker tools are runtime-available.",
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
      taskId: "task-runtime-tool-filter",
      userGoal: "inspect unavailable tools",
    });

    expect(commanderTool.plan).toHaveBeenCalled();
  });

  it("passes required tool inputs into Commander DAG planning", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        const writeTextDescriptor = request.availableTools?.find((tool) => tool.name === "file.writeText");
        expect(writeTextDescriptor?.requiredInputs).toEqual([
          { name: "targetPath", type: "string", nonEmpty: true },
        ]);
        return {
          title: "Inputs visible",
          reasoning: "Planner sees descriptor-derived required inputs.",
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
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => []),
        planWriteText: vi.fn(),
        writeText: vi.fn(),
      },
      taskId: "task-required-inputs-visible",
      userGoal: "write a report",
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

  it("resumes a Commander DAG from checkpoint without rerunning completed upstream steps", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Resume task",
        reasoning: "Commander will reuse durable repository evidence.",
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
        message: "packages/core/src/index.ts",
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
        throw new Error("completed upstream step should not rerun");
      }),
    };
    const checkpointWorkflowSteps = [
      {
        id: "collect-evidence",
        title: "Collect evidence",
        agentKind: "code" as const,
        input: "Collect evidence",
        output: "Repository evidence is collected.",
        permissionLevel: "read" as const,
        dependsOn: [],
        canRunInParallel: true,
        requiredCapabilities: ["code_search" as const],
        outputContextKey: "repoEvidence",
        toolName: "code.searchRepository",
        toolInput: { goal: "find launch code" },
        successCriteria: "Repository evidence is collected.",
      },
      {
        id: "summarize-evidence",
        title: "Summarize evidence",
        agentKind: "commander" as const,
        input: "Summarize evidence",
        output: "Summary uses repository evidence.",
        permissionLevel: "read" as const,
        dependsOn: ["collect-evidence"],
        canRunInParallel: true,
        requiredCapabilities: ["synthesis" as const],
        inputContextKeys: ["repoEvidence"],
        outputContextKey: "summary",
        executionMode: "direct_response" as const,
        successCriteria: "Summary uses repository evidence.",
      },
    ];
    const checkpoint: WorkflowCheckpoint = {
      taskId: "task-resume-commander",
      runId: "run-task-resume-commander-old",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: computePlanHash(checkpointWorkflowSteps),
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Resume task",
        triggerExamples: [],
        goal: "summarize launch code",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["code", "commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: checkpointWorkflowSteps,
      },
      completedStepIds: ["collect-evidence"],
      abandonedStepIds: [],
      pendingStepIds: ["summarize-evidence"],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: createArtifactEnvelope(
          {
            keyFiles: ["packages/core/src/index.ts"],
            actualFound: [],
            inferred: [],
            needsConfirmation: [],
            relatedTestFiles: [],
            testFileCandidates: [],
            clusters: [],
            attempts: [],
          },
          {
            taskId: "task-resume-commander",
            runId: "run-task-resume-commander-old",
            type: "repoEvidence",
            producer: { stepId: "collect-evidence", agentKind: "code" },
          },
        ),
      },
      approvalRequestIds: [],
      eventSequence: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    const events: RuntimeEventEnvelope[] = [
      createRuntimeEventEnvelopeForTest("task-resume-commander", checkpoint.runId, 1, {
        kind: "step.started",
        taskId: "task-resume-commander",
        stepId: "collect-evidence",
      }),
      createRuntimeEventEnvelopeForTest("task-resume-commander", checkpoint.runId, 2, {
        kind: "step.completed",
        taskId: "task-resume-commander",
        stepId: "collect-evidence",
      }),
    ];
    const { controller, emitted } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-resume-commander",
      userGoal: "summarize launch code",
      resumeFromCheckpoint: { checkpoint, events },
    });

    expect(codeTool.searchRepository).not.toHaveBeenCalled();
    expect(commanderTool.synthesize).toHaveBeenCalled();
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.plan.find((step) => step.id === "collect-evidence")?.status).toBe("completed");
    expect(finalSnapshot?.plan.find((step) => step.id === "summarize-evidence")?.status).toBe("completed");
  });

  it("rejects a resumed artifact whose producer tool does not match the Commander DAG step", async () => {
    const taskId = "task-resume-provenance-mismatch";
    const runId = "run-task-resume-provenance-mismatch";
    const step = {
      id: "collect-evidence",
      title: "Collect evidence",
      agentKind: "code" as const,
      input: "Collect evidence",
      output: "Repository evidence is collected.",
      permissionLevel: "read" as const,
      dependsOn: [],
      canRunInParallel: true,
      requiredCapabilities: ["code_search" as const],
      outputContextKey: "repoEvidence",
      toolName: "code.searchRepository",
      toolInput: { goal: "find launch code" },
      successCriteria: "Repository evidence is collected.",
    };
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be synthesized from mismatched provenance.",
    }));
    const checkpoint: WorkflowCheckpoint = {
      taskId,
      runId,
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: computePlanHash([step]),
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Resume provenance task",
        triggerExamples: [],
        goal: "summarize launch code",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["code"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: [step],
      },
      completedStepIds: [step.id],
      abandonedStepIds: [],
      pendingStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: createArtifactEnvelope(
          {
            keyFiles: ["packages/core/src/index.ts"],
            actualFound: [],
            inferred: [],
            needsConfirmation: [],
            relatedTestFiles: [],
            testFileCandidates: [],
            clusters: [],
            attempts: [],
          },
          {
            taskId,
            runId,
            type: "repoEvidence",
            producer: {
              workflowId: "commander-dag",
              stepId: step.id,
              agentKind: "code",
              agentId: "agent-code",
              toolName: "shell.runReadOnlyCommand",
            },
          },
        ),
      },
      approvalRequestIds: [],
      eventSequence: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    const events: RuntimeEventEnvelope[] = [
      createRuntimeEventEnvelopeForTest(taskId, runId, 1, {
        kind: "step.started",
        taskId,
        stepId: step.id,
      }),
      createRuntimeEventEnvelopeForTest(taskId, runId, 2, {
        kind: "step.completed",
        taskId,
        stepId: step.id,
      }),
    ];
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool: {
        plan: vi.fn(async () => ({
          title: "Resume provenance task",
          reasoning: "Use the completed repository evidence.",
          steps: [{
            id: step.id,
            title: step.title,
            assignedAgentKind: step.agentKind,
            toolName: step.toolName,
            toolInput: step.toolInput,
            requiredCapabilities: step.requiredCapabilities,
            dependsOn: step.dependsOn,
            outputContextKey: step.outputContextKey,
            successCriteria: step.successCriteria,
          }],
        })),
        synthesize,
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        searchRepository: vi.fn(async () => {
          throw new Error("completed upstream step should not rerun");
        }),
      },
      taskId,
      userGoal: "summarize launch code",
      resumeFromCheckpoint: { checkpoint, events },
    });

    expect(synthesize).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]).toMatchObject({
      status: "failed",
      userFacingError: expect.stringContaining("mismatched provenance"),
    });
  });

  it("rebuilds Commander DAG resume state from event log when checkpoint step state conflicts", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Rebuild resume task",
        reasoning: "Commander will rebuild checkpoint state from event log.",
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
        message: "packages/core/src/index.ts",
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
        keyFiles: ["packages/core/src/index.ts"],
        actualFound: [],
        inferred: [],
        needsConfirmation: [],
        relatedTestFiles: [],
        testFileCandidates: [],
        clusters: [],
        attempts: [],
      })),
    };
    const checkpointWorkflowSteps = [
      {
        id: "collect-evidence",
        title: "Collect evidence",
        agentKind: "code" as const,
        input: "Collect evidence",
        output: "Repository evidence is collected.",
        permissionLevel: "read" as const,
        dependsOn: [],
        canRunInParallel: true,
        requiredCapabilities: ["code_search" as const],
        outputContextKey: "repoEvidence",
        toolName: "code.searchRepository",
        toolInput: { goal: "find launch code" },
        successCriteria: "Repository evidence is collected.",
      },
      {
        id: "summarize-evidence",
        title: "Summarize evidence",
        agentKind: "commander" as const,
        input: "Summarize evidence",
        output: "Summary uses repository evidence.",
        permissionLevel: "read" as const,
        dependsOn: ["collect-evidence"],
        canRunInParallel: true,
        requiredCapabilities: ["synthesis" as const],
        inputContextKeys: ["repoEvidence"],
        outputContextKey: "summary",
        executionMode: "direct_response" as const,
        successCriteria: "Summary uses repository evidence.",
      },
    ];
    const checkpoint: WorkflowCheckpoint = {
      taskId: "task-rebuild-resume-commander",
      runId: "run-task-rebuild-resume-commander-old",
      workflowId: "commander-dag",
      workflowVersion: 1,
      planHash: computePlanHash(checkpointWorkflowSteps),
      workflowSnapshot: {
        id: "commander-dag" as never,
        title: "Rebuild resume task",
        triggerExamples: [],
        goal: "summarize launch code",
        coordinatorAgentKind: "commander",
        participatingAgentKinds: ["code", "commander"],
        currentSupport: "partial",
        safetyNotes: [],
        steps: checkpointWorkflowSteps,
      },
      completedStepIds: ["collect-evidence"],
      abandonedStepIds: [],
      pendingStepIds: ["summarize-evidence"],
      runningStepIds: [],
      contextSnapshot: {},
      approvalRequestIds: [],
      eventSequence: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
    };
    const events: RuntimeEventEnvelope[] = [
      createRuntimeEventEnvelopeForTest("task-rebuild-resume-commander", checkpoint.runId, 1, {
        kind: "step.started",
        taskId: "task-rebuild-resume-commander",
        stepId: "collect-evidence",
      }),
      createRuntimeEventEnvelopeForTest("task-rebuild-resume-commander", checkpoint.runId, 2, {
        kind: "step.failed",
        taskId: "task-rebuild-resume-commander",
        stepId: "collect-evidence",
        error: "search failed before restart",
      }),
    ];
    const { controller, emitted } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-rebuild-resume-commander",
      userGoal: "summarize launch code",
      resumeFromCheckpoint: { checkpoint, events },
    });

    expect(codeTool.searchRepository).toHaveBeenCalledTimes(1);
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(emitted.some((snapshot) =>
      snapshot.logs.some((log) => log.detail.includes("workflow.resume.rebuilt")),
    )).toBe(true);
    expect(finalSnapshot?.durableResume).toMatchObject({
      runId: checkpoint.runId,
      source: "event-log",
      checkpointEventSequence: 2,
      latestEventSequence: 2,
      completedStepIds: [],
      retryStepIds: ["collect-evidence"],
      approvalRequestIds: [],
      rebuilt: true,
    });
  });

  it("uses a capability-only verifier verdict as the final completion gate", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Capability verifier",
        reasoning: "The verifier independently checks the requested result.",
        steps: [{
          id: "collect-goal-evidence",
          title: "Collect goal evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "verify this task" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "goalEvidence",
          successCriteria: "The goal evidence is collected.",
        }, {
          id: "verify-goal",
          title: "Verify goal evidence",
          assignedAgentKind: "verifier",
          capability: "evidence_check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect-goal-evidence"],
          inputContextKeys: ["goalEvidence"],
          successCriteria: "The user goal is available as verification evidence.",
        }],
      })),
    };
    const check = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Goal evidence is present.",
      detail: "The verifier received the declared handoff evidence.",
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool: {
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
      },
      verifierTool: { check },
      taskId: "task-capability-verifier",
      userGoal: "verify this task",
    });

    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "verify-goal",
      evidence: [{
        kind: "log",
        label: "Handoff artifact: goalEvidence",
        data: {
          actualFound: [],
          inferred: [],
          needsConfirmation: [],
          keyFiles: [],
          relatedTestFiles: [],
          testFileCandidates: [],
          clusters: [],
          attempts: [],
        },
      }],
    }));
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.verificationResult).toMatchObject({ status: "pass" });
  });

  it("fails closed when a verifier returns a malformed pass verdict", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be synthesized from malformed evidence.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Malformed verifier",
        reasoning: "The verifier response is intentionally incomplete.",
        steps: [{
          id: "collect-malformed-evidence",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "verify malformed output" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "malformedEvidence",
          successCriteria: "Evidence is collected.",
        }, {
          id: "verify-malformed",
          title: "Verify malformed result",
          assignedAgentKind: "verifier",
          capability: "evidence_check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect-malformed-evidence"],
          inputContextKeys: ["malformedEvidence"],
          successCriteria: "The verifier returns a complete verdict.",
        }],
      })),
      synthesize,
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool: {
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
      },
      verifierTool: {
        check: vi.fn(async () => ({ status: "pass" } as unknown as Awaited<ReturnType<VerifierTool["check"]>>)),
      },
      taskId: "task-malformed-verifier",
      userGoal: "verify malformed output",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationResult).toMatchObject({
      status: "fail",
      summary: "Verifier returned an invalid result.",
    });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("aggregates multiple verifier results without allowing a later pass to hide a failure", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be synthesized when one verifier fails.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Multiple verifier checks",
        reasoning: "Two independent checks must both pass.",
        steps: [{
          id: "collect",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "collect evidence" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "evidence",
          successCriteria: "Evidence is collected.",
        }, {
          id: "verify-fail",
          title: "Failing verifier",
          assignedAgentKind: "verifier",
          capability: "evidence_check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect"],
          inputContextKeys: ["evidence"],
          successCriteria: "The first independent check passes.",
        }, {
          id: "verify-pass",
          title: "Passing verifier",
          assignedAgentKind: "verifier",
          capability: "evidence_check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect"],
          inputContextKeys: ["evidence"],
          successCriteria: "The second independent check passes.",
        }],
      })),
      synthesize,
    };
    const check = vi.fn<VerifierTool["check"]>(async (request) => ({
      status: request.stepId === "verify-fail" ? "fail" : "pass",
      summary: request.stepId === "verify-fail" ? "The first check failed." : "The second check passed.",
      detail: request.stepId === "verify-fail" ? "Evidence is incomplete." : "Evidence is present.",
    }));
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository: vi.fn(async () => ({
        keyFiles: ["README.md"],
        actualFound: [],
        inferred: [],
        needsConfirmation: [],
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
      verifierTool: { check },
      taskId: "task-multiple-verifiers",
      userGoal: "verify this evidence",
    });

    expect(check).toHaveBeenCalledTimes(2);
    expect(synthesize).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    expect(emitted[emitted.length - 1]?.verificationResult).toMatchObject({ status: "fail" });
  });

  it("runs an implicit provenance verifier before synthesizing a worker-only DAG", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "packages/core/src/index.ts is the collected key file.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Implicit verification",
        reasoning: "Collect repository evidence before final synthesis.",
        steps: [{
          id: "collect-evidence",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          toolInput: { goal: "find the entry point" },
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "repoEvidence",
          successCriteria: "Repository evidence is collected.",
        }],
      })),
      synthesize,
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        searchRepository: vi.fn(async () => ({
          keyFiles: ["packages/core/src/index.ts"],
          actualFound: [],
          inferred: [],
          needsConfirmation: [],
          relatedTestFiles: [],
          testFileCandidates: [],
          clusters: [],
          attempts: [],
        })),
      },
      taskId: "task-implicit-provenance-pass",
      userGoal: "find the entry point",
    });

    expect(synthesize).toHaveBeenCalled();
    expect(emitted[emitted.length - 1]).toMatchObject({
      status: "completed",
      verificationResult: {
        status: "pass",
        summary: expect.stringContaining("Implicit provenance verifier"),
      },
    });
  });

  it("blocks implicit synthesis when a worker artifact changes after hashing", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be synthesized.",
    }));
    let tamperReads = 0;
    const mutableResult = {
      keyFiles: ["packages/core/src/index.ts"],
      actualFound: [],
      inferred: [],
      needsConfirmation: [],
      relatedTestFiles: [],
      testFileCandidates: [],
      clusters: [],
      attempts: [],
      get tamperMarker() {
        tamperReads += 1;
        return tamperReads === 1 ? "sealed" : "changed";
      },
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool: {
        plan: vi.fn(async () => ({
          title: "Tampered evidence",
          reasoning: "Collect repository evidence before final synthesis.",
          steps: [{
            id: "collect-evidence",
            title: "Collect evidence",
            assignedAgentKind: "code",
            toolName: "code.searchRepository",
            toolInput: { goal: "find the entry point" },
            requiredCapabilities: ["code_search"],
            dependsOn: [],
            outputContextKey: "repoEvidence",
            successCriteria: "Repository evidence is collected.",
          }],
        })),
        synthesize,
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        searchRepository: vi.fn(async () => mutableResult),
      },
      taskId: "task-implicit-provenance-tamper",
      userGoal: "find the entry point",
    });

    expect(synthesize).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]).toMatchObject({
      status: "failed",
      verificationResult: {
        status: "fail",
        summary: expect.stringContaining("Implicit provenance verifier rejected"),
      },
    });
  });

  it("runs the local provenance verifier even when an explicit verifier passes", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be synthesized.",
    }));
    const check = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "The model verifier accepted the evidence.",
      detail: "The evidence text appears relevant.",
    }));
    let tamperReads = 0;
    const mutableResult = {
      keyFiles: ["packages/core/src/index.ts"],
      actualFound: [],
      inferred: [],
      needsConfirmation: [],
      relatedTestFiles: [],
      testFileCandidates: [],
      clusters: [],
      attempts: [],
      get tamperMarker() {
        tamperReads += 1;
        return tamperReads === 1 ? "sealed" : "changed";
      },
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool: {
        plan: vi.fn(async () => ({
          title: "Explicit verification with provenance",
          reasoning: "Collect and verify repository evidence before synthesis.",
          steps: [{
            id: "collect-evidence",
            title: "Collect evidence",
            assignedAgentKind: "code",
            toolName: "code.searchRepository",
            toolInput: { goal: "find the entry point" },
            requiredCapabilities: ["code_search"],
            dependsOn: [],
            outputContextKey: "repoEvidence",
            successCriteria: "Repository evidence is collected.",
          }, {
            id: "verify-evidence",
            title: "Verify evidence",
            assignedAgentKind: "verifier",
            toolName: "verifier.check",
            requiredCapabilities: ["evidence_check"],
            dependsOn: ["collect-evidence"],
            inputContextKeys: ["repoEvidence"],
            outputContextKey: "verificationResult",
            successCriteria: "Repository evidence is verified.",
          }],
        })),
        synthesize,
      },
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        searchRepository: vi.fn(async () => mutableResult),
      },
      verifierTool: { check },
      taskId: "task-explicit-provenance-tamper",
      userGoal: "find the entry point",
    });

    expect(check).toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]).toMatchObject({
      status: "failed",
      verificationResult: {
        status: "fail",
        summary: expect.stringContaining("Implicit provenance verifier rejected"),
      },
    });
  });

  it("attaches a recovery report when Commander replans after a step failure", async () => {
    const plan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Recovery report task",
      reasoning: "Commander will recover from a failed repository search.",
      executionPolicy: {
        maxConcurrency: 1,
        maxRetries: 1,
        circuitBreakerFailureThreshold: 1,
        degradationStrategy: "replan" as const,
      },
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
    }));
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Here is the direct answer.",
    }));
    const commanderTool: CommanderTool = {
      plan,
      synthesize,
    };
    const searchRepository = vi.fn(async () => {
      throw new Error("HTTP 503 from repository search provider");
    });
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository,
    };
    const replanDag = vi.fn(async (
      _userGoal: string,
      _contextSnapshot: Record<string, unknown>,
      _failedStepId?: string,
      _failureReason?: string,
    ) => ({
      title: "Recovery plan",
      reasoning: "Use a direct synthesis step with partial evidence.",
      executionPolicy: {
        maxConcurrency: 2,
        maxRetries: 0,
        circuitBreakerFailureThreshold: 2,
        degradationStrategy: "partial_results" as const,
      },
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
    const savedCheckpoints: WorkflowCheckpoint[] = [];
    const runtimeEvents: RuntimeEventEnvelope[] = [];
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-recovery-report",
      userGoal: "summarize launch code",
      replanDag,
      runtimeEventSink: {
        append: async (event) => {
          runtimeEvents.push(event);
        },
      },
      checkpointSink: {
        save: async (checkpoint) => {
          savedCheckpoints.push(checkpoint);
        },
      },
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(replanDag).toHaveBeenCalledOnce();
    expect(finalSnapshot?.status).toBe("completed");
    expect(replanDag.mock.calls[0]?.[1]).toMatchObject({
      commanderFailureSummary: {
        failedStepId: "collect-evidence",
        failureKind: "network",
        errorSummary: expect.stringContaining("HTTP 503"),
        executionPolicy: expect.objectContaining({ maxConcurrency: 1 }),
      },
    });
    expect(finalSnapshot?.commanderMessage).toContain("Execution reliability score:");
    expect(finalSnapshot?.commanderMessage).toContain("Successful flow:");
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
    const recoveryCheckpoint = savedCheckpoints.find((checkpoint) =>
      checkpoint.workflowSnapshot.steps.some((step) => step.id === "recover-with-partial-evidence"),
    );
    expect(recoveryCheckpoint?.workflowSnapshot.steps.map((step) => step.id)).toEqual([
      "collect-evidence",
      "recover-with-partial-evidence",
    ]);
    expect(recoveryCheckpoint?.abandonedStepIds).toContain("collect-evidence");
    expect(recoveryCheckpoint?.pendingStepIds).not.toContain("collect-evidence");
    expect(recoveryCheckpoint?.contextSnapshot.commanderPlan?.payload).toMatchObject({
      executionPolicy: expect.objectContaining({ maxConcurrency: 2 }),
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "recover-with-partial-evidence" }),
      ]),
    });
    expect(recoveryCheckpoint?.pendingStepIds).toContain("recover-with-partial-evidence");

    if (!recoveryCheckpoint) {
      throw new Error("Expected a recovery checkpoint.");
    }
    const planCallCount = plan.mock.calls.length;
    const searchCallCount = searchRepository.mock.calls.length;
    const synthesisCallCount = synthesize.mock.calls.length;
    const checkpointEvents = runtimeEvents.filter(
      (event) => event.sequence <= recoveryCheckpoint.eventSequence,
    );
    const resumed = createTestController();

    await runCommanderDagTask({
      controller: resumed.controller,
      commanderTool,
      codeTool,
      taskId: recoveryCheckpoint.taskId,
      userGoal: "summarize launch code",
      resumeFromCheckpoint: {
        checkpoint: recoveryCheckpoint,
        events: checkpointEvents,
      },
    });
    expect(plan).toHaveBeenCalledTimes(planCallCount);
    expect(searchRepository).toHaveBeenCalledTimes(searchCallCount);
    expect(synthesize).toHaveBeenCalledTimes(synthesisCallCount + 1);
    const lastSynthesisRequest = synthesize.mock.calls[synthesize.mock.calls.length - 1]?.[0];
    const finalResumedSnapshot = resumed.emitted[resumed.emitted.length - 1];
    expect(lastSynthesisRequest?.evidence).toMatchObject({
      userGoal: "summarize launch code",
      commanderPlan: {
        steps: expect.arrayContaining([
          expect.objectContaining({ id: "recover-with-partial-evidence" }),
        ]),
      },
    });
    expect(finalResumedSnapshot?.status).toBe("completed");
    expect(finalResumedSnapshot?.plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "collect-evidence", status: "failed" }),
      expect.objectContaining({ id: "recover-with-partial-evidence", status: "completed" }),
    ]));
  });

  it("resumes a replacement producer after persisting recovery dependencies", async () => {
    const plan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Recovery dependency task",
      reasoning: "Collect evidence, then synthesize it.",
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
    }));
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "packages/core/src/index.ts",
    }));
    const searchRepository = vi.fn(async (request: { goal: string }) => {
      if (request.goal === "find launch code") {
        throw new Error("HTTP 503 from repository search provider");
      }
      return {
        actualFound: [],
        inferred: [],
        needsConfirmation: [],
        keyFiles: ["packages/core/src/index.ts"],
        relatedTestFiles: [],
        testFileCandidates: [],
        clusters: [],
        attempts: [],
      };
    });
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository,
    };
    const replanDag = vi.fn(async () => ({
      title: "Replacement evidence plan",
      reasoning: "Retry evidence collection with a new recovery step.",
      steps: [{
        id: "recover-evidence",
        title: "Recover evidence",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        toolInput: { goal: "retry launch code search" },
        requiredCapabilities: ["code_search"],
        dependsOn: ["collect-evidence"],
        outputContextKey: "repoEvidence",
        successCriteria: "Replacement repository evidence is collected.",
      }],
    }));
    const runtimeEvents: RuntimeEventEnvelope[] = [];
    const savedCheckpoints: WorkflowCheckpoint[] = [];
    const firstRun = createTestController();

    await runCommanderDagTask({
      controller: firstRun.controller,
      commanderTool: { plan, synthesize },
      codeTool,
      taskId: "task-recovery-dependency-resume",
      userGoal: "summarize launch code",
      replanDag,
      runtimeEventSink: {
        append: async (event) => {
          runtimeEvents.push(event);
        },
      },
      checkpointSink: {
        save: async (checkpoint) => {
          savedCheckpoints.push(checkpoint);
        },
      },
    });

    const recoveryCheckpoint = savedCheckpoints.find((checkpoint) =>
      checkpoint.completedStepIds.includes("recover-evidence") &&
      checkpoint.pendingStepIds.includes("summarize-evidence"),
    );
    expect(recoveryCheckpoint).toBeDefined();
    if (!recoveryCheckpoint) {
      throw new Error("Expected a checkpoint after replacement evidence completed.");
    }
    expect(recoveryCheckpoint.workflowSnapshot.steps.find(
      (step) => step.id === "summarize-evidence",
    )?.dependsOn).toEqual(["recover-evidence"]);
    expect(recoveryCheckpoint.planHash).toBe(
      computePlanHash(recoveryCheckpoint.workflowSnapshot.steps),
    );
    expect(recoveryCheckpoint.contextSnapshot.repoEvidence?.producer.stepId).toBe(
      "recover-evidence",
    );

    const planCallCount = plan.mock.calls.length;
    const searchCallCount = searchRepository.mock.calls.length;
    const resumed = createTestController();
    await runCommanderDagTask({
      controller: resumed.controller,
      commanderTool: { plan, synthesize },
      codeTool,
      taskId: recoveryCheckpoint.taskId,
      userGoal: "summarize launch code",
      resumeFromCheckpoint: {
        checkpoint: recoveryCheckpoint,
        events: runtimeEvents.filter(
          (event) => event.sequence <= recoveryCheckpoint.eventSequence,
        ),
      },
    });

    expect(plan).toHaveBeenCalledTimes(planCallCount);
    expect(searchRepository).toHaveBeenCalledTimes(searchCallCount);
    const finalResumedSnapshot = resumed.emitted[resumed.emitted.length - 1];
    expect(finalResumedSnapshot).toMatchObject({
      status: "completed",
      plan: expect.arrayContaining([
        expect.objectContaining({ id: "collect-evidence", status: "failed" }),
        expect.objectContaining({ id: "recover-evidence", status: "completed" }),
        expect.objectContaining({ id: "summarize-evidence", status: "completed" }),
      ]),
    });
  });

  it("rejects recovery steps that reuse an existing DAG id without abandoning the failed step", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This duplicate recovery must not be synthesized.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Duplicate recovery task",
        reasoning: "Collect repository evidence.",
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
      synthesize,
    };
    const replanDag = vi.fn(async () => ({
      title: "Invalid duplicate recovery",
      reasoning: "Retry the failed step under the same id.",
      steps: [{
        id: "collect-evidence",
        title: "Retry evidence collection",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        toolInput: { goal: "find alternate launch code" },
        requiredCapabilities: ["code_search"],
        dependsOn: [] as string[],
        outputContextKey: "repoEvidence",
        successCriteria: "Alternate repository evidence is collected.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool: {
        inspectRepository: vi.fn(async () => ({
          workspacePath: "E:/Javis",
          changedFiles: [],
          diffStat: "0 files changed",
          diff: "",
        })),
        searchRepository: vi.fn(async () => {
          throw new Error("HTTP 503 from repository search provider");
        }),
      },
      taskId: "task-duplicate-recovery-id",
      userGoal: "summarize launch code",
      replanDag,
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(replanDag).toHaveBeenCalledOnce();
    expect(synthesize).not.toHaveBeenCalled();
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.recoveryReport).toMatchObject({
      status: "needs_attention",
      abandonedStepIds: [],
      replannedStepIds: [],
      attempts: [expect.objectContaining({
        failedStepId: "collect-evidence",
        replanStatus: "failed",
        abandonedFailedStep: false,
        recoveryStepIds: [],
        detail: expect.stringContaining("already present in the active DAG"),
      })],
    });
    expect(finalSnapshot?.plan).toEqual([
      expect.objectContaining({ id: "collect-evidence", status: "failed" }),
    ]);
  });

  it("stops recovery replanning at the configured maximum", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Bounded recovery",
        reasoning: "A failed scan may be retried with one recovery step.",
        steps: [{
          id: "initial-scan",
          title: "Initial scan",
          assignedAgentKind: "file",
          toolName: "file.scanMarkdownDocuments",
          requiredCapabilities: ["file_scan"],
          dependsOn: [],
          successCriteria: "Documents are scanned.",
        }],
      })),
    };
    const scanMarkdownDocuments = vi.fn(async () => {
      throw new Error("scan input is invalid");
    });
    const replanDag = vi.fn(async () => ({
      title: "Single recovery",
      reasoning: "Retry once with a new step.",
      steps: [{
        id: "recovery-scan",
        title: "Recovery scan",
        assignedAgentKind: "file",
        toolName: "file.scanMarkdownDocuments",
        requiredCapabilities: ["file_scan"],
        dependsOn: ["initial-scan"],
        successCriteria: "Documents are scanned through the fallback.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      fileTool: { scanMarkdownDocuments },
      taskId: "task-bounded-recovery",
      userGoal: "scan documents",
      replanDag,
      runtimeConfig: { maxReplans: 1, maxStepRetries: 0 },
    });

    expect(replanDag).toHaveBeenCalledOnce();
    expect(scanMarkdownDocuments).toHaveBeenCalledTimes(2);
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.recoveryReport?.attempts).toHaveLength(2);
    expect(finalSnapshot?.recoveryReport?.attempts[1]).toMatchObject({
      failedStepId: "recovery-scan",
      replanAttempted: false,
      replanStatus: "not_attempted",
    });
    expect(finalSnapshot?.recoveryReport?.attempts[1]?.detail).toContain(
      "Maximum recovery replan limit (1) reached",
    );
  });

  it("abandons recovery when Commander replan fails the compile gate", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Initial plan",
        reasoning: "Will trigger a recovery.",
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
    // Recovery plan: references an agent kind that doesn't exist in
    // availableTools, so compileCommanderPlan must reject it.
    const replanDag = vi.fn(async () => ({
      title: "Broken recovery plan",
      reasoning: "Recovery step references an unknown agent kind.",
      steps: [{
        id: "recover-broken",
        title: "Broken recovery",
        assignedAgentKind: "totally-unknown-agent",
        requiredCapabilities: [],
        dependsOn: ["collect-evidence"],
        successCriteria: "Will not be reached.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-recovery-gate-fail",
      userGoal: "summarize launch code",
      replanDag,
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(replanDag).toHaveBeenCalledOnce();
    // The recovery plan was rejected by the compile gate, so the task
    // ends as failed (not recovered, not completed).
    expect(finalSnapshot?.status).toBe("failed");
    const report = finalSnapshot?.recoveryReport;
    expect(report).toBeDefined();
    expect(report).toMatchObject({
      failureCount: 1,
      recoveredCount: 0,
      unrecoveredCount: 1,
    });
    expect(report?.attempts[0]).toMatchObject({
      failedStepId: "collect-evidence",
      replanAttempted: true,
      replanStatus: "failed",
    });
    // Diagnostic must include the compile-gate marker AND the offending
    // diagnostic code surfaced by compileCommanderPlan.
    expect(report?.attempts[0].detail).toContain("recovery plan failed compile gate");
    expect(report?.attempts[0].detail).toContain("UNKNOWN_AGENT");
  });

  it("emits a durable step.failed event when a DAG step fails", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Failing plan",
        reasoning: "Commander will execute a step that fails.",
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
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0 files changed",
        diff: "",
      })),
      searchRepository: vi.fn(async () => {
        throw new Error("repository search failed");
      }),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-step-failed",
      userGoal: "summarize launch code",
    });

    expect(emitted.some((snapshot) =>
      snapshot.logs.some((log) =>
        log.title === "step.failed" && log.detail.includes("repository search failed"),
      ),
    )).toBe(true);
  });

  it("attaches a PlanGenerationTrace with initial + recovery compile records", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Initial plan",
        reasoning: "Will trigger a recovery and capture the trace.",
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
        message: "Here is the direct answer.",
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
      reasoning: "Use a direct synthesis step.",
      steps: [{
        id: "recover-with-partial-evidence",
        title: "Recover with partial evidence",
        assignedAgentKind: "commander",
        executionMode: "direct_response" as const,
        requiredCapabilities: ["synthesis"],
        dependsOn: ["collect-evidence"],
        outputContextKey: "recoverySummary",
        successCriteria: "Recovery summary written.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-plan-trace",
      userGoal: "summarize launch code",
      replanDag,
    });

    const finalSnapshot = emitted[emitted.length - 1];
    const trace = finalSnapshot?.planGenerationTrace;
    expect(trace).toBeDefined();
    expect(trace?.userGoal).toBe("summarize launch code");
    expect(trace?.initialCompiled).toBe(true);
    expect(trace?.repairAttemptCount).toBe(0);
    expect(trace?.stages).toHaveLength(1);
    expect(trace?.stages[0]).toMatchObject({
      stage: "initial",
      status: "compiled",
      stepIds: ["collect-evidence"],
    });
    // Recovery: compile gate accepted the recovery plan.
    expect(trace?.recoveryCompiles).toHaveLength(1);
    expect(trace?.recoveryCompiles[0]).toMatchObject({
      stage: "recovery",
      failedStepId: "collect-evidence",
      status: "compiled",
      stepIds: ["recover-with-partial-evidence"],
    });
    // Schema-versioning + raw captured artifacts.
    expect(trace?.schemaVersion).toBe("1.0.0");
    expect(trace?.planSchemaVersion).toBe("1.2.0");
    expect(trace?.promptVersion).toBeDefined();
    expect(trace?.extractedJson).toBeDefined();
    expect(trace?.normalizedPlan).toBeDefined();
    const parsedNormalized = trace?.normalizedPlan as { steps: Array<{ id: string }> } | undefined;
    expect(parsedNormalized?.steps.map((s) => s.id)).toEqual(["collect-evidence"]);
  });

  it("records the recovery compile failure on PlanGenerationTrace when recovery plan fails the gate", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Initial plan",
        reasoning: "Triggers a recovery that will fail compile.",
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
      title: "Broken recovery plan",
      reasoning: "References an unknown agent.",
      steps: [{
        id: "recover-broken",
        title: "Broken recovery",
        assignedAgentKind: "totally-unknown-agent",
        requiredCapabilities: [],
        dependsOn: ["collect-evidence"],
        successCriteria: "Will not be reached.",
      }],
    }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-trace-gate-fail",
      userGoal: "summarize launch code",
      replanDag,
    });

    const finalSnapshot = emitted[emitted.length - 1];
    const trace = finalSnapshot?.planGenerationTrace;
    expect(trace).toBeDefined();
    expect(trace?.recoveryCompiles).toHaveLength(1);
    expect(trace?.recoveryCompiles[0]).toMatchObject({
      stage: "recovery",
      failedStepId: "collect-evidence",
      // UNKNOWN_AGENT is non-repairable, so the status must reflect that.
      status: "failed_non_repairable",
    });
    expect(trace?.recoveryCompiles[0].diagnostics.some(
      (d) => d.code === "UNKNOWN_AGENT",
    )).toBe(true);
  });
});

describe("executeCapabilityStep synthesis dispatch", () => {
  it("fails closed instead of calling raw commander.synthesize", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Ungrounded model conclusion",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn() as unknown as CommanderTool["plan"],
      synthesize,
    };

    await expect(executeCapabilityStep(
      {
        id: "unsafe-synthesis",
        title: "Unsafe synthesis",
        assignedAgentKind: "commander",
        toolName: "commander.synthesize",
        requiredCapabilities: ["synthesis"],
        dependsOn: [],
        executionMode: "direct_tool_call",
        successCriteria: "A conclusion is returned.",
      },
      createSharedTaskContext({ userGoal: "Summarize", evidence: {} }),
      { commanderTool },
    )).rejects.toThrow(/evidence-validated direct_response path/);

    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("Commander direct_response evidence boundary", () => {
  it("fails instead of persisting an ungrounded plan title when synthesis is rejected", async () => {
    const ungroundedTitle = "Project uses PostgreSQL";
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: ungroundedTitle,
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Answer project question",
        reasoning: "The answer requires an evidence-bound synthesis.",
        steps: [{
          id: "answer-project-question",
          title: ungroundedTitle,
          assignedAgentKind: "commander",
          executionMode: "direct_response",
          dependsOn: [],
          successCriteria: "Return an evidence-bound answer.",
        }],
      })),
      synthesize,
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      taskId: "task-direct-response-evidence-boundary",
      userGoal: "Summarize the project without running tools.",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.commanderMessage).not.toContain(ungroundedTitle);
    expect(emitted.some((snapshot) => snapshot.commanderMessage === ungroundedTitle)).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("uses verified structured hot-list evidence when model synthesis is rejected", async () => {
    const ungroundedConclusion = "数据库使用 PostgreSQL。";
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: ungroundedConclusion,
    }));
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-07-16T07:54:45.935Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 2,
      complete: true,
      warnings: [],
      diagnostics: [{
        provider: "weibo",
        sourceUrl: "https://weibo.com/ajax/side/hotSearch",
        requestedLimit: 2,
        startedAt: "2026-07-16T07:54:43.337Z",
        finishedAt: "2026-07-16T07:54:45.935Z",
        durationMs: 2598,
        status: "completed",
        httpStatus: 200,
        itemCount: 2,
      }],
      items: [
        { rank: 1, title: "突然觉得有车真的很方便", hotScore: 3166709, label: "热" },
        { rank: 2, title: "阿根廷球员偷看英格兰战术小抄", hotScore: 1094261 },
      ],
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "统计微博热搜 Top2 并生成总结",
        reasoning: "抓取、验证并总结结构化热搜数据。",
        steps: [{
          id: "fetch-weibo-hot-list",
          title: "抓取微博热搜 Top2",
          assignedAgentKind: "research",
          toolName: "trend.fetchHotList",
          requiredCapabilities: ["trend_fetch"],
          dependsOn: [],
          toolInput: { provider: "weibo", limit: 2 },
          outputContextKey: "weiboHotList",
          executionMode: "direct_tool_call" as const,
          successCriteria: "成功获取微博热搜前2条。",
        }, {
          id: "verify-hot-list",
          title: "验证热搜数据",
          assignedAgentKind: "verifier",
          toolName: "verifier.check",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["fetch-weibo-hot-list"],
          inputContextKeys: ["weiboHotList"],
          outputContextKey: "verificationResult",
          executionMode: "direct_tool_call" as const,
          successCriteria: "热搜数据完整且格式正确。",
        }, {
          id: "synthesize-summary",
          title: "生成热搜总结",
          assignedAgentKind: "commander",
          requiredCapabilities: ["synthesis"],
          dependsOn: ["fetch-weibo-hot-list", "verify-hot-list"],
          inputContextKeys: ["weiboHotList", "verificationResult"],
          executionMode: "direct_response" as const,
          successCriteria: "基于已验证热搜数据生成总结。",
        }],
      })),
      synthesize,
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      trendTool: { fetchHotList },
      verifierTool: {
        check: vi.fn(async () => ({
          status: "pass" as const,
          summary: "热搜数据验证通过。",
          detail: "两条记录均包含排名、标题和热度。",
        })),
      },
      taskId: "task-verified-trend-fallback",
      userGoal: "帮我总结微博热搜 Top2",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.commanderMessage).toContain("微博热搜 Top 2");
    expect(finalSnapshot?.commanderMessage).toContain("突然觉得有车真的很方便");
    expect(finalSnapshot?.commanderMessage).toContain("阿根廷球员偷看英格兰战术小抄");
    expect(finalSnapshot?.commanderMessage).not.toContain(ungroundedConclusion);
    expect(synthesize).toHaveBeenCalledTimes(1);
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

describe("executeCapabilityStep verifier dispatch", () => {
  it("builds verifier evidence from declared handoff artifacts for capability-only steps", async () => {
    const repoEvidence = {
      query: "workflow executor",
      paths: ["packages/core/src/workflow-executor.ts"],
    };
    const context = createSharedTaskContext({ repoEvidence });
    const check = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Evidence is sufficient.",
      detail: "Repository evidence names the inspected implementation.",
    }));

    const result = await executeCapabilityStep(
      {
        id: "verify-repo-evidence",
        title: "Verify repository evidence",
        assignedAgentKind: "verifier",
        capability: "evidence_check",
        requiredCapabilities: ["evidence_check"],
        dependsOn: ["collect-repo-evidence"],
        inputContextKeys: ["repoEvidence"],
        successCriteria: "Repository evidence supports the conclusion.",
      },
      context,
      { verifierTool: { check } },
    );

    expect(result.toolName).toBe("verifier.check");
    expect(check).toHaveBeenCalledWith({
      stepId: "verify-repo-evidence",
      successCriteria: "Repository evidence supports the conclusion.",
      evidence: [{
        kind: "log",
        label: "Handoff artifact: repoEvidence",
        data: repoEvidence,
      }],
    });
  });

  it("rejects an explicitly empty verifier evidence list", async () => {
    const check = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Should not run.",
      detail: "No evidence was supplied.",
    }));

    await expect(executeCapabilityStep(
      {
        id: "verify-empty-evidence",
        title: "Verify empty evidence",
        assignedAgentKind: "verifier",
        toolName: "verifier.check",
        requiredCapabilities: ["evidence_check"],
        dependsOn: [],
        toolInput: { evidence: [] },
        successCriteria: "Evidence must be present.",
      },
      createSharedTaskContext({ userGoal: "empty evidence" }),
      { verifierTool: { check } },
    )).rejects.toThrow("requires at least one evidence item");
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects malformed verifier evidence items before dispatch", async () => {
    const check = vi.fn<VerifierTool["check"]>();

    await expect(executeCapabilityStep(
      {
        id: "verify-malformed-evidence",
        title: "Verify malformed evidence",
        assignedAgentKind: "verifier",
        toolName: "verifier.check",
        requiredCapabilities: ["evidence_check"],
        dependsOn: [],
        toolInput: { evidence: [{ kind: "log", label: "" }] },
        successCriteria: "Evidence items match the verifier contract.",
      },
      createSharedTaskContext({ userGoal: "malformed evidence" }),
      { verifierTool: { check } },
    )).rejects.toThrow("must include a valid kind, non-empty label, and data field");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("runGenericWorkbenchWorkflow workspace registry dispatch", () => {
  it("honors a live workspace agent allowlist during concrete tool dispatch", async () => {
    const customAgentKind = "workspace.demo.registry-reader" as const;
    const customAgent: Agent = {
      id: "workspace-demo-registry-reader",
      kind: customAgentKind,
      displayName: "Workspace Registry Reader",
      description: "Reads workspace documents.",
      allowedToolNames: ["file.scanMarkdownDocuments"],
      modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8_000 },
      systemPrompt: { en: "Read workspace documents.", zhCN: "读取工作区文档。" },
    };
    const agentRegistry = createAgentRegistry([...demoAgents, customAgent]);
    const scanMarkdownDocuments = vi.fn(async () => [{
      path: "README.md",
      modifiedAt: "2026-07-12T00:00:00.000Z",
      sizeBytes: 12,
    }]);
    const context = createSharedTaskContext({ userGoal: "scan workspace documents" });

    const result = await executeCapabilityStep(
      {
        id: "workspace-scan",
        title: "Scan workspace documents",
        assignedAgentKind: customAgentKind,
        toolName: "file.scanMarkdownDocuments",
        requiredCapabilities: ["file_scan"],
        dependsOn: [],
        outputContextKey: "fileScanResults",
        successCriteria: "Workspace documents are collected.",
      },
      context,
      { fileTool: { scanMarkdownDocuments } },
      { agentRegistry },
    );

    expect(result.toolName).toBe("file.scanMarkdownDocuments");
    expect(scanMarkdownDocuments).toHaveBeenCalledTimes(1);
    expect(context.get("fileScanResults")).toEqual([expect.objectContaining({ path: "README.md" })]);

    const capabilityResult = await executeCapabilityStep(
      {
        id: "workspace-scan-by-capability",
        title: "Scan workspace documents by capability",
        assignedAgentKind: customAgentKind,
        capability: "file_scan",
        requiredCapabilities: ["file_scan"],
        dependsOn: [],
        outputContextKey: "capabilityFileScanResults",
        successCriteria: "Workspace documents are collected by capability.",
      },
      context,
      { fileTool: { scanMarkdownDocuments } },
      { agentRegistry },
    );

    expect(capabilityResult.toolName).toBe("file.scanMarkdownDocuments");
    expect(scanMarkdownDocuments).toHaveBeenCalledTimes(2);
  });

  it("executes a workspace workflow from the registry instead of falling back to a built-in blueprint", async () => {
    const workflowId = "workspace.demo.registry-flow" as const;
    const customAgentKind = "workspace.demo.registry-reviewer" as const;
    const customAgent: Agent = {
      id: "workspace-demo-registry-reviewer",
      kind: customAgentKind,
      displayName: "Workspace Registry Reviewer",
      description: "Reviews workspace registry evidence.",
      allowedToolNames: [],
      modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8_000 },
      systemPrompt: { en: "Review workspace evidence.", zhCN: "Review workspace evidence." },
    };
    const agentRegistry = createAgentRegistry([...demoAgents, customAgent]);
    const workflow: WorkbenchWorkflow = {
      id: workflowId,
      title: "Workspace registry flow",
      triggerExamples: ["run registry flow"],
      goal: "Exercise a workspace-provided workflow blueprint.",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander", customAgentKind, "verifier"],
      steps: [{
        id: "classify-documents",
        title: "Classify workspace evidence",
        agentKind: customAgentKind,
        input: "Workspace path",
        output: "Document summaries",
        permissionLevel: "read",
        dependsOn: [],
        canRunInParallel: false,
      }],
      currentSupport: "implemented",
      safetyNotes: ["Read-only test workflow."],
    };
    const registry = createWorkflowRegistry();
    registry.register(workflow);
    const { controller, emitted } = createTestController();
    const plan = vi.fn<CommanderTool["plan"]>(async () => ({
      title: "Workspace registry plan",
      reasoning: "Use the workspace reviewer.",
      steps: [],
    }));

    await runGenericWorkbenchWorkflow({
      controller,
      agentRegistry,
      commanderTool: { plan },
      verifierTool: {
        check: vi.fn(async () => ({
          status: "pass" as const,
          summary: "Workspace flow verified.",
          detail: "Registry workflow executed.",
        })),
      },
      taskId: "task-workspace-registry-flow",
      userGoal: "run registry flow",
      workflowId,
      workflowRegistry: registry,
    });

    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]?.[0].availableAgents.some((agent) => agent.kind === customAgentKind)).toBe(true);
    expect(emitted[0]?.title).toBe("Workspace registry flow");
    expect(emitted[emitted.length - 1]?.agents.find((agent) => agent.id === customAgent.id)?.status)
      .toBe("completed");
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
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

  it("uses the browser tool for structured hot-list research when available", async () => {
    const context = createSharedTaskContext({
      userGoal: "summarize top 2 Weibo hot searches",
      taskId: "task-browser-trend-fetch",
    });
    const navigate = vi.fn<BrowserTool["navigate"]>(async (request) => ({
      url: request.url,
      title: "Weibo hot list",
      status: 200,
      loadState: "load",
    }));
    const getContent = vi.fn<BrowserTool["getContent"]>(async () => ({
      url: "https://weibo.com/ajax/side/hotSearch",
      title: "Weibo hot list",
      content: JSON.stringify({
        data: {
          realtime: [
            { word: "Browser collected topic", rank: 0, raw_hot: 123 },
            { note: "Second browser topic", rank: 0, num: "99" },
          ],
        },
      }),
    }));
    const browserTool = createBrowserTool({ navigate, getContent });
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => {
      throw new Error("direct trend tool should not be used");
    });

    const result = await executeCapabilityStep(
      {
        id: "fetch-hot-list",
        title: "Fetch Weibo hot list",
        assignedAgentKind: "research",
        capability: "trend_fetch",
        requiredCapabilities: ["trend_fetch"],
        dependsOn: [],
        toolInput: { provider: "weibo", limit: 2 },
        outputContextKey: "hotList",
        successCriteria: "Structured hot list is collected.",
      },
      context,
      { browserTool, trendTool: { fetchHotList } },
    );

    expect(result.toolName).toBe("trend.fetchHotList");
    expect(fetchHotList).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://weibo.com/ajax/side/hotSearch",
      referrer: "https://weibo.com/",
    }));
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({
      format: "text",
    }));
    expect(context.get("hotList")).toMatchObject({
      provider: "weibo",
      expectedCount: 2,
      complete: true,
      items: [
        expect.objectContaining({ rank: 1, title: "Browser collected topic", hotScore: 123 }),
        expect.objectContaining({ rank: 2, title: "Second browser topic", hotScore: 99 }),
      ],
      diagnostics: [
        expect.objectContaining({
          provider: "weibo:browser:weibo-side-hot-search",
          status: "completed",
          itemCount: 2,
        }),
      ],
    });
  });

  it("falls back to the direct trend tool when browser hot-list extraction fails", async () => {
    const context = createSharedTaskContext({
      userGoal: "summarize top 2 Weibo hot searches",
      taskId: "task-browser-trend-fallback",
    });
    const navigate = vi.fn<BrowserTool["navigate"]>(async () => {
      throw new Error("sidecar unavailable");
    });
    const browserTool = createBrowserTool({
      navigate,
      getContent: vi.fn<BrowserTool["getContent"]>(),
    });
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 2,
      complete: true,
      warnings: [],
      diagnostics: [{
        provider: "weibo",
        sourceUrl: "https://weibo.com/ajax/side/hotSearch",
        requestedLimit: 2,
        startedAt: "2026-06-10T00:00:00.000Z",
        finishedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 0,
        status: "completed",
        httpStatus: 200,
        itemCount: 2,
      }],
      items: [
        { rank: 1, title: "Direct fallback topic", hotScore: 321 },
        { rank: 2, title: "Second fallback topic", hotScore: 99 },
      ],
    }));

    const result = await executeCapabilityStep(
      {
        id: "fetch-hot-list",
        title: "Fetch Weibo hot list",
        assignedAgentKind: "research",
        capability: "trend_fetch",
        requiredCapabilities: ["trend_fetch"],
        dependsOn: [],
        toolInput: { provider: "weibo", limit: 2 },
        outputContextKey: "hotList",
        successCriteria: "Structured hot list is collected.",
      },
      context,
      { browserTool, trendTool: { fetchHotList } },
    );

    expect(result.toolName).toBe("trend.fetchHotList");
    expect(fetchHotList).toHaveBeenCalledWith({
      provider: "weibo",
      fallbackProviders: undefined,
      limit: 2,
    });
    expect(context.get("hotList")).toEqual(expect.objectContaining({
      provider: "weibo",
      items: expect.arrayContaining([
        expect.objectContaining({ title: "Direct fallback topic" }),
        expect.objectContaining({ title: "Second fallback topic" }),
      ]),
      warnings: expect.arrayContaining([expect.stringContaining("direct trend provider fallback")]),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          provider: "weibo:browser:weibo-side-hot-search",
          status: "failed",
          error: expect.stringContaining("sidecar unavailable"),
        }),
        expect.objectContaining({
          provider: "weibo",
          status: "completed",
        }),
      ]),
    }));
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

describe("runCommanderDagTask plan repair loop", () => {
  it("invokes the Commander again with repairContext when the first plan is repairable-but-invalid", async () => {
    const planCalls: Array<{ repairContext?: unknown; tag: string }> = [];
    const invalidPlan = {
      title: "Broken",
      reasoning: "Missing dependency on a step that does not exist.",
      steps: [{
        id: "analyze",
        title: "Analyze",
        assignedAgentKind: "code",
        toolName: "code.inspectRepository",
        toolInput: { workspacePath: "E:/Javis" },
        requiredCapabilities: [],
        dependsOn: ["ghost-step"],
        successCriteria: "Done.",
      }],
    };
    const repairedPlan = {
      title: "Repaired",
      reasoning: "Removed the ghost dependency.",
      steps: [{
        id: "analyze",
        title: "Analyze",
        assignedAgentKind: "code",
        toolName: "code.inspectRepository",
        toolInput: { workspacePath: "E:/Javis" },
        requiredCapabilities: [],
        dependsOn: [],
        successCriteria: "Done.",
      }],
    };
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        const tag = request.repairContext
          ? `repair#${request.repairContext.attempt}`
          : "initial";
        planCalls.push({ repairContext: request.repairContext, tag });
        if (request.repairContext) {
          return repairedPlan;
        }
        return invalidPlan;
      }),
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0",
        diff: "",
      })),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-repair-1",
      userGoal: "Analyze the repository",
    });

    // First call is the normal plan, second call is the repair attempt.
    expect(planCalls).toHaveLength(2);
    expect(planCalls[0].tag).toBe("initial");
    expect(planCalls[1].tag).toBe("repair#1");
    expect(planCalls[0].repairContext).toBeUndefined();
    expect(planCalls[1].repairContext).toBeDefined();
    expect((planCalls[1].repairContext as { attempt: number }).attempt).toBe(1);

    const allLogs = emitted.flatMap((s) => s.logs);
    const repairStartLog = allLogs.find((log) =>
      (log.detail ?? "").includes("attempting repair"),
    );
    expect(repairStartLog).toBeDefined();

    const repairOkLog = allLogs.find((log) =>
      (log.detail ?? "").includes("Repair attempt 1 compiled"),
    );
    expect(repairOkLog).toBeDefined();
  });

  it("does not call repair when the first plan is non-repairable and surfaces the failure", async () => {
    const planCalls: Array<{ repairContext?: unknown }> = [];
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async (request) => {
        planCalls.push({ repairContext: request.repairContext });
        return {
          title: "Bad",
          reasoning: "References a tool the runtime does not have.",
          steps: [{
            id: "x",
            title: "X",
            assignedAgentKind: "code",
            toolName: "does.not.exist",
            requiredCapabilities: ["code_search"],
            dependsOn: [],
            successCriteria: "Done.",
          }],
        };
      }),
    };
    const codeTool: CodeTool = {
      inspectRepository: vi.fn(async () => ({
        workspacePath: "E:/Javis",
        changedFiles: [],
        diffStat: "0",
        diff: "",
      })),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      codeTool,
      taskId: "task-repair-2",
      userGoal: "List a directory",
    });

    // Only the initial plan call should have happened; UNKNOWN_TOOL is non-repairable.
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0].repairContext).toBeUndefined();

    const failureLog = emitted.flatMap((s) => s.logs).find((log) =>
      (log.detail ?? "").includes("Commander plan compilation failed"),
    );
    expect(failureLog).toBeDefined();
  });

  it("records INVALID_PLAN_SHAPE for malformed initial plans without desktop fallback", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn<CommanderTool["plan"]>(async () => ({
        title: "Malformed",
        reasoning: "Missing steps.",
      } as unknown as Awaited<ReturnType<CommanderTool["plan"]>>)),
    };
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      taskId: "task-repair-invalid-shape",
      userGoal: "Click the save button",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot.status).toBe("failed");
    expect(finalSnapshot.planGenerationTrace?.stages[0]).toMatchObject({
      stage: "initial",
      status: "failed_non_repairable",
      diagnostics: [expect.objectContaining({ code: "INVALID_PLAN_SHAPE" })],
    });
    expect(emitted.flatMap((snapshot) => snapshot.logs).some((log) =>
      (log.detail ?? "").includes("Commander JSON plan failed")
    )).toBe(false);
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
    const runtimePayloads: Array<Record<string, unknown>> = [];

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planStageFiles, executeStageFiles },
      taskId: "task-git-stage",
      userGoal: "stage README.md",
      runtimeEventSink: {
        append: async (envelope) => {
          runtimePayloads.push(envelope.payload as Record<string, unknown>);
        },
      },
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
    const permissionEvents = runtimePayloads.filter((event) =>
      event.kind === "permission.requested" || event.kind === "permission.resolved"
    );
    expect(permissionEvents).toEqual([
      expect.objectContaining({
        kind: "permission.requested",
        stepId: "stage-selected",
        toolName: "git.stageFiles",
        previewHash: expect.stringMatching(/^dryrun-fnv1a-[a-f0-9]{8}$/),
      }),
      expect.objectContaining({
        kind: "permission.resolved",
        stepId: "stage-selected",
        toolName: "git.stageFiles",
        previewHash: permissionEvents[0]?.previewHash,
      }),
    ]);
    expect((permissionEvents[0]?.request as Record<string, unknown>)?.bindingHash)
      .toBe(permissionEvents[0]?.previewHash);
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
    expect(JSON.stringify(emitted)).toContain("Staged 1 file(s): README.md.");
  });

  it("does not stage files when durable approval persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      for (const failingSink of ["runtime-event", "checkpoint"] as const) {
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
          approvalId: `approval-stage-${failingSink}`,
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
        let rejected = false;

        const runPromise = runCommanderDagTask({
          controller,
          commanderTool,
          gitTool: { planStageFiles, executeStageFiles },
          taskId: `task-durable-stage-${failingSink}`,
          userGoal: "stage README.md",
          ...(failingSink === "runtime-event"
            ? {
              runtimeEventSink: {
                append: async (envelope: RuntimeEventEnvelope) => {
                  if (!rejected && (envelope.payload as { kind?: string }).kind === "permission.resolved") {
                    rejected = true;
                    throw new Error("runtime event database is unavailable");
                  }
                },
              },
            }
            : {
              checkpointSink: {
                save: async (checkpoint: WorkflowCheckpoint) => {
                  if (!rejected && checkpoint.waitingReason === "human_approval") {
                    rejected = true;
                    throw new Error("checkpoint database is unavailable");
                  }
                },
              },
            }),
        });

        const [, handler] = await waitForPermissionHandler(permissionHandlers);
        await handler("approved");
        await runPromise;

        expect(rejected).toBe(true);
        expect(planStageFiles).toHaveBeenCalledOnce();
        expect(executeStageFiles).not.toHaveBeenCalled();
        expect(emitted[emitted.length - 1]?.status).toBe("failed");
        expect(emitted[emitted.length - 1]?.commanderMessage).toContain(
          `Durable persistence failed in ${failingSink}-sink`,
        );
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it("runs approved Git stage through WorkspaceRuntime when a write-capable runtime is provided", async () => {
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
      approvalId: "approval-stage-runtime",
      preview: {
        workspaceRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        files: [],
        diffStat: "",
        diff: "",
        dryRun: {
          operation: "git.stageFiles",
          affectedPaths: [{ source: "README.md", target: "Git index", action: "stage" }],
          riskSummary: "Stages selected files in the Git index.",
          reversible: true,
        },
      },
    }));
    const executeStageFiles = vi.fn<NonNullable<GitTool["executeStageFiles"]>>(async () => {
      throw new Error("executeStageFiles should not be called when runtime is write-capable");
    });
    const workspaceRuntime = createTestWorkspaceRuntime();
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planStageFiles, executeStageFiles },
      workspaceRuntime,
      taskId: "task-git-stage-runtime",
      userGoal: "stage README.md",
    });

    const [, handler] = await waitForPermissionHandler(permissionHandlers);
    await handler("approved");
    await runPromise;

    expect(executeStageFiles).not.toHaveBeenCalled();
    expect(workspaceRuntime.execute).toHaveBeenCalledWith({
      program: "git",
      args: ["add", "--", "README.md"],
      cwd: workspaceRuntime.root,
      permissionLevel: "confirmed_write",
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
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

  it("runs approved Git commit through WorkspaceRuntime when a write-capable runtime is provided", async () => {
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
      approvalId: "approval-commit-runtime",
      preview: {
        workspaceRoot: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        branch: "feature/test",
        message: "Commit README update",
        files: [{ path: "README.md", indexStatus: " ", worktreeStatus: "M", action: "modify", contentHash: "hash-1" }],
        diffStat: "",
        diff: "",
        dryRun: {
          operation: "git.createCommit",
          affectedPaths: [{ source: "README.md", target: "README.md", action: "modify" }],
          riskSummary: "Creates a local Git commit for selected paths.",
          reversible: false,
        },
      },
    }));
    const executeCommit = vi.fn<NonNullable<GitTool["executeCommit"]>>(async () => {
      throw new Error("executeCommit should not be called when runtime is write-capable");
    });
    const workspaceRuntime = createTestWorkspaceRuntime({
      execute: vi.fn(async (request) => ({
        command: [request.program, ...request.args].join(" "),
        cwd: "E:/Javis/.codex-tmp/javis-sandboxes/task-1",
        exitCode: 0,
        stdout: request.args[0] === "commit" ? "[feature/test abc1234] Commit README update" : "",
        stderr: "",
      })),
    });
    const { controller, emitted, permissionHandlers } = createTestController({ withPermissionHandler: true });

    const runPromise = runCommanderDagTask({
      controller,
      commanderTool,
      gitTool: { planCommit, executeCommit },
      workspaceRuntime,
      taskId: "task-git-commit-runtime",
      userGoal: "commit README.md",
    });

    const [, handler] = await waitForPermissionHandler(permissionHandlers);
    await handler("approved");
    await runPromise;

    expect(executeCommit).not.toHaveBeenCalled();
    expect(workspaceRuntime.execute).toHaveBeenNthCalledWith(1, {
      program: "git",
      args: ["add", "--", "README.md"],
      cwd: workspaceRuntime.root,
      permissionLevel: "confirmed_write",
    });
    expect(workspaceRuntime.execute).toHaveBeenNthCalledWith(2, {
      program: "git",
      args: ["commit", "-m", "Commit README update"],
      cwd: workspaceRuntime.root,
      permissionLevel: "confirmed_write",
    });
    expect(JSON.stringify(emitted)).toContain("Created commit abc1234 for 1 file(s): Commit README update.");
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

describe("executeCapabilityStep web.fetchSource evidence boundary", () => {
  const baseStep = {
    id: "fetch-source",
    title: "Fetch the requested source",
    assignedAgentKind: "research" as const,
    toolName: "web.fetchSource",
    requiredCapabilities: ["web_fetch"],
    dependsOn: [] as string[],
    toolInput: { url: "https://example.test/requested" },
    outputContextKey: "source",
    successCriteria: "The requested source has a usable excerpt.",
  };

  it("binds the returned source to the requested URL and keeps normalized evidence", async () => {
    const context = createSharedTaskContext({ taskId: "task-fetch-source" });
    const fetchWebSource = vi.fn<NonNullable<WebTool["fetchWebSource"]>>(async () => ({
      url: "https://example.test/requested#section",
      title: "Requested source",
      excerpt: "  Requested source contains enough evidence for validation.  ",
      fetchedAt: "2026-07-12T00:00:00.000Z",
    }));

    const result = await executeCapabilityStep(baseStep, context, {
      webTool: { fetchWebSource },
    });

    expect(fetchWebSource).toHaveBeenCalledWith({ url: "https://example.test/requested" });
    expect(result.output).toMatchObject({
      url: "https://example.test/requested",
      excerpt: "Requested source contains enough evidence for validation.",
    });
    expect(context.get("source")).toMatchObject({
      url: "https://example.test/requested",
    });
  });

  it.each([
    {
      name: "URL substitution",
      source: {
        url: "https://evil.example/substitute",
        title: "Substituted source",
        excerpt: "This source is long enough but belongs to another URL.",
        fetchedAt: "2026-07-12T00:00:00.000Z",
      },
      message: "Fetched source URL does not match the requested URL.",
    },
    {
      name: "weak excerpt",
      source: {
        url: "https://example.test/requested",
        title: "Placeholder source",
        excerpt: "unknown",
        fetchedAt: "2026-07-12T00:00:00.000Z",
      },
      message: "Fetched source evidence was rejected: excerpt_too_short.",
    },
  ])("fails closed for $name", async ({ source, message }) => {
    const context = createSharedTaskContext({ taskId: "task-fetch-source-invalid" });
    const fetchWebSource = vi.fn<NonNullable<WebTool["fetchWebSource"]>>(async () => source);

    await expect(executeCapabilityStep(baseStep, context, {
      webTool: { fetchWebSource },
    })).rejects.toThrow(message);
    expect(context.get("source")).toBeUndefined();
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

  it("rejects forged MCP descriptors at the direct capability boundary", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const context = createSharedTaskContext({});

    await expect(executeCapabilityStep(
      {
        id: "forged-mcp-call",
        title: "Call forged MCP descriptor",
        assignedAgentKind: "commander",
        toolName: "mcp.evil.listTools",
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        successCriteria: "The forged descriptor must be rejected.",
      },
      context,
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: "mcp.evil.listTools",
          permissionLevel: "read",
          summary: "Forged MCP descriptor.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
        }],
      },
    )).rejects.toThrow(/not explicitly allowed for agent commander/);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("rejects MCP descriptors whose encoded server disagrees with metadata", async () => {
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ ok: true }));
    const encodedForgedServer = encodeMcpToolServerName("javis:other-server");
    const descriptorName = `mcp.${encodedForgedServer}.listTools`;

    await expect(executeCapabilityStep(
      {
        id: "mcp-server-metadata-mismatch",
        title: "Call mismatched MCP descriptor",
        assignedAgentKind: "commander",
        toolName: descriptorName,
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        successCriteria: "The mismatched descriptor is rejected.",
      },
      createSharedTaskContext({}),
      { mcpTool: { call: mcpCall } },
      {
        availableToolDescriptors: [{
          name: descriptorName,
          permissionLevel: "read",
          summary: "Mismatched MCP descriptor.",
          capabilityTags: ["local_search"],
          ownerAgentKinds: ["commander"],
          metadata: {
            mcpServerName: "filesystem",
            mcpSource: "javis",
            mcpAction: "listTools",
          },
        }],
      },
    )).rejects.toThrow(/not explicitly allowed for agent commander/);
    expect(mcpCall).not.toHaveBeenCalled();
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
      createSharedTaskContext({ candidateLinks: [{ href: "https://example.test/item", title: "Item" }], maxFollow: 2 }),
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
      candidateLinks: [{ href: "https://example.test/item", title: "Item" }],
      urlPattern: undefined,
      maxFollow: 2,
    });
    expect(list).toHaveBeenCalledWith();
    expect(scaffold).toHaveBeenCalledWith("knowledge workspace");
  });

  it("rejects shell.runReadOnlyCommand before dispatch when program or args are missing", async () => {
    const runReadOnlyCommand = vi.fn<ShellTool["runReadOnlyCommand"]>(async () => ({
      command: "",
      cwd: "E:/Javis",
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await expect(executeCapabilityStep(
      {
        id: "shell-date",
        title: "Get current date",
        assignedAgentKind: "code",
        toolName: "shell.runReadOnlyCommand",
        requiredCapabilities: ["shell_readonly"],
        dependsOn: [],
        toolInput: {},
        successCriteria: "Date collected.",
      },
      createSharedTaskContext({}),
      {
        shellTool: { runReadOnlyCommand },
      },
    )).rejects.toThrow("shell.runReadOnlyCommand requires explicit toolInput.program");

    expect(runReadOnlyCommand).not.toHaveBeenCalled();
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

  it("rejects computer path tools before dispatch when toolInput.path is missing", async () => {
    const listDirectory = vi.fn<ComputerTool["listDirectory"]>(async () => []);
    const openPath = vi.fn<ComputerTool["openPath"]>(async () => ({ opened: true }));
    const computerTool: ComputerTool = {
      searchLocalDocuments: vi.fn(async () => []),
      listDirectory,
      screenshot: vi.fn(async () => ({
        dataUrl: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
        capturedAt: "2026-06-08T00:00:00.000Z",
      })),
      listWindows: vi.fn(async () => ({ windows: [] })),
      inspectUi: vi.fn(async () => ({ tree: "", nodeCount: 0 })),
      focusWindow: vi.fn(),
      moveMouse: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      keyCombo: vi.fn(),
      scroll: vi.fn(),
      invokeUi: vi.fn(),
      setUiValue: vi.fn(),
      wait: vi.fn(async () => ({ waited: 1 })),
      openPath,
    };

    await expect(
      executeCapabilityStep(
        {
          id: "list-wallpaper-dir",
          title: "List Wallpaper Engine directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          successCriteria: "Directory listed.",
        },
        createSharedTaskContext({}),
        { computerTool },
      ),
    ).rejects.toThrow("Path clarification needed");

    await expect(
      executeCapabilityStep(
        {
          id: "open-wallpaper-dir",
          title: "Open Wallpaper Engine directory",
          assignedAgentKind: "computer",
          toolName: "computer.openPath",
          requiredCapabilities: ["local_search"],
          dependsOn: [],
          toolInput: { path: "  " },
          successCriteria: "Directory opened.",
        },
        createSharedTaskContext({}),
        { computerTool },
      ),
    ).rejects.toThrow("Tool computer.openPath requires confirmed_write approval");

    expect(listDirectory).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
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
            planWriteText: vi.fn(),
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
            planWriteText: vi.fn(),
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
      expectedCount: 2,
      complete: true,
      warnings: [],
      diagnostics: [{
        provider: "mirror",
        sourceUrl: "https://example.test/mirror",
        requestedLimit: 2,
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
        requestedLimit: 2,
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
      verifierTool: { check: vi.fn(async () => ({
        status: "pass" as const,
        summary: "Trend evidence verified.",
        detail: "Fixture verifier passed.",
      })) },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-weibo-hot-list",
      userGoal: "summarize top 2 Weibo hot searches",
      workflowId: "research-trending-topics",
    });

    expect(fetchHotList).toHaveBeenCalledWith({
      provider: "weibo",
      fallbackProviders: undefined,
      limit: 2,
    });
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.researchReport?.title).toBe("Weibo trend top 2");
    expect(finalSnapshot?.researchReport?.rows.map((row) => row.claim)).toEqual([
      "1. AI 新闻",
      "2. 第二条",
    ]);
    expect(finalSnapshot?.researchReport?.rows[0]?.sourceProvider).toBe("weibo");
    expect(finalSnapshot?.researchReport?.summary).toContain("Diagnostics: 1 completed, 1 failed.");
    expect(finalSnapshot?.researchReport?.unknowns).toContain("Trend provider mirror failed: HTTP 503; HTTP 503");
  });

  it("uses the browser tool before direct trend fetch for hot-list research workflows", async () => {
    const navigate = vi.fn<BrowserTool["navigate"]>(async (request) => ({
      url: request.url,
      title: "Weibo hot list",
      status: 200,
      loadState: "load",
    }));
    const getContent = vi.fn<BrowserTool["getContent"]>(async () => ({
      url: "https://weibo.com/ajax/side/hotSearch",
      title: "Weibo hot list",
      content: JSON.stringify({
        data: {
          realtime: [
            { word: "Browser workflow topic", raw_hot: 101 },
            { word: "Browser workflow second", raw_hot: 88 },
          ],
        },
      }),
    }));
    const browserTool = createBrowserTool({ navigate, getContent });
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => {
      throw new Error("direct trend tool should not run when browser is available");
    });
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
      browserTool,
      trendTool: { fetchHotList },
      webTool: { fetchWebSource },
      verifierTool: { check: vi.fn(async () => ({
        status: "pass" as const,
        summary: "Trend evidence verified.",
        detail: "Fixture verifier passed.",
      })) },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-browser-weibo-hot-list",
      userGoal: "summarize top 2 Weibo hot searches",
      workflowId: "research-trending-topics",
    });

    expect(fetchHotList).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://weibo.com/ajax/side/hotSearch",
      referrer: "https://weibo.com/",
    }));
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    expect(finalSnapshot?.researchReport?.title).toBe("Weibo trend top 2");
    expect(finalSnapshot?.researchReport?.rows.map((row) => row.claim)).toEqual([
      "1. Browser workflow topic",
      "2. Browser workflow second",
    ]);
    expect(finalSnapshot?.researchReport?.rows[0]?.sourceProvider).toBe("weibo");
    expect(finalSnapshot?.researchReport?.summary).toContain("Diagnostics: 1 completed, 0 failed.");
  });

  it("fails closed when a generic workflow has no verifier runtime", async () => {
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-verifier-missing",
      userGoal: "scan workspace documents",
      workflowId: "scan-workspace-documents",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toBe("fail: Verifier tool is unavailable.");
  });

  it("does not synthesize generic research when the verifier runtime is missing", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented without source verification.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const searchWeb = vi.fn(async () => [{
      url: "https://example.test/candidate",
      title: "Candidate",
      excerpt: "Candidate search evidence is long enough for validation.",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      provider: "fixture",
    }]);
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched candidate",
      excerpt: "Fetched source evidence is long enough for validation.",
      fetchedAt: "2026-06-10T00:00:01.000Z",
      provider: "fixture",
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      webTool: { searchWeb, fetchWebSource },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-research-no-verifier",
      userGoal: "research public sources",
      workflowId: "research-trending-topics",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Verifier tool is unavailable.");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails generic source-backed research before external synthesis when report evidence is replaced", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented from a weak excerpt.",
    }));
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Verifier was intentionally permissive in this fixture.",
      detail: "The deterministic source gate must still reject the report.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const searchWeb = vi.fn(async () => [{
      url: "https://example.test/candidate",
      title: "Candidate",
      excerpt: "Candidate search evidence is long enough for validation.",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      provider: "fixture",
    }]);
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched candidate",
      excerpt: "bad",
      fetchedAt: "2026-06-10T00:00:01.000Z",
      provider: "fixture",
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      verifierTool: { check: verifierCheck },
      webTool: { searchWeb, fetchWebSource },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-research-weak-evidence",
      userGoal: "research public sources",
      workflowId: "research-trending-topics",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Research source evidence validation failed.");
    expect(verifierCheck).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails generic trend research before verifier or synthesis when hot-list counts are inconsistent", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented from inconsistent trend metadata.",
    }));
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Permissive verifier fixture.",
      detail: "Deterministic trend validation should run first.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 1,
      complete: true,
      warnings: [],
      diagnostics: [],
      items: [
        { rank: 1, title: "First topic" },
        { rank: 2, title: "Second topic" },
      ],
    }));
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched trend detail",
      excerpt: "Fetched trend detail evidence is available.",
      fetchedAt: "2026-06-10T00:00:01.000Z",
      provider: "fixture",
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      trendTool: { fetchHotList },
      webTool: { fetchWebSource },
      verifierTool: { check: verifierCheck },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-trend-invalid-count",
      userGoal: "summarize top 1 Weibo hot searches",
      workflowId: "research-trending-topics",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Trend research evidence validation failed.");
    expect(verifierCheck).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("rejects generic trend payloads with fabricated item shapes", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented from a fabricated trend item.",
    }));
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Permissive verifier fixture.",
      detail: "Deterministic trend shape validation should run first.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const fetchHotList = vi.fn<TrendTool["fetchHotList"]>(async () => ({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      expectedCount: 1,
      complete: true,
      warnings: [],
      diagnostics: [],
      // Runtime data can be malformed even though the TypeScript contract is typed.
      items: [{ rank: "one" as unknown as number, title: "Fabricated topic", label: "long enough label" }],
    }));
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched trend detail",
      excerpt: "Fetched trend detail evidence is available.",
      fetchedAt: "2026-06-10T00:00:01.000Z",
      provider: "fixture",
    }));
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      trendTool: { fetchHotList },
      webTool: { fetchWebSource },
      verifierTool: { check: verifierCheck },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-generic-trend-invalid-item",
      userGoal: "summarize top 1 Weibo hot searches",
      workflowId: "research-trending-topics",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Trend payload validation failed.");
    expect(verifierCheck).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails source-only Spring guidance before a permissive verifier or synthesis", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented from weak guidance evidence.",
    }));
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Permissive verifier fixture.",
      detail: "Source-only deterministic validation should run first.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const searchWeb = vi.fn(async () => [{
      url: "https://example.test/spring-guidance",
      title: "Spring guidance",
      excerpt: "bad",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      provider: "fixture",
    }]);
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      verifierTool: { check: verifierCheck },
      webTool: {
        searchWeb,
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Spring guidance",
          excerpt: "bad",
          fetchedAt: "2026-06-10T00:00:01.000Z",
          provider: "fixture",
        })),
      },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-spring-guidance-weak-source",
      userGoal: "how do I start a Spring Boot app",
      workflowId: "plan-spring-boot-project",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Research source collection validation failed.");
    expect(verifierCheck).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails source-only Spring guidance when no source handoff exists", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be presented without guidance sources.",
    }));
    const verifierCheck = vi.fn<VerifierTool["check"]>(async () => ({
      status: "pass",
      summary: "Permissive verifier fixture.",
      detail: "Missing source handoff must fail before verifier execution.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan fixture unavailable");
      }),
      synthesize,
    };
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      commanderTool,
      verifierTool: { check: verifierCheck },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      taskId: "task-spring-guidance-no-source",
      userGoal: "how do I start a Spring Boot app",
      workflowId: "plan-spring-boot-project",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toContain("Research source collection validation failed.");
    expect(verifierCheck).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails closed when a generic workflow verifier throws", async () => {
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      verifierTool: {
        check: vi.fn(async () => {
          throw new Error("verifier provider unavailable");
        }),
      },
      taskId: "task-generic-verifier-error",
      userGoal: "scan workspace documents",
      workflowId: "scan-workspace-documents",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toBe("fail: Verifier execution failed.");
    expect(finalSnapshot?.logs.some((log) => log.detail.includes("verifier provider unavailable"))).toBe(true);
  });

  it("fails closed when a generic workflow verifier returns malformed pass data", async () => {
    const { controller, emitted } = createTestController();

    await runGenericWorkbenchWorkflow({
      controller,
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      verifierTool: {
        check: vi.fn(async () => ({ status: "pass" } as unknown as Awaited<ReturnType<VerifierTool["check"]>>)),
      },
      taskId: "task-generic-verifier-malformed",
      userGoal: "scan workspace documents",
      workflowId: "scan-workspace-documents",
    });

    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("failed");
    expect(finalSnapshot?.verificationSummary).toBe("fail: Verifier returned an invalid result.");
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
    const failedLog = emitted[emitted.length - 1]?.logs.find((log) => log.title === "task.failed");
    expect(failedLog?.detail).toContain('Unknown tool "memory.search"');
  });

  it("keeps Commander planning scoped to desktop tools for Computer Use goals", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async (request) => {
        const toolNames = new Set(request.availableTools?.map((tool: { name: string }) => tool.name));
        expect(toolNames.has("computer.screenshot")).toBe(true);
        expect(toolNames.has("computer.click")).toBe(true);
        expect(toolNames.has("computer.type")).toBe(true);
        expect(toolNames.has("code.searchRepository")).toBe(false);
        expect(toolNames.has("file.writeText")).toBe(false);
        expect(request.availableAgents.map((agent: { kind: string }) => agent.kind)).toEqual([
          "commander",
          "computer",
          "verifier",
          "vision",
        ]);
        return {
          title: "Desktop automation",
          reasoning: "Delegate to the Computer Agent.",
          steps: [{
            id: "computer-use-loop",
            title: "Use the desktop",
            assignedAgentKind: "computer",
            capability: "desktop_input",
            requiredCapabilities: ["desktop_screenshot", "desktop_input"],
            dependsOn: [],
            inputContextKeys: ["userGoal"],
            successCriteria: "The desktop task is attempted.",
          }],
        };
      }),
    };
    const computerUseLoopRunner = vi.fn(async () => []);
    const { controller, emitted } = createTestController({ withPermissionHandler: true });

    await runCommanderDagTask({
      controller,
      commanderTool,
      computerTool: {
        screenshot: vi.fn(async () => ({ dataUrl: "", width: 0, height: 0, capturedAt: "" })),
        click: vi.fn(async () => ({ x: 0, y: 0, clicked: true })),
        type: vi.fn(async () => ({ typed: true, length: 0 })),
      } as unknown as ComputerTool,
      computerUseLoopRunner,
      taskId: "task-computer-use-planning-scope",
      userGoal: "用 computerUse 操控 QQ 给联系人发送消息",
      availableToolDescriptors: initialToolDescriptors,
    });

    expect(commanderTool.plan).toHaveBeenCalledTimes(1);
    expect(computerUseLoopRunner).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(emitted)).toContain("computer-use.loop");
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

  it("does not synthesize a read-current-project conclusion after verifier failure", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "This must not be shown without verified evidence.",
    }));
    const { controller, emitted } = createTestController();

    await runReadCurrentProjectWorkflow({
      controller,
      commanderTool: {
        plan: vi.fn(async () => {
          throw new Error("plan fixture unavailable");
        }),
        synthesize,
      },
      verifierTool: {
        check: vi.fn(async () => ({
          status: "fail" as const,
          summary: "Evidence is incomplete.",
          detail: "The fixture intentionally fails verification.",
        })),
      },
      fileTool: { scanMarkdownDocuments: vi.fn(async () => []) },
      projectTool: { inspectProject: vi.fn(async () => ({ workspacePath: "E:/Javis", scripts: [] })) },
      shellTool: { runReadOnlyCommand: vi.fn<ShellTool["runReadOnlyCommand"]>(async (request) => ({
        command: [request.program, ...request.args].join(" "),
        cwd: request.workspacePath ?? "E:/Javis",
        exitCode: 0,
        stdout: "",
        stderr: "",
      })) },
      taskId: "task-read-project-verifier-fail",
      userGoal: "read current project",
    });

    expect(synthesize).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
    expect(emitted[emitted.length - 1]?.verificationSummary).toBe("fail: Evidence is incomplete.");
  });

  it("allows Commander DAG plans to use enabled dynamic MCP descriptors", async () => {
    const mcpListToolName = `mcp.${encodeMcpToolServerName("javis:filesystem")}.listTools`;
    const commanderTool: CommanderTool = {
      plan: vi.fn(async ({ availableAgents }: Parameters<CommanderTool["plan"]>[0]) => {
        expect(availableAgents.find((agent) => agent.kind === "commander")?.allowedToolNames)
          .toContain(mcpListToolName);
        return {
          title: "List MCP tools",
          reasoning: "Use the enabled MCP server.",
          steps: [{
            id: "list-mcp-tools",
            title: "List filesystem MCP tools",
            assignedAgentKind: "commander",
            toolName: mcpListToolName,
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
        name: mcpListToolName,
        permissionLevel: "read",
        summary: "List filesystem MCP tools.",
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
        metadata: {
          mcpServerName: "filesystem",
          mcpSource: "javis",
          mcpAction: "listTools",
        },
      }],
    });

    expect(mcpCall).toHaveBeenCalledWith({
      serverName: "filesystem",
      source: "javis",
      action: "listTools",
      toolName: undefined,
      arguments: undefined,
      input: {},
      timeoutMs: 5_000,
    });
    expect(emitted[emitted.length - 1]?.status).toBe("completed");
  });

  it("rejects a forged MCP listTools descriptor without canonical metadata", async () => {
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => ({
        title: "Forged MCP descriptor",
        reasoning: "The descriptor must be rejected before dispatch.",
        steps: [{
          id: "forged-list",
          title: "List MCP tools",
          assignedAgentKind: "commander",
          toolName: "mcp.filesystem.listTools",
          requiredCapabilities: ["local_search"],
          dependsOn: [],
          successCriteria: "The forged descriptor must not run.",
        }],
      })),
      synthesize: vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
        message: "Here is the direct answer.",
      })),
    };
    const mcpCall = vi.fn<McpTool["call"]>(async () => ({ tools: [] }));
    const { controller, emitted } = createTestController();

    await runCommanderDagTask({
      controller,
      commanderTool,
      mcpTool: { call: mcpCall },
      taskId: "task-forged-mcp-list",
      userGoal: "list filesystem MCP tools",
      availableToolDescriptors: [{
        name: "mcp.filesystem.listTools",
        permissionLevel: "read",
        summary: "Forged MCP list descriptor.",
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["commander"],
      }],
    });

    expect(mcpCall).not.toHaveBeenCalled();
    expect(emitted[emitted.length - 1]?.status).toBe("failed");
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
      if (request.observations.length === 0) {
        return {
          status: "continue" as const,
          toolName: request.availableTools[0]?.name,
          reason: "Inspect the MCP tool list before completing.",
        };
      }
      return {
        status: "completed" as const,
        reason: `<think>private chain of thought must not reach logs</think> bearer sk-live-secret ${"x".repeat(400)} Tool list inspected.`,
        output: request.observations[0]?.output,
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
      mcpTool: { call: vi.fn(async () => ({ tools: [{ name: "read_00" }] })) },
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

    expect(reactRequests).toHaveLength(2);
    expect(reactRequests[0].availableTools.map((tool) => tool.name)).toEqual([
      `mcp.${encodedServer}.listTools`,
      ...descriptors.slice(0, 8).map((descriptor) => descriptor.name),
    ]);
    expect(reactRequests[0].availableTools.some((tool) => tool.name === hiddenToolName)).toBe(false);
    const finalSnapshot = emitted[emitted.length - 1];
    expect(finalSnapshot?.status).toBe("completed");
    const reactLog = finalSnapshot?.logs.find((log) => log.detail.includes("ReAct completed after"));
    expect(reactLog?.detail).not.toContain("private chain of thought");
    expect(reactLog?.detail).not.toContain("<think>");
    expect(reactLog?.detail).not.toContain("sk-live-secret");
    expect(reactLog?.detail).toContain("[redacted:secret]");
    expect(reactLog?.detail).toContain("...[truncated]");
    expect(reactLog?.detail.length).toBeLessThan(450);
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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
            capability: "desktop_input",
            requiredCapabilities: ["desktop_input"],
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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
      { tool: "computer.click", params: { x: 10, y: 20 }, riskLevel: "navigate" },
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
            capability: "desktop_input",
            requiredCapabilities: ["desktop_input"],
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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
        riskLevel: "compose",
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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
        riskLevel: "compose",
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
          capability: "desktop_input",
          requiredCapabilities: ["desktop_input"],
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

describe("SUPPORTED_APPROVAL_GATED_TOOLS allowlist", () => {
  it("contains the four Git tools with explicit preflight handlers", () => {
    const allowed = new Set<string>(SUPPORTED_APPROVAL_GATED_TOOLS);
    for (const name of [
      "git.stageFiles",
      "git.createCommit",
      "git.createPullRequest",
      "git.commentPullRequest",
    ]) {
      expect(allowed.has(name)).toBe(true);
    }
    // The set MUST be closed — every member is either a Git tool with a
    // dedicated plan/preview handler, or a computer-use tool routed through
    // computerUseLoopRunner. No generic confirmed_write tools allowed.
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toHaveLength(5 + 8);
  });

  it("lists file.writeText because Commander has an explicit preflight handler", () => {
    // file.writeText is routed through runCommanderDagTask() where it
    // first creates a preview and waits for confirmed_write approval.
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toContain("file.writeText");
  });

  it("does not list browser confirmed-write tools that lack Commander preflight", () => {
    // Browser write tools are not part of the commander DAG — they have
    // their own approval flow separate from this allowlist.
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).not.toContain("browser.click");
  });

  it("includes computer-use tools that go through computerUseLoopRunner", () => {
    // The computer use action loop has explicit preflight + per-action
    // approval, so the corresponding tool names are in the allowlist.
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toContain("computer.click");
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toContain("computer.type");
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toContain("computer.invokeUi");
    expect(SUPPORTED_APPROVAL_GATED_TOOLS).toContain("computer.setUiValue");
  });
});
