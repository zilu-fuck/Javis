# 核心契约

## 设计目标

这份文档定义 Javis 第一版编码时必须共享的核心类型、事件流和模块边界。目标不是设计完整框架，而是让 `apps/desktop`、`packages/core`、`packages/tools` 和 Tauri bridge 在第一轮实现时使用同一套语言。

第一版契约遵循这些原则：

- 桌面 UI 是主入口，所有任务状态都必须能被 UI 实时展示。
- Core 负责 Agent 编排和状态流转，不直接碰本地系统能力。
- Tools 负责工具抽象、权限分级和 dry-run，不绕过权限策略。
- Tauri 只负责本地原生能力桥接，不写 Agent 决策逻辑。
- 每个可见状态变化都通过 `TaskEvent` 传播，UI 不猜测后台发生了什么。
- 写入、移动、覆盖、删除、安装依赖、执行高风险命令等操作必须先形成 `PermissionRequest`。
- Verifier 是独立阶段，不能把 Worker 的输出直接当作最终完成。

## 核心实体

### TypeScript 伪代码接口

以下接口是编码契约，不是最终实现代码。实际字段可以按实现微调，但语义不要漂移。

```ts
type ID = string;
type ISODateTime = string;

type TaskStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

type AgentKind =
  | "commander"
  | "file"
  | "shell"
  | "browser"
  | "research"
  | "code"
  | "verifier";

type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

type PermissionLevel =
  | "read"
  | "preview"
  | "confirmed_write"
  | "dangerous";

type VerificationStatus =
  | "verified"
  | "unverified"
  | "failed";

interface Task {
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

interface TaskStep {
  id: ID;
  title: string;
  assignedAgentKind: AgentKind;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  successCriteria?: string;
}

interface Agent {
  id: ID;
  kind: AgentKind;
  displayName: string;
  description: string;
  allowedToolNames: string[];
  preferredModelTags?: string[];
}

interface AgentRun {
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

interface ModelProfile {
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

interface ToolCall {
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

interface DryRunSummary {
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

interface PermissionRequest {
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

interface VerificationResult {
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

type TaskEvent =
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

interface TaskError {
  code: string;
  message: string;
  recoverable: boolean;
  detail?: unknown;
}
```

## Agent 状态机

第一版不做复杂工作流引擎，但状态流转必须稳定。

```text
queued
  -> planning
  -> running
  -> waiting_permission
  -> running
  -> verifying
  -> completed

running
  -> failed
  -> queued | cancelled

verifying
  -> completed | failed

任何非终态
  -> cancelled
```

规则：

- `Commander` 创建 `Task` 后先进入 `planning`，生成 `TaskStep[]`。
- Worker Agent 只处理自己负责的步骤，不能直接结束整个 Task。
- Agent 需要工具时必须先创建 `ToolCall`，再由 Tools 判断权限等级。
- `read` 工具可以直接执行，但仍要产生 `tool_call` 事件。
- `preview` 工具只能生成计划或 dry-run，不能改变本地状态。
- `confirmed_write` 必须进入 `waiting_permission`，等 UI 返回确认结果。
- `dangerous` 第一版默认拒绝，除非后续文档明确开放。
- `Verifier` 只在 Worker 阶段结束后运行，输出 `VerificationResult`。
- Verifier 失败且 `recoverable = true` 时，Commander 最多触发一次默认重试；更多重试需要用户确认。

## UI / Core / Tools / Tauri 数据流

```text
React UI
  -> startTask(userGoal, workspacePath?)
  -> Core Commander
  -> Model Router
  -> Agent Runtime
  -> Tools
  -> Tauri Commands
  -> Tools
  -> Core
  -> TaskEvent stream
  -> React UI
```

模块边界：

- UI 负责展示任务、Agent 图、日志、确认卡片和用户输入。UI 不直接调用文件系统、shell 或模型。
- Core 负责 `Task` 生命周期、Agent 调度、模型选择、重试策略和 Verifier 调用。Core 不直接调用 Tauri command。
- Tools 负责把 Agent 的意图变成受控工具调用，包括权限分级、dry-run、输入输出摘要和错误归一化。
- Tauri 负责原生能力执行，例如读目录、读文件、执行命令、打开浏览器。Tauri 不知道 `Commander` 和 `Verifier` 的业务语义。
- 所有跨层数据必须可序列化。不要传函数、类实例、文件句柄或不可恢复的运行时对象。

