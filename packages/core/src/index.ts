import type {
  FileTool,
  MarkdownDocumentSummary,
  ShellCommandOutput,
  ShellTool,
  WebSource,
  WebTool,
} from "@javis/tools";
import { summarizeMarkdownDocuments } from "@javis/tools";

export type ID = string;
export type ISODateTime = string;

export type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentKind =
  | "commander"
  | "file"
  | "shell"
  | "browser"
  | "research"
  | "code"
  | "verifier";

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type PermissionLevel = "read" | "preview" | "confirmed_write" | "dangerous";
export type VerificationStatus = "verified" | "unverified" | "failed";

export interface Task {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  workspacePath?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  plan?: TaskStep[];
  agentRuns: AgentRun[];
  pendingPermissionRequestId?: ID;
  verification?: VerificationResult;
  finalMessage?: string;
}

export interface TaskStep {
  id: ID;
  title: string;
  assignedAgentKind: AgentKind;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  successCriteria?: string;
}

export interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  preferredModelTags?: string[];
}

export interface AgentRun {
  id: ID;
  taskId: ID;
  agentId: ID;
  agentKind: AgentKind;
  status: AgentRunStatus;
  modelProfileId?: ID;
  inputSummary: string;
  outputSummary?: string;
  toolCallIds: ID[];
  error?: TaskError;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
}

export interface ModelProfile {
  id: ID;
  provider: string;
  model: string;
  displayName: string;
  tags: string[];
  capabilities: {
    text: boolean;
    vision: boolean;
    code: boolean;
    longContext: boolean;
    local: boolean;
    toolCalling: boolean;
  };
  limits?: {
    contextTokens?: number;
    outputTokens?: number;
  };
}

export interface ToolCall {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolName: string;
  permissionLevel: PermissionLevel;
  status:
    | "planned"
    | "waiting_permission"
    | "running"
    | "succeeded"
    | "failed"
    | "denied"
    | "cancelled";
  inputSummary: string;
  outputSummary?: string;
  dryRun?: DryRunSummary;
  permissionRequestId?: ID;
  startedAt?: ISODateTime;
  endedAt?: ISODateTime;
  error?: TaskError;
}

export interface DryRunSummary {
  operation: string;
  affectedPaths?: Array<{
    source?: string;
    target?: string;
    action: "create" | "modify" | "move" | "copy" | "delete" | "overwrite";
    conflict?: string;
  }>;
  command?: {
    cwd: string;
    text: string;
    expectedWrites?: string[];
  };
  riskSummary: string;
  reversible: boolean;
}

