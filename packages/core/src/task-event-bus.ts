import type { AskUserQuestionRequest, PermissionRequest as ToolPermissionRequest } from "@javis/tools";
import type {
  AgentKind,
  AgentRunStatus,
  ID,
  TaskLogEntry,
} from "./index";

type ToolRuntimeIdentity = {
  toolCallId?: ID;
  stepId?: ID;
  agentId?: ID;
  agentKind?: AgentKind;
  agentRunId?: ID;
  attempt?: number;
  backendSessionId?: string;
};

export type TaskRuntimeEvent =
  | { kind: "task.created"; taskId: ID }
  | {
      kind: "task.waiting";
      taskId: ID;
      phase: "waiting_model" | "waiting_tool" | "waiting_user";
      label: string;
      detail: string;
      stepId?: ID;
      agentKind?: AgentKind;
      toolName?: string;
    }
  | {
      kind: "task.timeout";
      taskId: ID;
      phase: "waiting_model" | "waiting_tool" | "waiting_user";
      label: string;
      timeoutMs: number;
      detail: string;
      stepId?: ID;
      agentKind?: AgentKind;
      toolName?: string;
    }
  | {
      kind: "task.cancelled";
      taskId: ID;
      label: string;
      detail: string;
      stepId?: ID;
      agentKind?: AgentKind;
    }
  | {
      kind: "task.replan_started";
      taskId: ID;
      failedStepId: ID;
      error: string;
    }
  | {
      kind: "task.replan_failed";
      taskId: ID;
      failedStepId: ID;
      error: string;
    }
  | {
      kind: "agent.status";
      taskId: ID;
      agentKind: AgentKind;
      status: AgentRunStatus;
      message: string;
    }
  | ({ kind: "tool.planned"; taskId: ID; toolName: string; detail: string } & ToolRuntimeIdentity)
  | ({ kind: "tool.started"; taskId: ID; toolName: string; detail: string } & ToolRuntimeIdentity)
  | ({ kind: "tool.completed"; taskId: ID; toolName: string; detail: string } & ToolRuntimeIdentity)
  | ({
      kind: "tool.failed";
      taskId: ID;
      toolName: string;
      detail: string;
      reason: string;
    } & ToolRuntimeIdentity)
  | {
      kind: "permission.requested";
      taskId: ID;
      stepId: ID;
      toolName: string;
      previewHash: string;
      request: ToolPermissionRequest;
    }
  | {
      kind: "permission.resolved";
      taskId: ID;
      stepId: ID;
      toolName: string;
      previewHash: string;
      requestId: string;
      decision: "approved" | "denied";
    }
  | { kind: "ask_user.requested"; taskId: ID; question: AskUserQuestionRequest }
  | { kind: "ask_user.responded"; taskId: ID; requestId: string; answer: string }
  | { kind: "task.completed"; taskId: ID; detail?: string }
  | { kind: "task.failed"; taskId: ID; error: string }
  // Streaming agent output events
  | { kind: "agent.chunk_start"; taskId: ID; agentKind: AgentKind }
  | { kind: "agent.chunk"; taskId: ID; agentKind: AgentKind; text: string }
  | { kind: "agent.chunk_end"; taskId: ID; agentKind: AgentKind; fullText: string; error?: string }
  // Step-level progress events
  | { kind: "step.progress"; taskId: ID; stepId: ID; percent: number; detail: string; agentKind?: AgentKind; agentId?: ID }
  | { kind: "step.started"; taskId: ID; stepId: ID; agentKind?: AgentKind; agentId?: ID }
  | { kind: "step.completed"; taskId: ID; stepId: ID; summary: string; agentKind?: AgentKind; agentId?: ID }
  | { kind: "step.failed"; taskId: ID; stepId: ID; error: string; agentKind?: AgentKind; agentId?: ID }
  // Tool partial output events
  | { kind: "tool.partial"; taskId: ID; toolCallId: ID; partialOutput: string };

