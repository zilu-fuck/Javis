import { describe, expect, it } from "vitest";
import {
  createFailedStepResult,
  normalizeStepContract,
  normalizeStepResult,
} from "./step-protocol";

describe("step protocol", () => {
  it("normalizes legacy step fields into an explicit contract", () => {
    expect(normalizeStepContract({
      title: "Inspect the repository",
      successCriteria: "The repository structure is supported by evidence.",
    })).toEqual({
      instruction: "Inspect the repository",
      hardConstraints: [],
      preferences: [],
      acceptanceCriteria: ["The repository structure is supported by evidence."],
      artifactObligation: "none",
      completionPolicy: {
        partial: "stop",
        blocked: "replan",
        needsClarification: "replan",
      },
    });
  });

  it("infers artifact obligations and primary capability for legacy plans", () => {
    expect(normalizeStepContract({
      title: "Inspect the repository",
      requiredCapabilities: ["code_search"],
      outputContextKey: "repoEvidence",
    })).toMatchObject({
      primaryCapability: "code_search",
      artifactObligation: "required",
    });
  });

  it("preserves structured result metadata while removing empty entries", () => {
    expect(normalizeStepResult({
      status: "partial",
      output: { files: 3 },
      evidence: [
        { kind: "file", label: "Manifest", reference: "package.json" },
        { kind: "url", label: "Specification", reference: "https://example.test/spec" },
      ],
      assumptions: ["The workspace is the selected project."],
      unresolvedQuestions: ["Which release target should be used?"],
    })).toEqual({
      status: "partial",
      output: { files: 3 },
      evidence: [
        { kind: "file", label: "Manifest", reference: "package.json" },
        { kind: "url", label: "Specification", reference: "https://example.test/spec" },
      ],
      assumptions: ["The workspace is the selected project."],
      unresolvedQuestions: ["Which release target should be used?"],
    });
  });

  it("turns thrown errors into an auditable failed result", () => {
    expect(createFailedStepResult(new Error("tool unavailable"))).toEqual({
      status: "failed",
      evidence: [],
      assumptions: [],
      unresolvedQuestions: [],
      error: "tool unavailable",
      errorDetail: {
        code: "step_execution_failed",
        message: "tool unavailable",
        phase: "runtime",
        retryable: false,
      },
    });
  });

  it("preserves structured blocked and clarification fields", () => {
    expect(normalizeStepResult({
      status: "blocked",
      requestedContextKeys: ["workspacePath"],
      requestedAgentKind: "workspace",
      blockedReason: {
        kind: "environment",
        resumable: true,
        retryable: true,
        detail: "Workspace is not mounted.",
        wakeCondition: { event: "context_available", ref: "workspacePath" },
      },
    })).toMatchObject({
      status: "blocked",
      requestedContextKeys: ["workspacePath"],
      requestedAgentKind: "workspace",
      blockedReason: {
        kind: "environment",
        wakeCondition: { event: "context_available", ref: "workspacePath" },
      },
    });
  });
});
