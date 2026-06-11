import { describe, expect, it, vi } from "vitest";
import { fetchTrendHotList } from "./trending-service";

describe("fetchTrendHotList", () => {
  it("dispatches to a provider adapter and normalizes hot list items", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          realtime: [
            {
              word: "AI 新闻",
              word_scheme: "AI 新闻",
              raw_hot: 123456,
              label_name: "hot",
              category: "tech",
            },
            {
              note: "第二条",
              num: 42,
            },
          ],
        },
      }),
    } as Response));

    const result = await fetchTrendHotList(
      { provider: "weibo", limit: 2 },
      {
        fetchImpl,
        now: () => new Date("2026-06-10T00:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      provider: "weibo",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      expectedCount: 2,
      complete: true,
      warnings: [],
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({
      provider: "weibo",
      sourceUrl: "https://weibo.com/ajax/side/hotSearch",
      requestedLimit: 2,
      status: "completed",
      httpStatus: 200,
      itemCount: 2,
    })]);
    expect(result.items).toEqual([
      expect.objectContaining({
        rank: 1,
        title: "AI 新闻",
        hotScore: 123456,
        label: "hot",
        category: "tech",
      }),
      expect.objectContaining({
        rank: 2,
        title: "第二条",
        hotScore: 42,
      }),
    ]);
    expect(result.items[0]?.url).toContain("https://s.weibo.com/weibo?q=");
  });

  it("reports incomplete hot lists", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          realtime: [{ word: "only one" }],
        },
      }),
    } as Response));

    const result = await fetchTrendHotList({ provider: "weibo", limit: 3 }, { fetchImpl });

    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.warnings[0]).toContain("Expected 3");
  });

  it("tries fallback providers and preserves failed attempt diagnostics", async () => {
    const result = await fetchTrendHotList({
      provider: "primary",
      fallbackProviders: ["fallback"],
      limit: 2,
    }, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => new Date("2026-06-10T00:00:00.000Z"),
      adapters: [{
        provider: "primary",
        fetchHotList: async () => {
          throw new Error("primary failed");
        },
      }, {
        provider: "fallback",
        fetchHotList: async (request) => ({
          provider: request.provider,
          fetchedAt: "2026-06-10T00:00:01.000Z",
          sourceUrl: "https://example.test/fallback",
          items: [{ rank: 1, title: "fallback item" }],
          expectedCount: 2,
          complete: false,
          warnings: ["Expected 2 hot list item(s), but only 1 were returned."],
          diagnostics: [{
            provider: "fallback",
            sourceUrl: "https://example.test/fallback",
            requestedLimit: 2,
            startedAt: "2026-06-10T00:00:00.000Z",
            finishedAt: "2026-06-10T00:00:01.000Z",
            durationMs: 1000,
            status: "completed",
            httpStatus: 200,
            itemCount: 1,
          }],
        }),
      }],
    });

    expect(result.provider).toBe("fallback");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        provider: "primary",
        status: "failed",
        errorKind: "unknown",
        error: "primary failed",
      }),
      expect.objectContaining({
        provider: "fallback",
        status: "completed",
        itemCount: 1,
      }),
    ]);
  });

  it("fails clearly when the endpoint returns an error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response));

    await expect(fetchTrendHotList({ provider: "weibo" }, { fetchImpl }))
      .rejects.toMatchObject({
        name: "TrendFetchError",
        diagnostic: expect.objectContaining({
          provider: "weibo",
          status: "failed",
          httpStatus: 503,
          errorKind: "http",
        }),
      });
  });

  it("attaches parse diagnostics when a provider payload cannot be read", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response));

    await expect(fetchTrendHotList({ provider: "weibo" }, { fetchImpl }))
      .rejects.toMatchObject({
        diagnostic: expect.objectContaining({
          status: "failed",
          errorKind: "parse",
          httpStatus: 200,
          error: "invalid json",
        }),
      });
  });

  it("fails clearly for unsupported providers instead of falling back implicitly", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response));

    await expect(fetchTrendHotList(
      { provider: "unknown" },
      { fetchImpl },
    )).rejects.toMatchObject({
      name: "TrendFetchError",
      diagnostics: [expect.objectContaining({
        provider: "unknown",
        status: "failed",
        errorKind: "unsupported_provider",
      })],
      diagnostic: expect.objectContaining({
        provider: "unknown",
        status: "failed",
        errorKind: "unsupported_provider",
      }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
