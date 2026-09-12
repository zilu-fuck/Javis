import { demoAgents } from "../agents";
import { routeMessage } from "../local-router";
import { isTextWriteGoal } from "../text-write-flow";
import { compileCommanderPlan } from "../planning";
import { detectCommanderPlanIntents } from "../planning/plan-legality";
import { initialToolDescriptors } from "@javis/tools";
import type { ToolDescriptor } from "@javis/tools";
import {
  isPlanExpectation,
  type GoldenTask,
  type GoldenTaskCategory,
} from "./golden-tasks";

export type GoldenFailureKind =
  | "unexpected_route_level"
  | "unexpected_write_intent"
  | "unexpected_plan_intent"
  | "plan_should_have_been_rejected"
  | "plan_should_have_been_accepted"
  | "missing_diagnostic"
  | "runner_error";

export interface GoldenTaskResult {
  id: string;
  category: GoldenTaskCategory;
  ok: boolean;
  /** Compact description of what was required. */
  expected: string;
  /** Compact description of what the harness did. */
  observed: string;
  failureKind?: GoldenFailureKind;
}

/**
 * The agents and tools the eval compiles against.
 *
 * These are the *production* defaults (`demoAgents` / `initialToolDescriptors`)
 * rather than a test fixture, so the golden set also catches a plan that stopped
 * compiling because a tool left the registry.
 */
const EVAL_AGENTS = demoAgents.map((agent) => ({
  kind: agent.kind,
  allowedToolNames: [...agent.allowedToolNames],
  capabilities: (agent as { capabilities?: readonly string[] }).capabilities ?? [],
}));

const EVAL_TOOLS: ToolDescriptor[] = [...initialToolDescriptors];

const APPROVAL_GATED_TOOLS = EVAL_TOOLS
  .filter((tool) => tool.permissionLevel === "confirmed_write")
  .map((tool) => tool.name);

const BASE_PLAN_INTENTS = {
  write: false,
  export: false,
  statistics: false,
  retrieval: false,
};

export function runGoldenTask(task: GoldenTask): GoldenTaskResult {
  try {
    return runGoldenTaskUnsafe(task);
  } catch (error) {
    return {
      id: task.id,
      category: task.category,
      ok: false,
      expected: "the eval runner completes",
      observed: error instanceof Error ? error.message : String(error),
      failureKind: "runner_error",
    };
  }
}

function runGoldenTaskUnsafe(task: GoldenTask): GoldenTaskResult {
  const base = { id: task.id, category: task.category };

  if (isPlanExpectation(task.expectation)) {
    const { plan, accepted, diagnosticCode } = task.expectation;
    const planIntents = {
      ...BASE_PLAN_INTENTS,
      ...(task.expectation.planIntents ?? {}),
    };
    const result = compileCommanderPlan({
      plan,
      availableAgents: EVAL_AGENTS,
      availableTools: EVAL_TOOLS,
      supportedApprovalGatedTools: APPROVAL_GATED_TOOLS,
      preloadedContextKeys: ["userGoal", "taskId"],
      planIntents,
      userGoal: task.goal,
    });

    const codes = result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
    const expectedLabel = accepted
      ? "plan compiles"
      : `plan rejected${diagnosticCode ? ` with ${diagnosticCode}` : ""}`;
    const observedLabel = result.ok ? "plan compiles" : `plan rejected with ${codes.join(", ") || "no diagnostics"}`;

    if (result.ok !== accepted) {
      return {
        ...base,
        ok: false,
        expected: expectedLabel,
        observed: observedLabel,
        failureKind: accepted ? "plan_should_have_been_accepted" : "plan_should_have_been_rejected",
      };
    }
    if (!accepted && diagnosticCode && !codes.includes(diagnosticCode)) {
      return {
        ...base,
        ok: false,
        expected: expectedLabel,
        observed: observedLabel,
        failureKind: "missing_diagnostic",
      };
    }
    return { ...base, ok: true, expected: expectedLabel, observed: observedLabel };
  }

  const expectation = task.expectation;
  const decision = routeMessage(task.goal);
  const textWrite = isTextWriteGoal(task.goal);
  const intents = detectCommanderPlanIntents(task.goal);

  const mismatches: Array<{ kind: GoldenFailureKind; detail: string }> = [];
  if (expectation.routeLevel && decision.level !== expectation.routeLevel) {
    mismatches.push({
      kind: "unexpected_route_level",
      detail: `level ${decision.level} (expected ${expectation.routeLevel})`,
    });
  }
  if (expectation.textWrite !== undefined && textWrite !== expectation.textWrite) {
    mismatches.push({
      kind: "unexpected_write_intent",
      detail: `textWrite=${textWrite} (expected ${expectation.textWrite})`,
    });
  }
  for (const [key, value] of Object.entries(expectation.planIntents ?? {})) {
    const actual = intents[key as keyof typeof intents];
    if (actual !== value) {
      mismatches.push({
        kind: "unexpected_plan_intent",
        detail: `intent ${key}=${String(actual)} (expected ${String(value)})`,
      });
    }
  }

  const expectedParts = [
    expectation.routeLevel ? `level=${expectation.routeLevel}` : undefined,
    expectation.textWrite !== undefined ? `textWrite=${expectation.textWrite}` : undefined,
    ...Object.entries(expectation.planIntents ?? {}).map(([key, value]) => `${key}=${String(value)}`),
  ].filter(Boolean);
  const observedParts = [
    `level=${decision.level}`,
    `mode=${decision.mode}`,
    `textWrite=${textWrite}`,
    `write=${intents.write}`,
    `export=${intents.export}`,
    `statistics=${intents.statistics}`,
    `retrieval=${intents.retrieval}`,
  ];

  return {
    ...base,
    ok: mismatches.length === 0,
    expected: expectedParts.join(", ") || "no constraint",
    observed: mismatches.length === 0
      ? observedParts.join(", ")
      : `${observedParts.join(", ")} | ${mismatches.map((m) => m.detail).join("; ")}`,
    failureKind: mismatches[0]?.kind,
  };
}

export function runGoldenTasks(tasks: readonly GoldenTask[]): GoldenTaskResult[] {
  return tasks.map(runGoldenTask);
}
