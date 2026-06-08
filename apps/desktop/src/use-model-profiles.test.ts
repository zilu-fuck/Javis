// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModelProfiles } from "./use-model-profiles";
import type { WorkbenchModelConfiguration } from "@javis/ui";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

function createModelProfileRepo() {
  return {
    load: vi.fn().mockResolvedValue({ profiles: [], agentOverrides: {} }),
    save: vi.fn().mockResolvedValue({ profiles: [], agentOverrides: {} }),
    importFromLegacySettings: vi.fn().mockResolvedValue({ profiles: [], agentOverrides: {} }),
  };
}

function buildConfig(
  overrides: Partial<WorkbenchModelConfiguration> = {},
): WorkbenchModelConfiguration {
  return {
    profiles: [
      {
        id: "primary",
        slot: null,
        displayName: "Primary",
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test-123",
        apiKeyReference: "model.openai",
        baseUrl: "",
        capabilities: { vision: true, code: true, contextTokens: 128000 },
      },
      {
        id: "secondary",
        slot: null,
        displayName: "Secondary",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: "",
        apiKeyReference: "model.deepseek",
        baseUrl: "",
        capabilities: { vision: false, code: true, contextTokens: 128000 },
      },
    ],
    agentOverrides: {},
    ...overrides,
  } as any;
}

describe("useModelProfiles", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("saves profiles to repo and api keys via Tauri invoke", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;

    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef, onSaved } as any),
    );

    const config = buildConfig();
    await act(async () => {
      await result.current.handleModelConfigurationChange(config);
    });

    expect(repo.save).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith("save_model_api_key_secret", {
      request: { keyReference: "model.openai", apiKey: "sk-test-123" },
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("keeps stored api key when hasStoredApiKey is true and apiKey is empty", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef } as any),
    );

    const config = buildConfig({
      profiles: [
        {
          id: "primary",
          slot: null,
          displayName: "Primary",
          provider: "openai",
          model: "gpt-4o",
          apiKey: "",
          apiKeyReference: "model.openai",
          baseUrl: "",
          hasStoredApiKey: true,
          capabilities: { vision: true, code: true, contextTokens: 128000 },
        } as any,
      ],
    });

    await act(async () => {
      await result.current.handleModelConfigurationChange(config);
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("delete_model_api_key_secret", expect.anything());
    expect(result.current.modelConfiguration?.profiles[0]?.hasStoredApiKey).toBe(true);
  });

  it("deletes api key via Tauri when hasStoredApiKey is explicitly false", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef } as any),
    );

    const config = buildConfig({
      profiles: [
        {
          id: "primary",
          slot: null,
          displayName: "Primary",
          provider: "openai",
          model: "gpt-4o",
          apiKey: "",
          apiKeyReference: "model.openai",
          baseUrl: "",
          hasStoredApiKey: false,
          capabilities: { vision: true, code: true, contextTokens: 128000 },
        } as any,
      ],
    });

    await act(async () => {
      await result.current.handleModelConfigurationChange(config);
    });

    expect(mockInvoke).toHaveBeenCalledWith("delete_model_api_key_secret", {
      keyReference: "model.openai",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("save_model_api_key_secret", expect.anything());
  });

  it("strips apiKey from profile data before saving to repo", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef } as any),
    );

    const config = buildConfig();
    await act(async () => {
      await result.current.handleModelConfigurationChange(config);
    });

    const savedProfiles = repo.save.mock.calls[0]?.[0] ?? [];
    for (const profile of savedProfiles) {
      expect(profile).not.toHaveProperty("apiKey");
    }
  });

  it("sets modelConfiguration state after save with apiKey cleared and hasStoredApiKey set", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef } as any),
    );

    const config = buildConfig();
    await act(async () => {
      await result.current.handleModelConfigurationChange(config);
    });

    // After save, apiKey is cleared from state (stored in OS credential store)
    // and hasStoredApiKey reflects that a key was successfully saved
    expect(result.current.modelConfiguration?.profiles[0]?.apiKey).toBe("");
    expect(result.current.modelConfiguration?.profiles[0]?.hasStoredApiKey).toBe(true);
    // Profile without a key should not be marked as stored
    expect(result.current.modelConfiguration?.profiles[1]?.apiKey).toBe("");
    expect(result.current.modelConfiguration?.profiles[1]?.hasStoredApiKey).toBeFalsy();
  });

  it("does not mark profiles saved when repo persistence fails", async () => {
    const repo = createModelProfileRepo();
    repo.save.mockRejectedValueOnce(new Error("db unavailable"));
    const repoRef = { current: repo } as any;
    const onSaved = vi.fn();

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef, onSaved } as any),
    );

    await act(async () => {
      await expect(result.current.handleModelConfigurationChange(buildConfig())).rejects.toThrow("db unavailable");
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.modelConfiguration).toBeUndefined();
  });

  it("does not persist profile config when api key storage fails", async () => {
    const repo = createModelProfileRepo();
    const repoRef = { current: repo } as any;
    const onSaved = vi.fn();
    mockInvoke.mockRejectedValueOnce(new Error("keyring unavailable"));

    const { result } = renderHook(() =>
      useModelProfiles({ modelProfileRepoRef: repoRef, onSaved } as any),
    );

    await act(async () => {
      await expect(result.current.handleModelConfigurationChange(buildConfig())).rejects.toThrow("keyring unavailable");
    });

    expect(repo.save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.modelConfiguration).toBeUndefined();
  });
});