export const AGENT_RUN_EVENT_KINDS = [
  "task.created",
  "task.waiting",
  "task.timeout",
  "task.cancelled",
  "task.replan_started",
  "task.replan_failed",
  "agent.status",
  "agent.chunk_start",
  "agent.chunk",
  "agent.chunk_end",
  "step.started",
  "step.progress",
  "step.completed",
  "step.failed",
  "tool.planned",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.partial",
  "permission.requested",
  "permission.resolved",
  "ask_user.requested",
  "ask_user.responded",
  "task.completed",
  "task.failed",
] as const;

export type AgentRunEventKind = typeof AGENT_RUN_EVENT_KINDS[number];
export type AgentRunEvent = Extract<TaskRuntimeEvent, { kind: AgentRunEventKind }>;

export function isAgentRunEvent(event: TaskRuntimeEvent): event is AgentRunEvent {
  return (AGENT_RUN_EVENT_KINDS as readonly string[]).includes(event.kind);
}

export type TaskEventHandler = (event: TaskRuntimeEvent) => void;
export type TaskEventMiddleware = (
  event: TaskRuntimeEvent,
  next: (event: TaskRuntimeEvent) => void,
) => void;

export interface TaskEventBus {
  emit(event: TaskRuntimeEvent): void;
  on(handler: TaskEventHandler): () => void;
  use(middleware: TaskEventMiddleware): () => void;
}

export function createTaskEventBus(): TaskEventBus {
  const handlers = new Set<TaskEventHandler>();
  const middlewares: TaskEventMiddleware[] = [];

  return {
    emit(event) {
      const dispatch = (index: number, currentEvent: TaskRuntimeEvent): void => {
        const middleware = middlewares[index];
        if (middleware) {
          middleware(currentEvent, (nextEvent) => dispatch(index + 1, nextEvent));
          return;
        }
        for (const handler of handlers) {
          handler(currentEvent);
        }
      };
      dispatch(0, event);
    },
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    use(middleware) {
      middlewares.push(middleware);
      return () => {
        const index = middlewares.indexOf(middleware);
        if (index >= 0) {
          middlewares.splice(index, 1);
        }
      };
    },
  };
}

