/**
 * Shared contract between Commander planning, step execution, handoffs, and
 * verification. The normalizer deliberately accepts legacy step shapes so
 * persisted plans and existing executors remain runnable during migration.
 */

export const STEP_RESULT_STATUSES = [
  "completed",
  "partial",
  "blocked",
  "needs_clarification",
  "failed",
] as const;

export type StepResultStatus = (typeof STEP_RESULT_STATUSES)[number];

export type StepEvidenceKind =
  | "file"
  | "command"
  | "source"
  | "url"
  | "log"
  | "permission"
  | "screenshot"
  | "artifact"
  | "manual";

export interface StepEvidence {
  kind: StepEvidenceKind;
  label: string;
  data?: unknown;
  reference?: string;
}

export type ArtifactObligation = "required" | "optional" | "none";

export interface StepCompletionPolicy {
  partial: "publish_and_continue" | "retain_and_replan" | "stop";
  blocked: "wait" | "replan";
  needsClarification: "ask_user" | "replan";
}

export const DEFAULT_STEP_COMPLETION_POLICY: Readonly<StepCompletionPolicy> = {
  partial: "stop",
  blocked: "replan",
  needsClarification: "replan",
};

export interface StepBlockedReason {
  kind: "approval" | "environment" | "policy" | "external";
  resumable: boolean;
  retryable: boolean;
  detail: string;
  wakeCondition?: {
    event: "approval_resolved" | "context_available" | "retry_at" | "external_event";
    ref: string;
    retryAt?: string;
  };
}

export interface StepErrorDetail {
  code: string;
  message: string;
  phase: "model" | "tool" | "protocol" | "verification" | "runtime";
  retryable: boolean;
}

export interface StepContract {
  instruction: string;
  hardConstraints: string[];
  preferences: string[];
  acceptanceCriteria: string[];
  outputSchemaRef?: string;
  primaryCapability?: string;
  artifactObligation: ArtifactObligation;
  completionPolicy: StepCompletionPolicy;
}

export interface StepContractInput {
  title: string;
  instruction?: string;
  hardConstraints?: string[];
  preferences?: string[];
  acceptanceCriteria?: string[];
  outputSchemaRef?: string;
  primaryCapability?: string;
  capability?: string;
  requiredCapabilities?: string[];
  artifactObligation?: ArtifactObligation;
  completionPolicy?: Partial<StepCompletionPolicy>;
  outputContextKey?: string;
  successCriteria?: string;
}

export interface StepResult<T = unknown> {
  status: StepResultStatus;
  output?: T;
  evidence: StepEvidence[];
  assumptions: string[];
  unresolvedQuestions: string[];
  unmetCriteria?: string[];
  requestedContextKeys?: string[];
  requestedAgentKind?: string;
  blockedReason?: StepBlockedReason;
  error?: string;
  errorDetail?: StepErrorDetail;
}

export interface StepResultInput<T = unknown> {
  status?: StepResultStatus;
  output?: T;
  evidence?: StepEvidence[];
  assumptions?: string[];
  unresolvedQuestions?: string[];
  unmetCriteria?: string[];
  requestedContextKeys?: string[];
  requestedAgentKind?: string;
  blockedReason?: StepBlockedReason;
  error?: string;
  errorDetail?: StepErrorDetail;
}

export function normalizeStepContract(input: StepContractInput): StepContract {
  const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria);
  const fallbackCriteria = normalizeStringArray(
    input.successCriteria ? [input.successCriteria] : undefined,
  );
  return {
    instruction: normalizeText(input.instruction) ?? normalizeText(input.title) ?? "Complete the step.",
    hardConstraints: normalizeStringArray(input.hardConstraints),
    preferences: normalizeStringArray(input.preferences),
    acceptanceCriteria: acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : fallbackCriteria.length > 0
        ? fallbackCriteria
        : ["Step completed with usable evidence."],
    ...(normalizeText(input.outputSchemaRef)
      ? { outputSchemaRef: normalizeText(input.outputSchemaRef) }
      : {}),
    ...(resolvePrimaryCapability(input)
      ? { primaryCapability: resolvePrimaryCapability(input) }
      : {}),
    artifactObligation: normalizeArtifactObligation(
      input.artifactObligation,
      normalizeText(input.outputContextKey) ? "required" : "none",
    ),
    completionPolicy: normalizeCompletionPolicy(input.completionPolicy),
  };
}

