import type { ModelSettings } from "./model-settings";
import { localeDefaultModelSettings } from "./model-settings";
import { invoke } from "@tauri-apps/api/core";

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

async function* streamModelPrompt(
  prompt: string,
  providerSettings: ModelProviderSettings,
  options?: StreamOptions,
): AsyncIterable<CompletionChunk> {
  let chunks: CompletionChunk[];
  try {
    chunks = await invoke<CompletionChunk[]>("stream_model_prompt", {
      request: createModelRequest(prompt, providerSettings, options),
    });
  } catch (error) {
    throw normalizeModelProviderError(error, providerSettings.provider);
  }

  for (const chunk of chunks) {
    if (!chunk.text) {
      continue;
    }
    options?.onChunk?.(chunk);
    yield chunk;
  }
}

function createModelRequest(
  prompt: string,
  providerSettings: ModelProviderSettings,
  options?: CompletionOptions,
) {
  return {
    prompt,
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