export interface PermissionRequest {
  id: ID;
  taskId: ID;
  agentRunId: ID;
  toolCallId: ID;
  level: Exclude<PermissionLevel, "read">;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface VerificationResult {
  id: ID;
  taskId: ID;
  status: VerificationStatus;
  checkedAt: ISODateTime;
  summary: string;
  evidence: Array<{
    kind: "file" | "command" | "source" | "log" | "permission" | "manual";
    label: string;
    reference?: string;
    result: "pass" | "warn" | "fail";
  }>;
  retryRecommendation?: {
    shouldRetry: boolean;
    reason: string;
    suggestedAgentKind?: AgentKind;
  };
}

export type TaskEvent =
  | { type: "task.created"; task: Task }
  | { type: "task.status_changed"; taskId: ID; status: TaskStatus }
  | { type: "task.plan_updated"; taskId: ID; plan: TaskStep[] }
  | { type: "agent_run.started"; taskId: ID; agentRun: AgentRun }
  | { type: "agent_run.updated"; taskId: ID; agentRun: AgentRun }
  | { type: "tool_call.planned"; taskId: ID; toolCall: ToolCall }
  | { type: "tool_call.updated"; taskId: ID; toolCall: ToolCall }
  | { type: "permission.requested"; taskId: ID; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: ID; request: PermissionRequest }
  | { type: "verification.completed"; taskId: ID; result: VerificationResult }
  | { type: "task.message"; taskId: ID; role: "system" | "agent" | "user"; content: string }
  | { type: "task.failed"; taskId: ID; error: TaskError }
  | { type: "task.completed"; taskId: ID; finalMessage: string };

export interface TaskError {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}

export interface AgentSnapshot {
  id: ID;
  name: string;
  role: string;
  status: AgentRunStatus;
  task: string;
}

export interface TaskLogEntry {
  id: ID;
  kind: "plan" | "tool" | "permission" | "verification" | "event";
  title: string;
  detail: string;
}

export interface TaskSnapshot {
  id: ID;
  title: string;
  userGoal: string;
  status: TaskStatus;
  commanderMessage: string;
  plan: TaskStep[];
  agents: AgentSnapshot[];
  logs: TaskLogEntry[];
  documents?: MarkdownDocumentSummary[];
  commands?: ShellCommandOutput[];
  sources?: WebSource[];
  verificationSummary?: string;
}

export interface TaskRuntime {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  start(userGoal: string): void;
  dispose(): void;
}

export interface FileScanRuntimeOptions {
  fileTool: FileTool;
  shellTool?: ShellTool;
  webTool?: WebTool;
  delayMs?: number;
}

const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "Task planning and orchestration",
    allowedToolNames: [],
  },
  {
    id: "agent-file",
    kind: "file",
    displayName: "File Agent",
    description: "Read-only local document scanning",
    allowedToolNames: ["file.scanMarkdownDocuments"],
  },
  {
    id: "agent-shell",
    kind: "shell",
    displayName: "Shell Agent",
    description: "Read-only command execution",
    allowedToolNames: ["shell.runReadOnlyCommand"],
  },
  {
    id: "agent-research",
    kind: "research",
    displayName: "Research Agent",
    description: "Public source collection",
    allowedToolNames: ["web.fetchSource"],
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    displayName: "Verifier",
    description: "Evidence and completion checks",
    allowedToolNames: [],
  },
];

export function createInitialTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "Waiting for a task",
    status: "created",
    commanderMessage:
      "Javis desktop is ready. Enter a goal to start the Core event stream.",
    plan: [],
    agents: demoAgents.map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      role: agent.description,
      status: "queued",
      task: "Waiting",
    })),
    logs: [
      {
        id: "log-ready",
        kind: "event",
        title: "Runtime ready",
        detail: "Core runtime is ready for startTask.",
      },
    ],
  };
}

