import type {
  AgentEvent,
  AgentMessage,
  AgentRunHandle,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntime,
  AgentTokenUsage,
  AgentToolSpec,
  AgentDefinition,
  AgentModelGateway,
  ToolExecutionGateway,
} from "@javis/core";
import { addAgentTokenUsage, normalizeStepResult } from "@javis/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  createAgent,
  providerStrategy,
  tool,
  toolStrategy,
} from "langchain/browser";
import type { BaseMessage } from "@langchain/core/messages";
import { AgentRequestInputError, JavisChatModel } from "./javis-chat-model";
import { createLangChainTools } from "./tool-adapter";

const REQUEST_INPUT_TOOL_SPEC: AgentToolSpec = {
  canonicalName: "javis.requestInput",
  modelName: "javis__request_input",
  description: "Stop this run and request missing upstream context before continuing.",
  inputSchema: {
    type: "object",
    properties: {
      contextKeys: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      requestedAgentKind: { type: "string" },
      reason: { type: "string" },
    },
    required: ["contextKeys"],
    additionalProperties: false,
  },
};

type LangChainJsonSchema = Readonly<Record<string, unknown>> & {
  type: "null" | "boolean" | "object" | "array" | "number" | "string" | "integer";
};

export interface LangChainAgentRuntimeOptions {
  modelGateway: AgentModelGateway;
  toolGateway: ToolExecutionGateway;
  toolSpecs: readonly AgentToolSpec[];
}

export function createLangChainAgentRuntime(
  options: LangChainAgentRuntimeOptions,
): AgentRuntime {
  return {
    run(definition, request) {
      return runLangChainAgent(options, definition, request);
    },
  };
}

function runLangChainAgent(
  options: LangChainAgentRuntimeOptions,
  definition: AgentDefinition,
  request: AgentRunRequest,
): AgentRunHandle {
  const queue = new AgentEventQueue();
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (request.signal?.aborted) controller.abort(request.signal.reason);
  const runtimeRequest: AgentRunRequest = { ...request, signal: controller.signal };

  let usage: AgentTokenUsage | undefined;
  let modelCalls = 0;
  let toolCalls = 0;
  let activeModelCall = 0;
  const startedAt = Date.now();
  const onEvent = (event: AgentEvent) => {
    if (event.type === "model.started") activeModelCall = event.callIndex;
    if (event.type === "usage.updated") usage = addAgentTokenUsage(usage, event.usage);
    if (event.type === "model.started") modelCalls += 1;
    if (event.type === "tool.started") toolCalls += 1;
    const callId = event.type === "tool.requested" || event.type === "tool.started" ||
        event.type === "tool.completed" || event.type === "tool.failed"
      ? event.toolCallId
      : event.type === "model.started" || event.type === "model.completed"
        ? request.stepId ? `${request.stepId}:model:${event.callIndex}` : undefined
        : event.type === "usage.updated" && activeModelCall > 0 && request.stepId
          ? `${request.stepId}:model:${activeModelCall}`
          : undefined;
    if (request.stepId && request.attempt !== undefined) {
      queue.push({
        ...event,
        runId: request.runId,
        ...(request.workflowRunId ? { workflowRunId: request.workflowRunId } : {}),
        ...(request.agentRunId ? { agentRunId: request.agentRunId } : {}),
        stepId: request.stepId,
        attempt: request.attempt,
        ...(callId ? { callId } : {}),
      } as AgentEvent);
      return;
    }
    queue.push(event);
  };

  const result = executeLangChainAgent(
    options,
    definition,
    runtimeRequest,
    onEvent,
    () => usage,
  ).then((runResult) => {
    const resultWithMetrics: AgentRunResult = {
      ...runResult,
      metrics: {
        backend: "langchain" as const,
        status: runResult.status,
        durationMs: Date.now() - startedAt,
        modelCalls,
        toolCalls,
        ...(usage ? { usage } : {}),
      },
      ...(request.stepId
        ? { termination: runResult.status === "cancelled" ? "cancelled" as const : "returned" as const }
        : {}),
    };
    if (resultWithMetrics.status === "completed" || resultWithMetrics.status === "request_input") {
      onEvent({ type: "run.completed", result: resultWithMetrics });
    }
    return resultWithMetrics;
  }).finally(() => {
    request.signal?.removeEventListener("abort", abortFromRequest);
    queue.close();
  });

  return {
    events: queue.iterate(),
    result,
    cancel() {
      controller.abort(new DOMException("Cancelled", "AbortError"));
    },
  };
}

