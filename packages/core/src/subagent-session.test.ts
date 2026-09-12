import { describe, expect, it } from "vitest";
import {
  buildSessionLineage,
  isForeignContextWrite,
  namespaceChildContextKey,
  parseChildContextKey,
  planSubagentFork,
  type SessionMessage,
  type SubagentSession,
} from "./subagent-session";

const PARENT: SessionMessage[] = [
  { role: "system", tokens: 1_000 },
  { role: "user", tokens: 200 },
  { role: "assistant", tokens: 300 },
  { role: "tool", tokens: 500 },
];

describe("planSubagentFork", () => {
  it("reuses the whole parent conversation when the prefix is identical", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      childSystemPromptTokens: 100,
      sharesParentPrefix: true,
    });
    expect(plan.sharedPrefixMessages).toBe(4);
    expect(plan.sharedPrefixTokens).toBe(2_000);
    expect(plan.childOnlyTokens).toBe(100);
    expect(plan.totalTokens).toBe(2_100);
    expect(plan.prefixCacheable).toBe(true);
    expect(plan.droppedPrefixMessages).toBe(0);
    expect(plan.reason).toContain("identical prefix");
  });

  it("reports that nothing is reusable when the child's prefix differs", () => {
    // The whole point: a changed system prompt or tool list means the provider has no
    // matching prefix, so the child costs a cold start even though it "inherited" the
    // messages.
    const plan = planSubagentFork({
      parentMessages: PARENT,
      childSystemPromptTokens: 100,
      sharesParentPrefix: false,
    });
    expect(plan.prefixCacheable).toBe(false);
    expect(plan.reason).toContain("nothing can be reused from cache");
    // The token count still reflects what must be sent.
    expect(plan.uncachedPrefixTokens).toBe(2_000);
  });

  it("forks from a prefix of the conversation", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      forkAtMessageCount: 2,
      childSystemPromptTokens: 50,
      sharesParentPrefix: true,
    });
    expect(plan.sharedPrefixMessages).toBe(2);
    expect(plan.sharedPrefixTokens).toBe(1_200);
    expect(plan.totalTokens).toBe(1_250);
  });

  it("clamps a fork point beyond the conversation instead of over-reading", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      forkAtMessageCount: 99,
      childSystemPromptTokens: 0,
      sharesParentPrefix: true,
    });
    expect(plan.sharedPrefixMessages).toBe(4);
  });

  it("drops the oldest inherited messages to fit the budget, and says the prefix died", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      childSystemPromptTokens: 100,
      sharesParentPrefix: true,
      budgetTokens: 1_000,
    });
    expect(plan.exceededBudget).toBe(false);
    expect(plan.droppedPrefixMessages).toBeGreaterThan(0);
    expect(plan.totalTokens).toBeLessThanOrEqual(1_000);
    // Trimming the front changes the prefix, so the cache benefit is gone.
    expect(plan.prefixCacheable).toBe(false);
    expect(plan.reason).toContain("invalidates it");
  });

  it("keeps the most recent turns when trimming", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      childSystemPromptTokens: 0,
      sharesParentPrefix: true,
      budgetTokens: 800,
    });
    // 500 + 300 = 800 fits; the system and the first user message were dropped.
    expect(plan.sharedPrefixTokens).toBe(800);
    expect(plan.droppedPrefixMessages).toBe(2);
  });

  it("flags an impossible budget rather than pretending it fits", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      childSystemPromptTokens: 5_000,
      sharesParentPrefix: true,
      budgetTokens: 1_000,
    });
    expect(plan.exceededBudget).toBe(true);
    expect(plan.droppedPrefixMessages).toBe(4);
    expect(plan.totalTokens).toBe(5_000);
    expect(plan.reason).toContain("exceeds the 1000-token budget");
  });

  it("explains an empty prefix", () => {
    const plan = planSubagentFork({
      parentMessages: [],
      childSystemPromptTokens: 200,
      sharesParentPrefix: true,
    });
    expect(plan.sharedPrefixMessages).toBe(0);
    expect(plan.prefixCacheable).toBe(false);
    expect(plan.reason).toContain("no prefix to reuse");
  });

  it("never invents negative tokens", () => {
    const plan = planSubagentFork({
      parentMessages: PARENT,
      forkAtMessageCount: -5,
      childSystemPromptTokens: -10,
      sharesParentPrefix: true,
    });
    expect(plan.sharedPrefixTokens).toBe(0);
    expect(plan.childOnlyTokens).toBe(0);
    expect(plan.totalTokens).toBe(0);
  });

  it("is a pure function of its inputs", () => {
    const input = { parentMessages: PARENT, childSystemPromptTokens: 10, sharesParentPrefix: true };
    expect(planSubagentFork(input)).toEqual(planSubagentFork(input));
  });
});

