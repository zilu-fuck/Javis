import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProviderModels } from "./provider-models";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("fetchProviderModels", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses the native command even when a typed API key is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invokeMock.mockResolvedValueOnce({ models: ["model-a"], error: null });

    await expect(fetchProviderModels({
      provider: "openai",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-typed",
      apiType: "openai-compatible",
      keyReference: "model.primary",
      modelListMode: "openai",
    })).resolves.toEqual(["model-a"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("fetch_provider_models", {
      request: {
        keyReference: "model.primary",
        apiKey: "sk-typed",
        baseUrl: "https://api.example.test/v1",
        providerId: "openai",
        apiType: "openai-compatible",
        modelListMode: "openai",
      },
    });
  });

  it("returns native errors without falling back to renderer fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invokeMock.mockResolvedValueOnce({ models: [], error: "HTTP 401" });

    await expect(fetchProviderModels({
      baseUrl: "https://api.example.test/v1",
      apiType: "openai-compatible",
      keyReference: "default",
      modelListMode: "openai",
    })).rejects.toThrow("HTTP 401");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
