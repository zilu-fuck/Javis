import { describe, expect, it, vi } from "vitest";
import type { CommanderTool } from "@javis/tools";
import { safeSynthesizeConclusion } from "./workflow-executor";

function commanderWithSynthesis(
  synthesize: NonNullable<CommanderTool["synthesize"]>,
): CommanderTool {
  return {
    plan: vi.fn() as unknown as CommanderTool["plan"],
    synthesize,
  };
}

describe("safeSynthesizeConclusion evidence guard", () => {
  it("accepts concrete claims whose path and count occur in evidence", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The entry point is src/main.ts; 3 files were scanned.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"], count: 3 } },
    )).resolves.toEqual({
      message: "The entry point is src/main.ts; 3 files were scanned.",
    });
  });

  it("rejects unsupported URLs, paths, and numeric claims", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Use https://evil.example/api; 999 files were changed in src/evil.ts.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"], count: 3 } },
    )).resolves.toBeUndefined();
  });

  it("rejects fluent prose with no substantive overlap when evidence exists", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The project uses React and has a secure deployment architecture.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"], count: 3 } },
    )).resolves.toBeUndefined();
  });

  it("rejects an unsupported clause even when another clause has a supported anchor", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The entry point is src/main.ts, and the project uses PostgreSQL.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"] } },
    )).resolves.toBeUndefined();
  });

  it("does not treat user-goal paths as factual evidence", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "src/main.ts contains a production-grade payment system.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "summarize src/main.ts",
      "Project summary",
      { userGoal: "summarize src/main.ts", scan: { keyFiles: [] } },
    )).resolves.toBeUndefined();
  });

  it("splits an unsupported English clause without requiring a comma", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The entry point is src/main.ts and the project uses PostgreSQL.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"] } },
    )).resolves.toBeUndefined();
  });

  it("accepts supported Chinese claims using bounded CJK token overlap", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "代码证据足够支撑项目功能结论。",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "总结项目",
      "项目总结",
      { review: { summary: "代码证据足够支撑项目功能结论。" } },
    )).resolves.toEqual({ message: "代码证据足够支撑项目功能结论。" });
  });

  it("rejects an unsupported Chinese clause after a supported anchor", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "入口位于 src/main.ts，并采用分布式微服务架构。",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "总结项目",
      "项目总结",
      { scan: { keyFiles: ["src/main.ts"] } },
    )).resolves.toBeUndefined();
  });

  it("does not let a trailing uncertainty word excuse an unsupported claim", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The project uses PostgreSQL. Unknown.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"], count: 3 } },
    )).resolves.toBeUndefined();
  });

  it("accepts a pure uncertainty conclusion when evidence is inconclusive", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Unknown.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { keyFiles: ["src/main.ts"], count: 3 } },
    )).resolves.toEqual({ message: "Unknown." });
  });

  it("keeps generic direct answers when no evidence was collected", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Here is the direct answer.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Answer directly",
      "Direct answer",
      {},
    )).resolves.toEqual({ message: "Here is the direct answer." });
  });

  it("rejects factual claims when no trusted evidence was collected", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The project uses React and PostgreSQL.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      {},
    )).resolves.toBeUndefined();
  });

  it("accepts a direct_response capability overview with no evidence", async () => {
    // Reproduction for the "你能干些什么" failure: a direct_response step
    // answers from model knowledge; the evidence-free gate used to reject
    // every positive informational answer.
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async (_request) => {
      expect(_request.directResponse).toBe(true);
      return {
        message: "我可以帮你检查和分析项目代码、整理文档、搜索本地文件和网页内容，也能操作桌面应用和安排定时任务。你想从哪一类开始？",
      };
    });

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "你能干些什么",
      "能力概览",
      {},
      undefined,
      undefined,
      { directResponse: true },
    )).resolves.toEqual({
      message: "我可以帮你检查和分析项目代码、整理文档、搜索本地文件和网页内容，也能操作桌面应用和安排定时任务。你想从哪一类开始？",
    });
  });

  it("keeps evidence grounding for direct_response steps that declared inputs", async () => {
    // A direct_response step that DOES declare inputContextKeys receives
    // real evidence; the full anchor and clause checks apply (the executor
    // passes only declared inputs, never residual runtime metadata, so an
    // evidence-bearing direct_response answer cannot dodge the guard).
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "我是 Javis。比如你可以说\"在这个工作区里看看项目结构\"、\"帮我评审最近的改动\"。",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "你能干些什么",
      "能力概览",
      { workspaceInventory: { entries: [] } },
      undefined,
      undefined,
      { directResponse: true },
    )).resolves.toBeUndefined();
  });

  it("still rejects evidence-free factual claims when the step is not direct_response", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "我可以帮你检查和分析项目代码、整理文档、搜索本地文件和网页内容。",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "你能干些什么",
      "能力概览",
      {},
    )).resolves.toBeUndefined();
  });

  it("reports rejection reasons and the draft excerpt through onDiagnostic", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "The project uses React and PostgreSQL.",
    }));
    const diagnostics: string[] = [];

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      {},
      undefined,
      undefined,
      { onDiagnostic: (detail) => diagnostics.push(detail) },
    )).resolves.toBeUndefined();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("no evidence was collected");
    expect(diagnostics[0]).toContain("The project uses React and PostgreSQL.");
  });

  it("reports failed model calls through onDiagnostic", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => {
      throw new Error("provider offline");
    });
    const diagnostics: string[] = [];

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the project",
      "Project summary",
      { scan: { count: 3 } },
      undefined,
      undefined,
      { onDiagnostic: (detail) => diagnostics.push(detail) },
    )).resolves.toBeUndefined();

    expect(diagnostics).toEqual(["Commander synthesis model call failed: provider offline"]);
  });

  it("accepts uncertainty answers that mention counts even with no evidence", async () => {
    // The anchor gate used to run before the uncertainty gate, so any
    // uncertainty answer containing a number ("2 个候选路径") was rejected
    // as an unsupported claim even though there was nothing to compare.
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "目前缺少相关证据，无法确定项目使用的框架；你可以提供 2 个候选路径让我检查。",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "这个项目用什么框架",
      "框架确认",
      {},
    )).resolves.toEqual({
      message: "目前缺少相关证据，无法确定项目使用的框架；你可以提供 2 个候选路径让我检查。",
    });
  });

  it("does not treat completion acknowledgements as evidence when no tools ran", async () => {
    for (const message of ["Done.", "Javis completed the database migration task."]) {
      const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({ message }));
      await expect(safeSynthesizeConclusion(
        commanderWithSynthesis(synthesize),
        "Summarize the task",
        "Task summary",
        {},
      )).resolves.toBeUndefined();
    }
  });

  it("rejects conclusions whose polarity contradicts the evidence", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Feature is enabled and deployment is approved.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the deployment",
      "Deployment summary",
      { review: { summary: "Feature is not enabled and deployment is not approved." } },
    )).resolves.toBeUndefined();
  });

  it("checks polarity independently across comma-separated relations", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Feature is enabled, deployment is not approved.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the deployment",
      "Deployment summary",
      { review: { summary: "Feature is not enabled, deployment is approved." } },
    )).resolves.toBeUndefined();
  });

  it("rejects Chinese conclusions whose polarity contradicts the evidence", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "\u7cfb\u7edf\u5f53\u524d\u529f\u80fd\u5df2\u542f\u7528\uff0c\u90e8\u7f72\u6d41\u7a0b\u5df2\u6279\u51c6\u3002",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the deployment",
      "Deployment summary",
      { review: { summary: "\u7cfb\u7edf\u5f53\u524d\u529f\u80fd\u672a\u542f\u7528\uff0c\u90e8\u7f72\u6d41\u7a0b\u672a\u6279\u51c6\u3002" } },
    )).resolves.toBeUndefined();
  });

  it("rejects definite conclusions supported only by disputed claims", async () => {
    const synthesize = vi.fn<NonNullable<CommanderTool["synthesize"]>>(async () => ({
      message: "Alice approved deployment.",
    }));

    await expect(safeSynthesizeConclusion(
      commanderWithSynthesis(synthesize),
      "Summarize the deployment",
      "Deployment summary",
      { review: { summary: "A false rumor claims Alice approved deployment." } },
    )).resolves.toBeUndefined();
  });
});
