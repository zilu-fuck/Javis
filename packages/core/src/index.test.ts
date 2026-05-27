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
import type {
  FileOrganizationExecution,
  FileOrganizationPlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
} from "@javis/tools";
import type { TaskSnapshot } from "./index";

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
      "agent-research",
      "agent-computer",
      "agent-scheduler",
      "agent-verifier",
      "agent-chinese-reviewer",
    ]);
    expect(snapshot.agents.every((agent) => agent.status === "queued")).toBe(true);
  });

  it("provides bilingual system prompts for built-in agents", () => {
    const commander = demoAgents.find((agent) => agent.kind === "commander");
    const reviewer = demoAgents.find((agent) => agent.kind === "chinese-reviewer");

    expect(commander?.systemPrompt.en).toContain("Commander");
    expect(reviewer?.allowedToolNames).toEqual([]);
    expect(reviewer && getAgentSystemPrompt(reviewer, "zh-CN")).toContain("中文审校");
    expect(commander && getAgentSystemPrompt(commander, "zh-CN")).toContain("指挥官");
  });

  it("describes the product multi-agent workflow blueprints", () => {
    const workflows = listWorkbenchWorkflows();

    expect(workflows.map((workflow) => workflow.id)).toEqual([
      "read-current-project",
      "research-trending-topics",
      "plan-spring-boot-project",
      "find-local-document",
      "daily-reminder",
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
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "test", command: "pnpm test" }],
      recommendedStartCommand: "pnpm dev",
      recommendedTestCommand: "pnpm test",
    };
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
      reasoning: "Use File, Shell, Code, and Verifier agents for a read-only project pass.",
      steps: [
        {
          id: "scan-files",
          title: "Scan files",
          assignedAgentKind: "file",
          successCriteria: "Markdown documents are scanned.",
        },
      ],
    }));
    const verifierCheck = vi.fn(async () => ({
      status: "pass" as const,
      summary: "All read-current-project evidence is present.",
      detail: "Documents, project inspection, command outputs, and summary were provided.",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
      },
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => documents),
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        })),
      },
      verifierTool: {
        check: verifierCheck,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("inspect this project");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toBe("Read current project");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "scan-files",
      "inspect-project",
      "analyze-code",
      "summarize-project",
      "commander-synthesize",
    ]);
    expect(finalSnapshot.documents).toHaveLength(1);
    expect(finalSnapshot.project).toEqual(project);
    expect(finalSnapshot.commands).toHaveLength(3);
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "read-current-project",
      userGoal: "inspect this project",
    }));
    expect(verifierCheck).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "summarize-project",
      successCriteria: "Human-readable summary with evidence and unknowns",
    }));
    expect(verifierCheck).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          label: "Shared workflow context",
          data: expect.objectContaining({
            fileScan: expect.objectContaining({ count: 1 }),
            projectInspection: project,
            shellCommands: expect.any(Array),
            analysisSummary: expect.stringContaining("Code Agent identified pnpm"),
          }),
        }),
      ]),
    }));
    expect(finalSnapshot.verificationSummary).toContain("pass: All read-current-project evidence is present.");

    unsubscribe();
    runtime.dispose();
  });

  it("routes supported workflow blueprints through concrete generic workflow tools", async () => {
    const commanderPlan = vi.fn(async () => ({
      title: "Model planned reminder",
      reasoning: "Use the Scheduler workflow and keep confirmed writes explicit.",
      steps: [
        {
          id: "parse-schedule",
          title: "Parse schedule",
          assignedAgentKind: "commander",
          successCriteria: "Reminder intent is parsed.",
        },
      ],
    }));
    const verifierCheck = vi.fn(async () => ({
      status: "pass" as const,
      summary: "Reminder workflow created a durable schedule.",
      detail: "The DAG executor recorded scheduler output.",
    }));
    const createTask = vi.fn(async (draft) => ({
      ...draft,
      id: "st-test",
      enabled: true,
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      commanderTool: {
        plan: commanderPlan,
      },
      verifierTool: {
        check: verifierCheck,
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
      "persist-reminder",
      "verify-reminder",
    ]);
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);
    expect(finalSnapshot.verificationSummary).toContain("pass: Reminder workflow created");
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      goal: "remind me every day at 8",
      schedule: { type: "daily", value: "08:00" },
    }));
    expect(commanderPlan).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "daily-reminder",
      userGoal: "remind me every day at 8",
    }));
    expect(verifierCheck).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "daily-reminder:generic-summary",
      evidence: expect.arrayContaining([
        expect.objectContaining({
          label: "Shared workflow context",
          data: expect.objectContaining({
            "parse-schedule": expect.objectContaining({ status: "completed" }),
            "persist-reminder": expect.objectContaining({ status: "completed" }),
            "verify-reminder": expect.objectContaining({ status: "completed" }),
          }),
        }),
      ]),
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
      },
      computerTool: {
        searchLocalDocuments,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("find local finance document on my computer");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(searchLocalDocuments).toHaveBeenCalled();
    expect(finalSnapshot.documents?.[0]?.path).toBe("C:/Users/me/Documents/finance-report.pdf");
    expect(finalSnapshot.plan.every((step) => step.status === "completed")).toBe(true);

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

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.title).toContain("Combined workflow");
    expect(finalSnapshot.plan.map((step) => step.id)).toEqual([
      "find-local-document:parse-query",
      "find-local-document:search-computer",
      "find-local-document:rank-results",
      "daily-reminder:parse-schedule",
      "daily-reminder:persist-reminder",
      "daily-reminder:verify-reminder",
    ]);
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
    expect(finalSnapshot.commanderMessage).toContain("opencode model settings");
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

    expect(finalSnapshot.documents).toHaveLength(1);
    expect(finalSnapshot.documents?.[0]?.purpose).toBe("Project or module entry document.");
    expect(finalSnapshot.verificationSummary).toContain("verified");

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
    expect(finalSnapshot.title).toBe("需要更多信息");
    expect(finalSnapshot.status).toBe("completed");

    unsubscribe();
    runtime.dispose();
  });

  it("routes casual Chinese chat input to general chat when available", async () => {
    const scanMarkdownDocuments = vi.fn(async () => []);
    const complete = vi.fn(async () => ({ text: "你好，我是 Javis。" }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: { scanMarkdownDocuments },
      chatTool: { complete },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("你好");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("你好"), {
      maxTokens: 1200,
      temperature: 0.7,
      locale: "zh-CN",
    });
    expect(finalSnapshot.title).toBe("已回答");
    expect(finalSnapshot.commanderMessage).toBe("你好，我是 Javis。");
    expect(finalSnapshot.tokenUsage?.modelCalls).toBe(1);
    expect(finalSnapshot.status).toBe("completed");

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

    runtime.start("这个怎么弄");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(scanMarkdownDocuments).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("模型调用失败");
    expect(finalSnapshot.commanderMessage).toContain("模型请求失败");
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

    runtime.start("扫描工作区文档");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(scanMarkdownDocuments).toHaveBeenCalled();
    expect(finalSnapshot.title).toBe("Workspace documents scanned");

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

    expect(finalSnapshot.title).toBe("Document scan failed");
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
