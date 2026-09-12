import { describe, expect, it } from "vitest";
import { diagnoseSetup, type SetupDiagnosisInput } from "./setup-diagnostics";

function input(overrides: Partial<SetupDiagnosisInput> = {}): SetupDiagnosisInput {
  return {
    profiles: [{ slot: "primary", provider: "deepseek", model: "deepseek-v4-flash", hasStoredApiKey: true }],
    workspacePath: "E:/project",
    ...overrides,
  };
}

describe("diagnoseSetup", () => {
  it("reports ready when the primary slot is complete", () => {
    const diagnosis = diagnoseSetup(input());
    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.blockers).toBe(0);
    expect(diagnosis.nextStep).toBeUndefined();
    expect(diagnosis.summary).toBe("Setup is ready.");
    expect(diagnosis.steps.every((step) => step.status === "done")).toBe(true);
  });

  it("starts at the provider when nothing is configured", () => {
    const diagnosis = diagnoseSetup({ profiles: [] });
    expect(diagnosis.ready).toBe(false);
    expect(diagnosis.nextStep?.id).toBe("provider");
    expect(diagnosis.blockers).toBe(3); // provider, model, api_key
    expect(diagnosis.summary).toContain("3 steps left: Provider");
  });

  it("walks provider -> model -> api key in order", () => {
    expect(diagnoseSetup({ profiles: [{ slot: "primary", provider: "deepseek" }] }).nextStep?.id)
      .toBe("model");
    expect(diagnoseSetup({
      profiles: [{ slot: "primary", provider: "deepseek", model: "x" }],
    }).nextStep?.id).toBe("api_key");
    expect(diagnoseSetup({
      profiles: [{ slot: "primary", provider: "deepseek", model: "x", hasStoredApiKey: true }],
    }).ready).toBe(true);
  });

  it("does not demand a key for a provider that needs none", () => {
    const diagnosis = diagnoseSetup(input({
      profiles: [{ slot: "primary", provider: "ollama", model: "qwen", requiresApiKey: false }],
    }));
    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.steps.find((step) => step.id === "api_key")?.detail).toContain("needs no key");
  });

  it("requires a base URL only for a self-hosted endpoint", () => {
    const missing = diagnoseSetup(input({
      profiles: [{ slot: "primary", provider: "custom", model: "m", hasStoredApiKey: true, requiresBaseUrl: true }],
    }));
    expect(missing.ready).toBe(false);
    expect(missing.nextStep?.id).toBe("base_url");

    const provided = diagnoseSetup(input({
      profiles: [{
        slot: "primary", provider: "custom", model: "m",
        hasStoredApiKey: true, requiresBaseUrl: true, baseUrl: "http://localhost:8080/v1",
      }],
    }));
    expect(provided.ready).toBe(true);
    expect(provided.steps.some((step) => step.id === "base_url")).toBe(false);
  });

  it("warns about an unknown provider without blocking", () => {
    const diagnosis = diagnoseSetup(input({
      profiles: [{ slot: "primary", provider: "mystery", model: "m", hasStoredApiKey: true }],
      knownProviders: ["deepseek", "openai"],
    }));
    expect(diagnosis.ready).toBe(true);
    const warning = diagnosis.steps.find((step) => step.id === "provider_supported");
    expect(warning?.status).toBe("warning");
    expect(warning?.detail).toContain("OpenAI-compatible");
  });

  it("treats a missing workspace as a warning, not a blocker", () => {
    const diagnosis = diagnoseSetup(input({ workspacePath: undefined }));
    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.steps.find((step) => step.id === "workspace")?.status).toBe("warning");
    expect(diagnosis.steps.find((step) => step.id === "workspace")?.blocking).toBe(false);
  });

  it("falls back to the first profile when no primary slot is declared", () => {
    const diagnosis = diagnoseSetup({
      profiles: [{ slot: "secondary", provider: "deepseek", model: "m", hasStoredApiKey: true }],
    });
    expect(diagnosis.ready).toBe(true);
    expect(diagnosis.steps.find((step) => step.id === "provider")?.detail).toBe("deepseek");
  });

  it("renders the checklist in Chinese", () => {
    const diagnosis = diagnoseSetup({ profiles: [], locale: "zhCN" });
    expect(diagnosis.nextStep?.title).toBe("服务商");
    expect(diagnosis.summary).toContain("还差 3 步");
    expect(diagnosis.steps.find((step) => step.id === "api_key")?.detail).toContain("localStorage");
  });

  it("keeps every blocking step actionable and every step labelled", () => {
    for (const profile of [
      {},
      { slot: "primary" },
      { slot: "primary", provider: "p" },
      { slot: "primary", provider: "p", model: "m" },
      { slot: "primary", provider: "p", model: "m", hasStoredApiKey: true },
    ]) {
      const diagnosis = diagnoseSetup({ profiles: [profile as never] });
      for (const step of diagnosis.steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.detail.length).toBeGreaterThan(0);
      }
      expect(diagnosis.ready).toBe(diagnosis.blockers === 0);
      if (!diagnosis.ready) {
        expect(diagnosis.nextStep?.blocking).toBe(true);
      }
    }
  });
});
