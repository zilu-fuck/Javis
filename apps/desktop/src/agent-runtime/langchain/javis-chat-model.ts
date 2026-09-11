import type {
  AgentChatRequest,
  AgentChatStreamEvent,
  AgentContentBlock,
  AgentEvent,
  AgentMessage,
  AgentModelGateway,
  AgentToolChoice,
  AgentToolSpec,
} from "@javis/core";
import { validateAgentRequestInput } from "@javis/core";
import { ModelChatEmptyResponseError } from "../agent-model-gateway";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ToolMessage,
} from "langchain/browser";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { ChatGenerationChunk } from "@langchain/core/outputs";

export interface JavisChatModelOptions {
  gateway: AgentModelGateway;
  model?: string;
  tools?: readonly AgentToolSpec[];
  toolChoice?: AgentToolChoice;
  responseSchema?: import("@javis/core").JsonSchema;
  parallelToolCalls?: boolean;
  temperature?: number;
  maxTokens?: number;
  modelTimeoutMs?: number;
  maxModelCalls?: number;
  liveAgentKinds?: readonly import("@javis/core").AgentKind[];
  onEvent?(event: AgentEvent): void;
}

export interface AgentRequestInputDetails {
  contextKeys: string[];
  requestedAgentKind?: import("@javis/core").AgentKind;
  reason?: string;
}

export class AgentRequestInputError extends Error {
  readonly details: AgentRequestInputDetails;

  constructor(
    input: unknown,
    liveAgentKinds?: readonly import("@javis/core").AgentKind[],
  ) {
    const details = normalizeRequestInput(input, liveAgentKinds);
    super(details.reason ?? "Agent requires additional upstream context.");
    this.name = "AgentRequestInputError";
    this.details = details;
  }
}

interface JavisChatModelState {
  modelCalls: number;
}

