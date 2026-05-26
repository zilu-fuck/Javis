import type { PermissionRequest as ToolPermissionRequest } from "@javis/tools";
import type {
  AgentKind,
  AgentRunStatus,
  ID,
  TaskLogEntry,
} from "./index";

export type TaskRuntimeEvent =
  | { kind: "task.created"; taskId: ID }
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
  | { kind: "task.completed"; taskId: ID; detail?: string }
  | { kind: "task.failed"; taskId: ID; error: string }
  // Streaming agent output events
  | { kind: "agent.chunk_start"; taskId: ID; agentKind: AgentKind }
  | { kind: "agent.chunk"; taskId: ID; agentKind: AgentKind; text: string }
  | { kind: "agent.chunk_end"; taskId: ID; agentKind: AgentKind; fullText: string; error?: string }
  // Step-level progress events
  | { kind: "step.progress"; taskId: ID; stepId: ID; percent: number; detail: string }
  | { kind: "step.started"; taskId: ID; stepId: ID }
  | { kind: "step.completed"; taskId: ID; stepId: ID; summary: string }
  // Tool partial output events
  | { kind: "tool.partial"; taskId: ID; toolCallId: ID; partialOutput: string };

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
      };
    case "agent.status":
      return {
        id: `${event.taskId}-agent-${event.agentKind}-${event.status}`,
        kind: "event",
        title: "agent.status",
        detail: `${event.agentKind}: ${event.message}`,
      };
    case "tool.planned":
      return {
        id: `${event.taskId}-tool-${event.toolName}-planned`,
        kind: "tool",
        title: "tool_call.planned",
        detail: event.detail,
      };
    case "tool.completed":
      return {
        id: `${event.taskId}-tool-${event.toolName}-completed`,
        kind: "tool",
        title: "tool_call.updated",
        detail: event.detail,
      };
    case "permission.requested":
      return {
        id: `${event.taskId}-permission-${event.request.id}-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: event.request.reason,
      };
    case "permission.resolved":
      return {
        id: `${event.taskId}-permission-${event.requestId}-resolved`,
        kind: "permission",
        title: "permission.resolved",
        detail: `Permission ${event.requestId} was ${event.decision}.`,
      };
    case "task.completed":
      return {
        id: `${event.taskId}-event-completed`,
        kind: "verification",
        title: "task.completed",
        detail: event.detail ?? "Task event bus recorded task completion.",
      };
    case "task.failed":
      return {
        id: `${event.taskId}-event-failed`,
        kind: "tool",
        title: "task.failed",
        detail: event.error,
      };
    case "agent.chunk_start":
      return {
        id: `${event.taskId}-chunk-start-${event.agentKind}`,
        kind: "event",
        title: "agent.chunk_start",
        detail: `${event.agentKind} is generating output...`,
      };
    case "agent.chunk":
      return {
        id: `${event.taskId}-chunk-${event.agentKind}-${Date.now()}`,
        kind: "event",
        title: "agent.chunk",
        detail: event.text,
      };
    case "agent.chunk_end":
      return {
        id: `${event.taskId}-chunk-end-${event.agentKind}`,
        kind: "event",
        title: "agent.chunk_end",
        detail: `${event.agentKind} completed output (${event.fullText.length} chars).`,
      };
    case "step.progress":
      return {
        id: `${event.taskId}-step-${event.stepId}-progress`,
        kind: "event",
        title: "step.progress",
        detail: event.detail,
      };
    case "step.started":
      return {
        id: `${event.taskId}-step-${event.stepId}-started`,
        kind: "event",
        title: "step.started",
        detail: `Step ${event.stepId} started.`,
      };
    case "step.completed":
      return {
        id: `${event.taskId}-step-${event.stepId}-completed`,
        kind: "event",
        title: "step.completed",
        detail: event.summary,
      };
    case "tool.partial":
      return {
        id: `${event.taskId}-tool-${event.toolCallId}-partial`,
        kind: "tool",
        title: "tool.partial",
        detail: event.partialOutput,
      };
  }
}
