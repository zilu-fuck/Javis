export interface SharedTaskContext {
  set<T>(key: string, value: T): void;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  snapshot(): Record<string, unknown>;
  clear(): void;
  resolveKey(key: ContextKey, locale?: string): string;
}

export const CONTEXT_KEYS = {
  WORKSPACE_PATH: { en: "workspacePath", zhCN: "工作区路径" },
  USER_GOAL: { en: "userGoal", zhCN: "用户目标" },
  TASK_ID: { en: "taskId", zhCN: "任务标识" },
  COMMANDER_PLAN: { en: "commanderPlan", zhCN: "指挥官计划" },
  DIFF_PREVIEW: { en: "diffPreview", zhCN: "差异预览" },
  PROPOSED_EDIT: { en: "proposedEdit", zhCN: "提议编辑" },
  VERIFICATION_RESULT: { en: "verificationResult", zhCN: "验证结果" },
  APPROVAL_RECORD: { en: "approvalRecord", zhCN: "审批记录" },
  SEARCH_RESULTS: { en: "searchResults", zhCN: "搜索结果" },
  RESEARCH_SOURCES: { en: "researchSources", zhCN: "研究来源" },
  PROJECT_INSPECTION: { en: "projectInspection", zhCN: "项目检查" },
  FILE_SCAN_RESULTS: { en: "fileScanResults", zhCN: "文件扫描结果" },
  PDF_ORGANIZATION_PLAN: { en: "pdfOrganizationPlan", zhCN: "PDF整理计划" },
  ERROR_CONTEXT: { en: "errorContext", zhCN: "错误上下文" },
  AGENT_STATE: { en: "agentState", zhCN: "代理状态" },
  TOKEN_USAGE: { en: "tokenUsage", zhCN: "令牌用量" },
  WORKFLOW_ID: { en: "workflowId", zhCN: "工作流标识" },
  STEP_RESULTS: { en: "stepResults", zhCN: "步骤结果" },
  BASE_GIT_HEAD: { en: "baseGitHead", zhCN: "基准提交" },
  STRUCTURED_HUNKS: { en: "structuredHunks", zhCN: "结构化差异块" },
  ASK_USER_QUESTION: { en: "askUserQuestion", zhCN: "用户提问" },
  ASK_USER_RESPONSE: { en: "askUserResponse", zhCN: "用户回答" },
} as const;

export type ContextKey = (typeof CONTEXT_KEYS)[keyof typeof CONTEXT_KEYS];

export interface HandoffReportStep {
  id: string;
  title?: string;
  assignedAgentKind: string;
  dependsOn?: string[];
  inputContextKeys?: string[];
  outputContextKey?: string;
  successCriteria?: string;
}

export interface HandoffReportValueSummary {
  type: "array" | "object" | "string" | "number" | "boolean" | "null" | "undefined" | "unknown";
  present: boolean;
  itemCount?: number;
  keyCount?: number;
  preview?: string;
}

export interface HandoffReportRecord {
  contextKey: string;
  producedByStepId?: string;
  consumedByStepIds: string[];
  status: "available" | "missing" | "unconsumed" | "input_missing" | "invalid_schema";
  valueSummary: HandoffReportValueSummary;
  schemaError?: string;
}

export interface HandoffReportStepRecord {
  stepId: string;
  title?: string;
  assignedAgentKind: string;
  dependsOn: string[];
  inputContextKeys: string[];
  outputContextKey?: string;
  missingInputContextKeys: string[];
  invalidInputContextKeys: string[];
  successCriteria?: string;
}

export interface HandoffReport {
  generatedAt: string;
  steps: HandoffReportStepRecord[];
  handoffs: HandoffReportRecord[];
  missingInputContextKeys: string[];
  invalidInputContextKeys: string[];
  unconsumedOutputContextKeys: string[];
  status: "complete" | "needs_attention";
}

export interface ContextValueValidation {
  key: string;
  valid: boolean;
  reason?: string;
  expectedType?: string;
}

export interface StepInputValidationResult {
  valid: boolean;
  stepId: string;
  missingInputContextKeys: string[];
  invalidInputContextKeys: ContextValueValidation[];
}

export interface ContextKeySchema {
  key: string;
  expectedType: string;
  validate(value: unknown): boolean;
}

export interface HandoffReportArtifact {
  fileName: string;
  mimeType: "application/json" | "text/markdown";
  content: string;
}

export function contextKeyForLocale(key: ContextKey, locale = "en"): string {
  return locale.toLowerCase().startsWith("zh") ? key.zhCN : key.en;
}

