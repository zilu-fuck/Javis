/**
 * OpenAI 兼容适配器
 *
 * 基线实现，适用于 OpenAI 及所有 OpenAI 兼容端点（智谱、豆包、通义千问等）。
 * protocol: openai-compatible
 */

import type {
  AdapterCompletionInput,
  AdapterCompletionResponse,
  AdapterRequestPayload,
  ProviderAdapter,
  ProviderCapabilities,
} from "../provider-adapter";
import { normalizeBaseUrl } from "./adapter-utils";

export class OpenAIAdapter implements ProviderAdapter {
  readonly adapterId = "openai";
  readonly protocol = "openai-compatible" as const;
  readonly capabilities: ProviderCapabilities = {
    vision: true,
    code: true,
    longContext: true,
    nativeToolCalling: true,
    streamingToolCalls: true,
    structuredOutput: true,
    parallelToolCalls: true,
  };

  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload {
    return {
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      assistantPrefill: input.assistantPrefill,
      imageDataUrl: input.imageDataUrl,
      images: input.images,
      media: input.media,
      enableMediaUuid: input.enableMediaUuid,
      disableThinking: input.disableThinking,
      providerId: input.providerId || "openai",
      model: input.model,
      apiKeyReference: input.apiKeyReference,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      stopSequences: input.stopSequences,
      locale: input.locale,
      timeoutMs: input.timeoutMs,
      protocol: this.protocol,
    };
  }

  normalizeCompletionResponse(
    response: AdapterCompletionResponse,
  ): AdapterCompletionResponse {
    return response;
  }
}
