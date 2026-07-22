import { describe, expect, it } from "vitest";
import { createArtifactEnvelope } from "./artifact-envelope";
import { buildCheckpointFromDagState, computePlanHash } from "./workflow-checkpoint";
import type { WorkbenchWorkflow } from "./workflows";

const workflow: WorkbenchWorkflow = {
  id: "code-review",
  title: "Review",
  triggerExamples: [],
  goal: "Review code",
  coordinatorAgentKind: "commander",
  participatingAgentKinds: ["commander", "code", "verifier"],
  currentSupport: "implemented",
  safetyNotes: [],
  steps: [
    {
      id: "scan",
      title: "Scan repository",
      agentKind: "code",
      input: "repo",
      output: "evidence",
      permissionLevel: "read",
      dependsOn: [],
      canRunInParallel: false,
      outputContextKey: "repoEvidence",
    },
  ],
};

describe("buildCheckpointFromDagState", () => {
  it("persists ordinary shared context values as restorable envelopes", () => {
    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow,
      completedStepIds: ["scan"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: { files: ["src/index.ts"] },
      },
      eventSequence: 7,
    });

    expect(checkpoint.contextSnapshot.repoEvidence.payload).toEqual({
      files: ["src/index.ts"],
    });
    expect(checkpoint.contextSnapshot.repoEvidence.producer).toMatchObject({
      stepId: "scan",
      agentKind: "code",
    });
  });

  it("prefers existing artifact envelopes over raw context payloads", () => {
    const envelope = createArtifactEnvelope({ files: ["README.md"] }, {
      taskId: "task-1",
      runId: "run-1",
      type: "repoEvidence",
      producer: { stepId: "scan", agentKind: "code" },
    });
    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow,
      completedStepIds: ["scan"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        repoEvidence: { files: ["src/index.ts"] },
      },
      envelopes: {
        repoEvidence: envelope,
      },
      eventSequence: 8,
    });

    expect(checkpoint.contextSnapshot.repoEvidence.artifactId).toBe(envelope.artifactId);
    expect(checkpoint.contextSnapshot.repoEvidence.payload).toEqual({
      files: ["README.md"],
    });
  });

  it("copies durable Agent metrics and token usage without retaining mutable inputs", () => {
    const metrics = {
      backend: "langchain" as const,
      runCount: 1,
      completedRunCount: 1,
      successRate: 1,
      totalDurationMs: 20,
      averageDurationMs: 20,
      modelCalls: 2,
      toolCalls: 1,
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    };
    const tokenUsage = {
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      modelCalls: 2,
      byAgentKind: [{
        agentKind: "research",
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        modelCalls: 2,
      }],
    };
    const routingMetrics = [{
      providerId: "openai",
      agentKind: "research" as const,
      taskType: "read",
      routeCount: 2,
      rolloutTargetCount: 2,
      langchainRouteCount: 1,
      legacyRouteCount: 1,
      unavailableRouteCount: 0,
      fallbackCount: 1,
      fallbackRate: 0.5,
      fallbackReasons: [{ reason: "runtime_factory_unavailable" as const, count: 1 }],
      observationIds: ["run-1:scan", "run-1:legacy"],
    }];
    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow,
      completedStepIds: ["scan"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {},
      eventSequence: 9,
      agentRuntimeMetrics: [metrics],
      agentRuntimeRoutingMetrics: routingMetrics,
      tokenUsage,
    });

    metrics.usage.inputTokens = 99;
    tokenUsage.byAgentKind[0]!.inputTokens = 99;
    routingMetrics[0]!.providerId = "changed";
    routingMetrics[0]!.fallbackReasons[0]!.count = 99;
    routingMetrics[0]!.observationIds[0] = "changed";

    expect(checkpoint.agentRuntimeMetrics?.[0]?.usage?.inputTokens).toBe(13);
    expect(checkpoint.tokenUsage?.byAgentKind[0]?.inputTokens).toBe(13);
    expect(checkpoint.agentRuntimeRoutingMetrics?.[0]?.providerId).toBe("openai");
    expect(checkpoint.agentRuntimeRoutingMetrics?.[0]?.fallbackReasons[0]?.count).toBe(1);
    expect(checkpoint.agentRuntimeRoutingMetrics?.[0]?.observationIds[0]).toBe("run-1:scan");
  });
});

function testWorkflow(): WorkbenchWorkflow {
  return {
    id: "read-current-project",
    title: "Test workflow",
    triggerExamples: [],
    goal: "Test durable checkpoints",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "code"],
    currentSupport: "partial",
    safetyNotes: [],
    steps: [
      {
        id: "inspect",
        title: "Inspect",
        agentKind: "code",
        input: "workspace",
        output: "diff preview",
        permissionLevel: "read",
        dependsOn: [],
        canRunInParallel: false,
      },
    ],
  };
}

