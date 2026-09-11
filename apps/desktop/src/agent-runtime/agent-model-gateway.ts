import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getAdapter,
  type AgentChatRequest,
  type AgentChatResponse,
  type AgentChatStreamEvent,
  type AgentModelCapabilities,
  type AgentModelGateway,
  type AgentTokenUsage,
} from "@javis/core";
import type { ModelProviderSettings } from "../model-provider";

interface NativeModelChatRequest extends Omit<AgentChatRequest, "signal" | "responseSchema"> {
  responseFormat?: { jsonSchema: AgentChatRequest["responseSchema"] };
  providerId: string;
  apiKeyReference: string;
  baseUrl: string;
  protocol: "openai-compatible" | "anthropic";
  parallelToolCalls?: boolean;
}

export function createAgentModelGateway(
  settings: ModelProviderSettings,
): AgentModelGateway {
  const adapter = getAdapter(settings.provider);
  const capabilities: AgentModelCapabilities = {
    nativeToolCalling: adapter.capabilities.nativeToolCalling !== false,
    streamingToolCalls: adapter.capabilities.streamingToolCalls !== false,
    structuredOutput: adapter.capabilities.structuredOutput === true,
    parallelToolCalls: adapter.capabilities.parallelToolCalls === true,
  };

  return {
    capabilities: () => capabilities,
    async complete(request) {
      assertNativeToolCalling(capabilities, settings.provider);
      const completion = invoke<AgentChatResponse>("complete_model_chat", {
        request: createNativeRequest(request, settings, adapter.protocol, capabilities),
      }).catch((error) => {
        throw normalizeNativeModelError(error);
      });
      return waitForCompletion(completion, request.signal);
    },
    stream(request): AsyncIterable<AgentChatStreamEvent> {
      assertNativeToolCalling(capabilities, settings.provider);
      if (!capabilities.streamingToolCalls) {
        throw new Error(`Native streaming tool calls are unavailable for provider ${settings.provider}.`);
      }
      return streamModelChat(
        createNativeRequest(request, settings, adapter.protocol, capabilities),
        request.signal,
      );
    },
  };
}

interface NativeModelChatStreamPayload {
  streamId?: string;
  stream_id?: string;
  event: AgentChatStreamEvent;
}

interface NativeModelChatStreamErrorPayload {
  streamId?: string;
  stream_id?: string;
  error: string;
}

/**
 * Structured empty-response failure from the native chat boundary
 * (dual-kernel plan §13.2). Carries a sanitized response shape and the
 * usage of the failed call so the caller can retain failed-call tokens.
 */
export class ModelChatEmptyResponseError extends Error {
  readonly responseShape: Record<string, unknown>;
  readonly finishReason?: string;
  readonly usage?: AgentTokenUsage;

  constructor(shape: Record<string, unknown>, finishReason?: string, usage?: AgentTokenUsage) {
    super(`Model chat returned an empty response (shape ${safeShapeSummary(shape)}).`);
    this.name = "ModelChatEmptyResponseError";
    this.responseShape = shape;
    this.finishReason = finishReason;
    this.usage = usage;
  }
}

const EMPTY_RESPONSE_ERROR_PREFIX = "__JAVIS_EMPTY_RESPONSE__";

export function parseModelChatError(message: string): unknown {
  if (!message.startsWith(EMPTY_RESPONSE_ERROR_PREFIX)) return new Error(message);
  try {
    const payload = JSON.parse(message.slice(EMPTY_RESPONSE_ERROR_PREFIX.length)) as {
      code?: string;
      responseShape?: Record<string, unknown>;
      finishReason?: string | null;
      usage?: AgentTokenUsage;
    };
    if (payload.code !== "model_chat_empty_response") return new Error(message);
    return new ModelChatEmptyResponseError(
      payload.responseShape ?? {},
      payload.finishReason ?? undefined,
      payload.usage,
    );
  } catch {
    return new Error(message);
  }
}

function safeShapeSummary(shape: Record<string, unknown>): string {
  return [
    typeof shape.contentType === "string" ? `content:${shape.contentType}` : "content:?",
    typeof shape.toolCallsCount === "number" ? `toolCalls:${shape.toolCallsCount}` : "toolCalls:?",
    typeof shape.hasUsage === "boolean" ? `usage:${shape.hasUsage ? "reported" : "missing"}` : "usage:?",
  ].join(" ");
}

async function* streamModelChat(
  request: NativeModelChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<AgentChatStreamEvent> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const streamId = `chat-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const buffer: AgentChatStreamEvent[] = [];
  const unlisteners: UnlistenFn[] = [];
  let pendingResolve: (() => void) | undefined;
  let streamError: unknown;
  let finished = false;
  let nativeStarted = false;
  let aborted = false;

  const wake = () => {
    pendingResolve?.();
    pendingResolve = undefined;
  };
  const onAbort = () => {
    aborted = true;
    streamError = signal?.reason ?? new DOMException("Aborted", "AbortError");
    finished = true;
    if (nativeStarted) {
      void invoke("stream_model_chat_cancel", { streamId }).catch(() => undefined);
    }
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    unlisteners.push(await listen<NativeModelChatStreamPayload>(
      "stream-model-chat-event",
      (payload) => {
        if (readStreamId(payload.payload) !== streamId) return;
        buffer.push(payload.payload.event);
        if (payload.payload.event.type === "message_end") finished = true;
        wake();
      },
    ));
    unlisteners.push(await listen<NativeModelChatStreamErrorPayload>(
      "stream-model-chat-error",
      (payload) => {
        if (readStreamId(payload.payload) !== streamId) return;
        streamError = normalizeNativeModelError(payload.payload.error);
        finished = true;
        wake();
      },
    ));
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await invoke("stream_model_chat_start", { request, streamId });
    nativeStarted = true;
    if (signal?.aborted) {
      aborted = true;
      try {
        await invoke("stream_model_chat_cancel", { streamId });
      } catch {
        // The native stream may have completed while the abort was delivered.
      }
    }

    while (!finished || buffer.length > 0) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }
    }
    if (streamError) throw streamError;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (nativeStarted && (!finished || aborted)) {
      try {
        await invoke("stream_model_chat_cancel", { streamId });
      } catch {
        // The native stream may have completed while the consumer stopped iterating.
      }
    }
    for (const unlisten of unlisteners) unlisten();
  }
}

function readStreamId(payload: { streamId?: string; stream_id?: string }): string | undefined {
  return payload.streamId ?? payload.stream_id;
}

function createNativeRequest(
  request: AgentChatRequest,
  settings: ModelProviderSettings,
  protocol: "openai-compatible" | "anthropic",
  capabilities: AgentModelCapabilities,
): NativeModelChatRequest {
  return {
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    ...(request.responseSchema
      ? { responseFormat: { jsonSchema: request.responseSchema } }
      : {}),
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    timeoutMs: request.timeoutMs,
    model: request.model ?? settings.model,
    providerId: settings.provider,
    apiKeyReference: settings.apiKeyReference,
    baseUrl: settings.baseUrl,
    protocol,
    ...(request.parallelToolCalls !== undefined
      ? { parallelToolCalls: request.parallelToolCalls }
      : capabilities.parallelToolCalls ? { parallelToolCalls: true } : {}),
  };
}

function assertNativeToolCalling(
  capabilities: AgentModelCapabilities,
  provider: string,
): void {
  if (!capabilities.nativeToolCalling) {
    throw new Error(`Provider ${provider} explicitly disables native tool calling.`);
  }
}

function normalizeNativeModelError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return parseModelChatError(message);
}

function waitForCompletion<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
