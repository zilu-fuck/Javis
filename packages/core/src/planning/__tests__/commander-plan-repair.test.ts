import { describe, expect, it, vi } from "vitest";
import { buildCommanderPlanRepairPrompt } from "../../commander-plan-schema";
import { attemptPlanRepair } from "../commander-plan-repair";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import type { CommanderPlanResult, ToolDescriptor } from "@javis/tools";
import type { PlanDiagnostic } from "../commander-plan-diagnostics";

// --- Shared helpers -----------------------------------------------------------

function makeToolDescriptor(
  name: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    name,
    permissionLevel: "read",
    summary: `Tool: ${name}`,
    capabilityTags: [],
    ownerAgentKinds: [],
    ...overrides,
  };
}

const availableAgents = [
  { kind: "commander", allowedToolNames: ["commander.synthesize"] },
  { kind: "code", allowedToolNames: ["code.searchRepository"] },
  { kind: "verifier", allowedToolNames: ["verifier.check"] },
  { kind: "computer", allowedToolNames: ["computer.listDirectory"] },
] as const;

const availableTools: ToolDescriptor[] = [
  makeToolDescriptor("code.searchRepository", { capabilityTags: ["code_search"], ownerAgentKinds: ["code"] }),
  makeToolDescriptor("verifier.check", { capabilityTags: ["evidence_check"], ownerAgentKinds: ["verifier"] }),
  makeToolDescriptor("computer.listDirectory", { capabilityTags: ["directory_list"], ownerAgentKinds: ["computer"] }),
];

function invalidMissingDepPlan(): CommanderDagPlan {
  return {
    title: "Broken",
    reasoning: "Has a missing dependency",
    steps: [
      {
        id: "analyze",
        title: "Analyze",
        assignedAgentKind: "code",
        requiredCapabilities: ["code_search"],
        dependsOn: ["ghost-step"],
        successCriteria: "Done.",
      },
    ],
  };
}

const missingDepDiag: PlanDiagnostic = {
  code: "MISSING_DEPENDENCY",
  severity: "error",
  stepId: "analyze",
  message: "Step \"analyze\" depends on \"ghost-step\" which does not exist.",
  suggestedFix: "Remove the dependency or add a step with id \"ghost-step\".",
};

function validPlanResult(): CommanderPlanResult {
  return {
    title: "Repaired",
    reasoning: "Repair removed the ghost dependency.",
    steps: [
      {
        id: "analyze",
        title: "Analyze",
        assignedAgentKind: "code",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        successCriteria: "Done.",
      },
    ],
  };
}

// --- Prompt builder -----------------------------------------------------------

describe("buildCommanderPlanRepairPrompt", () => {
  it("includes diagnostics, invalid plan, and original user goal", () => {
    const prompt = buildCommanderPlanRepairPrompt({
      locale: "en",
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      attempt: 1,
      maxAttempts: 2,
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities: readonly string[];
      }>,
      availableTools,
    });

    expect(prompt).toContain("repair attempt 1 of 2");
    expect(prompt).toContain("Original user goal: List the directory");
    expect(prompt).toContain("MISSING_DEPENDENCY");
    expect(prompt).toContain("Remove the dependency or add a step with id \"ghost-step\"");
    expect(prompt).toContain("ghost-step");
    expect(prompt).toContain("Do NOT change the user goal");
    expect(prompt).toContain("Return JSON only");
  });

  it("uses the Chinese rule set for zhCN locale", () => {
    const prompt = buildCommanderPlanRepairPrompt({
      locale: "zh-CN",
      originalUserGoal: "列出目录",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      attempt: 2,
      maxAttempts: 2,
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities: readonly string[];
      }>,
      availableTools,
    });

    expect(prompt).toContain("修复尝试 2 / 2");
    expect(prompt).toContain("原始用户目标: 列出目录");
    expect(prompt).toContain("不要改变用户目标");
  });
});

// --- Repair loop orchestration ------------------------------------------------

