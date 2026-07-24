import type { AgentRunResult, AgentTokenUsage } from "./contracts";

type AgentEventIdentity = {
  callId?: string;
  stepId?: string;
  attempt?: number;
  runId?: string;
  workflowRunId?: string;
  agentRunId?: string;
  backendSessionId?: string;
};

export type AgentEvent =
  | ({ type: "run.started"; runId: string } & AgentEventIdentity)
  | ({ type: "run.completed"; result: AgentRunResult } & AgentEventIdentity)
  | ({ type: "run.failed"; reason: string } & AgentEventIdentity)
  | ({ type: "run.cancelled"; reason: string } & AgentEventIdentity)
  | ({ type: "model.started"; callIndex: number } & AgentEventIdentity)
  | ({ type: "model.delta"; delta: string } & AgentEventIdentity)
  | ({ type: "model.completed"; callIndex: number; finishReason: string } & AgentEventIdentity)
  | ({ type: "tool.requested"; toolCallId: string; toolName: string } & AgentEventIdentity)
  | ({ type: "tool.started"; toolCallId: string; toolName: string } & AgentEventIdentity)
  | ({ type: "tool.completed"; toolCallId: string; toolName: string; output: unknown } & AgentEventIdentity)
  | ({ type: "tool.failed"; toolCallId: string; toolName: string; reason: string } & AgentEventIdentity)
  | ({
      type: "context.requested";
      contextKeys: readonly string[];
      requestedAgentKind?: import("../index").AgentKind;
    } & AgentEventIdentity)
  | ({ type: "policy.blocked"; reason: string; permissionLevel?: "read" | "preview" | "confirmed_write" | "dangerous" } & AgentEventIdentity)
  | ({ type: "backend.diagnostic"; code: string; message: string; phase?: string } & AgentEventIdentity)
  | ({ type: "usage.updated"; usage: AgentTokenUsage; revision?: number; final?: boolean } & AgentEventIdentity);
