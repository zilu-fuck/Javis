import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PREFIX_TOOLS,
  DEFAULT_MIN_CALLS_TO_KEEP,
  diffToolPrefix,
  planToolDeferral,
  searchDeferredTools,
  type DeferrableTool,
} from "./tool-deferral";

function tool(
  name: string,
  overrides: Partial<Omit<DeferrableTool, "name">> = {},
): DeferrableTool {
  return {
    name,
    summary: `Does ${name}.`,
    capabilityTags: [name.split(".")[0]],
    ownerAgentKinds: ["code"],
    ...overrides,
  };
}

/** A registry resembling a workspace with several MCP servers attached. */
const REGISTRY: DeferrableTool[] = [
  tool("tools.search", { ownerAgentKinds: ["commander"], capabilityTags: ["tool_discovery"] }),
  tool("code.inspectWorkspace", { capabilityTags: ["code_inspect"] }),
  tool("code.searchRepository", { capabilityTags: ["code_search"] }),
  tool("file.writeText", { capabilityTags: ["file_write"], ownerAgentKinds: ["file"] }),
  tool("pdf.organizeFiles", { capabilityTags: ["pdf_move"], ownerAgentKinds: ["file"], summary: "Moves PDF files listed in an approved plan." }),
  tool("web.search", { capabilityTags: ["web_search"], ownerAgentKinds: ["research"] }),
  tool("computer.screenshot", { capabilityTags: ["computer_use"], ownerAgentKinds: ["computer"] }),
];

describe("planToolDeferral", () => {
  it("keeps pinned tools and the current agent's tools, and defers the rest", () => {
    const result = planToolDeferral(REGISTRY, {
      alwaysInclude: ["tools.search"],
      currentAgentKind: "code",
    });
    const prefix = result.prefix.map((entry) => entry.name);
    expect(prefix).toContain("tools.search");
    expect(prefix).toContain("code.inspectWorkspace");
    expect(prefix).toContain("code.searchRepository");
    expect(result.deferred.map((entry) => entry.name)).toContain("pdf.organizeFiles");
    expect(result.reasons["tools.search"]).toContain("pinned");
    expect(result.reasons["code.searchRepository"]).toContain('owned by the current agent kind "code"');
    expect(result.reasons["pdf.organizeFiles"]).toBe("no recorded usage");
  });

  it("pins by capability tag as well as by name", () => {
    const result = planToolDeferral(REGISTRY, { alwaysIncludeTags: ["file_write"] });
    expect(result.prefix.map((entry) => entry.name)).toContain("file.writeText");
    expect(result.reasons["file.writeText"]).toContain('capability tag "file_write"');
  });

  it("keeps a frequently used tool even when nothing else selects it", () => {
    const result = planToolDeferral(REGISTRY, {
      currentAgentKind: "code",
      usage: { "pdf.organizeFiles": DEFAULT_MIN_CALLS_TO_KEEP },
    });
    expect(result.prefix.map((entry) => entry.name)).toContain("pdf.organizeFiles");
    expect(result.reasons["pdf.organizeFiles"]).toContain("at or above the keep threshold");
  });

  it("is a pure function of its inputs: same inputs, identical prefix", () => {
    // This is the property the whole design rests on. A prefix that varies run to run
    // invalidates the provider's cached prefix on every turn, which is the cost this
    // module exists to avoid.
    const policy = { alwaysInclude: ["tools.search"], currentAgentKind: "code", usage: { "web.search": 9 } };
    const first = planToolDeferral(REGISTRY, policy);
    const shuffled = planToolDeferral([...REGISTRY].reverse(), policy);
    const again = planToolDeferral(REGISTRY, policy);
    expect(shuffled.prefix.map((entry) => entry.name)).toEqual(first.prefix.map((entry) => entry.name));
    expect(again.prefix.map((entry) => entry.name)).toEqual(first.prefix.map((entry) => entry.name));
    expect(diffToolPrefix(first.prefix, again.prefix).changed).toBe(false);
  });

  it("orders pinned first, then the agent's tools, then by usage", () => {
    const result = planToolDeferral(REGISTRY, {
      alwaysInclude: ["tools.search"],
      currentAgentKind: "code",
      usage: { "web.search": 10, "pdf.organizeFiles": 5 },
      minCallsToKeep: 1,
    });
    const prefix = result.prefix.map((entry) => entry.name);
    expect(prefix[0]).toBe("tools.search");
    // Most-used ranks above less-used.
    expect(prefix.indexOf("web.search")).toBeLessThan(prefix.indexOf("pdf.organizeFiles"));
  });

  it("enforces the cap and defers the overflow instead of dropping it", () => {
    const result = planToolDeferral(REGISTRY, {
      alwaysInclude: ["tools.search"],
      currentAgentKind: "code",
      maxPrefixTools: 2,
    });
    expect(result.prefix).toHaveLength(2);
    // Nothing disappears: every tool is in exactly one of the two lists.
    const total = result.prefix.length + result.deferred.length;
    expect(total).toBe(REGISTRY.length);
    const overflowed = result.deferred.map((entry) => entry.name);
    expect(result.reasons[overflowed[0]]).toContain("cap");
  });

  it("states how many tools are hidden, and says nothing when none are", () => {
    const withDeferral = planToolDeferral(REGISTRY, { currentAgentKind: "code" });
    expect(withDeferral.notice).toContain(`${withDeferral.deferred.length} further tool(s)`);

    const allPinned = planToolDeferral(REGISTRY, {
      alwaysInclude: REGISTRY.map((entry) => entry.name),
    });
    expect(allPinned.deferred).toEqual([]);
    expect(allPinned.notice).toBe("");
  });

  it("handles an empty registry and a zero cap", () => {
    expect(planToolDeferral([])).toMatchObject({ prefix: [], deferred: [], notice: "" });
    const zero = planToolDeferral(REGISTRY, { maxPrefixTools: 0, alwaysInclude: ["tools.search"] });
    expect(zero.prefix).toEqual([]);
    expect(zero.deferred).toHaveLength(REGISTRY.length);
  });

  it("never loses or duplicates a tool", () => {
    for (const policy of [
      {},
      { currentAgentKind: "file" },
      { alwaysInclude: ["tools.search"], maxPrefixTools: 3 },
      { alwaysIncludeTags: ["code_search"], maxPrefixTools: 1 },
    ]) {
      const result = planToolDeferral(REGISTRY, policy);
      const names = [...result.prefix, ...result.deferred].map((entry) => entry.name).sort();
      expect(names).toEqual(REGISTRY.map((entry) => entry.name).sort());
    }
    expect(DEFAULT_MAX_PREFIX_TOOLS).toBe(24);
  });
});