async function executeLangChainAgent(
  options: LangChainAgentRuntimeOptions,
  definition: AgentDefinition,
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
  getUsage: () => AgentTokenUsage | undefined,
): Promise<AgentRunResult> {
  onEvent({ type: "run.started", runId: request.runId });
  try {
    const allowedNames = new Set(definition.allowedToolNames);
    const toolSpecs = options.toolSpecs.filter((tool) => allowedNames.has(tool.canonicalName));
    const missingTools = [...allowedNames].filter((name) =>
      !toolSpecs.some((tool) => tool.canonicalName === name));
    if (missingTools.length > 0) {
      throw new Error(`Agent runtime is missing tool specs: ${missingTools.join(", ")}.`);
    }
    const responseFormat = createResponseFormat(definition, options.modelGateway);
    const structuredToolSpecs = responseFormat?.kind === "tool"
      ? responseFormat.strategies.map((strategy): AgentToolSpec => ({
          canonicalName: `javis.structuredOutput.${strategy.name}`,
          modelName: strategy.name,
          description: strategy.tool.function.description ?? "Return the structured Agent result.",
          inputSchema: strategy.schema,
        }))
      : [];
    const model = new JavisChatModel({
      gateway: options.modelGateway,
      tools: [...toolSpecs, REQUEST_INPUT_TOOL_SPEC, ...structuredToolSpecs],
      modelTimeoutMs: definition.limits.modelTimeoutMs,
      maxModelCalls: definition.limits.maxModelCalls,
      liveAgentKinds: definition.liveAgentKinds,
      parallelToolCalls: false,
      onEvent,
    });
    const tools = createLangChainTools({
      specs: toolSpecs,
      gateway: options.toolGateway,
      request,
      agentKind: definition.kind,
      toolTimeoutMs: definition.limits.toolTimeoutMs,
      maxToolCalls: definition.limits.maxToolCalls,
      onEvent,
    });
    const requestInputTool = createRequestInputTool(definition.liveAgentKinds);
    const agent = createAgent({
      model,
      tools: [...tools, requestInputTool] as const,
      systemPrompt: [
        definition.instructions,
        "If required upstream context is missing, call javis__request_input instead of guessing.",
      ].join("\n\n"),
      ...(responseFormat
        ? { responseFormat: responseFormat.value }
        : {}),
    });
    const agentInput = { messages: toLangChainMessages(request.messages) };
    const agentConfig = {
      signal: request.signal,
      recursionLimit: definition.limits.maxModelCalls + definition.limits.maxToolCalls + 2,
      configurable: {
        thread_id: request.threadId ?? request.taskId,
        run_id: request.runId,
      },
    };
    type AgentState = Awaited<ReturnType<typeof agent.invoke>>;
    let state: AgentState | undefined;
    if (options.modelGateway.capabilities().streamingToolCalls) {
      const stream = await agent.stream(agentInput, {
        ...agentConfig,
        streamMode: ["messages", "values"],
      });
      for await (const chunk of stream) {
        if (Array.isArray(chunk) && chunk[0] === "values") {
          state = chunk[1] as AgentState;
        }
      }
      if (!state) throw new Error("LangChain Agent stream ended without final state.");
    } else {
      state = await agent.invoke(agentInput, agentConfig);
    }
    const finalMessage = [...state.messages].reverse().find(AIMessage.isInstance);
    if (!finalMessage || finalMessage.tool_calls?.length) {
      throw new Error("LangChain Agent ended without a final assistant message.");
    }
    const finalOutput = "structuredResponse" in state
      ? state.structuredResponse
      : finalMessage.text;
    const completed: AgentRunResult = {
      status: "completed",
      output: finalOutput,
      stepResult: normalizeStepResult({
        status: "completed",
        output: finalOutput,
        evidence: request.stepId
          ? [{ kind: "log", label: "LangChain final response", reference: request.stepId }]
          : [],
        assumptions: [],
        unresolvedQuestions: [],
      }),
      usage: getUsage(),
    };
    return completed;
  } catch (error) {
    if (error instanceof AgentRequestInputError) {
      const requested: AgentRunResult = {
        status: "request_input",
        reason: error.message,
        requestedContextKeys: error.details.contextKeys,
        requestedAgentKind: error.details.requestedAgentKind,
        stepResult: normalizeStepResult({
          status: "needs_clarification",
          evidence: [],
          assumptions: [],
          unresolvedQuestions: [error.message],
          requestedContextKeys: error.details.contextKeys,
          ...(error.details.requestedAgentKind
            ? { requestedAgentKind: error.details.requestedAgentKind }
            : {}),
        }),
        usage: getUsage(),
      };
      onEvent({
        type: "context.requested",
        contextKeys: error.details.contextKeys,
        requestedAgentKind: error.details.requestedAgentKind,
      });
      return requested;
    }
    const cancelled = request.signal?.aborted ||
      error instanceof DOMException && error.name === "AbortError";
    const reason = cancelled
      ? "Agent run was cancelled."
      : error instanceof Error ? error.message : String(error);
    const result: AgentRunResult = {
      status: cancelled ? "cancelled" : "failed",
      reason,
      ...(cancelled
        ? {}
        : {
            stepResult: normalizeStepResult({
              status: "failed",
              evidence: [],
              assumptions: [],
              unresolvedQuestions: [],
              error: reason,
              errorDetail: {
                code: "langchain_runtime_failed",
                message: reason,
                phase: "runtime",
                retryable: false,
              },
            }),
          }),
      usage: getUsage(),
    };
    onEvent({ type: "run.failed", reason });
    return result;
  }
}

