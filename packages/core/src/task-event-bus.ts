import type { AskUserQuestionRequest, PermissionRequest as ToolPermissionRequest } from "@javis/tools";
import type {
  AgentKind,
  AgentRunStatus,
  ID,
  TaskLogEntry,
} from "./index";

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
  | { kind: "tool.planned"; taskId: ID; toolName: string; detail: string }
  | { kind: "tool.completed"; taskId: ID; toolName: string; detail: string }
  | { kind: "permission.requested"; taskId: ID; request: ToolPermissionRequest }
  | {
      kind: "permission.resolved";
      taskId: ID;
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
  "tool.completed",
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
        agentId: event.agentKind ? agentIdFromKind(event.agentKind) : agentIdFromToolName(event.toolName ?? ""),
        stepId: event.stepId,
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
        agentId: event.agentKind ? agentIdFromKind(event.agentKind) : agentIdFromToolName(event.toolName ?? ""),
        stepId: event.stepId,
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
        agentId: event.agentKind ? agentIdFromKind(event.agentKind) : undefined,
        stepId: event.stepId,
      };
    case "task.replan_started":
      return {
        id: `${event.taskId}-replan-started-${toLogIdPart(event.failedStepId)}`,
        kind: "event",
        title: "replan_started",
        detail: `Replanning after ${event.failedStepId}: ${event.error}`,
        userMessage: `Replanning after ${event.failedStepId}`,
        devDetail: JSON.stringify({
          failedStepId: event.failedStepId,
          error: event.error,
        }),
        stepId: event.failedStepId,
      };
    case "task.replan_failed":
      return {
        id: `${event.taskId}-replan-failed-${toLogIdPart(event.failedStepId)}`,
        kind: "tool",
        title: "replan_failed",
        detail: `Replan failed after ${event.failedStepId}: ${event.error}`,
        userMessage: `Replan failed after ${event.failedStepId}`,
        devDetail: JSON.stringify({
          failedStepId: event.failedStepId,
          error: event.error,
        }),
        stepId: event.failedStepId,
      };
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
        id: `${event.taskId}-tool-${event.toolName}-planned`,
        kind: "tool",
        title: "tool_call.planned",
        detail: event.detail,
        userMessage: getToolUserMessage(event.toolName, "planned"),
        devDetail: event.detail,
        agentId: agentIdFromToolName(event.toolName),
      };
    case "tool.completed":
      return {
        id: `${event.taskId}-tool-${event.toolName}-completed`,
        kind: "tool",
        title: "tool_call.updated",
        detail: event.detail,
        userMessage: getToolUserMessage(event.toolName, "completed"),
        devDetail: event.detail,
        agentId: agentIdFromToolName(event.toolName),
      };
    case "permission.requested":
      return {
        id: `${event.taskId}-permission-${event.request.id}-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: event.request.reason,
        userMessage: "需要你的确认才能继续",
        devDetail: event.request.reason,
      };
    case "permission.resolved":
      return {
        id: `${event.taskId}-permission-${event.requestId}-resolved`,
        kind: "permission",
        title: "permission.resolved",
        detail: `Permission ${event.requestId} was ${event.decision}.`,
        userMessage: event.decision === "approved" ? "确认已通过" : "确认已拒绝",
        devDetail: `Permission ${event.requestId} was ${event.decision}.`,
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
    case "task.failed":
      return {
        id: `${event.taskId}-event-failed`,
        kind: "tool",
        title: "task.failed",
        detail: event.error,
        userMessage: `出错: ${toShortError(event.error)}`,
        devDetail: event.error,
      };
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
      return {
        id: `${event.taskId}-chunk-end-${event.agentKind}`,
        kind: "event",
        title: "agent.chunk_end",
        detail: `${event.agentKind} completed output (${event.fullText.length} chars).`,
        userMessage: "回复生成完成",
        devDetail: `${event.agentKind} completed output (${event.fullText.length} chars).`,
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
        agentId: event.agentId ?? agentIdFromOptionalKind(event.agentKind),
        stepId: event.stepId,
      };
    case "step.started":
      return {
        id: `${event.taskId}-step-${event.stepId}-started`,
        kind: "event",
        title: "step.started",
        detail: `Step ${event.stepId} started.`,
        userMessage: `正在执行: ${event.stepId}`,
        devDetail: `Dispatching step ${event.stepId}.`,
        agentId: event.agentId ?? agentIdFromOptionalKind(event.agentKind),
        stepId: event.stepId,
      };
    case "step.completed":
      return {
        id: `${event.taskId}-step-${event.stepId}-completed`,
        kind: "event",
        title: "step.completed",
        detail: event.summary,
        userMessage: `${event.stepId} 完成`,
        devDetail: event.summary,
        agentId: event.agentId ?? agentIdFromOptionalKind(event.agentKind),
        stepId: event.stepId,
      };
    case "step.failed":
      return {
        id: `${event.taskId}-step-${event.stepId}-failed`,
        kind: "tool",
        title: "step.failed",
        detail: event.error,
        userMessage: `${event.stepId} 失败: ${toShortError(event.error)}`,
        devDetail: event.error,
        agentId: event.agentId ?? agentIdFromOptionalKind(event.agentKind),
        stepId: event.stepId,
      };
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
  return `agent-${agentKind}`;
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

function getAgentStatusUserMessage(
  agentKind: AgentKind,
  status: AgentRunStatus,
  message: string,
): string {
  if (status === "running") {
    return `正在处理: ${message}`;
  }
  if (status === "completed") {
    return `${agentKind} 已完成`;
  }
  if (status === "failed") {
    return `${agentKind} 执行失败`;
  }
  if (status === "waiting_permission") {
    return "等待你的确认";
  }
  return message;
}

function getToolUserMessage(toolName: string, phase: "planned" | "completed"): string {
  const readableName = toolName
    .replace(/^commander\./, "")
    .replace(/\./g, " ");
  return phase === "planned"
    ? `准备执行: ${readableName}`
    : `${readableName} 已完成`;
}

function toShortError(error: string): string {
  return error.split(/\r?\n/u)[0]?.slice(0, 160) || "任务执行失败";
}
