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
  };

  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload {
    return {
      prompt: input.prompt,
      imageDataUrl: input.imageDataUrl,
      providerId: input.providerId || "openai",
      model: input.model,
      apiKeyReference: input.apiKeyReference,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      stopSequences: input.stopSequences,
      locale: input.locale,
      protocol: this.protocol,
    };
  }

  normalizeCompletionResponse(
    response: AdapterCompletionResponse,
  ): AdapterCompletionResponse {
    return response;
  }
}
