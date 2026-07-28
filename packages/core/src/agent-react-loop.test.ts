import { describe, expect, it, vi } from "vitest";
import { demoAgents } from "./agents";
import {
  MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS,
  MAX_REACT_REQUESTED_CONTEXT_KEYS,
  MAX_REACT_OBSERVATION_TOTAL_CHARS,
  runAgentReActLoop,
  type AgentReActDecision,
  type AgentReActObservation,
} from "./agent-react-loop";
import { createSharedTaskContext } from "./shared-context";
import type { AgentKind } from "./index";
import type { WorkbenchWorkflowStep } from "./workflows";

describe("runAgentReActLoop", () => {
  it("records backend-neutral legacy run metrics without changing the result", async () => {
    const metrics = vi.fn(() => {
      throw new Error("metrics sink unavailable");
    });
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ sources: [{ url: "https://example.test" }] }),
      }],
      decideNext: vi.fn()
        .mockResolvedValueOnce({
          status: "continue",
          toolName: "file.scanMarkdownDocuments",
          reason: "search",
          usage: { inputTokens: 4, outputTokens: 2 },
        })
        .mockResolvedValueOnce({
          status: "completed",
          reason: "done",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        }),
      onRunMetrics: metrics,
    });

    expect(result.status).toBe("completed");
    expect(result.metrics).toMatchObject({
      backend: "legacy",
      status: "completed",
      modelCalls: 2,
      toolCalls: 1,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(metrics).toHaveBeenCalledWith(result.metrics);
  });

  it("counts dispatched tools on a later model failure and isolates metrics observers", async () => {
    const metrics = vi.fn(() => {
      throw new Error("metrics sink unavailable");
    });
    const decideNext = vi.fn()
      .mockResolvedValueOnce({
        status: "continue",
        toolName: "file.scanMarkdownDocuments",
        reason: "scan",
      })
      .mockRejectedValueOnce(new Error("model unavailable"));

    await expect(runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ sources: [{ url: "https://example.test" }] }),
      }],
      decideNext,
      onRunMetrics: metrics,
    })).rejects.toThrow("model unavailable");

    expect(metrics).toHaveBeenCalledWith(expect.objectContaining({
      backend: "legacy",
      status: "failed",
      modelCalls: 2,
      toolCalls: 1,
    }));
  });

  it("emits ordered requested, started, and terminal events for legacy tools", async () => {
    const toolEvents: Array<{ phase: string; toolCallId: string; toolName: string }> = [];
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [{
        name: "code.inspectRepository",
        execute: async () => ({ changedFiles: ["src/app.ts"] }),
      }, {
        name: "code.searchRepository",
        execute: async () => {
          throw new Error("Search unavailable.");
        },
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "code.inspectRepository", reason: "inspect" }
        : observations.length === 1
          ? { status: "continue", toolName: "code.searchRepository", reason: "search" }
          : { status: "failed", reason: "search failed" },
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(result.status).toBe("failed");
    expect(toolEvents).toEqual([
      { phase: "requested", toolCallId: "react-step:react:1", toolName: "code.inspectRepository" },
      { phase: "started", toolCallId: "react-step:react:1", toolName: "code.inspectRepository" },
      { phase: "completed", toolCallId: "react-step:react:1", toolName: "code.inspectRepository" },
      { phase: "requested", toolCallId: "react-step:react:2", toolName: "code.searchRepository" },
      { phase: "started", toolCallId: "react-step:react:2", toolName: "code.searchRepository" },
      expect.objectContaining({
        phase: "failed",
        toolCallId: "react-step:react:2",
        toolName: "code.searchRepository",
        reason: "Search unavailable.",
      }),
    ]);
  });

  it("does not report zero token usage when the provider omits usage", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ sources: [{ url: "https://example.test" }] }),
      }],
      decideNext: vi.fn()
        .mockResolvedValueOnce({
          status: "continue",
          toolName: "file.scanMarkdownDocuments",
          reason: "scan",
        })
        .mockResolvedValueOnce({ status: "completed", reason: "done" }),
    });

    expect(result.metrics.usage).toBeUndefined();
  });

  it("observes tool output and lets the agent choose a follow-up tool", async () => {
    const agent = mustAgent("code");
    const context = createSharedTaskContext();
    const inspectRepository = vi.fn(async () => ({ changedFiles: ["src/app.ts"] }));
    const runReadOnlyCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok" }));

    const result = await runAgentReActLoop({
      agent,
      step: step("code"),
      context,
      tools: [
        { name: "code.inspectRepository", execute: inspectRepository },
        { name: "shell.runReadOnlyCommand", execute: runReadOnlyCommand },
      ],
      decideNext: ({ observations }) => {
        if (observations.length === 0) {
          return { status: "continue", toolName: "code.inspectRepository", reason: "inspect first" };
        }
        if (observations.length === 1) {
          return { status: "continue", toolName: "shell.runReadOnlyCommand", reason: "verify after inspect" };
        }
        return { status: "completed", reason: "verified", output: observations[observations.length - 1]?.output };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.observations.map((item) => item.toolName)).toEqual([
      "code.inspectRepository",
      "shell.runReadOnlyCommand",
    ]);
    expect(context.get("react:react-step:1")).toMatchObject({ toolName: "code.inspectRepository" });
    expect(inspectRepository).toHaveBeenCalledOnce();
    expect(runReadOnlyCommand).toHaveBeenCalledOnce();
  });

  it("publishes a structured completion derived from the latest successful observation", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("page-agent"),
      step: step("page-agent"),
      context: createSharedTaskContext(),
      tools: [{
        name: "browser.getContent",
        execute: async () => ({
          url: "https://example.test/trending",
          content: "1. First topic\n2. Second topic",
        }),
      }],
      decideNext: vi.fn()
        .mockResolvedValueOnce({
          status: "continue",
          toolName: "browser.getContent",
          reason: "Read the ranked page.",
        })
        .mockResolvedValueOnce({
          status: "completed",
          reason: "Return structured ranked evidence.",
          output: {
            sourceUrl: "https://example.test/trending",
            items: [
              { rank: 1, title: "First topic" },
              { rank: 2, title: "Second topic" },
            ],
          },
        }),
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      sourceUrl: "https://example.test/trending",
      items: [
        { rank: 1, title: "First topic" },
        { rank: 2, title: "Second topic" },
      ],
    });
  });

  it("publishes an evidence-grounded specialist summary instead of the raw tool payload", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("language-reviewer"),
      step: step("language-reviewer"),
      context: createSharedTaskContext(),
      completionOutputMode: "summary",
      tools: [{
        name: "code.searchRepository",
        execute: async () => ({ matches: [{ path: "README.md", line: 20, excerpt: "Uses Tauri." }] }),
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? {
            status: "continue",
            toolName: "code.searchRepository",
            reason: "collect evidence",
          }
        : {
            status: "completed",
            reason: "review complete",
            output: {
              findings: [{ severity: "P2", path: "README.md", line: 20, detail: "Claim needs updating." }],
              limitations: [],
            },
          },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      findings: [{ severity: "P2", path: "README.md", line: 20, detail: "Claim needs updating." }],
      limitations: [],
    });
  });

  it("rejects tools outside the agent whitelist", async () => {
    const agent = mustAgent("file");
    const forbiddenTool = vi.fn(async () => "should not run");

    const result = await runAgentReActLoop({
      agent,
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "shell.runReadOnlyCommand", execute: forbiddenTool }],
      decideNext: () => ({
        status: "continue",
        toolName: "shell.runReadOnlyCommand",
        reason: "try wrong tool",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("cannot use tool shell.runReadOnlyCommand");
    expect(forbiddenTool).not.toHaveBeenCalled();
  });

  it("fails before the first iteration when declared input context is missing", async () => {
    const decideNext = vi.fn();
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: {
        ...step("code"),
        inputContextKeys: ["diffPreview"],
      },
      context: createSharedTaskContext(),
      tools: [{ name: "code.inspectRepository", execute: async () => ({}) }],
      decideNext,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("missing input context key(s): diffPreview");
    expect(decideNext).not.toHaveBeenCalled();
  });

  it("returns request_input when an agent asks another agent to repair context", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [{ name: "code.inspectRepository", execute: async () => ({}) }],
      liveAgentKinds: ["code", "computer"],
      decideNext: () => ({
        status: "request_input",
        reason: "Need UI facts before editing.",
        requestedContextKeys: ["uiEvidence"],
        requestedAgentKind: "computer",
      }),
    });

    expect(result.status).toBe("request_input");
    expect(result.requestedContextKeys).toEqual(["uiEvidence"]);
    expect(result.requestedAgentKind).toBe("computer");
  });

  it("hands a failed tool to its configured fallback agent without another model turn", async () => {
    const decideNext = vi.fn(async () => ({
      status: "continue" as const,
      toolName: "trend.fetchHotList",
      reason: "Try the structured browser-first collector.",
    }));
    const fetchHotList = vi.fn(async () => {
      throw new Error("Structured trend provider is unsupported.");
    });

    const result = await runAgentReActLoop({
      agent: mustAgent("research"),
      step: step("research"),
      context: createSharedTaskContext(),
      tools: [{
        name: "trend.fetchHotList",
        failureFallbackAgentKind: "page-agent",
        failureFallbackCapability: "browser_navigate",
        failureFallbackContextKey: "hotListEvidence",
        execute: fetchHotList,
      }],
      liveAgentKinds: ["research", "page-agent"],
      decideNext,
    });

    expect(result.status).toBe("request_input");
    expect(result.requestedContextKeys).toEqual(["hotListEvidence"]);
    expect(result.requestedAgentKind).toBe("page-agent");
    expect(result.reason).toContain("browser_navigate");
    expect(result.observations).toEqual([
      expect.objectContaining({
        toolName: "trend.fetchHotList",
        status: "failed",
        error: "Structured trend provider is unsupported.",
      }),
    ]);
    expect(decideNext).toHaveBeenCalledOnce();
    expect(fetchHotList).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "missing keys",
      decision: { status: "request_input", reason: "need data" },
      expectedReason: "non-empty array",
    },
    {
      name: "empty keys",
      decision: { status: "request_input", reason: "need data", requestedContextKeys: [] },
      expectedReason: "non-empty array",
    },
    {
      name: "non-array keys",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: "uiEvidence",
      },
      expectedReason: "non-empty array",
    },
    {
      name: "too many keys",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: Array.from(
          { length: MAX_REACT_REQUESTED_CONTEXT_KEYS + 1 },
          (_, index) => `evidence${index}`,
        ),
      },
      expectedReason: `more than ${MAX_REACT_REQUESTED_CONTEXT_KEYS}`,
    },
    {
      name: "overlong key",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: [`e${"x".repeat(MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS)}`],
      },
      expectedReason: `at most ${MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS}`,
    },
    {
      name: "non-string key",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: [42],
      },
      expectedReason: "must be a string",
    },
    {
      name: "duplicate keys",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: ["uiEvidence", "uiEvidence"],
      },
      expectedReason: "must not contain duplicates",
    },
    {
      name: "unsafe key characters",
      decision: {
        status: "request_input",
        reason: "need data",
        requestedContextKeys: ["uiEvidence\nInjected log"],
      },
      expectedReason: "valid context key",
    },
  ])("rejects request_input with $name", async ({ decision, expectedReason }) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [{ name: "code.inspectRepository", execute: async () => ({}) }],
      liveAgentKinds: ["code", "computer"],
      decideNext: () => decision as AgentReActDecision,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Invalid request_input decision");
    expect(result.reason).toContain(expectedReason);
    expect(result.requestedContextKeys).toBeUndefined();
  });

  it("rejects a requested agent that is not in the live registry", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [{ name: "code.inspectRepository", execute: async () => ({}) }],
      liveAgentKinds: ["code"],
      decideNext: () => ({
        status: "request_input",
        reason: "Need UI evidence.",
        requestedContextKeys: ["uiEvidence"],
        requestedAgentKind: "computer",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("live registered agent");
    expect(result.requestedAgentKind).toBeUndefined();
  });

  it("rejects a non-string requested agent kind", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [{ name: "code.inspectRepository", execute: async () => ({}) }],
      liveAgentKinds: ["code", "computer"],
      decideNext: () => ({
        status: "request_input",
        reason: "Need UI evidence.",
        requestedContextKeys: ["uiEvidence"],
        requestedAgentKind: 42,
      } as unknown as AgentReActDecision),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("live registered agent");
  });

  it("passes decision input to the selected tool", async () => {
    const tool = vi.fn(async ({ input }) => input);

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: tool }],
      decideNext: ({ observations }) =>
        observations.length === 0
          ? {
              status: "continue",
              toolName: "file.scanMarkdownDocuments",
              input: { query: "demo" },
              reason: "scan with input",
            }
          : { status: "completed", reason: "done" },
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledWith(expect.objectContaining({
      input: { query: "demo" },
    }));
    expect(result.observations[0]?.output).toEqual({ query: "demo" });
  });

  it("rejects missing or empty required tool input before execution", async () => {
    const tool = vi.fn(async () => ({ ok: true }));

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        requiredInputs: [{ name: "query", type: "string", nonEmpty: true }],
        execute: tool,
      }],
      decideNext: () => ({
        status: "continue",
        toolName: "file.scanMarkdownDocuments",
        input: { query: "   " },
        reason: "scan",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("input.query");
    expect(result.reason).toContain("non-empty");
    expect(tool).not.toHaveBeenCalled();
  });

  it("validates required inputs after merging deterministic base input", async () => {
    const tool = vi.fn(async ({ input }) => input);

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        baseInput: { paths: ["README.md"] },
        requiredInputs: [{ name: "paths", type: "string[]", nonEmpty: true }],
        execute: tool,
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? {
            status: "continue",
            toolName: "file.scanMarkdownDocuments",
            reason: "scan configured paths",
          }
        : { status: "completed", reason: "done" },
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledWith(expect.objectContaining({
      input: { paths: ["README.md"] },
    }));
  });

  it("validates numeric and boolean array inputs without coercing them to strings", async () => {
    const tool = vi.fn(async ({ input }) => input);

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        requiredInputs: [
          { name: "weights", type: "number[]", nonEmpty: true },
          { name: "flags", type: "boolean[]", nonEmpty: true },
        ],
        execute: tool,
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? {
            status: "continue",
            toolName: "file.scanMarkdownDocuments",
            input: { weights: [0.25, 0.75], flags: [true, false] },
            reason: "scan with typed arrays",
          }
        : { status: "completed", reason: "done" },
    });

    expect(result.status).toBe("completed");
    expect(tool).toHaveBeenCalledWith(expect.objectContaining({
      input: { weights: [0.25, 0.75], flags: [true, false] },
    }));
  });

  it("rejects a non-boolean member in a required boolean array", async () => {
    const tool = vi.fn(async () => ({ ok: true }));

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        requiredInputs: [{ name: "flags", type: "boolean[]", nonEmpty: true }],
        execute: tool,
      }],
      decideNext: () => ({
        status: "continue",
        toolName: "file.scanMarkdownDocuments",
        input: { flags: [true, "false"] },
        reason: "scan",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("input.flags");
    expect(result.reason).toContain("boolean[]");
    expect(tool).not.toHaveBeenCalled();
  });

  it("fails when the agent keeps acting past the iteration limit", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      maxIterations: 2,
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => [] }],
      decideNext: () => ({
        status: "continue",
        toolName: "file.scanMarkdownDocuments",
        reason: "need more",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.observations).toHaveLength(2);
    expect(result.reason).toContain("iteration limit");
  });

  it("offers one terminal decision after the last allowed tool call", async () => {
    const decideNext = vi.fn(({ remainingToolCalls }: { remainingToolCalls: number }) =>
      remainingToolCalls > 0
        ? {
            status: "continue" as const,
            toolName: "file.scanMarkdownDocuments",
            reason: "collect the final evidence",
          }
        : {
            status: "completed" as const,
            reason: "the final observation satisfies the step",
            output: { summary: "README found." },
          });

    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      maxIterations: 1,
      completionOutputMode: "summary",
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ matches: ["README.md"] }),
      }],
      decideNext,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "README found." });
    expect(decideNext).toHaveBeenCalledTimes(2);
    expect(decideNext.mock.calls[1]?.[0]).toMatchObject({
      iteration: 2,
      maxToolCalls: 1,
      remainingToolCalls: 0,
    });
  });

  it("defaults to six iterations for multi-step reasoning", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => [] }],
      decideNext: () => ({
        status: "continue",
        toolName: "file.scanMarkdownDocuments",
        reason: "need more",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.observations).toHaveLength(6);
    expect(result.reason).toContain("iteration limit");
  });

  it("records tool failures as observations so the agent can choose another tool", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      tools: [
        {
          name: "code.inspectRepository",
          execute: async () => {
            throw new Error("git unavailable");
          },
        },
        {
          name: "shell.runReadOnlyCommand",
          execute: async () => ({ exitCode: 0, stdout: "fallback ok" }),
        },
      ],
      decideNext: ({ observations }) => {
        if (observations.length === 0) {
          return { status: "continue", toolName: "code.inspectRepository", reason: "try git first" };
        }
        if (observations[0].status === "failed" && observations.length === 1) {
          return { status: "continue", toolName: "shell.runReadOnlyCommand", reason: "fall back to shell" };
        }
        return { status: "completed", reason: "fallback worked" };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.observations).toMatchObject([
      { toolName: "code.inspectRepository", status: "failed", error: "git unavailable" },
      { toolName: "shell.runReadOnlyCommand", status: "succeeded" },
    ]);
  });

  it("can complete from earlier usable evidence after an optional follow-up fails", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("language-reviewer"),
      step: step("language-reviewer"),
      context: createSharedTaskContext(),
      completionOutputMode: "summary",
      tools: [
        {
          name: "code.searchRepository",
          execute: async () => ({ matches: [{ path: "README.md", line: 10, excerpt: "Current claim" }] }),
        },
        {
          name: "shell.runReadOnlyCommand",
          execute: async () => {
            throw new Error("Command is not in the first-version read-only allowlist.");
          },
        },
      ],
      decideNext: ({ observations }) => {
        if (observations.length === 0) {
          return { status: "continue", toolName: "code.searchRepository", reason: "search" };
        }
        if (observations.length === 1) {
          return { status: "continue", toolName: "shell.runReadOnlyCommand", reason: "optional check" };
        }
        return {
          status: "completed",
          reason: "report grounded findings and the unavailable optional check",
          output: { findings: [], limitations: ["The optional shell check was not allowlisted."] },
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({
      findings: [],
      limitations: ["The optional shell check was not allowlisted."],
    });
    expect(result.observations.map((observation) => observation.status)).toEqual(["succeeded", "failed"]);
  });

  it("stops after the same tool failure repeats instead of exhausting the iteration budget", async () => {
    const inspectRepository = vi.fn(async () => {
      throw new Error("Tool input contains an undeclared field: workspaceEvidence.");
    });

    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      maxIterations: 8,
      tools: [{ name: "code.inspectRepository", execute: inspectRepository }],
      decideNext: () => ({
        status: "continue",
        toolName: "code.inspectRepository",
        reason: "retry repository inspection",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.observations).toHaveLength(2);
    expect(result.reason).toContain("repeated the same failure");
    expect(inspectRepository).toHaveBeenCalledTimes(2);
  });

  it("stops when the same failure recurs after another tool succeeds", async () => {
    const searchRepository = vi.fn(async () => {
      throw new Error("Command is not in the read-only allowlist.");
    });
    const inspectRepository = vi.fn(async () => ({ diff: "clean" }));
    const decisions = [
      { status: "continue" as const, toolName: "code.searchRepository", reason: "search" },
      { status: "continue" as const, toolName: "code.inspectRepository", reason: "inspect" },
      { status: "continue" as const, toolName: "code.searchRepository", reason: "retry search" },
    ];

    const result = await runAgentReActLoop({
      agent: mustAgent("code"),
      step: step("code"),
      context: createSharedTaskContext(),
      maxIterations: 8,
      tools: [
        { name: "code.searchRepository", execute: searchRepository },
        { name: "code.inspectRepository", execute: inspectRepository },
      ],
      decideNext: () => decisions.shift() ?? {
        status: "failed",
        reason: "unexpected extra iteration",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("repeated the same failure");
    expect(result.observations.map((observation) => observation.status)).toEqual([
      "failed",
      "succeeded",
      "failed",
    ]);
    expect(searchRepository).toHaveBeenCalledTimes(2);
    expect(inspectRepository).toHaveBeenCalledTimes(1);
  });

  it("fails when a ReAct decision times out", async () => {
    await expect(
      runAgentReActLoop({
        agent: mustAgent("file"),
        step: step("file"),
        context: createSharedTaskContext(),
        decisionTimeoutMs: 10,
        tools: [{ name: "file.scanMarkdownDocuments", execute: async () => [] }],
        decideNext: async () => new Promise(() => undefined),
      }),
    ).rejects.toThrow("timed out");
  });

  it("records timed out tools as failed observations", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      toolTimeoutMs: 10,
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => new Promise(() => undefined) }],
      decideNext: ({ observations }) =>
        observations.length === 0
          ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
          : { status: "completed", reason: "done" },
    });

    expect(result.status).toBe("failed");
    expect(result.observations[0]).toMatchObject({
      toolName: "file.scanMarkdownDocuments",
      status: "failed",
    });
    expect(result.observations[0]?.error).toContain("timed out");
  });

  it("does not allow completion without a successful evidence observation", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => { throw new Error("unavailable"); } }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done", output: "claimed" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("successful usable evidence observation");
  });

  it.each([[], {}])("rejects an empty observation container as completion evidence", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "no matching documents" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it("rejects a false observation as completion evidence", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => false }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it.each([
    [{ status: "failed" }],
    [null],
    [""],
    [{}],
  ])("rejects arrays whose only member is not usable evidence: %j", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it("rejects a truncated failure object as completion evidence", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({
          payload: "x".repeat(13_000),
          status: "failed",
        }),
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
    expect(result.observations[0]?.outputTruncated).toBe(true);
    expect(result.observations[0]?.outputUsable).toBe(false);
  });

  it.each([
    { matches: [] },
    { data: { tools: [] } },
    "No results found",
    "Not found",
  ])("rejects nested or textual empty-result observations: %j", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "no matching documents" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it.each([
    { items: [false] },
    { results: [{ status: "failed", error: "lookup failed" }] },
    { sources: [""] },
  ])("rejects invalid members inside nested result arrays: %j", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it("fails closed for cyclic tool output instead of recursing indefinitely", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.items = [cyclic];
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => cyclic }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it.each([
    { status: "failed", error: "lookup failed" },
    { ok: false },
    { success: false },
    { exitCode: 1, stderr: "failed" },
  ])("rejects an explicit tool failure as completion evidence", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it.each([
    { status: "pending", jobId: "job-1" },
    { status: "running", progress: 50 },
    { status: "queued", position: 2 },
    { status: "in_progress", progress: 75 },
    { status: "in progress", progress: 75 },
    { completed: false, result: "not ready" },
    { done: false, result: "not ready" },
    { job: { status: "pending", id: "job-1" } },
    { result: { completed: false, value: "not ready" } },
    { events: [{ status: "pending", id: "job-1" }] },
    "pending",
    "in_progress: 75%",
    { results: null },
    { status: "completed", result: null },
    { error: null },
    { events: [{ status: "failed" }] },
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects a non-terminal tool response as completion evidence: %j", async (output) => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => output }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "scan" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("usable evidence");
  });

  it("redacts image data URLs from observations before the next decision", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ screenshot: "data:image/png;base64,SECRET_PAYLOAD" }),
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "completed", reason: "evidence collected" },
    });

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.observations[0]?.output)).not.toContain("SECRET_PAYLOAD");
    expect(JSON.stringify(result.observations[0]?.output)).toContain("redacted:image data URL");
  });

  it("redacts nested secret fields and common secret formats from observations", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({
          ok: true,
          apiKey: "sk-project-secret-value",
          detail: "Bearer bearer-secret-value password=hunter2",
        }),
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "completed", reason: "evidence collected" },
    });

    const serialized = JSON.stringify(result.observations);
    expect(result.status).toBe("completed");
    expect(serialized).not.toContain("sk-project-secret-value");
    expect(serialized).not.toContain("bearer-secret-value");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[redacted:secret]");
  });

  it("binds completion output to the latest successful tool observation", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ ok: true, result: "trusted tool evidence" }),
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : {
            status: "completed",
            reason: "done",
            output: { result: "fabricated model claim", screenshot: "data:image/png;base64,MODEL_SECRET" },
          },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true, result: "trusted tool evidence" });
    expect(JSON.stringify(result.output)).not.toContain("fabricated model claim");
    expect(JSON.stringify(result.output)).not.toContain("MODEL_SECRET");
  });

  it("falls back to the successful non-empty observation when completion output is empty text", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{ name: "file.scanMarkdownDocuments", execute: async () => ({ matches: ["doc.md"] }) }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "completed", reason: "matches found", output: "   " },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ matches: ["doc.md"] });
  });

  it("bounds the aggregate observation history passed to later decisions", async () => {
    let decisionCount = 0;
    const observedSizes: number[] = [];
    const context = createSharedTaskContext();
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context,
      maxIterations: 5,
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => ({ payload: "x".repeat(11_000) }),
      }],
      decideNext: ({ observations }) => {
        observedSizes.push(JSON.stringify(observations).length);
        decisionCount += 1;
        return decisionCount <= 4
          ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "collect" }
          : { status: "completed", reason: "enough evidence" };
      },
    });

    expect(result.status).toBe("completed");
    expect(Math.max(...observedSizes)).toBeLessThanOrEqual(MAX_REACT_OBSERVATION_TOTAL_CHARS);
    expect(JSON.stringify(result.observations).length).toBeLessThanOrEqual(
      MAX_REACT_OBSERVATION_TOTAL_CHARS,
    );
    expect(result.observations[result.observations.length - 1]?.iteration).toBe(4);
    expect(context.get<AgentReActObservation>("react:react-step:1")?.output).toBe(
      "[observation omitted by total budget]",
    );
  });

  it("redacts and bounds failed observation errors before the next decision", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => {
          throw new Error(`failed data:image/png;base64,SECRET_PAYLOAD ${"x".repeat(4_000)}`);
        },
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "failed", reason: "tool failed" },
    });

    expect(result.status).toBe("failed");
    const observationError = result.observations[0]?.error ?? "";
    expect(observationError).not.toContain("SECRET_PAYLOAD");
    expect(observationError).toContain("redacted:image data URL");
    expect(observationError).toContain("[truncated]");
    expect(observationError.length).toBeLessThanOrEqual(2_014);
  });

  it("does not complete on an observation that cannot be serialized", async () => {
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => () => "not model evidence",
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("successful usable evidence observation");
  });

  it("does not complete on a cyclic observation object", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await runAgentReActLoop({
      agent: mustAgent("file"),
      step: step("file"),
      context: createSharedTaskContext(),
      tools: [{
        name: "file.scanMarkdownDocuments",
        execute: async () => cyclic,
      }],
      decideNext: ({ observations }) => observations.length === 0
        ? { status: "continue", toolName: "file.scanMarkdownDocuments", reason: "inspect" }
        : { status: "completed", reason: "claim done" },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("successful usable evidence observation");
    expect(result.observations[0]?.output).toBeUndefined();
  });
});

function mustAgent(kind: AgentKind) {
  const agent = demoAgents.find((item) => item.kind === kind);
  if (!agent) throw new Error(`Missing test agent ${kind}`);
  return agent;
}

function step(agentKind: AgentKind): WorkbenchWorkflowStep {
  return {
    id: "react-step",
    title: "React step",
    agentKind,
    input: "input",
    output: "output",
    permissionLevel: "read",
    dependsOn: [],
    canRunInParallel: false,
  };
}
