import { describe, expect, it } from "vitest";
import {
  buildRecoveryReport,
  classifyRecoveryFailure,
  createRecoveryAttempt,
} from "./recovery-report";

describe("recovery report", () => {
  it("classifies common failure kinds without tool-specific hardcoding", () => {
    expect(classifyRecoveryFailure("Tool timed out after 10000ms")).toBe("timeout");
    expect(classifyRecoveryFailure("User denied approval for write")).toBe("permission_denied");
    expect(classifyRecoveryFailure("Tool code.traceCallChain is not available")).toBe("unavailable");
    expect(classifyRecoveryFailure("HTTP 502 network fetch failed")).toBe("network");
    expect(classifyRecoveryFailure("Invalid schema: missing provider")).toBe("validation");
    expect(classifyRecoveryFailure("something surprising happened")).toBe("unknown");
  });

  it("builds a recovered report from a planned alternate path", () => {
    const attempt = createRecoveryAttempt({
      step: {
        id: "search-primary",
        title: "Search with primary provider",
        agentKind: "research",
      },
      error: "HTTP 503 from primary provider",
      completedStepIds: ["parse-request"],
      replanAttempted: true,
      replanStatus: "planned",
      abandonedFailedStep: true,
      recoveryStepIds: ["search-fallback", "synthesize-partial"],
    });

    const report = buildRecoveryReport([attempt], {
      generatedAt: "2026-06-11T00:00:00.000Z",
      abandonedStepIds: ["search-primary"],
      replannedStepIds: ["search-fallback", "synthesize-partial"],
    });

    expect(report).toMatchObject({
      status: "recovered",
      failureCount: 1,
      recoveredCount: 1,
      unrecoveredCount: 0,
      abandonedStepIds: ["search-primary"],
      replannedStepIds: ["search-fallback", "synthesize-partial"],
      stuckSignals: [],
      commanderGuidance: [],
    });
    expect(report.attempts[0]).toMatchObject({
      failedStepId: "search-primary",
      failureKind: "network",
      completedBefore: ["parse-request"],
      suggestedAlternatives: [
        "retry with a fallback provider",
        "use cached or user-provided sources when available",
      ],
    });
  });

  it("marks reports needing attention when recovery was not planned", () => {
    const report = buildRecoveryReport([
      createRecoveryAttempt({
        step: {
          id: "apply-change",
          title: "Apply change",
          agentKind: "code",
        },
        error: "User denied approval.",
        replanAttempted: false,
      }),
    ]);

    expect(report.status).toBe("needs_attention");
    expect(report.recoveredCount).toBe(0);
    expect(report.unrecoveredCount).toBe(1);
    expect(report.attempts[0]?.failureKind).toBe("permission_denied");
  });

  it("adds Commander guidance when the same tool failure repeats", () => {
    const attempts = [
      createRecoveryAttempt({
        step: { id: "search-a", title: "Search", agentKind: "code" },
        error: "Tool failed with identical input",
        replanAttempted: true,
        replanStatus: "failed",
      }),
      createRecoveryAttempt({
        step: { id: "search-b", title: "Search", agentKind: "code" },
        error: "Tool failed with identical input",
        replanAttempted: true,
        replanStatus: "failed",
      }),
    ];

    const report = buildRecoveryReport(attempts);

    expect(report.stuckSignals).toEqual([
      expect.objectContaining({
        kind: "repeated_tool_failure",
        severity: "blocked",
      }),
    ]);
    expect(report.commanderGuidance).toContain("switch tool or switch agent kind before retrying");
  });

  it("detects duplicate replan shapes returned by Commander", () => {
    const report = buildRecoveryReport([
      createRecoveryAttempt({
        step: { id: "apply", title: "Apply", agentKind: "code" },
        error: "verification failed",
        replanAttempted: true,
        replanStatus: "failed",
      }),
    ], {
      replanShapes: [
        {
          steps: [
            {
              agentKind: "code",
              inputContextKeys: ["diffPreview"],
              outputContextKey: "patchResult",
              permissionLevel: "preview",
            },
          ],
        },
        {
          steps: [
            {
              agentKind: "code",
              inputContextKeys: ["diffPreview"],
              outputContextKey: "patchResult",
              permissionLevel: "preview",
            },
          ],
        },
      ],
    });

    expect(report.stuckSignals).toEqual([
      expect.objectContaining({
        kind: "duplicate_replan_shape",
      }),
    ]);
    expect(report.commanderGuidance).toContain("return a materially different recovery plan");
  });

  it("classifies request_input missing keys as handoff failures with actionable guidance", () => {
    const report = buildRecoveryReport([
      createRecoveryAttempt({
        step: { id: "verify", title: "Verify", agentKind: "verifier" },
        error: "ReAct request_input for step verify: Need upstream data. requestedContextKeys: [diffPreview]",
        replanAttempted: false,
      }),
      createRecoveryAttempt({
        step: { id: "summarize", title: "Summarize", agentKind: "commander" },
        error: "ReAct request_input for step summarize: Need upstream data. requestedContextKeys: [diffPreview]",
        replanAttempted: false,
      }),
    ]);

    expect(report.attempts[0]?.failureKind).toBe("handoff");
    expect(report.stuckSignals).toEqual([
      expect.objectContaining({
        kind: "repeated_missing_context",
        fingerprint: "missing-context:diffPreview",
      }),
    ]);
    expect(report.commanderGuidance).toContain("produce the missing context key or ask the user for it");
  });

  it("includes a progress ledger when workflow steps are supplied", () => {
    const report = buildRecoveryReport([
      createRecoveryAttempt({
        step: { id: "verify", title: "Verify", agentKind: "code" },
        error: "missing context key diffPreview",
        completedStepIds: ["inspect"],
        replanAttempted: true,
        replanStatus: "failed",
      }),
    ], {
      workflowSteps: [
        {
          id: "inspect",
          title: "Inspect",
          agentKind: "code",
          input: "workspace",
          output: "evidence",
          permissionLevel: "read",
          dependsOn: [],
          canRunInParallel: false,
        },
        {
          id: "verify",
          title: "Verify",
          agentKind: "code",
          input: "evidence",
          output: "result",
          permissionLevel: "read",
          dependsOn: ["inspect"],
          canRunInParallel: false,
        },
      ],
      completedStepIds: ["inspect"],
    });

    expect(report.progressLedger).toMatchObject({
      completed: [
        { stepId: "inspect", title: "Inspect", agentKind: "code" },
      ],
      failed: [
        { stepId: "verify", title: "Verify", agentKind: "code" },
      ],
      blocked: [
        { stepId: "verify" },
      ],
      remainingWork: ["verify"],
    });
  });
});
