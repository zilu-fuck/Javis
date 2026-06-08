import { invoke } from "@tauri-apps/api/core";

export interface FetchProviderModelsParams {
  provider?: string;
  baseUrl: string;
  apiKey?: string;
  apiType: string;
  keyReference: string;
  modelListMode: "openai" | "anthropic" | "unsupported";
}

export async function fetchProviderModels(params: FetchProviderModelsParams): Promise<string[]> {
  if (params.modelListMode === "unsupported") {
    throw new Error("This provider does not support automatic model fetch yet. Enter the model ID manually.");
  }

  const result = await invoke<{ models: string[]; error: string | null }>("fetch_provider_models", {
    request: {
      keyReference: params.keyReference,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      providerId: params.provider,
      apiType: params.apiType,
      modelListMode: params.modelListMode,
    },
  });
  if (result.error) throw new Error(result.error);
  return result.models;
}
