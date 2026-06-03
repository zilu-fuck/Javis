/**
 * Generic OpenAI-compatible provider adapter.
 *
 * Used for providers whose chat API follows /chat/completions but need their
 * own provider id, default base URL, or capability flags.
 */

import type {
  AdapterCompletionInput,
  AdapterCompletionResponse,
  AdapterRequestPayload,
  ProviderAdapter,
  ProviderCapabilities,
} from "../provider-adapter";
import { normalizeBaseUrl } from "./adapter-utils";

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;

  constructor(
    readonly adapterId: string,
    private readonly defaultBaseUrl: string,
    readonly capabilities: ProviderCapabilities = {
      vision: true,
      code: true,
      longContext: true,
    },
  ) {}

  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload {
    return {
      prompt: input.prompt,
      imageDataUrl: input.imageDataUrl,
      providerId: input.providerId || this.adapterId,
      model: input.model,
      apiKeyReference: input.apiKeyReference,
      baseUrl: normalizeBaseUrl(input.baseUrl) || this.defaultBaseUrl,
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