export function createSharedTaskContext(
  initialValues: Record<string, unknown> = {},
): SharedTaskContext {
  const store = new Map<string, unknown>(Object.entries(initialValues));

  return {
    set(key, value) {
      store.set(key, value);
    },
    get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    has(key) {
      return store.has(key);
    },
    snapshot() {
      return Object.fromEntries(store);
    },
    clear() {
      store.clear();
    },
    resolveKey(key, locale) {
      return contextKeyForLocale(key, locale);
    },
  };
}

/**
 * Resolve the input for a step by reading its declared inputContextKeys from SharedContext.
 * Returns a record of { key: value } for each key that has data in the context.
 */
export function resolveStepInput(
  inputContextKeys: string[] | undefined,
  context: SharedTaskContext,
): Record<string, unknown> {
  if (!inputContextKeys || inputContextKeys.length === 0) {
    return {};
  }
  const input: Record<string, unknown> = {};
  for (const key of inputContextKeys) {
    const value = context.get(key);
    if (value !== undefined) {
      input[key] = value;
    }
  }
  return input;
}

/**
 * Write a step's output to SharedContext under its declared outputContextKey.
 * No-op if outputContextKey is not set.
 */
export function writeStepOutput(
  outputContextKey: string | undefined,
  output: unknown,
  context: SharedTaskContext,
): void {
  if (!outputContextKey) return;
  context.set(outputContextKey, output);
}

export const DEFAULT_CONTEXT_KEY_SCHEMAS: readonly ContextKeySchema[] = [
  objectWith("diffPreview", "object { diff: string, changedFiles: string[] }", [
    ["diff", "string"],
    ["changedFiles", "stringArray"],
  ]),
  objectWith("projectInspection", "object { workspacePath?: string, files?: unknown }", []),
  objectWith("fileScanResults", "object or array", [], { allowArray: true }),
  objectWith("searchResults", "object or array", [], { allowArray: true }),
  objectWith("researchSources", "array", [], { requireArray: true }),
  objectWith("repoSearch", "object { query?: string, results?: unknown }", []),
  objectWith("repoTrace", "object", []),
  objectWith("repoEvidence", "object", []),
  objectWith("uiEvidence", "object { screenshot?: unknown, facts?: unknown }", []),
  objectWith("computerEvidence", "object", []),
  objectWith("computerScreenshot", "object or string", [], { allowString: true }),
  objectWith("computerResult", "object or array", [], { allowArray: true }),
  objectWith("verificationResult", "object { status?: string, summary?: string }", []),
  objectWith("verifierCheck", "object { status: string, summary?: string }", [["status", "string"]]),
  objectWith("proposedEdit", "object", []),
  objectWith("approvalRecord", "object", []),
];

export function validateContextValue(
  key: string,
  value: unknown,
  schemas: readonly ContextKeySchema[] = DEFAULT_CONTEXT_KEY_SCHEMAS,
): ContextValueValidation {
  if (value === undefined) {
    return { key, valid: false, reason: "missing" };
  }
  const schema = schemas.find((item) => item.key === key);
  if (!schema) {
    return { key, valid: true };
  }
  if (!schema.validate(value)) {
    return {
      key,
      valid: false,
      reason: `invalid schema for ${key}`,
      expectedType: schema.expectedType,
    };
  }
  return { key, valid: true, expectedType: schema.expectedType };
}

export function validateStepInputContext(
  step: Pick<HandoffReportStep, "id" | "inputContextKeys">,
  context: SharedTaskContext,
  schemas: readonly ContextKeySchema[] = DEFAULT_CONTEXT_KEY_SCHEMAS,
): StepInputValidationResult {
  const inputContextKeys = step.inputContextKeys ?? [];
  const missingInputContextKeys: string[] = [];
  const invalidInputContextKeys: ContextValueValidation[] = [];

  for (const key of inputContextKeys) {
    if (!context.has(key)) {
      missingInputContextKeys.push(key);
      continue;
    }
    const validation = validateContextValue(key, context.get(key), schemas);
    if (!validation.valid) {
      invalidInputContextKeys.push(validation);
    }
  }

  return {
    valid: missingInputContextKeys.length === 0 && invalidInputContextKeys.length === 0,
    stepId: step.id,
    missingInputContextKeys,
    invalidInputContextKeys,
  };
}

