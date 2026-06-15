/**
 * PlanGenerationTrace
 *
 * Structured, serializable audit of every Commander plan that flowed
 * through the executor: the initial plan, optional repair attempts, and
 * any per-step recovery (replan) plans. Each compile gate outcome is
 * captured along with the diagnostics and the final plan shape, so
 * post-mortem debugging and product analytics can answer
 *
 *   - "Did the initial plan pass compile on the first try, or did it
 *     need repair? How many repair attempts?"
 *   - "When a step failed and replanDag() was called, did the recovery
 *     plan pass the compile gate, or was recovery abandoned?"
 *   - "What did the final compiled plan look like vs. the raw model
 *     output?"
 *
 * This is the canonical, persisted artifact. It lives alongside
 * `RecoveryReport` (which is user-facing) and `ExecutionTrace` (which is
 * per-step timing).
 */

import type { PlanDiagnostic } from "./commander-plan-diagnostics";
import type { CommanderDagPlan } from "../commander-plan-schema";
import {
  PLAN_GENERATION_TRACE_SCHEMA_VERSION,
  COMMANDER_PLAN_SCHEMA_VERSION,
} from "./schema";

export {
  PLAN_GENERATION_TRACE_SCHEMA_VERSION,
  COMMANDER_PLAN_SCHEMA_VERSION,
} from "./schema";

export type PlanGenerationStage =
  | "initial"
  | "repair";

/** Outcome of a single compile gate. */
export type PlanGenerationStageStatus =
  | "compiled"
  | "compiled_with_warnings"
  | "failed_repairable"
  | "failed_non_repairable";

export interface PlanGenerationStageRecord {
  /** Which gate produced this record. */
  stage: PlanGenerationStage;
  /** 1-based attempt number within the stage (repair is 1, 2, ...; initial is always 1). */
  attempt: number;
  /** Compile status. */
  status: PlanGenerationStageStatus;
  /** Diagnostics emitted by the compiler (errors + warnings). */
  diagnostics: PlanDiagnostic[];
  /**
   * Step ids in the plan that successfully passed this gate. For
   * initial/repair this is the post-repair step set; for recovery it is
   * the recovery step set.
   */
  stepIds: string[];
  /** Optional human-readable detail (caller may attach a short note). */
  detail?: string;
}

/** Single repair attempt (subset of StageRecord for stage=repair). */
export interface PlanRepairAttemptRecord extends PlanGenerationStageRecord {
  stage: "repair";
}

/** Single recovery (replan) compile. Independent of PlanGenerationStageRecord
 * because the stage field is the literal "recovery", outside the
 * PlanGenerationStage enum (which only covers initial/repair). */
export interface PlanRecoveryCompileRecord {
  stage: "recovery";
  /** 1-based attempt number. */
  attempt: number;
  /** Compile status. */
  status: PlanGenerationStageStatus;
  /** Diagnostics emitted by the compiler (errors + warnings). */
  diagnostics: PlanDiagnostic[];
  /** Step ids in the plan that passed this gate. */
  stepIds: string[];
  /** Optional human-readable detail. */
  detail?: string;
  /** id of the step whose failure triggered this recovery compile. */
  failedStepId: string;
}

export interface PlanGenerationTrace {
  /** Schema version of this trace shape itself. Bumped on breaking changes. */
  schemaVersion: string;
  /** Schema version of the underlying CommanderDagPlan that was compiled. */
  planSchemaVersion: string;
  generatedAt: string;
  /** User goal passed to the initial plan call. */
  userGoal: string;
  /** Whether the initial plan compiled successfully (with or without warnings). */
  initialCompiled: boolean;
  /**
   * Number of repair attempts the executor spent on the initial plan.
   * 0 means the initial plan compiled first try.
   */
  repairAttemptCount: number;
  /** Per-stage record of the initial plan and any repair attempts. */
  stages: PlanGenerationStageRecord[];
  /**
   * Per-step recovery compile results. Empty when no step failed and
   * triggered replanDag.
   */
  recoveryCompiles: PlanRecoveryCompileRecord[];
  /**
   * Raw model output JSON string captured at the initial plan call,
   * before any normalization. Optional because the trace may be
   * assembled before the first plan call returns (e.g. on a runtime
   * failure during normalize).
   */
  extractedJson?: string;
  /**
   * The post-normalize initial plan (after defaulting required fields
   * and clamping the Zod shape). Captured once for the initial plan;
   * absent on traces assembled before the initial plan call returns.
   */
  normalizedPlan?: CommanderDagPlan;
  /**
   * Identifier of the planner prompt template that produced the initial
   * plan call. Bumped when the prompt text changes so post-mortem
   * analytics can correlate plan success with prompt version.
   */
  promptVersion?: string;
}

export function buildPlanGenerationTrace(input: {
  userGoal: string;
  stages: PlanGenerationStageRecord[];
  recoveryCompiles: PlanRecoveryCompileRecord[];
  generatedAt?: string;
  extractedJson?: string;
  normalizedPlan?: CommanderDagPlan;
  promptVersion?: string;
}): PlanGenerationTrace {
  const initialStage = input.stages.find((s) => s.stage === "initial");
  const repairStages = input.stages.filter((s) => s.stage === "repair");
  return {
    schemaVersion: PLAN_GENERATION_TRACE_SCHEMA_VERSION,
    planSchemaVersion: COMMANDER_PLAN_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    userGoal: input.userGoal,
    initialCompiled: initialStage?.status === "compiled"
      || initialStage?.status === "compiled_with_warnings",
    repairAttemptCount: repairStages.length,
    stages: input.stages.map((s) => ({ ...s })),
    recoveryCompiles: input.recoveryCompiles.map((r) => ({ ...r })),
    ...(input.extractedJson !== undefined ? { extractedJson: input.extractedJson } : {}),
    ...(input.normalizedPlan !== undefined ? { normalizedPlan: input.normalizedPlan } : {}),
    ...(input.promptVersion !== undefined ? { promptVersion: input.promptVersion } : {}),
  };
}

/**
 * Convenience for the executor: classify a compile result into one of the
 * stable status values the trace uses. Centralized so the executor and
 * the trace builder stay in lock-step.
 */
export function classifyCompileStatus(
  ok: boolean,
  repairable: boolean,
  warnings: PlanDiagnostic[],
): PlanGenerationStageStatus {
  if (!ok) return repairable ? "failed_repairable" : "failed_non_repairable";
  return warnings.length > 0 ? "compiled_with_warnings" : "compiled";
}
