/**
 * Canonical provider definitions.
 *
 * Every built-in AI provider is declared once here. All other layers
 * (core adapters, UI catalog, Rust base-URL map) derive their data
 * from this single source.
 */

import type { ProviderProtocol, ProviderCapabilities } from "./provider-adapter";

export type AdapterKind =
  | "openai"
  | "openai-compatible"
  | "deepseek"
  | "anthropic";

export interface ProviderDefinition {
  /** Unique identifier (kebab-case). */
  id: string;
  /** Human-readable display label. */
  label: string;
  /** Default API base URL (no trailing slash). */
  defaultBaseUrl: string;
  /** Wire protocol used by this provider. */
  protocol: ProviderProtocol;
  /** Which adapter class to instantiate. */
  adapterKind: AdapterKind;
  /** Default capabilities for this provider. */
  capabilities: ProviderCapabilities;
  /** How model-listing works for this provider. */
  modelListMode: "openai" | "anthropic" | "unsupported";
}

// ── Default capability presets ──────────────────────────────────────────

const ALL_CAPS: ProviderCapabilities = {
  vision: true,
  code: true,
  longContext: true,
};

const NO_VISION: ProviderCapabilities = {
  vision: false,
  code: true,
  longContext: true,
};

const OLLAMA_CAPS: ProviderCapabilities = {
  vision: false,
  code: true,
  longContext: false,
};

// ── Provider list ───────────────────────────────────────────────────────

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    protocol: "openai-compatible",
    adapterKind: "deepseek",
    capabilities: NO_VISION,
    modelListMode: "openai",
  },
  {
    id: "deepseek-anthropic",
    label: "DeepSeek Anthropic",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    protocol: "anthropic",
    adapterKind: "anthropic",
    capabilities: ALL_CAPS,
    modelListMode: "anthropic",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    adapterKind: "anthropic",
    capabilities: ALL_CAPS,
    modelListMode: "anthropic",
  },
  {
    id: "dashscope",
    label: "阿里云百炼 (DashScope)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "dashscope-coding",
    label: "百炼 Coding Plan",
    defaultBaseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "zhipu",
    label: "智谱 AI (GLM)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "baichuan",
    label: "百川智能",
    defaultBaseUrl: "https://api.baichuan-ai.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "stepfun",
    label: "阶跃星辰 (StepFun)",
    defaultBaseUrl: "https://api.stepfun.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "volcengine",
    label: "火山引擎 (豆包)",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "volcengine-coding",
    label: "火山引擎 Coding Plan",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "baidu-cloud",
    label: "百度智能云 (文心)",
    defaultBaseUrl: "https://qianfan.baidubce.com/v2",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "modelscope",
    label: "魔搭 (ModelScope)",
    defaultBaseUrl: "https://api-inference.modelscope.cn/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "infini",
    label: "无问芯穹 (Infini)",
    defaultBaseUrl: "https://cloud.infini-ai.com/maas/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "mimo",
    label: "Xiaomi (MiMo)",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "together",
    label: "Together AI",
    defaultBaseUrl: "https://api.together.xyz/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    defaultBaseUrl: "https://api.x.ai/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "openai",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "minimax-token-plan",
    label: "MiniMax Token Plan",
    defaultBaseUrl: "https://api.minimax.io/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: ALL_CAPS,
    modelListMode: "unsupported",
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    defaultBaseUrl: "http://localhost:11434/v1",
    protocol: "openai-compatible",
    adapterKind: "openai-compatible",
    capabilities: OLLAMA_CAPS,
    modelListMode: "openai",
  },
];

/** O(1) lookup by provider id. */
export const PROVIDER_BY_ID: ReadonlyMap<string, ProviderDefinition> =
  new Map(PROVIDER_DEFINITIONS.map((d) => [d.id, d]));

/** All known provider IDs. */
export const PROVIDER_IDS: readonly string[] =
  PROVIDER_DEFINITIONS.map((d) => d.id);
