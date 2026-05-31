/**
 * Provider 适配器注册表
 *
 * 按 providerId 查找适配器，未知 provider 回退到 OpenAIAdapter。
 */

import type { ProviderAdapter } from "../provider-adapter";
import { OpenAIAdapter } from "./openai-adapter";
import { DeepSeekAdapter } from "./deepseek-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";

const adapters = new Map<string, ProviderAdapter>([
  ["openai", new OpenAIAdapter()],
  ["deepseek", new DeepSeekAdapter()],
  ["deepseek-anthropic", new AnthropicAdapter("deepseek-anthropic")],
  ["anthropic", new AnthropicAdapter()],
]);

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
