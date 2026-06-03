import { describe, expect, it } from "vitest";
import { createAgentRegistry } from "./agent-capability";
import { createDefaultAgentRegistry } from "./agents";

describe("AgentRegistry", () => {
  const registry = createDefaultAgentRegistry();

  it("finds the Code Agent by git_inspect capability", () => {
    const reg = registry.findByCapabilities(["git_inspect"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("code");
  });

  it("finds the Research Agent by web_search capability", () => {
    const reg = registry.findByCapabilities(["web_search"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("research");
  });

  it("finds the Verifier by evidence_check capability", () => {
    const reg = registry.findByCapabilities(["evidence_check"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("verifier");
  });

  it("finds the Commander by planning capability", () => {
    const reg = registry.findByCapabilities(["planning"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("commander");
  });

  it("finds the Computer Agent by local_search capability", () => {
    const reg = registry.findByCapabilities(["local_search"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("computer");
  });

  it("returns undefined for unknown capability tag", () => {
    const unknownCapability = "nonexistent_tag" as never;
    const reg = registry.findByCapabilities([unknownCapability]);
    expect(reg).toBeUndefined();
  });

  it("returns undefined when asking for capabilities no single agent has", () => {
    // No single agent has BOTH code_propose AND web_search
    const reg = registry.findByCapabilities(["code_propose", "web_search"]);
    expect(reg).toBeUndefined();
  });

  it("returns first registered agent when multiple match", () => {
    // Both Commander and Verifier have "planning"
    const reg = registry.findByCapabilities(["planning"]);
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("commander");
  });

  it("finds by kind (backward compat)", () => {
    const reg = registry.findByKind("code");
    expect(reg).toBeDefined();
    expect(reg!.agent.kind).toBe("code");
    expect(reg!.capabilityTags).toContain("git_inspect");
  });

  it("returns undefined for unknown kind", () => {
    const reg = registry.findByKind("nonexistent");
    expect(reg).toBeUndefined();
  });

  describe("modelRequirements", () => {
    it("code agent prefersCode is true", () => {
      const req = registry.getModelRequirements("code");
      expect(req).toBeDefined();
      expect(req!.prefersCode).toBe(true);
      expect(req!.prefersVision).toBe(false);
      expect(req!.minContextTokens).toBe(16000);
    });

    it("computer agent prefersVision is true (screenshots for desktop automation)", () => {
      const req = registry.getModelRequirements("computer");
      expect(req).toBeDefined();
      expect(req!.prefersVision).toBe(true);
      expect(req!.minContextTokens).toBe(16000);
    });

    it("commander has minContextTokens 16000", () => {
      const req = registry.getModelRequirements("commander");
      expect(req).toBeDefined();
      expect(req!.minContextTokens).toBe(16000);
    });

    it("returns undefined for unknown kind", () => {
      const req = registry.getModelRequirements("nonexistent");
      expect(req).toBeUndefined();
    });
  });

  describe("all agents have capability tags", () => {
    const all = registry.list();

    it("has 12 agents registered", () => {
      expect(all).toHaveLength(12);
    });

    it("every agent has non-empty capabilityTags", () => {
      for (const reg of all) {
        expect(
          reg.capabilityTags.length,
          `${reg.agent.kind} has no capability tags`,
        ).toBeGreaterThan(0);
      }
    });

    it("every agent has modelRequirements", () => {
      for (const reg of all) {
        expect(reg.modelRequirements).toBeDefined();
        expect(typeof reg.modelRequirements.prefersVision).toBe("boolean");
        expect(typeof reg.modelRequirements.prefersCode).toBe("boolean");
        expect(typeof reg.modelRequirements.minContextTokens).toBe("number");
      }
    });
  });

  describe("createAgentRegistry with empty agents", () => {
    it("returns a registry with empty list", () => {
      const empty = createAgentRegistry([]);
      expect(empty.list()).toEqual([]);
      expect(empty.findByKind("anything")).toBeUndefined();
    });
  });

  describe("capability inference", () => {
    it("chinese-reviewer has language_review", () => {
      const reg = registry.findByKind("chinese-reviewer");
      expect(reg).toBeDefined();
      expect(reg!.capabilityTags).toContain("language_review");
    });

    it("scheduler has schedule_create", () => {
      const reg = registry.findByKind("scheduler");
      expect(reg).toBeDefined();
      expect(reg!.capabilityTags).toContain("schedule_create");
    });

    it("file agent has file_scan", () => {
      const reg = registry.findByKind("file");
      expect(reg).toBeDefined();
      expect(reg!.capabilityTags).toContain("file_scan");
    });

    it("file agent has document_classify", () => {
      const reg = registry.findByKind("file");
      expect(reg).toBeDefined();
      expect(reg!.capabilityTags).toContain("document_classify");
    });
  });
});