export class JavisChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  readonly gateway: AgentModelGateway;
  readonly model?: string;
  readonly toolSpecs: readonly AgentToolSpec[];
  readonly toolChoice?: AgentToolChoice;
  readonly responseSchema?: import("@javis/core").JsonSchema;
  readonly parallelToolCalls?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly modelTimeoutMs?: number;
  readonly maxModelCalls?: number;
  readonly liveAgentKinds?: readonly import("@javis/core").AgentKind[];
  readonly onEvent?: (event: AgentEvent) => void;
  private readonly state: JavisChatModelState;

  constructor(options: JavisChatModelOptions, state: JavisChatModelState = { modelCalls: 0 }) {
    super({});
    this.gateway = options.gateway;
    this.model = options.model;
    this.toolSpecs = options.tools ?? [];
    this.toolChoice = options.toolChoice;
    this.responseSchema = options.responseSchema;
    this.parallelToolCalls = options.parallelToolCalls;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.modelTimeoutMs = options.modelTimeoutMs;
    this.maxModelCalls = options.maxModelCalls;
    this.liveAgentKinds = options.liveAgentKinds;
    this.onEvent = options.onEvent;
    this.state = state;
  }

  _llmType(): string {
    return "javis";
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): JavisChatModel {
    const requestedNames = new Set(tools.map(readBoundToolName));
    const boundTools = this.toolSpecs.filter((tool) => requestedNames.has(tool.modelName));
    if (boundTools.length !== requestedNames.size) {
      const known = new Set(boundTools.map((tool) => tool.modelName));
      const unknown = [...requestedNames].filter((name) => !known.has(name));
      throw new Error(`LangChain attempted to bind unknown Javis tools: ${unknown.join(", ")}.`);
    }
    return new JavisChatModel({
      gateway: this.gateway,
      model: this.model,
      tools: boundTools,
      toolChoice: normalizeToolChoice(kwargs?.tool_choice) ?? this.toolChoice,
      responseSchema: readResponseSchema(kwargs) ?? this.responseSchema,
      parallelToolCalls: this.parallelToolCalls,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      modelTimeoutMs: this.modelTimeoutMs,
      maxModelCalls: this.maxModelCalls,
      liveAgentKinds: this.liveAgentKinds,
      onEvent: this.onEvent,
    }, this.state);
  }

  async _generate(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
  ): Promise<ChatResult> {
    const callIndex = this.beginModelCall();
    const request = this.createRequest(messages, options);
    const response = await this.completeWithEmptyResponseRetry(request);
    this.emitAssistantEvents(response.message.toolCalls ?? []);
    this.onEvent?.({
      type: "model.completed",
      callIndex,
      finishReason: response.finishReason,
    });
    if (response.usage) this.onEvent?.({ type: "usage.updated", usage: response.usage });
    const requestInput = response.message.toolCalls?.find((call) =>
      call.name === "javis__request_input"
    );
    if (requestInput) {
      throw new AgentRequestInputError(requestInput.arguments, this.liveAgentKinds);
    }
    const text = response.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const message = new AIMessage({
      content: text,
      tool_calls: response.message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        type: "tool_call" as const,
      })),
      response_metadata: { finish_reason: response.finishReason },
      ...(response.usage
        ? {
            usage_metadata: {
              input_tokens: response.usage.inputTokens,
              output_tokens: response.usage.outputTokens,
              total_tokens: response.usage.totalTokens
                ?? response.usage.inputTokens + response.usage.outputTokens,
            },
          }
        : {}),
    });
    return {
      generations: [{
        text,
        message,
        generationInfo: { finishReason: response.finishReason },
      }],
      llmOutput: response.usage ? { tokenUsage: response.usage } : undefined,
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
  ): AsyncGenerator<ChatGenerationChunk> {
    const callIndex = this.beginModelCall();
    const request = this.createRequest(messages, options);
    try {
      yield* this.iterateStreamEvents(this.gateway.stream(request), callIndex);
    } catch (error) {
      const empty = toEmptyResponseError(error);
      if (!empty) throw error;
      this.emitEmptyResponseDiagnostic(empty);
      this.beginModelCall();
      yield* this.iterateStreamEvents(this.gateway.stream(request), callIndex);
    }
  }

  private async *iterateStreamEvents(
    stream: AsyncIterable<AgentChatStreamEvent>,
    callIndex: number,
  ): AsyncGenerator<ChatGenerationChunk> {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        this.onEvent?.({ type: "model.delta", delta: event.delta });
      } else if (event.type === "reasoning_delta") {
        this.onEvent?.({ type: "model.reasoning_delta", delta: event.delta });
      } else if (event.type === "tool_call_start") {
        this.emitAssistantEvents([{ id: event.id, name: event.name }]);
      } else if (event.type === "usage") {
        this.onEvent?.({ type: "usage.updated", usage: event.usage });
      } else if (event.type === "message_end") {
        this.onEvent?.({
          type: "model.completed",
          callIndex,
          finishReason: event.finishReason,
        });
      }
      const chunk = streamEventToGenerationChunk(event);
      if (chunk) yield chunk;
    }
  }

  /**
   * Controlled single retry for an empty provider response (dual-kernel
   * plan §13.2). The first call's usage and a sanitized response-shape
   * diagnostic are emitted before the retry, which starts a fresh model
   * call with a new call id so both calls meter and dedupe separately.
   */
  private async completeWithEmptyResponseRetry(
    request: AgentChatRequest,
  ): Promise<import("@javis/core").AgentChatResponse> {
    try {
      return await this.gateway.complete(request);
    } catch (error) {
      const empty = toEmptyResponseError(error);
      if (!empty) throw error;
      this.emitEmptyResponseDiagnostic(empty);
      if (empty.usage) {
        this.onEvent?.({ type: "usage.updated", usage: empty.usage, final: true });
      }
      this.beginModelCall();
      try {
        return await this.gateway.complete(request);
      } catch (retryError) {
        const retryEmpty = toEmptyResponseError(retryError);
        if (retryEmpty) {
          this.emitEmptyResponseDiagnostic(retryEmpty);
          if (retryEmpty.usage) {
            this.onEvent?.({ type: "usage.updated", usage: retryEmpty.usage, final: true });
          }
        }
        throw retryError;
      }
    }
  }

  private emitEmptyResponseDiagnostic(error: ModelChatEmptyResponseError): void {
    this.onEvent?.({
      type: "backend.diagnostic",
      code: "model_chat_empty_response",
      message: error.message,
      phase: "model",
    });
  }

  private createRequest(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
  ): AgentChatRequest {
    return {
      messages: toAgentMessages(messages),
      tools: this.toolSpecs,
      toolChoice: normalizeToolChoice(options.tool_choice) ?? this.toolChoice,
      responseSchema: this.responseSchema,
      parallelToolCalls: this.parallelToolCalls,
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      timeoutMs: this.modelTimeoutMs,
      signal: options.signal,
    };
  }

  private beginModelCall(): number {
    this.state.modelCalls += 1;
    if (this.maxModelCalls !== undefined && this.state.modelCalls > this.maxModelCalls) {
      throw new Error(`Agent exceeded the model call limit (${this.maxModelCalls}).`);
    }
    this.onEvent?.({ type: "model.started", callIndex: this.state.modelCalls });
    return this.state.modelCalls;
  }

  private emitAssistantEvents(
    toolCalls: readonly { id: string; name: string }[],
  ): void {
    for (const call of toolCalls) {
      const spec = this.toolSpecs.find((tool) => tool.modelName === call.name);
      if (!spec) throw new Error(`Model returned unknown tool alias: ${call.name}.`);
      this.onEvent?.({
        type: "tool.requested",
        toolCallId: call.id,
        toolName: spec.canonicalName,
      });
    }
  }
}