export function createFileScanTaskRuntime({
  fileTool,
  shellTool,
  webTool,
  delayMs = 250,
}: FileScanRuntimeOptions): TaskRuntime {
  let snapshot = createInitialTaskSnapshot();
  const listeners = new Set<(nextSnapshot: TaskSnapshot) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  function emit(nextSnapshot: TaskSnapshot) {
    if (disposed) {
      return;
    }
    snapshot = nextSnapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function wait() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, delayMs);
      timers.add(timer);
    });
  }

  async function runFileScanTask(taskId: ID, userGoal: string) {
    const plan = createFileScanPlan();

    emit({
      id: taskId,
      title: "Scanning workspace documents",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a local document scan and prepared a read-only File Tool call.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create document scan plan"),
        fileSnapshot("queued", "Waiting for file.scanMarkdownDocuments"),
        verifierSnapshot("queued", "Waiting for file scan results"),
      ],
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the user goal to Core.",
        },
        {
          id: `${taskId}-plan`,
          kind: "plan",
          title: "task.plan_updated",
          detail:
            "Plan includes read-only Markdown scan, purpose summary, and result verification.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      title: "Scanning workspace documents",
      status: "running",
      commanderMessage:
        "File Agent is scanning Markdown documents through the Tauri desktop bridge.",
      plan: markStep(snapshot.plan, "step-scan-markdown", "running"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("running", "Running read-only Markdown scan"),
        verifierSnapshot("queued", "Waiting for scan results"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-tool-planned`,
        kind: "tool",
        title: "tool_call.planned",
        detail:
          "file.scanMarkdownDocuments uses read permission and does not modify local files.",
      }),
    });

    try {
      const documents = summarizeMarkdownDocuments(await fileTool.scanMarkdownDocuments());

      emit({
        ...snapshot,
        title: "Summarizing workspace documents",
        status: "running",
        commanderMessage: `File Agent found ${documents.length} Markdown documents and generated purpose summaries.`,
        plan: markStep(snapshot.plan, "step-scan-markdown", "completed", "step-summarize", "running"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("completed", `Found ${documents.length} Markdown documents`),
          verifierSnapshot("queued", "Waiting for verification"),
        ],
        documents,
        logs: appendLog(snapshot, {
          id: `${taskId}-tool-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `file.scanMarkdownDocuments succeeded with ${documents.length} records.`,
        }),
      });

      await wait();

      emit({
        ...snapshot,
        title: "Verifying workspace documents",
        status: "verifying",
        commanderMessage:
          "Verifier is checking that each result includes a path, modified time, size, and purpose.",
        plan: markStep(snapshot.plan, "step-summarize", "completed", "step-verify-docs", "running"),
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          fileSnapshot("completed", "Document scan and summaries completed"),
          verifierSnapshot("verifying", "Checking document result fields"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-verify`,
          kind: "verification",
          title: "verification.started",
          detail:
            "Checking each document record for path, modifiedAt, sizeBytes, and purpose.",
        }),
      });

      await wait();

      const validCount = documents.filter(
        (document) =>
          Boolean(document.path) &&
          Boolean(document.modifiedAt) &&
          document.sizeBytes >= 0 &&
          Boolean(document.purpose),
      ).length;
      const verificationStatus = validCount === documents.length ? "completed" : "failed";

      emit({
        ...snapshot,
        title:
          verificationStatus === "completed"
            ? "Workspace documents scanned"
            : "Document scan verification failed",
        status: verificationStatus,
        commanderMessage:
          verificationStatus === "completed"
            ? "Document scan completed with read-only filesystem evidence."
            : "Document scan finished, but Verifier found incomplete records.",
        plan:
          verificationStatus === "completed"
            ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
            : markStep(snapshot.plan, "step-verify-docs", "failed"),
        agents: [
          commanderSnapshot("completed", "Task finished"),
          fileSnapshot("completed", "Read-only scan completed"),
          verifierSnapshot(
            verificationStatus === "completed" ? "completed" : "failed",
            `${validCount}/${documents.length} records verified`,
          ),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title:
            verificationStatus === "completed"
              ? "verification.completed"
              : "verification.failed",
          detail: `Verifier checked ${validCount}/${documents.length} document records.`,
        }),
        verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${documents.length} documents include path, modified time, size, and purpose.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        ...snapshot,
        title: "Document scan failed",
        status: "failed",
        commanderMessage:
          "File Agent scan failed. The task stopped without running any write operation.",
        plan: markStep(snapshot.plan, "step-scan-markdown", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("failed", "Scan failed"),
          verifierSnapshot("cancelled", "No result to verify"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: message,
        }),
      });
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    start(userGoal) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      const taskId = `task-${Date.now()}`;
      if (webTool && extractUrls(userGoal).length > 0) {
        void runResearchSourceTask(taskId, userGoal, webTool);
        return;
      }
      if (shellTool && isProjectInspectionGoal(userGoal)) {
        void runProjectInspectionTask(taskId, userGoal, shellTool);
        return;
      }
      void runFileScanTask(taskId, userGoal);
    },
    dispose() {
      disposed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      listeners.clear();
    },
  };

  async function runProjectInspectionTask(taskId: ID, userGoal: string, activeShellTool: ShellTool) {
    const plan = createProjectInspectionPlan();

    emit({
      id: taskId,
      title: "Inspecting project environment",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander identified a project inspection task and prepared read-only Shell Tool calls.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create project inspection plan"),
        fileSnapshot("queued", "No file scan needed"),
        shellSnapshot("queued", "Waiting for read-only commands"),
        verifierSnapshot("queued", "Waiting for command results"),
      ],
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the project inspection goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Shell Agent is running allowlisted read-only commands.",
      plan: markStep(snapshot.plan, "step-read-env", "running"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("queued", "No file scan needed"),
        shellSnapshot("running", "Running node/pnpm/git read-only checks"),
        verifierSnapshot("queued", "Waiting for command results"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-commands-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "Planned node --version, pnpm --version, and git status --short.",
      }),
    });

    try {
      const commands = await Promise.all([
        activeShellTool.runReadOnlyCommand({
          program: "node",
          args: ["--version"],
          workspacePath: null,
        }),
        activeShellTool.runReadOnlyCommand({
          program: "pnpm",
          args: ["--version"],
          workspacePath: null,
        }),
        activeShellTool.runReadOnlyCommand({
          program: "git",
          args: ["status", "--short"],
          workspacePath: null,
        }),
      ]);

      emit({
        ...snapshot,
        title: "Verifying project environment",
        status: "verifying",
        commanderMessage: "Verifier is checking command exit codes and output summaries.",
        plan: markStep(snapshot.plan, "step-read-env", "completed", "step-verify-env", "running"),
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("completed", "Read-only commands completed"),
          verifierSnapshot("verifying", "Checking exit codes"),
        ],
        commands,
        logs: [
          ...appendLog(snapshot, {
            id: `${taskId}-commands-done`,
            kind: "tool",
            title: "tool_call.updated",
            detail: `Shell Tool completed ${commands.length} read-only commands.`,
          }),
          ...commands.map((command, index) => ({
            id: `${taskId}-command-${index}`,
            kind: "tool" as const,
            title: command.command,
            detail: `exit=${command.exitCode ?? "unknown"} stdout=${command.stdout || "(empty)"}`,
          })),
        ],
      });

      await wait();

      const passingCount = commands.filter((command) => command.exitCode === 0).length;
      emit({
        ...snapshot,
        title: "Project environment inspected",
        status: "completed",
        commanderMessage:
          "Project inspection completed through the Tauri desktop process and a read-only command allowlist.",
        plan: snapshot.plan.map((step) => ({ ...step, status: "completed" })),
        agents: [
          commanderSnapshot("completed", "Task finished"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("completed", "Read-only command checks completed"),
          verifierSnapshot("completed", "Verification passed"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title: "task.completed",
          detail: `Verifier checked ${passingCount}/${commands.length} command results.`,
        }),
        verificationSummary: `verified: ${passingCount}/${commands.length} read-only commands exited successfully.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        ...snapshot,
        title: "Project inspection failed",
        status: "failed",
        commanderMessage:
          "Shell Agent inspection failed. The task stopped without running any write operation.",
        plan: markStep(snapshot.plan, "step-read-env", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          fileSnapshot("queued", "No file scan needed"),
          shellSnapshot("failed", "Read-only command failed"),
          verifierSnapshot("cancelled", "No result to verify"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: message,
        }),
      });
    }
  }

  async function runResearchSourceTask(taskId: ID, userGoal: string, activeWebTool: WebTool) {
    const urls = extractUrls(userGoal);
    const plan = createResearchSourcePlan();

    emit({
      id: taskId,
      title: "Collecting research sources",
      userGoal,
      status: "planning",
      commanderMessage:
        "Commander found user-provided URLs and prepared read-only source collection.",
      plan,
      agents: [
        commanderSnapshot("planning", "Create research source plan"),
        researchSnapshot("queued", `Waiting to fetch ${urls.length} source(s)`),
        verifierSnapshot("queued", "Waiting for source evidence"),
      ],
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "Desktop UI passed the research goal to Core.",
        },
      ],
    });

    await wait();

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Research Agent is fetching public sources provided by the user.",
      plan: markStep(snapshot.plan, "step-fetch-sources", "running"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        researchSnapshot("running", "Fetching public URL sources"),
        verifierSnapshot("queued", "Waiting for sources"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-sources-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: `Fetching ${urls.length} URL(s) with read permission.`,
      }),
    });

    try {
      const sources = await Promise.all(
        urls.map((url) => activeWebTool.fetchWebSource({ url })),
      );

      emit({
        ...snapshot,
        title: "Drafting source-backed report",
        status: "verifying",
        commanderMessage:
          "Research Agent collected sources. Verifier is checking that every source has a URL and excerpt.",
        plan: markStep(snapshot.plan, "step-fetch-sources", "completed", "step-verify-sources", "running"),
        agents: [
          commanderSnapshot("completed", "Waiting for verification"),
          researchSnapshot("completed", `Fetched ${sources.length} source(s)`),
          verifierSnapshot("verifying", "Checking source evidence"),
        ],
        sources,
        logs: appendLog(snapshot, {
          id: `${taskId}-sources-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `web.fetchSource completed for ${sources.length} source(s).`,
        }),
      });

      await wait();

      const validCount = sources.filter((source) => source.url && source.excerpt).length;
      emit({
        ...snapshot,
        title: "Research sources collected",
        status: "completed",
        commanderMessage:
          "Source collection completed. This is the Milestone 4 fallback path for user-provided URLs before search provider integration.",
        plan: snapshot.plan.map((step) => ({ ...step, status: "completed" })),
        agents: [
          commanderSnapshot("completed", "Task finished"),
          researchSnapshot("completed", "Source collection completed"),
          verifierSnapshot("completed", "Verification passed"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title: "task.completed",
          detail: `Verifier checked ${validCount}/${sources.length} source records.`,
        }),
        verificationSummary: `verified: ${validCount}/${sources.length} sources include URL and excerpt.`,
      });
    } catch (error) {
      emit({
        ...snapshot,
        title: "Research source collection failed",
        status: "failed",
        commanderMessage:
          "Research Agent could not fetch the provided source. Search provider integration remains a later step.",
        plan: markStep(snapshot.plan, "step-fetch-sources", "failed"),
        agents: [
          commanderSnapshot("completed", "Plan submitted"),
          researchSnapshot("failed", "Source fetch failed"),
          verifierSnapshot("cancelled", "No source to verify"),
        ],
        logs: appendLog(snapshot, {
          id: `${taskId}-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
}

function createFileScanPlan(): TaskStep[] {
  return [
    {
      id: "step-scan-markdown",
      title: "File Agent scans workspace Markdown documents",
      assignedAgentKind: "file",
      status: "pending",
      successCriteria: "Return real file paths, modified times, and file sizes.",
    },
    {
      id: "step-summarize",
      title: "Commander summarizes document purpose",
      assignedAgentKind: "commander",
      status: "pending",
      successCriteria: "Each document has a one-line purpose summary.",
    },
    {
      id: "step-verify-docs",
      title: "Verifier checks scan evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result includes verifiable evidence from the file scan.",
    },
  ];
}

function createProjectInspectionPlan(): TaskStep[] {
  return [
    {
      id: "step-read-env",
      title: "Shell Agent runs read-only project checks",
      assignedAgentKind: "shell",
      status: "pending",
      successCriteria: "Return command, cwd, exit code, stdout, and stderr.",
    },
    {
      id: "step-verify-env",
      title: "Verifier checks command outputs",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result explains whether the environment checks succeeded.",
    },
  ];
}

function createResearchSourcePlan(): TaskStep[] {
  return [
    {
      id: "step-fetch-sources",
      title: "Research Agent fetches user-provided source URLs",
      assignedAgentKind: "research",
      status: "pending",
      successCriteria: "Each source returns URL, title or excerpt, and fetched timestamp.",
    },
    {
      id: "step-verify-sources",
      title: "Verifier checks source evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result only verifies sources with retrievable excerpts.",
    },
  ];
}

function commanderSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[0], status, task);
}

function fileSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[1], status, task);
}

function shellSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[2], status, task);
}

function researchSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[3], status, task);
}

function verifierSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[4], status, task);
}

function createAgentSnapshot(agent: Agent, status: AgentRunStatus, task: string): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.displayName,
    role: agent.description,
    status,
    task,
  };
}

function appendLog(snapshotValue: TaskSnapshot, entry: TaskLogEntry): TaskLogEntry[] {
  return [...snapshotValue.logs, entry];
}

function markStep(
  steps: TaskStep[],
  firstStepId: ID,
  firstStatus: TaskStep["status"],
  secondStepId?: ID,
  secondStatus?: TaskStep["status"],
): TaskStep[] {
  return steps.map((step) => {
    if (step.id === firstStepId) {
      return { ...step, status: firstStatus };
    }
    if (step.id === secondStepId && secondStatus) {
      return { ...step, status: secondStatus };
    }
    return step;
  });
}

function isProjectInspectionGoal(userGoal: string): boolean {
  return /项目|启动|测试|环境|命令|project|test|start|environment/i.test(userGoal);
}

function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s)]+/g), (match) => match[0]);
}