export function taskEventToLogEntry(event: TaskRuntimeEvent): TaskLogEntry {
  switch (event.kind) {
    case "task.created":
      return {
        id: `${event.taskId}-event-created`,
        kind: "event",
        title: "task.created",
        detail: "Task event bus recorded task creation.",
        userMessage: "任务已创建",
        devDetail: "Task event bus recorded task creation.",
      };
    case "task.waiting":
      return {
        id: `${event.taskId}-${event.phase}-${toLogIdPart(event.label)}`,
        kind: "event",
        title: event.phase,
        detail: `${event.label}: ${event.detail}`,
        userMessage: event.detail,
        devDetail: JSON.stringify({
          phase: event.phase,
          label: event.label,
          detail: event.detail,
          toolName: event.toolName,
        }),
        ...optionalLogOwnership(
          event.agentKind ? agentIdFromKind(event.agentKind) : agentIdFromToolName(event.toolName ?? ""),
          event.stepId,
        ),
      };
    case "task.timeout":
      return {
        id: `${event.taskId}-timeout-${toLogIdPart(event.label)}`,
        kind: "tool",
        title: "timeout",
        detail: `${event.label} timed out after ${event.timeoutMs}ms. ${event.detail}`,
        userMessage: `Timed out: ${event.label}`,
        devDetail: JSON.stringify({
          phase: event.phase,
          label: event.label,
          timeoutMs: event.timeoutMs,
          detail: event.detail,
          toolName: event.toolName,
        }),
        ...optionalLogOwnership(
          event.agentKind ? agentIdFromKind(event.agentKind) : agentIdFromToolName(event.toolName ?? ""),
          event.stepId,
        ),
      };
    case "task.cancelled":
      return {
        id: `${event.taskId}-cancelled-${toLogIdPart(event.label)}`,
        kind: "event",
        title: "cancelled",
        detail: `${event.label}: ${event.detail}`,
        userMessage: event.detail,
        devDetail: JSON.stringify({
          label: event.label,
          detail: event.detail,
        }),
        ...optionalLogOwnership(
          event.agentKind ? agentIdFromKind(event.agentKind) : undefined,
          event.stepId,
        ),
      };
    case "task.replan_started": {
      const safeError = redactTaskEventLogSecrets(event.error);
      return {
        id: `${event.taskId}-replan-started-${toLogIdPart(event.failedStepId)}`,
        kind: "event",
        title: "replan_started",
        detail: `Replanning after ${event.failedStepId}: ${safeError}`,
        userMessage: `Replanning after ${event.failedStepId}`,
        devDetail: JSON.stringify({
          failedStepId: event.failedStepId,
          error: safeError,
        }),
        stepId: event.failedStepId,
      };
    }
    case "task.replan_failed": {
      const safeError = redactTaskEventLogSecrets(event.error);
      return {
        id: `${event.taskId}-replan-failed-${toLogIdPart(event.failedStepId)}`,
        kind: "tool",
        title: "replan_failed",
        detail: `Replan failed after ${event.failedStepId}: ${safeError}`,
        userMessage: `Replan failed after ${event.failedStepId}`,
        devDetail: JSON.stringify({
          failedStepId: event.failedStepId,
          error: safeError,
        }),
        stepId: event.failedStepId,
      };
    }
    case "agent.status":
      return {
        id: `${event.taskId}-agent-${event.agentKind}-${event.status}`,
        kind: "event",
        title: "agent.status",
        detail: `${event.agentKind}: ${event.message}`,
        userMessage: getAgentStatusUserMessage(event.agentKind, event.status, event.message),
        devDetail: `${event.agentKind}: ${event.message}`,
        agentId: agentIdFromKind(event.agentKind),
      };
    case "tool.planned":
      return {
        id: toolEventLogId(event, "planned"),
        kind: "tool",
        title: "tool_call.planned",
        detail: event.detail,
        userMessage: getToolUserMessage(event.toolName, "planned"),
        devDetail: event.detail,
        ...optionalLogOwnership(toolEventOwnerId(event), event.stepId),
      };
    case "tool.started":
      return {
        id: toolEventLogId(event, "started"),
        kind: "tool",
        title: "tool_call.started",
        detail: event.detail,
        userMessage: getToolUserMessage(event.toolName, "started"),
        devDetail: event.detail,
        ...optionalLogOwnership(toolEventOwnerId(event), event.stepId),
      };
    case "tool.completed":
      return {
        id: toolEventLogId(event, "completed"),
        kind: "tool",
        title: "tool_call.updated",
        detail: event.detail,
        userMessage: getToolUserMessage(event.toolName, "completed"),
        devDetail: event.detail,
        ...optionalLogOwnership(toolEventOwnerId(event), event.stepId),
      };
    case "tool.failed":
      return {
        id: toolEventLogId(event, "failed"),
        kind: "tool",
        title: "tool_call.failed",
        detail: event.detail,
        userMessage: `${event.toolName} 执行失败`,
        devDetail: event.detail,
        ...optionalLogOwnership(toolEventOwnerId(event), event.stepId),
      };
    case "permission.requested":
      return {
        id: `${event.taskId}-permission-${event.request.id}-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: event.request.reason,
        userMessage: "需要你的确认才能继续",
        devDetail: event.request.reason,
        ...optionalLogOwnership(agentIdFromToolName(event.toolName), event.stepId),
      };
    case "permission.resolved":
      return {
        id: `${event.taskId}-permission-${event.requestId}-resolved`,
        kind: "permission",
        title: "permission.resolved",
        detail: `Permission ${event.requestId} was ${event.decision}.`,
        userMessage: event.decision === "approved" ? "确认已通过" : "确认已拒绝",
        devDetail: `Permission ${event.requestId} was ${event.decision}.`,
        ...optionalLogOwnership(agentIdFromToolName(event.toolName), event.stepId),
      };
    case "ask_user.requested":
      return {
        id: `${event.taskId}-askuser-${event.question.id}-requested`,
        kind: "event",
        title: "ask_user.requested",
        detail: event.question.question,
        userMessage: event.question.question,
        devDetail: `ask_user.requested: ${event.question.question}`,
      };
    case "ask_user.responded":
      return {
        id: `${event.taskId}-askuser-${event.requestId}-responded`,
        kind: "event",
        title: "ask_user.responded",
        detail: `User answered: ${event.answer}`,
        userMessage: "已收到你的补充信息",
        devDetail: `User answered: ${event.answer}`,
      };
    case "task.completed":
      return {
        id: `${event.taskId}-event-completed`,
        kind: "verification",
        title: "task.completed",
        detail: event.detail ?? "Task event bus recorded task completion.",
        userMessage: event.detail ?? "任务已完成",
        devDetail: event.detail ?? "Task event bus recorded task completion.",
      };
    case "task.failed": {
      const safeError = redactTaskEventLogSecrets(event.error);
      return {
        id: `${event.taskId}-event-failed`,
        kind: "tool",
        title: "task.failed",
        detail: safeError,
        userMessage: `出错: ${toShortError(safeError)}`,
        devDetail: safeError,
      };
    }
    case "agent.chunk_start":
      return {
        id: `${event.taskId}-chunk-start-${event.agentKind}`,
        kind: "event",
        title: "agent.chunk_start",
        detail: `${event.agentKind} is generating output...`,
        userMessage: "正在生成回复...",
        devDetail: `${event.agentKind} is generating output...`,
        agentId: agentIdFromKind(event.agentKind),
      };
    case "agent.chunk":
      return {
        id: `${event.taskId}-chunk-${event.agentKind}-${Date.now()}`,
        kind: "event",
        title: "agent.chunk",
        detail: event.text,
        userMessage: "",
        devDetail: event.text,
        agentId: agentIdFromKind(event.agentKind),
      };
    case "agent.chunk_end":
      const chunkEndUserMessage = event.error
        ? `回复生成失败: ${toShortError(event.error)}`
        : event.fullText.trim().length > 0
          ? "回复生成完成"
          : "回复生成结束（无正文）";
      return {
        id: `${event.taskId}-chunk-end-${event.agentKind}`,
        kind: "event",
        title: "agent.chunk_end",
        detail: event.error
          ? `${event.agentKind} output failed after ${event.fullText.length} chars: ${event.error}`
          : `${event.agentKind} output ended (${event.fullText.length} chars).`,
        userMessage: chunkEndUserMessage,
        devDetail: event.error
          ? `${event.agentKind} output failed after ${event.fullText.length} chars: ${event.error}`
          : `${event.agentKind} output ended (${event.fullText.length} chars).`,
        agentId: agentIdFromKind(event.agentKind),
      };
    case "step.progress":
      return {
        id: `${event.taskId}-step-${event.stepId}-progress`,
        kind: "event",
        title: "step.progress",
        detail: event.detail,
        userMessage: event.detail,
        devDetail: `Step ${event.stepId} progress ${event.percent}%: ${event.detail}`,
        ...optionalLogOwnership(
          event.agentId ?? agentIdFromOptionalKind(event.agentKind),
          event.stepId,
        ),
      };
    case "step.started":
      return {
        id: `${event.taskId}-step-${event.stepId}-started`,
        kind: "event",
        title: "step.started",
        detail: `Step ${event.stepId} started.`,
        userMessage: "正在执行下一步。",
        devDetail: `Dispatching step ${event.stepId}.`,
        ...optionalLogOwnership(
          event.agentId ?? agentIdFromOptionalKind(event.agentKind),
          event.stepId,
        ),
      };
    case "step.completed":
      return {
        id: `${event.taskId}-step-${event.stepId}-completed`,
        kind: "event",
        title: "step.completed",
        detail: event.summary,
        userMessage: "这一步已完成。",
        devDetail: event.summary,
        ...optionalLogOwnership(
          event.agentId ?? agentIdFromOptionalKind(event.agentKind),
          event.stepId,
        ),
      };
    case "step.failed": {
      const safeError = redactTaskEventLogSecrets(event.error);
      return {
        id: `${event.taskId}-step-${event.stepId}-failed`,
        kind: "tool",
        title: "step.failed",
        detail: safeError,
        userMessage: `这一步失败了: ${toShortError(safeError)}`,
        devDetail: safeError,
        ...optionalLogOwnership(
          event.agentId ?? agentIdFromOptionalKind(event.agentKind),
          event.stepId,
        ),
      };
    }
    case "tool.partial":
      return {
        id: `${event.taskId}-tool-${event.toolCallId}-partial`,
        kind: "tool",
        title: "tool.partial",
        detail: event.partialOutput,
        userMessage: "",
        devDetail: event.partialOutput,
      };
  }
}

function agentIdFromKind(agentKind: AgentKind): string {
  return `agent-${agentKind === "browser" ? "page-agent" : agentKind}`;
}

function optionalLogOwnership(
  agentId: string | undefined,
  stepId: string | undefined,
): Partial<Pick<TaskLogEntry, "agentId" | "stepId">> {
  return {
    ...(agentId ? { agentId } : {}),
    ...(stepId ? { stepId } : {}),
  };
}

function toLogIdPart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "event";
}

function agentIdFromOptionalKind(agentKind: AgentKind | undefined): string | undefined {
  return agentKind ? agentIdFromKind(agentKind) : undefined;
}

function agentIdFromToolName(toolName: string): string | undefined {
  const [prefix] = toolName.split(".");
  if (!prefix) return undefined;
  return agentIdFromKind(prefix as AgentKind);
}

const AGENT_DISPLAY_NAMES: Partial<Record<AgentKind, string>> = {
  commander: "Commander",
  file: "File Agent",
  shell: "Shell Agent",
  code: "Code Agent",
  "language-reviewer": "Language Reviewer",
  "security-reviewer": "Security Reviewer",
  "build-fix": "Build Fix Agent",
  "test-runner": "Test Runner",
  "doc-updater": "Doc Updater",
  explorer: "Explorer",
  "perf-analyzer": "Performance Analyzer",
  refactor: "Refactor Agent",
  research: "Research Agent",
  computer: "Computer Agent",
  scheduler: "Scheduler Agent",
  verifier: "Verifier",
  vision: "Vision Agent",
  workspace: "Workspace Agent",
  "page-agent": "Page Agent",
};

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  "commander.plan": "任务规划",
  "commander.synthesize": "结果总结",
  "commander.askUser": "补充信息确认",
  "memory.search": "记忆检索",
  "file.scanMarkdownDocuments": "文档扫描",
  "file.scanUserDocuments": "本地文档扫描",
  "file.classifyDocuments": "文档分类",
  "file.planPdfOrganization": "PDF 整理预览",
  "file.executePdfOrganization": "PDF 整理",
  "file.planWriteText": "文本写入预览",
  "file.writeText": "文本写入",
  "shell.runReadOnlyCommand": "只读命令检查",
  "code.inspectRepository": "仓库变更检查",
  "code.inspectWorkspace": "工作区结构检查",
  "code.searchRepository": "代码库检索",
  "code.traceCallChain": "调用链追踪",
  "code.proposeEdit": "代码修改预览",
  "code.applyProposedEdit": "代码修改应用",
  "web.search": "网页搜索",
  "web.fetchSource": "网页读取",
};

function getAgentDisplayName(agentKind: AgentKind): string {
  return AGENT_DISPLAY_NAMES[agentKind] ?? String(agentKind);
}

function getAgentStatusUserMessage(
  agentKind: AgentKind,
  status: AgentRunStatus,
  message: string,
): string {
  if (status === "running") {
    return `正在处理: ${message}`;
  }
  if (status === "completed") {
    return `${getAgentDisplayName(agentKind)} 已完成`;
  }
  if (status === "failed") {
    return `${getAgentDisplayName(agentKind)} 执行失败`;
  }
  if (status === "waiting_permission") {
    return "等待你的确认";
  }
  return message;
}

function getToolUserMessage(toolName: string, phase: "planned" | "started" | "completed"): string {
  const readableName = TOOL_DISPLAY_NAMES[toolName] ?? toolName
    .replace(/^commander\./, "")
    .replace(/\./g, " ");
  if (phase === "planned") return `准备执行: ${readableName}`;
  if (phase === "started") return `${readableName} 执行中`;
  return `${readableName} 已完成`;
}

function toolEventLogId(
  event: { taskId: ID; toolName: string; toolCallId?: ID },
  phase: string,
): string {
  const callId = event.toolCallId ? `-${toLogIdPart(event.toolCallId)}` : "";
  return `${event.taskId}-tool-${event.toolName}${callId}-${phase}`;
}

function toolEventOwnerId(event: ToolRuntimeIdentity & { toolName: string }): ID | undefined {
  return event.agentId ?? (event.agentKind ? agentIdFromKind(event.agentKind) : agentIdFromToolName(event.toolName));
}

function toShortError(error: string): string {
  const firstLine = error.split(/\r?\n/u)[0]?.trim() || "";
  if (/^Commander plan compilation failed:\s*$/iu.test(firstLine)) {
    if (/\b(?:rate(?:\s+limit)?|429)\b/iu.test(error)) {
      return "Commander 计划编译失败：请求频率过高，请稍后重试。";
    }
    if (/\b(?:timeout|timed out)\b/iu.test(error)) {
      return "Commander 计划编译失败：模型请求超时，请重试。";
    }
    const diagnosticCodes = [...error.matchAll(/\b(?:ERROR|WARN)\s+([A-Z][A-Z0-9_]+)\b/gu)]
      .map((match) => match[1]);
    if (
      diagnosticCodes.includes("MISSING_APPROVAL_TOOL_SELECTION") ||
      diagnosticCodes.includes("MISSING_TOOL_INPUT")
    ) {
      return "Commander 计划中的工具或必要输入不完整，自动修复未成功，请重试。";
    }
    if (
      diagnosticCodes.includes("MISSING_VERIFIER") ||
      diagnosticCodes.includes("INVALID_EXECUTION_MODE")
    ) {
      return "Commander 计划缺少必要的验证或总结步骤，自动修复未成功，请重试。";
    }
    if (diagnosticCodes.includes("CAPABILITY_NOT_AVAILABLE")) {
      return "Commander 计划中的 Agent 与能力不匹配，自动修复未成功，请重试。";
    }
    const diagnosticCode = diagnosticCodes[0];
    return diagnosticCode
      ? `Commander 计划编译失败（${diagnosticCode}），请查看任务详情。`
      : "Commander 计划编译失败，请查看任务详情。";
  }
  return firstLine.slice(0, 160) || "任务执行失败";
}

export function redactTaskEventLogSecrets(value: string): string {
  return value
    .replace(
      /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu,
      "[redacted:image data URL]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, "Bearer [redacted:secret]")
    .replace(/\b(?:Basic|Token)\s+[A-Za-z0-9._~+\/-]{8,}/giu, (match) =>
      `${match.split(/\s+/u)[0]} [redacted:secret]`
    )
    .replace(
      /\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|token|secret|password|passwd|credential))\s*[:=]\s*["']?[^\s,;"']+/giu,
      "$1=[redacted:secret]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,})\b/gu,
      "[redacted:secret]",
    );
}
