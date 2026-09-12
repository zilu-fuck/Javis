import { describe, expect, it } from "vitest";
import type { TokenUsageSummary } from "@javis/tools";
import {
  HIGH_CONTEXT_UTILIZATION_THRESHOLD,
  LOW_CACHE_HIT_RATE_THRESHOLD,
  computeCacheHitRate,
  computeContextUtilization,
  estimateUsageCost,
  formatUsagePanel,
} from "./usage-panel";

function summary(overrides: Partial<TokenUsageSummary> = {}): TokenUsageSummary {
  return {
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    modelCalls: 3,
    byAgentKind: [
      { agentKind: "commander", inputTokens: 6_000, outputTokens: 1_500, totalTokens: 7_500, modelCalls: 2 },
      { agentKind: "code", inputTokens: 4_000, outputTokens: 500, totalTokens: 4_500, modelCalls: 1 },
    ],
    ...overrides,
  };
}

describe("usage ratios", () => {
  it("computes the cache hit rate against total input", () => {
    expect(computeCacheHitRate(summary({ cacheReadTokens: 6_000 }))).toBeCloseTo(0.6);
  });

  it("returns no hit rate when the provider reported nothing, rather than 0%", () => {
    // 0% would read as "caching is broken" when the truth is "not reported".
    expect(computeCacheHitRate(summary())).toBeUndefined();
    expect(computeCacheHitRate(summary({ inputTokens: 0 }))).toBeUndefined();
    // A cache *write* alone still proves the provider is reporting cache activity.
    expect(computeCacheHitRate(summary({ cacheWriteTokens: 5_000 }))).toBe(0);
  });

  it("never reports a hit rate above 100%", () => {
    expect(computeCacheHitRate(summary({ inputTokens: 1_000, cacheReadTokens: 5_000 }))).toBe(1);
  });

  it("computes context utilization only when both numbers are known", () => {
    expect(computeContextUtilization(summary({ contextUsedTokens: 8_000, contextWindowTokens: 16_000 })))
      .toBeCloseTo(0.5);
    expect(computeContextUtilization(summary({ contextUsedTokens: 8_000 }))).toBeUndefined();
    expect(computeContextUtilization(summary({ contextWindowTokens: 0, contextUsedTokens: 1 }))).toBeUndefined();
  });
});

describe("cost estimation", () => {
  it("charges cached tokens at the cache price, not the input price", () => {
    const cost = estimateUsageCost(
      summary({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }),
      { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 1 },
    );
    // Entirely cached: uncached input is zero, so only the cache price applies.
    expect(cost).toBeCloseTo(1);
  });

  it("splits uncached, cache-read and cache-write input", () => {
    const cost = estimateUsageCost(
      summary({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 200_000 }),
      { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 },
    );
    // 200k uncached @10 = 2 ; 600k read @1 = 0.6 ; 200k write @12.5 = 2.5 ; 1M out @30 = 30
    expect(cost).toBeCloseTo(35.1, 3);
  });

  it("falls back to the input price when cache prices are not supplied", () => {
    const cost = estimateUsageCost(
      summary({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }),
      { inputPerMillion: 10, outputPerMillion: 30 },
    );
    expect(cost).toBeCloseTo(10);
  });
});

describe("formatUsagePanel", () => {
  it("shows tokens, cache rate and context utilization when available", () => {
    const panel = formatUsagePanel(summary({
      cacheReadTokens: 6_000,
      contextUsedTokens: 8_000,
      contextWindowTokens: 32_000,
    }));
    expect(panel.cacheHitRate).toBeCloseTo(0.6);
    expect(panel.contextUtilization).toBeCloseTo(0.25);
    const cache = panel.lines.find((line) => line.id === "cache");
    expect(cache?.value).toBe("60%");
    expect(panel.lines.find((line) => line.id === "context")?.value).toBe("25%");
    // The only caveat is the missing price table: neither the cache rate nor the
    // context utilization is in a warning range here.
    expect(panel.caveats).toHaveLength(1);
    expect(panel.caveats[0]).toContain("ships no price table");
  });

  it("explains a missing cache report instead of printing 0%", () => {
    const panel = formatUsagePanel(summary());
    expect(panel.cacheHitRate).toBeUndefined();
    expect(panel.lines.find((line) => line.id === "cache")?.value).toBe("no data");
    expect(panel.caveats.join(" ")).toContain("reported no prefix-cache usage");
  });

  it("flags a low hit rate and a nearly full context separately", () => {
    const low = formatUsagePanel(summary({ cacheReadTokens: 500 }));
    expect(low.caveats.join(" ")).toContain(`Low hit rate`);

    const full = formatUsagePanel(summary({
      contextUsedTokens: Math.ceil(32_000 * (HIGH_CONTEXT_UTILIZATION_THRESHOLD + 0.05)),
      contextWindowTokens: 32_000,
    }));
    expect(full.caveats.join(" ")).toContain("may be rejected for length");
    expect(LOW_CACHE_HIT_RATE_THRESHOLD).toBeLessThan(HIGH_CONTEXT_UTILIZATION_THRESHOLD);
  });

  it("names the heaviest agent", () => {
    const panel = formatUsagePanel(summary());
    expect(panel.lines.find((line) => line.id === "agents")?.value).toContain("commander");
  });

  it("says why there is no cost line instead of inventing one", () => {
    const panel = formatUsagePanel(summary());
    expect(panel.estimatedCost).toBeUndefined();
    expect(panel.lines.some((line) => line.id === "cost")).toBe(false);
    expect(panel.caveats.join(" ")).toContain("ships no price table");
  });

  it("adds a cost line when prices are supplied", () => {
    const panel = formatUsagePanel(summary(), {
      pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: "CNY" },
    });
    const cost = panel.lines.find((line) => line.id === "cost");
    expect(cost).toBeDefined();
    expect(cost?.value).toContain("CNY");
    expect(panel.estimatedCost).toBeGreaterThan(0);
    expect(panel.caveats.join(" ")).not.toContain("no price table");
  });

  it("renders in Chinese", () => {
    const panel = formatUsagePanel(summary({ cacheReadTokens: 6_000 }), { locale: "zhCN" });
    expect(panel.lines.find((line) => line.id === "cache")?.label).toBe("前缀缓存命中率");
    expect(panel.lines[0].label).toBe("Token 用量");
  });

  it("handles an empty summary without throwing", () => {
    const panel = formatUsagePanel({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      modelCalls: 0,
      byAgentKind: [],
    });
    expect(panel.lines.length).toBeGreaterThan(0);
    expect(panel.estimatedCost).toBeUndefined();
  });
});
