// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useModelSettingsControls } from "./use-model-settings";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("useModelSettingsControls", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("can sync settings without mutating stored API key secrets", async () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() => useModelSettingsControls(storage as Storage));

    await act(async () => {
      await result.current.updateModelSettings(
        {
          provider: "custom-s",
          model: "deepseek-v4-flash",
          apiKey: "",
          apiKeyReference: "model.custom-s",
          baseUrl: "http://101.251.162.103:8080/v1",
        },
        { persistApiKeySecret: false },
      );
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.modelSettings).toMatchObject({
      provider: "custom-s",
      model: "deepseek-v4-flash",
      apiKeyReference: "model.custom-s",
      baseUrl: "http://101.251.162.103:8080/v1",
    });
  });
});

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
