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
  verificationSummary?: string;
}

export interface TaskRuntime {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
  start(userGoal: string): void;
  dispose(): void;
}

const demoAgents: Agent[] = [
  {
    id: "agent-commander",
    kind: "commander",
    displayName: "Commander",
    description: "任务拆解与调度",
    allowedToolNames: [],
  },
  {
    id: "agent-file",
    kind: "file",
    displayName: "File Agent",
    description: "本地文件工具",
    allowedToolNames: ["file.search"],
  },
  {
    id: "agent-verifier",
    kind: "verifier",
    displayName: "Verifier",
    description: "结果验证",
    allowedToolNames: [],
  },
];

export function createInitialTaskSnapshot(): TaskSnapshot {
  return {
    id: "task-idle",
    title: "Ready",
    userGoal: "等待用户输入任务",
    status: "created",
    commanderMessage: "Javis 桌面工作台已准备好。输入一个目标后，Core 会发送任务事件流。",
    plan: [],
    agents: demoAgents.map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      role: agent.description,
      status: "queued",
      task: "等待任务",
    })),
    logs: [
      {
        id: "log-ready",
        kind: "event",
        title: "Runtime ready",
        detail: "Core runtime 已创建，等待 startTask。",
      },
    ],
  };
}

export function createDemoTaskRuntime(delayMs = 650): TaskRuntime {
  let snapshot = createInitialTaskSnapshot();
  const listeners = new Set<(nextSnapshot: TaskSnapshot) => void>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  function emit(nextSnapshot: TaskSnapshot) {
    snapshot = nextSnapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function schedule(index: number, update: () => TaskSnapshot) {
    timers.push(
      setTimeout(() => {
        emit(update());
      }, delayMs * index),
    );
  }

  function start(userGoal: string) {
    for (const timer of timers.splice(0)) {
      clearTimeout(timer);
    }

    const taskId = `task-${Date.now()}`;
    const plan = createDemoPlan();

    emit({
      id: taskId,
      title: "Planning task",
      userGoal,
      status: "created",
      commanderMessage: "Commander 已接收目标，正在创建任务。",
      plan: [],
      agents: createAgentSnapshots("queued", "等待 Commander 分配步骤"),
      logs: [
        {
          id: `${taskId}-created`,
          kind: "event",
          title: "task.created",
          detail: "UI 已把用户目标交给 Core。",
        },
      ],
    });

    schedule(1, () => ({
      ...snapshot,
      title: "Planning task",
      status: "planning",
      commanderMessage: "Commander 正在拆解任务，并为 Worker Agent 准备步骤。",
      plan,
      agents: [
        commanderSnapshot("planning", "生成任务计划"),
        fileSnapshot("queued", "等待本地扫描步骤"),
        verifierSnapshot("queued", "等待 Worker 结果"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-plan`,
        kind: "plan",
        title: "task.plan_updated",
        detail: "生成 3 个步骤：规划、模拟工具调用、验证结果。",
      }),
    }));

    schedule(2, () => ({
      ...snapshot,
      title: "Running task",
      status: "running",
      commanderMessage: "File Agent 正在执行只读模拟工具调用。真实文件工具将在 Milestone 3 接入。",
      plan: markStep(snapshot.plan, "step-read", "running"),
      agents: [
        commanderSnapshot("completed", "计划已提交"),
        fileSnapshot("running", "模拟 file.search read 工具调用"),
        verifierSnapshot("queued", "等待验证"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-tool`,
        kind: "tool",
        title: "tool_call.updated",
        detail: "file.search 以 read 权限完成模拟调用，没有修改本地文件。",
      }),
    }));

    schedule(3, () => ({
      ...snapshot,
      title: "Verifying task",
      status: "verifying",
      commanderMessage: "Verifier 正在检查事件、计划和工具输出是否完整。",
      plan: markStep(snapshot.plan, "step-read", "completed", "step-verify", "running"),
      agents: [
        commanderSnapshot("completed", "等待验证结论"),
        fileSnapshot("completed", "模拟工具调用完成"),
        verifierSnapshot("verifying", "检查状态流转和日志证据"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-verifying`,
        kind: "verification",
        title: "verification.started",
        detail: "Verifier 正在检查 mock task 是否满足 Milestone 2 验收。",
      }),
    }));

    schedule(4, () => ({
      ...snapshot,
      title: "Task completed",
      status: "completed",
      commanderMessage: "模拟任务已完成。Main Thread、Agent Inspector 和 Activity 区都已收到状态更新。",
      plan: snapshot.plan.map((step) => ({ ...step, status: "completed" })),
      agents: [
        commanderSnapshot("completed", "任务完成"),
        fileSnapshot("completed", "只读工具模拟完成"),
        verifierSnapshot("completed", "验证通过"),
      ],
      logs: appendLog(snapshot, {
        id: `${taskId}-done`,
        kind: "verification",
        title: "task.completed",
        detail: "状态流转完成：created -> planning -> running -> verifying -> completed。",
      }),
      verificationSummary: "verified: mock task lifecycle completed with visible evidence.",
    }));
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
    start,
    dispose() {
      for (const timer of timers.splice(0)) {
        clearTimeout(timer);
      }
      listeners.clear();
    },
  };
}

function createDemoPlan(): TaskStep[] {
  return [
    {
      id: "step-plan",
      title: "Commander 生成任务计划",
      assignedAgentKind: "commander",
      status: "completed",
      successCriteria: "UI 能看到计划步骤",
    },
    {
      id: "step-read",
      title: "File Agent 执行只读模拟工具调用",
      assignedAgentKind: "file",
      status: "pending",
      successCriteria: "Activity 区能看到 tool_call 事件",
    },
    {
      id: "step-verify",
      title: "Verifier 检查任务状态流转",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "最终状态为 completed 并给出验证摘要",
    },
  ];
}

function createAgentSnapshots(status: AgentRunStatus, task: string): AgentSnapshot[] {
  return demoAgents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    role: agent.description,
    status,
    task,
  }));
}

function commanderSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[0], status, task);
}

function fileSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[1], status, task);
}

function verifierSnapshot(status: AgentRunStatus, task: string): AgentSnapshot {
  return createAgentSnapshot(demoAgents[2], status, task);
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
