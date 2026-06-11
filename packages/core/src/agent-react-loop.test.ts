import { describe, expect, it, vi } from "vitest";
import { demoAgents } from "./agents";
import { runAgentReActLoop } from "./agent-react-loop";
import { createSharedTaskContext } from "./shared-context";
import type { WorkbenchWorkflowStep } from "./workflows";

describe("runAgentReActLoop", () => {
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

    expect(result.status).toBe("completed");
    expect(result.observations[0]).toMatchObject({
      toolName: "file.scanMarkdownDocuments",
      status: "failed",
    });
    expect(result.observations[0]?.error).toContain("timed out");
  });
});

function mustAgent(kind: "code" | "file") {
  const agent = demoAgents.find((item) => item.kind === kind);
  if (!agent) throw new Error(`Missing test agent ${kind}`);
  return agent;
}

function step(agentKind: "code" | "file"): WorkbenchWorkflowStep {
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