function createRequestInputTool(
  liveAgentKinds?: readonly import("@javis/core").AgentKind[],
) {
  return tool(
    async (input: unknown) => {
      throw new AgentRequestInputError(input, liveAgentKinds);
    },
    {
      name: REQUEST_INPUT_TOOL_SPEC.modelName,
      description: REQUEST_INPUT_TOOL_SPEC.description,
      schema: REQUEST_INPUT_TOOL_SPEC.inputSchema as Record<string, unknown>,
    },
  );
}

function createResponseFormat(
  definition: AgentDefinition,
  gateway: AgentModelGateway,
) {
  if (!definition.outputSchema) return undefined;
  const schema = {
    type: "object",
    ...definition.outputSchema,
    title: "javis__structured_output",
  } as unknown as LangChainJsonSchema;
  if (gateway.capabilities().structuredOutput) {
    const strategy = providerStrategy(schema);
    return { kind: "provider" as const, value: strategy };
  }
  const strategies = toolStrategy(schema, { handleError: false });
  return { kind: "tool" as const, value: strategies, strategies };
}

function toLangChainMessages(messages: readonly AgentMessage[]): BaseMessage[] {
  return messages.map((message): BaseMessage => {
    const content = message.content.map((block) => block.type === "text"
      ? { type: "text" as const, text: block.text }
      : { type: "image_url" as const, image_url: { url: block.url } });
    switch (message.role) {
      case "system":
        return new SystemMessage({ content });
      case "user":
        return new HumanMessage({ content });
      case "assistant":
        return new AIMessage({
          content,
          tool_calls: message.toolCalls?.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.arguments,
            type: "tool_call" as const,
          })),
        });
      case "tool":
        return new ToolMessage({
          content,
          tool_call_id: message.toolCallId,
          name: message.name,
          status: message.status,
        });
    }
  });
}

class AgentEventQueue {
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    while (!this.closed || this.buffer.length > 0) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }
}
