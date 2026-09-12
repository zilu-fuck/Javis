/**
 * Tool deferral and search (C5).
 *
 * Every connected MCP server adds its tools to the model's system prompt. Those tools
 * sit in the *cacheable prefix*, so two costs compound: the prefix grows with tools the
 * task will never call, and any change to the tool list invalidates the whole cached
 * prefix. The measured effect of the second one is already visible in this repository:
 * low cache hit rates on long tasks.
 *
 * The strategy is the one search tools use: keep a small, stable core of tools in the
 * prefix, and make everything else reachable through a search tool. Two properties make
 * that safe rather than merely smaller:
 *
 *  * **stability over cleverness** — the prefix is a pure function of its inputs, so the
 *    same situation produces byte-identical tool lists and the cache survives. A
 *    "helpful" reordering would defeat the entire exercise, so ordering is pinned and
 *    `diffToolPrefix` reports exactly which tools entered or left.
 *  * **nothing becomes unreachable** — a deferred tool is still discoverable by name,
 *    capability tag or summary, and the notice in the prefix states how many are hidden.
 *
 * This module computes the partition; it does not perform the search call itself.
 */

export interface DeferrableTool {
  name: string;
  summary: string;
  capabilityTags: string[];
  ownerAgentKinds: string[];
}

export interface ToolDeferralPolicy {
  /**
   * Tools that must always stay in the prefix (typically the search tool itself and
   * anything needed before a search can happen).
   */
  alwaysInclude?: readonly string[];
  /** Never defer these capability tags. */
  alwaysIncludeTags?: readonly string[];
  /** Agent kind driving this task; its own tools stay available. */
  currentAgentKind?: string;
  /** Name → call count observed so far. Absent means "no evidence yet". */
  usage?: Readonly<Record<string, number>>;
  /** A tool used at least this often stays in the prefix. */
  minCallsToKeep?: number;
  /** Upper bound on prefix tools, so the list cannot grow without limit. */
  maxPrefixTools?: number;
}

export interface ToolDeferralResult {
  /** Tools rendered into the system prompt, in a deterministic order. */
  prefix: DeferrableTool[];
  /** Tools reachable through search. */
  deferred: DeferrableTool[];
  /** Why each tool landed where it did, for diagnostics and tests. */
  reasons: Record<string, string>;
  /** One-line note to place in the prefix, or empty when nothing was deferred. */
  notice: string;
}

export const DEFAULT_MIN_CALLS_TO_KEEP = 3;
export const DEFAULT_MAX_PREFIX_TOOLS = 24;

/**
 * Partitions tools into the prefix and the searchable remainder.
 *
 * Ordering is `alwaysInclude` first, then the current agent's tools, then by
 * descending usage, then alphabetically — a total order with no dependence on input
 * order, which is what keeps the cached prefix stable.
 */
