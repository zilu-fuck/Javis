import type { CommanderTool } from "@javis/tools";
import { describe, expect, it, vi } from "vitest";
import type { FlowController } from "./flow-controller";
import { createInitialTaskSnapshot, type TaskSnapshot } from "./index";
import {
  buildResearchSearchQuery,
  resolveResearchSourceUrls,
  runResearchSearchTask,
  runResearchSourceTask,
} from "./research-flow";

function createTestController(): {
  controller: FlowController;
  getSnapshot: () => TaskSnapshot;
} {
  let snapshot = createInitialTaskSnapshot();
  return {
    controller: {
      emit(nextSnapshot) {
        snapshot = nextSnapshot;
      },
      getSnapshot() {
        return snapshot;
      },
      async wait() {},
    },
    getSnapshot: () => snapshot,
  };
}

describe("research evidence gate", () => {
  it("builds focused queries from short natural prompts and resolves recent page URLs", () => {
    expect(buildResearchSearchQuery("用浏览器查信息：Javis 最新资料")).toBe("Javis 最新资料");
    expect(buildResearchSearchQuery("最近 AI 工具有啥新闻？")).toBe("AI 工具 最新新闻");
    expect(resolveResearchSourceUrls("这个网页讲啥", [
      { content: "先看 https://example.test/older" },
      { content: "当前链接是 https://example.test/current。" },
    ])).toEqual(["https://example.test/current"]);
    expect(resolveResearchSourceUrls("最近 AI 工具有啥新闻", [
      { content: "https://example.test/unrelated" },
    ])).toEqual([]);
  });

  it("fails verification and skips Commander synthesis for whitespace evidence", async () => {
    const synthesize = vi.fn(async () => ({ message: "Unsupported synthesis" }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan is not used by the deterministic research flow");
      }),
      synthesize,
    };
    const { controller, getSnapshot } = createTestController();

    await runResearchSourceTask({
      controller,
      taskId: "research-invalid-evidence",
      userGoal: "Compare https://example.test/whitespace",
      webTool: {
        fetchWebSource: vi.fn(async ({ url }) => ({
          url,
          title: "Whitespace source",
          excerpt: " \t\n ",
          fetchedAt: "2026-07-12T00:00:00.000Z",
        })),
      },
      commanderTool,
    });

    const finalSnapshot = getSnapshot();
    expect(finalSnapshot.status).toBe("failed");
    expect(finalSnapshot.title).toBe("Research source verification failed");
    expect(finalSnapshot.researchReport?.rows[0]).toMatchObject({
      status: "unknown",
      evidence: "",
      verificationStatus: "unknown",
    });
    expect(finalSnapshot.verificationSummary).toContain("source-1:missing_excerpt");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("allows synthesis only after source and claim evidence pass", async () => {
    const synthesize = vi.fn(async () => ({
      message: "Javis exposes a source-backed research flow.",
    }));
    const commanderTool: CommanderTool = {
      plan: vi.fn(async () => {
        throw new Error("plan is not used by the deterministic research flow");
      }),
      synthesize,
    };
    const { controller, getSnapshot } = createTestController();

    await runResearchSourceTask({
      controller,
      taskId: "research-valid-evidence",
      userGoal: "Compare https://example.test/grounded",
      webTool: {
        fetchWebSource: vi.fn(async ({ url }) => ({
          url,
          title: "Grounded source",
          excerpt: "Javis exposes a read-only source-backed research flow.",
          fetchedAt: "2026-07-12T00:00:00.000Z",
        })),
      },
      commanderTool,
    });

    const finalSnapshot = getSnapshot();
    expect(finalSnapshot.status).toBe("completed");
    expect(finalSnapshot.commanderMessage).toBe(
      "Javis exposes a source-backed research flow.",
    );
    expect(finalSnapshot.researchReport?.rows[0]?.verificationStatus).toBe("verified");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a manual fetch returns a different URL", async () => {
    const synthesize = vi.fn(async () => ({ message: "Unsupported synthesis" }));
    const { controller, getSnapshot } = createTestController();

    await runResearchSourceTask({
      controller,
      taskId: "research-url-substitution",
      userGoal: "Compare https://example.test/requested",
      webTool: {
        fetchWebSource: vi.fn(async () => ({
          url: "https://evil.example/substitute",
          title: "Substituted source",
          excerpt: "This source must not be accepted for the requested URL evidence.",
          fetchedAt: "2026-07-12T00:00:00.000Z",
        })),
      },
      commanderTool: {
        plan: vi.fn(),
        synthesize,
      },
    });

    expect(getSnapshot().status).toBe("failed");
    expect(getSnapshot().title).toBe("Research source collection failed");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("fails closed when a searched fetch returns a different URL", async () => {
    const synthesize = vi.fn(async () => ({ message: "Unsupported synthesis" }));
    const { controller, getSnapshot } = createTestController();

    await runResearchSearchTask({
      controller,
      taskId: "research-search-url-substitution",
      userGoal: "Find evidence for the requested project",
      webTool: {
        searchWeb: vi.fn(async () => [{
          url: "https://example.test/requested",
          title: "Requested result",
          excerpt: "Search result excerpt is only a candidate until fetched.",
          fetchedAt: "2026-07-12T00:00:00.000Z",
          provider: "fixture",
        }]),
        fetchWebSource: vi.fn(async () => ({
          url: "https://evil.example/substitute",
          title: "Substituted source",
          excerpt: "This source must not be accepted for the requested URL evidence.",
          fetchedAt: "2026-07-12T00:00:00.000Z",
          provider: "fixture",
        })),
      },
      commanderTool: {
        plan: vi.fn(),
        synthesize,
      },
    });

    expect(getSnapshot().status).toBe("failed");
    expect(getSnapshot().title).toBe("Research search failed");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("binds report evidence to fetched content while retaining search provenance", async () => {
    const searchWeb = vi.fn(async () => [{
      url: "https://example.test/article",
      title: "Search candidate",
      excerpt: "Candidate snippets are not accepted as final page evidence.",
      fetchedAt: "2026-07-12T00:00:00.000Z",
      provider: "test-search",
    }]);
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: "Fetched article",
      excerpt: "The fetched article contains the complete source-backed evidence used in the report.",
      fetchedAt: "2026-07-12T00:01:00.000Z",
      provider: "page-fetch",
    }));
    const { controller, getSnapshot } = createTestController();

    await runResearchSearchTask({
      controller,
      taskId: "research-fetched-provenance",
      userGoal: "用浏览器查信息：Javis 最新资料",
      webTool: { searchWeb, fetchWebSource },
    });

    const finalSnapshot = getSnapshot();
    expect(finalSnapshot.status).toBe("completed");
    expect(searchWeb).toHaveBeenCalledWith({ query: "Javis 最新资料", maxResults: 3 });
    expect(finalSnapshot.researchReport?.rows[0]).toMatchObject({
      sourceUrl: "https://example.test/article",
      sourceProvider: "test-search",
      evidence: "The fetched article contains the complete source-backed evidence used in the report.",
    });
    expect(finalSnapshot.researchReport?.rows[0]?.evidence).not.toContain("Candidate snippets");
  });
});