第一版 UI 的数据来源以 `TaskEvent` 为准。UI 可以维护派生视图状态，但不能用派生状态反向决定任务是否完成。

## 事件流

### 任务开始

1. UI 收到用户输入，调用 Core 的 `startTask`。
2. Core 创建 `Task`，发送 `task.created`。
3. Commander 进入 `planning`，发送 `task.status_changed`。
4. Commander 生成计划，发送 `task.plan_updated`。
5. Core 为第一批 Worker 创建 `AgentRun`，发送 `agent_run.started`。

验收点：Main Thread 能看到任务目标和计划，右侧 Inspector 能看到参与的 Agent，底部 Activity 能看到事件日志。

### 工具调用

1. AgentRun 需要外部能力时创建 `ToolCall`。
2. Tools 根据输入判断 `permissionLevel`。
3. Core 发送 `tool_call.planned`。
4. 如果是 `read`，Tools 可以执行并发送 `tool_call.updated`。
5. 如果是 `preview`，Tools 只返回 `DryRunSummary`。
6. 如果是 `confirmed_write` 或 `dangerous`，进入权限流程。

验收点：每次工具调用都要有工具名、发起 Agent、输入摘要、权限等级、结果摘要或错误。

### 权限确认

1. Tools 为需要确认的调用生成 `PermissionRequest`。
2. Core 发送 `permission.requested`，Task 进入 `waiting_permission`。
3. UI 在底部确认区域显示卡片。
4. 用户选择批准或拒绝。
5. Core 发送 `permission.resolved`。
6. 如果批准，Tools 执行原工具调用；如果拒绝，ToolCall 标记为 `denied`，Commander 决定降级、改计划或结束。

规则：确认只对当前 `PermissionRequest` 有效。dry-run 内容、路径、命令或执行目录发生变化时，旧确认失效。

### 验证

1. Worker Agent 完成后，Commander 汇总输出。
2. Verifier Agent 创建独立 `AgentRun`。
3. Verifier 检查文件路径、命令 exit code、来源链接、权限记录或人工证据。
4. Core 发送 `verification.completed`。
5. 如果验证通过，Task 进入 `completed`。
6. 如果验证失败，Task 进入 `failed` 或 `retrying`。

验收点：最终结果必须包含验证摘要。无法验证的内容要明确标为 `unverified`，不能伪装成完成。

### 失败重试

1. 任意 AgentRun 或 ToolCall 失败时，必须产生 `TaskError`。
2. Commander 判断错误是否可恢复。
3. 可恢复错误可以进入 `retrying`，并创建新的 AgentRun。
4. 默认自动重试最多一次。
5. 不可恢复错误直接进入 `failed`，并给出用户可理解的原因。

常见可恢复错误：

- Web 来源暂时不可访问。
- Shell 命令超时但未造成写入。
- 模型返回格式不完整。
- Verifier 缺少证据但可以补一次只读检查。

常见不可恢复错误：

- 用户拒绝关键权限。
- 工具判断为 `dangerous`。
- 工作区路径不存在。
- 文件状态变化导致旧 dry-run 失效，且用户没有重新确认。

## 第一版暂不解决的问题

- 不做可拖拽编辑的复杂 Agent 编排器，Agent Graph 第一版只读展示。
- 不做分布式 Agent Runtime。
- 不做跨设备控制。
- 不做后台静默自动化和长时间无人值守任务。
- 不做完整 MCP 工具市场，只保留未来接入位置。
- 不做 A2A agent-to-agent 协议。
- 不做长期记忆、向量数据库和复杂知识库。
- 不做复杂模型评分系统，`Model Router` 第一版使用配置和规则。
- 不做完整应用自动化，浏览器和桌面应用控制后置。
- 不做自动 commit、push、发布、付款、发消息或提交表单。
- 不承诺所有失败都能自动恢复，失败原因必须清楚可见。
