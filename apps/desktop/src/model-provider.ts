import type { ModelSettings } from "./model-settings";
import { localeDefaultModelSettings } from "./model-settings";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { injectTerminologyPrompt } from "@javis/core";

export interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  locale?: string;
}

export interface StreamOptions extends CompletionOptions {
  onChunk?: (chunk: CompletionChunk) => void;
}

export interface CompletionResult {
  text: string;
  model?: string;
  provider?: string;
}

export interface CompletionChunk {
  text: string;
  model?: string;
  provider?: string;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export interface ModelProvider {
  id: string;
  settings: ModelProviderSettings;
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  stream(
    prompt: string,
    options?: StreamOptions,
  ): AsyncIterable<CompletionChunk>;
  defaultSettingsForLocale: typeof localeDefaultModelSettings;
}

export interface ModelProviderSettings {
  provider: string;
  model: string;
  apiKeyReference: string;
  baseUrl: string;
}

export function createConfiguredModelProvider(settings: ModelSettings): ModelProvider {
  const providerSettings = toModelProviderSettings(settings);
  return {
    id: providerSettings.provider,
    settings: providerSettings,
    defaultSettingsForLocale: localeDefaultModelSettings,
    async complete(prompt, options) {
      try {
        return await invoke<CompletionResult>("complete_model_prompt", {
          request: createModelRequest(prompt, providerSettings, options),
        });
      } catch (error) {
        throw normalizeModelProviderError(error, providerSettings.provider);
      }
    },
    stream(prompt, options) {
      return streamModelPrompt(prompt, providerSettings, options);
    },
  };
}

export function toModelProviderSettings(settings: ModelSettings): ModelProviderSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    apiKeyReference: settings.apiKeyReference,
    baseUrl: settings.baseUrl,
  };
}

interface StreamChunkPayload {
  stream_id: string;
  text: string;
  model?: string;
  provider?: string;
  index: number;
}

interface StreamDonePayload {
  stream_id: string;
  finish_reason?: string;
  total_chunks: number;
}

interface StreamErrorPayload {
  stream_id: string;
  error: string;
}

async function* streamModelPrompt(
  prompt: string,
  providerSettings: ModelProviderSettings,
  options?: StreamOptions,
): AsyncGenerator<CompletionChunk> {
  let streamId: string;
  try {
    streamId = await invoke<string>("stream_model_prompt_start", {
      request: createModelRequest(prompt, providerSettings, options),
    });
  } catch (error) {
    throw normalizeModelProviderError(error, providerSettings.provider);
  }

  const buffer: CompletionChunk[] = [];
  let pendingResolve:
    | ((value: IteratorResult<CompletionChunk>) => void)
    | null = null;
  let streamError: Error | null = null;
  let finished = false;

  function push(chunk: CompletionChunk) {
    if (pendingResolve) {
      pendingResolve({ value: chunk, done: false });
      pendingResolve = null;
    } else {
      buffer.push(chunk);
    }
  }

  function finish(error?: Error) {
    finished = true;
    if (error) streamError = error;
    if (pendingResolve) {
      pendingResolve({ value: undefined as unknown as CompletionChunk, done: true });
      pendingResolve = null;
    }
  }

  const unlisteners: UnlistenFn[] = [];

  try {
    const unlistenChunk = await listen<StreamChunkPayload>(
      "stream-model-chunk",
      (event) => {
        if (event.payload.stream_id !== streamId) return;
        const chunk: CompletionChunk = {
          text: event.payload.text,
          model: event.payload.model,
          provider: event.payload.provider,
        };
        options?.onChunk?.(chunk);
        push(chunk);
      },
    );
    unlisteners.push(unlistenChunk);

    const unlistenDone = await listen<StreamDonePayload>(
      "stream-model-done",
      (event) => {
        if (event.payload.stream_id !== streamId) return;
        finish();
      },
    );
    unlisteners.push(unlistenDone);

    const unlistenError = await listen<StreamErrorPayload>(
      "stream-model-error",
      (event) => {
        if (event.payload.stream_id !== streamId) return;
        finish(new Error(event.payload.error));
      },
    );
    unlisteners.push(unlistenError);

    while (!finished) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
      } else {
        await new Promise<IteratorResult<CompletionChunk>>((resolve) => {
          pendingResolve = resolve;
        }).then((result) => {
          if (!result.done) buffer.push(result.value);
        });
      }
    }

    // Drain remaining buffered chunks
    while (buffer.length > 0) {
      yield buffer.shift()!;
    }

    if (streamError) throw streamError;
  } finally {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  }
}

function createModelRequest(
  prompt: string,
  providerSettings: ModelProviderSettings,
  options?: CompletionOptions,
) {
  return {
    prompt: injectTerminologyPrompt(prompt, options?.locale),
    providerId: options?.locale
      ? localeDefaultModelSettings(options.locale).provider
      : providerSettings.provider,
    model: options?.model ?? providerSettings.model,
    apiKeyReference: providerSettings.apiKeyReference,
    baseUrl: providerSettings.baseUrl,
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    stopSequences: options?.stopSequences,
    locale: options?.locale,
  };
}

function normalizeModelProviderError(error: unknown, provider: string): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Model provider request failed.";
  return new ModelProviderError(message, provider, error);
}
