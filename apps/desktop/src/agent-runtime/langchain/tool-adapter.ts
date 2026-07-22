import type {
  AgentEvent,
  AgentRunRequest,
  AgentToolSpec,
  ToolExecutionGateway,
} from "@javis/core";
import { tool } from "langchain/browser";
import type { ToolRuntime } from "@langchain/core/tools";

export interface LangChainToolAdapterOptions {
  specs: readonly AgentToolSpec[];
  gateway: ToolExecutionGateway;
  request: AgentRunRequest;
  agentKind: import("@javis/core").AgentKind;
  toolTimeoutMs: number;
  maxToolCalls: number;
  onEvent?(event: AgentEvent): void;
}

export function createLangChainTools(options: LangChainToolAdapterOptions) {
  let toolCallCount = 0;
  return options.specs.map((spec) => tool(
    async (input: unknown, runtime: ToolRuntime) => {
      toolCallCount += 1;
      if (toolCallCount > options.maxToolCalls) {
        throw new Error(`Agent exceeded the tool call limit (${options.maxToolCalls}).`);
      }
      if (!isRecord(input)) throw new Error(`Tool ${spec.modelName} input must be an object.`);
      const toolCallId = runtime.toolCallId;
      options.onEvent?.({
        type: "tool.started",
        toolCallId,
        toolName: spec.canonicalName,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(
        new DOMException(`Tool ${spec.canonicalName} timed out.`, "TimeoutError"),
      ), options.toolTimeoutMs);
      const abort = () => controller.abort(options.request.signal?.reason);
      options.request.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await waitForToolExecution(
          options.gateway.execute({
            taskId: options.request.taskId,
            runId: options.request.runId,
            agentKind: options.agentKind,
            toolName: spec.canonicalName,
            input,
            signal: controller.signal,
          }),
          controller.signal,
        );
        if (result.status === "error") throw new Error(result.reason ?? `Tool ${spec.canonicalName} failed.`);
        options.onEvent?.({
          type: "tool.completed",
          toolCallId,
          toolName: spec.canonicalName,
          output: result.output,
        });
        return serializeToolOutput(result.output);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.onEvent?.({
          type: "tool.failed",
          toolCallId,
          toolName: spec.canonicalName,
          reason,
        });
        throw error;
      } finally {
        clearTimeout(timeout);
        options.request.signal?.removeEventListener("abort", abort);
      }
    },
    {
      name: spec.modelName,
      description: spec.description,
      schema: spec.inputSchema as Record<string, unknown>,
    },
  ));
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return serialized ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForToolExecution<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
