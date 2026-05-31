/**
 * Provider 适配器抽象层
 *
 * 定义多 provider 协议差异的统一接口。
 * 适配器是纯策略对象：构建请求载荷 + 规范化响应，不执行 HTTP。
 * HTTP 调用由 Rust 后端按 protocol 字段分发到不同路径。
 */

export type ProviderProtocol = "openai-compatible" | "anthropic";

export interface ProviderCapabilities {
  vision: boolean;
  code: boolean;
  longContext: boolean;
}

export interface AdapterCompletionInput {
  prompt: string;
  imageDataUrl?: string;
  /** Multi-image support — passed alongside imageDataUrl for backward compat. */
  images?: string[];
  model: string;
  providerId: string;
  baseUrl: string;
  apiKeyReference: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  locale?: string;
}

export interface AdapterRequestPayload {
  prompt: string;
  imageDataUrl?: string;
  images?: string[];
  providerId: string;
  model: string;
  apiKeyReference: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  locale?: string;
  protocol: ProviderProtocol;
}

export interface AdapterCompletionResponse {
  text: string;
  model?: string;
  provider?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
  };
}

export interface ProviderAdapter {
  readonly adapterId: string;
  readonly protocol: ProviderProtocol;
  readonly capabilities: ProviderCapabilities;
  buildCompletionRequest(input: AdapterCompletionInput): AdapterRequestPayload;
  normalizeCompletionResponse(
    response: AdapterCompletionResponse,
  ): AdapterCompletionResponse;
}
