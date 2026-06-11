import { describe, expect, it } from "vitest";
import { initialToolDescriptors, isDisabledBrowserWriteToolName } from "@javis/tools";
import {
  ALL_CAPABILITY_TAGS,
  createAgentRegistry,
  deriveAgentCapabilityVerificationInput,
  rankAgentRepairPriorities,
  scoreAgentCapabilities,
  scoreAgentCapability,
} from "./agent-capability";
import { createDefaultAgentRegistry } from "./agents";
import { COMPUTER_USE_OUTPUT_SCHEMA } from "./computer-use-prompt";
import { COMPUTER_USE_ACTION_TOOL_NAMES } from "./computer-use-types";

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

    it("finds the Computer Agent by desktop UI Automation capabilities", () => {
      expect(registry.findByCapabilities(["desktop_ui_tree"])?.agent.kind).toBe("computer");
      expect(registry.findByCapabilities(["desktop_ui_input"])?.agent.kind).toBe("computer");
    });

    it("keeps all descriptor capability tags in the valid capability set", () => {
      const validTags = new Set<string>(ALL_CAPABILITY_TAGS);
      const invalid = initialToolDescriptors.flatMap((descriptor) =>
        descriptor.capabilityTags
          .filter((tag) => !validTags.has(tag))
          .map((tag) => `${descriptor.name}:${tag}`),
      );

      expect(invalid).toEqual([]);
    });

    it("keeps disabled browser write tools out of the Browser Agent dispatch surface", () => {
      const browserWriteTools = [
        "browser.click",
        "browser.type",
        "browser.evaluate",
        "browser.runTest",
        "browser.upload",
      ];
      const browserAgent = registry.findByKind("browser")?.agent;

      for (const toolName of browserWriteTools) {
        const descriptor = initialToolDescriptors.find((tool) => tool.name === toolName);
        expect(isDisabledBrowserWriteToolName(toolName)).toBe(true);
        expect(descriptor?.permissionLevel).toBe("confirmed_write");
        expect(descriptor?.summary).toContain("Disabled until browser approvals are implemented");
        expect(browserAgent?.allowedToolNames).not.toContain(toolName);
      }

      expect(browserAgent?.allowedToolNames).toEqual([
        "browser.navigate",
        "browser.screenshot",
        "browser.getContent",
        "browser.extractLinks",
        "browser.followCandidateLinks",
      ]);
      expect(browserAgent?.description).toContain("pending approval support");
      expect(browserAgent?.systemPrompt.en).toContain(
        "Browser writes are disabled until approvals exist",
      );
      expect(browserAgent?.systemPrompt.en).toContain("source URLs/domains");
      expect(browserAgent?.systemPrompt.en).toContain("cross-site data");
      expect(browserAgent?.systemPrompt.en).toContain("currentOrigin");
      expect(browserAgent?.systemPrompt.en).toContain("allowedAction=readOnly|blocked");
    });

    it("keeps Computer Use action tools aligned across schema, descriptors, and agent dispatch", () => {
      const computerAgent = registry.findByKind("computer")?.agent;
      const schemaToolEnum = COMPUTER_USE_OUTPUT_SCHEMA.properties.action.properties.tool.enum;
      const readTools = new Set([
        "computer.screenshot",
        "computer.listWindows",
        "computer.inspectUi",
        "computer.wait",
      ]);

      expect(schemaToolEnum).toEqual(COMPUTER_USE_ACTION_TOOL_NAMES);

      for (const toolName of COMPUTER_USE_ACTION_TOOL_NAMES) {
        const descriptor = initialToolDescriptors.find((tool) => tool.name === toolName);
        expect(descriptor, `${toolName} descriptor missing`).toBeDefined();
        expect(descriptor?.ownerAgentKinds).toContain("computer");
        expect(computerAgent?.allowedToolNames).toContain(toolName);
        expect(descriptor?.permissionLevel).toBe(readTools.has(toolName) ? "read" : "confirmed_write");
      }

      expect(computerAgent?.allowedToolNames).not.toContain("computer.detectUiObjects");
    });

    it("keeps Research and Code structured report rules agent-only", () => {
      const researchAgent = registry.findByKind("research")?.agent;
      const codeAgent = registry.findByKind("code")?.agent;

      expect(researchAgent?.systemPrompt.en).toContain("claim, status, sourceUrl, excerpt");
      expect(codeAgent?.systemPrompt.en).toContain("changed, verified, failed, skipped, risk");
    });

    it("keeps repository search descriptor aligned with Code Agent dispatch", () => {
      const descriptor = initialToolDescriptors.find((tool) => tool.name === "code.searchRepository");
      const codeAgent = registry.findByKind("code")?.agent;

      expect(descriptor).toMatchObject({
        permissionLevel: "read",
        capabilityTags: ["code_search"],
        ownerAgentKinds: ["code"],
      });
      expect(codeAgent?.allowedToolNames).toContain("code.searchRepository");
      expect(registry.findByCapabilities(["code_search"])?.agent.kind).toBe("code");
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
      expect(all).toHaveLength(11);
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
    it("chinese-reviewer has been removed from the agent system", () => {
      const reg = registry.findByKind("chinese-reviewer");
      expect(reg).toBeUndefined();
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

  describe("capability scores", () => {
    it("marks an agent ready when implementation, permissions, QA, and live verification are present", () => {
      const reg = registry.findByKind("research");
      expect(reg).toBeDefined();

      const score = scoreAgentCapability(reg!, {
        qaPassedAgentKinds: ["research"],
        liveVerifiedAgentKinds: ["research"],
      });

      expect(score).toMatchObject({
        agentKind: "research",
        score: 100,
        status: "ready",
        implemented: true,
        permissionReady: true,
        qaPassed: true,
        liveVerified: true,
        highestPermissionLevel: "read",
      });
      expect(score.gaps).toEqual([]);
    });

    it("keeps source-level capability partial until product QA and live evidence are marked passed", () => {
      const reg = registry.findByKind("code");
      expect(reg).toBeDefined();

      const score = scoreAgentCapability(reg!);

      expect(score.implemented).toBe(true);
      expect(score.permissionReady).toBe(true);
      expect(score.qaPassed).toBe(false);
      expect(score.liveVerified).toBe(false);
      expect(score.status).toBe("usable");
      expect(score.gaps).toContain("product QA evidence is not marked as passed");
      expect(score.gaps).toContain("live workflow verification is not marked as passed");
    });

    it("does not mark a high-scoring agent ready without live verification", () => {
      const reg = registry.findByKind("code");
      expect(reg).toBeDefined();

      const score = scoreAgentCapability(reg!, {
        qaPassedAgentKinds: ["code"],
      });

      expect(score.score).toBe(90);
      expect(score.status).toBe("usable");
      expect(score.qaPassed).toBe(true);
      expect(score.liveVerified).toBe(false);
    });

    it("accepts QA and live verification by capability tag", () => {
      const reg = registry.findByKind("computer");
      expect(reg).toBeDefined();

      const score = scoreAgentCapability(reg!, {
        qaPassedCapabilityTags: ["desktop_screenshot"],
        liveVerifiedCapabilityTags: ["desktop_screenshot"],
      });

      expect(score.qaPassed).toBe(true);
      expect(score.liveVerified).toBe(true);
      expect(score.status).toBe("ready");
    });

    it("derives QA/live verification signals from generic evidence records", () => {
      const reg = registry.findByKind("research");
      expect(reg).toBeDefined();

      const verification = deriveAgentCapabilityVerificationInput([
        {
          kind: "qa",
          status: "passed",
          agentKind: "research",
          evidenceRef: "docs/qa/research-output.json",
        },
        {
          kind: "live",
          status: "passed",
          capabilityTags: ["web_search"],
          evidenceRef: "docs/qa/research-live.json",
        },
        {
          kind: "live",
          status: "blocked",
          agentKind: "code",
          evidenceRef: "docs/qa/code-live.json",
        },
      ]);
      const score = scoreAgentCapability(reg!, verification);

      expect(score.qaPassed).toBe(true);
      expect(score.liveVerified).toBe(true);
      expect(score.evidenceRefs).toEqual([
        "docs/qa/research-output.json",
        "docs/qa/research-live.json",
      ]);
      expect(score.status).toBe("ready");
    });

    it("derives recent failure rates from tool-call signals and reflects them in gaps", () => {
      const reg = registry.findByKind("research");
      expect(reg).toBeDefined();

      const verification = deriveAgentCapabilityVerificationInput([
        { kind: "qa", status: "passed", agentKind: "research" },
        { kind: "live", status: "passed", agentKind: "research" },
      ], [
        { toolName: "web.search", status: "succeeded" },
        { toolName: "web.search", status: "failed" },
        { toolName: "web.fetchSource", status: "blocked" },
      ]);
      const score = scoreAgentCapability(reg!, verification);

      expect(score.recentFailureRate).toBe(1);
      expect(score.score).toBe(80);
      expect(score.status).toBe("usable");
      expect(score.gaps).toContain("recent tool failure rate is 100%");
    });

    it("reports missing descriptors as implementation and permission gaps", () => {
      const [score] = scoreAgentCapabilities(createAgentRegistry([
        {
          id: "custom",
          displayName: "Custom Agent",
          kind: "file",
          description: "Custom agent with an unknown tool",
          allowedToolNames: ["missing.tool"],
          systemPrompt: { en: "Use the missing tool.", zhCN: "Use the missing tool." },
        },
      ]));

      expect(score.score).toBe(0);
      expect(score.status).toBe("limited");
      expect(score.implemented).toBe(false);
      expect(score.permissionReady).toBe(false);
      expect(score.highestPermissionLevel).toBe("dangerous");
      expect(score.gaps[0]).toContain("missing descriptors: missing.tool");
    });

    it("ranks repair priorities from capability gaps and recent failures", () => {
      const scores = scoreAgentCapabilities(registry, deriveAgentCapabilityVerificationInput([
        { kind: "qa", status: "passed", agentKind: "research" },
        { kind: "live", status: "passed", agentKind: "research" },
        { kind: "qa", status: "blocked", capabilityTags: ["git_pr_create"], evidenceRef: "docs/qa/git#blocked" },
        { kind: "live", status: "blocked", capabilityTags: ["git_pr_create"], evidenceRef: "docs/qa/git#blocked" },
      ], [
        { toolName: "git.createPullRequest", status: "failed" },
        { toolName: "git.createPullRequest", status: "blocked" },
        { toolName: "web.search", status: "succeeded" },
      ]));

      const priorities = rankAgentRepairPriorities(scores);

      expect(priorities[0]).toMatchObject({
        agentKind: "code",
        priority: "critical",
      });
      expect(priorities[0].reasons.join(" ")).toContain("live workflow verification");
      expect(priorities[0].reasons.join(" ")).toContain("recent tool failure rate");
      expect(priorities[0].nextEvidence).toContain("dated packaged/live workflow output with artifact references");
      expect(priorities.find((priority) => priority.agentKind === "research")).toBeUndefined();
    });

    it("treats missing implementation and dangerous permissions as critical repair work", () => {
      const [score] = scoreAgentCapabilities(createAgentRegistry([
        {
          id: "dangerous-custom",
          displayName: "Dangerous Custom Agent",
          kind: "code",
          description: "Custom agent with a missing dangerous tool",
          allowedToolNames: ["missing.dangerous"],
          systemPrompt: { en: "Use the missing tool.", zhCN: "Use the missing tool." },
        },
      ]));

      const [priority] = rankAgentRepairPriorities([score]);

      expect(priority).toMatchObject({
        agentKind: "code",
        priority: "critical",
      });
      expect(priority.reasons).toContain("implementation is missing or tool descriptors are incomplete");
      expect(priority.nextEvidence).toContain("source test proving the agent has descriptors for every allowed tool");
    });
  });
});