function normalizeRequestInput(
  input: unknown,
  liveAgentKinds?: readonly import("@javis/core").AgentKind[],
): AgentRequestInputDetails {
  if (!isRecord(input) || !Array.isArray(input.contextKeys)) {
    throw new Error("javis__request_input requires contextKeys.");
  }
  const validation = validateAgentRequestInput(
    input.contextKeys,
    input.requestedAgentKind,
    liveAgentKinds,
  );
  if (!validation.valid) throw new Error(validation.reason);
  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim().slice(0, 500)
    : undefined;
  return {
    contextKeys: validation.requestedContextKeys,
    requestedAgentKind: validation.requestedAgentKind,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamEventToGenerationChunk(
  event: AgentChatStreamEvent,
): ChatGenerationChunk | undefined {
  let message: AIMessageChunk | undefined;
  let generationInfo: Record<string, unknown> | undefined;
  switch (event.type) {
    case "text_delta":
      message = new AIMessageChunk({ content: event.delta });
      break;
    case "tool_call_start":
      message = new AIMessageChunk({
        content: "",
        tool_call_chunks: [{
          index: event.index,
          id: event.id,
          name: event.name,
          args: "",
          type: "tool_call_chunk",
        }],
      });
      break;
    case "tool_call_arguments_delta":
      message = new AIMessageChunk({
        content: "",
        tool_call_chunks: [{
          index: event.index,
          args: event.delta,
          type: "tool_call_chunk",
        }],
      });
      break;
    case "usage":
      message = new AIMessageChunk({
        content: "",
        usage_metadata: {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens
            ?? event.usage.inputTokens + event.usage.outputTokens,
        },
      });
      break;
    case "message_end":
      message = new AIMessageChunk({
        content: "",
        response_metadata: { finish_reason: event.finishReason },
      });
      generationInfo = { finishReason: event.finishReason };
      break;
    case "message_start":
    case "reasoning_delta":
    case "tool_call_end":
      return undefined;
  }
  return new ChatGenerationChunk({
    text: event.type === "text_delta" ? event.delta : "",
    message,
    generationInfo,
  });
}

export function toAgentMessages(messages: readonly BaseMessage[]): AgentMessage[] {
  const toolNamesByCallId = new Map<string, string>();
  return messages.map((message): AgentMessage => {
    if (AIMessage.isInstance(message)) {
      const toolCalls = message.tool_calls?.map((call) => {
        if (!call.id) throw new Error(`Assistant tool call ${call.name} is missing an id.`);
        toolNamesByCallId.set(call.id, call.name);
        return { id: call.id, name: call.name, arguments: call.args };
      });
      return {
        role: "assistant",
        content: toAgentContent(message.content),
        ...(toolCalls?.length ? { toolCalls } : {}),
      };
    }
    if (ToolMessage.isInstance(message)) {
      const name = message.name ?? toolNamesByCallId.get(message.tool_call_id);
      if (!name) throw new Error(`Tool message ${message.tool_call_id} is missing its tool name.`);
      return {
        role: "tool",
        toolCallId: message.tool_call_id,
        name,
        content: toAgentContent(message.content),
        status: message.status ?? "success",
      };
    }
    if (message.type === "system") {
      return { role: "system", content: toAgentContent(message.content) };
    }
    if (message.type === "human") {
      return { role: "user", content: toAgentContent(message.content) };
    }
    throw new Error(`Unsupported LangChain message type: ${message.type}.`);
  });
}

function toAgentContent(content: BaseMessage["content"]): AgentContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((block): AgentContentBlock[] => {
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "image_url") {
      const imageUrl = "image_url" in block ? block.image_url : undefined;
      const url = typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object" && "url" in imageUrl
          ? imageUrl.url
          : undefined;
      if (typeof url === "string") return [{ type: "image", url }];
    }
    throw new Error(`Unsupported LangChain content block: ${block.type}.`);
  });
}

function readBoundToolName(tool: BindToolsInput): string {
  if ("name" in tool && typeof tool.name === "string") return tool.name;
  if (
    "function" in tool &&
    typeof tool.function === "object" &&
    tool.function !== null &&
    "name" in tool.function &&
    typeof tool.function.name === "string"
  ) {
    return tool.function.name;
  }
  throw new Error("LangChain supplied a tool without a stable name.");
}

function normalizeToolChoice(choice: BaseChatModelCallOptions["tool_choice"]): AgentToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none") return choice;
  if (choice === "any") return "required";
  if (typeof choice === "string") return { name: choice };
  const functionName = "function" in choice && typeof choice.function === "object" &&
    choice.function !== null && "name" in choice.function
    ? choice.function.name
    : undefined;
  return typeof functionName === "string" ? { name: functionName } : undefined;
}

function readResponseSchema(
  options: BaseChatModelCallOptions | undefined,
): import("@javis/core").JsonSchema | undefined {
  if (!options) return undefined;
  const responseFormat = (options as BaseChatModelCallOptions & {
    response_format?: unknown;
  }).response_format;
  if (!isRecord(responseFormat) || !isRecord(responseFormat.json_schema)) return undefined;
  const schema = responseFormat.json_schema.schema;
  return isRecord(schema) ? schema : undefined;
}

function toEmptyResponseError(error: unknown): ModelChatEmptyResponseError | undefined {
  return error instanceof ModelChatEmptyResponseError ? error : undefined;
}
