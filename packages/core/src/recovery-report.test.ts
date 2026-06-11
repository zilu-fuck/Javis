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
});
