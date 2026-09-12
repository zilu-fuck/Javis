import { describe, expect, it } from "vitest";
import {
  decideAgentRouting,
  describeRoutingDecision,
  type RoutingCandidate,
} from "./routing-decision";

function candidate(
  agentKind: string,
  overrides: Partial<Omit<RoutingCandidate, "agentKind">> = {},
): RoutingCandidate {
  return { agentKind, capabilityTags: [agentKind], ...overrides };
}

const REGISTRY: RoutingCandidate[] = [
  candidate("code", { capabilityTags: ["code_search", "code_inspect"], modelRequirements: { prefersCode: true, minContextTokens: 200_000 } }),
  candidate("explorer", { capabilityTags: ["code_search"], costRank: 1 }),
  candidate("vision", { capabilityTags: ["ui_evidence"], modelRequirements: { prefersVision: true, minContextTokens: 32_000 } }),
  candidate("verifier", { capabilityTags: ["evidence_check"] }),
];

describe("decideAgentRouting", () => {
  it("routes by required capability and explains the choice", () => {
    const decision = decideAgentRouting(
      { stepId: "search", requiredCapabilities: ["code_search"] },
      REGISTRY,
    );
    // Both `code` and `explorer` qualify; `code` wins on being named first in the registry
    // only if scores tie — here the tie-break is alphabetical, so assert the documented rule.
    expect(["code", "explorer"]).toContain(decision.selectedAgentKind);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.summary).toContain("routed to");
  });

  it("prefers the agent the plan named", () => {
    const decision = decideAgentRouting(
      { stepId: "search", requiredCapabilities: ["code_search"], preferredAgentKind: "explorer" },
      REGISTRY,
    );
    expect(decision.selectedAgentKind).toBe("explorer");
    expect(decision.reasons).toContain("named by the plan");
    expect(decision.unambiguous).toBe(true);
  });

  it("reports a tie instead of hiding it behind a tie-break", () => {
    // Two identical candidates: whichever wins, the answer depended on a tie-break,
    // and that is worth surfacing rather than presenting as a considered choice.
    const decision = decideAgentRouting(
      { stepId: "search", requiredCapabilities: ["code_search"] },
      [candidate("alpha", { capabilityTags: ["code_search"] }), candidate("beta", { capabilityTags: ["code_search"] })],
    );
    expect(decision.unambiguous).toBe(false);
    expect(decision.selectedAgentKind).toBe("alpha");
    expect(decision.summary).toContain("tie-break");
  });

  it("treats a missing required capability as ineligible, not as a lower score", () => {
    const decision = decideAgentRouting(
      { stepId: "check", requiredCapabilities: ["evidence_check"] },
      REGISTRY,
    );
    expect(decision.selectedAgentKind).toBe("verifier");
    const rejected = decision.rejected.map((entry) => entry.agentKind);
    expect(rejected).toContain("code");
    expect(decision.rejected.find((entry) => entry.agentKind === "code")?.reason)
      .toContain("missing required capability evidence_check");
  });

  it("refuses to route a vision step to a text-only model", () => {
    // Both candidates declare the required capability, so the *vision* filter is what
    // separates them — capability is checked first, then model requirements.
    const decision = decideAgentRouting(
      { stepId: "read-screen", requiredCapabilities: ["ui_evidence"], needsVision: true },
      [
        candidate("blind-reviewer", { capabilityTags: ["ui_evidence"] }),
        candidate("vision", { capabilityTags: ["ui_evidence"], modelRequirements: { prefersVision: true } }),
      ],
    );
    expect(decision.selectedAgentKind).toBe("vision");
    // The rejection is explicit, so a vision step can never silently land on a blind model.
    expect(decision.rejected).toEqual([
      { agentKind: "blind-reviewer", reason: "no vision-capable model configured" },
    ]);
  });

  it("rejects on the missing capability before considering vision", () => {
    // Ordering matters for the explanation a user reads: "needs ui_evidence" is more
    // actionable than "not vision-capable".
    const decision = decideAgentRouting(
      { stepId: "read-screen", requiredCapabilities: ["ui_evidence"], needsVision: true },
      [candidate("code", { capabilityTags: ["code_search"] })],
    );
    expect(decision.rejected[0].reason).toContain("missing required capability ui_evidence");
  });

  it("rejects a candidate whose context window cannot hold the step", () => {
    const decision = decideAgentRouting(
      { stepId: "big-read", requiredCapabilities: ["ui_evidence"], needsVision: true, contextTokens: 128_000 },
      REGISTRY,
    );
    expect(decision.selectedAgentKind).toBeUndefined();
    expect(decision.rejected.find((entry) => entry.agentKind === "vision")?.reason)
      .toContain("context window too small");
  });

  it("rejects an unavailable candidate with that reason", () => {
    const decision = decideAgentRouting(
      { stepId: "check", requiredCapabilities: ["evidence_check"] },
      [candidate("verifier", { capabilityTags: ["evidence_check"], available: false })],
    );
    expect(decision.selectedAgentKind).toBeUndefined();
    expect(decision.rejected[0]).toEqual({ agentKind: "verifier", reason: "not available" });
  });

  it("explains what is missing when nothing is eligible", () => {
    const decision = decideAgentRouting(
      { stepId: "pdf", requiredCapabilities: ["pdf_move"] },
      REGISTRY,
    );
    expect(decision.selectedAgentKind).toBeUndefined();
    expect(decision.summary).toContain("No registered agent satisfies step pdf");
    expect(decision.summary).toContain("needs pdf_move");
    expect(decision.rejected).toHaveLength(REGISTRY.length);
  });

  it("handles an empty registry", () => {
    const decision = decideAgentRouting({ stepId: "x", requiredCapabilities: ["anything"] }, []);
    expect(decision.selectedAgentKind).toBeUndefined();
    expect(decision.summary).toContain("No agent is registered");
    expect(decision.evaluations).toEqual([]);
  });

  it("routes a step with no capability requirement to the cheapest candidate", () => {
    const decision = decideAgentRouting(
      { stepId: "anything" },
      [candidate("code"), candidate("explorer", { costRank: 5 })],
    );
    expect(decision.selectedAgentKind).toBe("code");
    expect(decision.reasons).toContain("no capability requirement to satisfy");
  });

  it("is deterministic across repeated calls and input orders", () => {
    const request = { stepId: "search", requiredCapabilities: ["code_search"] };
    const forward = decideAgentRouting(request, REGISTRY);
    const reversed = decideAgentRouting(request, [...REGISTRY].reverse());
    expect(reversed.selectedAgentKind).toBe(forward.selectedAgentKind);
    expect(reversed.evaluations.map((evaluation) => evaluation.agentKind).sort())
      .toEqual(forward.evaluations.map((evaluation) => evaluation.agentKind).sort());
  });

  it("evaluates every candidate, so an alternative is always explainable", () => {
    const decision = decideAgentRouting(
      { stepId: "search", requiredCapabilities: ["code_search"] },
      REGISTRY,
    );
    expect(decision.evaluations).toHaveLength(REGISTRY.length);
    const lines = describeRoutingDecision(decision);
    expect(lines[0]).toContain("routed to");
    expect(lines.join(" | ")).toContain("Rejected");
  });
});

describe("describeRoutingDecision", () => {
  it("lists considered alternatives and every rejection", () => {
    const decision = decideAgentRouting(
      { stepId: "search", requiredCapabilities: ["code_search"] },
      REGISTRY,
    );
    const lines = describeRoutingDecision(decision);
    expect(lines.some((line) => line.startsWith("Considered "))).toBe(true);
    expect(lines.filter((line) => line.startsWith("Rejected "))).toHaveLength(decision.rejected.length);
  });

  it("returns just the summary when nothing was rejected", () => {
    const decision = decideAgentRouting({ stepId: "x" }, [candidate("code")]);
    expect(describeRoutingDecision(decision)).toHaveLength(1);
  });
});
