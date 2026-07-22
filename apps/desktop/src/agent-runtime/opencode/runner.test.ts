import { describe, expect, it, vi } from "vitest";
import {
  createCodeProposalHash,
  type AgentDefinition,
  type AgentRunRequest,
} from "@javis/core";
import type { CodeProposedEdit, CodeReviewPreview } from "@javis/tools";
import { createOpenCodeAgentRuntime } from "./runner";

const preview: CodeReviewPreview = {
  workspacePath: "E:/repo",
  changedFiles: ["src/value.ts"],
  diffStat: " src/value.ts | 2 +-",
  diff: [
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
  ].join("\n"),
};

describe("OpenCodeAgentRuntime", () => {
  it("returns a normalized StepResult proposal without invoking Javis tools", async () => {
    const proposal = createProposal();
    const proposeEdit = vi.fn(async () => proposal);
    const runtime = createOpenCodeAgentRuntime({ proposeEdit });
    const handle = runtime.run(createDefinition(), createRequest());
    const eventsPromise = collectEvents(handle.events);

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      termination: "returned",
      stepResult: {
        status: "completed",
        output: proposal,
      },
      metrics: {
        backend: "opencode",
        modelCalls: 1,
        toolCalls: 0,
      },
    });
    expect(proposeEdit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      runId: "agent-run-1",
      userGoal: "Prepare the smallest safe patch.",
      preview,
    }));
    await expect(eventsPromise).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.started", stepId: "propose", attempt: 1 }),
      expect.objectContaining({ type: "run.completed", stepId: "propose", attempt: 1 }),
    ]));
  });

  it("fails closed when code.proposeEdit is exposed to the OpenCode runtime", async () => {
    const proposeEdit = vi.fn(async () => createProposal());
    const runtime = createOpenCodeAgentRuntime({ proposeEdit });
    const definition = createDefinition(["code.proposeEdit"]);

    await expect(runtime.run(definition, createRequest()).result).resolves.toMatchObject({
      status: "failed",
      stepResult: {
        status: "failed",
        errorDetail: { code: "opencode_forbidden_tool" },
      },
    });
    expect(proposeEdit).not.toHaveBeenCalled();
  });

  it("requests the diff preview instead of guessing when input context is missing", async () => {
    const proposeEdit = vi.fn(async () => createProposal());
    const runtime = createOpenCodeAgentRuntime({ proposeEdit });

    await expect(runtime.run(createDefinition(), createRequest({ context: {} })).result)
      .resolves.toMatchObject({
        status: "request_input",
        requestedContextKeys: ["diffPreview"],
        stepResult: {
          status: "needs_clarification",
          requestedContextKeys: ["diffPreview"],
        },
      });
    expect(proposeEdit).not.toHaveBeenCalled();
  });

  it("reads the diff preview from the normalized workflow step input", async () => {
    const proposeEdit = vi.fn(async () => createProposal());
    const runtime = createOpenCodeAgentRuntime({ proposeEdit });

    await expect(runtime.run(
      createDefinition(),
      createRequest({ context: { stepInput: { preview } } }),
    ).result).resolves.toMatchObject({
      status: "completed",
      stepResult: { status: "completed" },
    });
    expect(proposeEdit).toHaveBeenCalledWith(expect.objectContaining({ preview }));
  });

  it("maps an invalid proposal into a structured protocol failure", async () => {
    const proposal = { ...createProposal(), patchHash: "forged" };
    const runtime = createOpenCodeAgentRuntime({ proposeEdit: async () => proposal });

    await expect(runtime.run(createDefinition(), createRequest()).result).resolves.toMatchObject({
      status: "failed",
      stepResult: {
        status: "failed",
        errorDetail: {
          code: "opencode_invalid_proposal",
          phase: "protocol",
          retryable: false,
        },
      },
    });
  });

  it("returns transport cancellation without publishing a business StepResult", async () => {
    let resolveProposal!: (proposal: CodeProposedEdit) => void;
    const runtime = createOpenCodeAgentRuntime({
      proposeEdit: () => new Promise((resolve) => {
        resolveProposal = resolve;
      }),
    });
    const handle = runtime.run(createDefinition(), createRequest());
    handle.cancel();

    await expect(handle.result).resolves.toMatchObject({
      status: "cancelled",
      termination: "cancelled",
    });
    expect((await handle.result).stepResult).toBeUndefined();
    resolveProposal(createProposal());
  });
});

function createDefinition(allowedToolNames: string[] = []): AgentDefinition {
  return {
    id: "agent-code",
    kind: "code",
    instructions: "Return a proposal only.",
    allowedToolNames,
    limits: {
      maxModelCalls: 1,
      maxToolCalls: 0,
      modelTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
    },
  };
}

function createRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    taskId: "task-1",
    runId: "agent-run-1",
    workflowRunId: "workflow-run-1",
    agentRunId: "agent-run-1",
    stepId: "propose",
    attempt: 1,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Task goal: update the value" }],
    }],
    context: { diffPreview: preview },
    stepContract: {
      instruction: "Prepare the smallest safe patch.",
      hardConstraints: ["Do not write files."],
      preferences: [],
      acceptanceCriteria: ["Return a valid patch proposal."],
      primaryCapability: "code_propose",
      artifactObligation: "required",
      completionPolicy: {
        partial: "stop",
        blocked: "replan",
        needsClarification: "replan",
      },
    },
    ...overrides,
  };
}

function createProposal(): CodeProposedEdit {
  const proposal: CodeProposedEdit = {
    approvalId: "approval-1",
    proposalId: "proposal-1",
    workspacePath: preview.workspacePath,
    summary: "Update the value.",
    changedFiles: [...preview.changedFiles],
    patch: preview.diff,
    patchHash: "",
  };
  proposal.patchHash = createCodeProposalHash(proposal);
  return proposal;
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const event of events) values.push(event);
  return values;
}