export function normalizeStepResult<T>(input: StepResultInput<T>): StepResult<T> {
  const status = STEP_RESULT_STATUSES.includes(input.status ?? "completed")
    ? input.status ?? "completed"
    : "failed";
  return {
    status,
    ...("output" in input ? { output: input.output } : {}),
    evidence: normalizeEvidence(input.evidence),
    assumptions: normalizeStringArray(input.assumptions),
    unresolvedQuestions: normalizeStringArray(input.unresolvedQuestions),
    ...(normalizeStringArray(input.unmetCriteria).length > 0
      ? { unmetCriteria: normalizeStringArray(input.unmetCriteria) }
      : {}),
    ...(normalizeStringArray(input.requestedContextKeys).length > 0
      ? { requestedContextKeys: normalizeStringArray(input.requestedContextKeys) }
      : {}),
    ...(normalizeText(input.requestedAgentKind)
      ? { requestedAgentKind: normalizeText(input.requestedAgentKind) }
      : {}),
    ...(normalizeBlockedReason(input.blockedReason)
      ? { blockedReason: normalizeBlockedReason(input.blockedReason) }
      : {}),
    ...(normalizeText(input.error) ? { error: normalizeText(input.error) } : {}),
    ...(normalizeErrorDetail(input.errorDetail)
      ? { errorDetail: normalizeErrorDetail(input.errorDetail) }
      : {}),
  };
}

export function createFailedStepResult(error: unknown): StepResult {
  const message = error instanceof Error ? error.message : String(error);
  return normalizeStepResult({
    status: "failed",
    error: message,
    errorDetail: {
      code: "step_execution_failed",
      message,
      phase: "runtime",
      retryable: false,
    },
  });
}

export function isTerminalStepResultStatus(status: StepResultStatus): boolean {
  return status === "blocked" || status === "needs_clarification" || status === "failed";
}

function normalizeEvidence(evidence: StepEvidence[] | undefined): StepEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const label = normalizeText(item.label);
    if (!label || !STEP_RESULT_EVIDENCE_KINDS.includes(item.kind)) return [];
    return [{
      kind: item.kind,
      label,
      ...(Object.prototype.hasOwnProperty.call(item, "data") ? { data: item.data } : {}),
      ...(normalizeText(item.reference) ? { reference: normalizeText(item.reference) } : {}),
    }];
  });
}

const STEP_RESULT_EVIDENCE_KINDS: readonly StepEvidenceKind[] = [
  "file",
  "command",
  "source",
  "url",
  "log",
  "permission",
  "screenshot",
  "artifact",
  "manual",
];

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const normalized = normalizeText(value);
    return normalized ? [normalized] : [];
  });
}

function normalizeText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function resolvePrimaryCapability(input: StepContractInput): string | undefined {
  const explicit = normalizeText(input.primaryCapability) ?? normalizeText(input.capability);
  if (explicit) return explicit;
  const required = normalizeStringArray(input.requiredCapabilities);
  return required.length === 1 ? required[0] : undefined;
}

function normalizeArtifactObligation(
  value: ArtifactObligation | undefined,
  fallback: ArtifactObligation,
): ArtifactObligation {
  return value === "required" || value === "optional" || value === "none"
    ? value
    : fallback;
}

function normalizeCompletionPolicy(
  value: Partial<StepCompletionPolicy> | undefined,
): StepCompletionPolicy {
  return {
    partial: value?.partial === "publish_and_continue" ||
        value?.partial === "retain_and_replan" || value?.partial === "stop"
      ? value.partial
      : DEFAULT_STEP_COMPLETION_POLICY.partial,
    blocked: value?.blocked === "wait" || value?.blocked === "replan"
      ? value.blocked
      : DEFAULT_STEP_COMPLETION_POLICY.blocked,
    needsClarification: value?.needsClarification === "ask_user" ||
        value?.needsClarification === "replan"
      ? value.needsClarification
      : DEFAULT_STEP_COMPLETION_POLICY.needsClarification,
  };
}

function normalizeBlockedReason(value: StepBlockedReason | undefined): StepBlockedReason | undefined {
  if (!value || !["approval", "environment", "policy", "external"].includes(value.kind)) {
    return undefined;
  }
  const detail = normalizeText(value.detail);
  if (!detail) return undefined;
  const wakeCondition = value.wakeCondition;
  const normalizedWakeCondition = wakeCondition &&
      ["approval_resolved", "context_available", "retry_at", "external_event"].includes(
        wakeCondition.event,
      ) && normalizeText(wakeCondition.ref)
    ? {
        event: wakeCondition.event,
        ref: normalizeText(wakeCondition.ref)!,
        ...(normalizeText(wakeCondition.retryAt)
          ? { retryAt: normalizeText(wakeCondition.retryAt) }
          : {}),
      }
    : undefined;
  return {
    kind: value.kind,
    resumable: value.resumable === true,
    retryable: value.retryable === true,
    detail,
    ...(normalizedWakeCondition ? { wakeCondition: normalizedWakeCondition } : {}),
  };
}

function normalizeErrorDetail(value: StepErrorDetail | undefined): StepErrorDetail | undefined {
  if (!value || !["model", "tool", "protocol", "verification", "runtime"].includes(value.phase)) {
    return undefined;
  }
  const code = normalizeText(value.code);
  const message = normalizeText(value.message);
  if (!code || !message) return undefined;
  return {
    code,
    message,
    phase: value.phase,
    retryable: value.retryable === true,
  };
}
