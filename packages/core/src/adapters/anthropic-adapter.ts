/**
 * Anthropic 适配器
 *
 * Anthropic Messages API 协议。
 * protocol: anthropic
 *
 * 与 OpenAI 兼容协议的差异：
 * - 认证：x-api-key 头（非 Bearer）
 * - 端点：/v1/messages（非 /chat/completions）
 * - 消息格式：content 数组（非单个 content 字符串）
 * - system 通过 body.system 传递（非 message role）
 */

import type {
  AdapterCompletionInput,
  AdapterCompletionResponse,
  AdapterRequestPayload,
  ProviderAdapter,
  ProviderCapabilities,
} from "../provider-adapter";

export class AnthropicAdapter implements ProviderAdapter {
  readonly adapterId: string;
  readonly protocol = "anthropic" as const;
  readonly capabilities: ProviderCapabilities = {
    vision: true,
    code: true,
    longContext: true,
  };

  constructor(adapterId = "anthropic") {
    this.adapterId = adapterId;
  }

  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload {
    return {
      prompt: input.prompt,
      imageDataUrl: input.imageDataUrl,
      providerId: input.providerId || this.adapterId,
      model: input.model,
      apiKeyReference: input.apiKeyReference,
      baseUrl: normalizeAnthropicBaseUrl(input.baseUrl),
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

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  if (!baseUrl) return baseUrl;
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed === "https://api.deepseek.com") return `${trimmed}/anthropic`;
  if (trimmed === "https://api.deepseek.com/anthropic") return trimmed;
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}