describe("buildCheckpointFromDagState", () => {
  it("builds a stable plan hash for semantically identical step orderings", () => {
    const stepsA = testWorkflow().steps;
    const stepsB = [
      { ...stepsA[0], dependsOn: [...(stepsA[0]?.dependsOn ?? [])] },
    ];

    expect(computePlanHash(stepsA)).toBe(computePlanHash(stepsB));
  });

  it("changes the plan hash when execution-significant fields change", () => {
    const [baseStep] = testWorkflow().steps;
    const baseHash = computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: false,
    }]);

    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "diffPreview",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "confirmed_write",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["diffPreview"],
      permissionLevel: "read",
      canRunInParallel: false,
    }])).not.toBe(baseHash);
    expect(computePlanHash([{
      ...baseStep,
      outputContextKey: "repoEvidence",
      inputContextKeys: ["workspacePath"],
      permissionLevel: "read",
      canRunInParallel: true,
    }])).not.toBe(baseHash);
  });

  it("binds Commander tool dispatch fields into the plan hash", () => {
    const [baseStep] = testWorkflow().steps;
    const commanderStep = {
      ...baseStep,
      toolName: "code.searchRepository",
      toolInput: { goal: "find entrypoint", knownTerms: ["main", "src"] },
      executionMode: "direct_tool_call",
      capability: "code_search",
      choices: [{ label: "Current workspace", value: "workspace", isRecommended: true }],
      successCriteria: "Repository evidence identifies the entrypoint.",
    };
    const baseHash = computePlanHash([commanderStep]);

    expect(baseHash).toMatch(/^plan-sha256-v2-/);
    for (const changed of [
      { ...commanderStep, toolName: "code.traceCallChain" },
      { ...commanderStep, toolInput: { goal: "find config", knownTerms: ["main", "src"] } },
      { ...commanderStep, executionMode: "react" },
      { ...commanderStep, capability: "code_trace" },
      { ...commanderStep, choices: [{ label: "All workspaces", value: "all" }] },
      { ...commanderStep, successCriteria: "A call chain is returned." },
      { ...commanderStep, instruction: "Trace the repository call chain." },
      { ...commanderStep, hardConstraints: ["Read-only"] },
      { ...commanderStep, preferences: ["Prefer source-backed evidence"] },
      { ...commanderStep, acceptanceCriteria: ["The call chain is source-backed."] },
      { ...commanderStep, outputSchemaRef: "repoTrace" },
      { ...commanderStep, primaryCapability: "code_trace" },
      { ...commanderStep, artifactObligation: "required" as const },
      {
        ...commanderStep,
        completionPolicy: {
          partial: "publish_and_continue" as const,
          blocked: "replan" as const,
          needsClarification: "replan" as const,
        },
      },
    ]) {
      expect(computePlanHash([changed])).not.toBe(baseHash);
    }
  });

  it("keeps Commander tool input object key order hash-compatible", () => {
    const [baseStep] = testWorkflow().steps;
    const left = {
      ...baseStep,
      toolName: "code.searchRepository",
      toolInput: { goal: "find entrypoint", knownTerms: ["main", "src"] },
      executionMode: "direct_tool_call",
    };
    const right = {
      ...baseStep,
      toolName: "code.searchRepository",
      toolInput: { knownTerms: ["main", "src"], goal: "find entrypoint" },
      executionMode: "direct_tool_call",
    };

    expect(computePlanHash([left])).toBe(computePlanHash([right]));
  });

  it("preserves artifact envelopes supplied through contextSnapshot", () => {
    const envelope = createArtifactEnvelope(
      { changedFiles: ["src/a.ts"], diff: "patch" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect", agentKind: "code" },
        sensitivity: "workspace",
      },
    );

    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow: testWorkflow(),
      completedStepIds: ["inspect"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: {
        diffPreview: envelope,
        legacyRawValue: { omitted: true },
      },
      eventSequence: 5,
    });

    expect(checkpoint.contextSnapshot.diffPreview).toBe(envelope);
    expect(checkpoint.contextSnapshot.legacyRawValue?.payload).toEqual({ omitted: true });
  });

  it("lets explicit envelopes override matching contextSnapshot envelopes", () => {
    const original = createArtifactEnvelope(
      { diff: "old" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect" },
      },
    );
    const replacement = createArtifactEnvelope(
      { diff: "new" },
      {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "inspect-retry" },
      },
    );

    const checkpoint = buildCheckpointFromDagState({
      taskId: "task-1",
      runId: "run-1",
      workflow: testWorkflow(),
      completedStepIds: ["inspect"],
      abandonedStepIds: [],
      runningStepIds: [],
      contextSnapshot: { diffPreview: original },
      envelopes: { diffPreview: replacement },
      eventSequence: 6,
    });

    expect(checkpoint.contextSnapshot.diffPreview).toEqual(replacement);
  });
});
