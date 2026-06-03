/**
 * Provider 适配器注册表
 *
 * 按 providerId 查找适配器，未知 provider 回退到 OpenAIAdapter。
 * All built-in adapters are constructed from PROVIDER_DEFINITIONS —
 * the single source of truth for provider metadata.
 */

import type { ProviderAdapter } from "../provider-adapter";
import {
  PROVIDER_DEFINITIONS,
  type ProviderDefinition,
} from "../provider-definitions";
import { OpenAIAdapter } from "./openai-adapter";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter";
import { DeepSeekAdapter } from "./deepseek-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";

function createAdapter(def: ProviderDefinition): ProviderAdapter {
  switch (def.adapterKind) {
    case "openai":
      return new OpenAIAdapter();
    case "deepseek":
      return new DeepSeekAdapter();
    case "anthropic":
      return new AnthropicAdapter(
        def.id === "anthropic" ? undefined : def.id,
      );
    case "openai-compatible":
      return new OpenAICompatibleAdapter(
        def.id,
        def.defaultBaseUrl,
        def.capabilities,
      );
  }
}

const adapters = new Map<string, ProviderAdapter>(
  PROVIDER_DEFINITIONS.map((def) => [def.id, createAdapter(def)]),
);

const openaiFallback = new OpenAIAdapter();

export function getAdapter(providerId: string): ProviderAdapter {
  const normalized = providerId.toLowerCase().trim();
  const adapter = adapters.get(normalized);
  if (adapter) return adapter;
  if (normalized) {
    console.warn(
      `Unknown provider "${providerId}" — falling back to OpenAIAdapter. ` +
      `Known providers: ${[...adapters.keys()].join(", ")}. ` +
      `Register custom adapters with registerAdapter().`,
    );
  }
  return openaiFallback;
}

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.adapterId, adapter);
}

export function listAdapters(): ProviderAdapter[] {
  return [...adapters.values()];
}