export function formatStepInputValidationError(result: StepInputValidationResult): string {
  const missing = result.missingInputContextKeys.length
    ? `missing input context key(s): ${result.missingInputContextKeys.join(", ")}`
    : "";
  const invalid = result.invalidInputContextKeys.length
    ? `invalid input context key(s): ${result.invalidInputContextKeys
      .map((item) => `${item.key}${item.expectedType ? ` expected ${item.expectedType}` : ""}`)
      .join(", ")}`
    : "";
  return [
    `Input context validation failed for step ${result.stepId}.`,
    missing,
    invalid,
  ].filter(Boolean).join(" ");
}

export function buildHandoffReport(
  steps: readonly HandoffReportStep[],
  context: SharedTaskContext | Record<string, unknown>,
  options: { generatedAt?: string; previewLength?: number } = {},
): HandoffReport {
  const snapshot = isSharedTaskContext(context) ? context.snapshot() : context;
  const previewLength = Math.max(0, options.previewLength ?? 120);
  const producers = new Map<string, HandoffReportStep>();
  const consumers = new Map<string, HandoffReportStep[]>();

  for (const step of steps) {
    if (step.outputContextKey) {
      producers.set(step.outputContextKey, step);
    }
    for (const key of step.inputContextKeys ?? []) {
      consumers.set(key, [...(consumers.get(key) ?? []), step]);
    }
  }

  const stepRecords = steps.map((step) => {
    const inputContextKeys = step.inputContextKeys ?? [];
    const missingInputContextKeys = inputContextKeys.filter((key) => snapshot[key] === undefined);
    const invalidInputContextKeys = inputContextKeys
      .filter((key) => snapshot[key] !== undefined)
      .map((key) => validateContextValue(key, snapshot[key]))
      .filter((validation) => !validation.valid)
      .map((validation) => validation.key);
    return {
      stepId: step.id,
      title: step.title,
      assignedAgentKind: step.assignedAgentKind,
      dependsOn: step.dependsOn ?? [],
      inputContextKeys,
      outputContextKey: step.outputContextKey,
      missingInputContextKeys,
      invalidInputContextKeys,
      successCriteria: step.successCriteria,
    };
  });

  const allContextKeys = new Set([
    ...producers.keys(),
    ...consumers.keys(),
  ]);
  const handoffs = [...allContextKeys].sort().map((contextKey) => {
    const producer = producers.get(contextKey);
    const consumingSteps = consumers.get(contextKey) ?? [];
    const present = snapshot[contextKey] !== undefined;
    const schemaValidation = present ? validateContextValue(contextKey, snapshot[contextKey]) : undefined;
    const schemaError = schemaValidation && !schemaValidation.valid
      ? schemaValidation.expectedType
        ? `expected ${schemaValidation.expectedType}`
        : schemaValidation.reason
      : undefined;
    return {
      contextKey,
      producedByStepId: producer?.id,
      consumedByStepIds: consumingSteps.map((step) => step.id),
      status: resolveHandoffStatus({
        present,
        hasProducer: Boolean(producer),
        hasConsumers: consumingSteps.length > 0,
        schemaValid: schemaValidation?.valid ?? true,
      }),
      valueSummary: summarizeHandoffValue(snapshot[contextKey], previewLength),
      ...(schemaError ? { schemaError } : {}),
    };
  });

  const missingInputContextKeys = [...new Set(
    stepRecords.flatMap((step) => step.missingInputContextKeys),
  )].sort();
  const unconsumedOutputContextKeys = handoffs
    .filter((handoff) => handoff.producedByStepId && handoff.consumedByStepIds.length === 0)
    .map((handoff) => handoff.contextKey)
    .sort();
  const invalidInputContextKeys = [...new Set(
    stepRecords.flatMap((step) => step.invalidInputContextKeys),
  )].sort();

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    steps: stepRecords,
    handoffs,
    missingInputContextKeys,
    invalidInputContextKeys,
    unconsumedOutputContextKeys,
    status: missingInputContextKeys.length || invalidInputContextKeys.length || unconsumedOutputContextKeys.length
      ? "needs_attention"
      : "complete",
  };
}

export function createHandoffReportArtifacts(
  report: HandoffReport,
  options: { baseName?: string } = {},
): HandoffReportArtifact[] {
  const baseName = sanitizeArtifactBaseName(options.baseName ?? "agent-handoff-report");
  return [
    {
      fileName: `${baseName}.json`,
      mimeType: "application/json",
      content: `${JSON.stringify(report, null, 2)}\n`,
    },
    {
      fileName: `${baseName}.md`,
      mimeType: "text/markdown",
      content: formatHandoffReportMarkdown(report),
    },
  ];
}

