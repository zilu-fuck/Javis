import { describe, expect, it, vi } from "vitest";
import { buildCommanderPlanRepairPrompt } from "../../commander-plan-schema";
import { attemptPlanRepair } from "../commander-plan-repair";
import { compileCommanderPlan } from "../commander-plan-compiler";
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
  { kind: "code", allowedToolNames: ["code.inspectWorkspace", "code.searchRepository"] },
  { kind: "verifier", allowedToolNames: ["verifier.check"] },
  { kind: "computer", allowedToolNames: ["computer.listDirectory"] },
] as const;

const availableTools: ToolDescriptor[] = [
  makeToolDescriptor("code.inspectWorkspace", { capabilityTags: ["workspace_inspect"], ownerAgentKinds: ["code"] }),
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
      workspacePath: "E:/selected-workspace",
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
      expect(result.plan.steps[0]).toMatchObject({
        instruction: "Analyze",
        hardConstraints: [],
        preferences: [],
        acceptanceCriteria: ["Done."],
      });
    }
    expect(planCall).toHaveBeenCalledTimes(1);
    const sentRequest = planCall.mock.calls[0][0];
    expect(sentRequest.repairContext).toBeDefined();
    expect(sentRequest.repairContext?.attempt).toBe(1);
    expect(sentRequest.repairContext?.maxAttempts).toBe(2);
    expect(sentRequest.repairContext?.originalUserGoal).toBe("List the directory");
    expect(sentRequest.repairContext?.diagnostics[0].code).toBe("MISSING_DEPENDENCY");
    expect(sentRequest.workspacePath).toBe("E:/selected-workspace");
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

  it("preserves routing fields that are unrelated to the reported repair", async () => {
    const invalidPlan: CommanderDagPlan = {
      title: "Search repository",
      reasoning: "Search before reporting.",
      steps: [{
        id: "search",
        title: "Search repository",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        executionMode: "direct_tool_call",
        successCriteria: "Search evidence is returned.",
      }],
    };
    const missingInputDiagnostic: PlanDiagnostic = {
      code: "MISSING_TOOL_INPUT",
      severity: "error",
      stepId: "search",
      path: "steps[0].toolInput.query",
      message: "Search query is missing.",
    };
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValueOnce({
      title: "Search repository",
      reasoning: "Supply the missing query.",
      steps: [{
        id: "search",
        title: "Search repository",
        assignedAgentKind: "computer",
        requiredCapabilities: [],
        dependsOn: [],
        toolInput: { query: "primary capability" },
        executionMode: "react",
        successCriteria: "Search evidence is returned.",
      }],
    });

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "Search the repository",
      invalidPlan,
      diagnostics: [missingInputDiagnostic],
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools,
      maxAttempts: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps[0]).toMatchObject({
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        executionMode: "direct_tool_call",
        toolInput: { query: "primary capability" },
      });
    }
  });

  it("allows a plan-level route diagnostic to reassign an existing step to the required agent", async () => {
    const writeTool = makeToolDescriptor("file.writeText", {
      permissionLevel: "confirmed_write",
      requiredPlanIntent: "write",
      capabilityTags: ["file_execute"],
      ownerAgentKinds: ["file", "doc-updater"],
      requiredInputs: [
        { name: "targetPath", type: "string", nonEmpty: true },
        { name: "content", type: "string", nonEmpty: true },
      ],
    });
    const invalidPlan: CommanderDagPlan = {
      title: "Save summary",
      reasoning: "Persist the requested summary.",
      steps: [{
        id: "write-summary",
        title: "Write summary",
        assignedAgentKind: "doc-updater",
        primaryCapability: "doc_update",
        toolName: "file.writeText",
        toolInput: { targetPath: "summary.md", content: "Summary" },
        requiredCapabilities: ["file_execute"],
        dependsOn: [],
        executionMode: "direct_tool_call",
        successCriteria: "summary.md is written.",
      }],
    };
    const routeDiagnostics: PlanDiagnostic[] = [{
      code: "MISSING_REQUIRED_AGENT_ROUTE",
      severity: "error",
      path: "steps",
      message: "The file persistence route is missing.",
    }, {
      code: "MISSING_REQUIRED_ROUTE_TOOL",
      severity: "error",
      path: "steps",
      message: "The File Agent must use file.writeText.",
    }];
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValueOnce({
      ...invalidPlan,
      steps: [{
        ...invalidPlan.steps[0],
        assignedAgentKind: "file",
        primaryCapability: "file_execute",
      }],
    });

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "把这份总结保存成 summary.md。",
      invalidPlan,
      diagnostics: routeDiagnostics,
      availableAgents: [
        { kind: "file", allowedToolNames: ["file.writeText"] },
        { kind: "doc-updater", allowedToolNames: ["file.writeText"] },
      ],
      availableTools: [writeTool],
      supportedApprovalGatedTools: ["file.writeText"],
      planIntents: { write: true, export: false, statistics: false, retrieval: false },
      maxAttempts: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps[0]).toMatchObject({
        assignedAgentKind: "file",
        primaryCapability: "file_execute",
        toolName: "file.writeText",
      });
    }
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
    // First repair adds a new step with a non-repairable error. Existing-step
    // routing fields are intentionally stabilized by the repair loop.
    const secondAttemptPlan: CommanderDagPlan = {
      title: "Worse",
      reasoning: "Introduces unknown agent",
      steps: [
        {
          id: "analyze",
          title: "Analyze",
          assignedAgentKind: "code",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          successCriteria: "Done.",
        },
        {
          id: "ghost-step",
          title: "Unknown agent step",
          assignedAgentKind: "ghost-agent",
          requiredCapabilities: [],
          dependsOn: ["analyze"],
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

  it("runs the deterministic local repair before any model call (Layer 2)", async () => {
    // The invalid plan's only problem is an absolute write target inside
    // the selected workspace. The deterministic fixer relativizes it, the
    // plan compiles, and the model is never called.
    const writeAgents = [
      { kind: "commander", allowedToolNames: ["commander.synthesize"] },
      { kind: "file", allowedToolNames: ["file.writeText"] },
      { kind: "research", allowedToolNames: ["web.search"] },
    ] as const;
    const writeTools: ToolDescriptor[] = [
      makeToolDescriptor("web.search", { capabilityTags: ["web_search"], ownerAgentKinds: ["research"] }),
      makeToolDescriptor("file.writeText", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["file_execute"],
        ownerAgentKinds: ["file"],
        requiredInputs: [
          { name: "targetPath", type: "string", nonEmpty: true },
          { name: "content", type: "string" },
        ],
      }),
    ];
    const invalidPlan: CommanderDagPlan = {
      title: "Write report",
      reasoning: "Report must be saved.",
      steps: [
        {
          id: "collect",
          title: "Collect evidence",
          assignedAgentKind: "research",
          toolName: "web.search",
          requiredCapabilities: ["web_search"],
          dependsOn: [],
          toolInput: { query: "topic" },
          outputContextKey: "researchEvidence",
          successCriteria: "Evidence collected.",
        },
        {
          id: "write",
          title: "Write report",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          requiredCapabilities: [],
          dependsOn: ["collect"],
          inputContextKeys: ["researchEvidence"],
          toolInput: { targetPath: "E:/workspace/reports/out.md" },
          successCriteria: "Report written.",
        },
      ],
    };
    const unsafePathDiag: PlanDiagnostic = {
      code: "UNSAFE_WRITE_PATH",
      severity: "error",
      stepId: "write",
      path: "steps[1].toolInput.targetPath",
      message: "file.writeText targetPath is an absolute path.",
      suggestedFix: "Use a workspace-relative path.",
    };
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "Save the trend report to a file",
      workspacePath: "E:/workspace",
      invalidPlan,
      diagnostics: [unsafePathDiag],
      availableAgents: writeAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools: writeTools,
      supportedApprovalGatedTools: ["file.writeText"],
      planIntents: { write: true, export: false, statistics: false, retrieval: true },
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].channel).toBe("deterministic");
      expect(result.attempts[0].repairNotes?.some((note) => note.includes("relativized"))).toBe(true);
      expect(result.plan.steps[1]?.toolInput?.targetPath).toBe("reports/out.md");
    }
    // The model was never consulted — deterministic repair sufficed.
    expect(planCall).not.toHaveBeenCalled();
  });

  it("allows a misrouted project-inspection step to be fully reassigned from Computer to Code", async () => {
    const projectTools: ToolDescriptor[] = [
      ...availableTools,
      makeToolDescriptor("commander.synthesize", {
        capabilityTags: ["synthesis"],
        ownerAgentKinds: ["commander"],
      }),
    ];
    const projectIntents = {
      write: false,
      export: false,
      statistics: false,
      retrieval: false,
      projectUnderstanding: true,
      desktopInteraction: false,
    };
    const invalidPlan: CommanderDagPlan = {
      title: "Inspect project",
      reasoning: "Inspect, verify, and summarize the selected workspace.",
      steps: [
        {
          id: "inspect-project",
          title: "Inspect project structure",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          executionMode: "direct_tool_call",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          toolInput: { path: "E:/workspace" },
          outputContextKey: "projectEvidence",
          successCriteria: "Collect evidence about project modules and risks.",
        },
        {
          id: "verify-project",
          title: "Verify project evidence",
          assignedAgentKind: "verifier",
          toolName: "verifier.check",
          executionMode: "direct_tool_call",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["inspect-project"],
          inputContextKeys: ["projectEvidence"],
          outputContextKey: "verifiedProjectEvidence",
          successCriteria: "Verify the repository evidence.",
        },
        {
          id: "answer-project",
          title: "Answer with verified findings",
          assignedAgentKind: "commander",
          executionMode: "direct_response",
          requiredCapabilities: ["synthesis"],
          dependsOn: ["verify-project"],
          inputContextKeys: ["projectEvidence", "verifiedProjectEvidence"],
          successCriteria: "Return the verified module and risk summary.",
        },
      ],
    };
    const initialCompile = compileCommanderPlan({
      plan: invalidPlan,
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools: projectTools,
      planIntents: projectIntents,
    });
    expect(initialCompile.ok).toBe(false);
    if (initialCompile.ok) throw new Error("Expected the Computer-routed plan to fail compilation.");
    expect(initialCompile.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "MISROUTED_PROJECT_INSPECTION",
      "MISSING_PROJECT_EVIDENCE_STEP",
    ]));

    const repairedPlan: CommanderPlanResult = {
      ...invalidPlan,
      reasoning: "Use repository-aware evidence before verification and synthesis.",
      steps: [
        {
          ...invalidPlan.steps[0],
          assignedAgentKind: "code",
          toolName: "code.inspectWorkspace",
          requiredCapabilities: ["workspace_inspect"],
          toolInput: { maxDepth: 3, maxEntries: 400 },
        },
        invalidPlan.steps[1],
        invalidPlan.steps[2],
      ],
    };
    const planCall = vi.fn<Parameters<typeof attemptPlanRepair>[0]["commanderPlan"]>();
    planCall.mockResolvedValueOnce(repairedPlan);

    const result = await attemptPlanRepair({
      commanderPlan: planCall,
      originalUserGoal: "Inspect the current project structure, modules, and obvious risks.",
      workspacePath: "E:/workspace",
      invalidPlan,
      diagnostics: initialCompile.diagnostics,
      availableAgents: availableAgents as unknown as Array<{
        kind: string;
        allowedToolNames: string[];
        capabilities?: readonly string[];
      }>,
      availableTools: projectTools,
      planIntents: projectIntents,
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    expect(planCall).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.plan.steps[0]).toMatchObject({
        id: "inspect-project",
        assignedAgentKind: "code",
        toolName: "code.inspectWorkspace",
        executionMode: "direct_tool_call",
        requiredCapabilities: ["workspace_inspect"],
      });
      expect(result.plan.steps.map((step) => step.assignedAgentKind)).toEqual([
        "code",
        "verifier",
        "commander",
      ]);
    }
  });
});