describe("attemptPlanRepair", () => {
  it("returns ok with compiled plan when first repair attempt fixes the plan", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValueOnce(validPlanResult());

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      workflowId: "test-flow",
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].status).toBe("compiled");
      expect(result.attempts[0].attempt).toBe(1);
    }
    expect(planCall).toHaveBeenCalledTimes(1);
    const sentRequest = planCall.mock.calls[0][0];
    expect(sentRequest.repairContext).toBeDefined();
    expect(sentRequest.repairContext?.attempt).toBe(1);
    expect(sentRequest.repairContext?.maxAttempts).toBe(2);
    expect(sentRequest.repairContext?.originalUserGoal).toBe("List the directory");
    expect(sentRequest.repairContext?.diagnostics[0].code).toBe("MISSING_DEPENDENCY");
  });

  it("succeeds on the second attempt when first attempt still fails with repairable error", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall
      .mockResolvedValueOnce(invalidMissingDepPlan() as unknown as CommanderPlanResult)
      .mockResolvedValueOnce(validPlanResult());

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[1].status).toBe("compiled");
    }
    expect(planCall).toHaveBeenCalledTimes(2);
  });

  it("fails after maxAttempts when both repairs still fail", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValue(invalidMissingDepPlan() as unknown as CommanderPlanResult);

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts.every((a) => a.status === "failed")).toBe(true);
      // Loop exhausted - caller MUST NOT be told "you can try again" even
      // though the diagnostics themselves are still repairable in principle.
      expect(result.repairable).toBe(false);
    }
    expect(planCall).toHaveBeenCalledTimes(2);
  });

  it("returns repairable: false with maxAttempts=0 even when diagnostics are repairable", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValue(validPlanResult());

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 0,
    });

    expect(planCall).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(0);
      expect(result.repairable).toBe(false);
      expect(result.finalDiagnostics).toEqual([missingDepDiag]);
    }
  });

  it("fast-fails without calling the model when diagnostics are non-repairable", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();

    const nonRepairableDiag: PlanDiagnostic = {
      code: "UNKNOWN_AGENT",
      severity: "error",
      stepId: "x",
      message: "Agent \"ghost\" is not available.",
    };

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [nonRepairableDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(0);
      expect(result.repairable).toBe(false);
    }
    expect(planCall).not.toHaveBeenCalled();
  });

  it("short-circuits mid-loop when a repair attempt introduces a non-repairable error", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    // First repair keeps the missing dep, but also introduces a non-repairable error.
    const secondAttemptPlan: CommanderDagPlan = {
      title: "Worse",
      reasoning: "Introduces unknown agent",
      steps: [
        {
          id: "analyze",
          title: "Analyze",
          assignedAgentKind: "ghost-agent",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          successCriteria: "Done.",
        },
      ],
    };
    planCall.mockResolvedValueOnce(secondAttemptPlan as unknown as CommanderPlanResult);

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.repairable).toBe(false);
    }
    expect(planCall).toHaveBeenCalledTimes(1);
  });

  it("captures a model-call exception as a non-repairable failure", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockRejectedValueOnce(new Error("network down"));

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[0].diagnostics[0].message).toContain("network down");
      expect(result.repairable).toBe(false);
    }
  });

  it("falls back to maxAttempts=2 when caller passes invalid maxAttempts", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValue(invalidMissingDepPlan() as unknown as CommanderPlanResult);

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: -1,
    });

    expect(planCall).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
  });

  it("captures a malformed top-level shape as INVALID_PLAN_SHAPE instead of throwing", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    // Model returned a payload that is missing `steps` entirely.
    planCall.mockResolvedValueOnce({
      title: "broken",
      reasoning: "no steps",
    } as unknown as CommanderPlanResult);

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[0].diagnostics[0].code).toBe("INVALID_PLAN_SHAPE");
      expect(result.attempts[0].diagnostics[0].message).toContain("invalid top-level shape");
      // Shape errors are non-repairable - the loop must NOT call the model again.
      expect(result.repairable).toBe(false);
    }
    expect(planCall).toHaveBeenCalledTimes(1);
  });

  it("captures a step with missing required fields as INVALID_PLAN_SHAPE", async () => {
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValueOnce({
      title: "broken",
      reasoning: "bad step",
      steps: [
        {
          // missing `id`, `title`, `assignedAgentKind`, `successCriteria`
          dependsOn: [],
        } as unknown as CommanderPlanResult["steps"][number],
      ],
    });

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].diagnostics[0].code).toBe("INVALID_PLAN_SHAPE");
      // Path format: Zod uses dot form (steps.0.id); the prior
      // hand-written validator used bracket form (steps[0].id). Match
      // either so the test is stable across shape sources.
      expect(result.attempts[0].diagnostics[0].message).toMatch(/steps(?:\.0|\[0\])\.id/);
      expect(result.repairable).toBe(false);
    }
  });

  it("INVALID_PLAN_SHAPE is treated as non-repairable so it short-circuits the loop", async () => {
    // The first attempt produces a shape error. The loop must not be
    // re-entered even though maxAttempts is 2.
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall
      .mockResolvedValueOnce({ title: "x", reasoning: "y" } as unknown as CommanderPlanResult)
      .mockResolvedValueOnce(validPlanResult());

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "List the directory",
      invalidPlan: invalidMissingDepPlan(),
      diagnostics: [missingDepDiag],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 2,
    });

    expect(planCall).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairable).toBe(false);
      expect(result.attempts[0].diagnostics[0].code).toBe("INVALID_PLAN_SHAPE");
    }
  });
});