export function planToolDeferral(
  tools: readonly DeferrableTool[],
  policy: ToolDeferralPolicy = {},
): ToolDeferralResult {
  const alwaysInclude = new Set(policy.alwaysInclude ?? []);
  const alwaysIncludeTags = new Set(policy.alwaysIncludeTags ?? []);
  const usage = policy.usage ?? {};
  const minCalls = policy.minCallsToKeep ?? DEFAULT_MIN_CALLS_TO_KEEP;
  const maxPrefix = Math.max(0, policy.maxPrefixTools ?? DEFAULT_MAX_PREFIX_TOOLS);

  const reasons: Record<string, string> = {};
  const pinned: DeferrableTool[] = [];
  const byAgent: DeferrableTool[] = [];
  const byUsage: DeferrableTool[] = [];
  const rest: DeferrableTool[] = [];

  for (const tool of tools) {
    if (alwaysInclude.has(tool.name)) {
      reasons[tool.name] = "explicitly pinned to the prefix";
      pinned.push(tool);
      continue;
    }
    const pinnedTag = tool.capabilityTags.find((tag) => alwaysIncludeTags.has(tag));
    if (pinnedTag) {
      reasons[tool.name] = `capability tag "${pinnedTag}" is pinned to the prefix`;
      pinned.push(tool);
      continue;
    }
    if (policy.currentAgentKind && tool.ownerAgentKinds.includes(policy.currentAgentKind)) {
      reasons[tool.name] = `owned by the current agent kind "${policy.currentAgentKind}"`;
      byAgent.push(tool);
      continue;
    }
    const calls = usage[tool.name] ?? 0;
    if (calls >= minCalls) {
      reasons[tool.name] = `used ${calls} time(s), at or above the keep threshold`;
      byUsage.push(tool);
      continue;
    }
    reasons[tool.name] = calls > 0
      ? `used ${calls} time(s), below the keep threshold`
      : "no recorded usage";
    rest.push(tool);
  }

  const byName = (left: DeferrableTool, right: DeferrableTool) => left.name.localeCompare(right.name);
  byAgent.sort(byName);
  byUsage.sort((left, right) => {
    const difference = (usage[right.name] ?? 0) - (usage[left.name] ?? 0);
    return difference !== 0 ? difference : left.name.localeCompare(right.name);
  });
  rest.sort(byName);

  const ranked = [...pinned, ...byAgent, ...byUsage];
  const prefix = ranked.slice(0, maxPrefix);
  // Everything that did not fit the cap is deferred rather than silently dropped.
  const overflow = ranked.slice(maxPrefix);
  for (const tool of overflow) {
    reasons[tool.name] = `kept out of the prefix by the ${maxPrefix}-tool cap`;
  }
  const deferred = [...overflow, ...rest].sort(byName);

  return {
    prefix,
    deferred,
    reasons,
    notice: deferred.length === 0
      ? ""
      : `${deferred.length} further tool(s) are available through the tool search (by name, capability or summary).`,
  };
}

export interface DeferredToolMatch {
  tool: DeferrableTool;
  score: number;
  /** Which field produced the match, for an explainable result. */
  matchedOn: "name" | "capability" | "summary";
}

/**
 * Ranks deferred tools against a query.
 *
 * A name match outweighs a capability tag, which outweighs summary prose — a model
 * searching for `pdf.organizeFiles` should get that tool before a tool that merely
 * mentions "files".
 */
export function searchDeferredTools(
  deferred: readonly DeferrableTool[],
  query: string,
  options: { limit?: number } = {},
): DeferredToolMatch[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  const limit = Math.max(1, options.limit ?? 10);
  const matches: DeferredToolMatch[] = [];

  for (const tool of deferred) {
    const name = tool.name.toLowerCase();
    const tags = tool.capabilityTags.map((tag) => tag.toLowerCase());
    const summary = tool.summary.toLowerCase();

    let score = 0;
    let matchedOn: DeferredToolMatch["matchedOn"] = "summary";
    for (const token of tokens) {
      if (name === token) {
        score += 12;
        matchedOn = "name";
        continue;
      }
      if (name.includes(token)) {
        score += 8;
        matchedOn = matchedOn === "name" ? matchedOn : "name";
        continue;
      }
      if (tags.some((tag) => tag === token || tag.includes(token))) {
        score += 5;
        if (matchedOn === "summary") matchedOn = "capability";
        continue;
      }
      if (summary.includes(token)) {
        score += 2;
      }
    }
    if (score > 0) {
      matches.push({ tool, score, matchedOn });
    }
  }

  return matches
    .sort((left, right) => (right.score - left.score) || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit);
}

export interface ToolPrefixDiff {
  added: string[];
  removed: string[];
  /** True when the prefix changed, which invalidates any cached prefix. */
  changed: boolean;
}

/**
 * Reports how a previous prefix differs from the current one.
 *
 * Changing the tool list invalidates the provider's cached prefix, so this is the
 * signal to watch: a prefix that churns every turn explains a low cache hit rate.
 */
export function diffToolPrefix(
  previous: readonly DeferrableTool[],
  next: readonly DeferrableTool[],
): ToolPrefixDiff {
  const before = new Set(previous.map((tool) => tool.name));
  const after = new Set(next.map((tool) => tool.name));
  const added = [...after].filter((name) => !before.has(name)).sort();
  const removed = [...before].filter((name) => !after.has(name)).sort();
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.filter((token) => token.length > 1) ?? [],
  )];
}
