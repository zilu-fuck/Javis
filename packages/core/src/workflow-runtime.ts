import type { AgentKind, ID, TaskSnapshot } from "./index";
import { appendLog } from "./snapshot-utils";
import type { TaskRuntimeEvent } from "./task-event-bus";

export interface RuntimeExecutionConfig {
  contextStrategy?: "auto" | "short" | "long";
  agentMaxIterations?: number;
  maxStepRetries?: number;
  taskTimeoutMs?: number;
  failureRecoveryEnabled?: boolean;
  userWaitTimeoutMs?: number;
}

const COMMANDER_MODEL_TIMEOUT_MS = 90_000;
export const COMMANDER_TOOL_TIMEOUT_MS = 90_000;
export const COMMANDER_USER_WAIT_TIMEOUT_MS = 5 * 60_000;
export const COMMANDER_REPLAN_TIMEOUT_MS = 60_000;
export const MCP_LIST_TOOLS_TIMEOUT_MS = 5_000;
const DEFAULT_AGENT_MAX_ITERATIONS = 6;
export const MAX_REACT_MCP_SUBTOOLS = 40;
export const MAX_REACT_MCP_SUBTOOLS_PER_SERVER = 8;

export function resolveCommanderTimeouts(config?: RuntimeExecutionConfig): {
  modelTimeoutMs: number;
  toolTimeoutMs: number;
  replanTimeoutMs: number;
  userWaitTimeoutMs: number;
  agentMaxIterations: number;
  maxStepRetries: number;
} {
  const taskTimeoutMs = clampRuntimeNumber(config?.taskTimeoutMs, 30_000, 900_000, COMMANDER_MODEL_TIMEOUT_MS);
  return {
    modelTimeoutMs: taskTimeoutMs,
    toolTimeoutMs: taskTimeoutMs,
    replanTimeoutMs: clampRuntimeNumber(
      config?.taskTimeoutMs,
      30_000,
      600_000,
      COMMANDER_REPLAN_TIMEOUT_MS,
    ),
    userWaitTimeoutMs: clampRuntimeNumber(
      config?.userWaitTimeoutMs,
      60_000,
      120 * 60_000,
      COMMANDER_USER_WAIT_TIMEOUT_MS,
    ),
    agentMaxIterations: clampRuntimeNumber(
      config?.agentMaxIterations,
      1,
      24,
      DEFAULT_AGENT_MAX_ITERATIONS,
    ),
    maxStepRetries: clampRuntimeNumber(
      config?.maxStepRetries,
      0,
      3,
      1,
    ),
  };
}

function clampRuntimeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

type WaitLogPhase = "waiting_model" | "waiting_tool" | "waiting_user";

function emitStructuredLog(options: {
  event: TaskRuntimeEvent;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
}): void {
  const current = options.getSnapshot();
  options.emitSnapshot({
    ...current,
    logs: appendLog(current, options.emitEvent(options.event)),
  });
}

export function emitWaitingLog(options: {
  taskId: ID;
  phase: WaitLogPhase;
  label: string;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
  toolName?: string;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.waiting",
      taskId: options.taskId,
      phase: options.phase,
      label: options.label,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
      toolName: options.toolName,
    },
  });
}

export function emitTimeoutLog(options: {
  taskId: ID;
  phase: WaitLogPhase;
  label: string;
  timeoutMs: number;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
  toolName?: string;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.timeout",
      taskId: options.taskId,
      phase: options.phase,
      label: options.label,
      timeoutMs: options.timeoutMs,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
      toolName: options.toolName,
    },
  });
}

export function emitCancelledLog(options: {
  taskId: ID;
  label: string;
  detail: string;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  stepId?: ID;
  agentKind?: AgentKind;
}): void {
  emitStructuredLog({
    getSnapshot: options.getSnapshot,
    emitSnapshot: options.emitSnapshot,
    emitEvent: options.emitEvent,
    event: {
      kind: "task.cancelled",
      taskId: options.taskId,
      label: options.label,
      detail: options.detail,
      stepId: options.stepId,
      agentKind: options.agentKind,
    },
  });
}