describe("searchDeferredTools", () => {
  it("finds a deferred tool by name", () => {
    const { deferred } = planToolDeferral(REGISTRY, { currentAgentKind: "code" });
    const matches = searchDeferredTools(deferred, "pdf.organizeFiles");
    expect(matches[0].tool.name).toBe("pdf.organizeFiles");
    expect(matches[0].matchedOn).toBe("name");
  });

  it("ranks a name match above a capability tag above summary prose", () => {
    const deferred = [
      tool("acme.sendReport", { summary: "Sends a report.", capabilityTags: ["acme_report"] }),
      tool("acme.reportStatus", { summary: "Checks status.", capabilityTags: ["status"] }),
      tool("other.thing", { summary: "Produces a report of results.", capabilityTags: ["misc"] }),
    ];
    const matches = searchDeferredTools(deferred, "report");
    const order = matches.map((match) => match.tool.name);
    expect(order[0]).toBe("acme.reportStatus"); // exact capability token
    expect(order).toContain("other.thing");     // summary-only match still discoverable
    expect(matches.find((match) => match.tool.name === "other.thing")?.matchedOn).toBe("summary");
  });

  it("returns nothing for an empty or punctuation-only query", () => {
    const deferred = [tool("pdf.organizeFiles")];
    expect(searchDeferredTools(deferred, "")).toEqual([]);
    expect(searchDeferredTools(deferred, "   ")).toEqual([]);
  });

  it("respects the limit and stays deterministic", () => {
    const deferred = Array.from({ length: 30 }, (_, index) => tool(`acme.tool${index}`, { summary: "report tool" }));
    const matches = searchDeferredTools(deferred, "report", { limit: 5 });
    expect(matches).toHaveLength(5);
    expect(searchDeferredTools(deferred, "report", { limit: 5 }).map((m) => m.tool.name))
      .toEqual(matches.map((m) => m.tool.name));
  });

  it("does not match a single-character token into everything", () => {
    const deferred = [tool("any.tool", { summary: "a b c" })];
    expect(searchDeferredTools(deferred, "a")).toEqual([]);
  });
});

describe("diffToolPrefix", () => {
  it("reports an unchanged prefix", () => {
    const prefix = [tool("a.b"), tool("c.d")];
    expect(diffToolPrefix(prefix, prefix)).toEqual({ added: [], removed: [], changed: false });
  });

  it("reports which tools entered and left, which is the cache-invalidating event", () => {
    const before = [tool("a.b"), tool("c.d")];
    const after = [tool("a.b"), tool("e.f")];
    const diff = diffToolPrefix(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(["e.f"]);
    expect(diff.removed).toEqual(["c.d"]);
  });

  it("ignores reordering, matching how the prefix is actually rendered", () => {
    const before = [tool("a.b"), tool("c.d")];
    const after = [tool("c.d"), tool("a.b")];
    // Ordering is pinned by `planToolDeferral`, so a reorder is not a real change here;
    // the diff compares membership, which is what the provider caches on.
    expect(diffToolPrefix(before, after).changed).toBe(false);
  });
});
