import { describe, expect, test } from "vitest";
import { PROVIDER_DEFINITIONS, PROVIDER_BY_ID, PROVIDER_IDS } from "./provider-definitions";
import { listAdapters } from "./adapters/adapter-registry";

describe("PROVIDER_DEFINITIONS", () => {
  test("covers all registered adapters and vice versa", () => {
    const defIds = new Set(PROVIDER_IDS);
    const adapterIds = new Set(listAdapters().map((a) => a.adapterId));
    expect(defIds).toEqual(adapterIds);
  });

  test("has no duplicate ids", () => {
    expect(PROVIDER_IDS.length).toBe(new Set(PROVIDER_IDS).size);
  });

  test("every definition has a non-empty defaultBaseUrl", () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.defaultBaseUrl).toBeTruthy();
    }
  });

  test("PROVIDER_BY_ID contains every definition", () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(PROVIDER_BY_ID.get(def.id)).toBe(def);
    }
  });

  test("specialized adapters have correct adapterKind", () => {
    expect(PROVIDER_BY_ID.get("openai")?.adapterKind).toBe("openai");
    expect(PROVIDER_BY_ID.get("deepseek")?.adapterKind).toBe("deepseek");
    expect(PROVIDER_BY_ID.get("anthropic")?.adapterKind).toBe("anthropic");
    expect(PROVIDER_BY_ID.get("deepseek-anthropic")?.adapterKind).toBe("anthropic");
  });

  test("ollama has reduced capabilities", () => {
    const ollama = PROVIDER_BY_ID.get("ollama");
    expect(ollama?.capabilities).toEqual({
      vision: false,
      code: true,
      longContext: false,
    });
  });

  test("deepseek has no vision", () => {
    const ds = PROVIDER_BY_ID.get("deepseek");
    expect(ds?.capabilities.vision).toBe(false);
    expect(ds?.capabilities.code).toBe(true);
    expect(ds?.capabilities.longContext).toBe(true);
  });
});