export function formatHandoffReportMarkdown(report: HandoffReport): string {
  const lines = [
    "# Agent Handoff Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Summary",
    "",
    `- Handoffs: ${report.handoffs.length}`,
    `- Steps: ${report.steps.length}`,
    `- Missing inputs: ${report.missingInputContextKeys.join(", ") || "none"}`,
    `- Invalid inputs: ${report.invalidInputContextKeys.join(", ") || "none"}`,
    `- Unconsumed outputs: ${report.unconsumedOutputContextKeys.join(", ") || "none"}`,
    "",
    "## Handoffs",
    "",
    "| Context key | Producer | Consumers | Status | Value |",
    "| --- | --- | --- | --- | --- |",
    ...report.handoffs.map((handoff) => [
      escapeMarkdownTableCell(handoff.contextKey),
      escapeMarkdownTableCell(handoff.producedByStepId ?? "external"),
      escapeMarkdownTableCell(handoff.consumedByStepIds.join(", ") || "none"),
      escapeMarkdownTableCell(handoff.status),
      escapeMarkdownTableCell(handoff.schemaError
        ? `${formatHandoffValueSummary(handoff.valueSummary)} (${handoff.schemaError})`
        : formatHandoffValueSummary(handoff.valueSummary)),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Steps",
    "",
    "| Step | Agent | Inputs | Output | Missing inputs |",
    "| --- | --- | --- | --- | --- |",
    ...report.steps.map((step) => [
      escapeMarkdownTableCell(step.stepId),
      escapeMarkdownTableCell(step.assignedAgentKind),
      escapeMarkdownTableCell(step.inputContextKeys.join(", ") || "none"),
      escapeMarkdownTableCell(step.outputContextKey ?? "none"),
      escapeMarkdownTableCell(step.missingInputContextKeys.join(", ") || "none"),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
  ];
  return `${lines.join("\n")}`;
}

function isSharedTaskContext(value: unknown): value is SharedTaskContext {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as SharedTaskContext).snapshot === "function";
}

function resolveHandoffStatus(input: {
  present: boolean;
  hasProducer: boolean;
  hasConsumers: boolean;
  schemaValid: boolean;
}): HandoffReportRecord["status"] {
  if (!input.present) return "missing";
  if (!input.schemaValid) return "invalid_schema";
  if (!input.hasProducer) return "input_missing";
  if (!input.hasConsumers) return "unconsumed";
  return "available";
}

function summarizeHandoffValue(
  value: unknown,
  previewLength: number,
): HandoffReportValueSummary {
  if (value === undefined) {
    return { type: "undefined", present: false };
  }
  if (value === null) {
    return { type: "null", present: true };
  }
  if (Array.isArray(value)) {
    return { type: "array", present: true, itemCount: value.length };
  }
  const valueType = typeof value;
  if (valueType === "string") {
    const text = value as string;
    return {
      type: "string",
      present: true,
      preview: previewLength > 0 ? text.slice(0, previewLength) : undefined,
    };
  }
  if (valueType === "number" || valueType === "boolean") {
    return { type: valueType, present: true, preview: String(value) };
  }
  if (valueType === "object") {
    return { type: "object", present: true, keyCount: Object.keys(value).length };
  }
  return { type: "unknown", present: true };
}

function sanitizeArtifactBaseName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || "agent-handoff-report";
}

function formatHandoffValueSummary(value: HandoffReportValueSummary): string {
  if (!value.present) return value.type;
  if (value.type === "array") return `${value.type}: ${value.itemCount ?? 0} item(s)`;
  if (value.type === "object") return `${value.type}: ${value.keyCount ?? 0} key(s)`;
  if (value.preview) return `${value.type}: ${value.preview}`;
  return value.type;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function objectWith(
  key: string,
  expectedType: string,
  requiredFields: Array<[string, "string" | "stringArray"]>,
  options: { allowArray?: boolean; allowString?: boolean; requireArray?: boolean } = {},
): ContextKeySchema {
  return {
    key,
    expectedType,
    validate(value) {
      if (options.requireArray) {
        return Array.isArray(value);
      }
      if (options.allowArray && Array.isArray(value)) {
        return true;
      }
      if (options.allowString && typeof value === "string") {
        return value.trim().length > 0;
      }
      if (!isPlainObject(value)) {
        return false;
      }
      for (const [field, type] of requiredFields) {
        const fieldValue = value[field];
        if (type === "string" && typeof fieldValue !== "string") {
          return false;
        }
        if (
          type === "stringArray" &&
          (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string"))
        ) {
          return false;
        }
      }
      return true;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