describe("buildSessionLineage", () => {
  const SESSIONS: SubagentSession[] = [
    { id: "root", agentKind: "commander", status: "running" },
    { id: "child-a", agentKind: "code", parentSessionId: "root", status: "completed" },
    { id: "child-b", agentKind: "verifier", parentSessionId: "root", status: "running" },
    { id: "grandchild", agentKind: "file", parentSessionId: "child-a", status: "running" },
  ];

  it("returns ancestors root-first and excludes the session itself", () => {
    const lineage = buildSessionLineage(SESSIONS, "grandchild");
    expect(lineage.ancestors.map((session) => session.id)).toEqual(["root", "child-a"]);
    expect(lineage.depth).toBe(2);
    expect(lineage.orphaned).toBe(false);
  });

  it("returns direct and transitive descendants breadth-first", () => {
    const lineage = buildSessionLineage(SESSIONS, "root");
    expect(lineage.descendants.map((session) => session.id)).toEqual(["child-a", "child-b", "grandchild"]);
    expect(lineage.ancestors).toEqual([]);
  });

  it("reports an orphan instead of throwing when a parent is gone", () => {
    // A trajectory from a pruned parent must still be displayable.
    const lineage = buildSessionLineage(
      [{ id: "lonely", agentKind: "code", parentSessionId: "pruned", status: "completed" }],
      "lonely",
    );
    expect(lineage.orphaned).toBe(true);
    expect(lineage.ancestors).toEqual([]);
  });

  it("stops on a lineage cycle", () => {
    const lineage = buildSessionLineage([
      { id: "a", agentKind: "code", parentSessionId: "b", status: "running" },
      { id: "b", agentKind: "code", parentSessionId: "a", status: "running" },
    ], "a");
    expect(lineage.orphaned).toBe(true);
    expect(lineage.ancestors.length).toBeLessThanOrEqual(2);
  });

  it("handles an unknown session id", () => {
    const lineage = buildSessionLineage(SESSIONS, "nope");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.descendants).toEqual([]);
    expect(lineage.orphaned).toBe(false);
  });
});

describe("child context key namespacing", () => {
  it("round-trips a namespaced key", () => {
    const key = namespaceChildContextKey("child-a", "analysis");
    expect(key).toBe("sub:child-a:analysis");
    expect(parseChildContextKey(key)).toEqual({ childId: "child-a", key: "analysis" });
  });

  it("keeps a colon inside the original key intact", () => {
    const parsed = parseChildContextKey(namespaceChildContextKey("c1", "step:result"));
    expect(parsed).toEqual({ childId: "c1", key: "step:result" });
  });

  it("rejects keys that are not child-scoped or are malformed", () => {
    expect(parseChildContextKey("analysis")).toBeUndefined();
    expect(parseChildContextKey("sub::analysis")).toBeUndefined();
    expect(parseChildContextKey("sub:child-a:")).toBeUndefined();
    expect(parseChildContextKey("sub:child-a")).toBeUndefined();
  });

  it("detects a child writing outside its own scope", () => {
    expect(isForeignContextWrite("child-a", "sub:child-a:analysis")).toBe(false);
    // Unnamespaced means parent scope, and another child's namespace is not ours.
    expect(isForeignContextWrite("child-a", "analysis")).toBe(true);
    expect(isForeignContextWrite("child-a", "sub:child-b:analysis")).toBe(true);
  });
});
