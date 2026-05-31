/**
 * DeepSeek 适配器
 *
 * OpenAI 兼容协议，默认 baseUrl 指向 DeepSeek API。
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

const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekAdapter implements ProviderAdapter {
  readonly adapterId = "deepseek";
  readonly protocol = "openai-compatible" as const;
  readonly capabilities: ProviderCapabilities = {
    vision: false,
    code: true,
    longContext: true,
  };

  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload {
    return {
      prompt: input.prompt,
      providerId: input.providerId || "deepseek",
      model: input.model,
      apiKeyReference: input.apiKeyReference,
      baseUrl: normalizeBaseUrl(input.baseUrl) || DEEPSEEK_DEFAULT_BASE_URL,
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
