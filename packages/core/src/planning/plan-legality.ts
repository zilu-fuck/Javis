/**
 * Plan legality guardrails — the deterministic layers of the Commander DAG
 * legality five-layer guarantee:
 *
 *   Layer 2 (repair loop): deterministic local repair runs BEFORE the model
 *     repair round. Common mechanical defects (bad step-id casing, execution
 *     mode synonyms, absolute write targets inside the workspace) are fixed
 *     locally; only the residual diagnostics go to the model.
 *   Layer 4 (preset template): a fixed JSON skeleton the planner fills in,
 *     plus template defaulting applied to model output before validation.
 *   Layer 5 (lexical filter): user-intent recognition (write / export /
 *     statistics / retrieval) and regex-level scans of the raw model text
 *     (markdown fences, prose outside JSON, control characters, absolute or
 *     traversing target paths, secret-looking values).
 *
 * Layers 1 (prompt guidance) and 3 (schema constraints) live in
 * `commander-plan-schema.ts` / `schema.ts`; this module provides the
 * programmatic half they reference. Regexes here are lexical pre-checks
 * only — real path safety stays in `@javis/tools` path resolution and the
 * native write boundary, and JSON parsing always uses a real parser.
 */

import { normalizeWorkspaceRelativeTextTargetPath } from "@javis/tools";
import { isCodebaseUnderstandingRequest } from "../agent-intent";
import type { CommanderPlanResultT, StepExecutionModeT } from "./schema";

// --- Layer 5a: user-intent recognition ----------------------------------------

export interface CommanderPlanIntents {
  /**
   * The user asked to persist results to a file, or to produce a document
   * artifact (report / markdown file). When false, `file.writeText` steps
   * are rejected at compile time.
   */
  write: boolean;
  /** The user asked to export/share data out (a stronger form of write). */
  export: boolean;
  /** The user asked for statistics / counting / aggregation. */
  statistics: boolean;
  /** The user asked for retrieval / search / collection. */
  retrieval: boolean;
  /** The user asked to understand the selected project's structure/modules. */
  projectUnderstanding?: boolean;
  /** The user explicitly asked to operate a desktop UI or File Explorer. */
  desktopInteraction?: boolean;
}

const PERSISTENCE_PATTERNS: readonly RegExp[] = [
  /保存|写入|落盘|存档|存为|存成|存到|写到|记录到|另存|归档|备份/,
  /生成.{0,8}(文件|文档|报告|表格)/,
  /输出.{0,8}(文件|文档|报告)/,
  /(整理|组织|汇总|归并|编排|转换|导出)成(一个|一份)?(文件|文档|报告)/,
  /\b(?:save|persist|store|archive|back ?up)\b.{0,40}\b(?:results?|outputs?|data|findings?|summar(?:y|ies)|reports?|documents?|files?|markdown|md|txt|json|csv|pdf)\b/i,
  /\b(?:save|write) (?:to|into|as) (?:a )?(?:(?:markdown|md|txt|json|csv|pdf) )?file\b/i,
  /\b(?:as|to|into) (?:a )?(?:markdown|md|txt|json|csv|pdf) file\b/i,
];

const DOCUMENT_PRODUCTION_PATTERNS: readonly RegExp[] = [
  /(?:写|撰写|编写|起草|创建|制作|生成|更新|修改|编辑|追加|补充|整理|输出).{0,16}(?:报告|报表|白皮书|纪要|文档|文件|README(?:\.md)?|[^\s，。；;!?？]+\.(?:md|txt|json|csv))/i,
  /(?:报告|报表|白皮书|纪要|文档|文件|README(?:\.md)?|[^\s，。；;!?？]+\.(?:md|txt|json|csv)).{0,16}(?:帮我)?(?:更新|修改|编辑|追加|补充|整理|改一下|重写)/i,
  /\b(?:write|draft|create|generate|produce|update|edit|append to)\b.{0,40}\b(?:reports?|white ?papers?|minutes|documents?|files?|readme(?:\.md)?|[^\s]+\.(?:md|txt|json|csv))\b/i,
  /\b(?:reports?|white ?papers?|minutes|documents?|files?|readme(?:\.md)?|[^\s]+\.(?:md|txt|json|csv))\b.{0,40}\b(?:needs? (?:an )?update|update|edit|revise|rewrite|append)\b/i,
];

const EXPORT_PATTERNS: readonly RegExp[] = [
  /导出.{0,12}(?:为|到|成|数据|结果|内容|文件|文档|报告|报表|表格|markdown|csv|json|pdf)|分享为/,
  /\bexport\b.{0,40}\b(?:as|to|data|results?|outputs?|findings?|reports?|documents?|files?|markdown|md|txt|json|csv|pdf)\b/i,
];

const STATISTICS_PATTERNS: readonly RegExp[] = [
  /统计|汇总|计数|占比/,
  /\bcount\b|\bstatistic|\baggregate/i,
];

const RETRIEVAL_PATTERNS: readonly RegExp[] = [
  /检索|搜索|查询|采集|抓取|查找/,
  /\bsearch\b|\bretrieve\b|\bfetch\b|\bcollect\b/i,
];

const PROJECT_SCOPE_PATTERNS: readonly RegExp[] = [
  /\u5f53\u524d\u9879\u76ee|\u8fd9\u4e2a\u9879\u76ee|\u9879\u76ee|\u4ee3\u7801\u5e93|\u4ed3\u5e93/,
  /\b(?:current|this)\s+(?:project|repository|repo|codebase)\b|\b(?:project|repository|repo|codebase)\b/i,
];

const PROJECT_UNDERSTANDING_PATTERNS: readonly RegExp[] = [
  /\u76ee\u5f55\u7ed3\u6784|\u9879\u76ee\u7ed3\u6784|\u4ee3\u7801\u5e93\u7ed3\u6784|\u4e3b\u8981\u6a21\u5757|\u6a21\u5757\u5212\u5206|\u5165\u53e3\u6587\u4ef6|\u67b6\u6784\u6982\u89c8/,
  /(?:\u68c0\u67e5|\u7406\u89e3|\u9605\u8bfb|\u68b3\u7406|\u5206\u6790).{0,12}(?:\u9879\u76ee|\u4ee3\u7801\u5e93|\u4ed3\u5e93)/,
  /\b(?:directory|repository|repo|project|codebase)\s+(?:structure|layout|modules?|architecture|entrypoints?)\b/i,
  /\b(?:inspect|understand|read|analy[sz]e|map)\b.{0,40}\b(?:project|repository|repo|codebase)\b/i,
];

const EXPLICIT_DESKTOP_INTERACTION_PATTERNS: readonly RegExp[] = [
  /(?:\u4f7f\u7528|\u901a\u8fc7|\u6253\u5f00|\u64cd\u4f5c|\u70b9\u51fb|\u8f93\u5165).{0,12}(?:\u6587\u4ef6\u8d44\u6e90\u7ba1\u7406\u5668|\u684c\u9762|\u7a97\u53e3|GUI|UIA)/i,
  /(?:\u6587\u4ef6\u8d44\u6e90\u7ba1\u7406\u5668|\u684c\u9762|\u7a97\u53e3).{0,12}(?:\u67e5\u770b|\u68c0\u67e5|\u64cd\u4f5c|\u6253\u5f00|\u70b9\u51fb|\u8f93\u5165)/,
  /\b(?:use|through|open|operate|click|type in)\b.{0,24}\b(?:file explorer|desktop|window|gui|uia)\b/i,
  /\b(?:file explorer|desktop|window)\b.{0,24}\b(?:inspect|browse|operate|open|click|type)\b/i,
];

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Recognize the user's planning intents from the raw goal text. This is a
 * lexical pre-check used by the prompt layer (guidance) and the compile
 * gate (write-step gating); it never replaces semantic validation.
 */
export function detectCommanderPlanIntents(userGoal: string): CommanderPlanIntents {
  const goal = userGoal.trim();
  const exportIntent = matchesAny(EXPORT_PATTERNS, goal);
  const projectUnderstanding =
    isCodebaseUnderstandingRequest(goal) ||
    (matchesAny(PROJECT_SCOPE_PATTERNS, goal) &&
      matchesAny(PROJECT_UNDERSTANDING_PATTERNS, goal));
  const write =
    exportIntent ||
    matchesAny(PERSISTENCE_PATTERNS, goal) ||
    matchesAny(DOCUMENT_PRODUCTION_PATTERNS, goal);
  return {
    write,
    export: exportIntent,
    statistics: matchesAny(STATISTICS_PATTERNS, goal),
    retrieval: matchesAny(RETRIEVAL_PATTERNS, goal),
    projectUnderstanding,
    desktopInteraction: matchesAny(EXPLICIT_DESKTOP_INTERACTION_PATTERNS, goal),
  };
}

// --- Layer 5b: lexical scan of the raw model output ---------------------------

export type RawPlanLexicalIssueKind =
  | "markdown_fence"
  | "prose_outside_json"
  | "control_characters"
  | "absolute_target_path"
  | "traversal_target_path"
  | "secret_like_value";

export interface RawPlanLexicalIssue {
  kind: RawPlanLexicalIssueKind;
  message: string;
  /** Short redacted excerpt (max 80 chars) for diagnostics. */
  sample?: string;
}

const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ABSOLUTE_TARGET_PATH_PATTERN = /"targetPath"\s*:\s*"\s*(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)/;
const TRAVERSAL_TARGET_PATH_PATTERN = /"targetPath"\s*:\s*"[^"]*\.\.[\\/]/;
const SECRET_LIKE_VALUE_PATTERN =
  /"(?:api[_-]?key|access[_-]?token|secret|password|passwd|authorization|credential)"\s*:\s*"[^"]{6,}"/i;

function clipSample(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

/**
 * Regex-level pre-check over the raw model text BEFORE/AROUND parsing.
 * Findings are diagnostics for the JSON repair prompt, not rejections —
 * the parser and the compile gate remain the enforcement points.
 */
export function scanRawPlanOutputText(rawText: string): RawPlanLexicalIssue[] {
  const issues: RawPlanLexicalIssue[] = [];
  if (!rawText) return issues;

  if (rawText.includes("```")) {
    issues.push({
      kind: "markdown_fence",
      message: "Output contains markdown code fences; return the JSON object without fences.",
    });
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    issues.push({
      kind: "prose_outside_json",
      message: "Output does not contain a JSON object; return exactly one JSON object.",
      sample: clipSample(rawText),
    });
  } else {
    const outside = `${rawText.slice(0, firstBrace)}${rawText.slice(lastBrace + 1)}`
      .replace(/```(?:json)?/gi, "")
      .trim();
    if (outside.length > 0) {
      issues.push({
        kind: "prose_outside_json",
        message: "Output contains explanation text outside the JSON object; remove it.",
        sample: clipSample(outside),
      });
    }
  }

  if (CONTROL_CHARACTER_PATTERN.test(rawText)) {
    issues.push({
      kind: "control_characters",
      message: "Output contains control characters; remove non-printable characters.",
    });
  }

  if (ABSOLUTE_TARGET_PATH_PATTERN.test(rawText)) {
    issues.push({
      kind: "absolute_target_path",
      message: 'toolInput.targetPath is an absolute path; use a workspace-relative path like "reports/result.md".',
    });
  }

  if (TRAVERSAL_TARGET_PATH_PATTERN.test(rawText)) {
    issues.push({
      kind: "traversal_target_path",
      message: 'toolInput.targetPath contains a ".." traversal segment; stay inside the workspace.',
    });
  }

  if (SECRET_LIKE_VALUE_PATTERN.test(rawText)) {
    issues.push({
      kind: "secret_like_value",
      message: "Output embeds a secret-looking value (apiKey/token/password); never place credentials in a plan.",
    });
  }

  return issues;
}

// --- Lexical helpers shared with the validator --------------------------------

/** Absolute-path check for write targets (lexical; real safety is path resolution). */
export function isAbsolutePathLike(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("~")
  );
}

/** ".." segment check for write targets (lexical; real safety is path resolution). */
export function hasPathTraversalSegment(value: string): boolean {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

/**
 * Context keys are camelCase identifiers (e.g. `userGoal`, `uiEvidence`)
 * or implicit per-step keys with a kebab-case id (`step:<step-id>`).
 */
export const PLAN_CONTEXT_KEY_PATTERN =
  /^(?:[a-z][a-zA-Z0-9]*|step:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

const SENSITIVE_TOOL_INPUT_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|secret|password|passwd|credential)/i;

/** Return toolInput keys that look like they carry credentials. */
export function findSensitiveToolInputKeys(
  toolInput: Record<string, unknown> | undefined,
): string[] {
  if (!toolInput) return [];
  return Object.entries(toolInput)
    .filter(([key, value]) =>
      SENSITIVE_TOOL_INPUT_KEY_PATTERN.test(key) &&
      typeof value === "string" &&
      value.trim().length >= 4,
    )
    .map(([key]) => key);
}

// --- Layer 4: preset JSON template ---------------------------------------------

/**
 * The preset DAG skeleton the planner fills in (Layer 4). The program owns
 * the structure — field set, default arrays, fixed fields — so the model
 * only supplies task-specific content instead of designing the JSON shape.
 * Embedded into the planner system prompt; empty strings mean "omit".
 */
export const COMMANDER_PLAN_TEMPLATE_SKELETON = {
  title: "",
  reasoning: "",
  executionPolicy: {},
  steps: [
    {
      id: "",
      title: "",
      assignedAgentKind: "",
      executionMode: "",
      primaryCapability: "",
      toolName: "",
      requiredCapabilities: [] as string[],
      dependsOn: [] as string[],
      inputContextKeys: [] as string[],
      outputContextKey: "",
      toolInput: {} as Record<string, unknown>,
      successCriteria: "",
    },
  ],
};

export function buildCommanderPlanTemplateSkeleton(): string {
  // Compact single-line form: the skeleton lives in the planner prompt,
  // which has a strict token budget (see prompt-quality.test.ts).
  return JSON.stringify(COMMANDER_PLAN_TEMPLATE_SKELETON);
}

// --- Layer 2: deterministic local repair ----------------------------------------

export interface DeterministicPlanRepairOptions {
  /** Selected workspace, used to relativize absolute write targets. */
  workspacePath?: string;
}

export interface DeterministicPlanRepairResult<T> {
  plan: T;
  /** Human-readable notes for every deterministic fix that was applied. */
  repairs: string[];
}

const KEBAB_STEP_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const CONTROL_CHARACTERS_GLOBAL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g;

const EXECUTION_MODE_SYNONYMS: Record<string, StepExecutionModeT> = {
  direct_tool_call: "direct_tool_call",
  "direct-tool-call": "direct_tool_call",
  directtoolcall: "direct_tool_call",
  tool: "direct_tool_call",
  tool_call: "direct_tool_call",
  "tool-call": "direct_tool_call",
  direct: "direct_tool_call",
  direct_response: "direct_response",
  "direct-response": "direct_response",
  directresponse: "direct_response",
  response: "direct_response",
  answer: "direct_response",
  react: "react",
  agent: "react",
  desktop_input: "desktop_input",
  "desktop-input": "desktop_input",
  desktop: "desktop_input",
};

function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS_GLOBAL, "");
}

function coerceKebabCaseStepId(rawId: unknown, index: number): string {
  const raw = typeof rawId === "string" ? rawId : "";
  const base = stripControlCharacters(raw)
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  let id = base;
  if (!/^[a-z]/.test(id)) {
    id = id ? `step-${id}` : `step-${index + 1}`;
  }
  if (id.length < 2) {
    id = `${id}-${index + 1}`;
  }
  if (!KEBAB_STEP_ID_PATTERN.test(id)) {
    id = `step-${index + 1}`;
  }
  return id;
}

function normalizeExecutionModeValue(
  value: unknown,
): { mode?: StepExecutionModeT; dropped: boolean } {
  if (value === undefined || value === null || value === "") {
    return { dropped: false };
  }
  if (typeof value !== "string") {
    return { dropped: true };
  }
  const key = value.trim().toLowerCase();
  const mode = EXECUTION_MODE_SYNONYMS[key];
  return mode ? { mode, dropped: false } : { dropped: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutablePlanStep = NonNullable<CommanderPlanResultT["steps"]>[number];

/**
 * Deterministic local repair of a parsed plan (Layer 2). Runs before any
 * model repair round and before strict shape validation:
 *
 *  - step ids are coerced to unique kebab-case and `dependsOn` references
 *    are rewritten to the coerced ids;
 *  - control characters are stripped from plan/step string fields;
 *  - `executionMode` synonyms ("tool", "answer", …) are normalized and
 *    unknown values dropped so the executor's inference can take over;
 *  - `file.writeText` steps are pinned to `direct_tool_call`;
 *  - absolute `toolInput.targetPath` values inside the selected workspace
 *    are relativized (out-of-workspace / traversal targets are left for
 *    the validator to reject).
 */
export function applyDeterministicPlanRepairs<T extends CommanderPlanResultT>(
  plan: T,
  options: DeterministicPlanRepairOptions = {},
): DeterministicPlanRepairResult<T> {
  if (!isPlainRecord(plan) || !Array.isArray(plan.steps)) {
    return { plan, repairs: [] };
  }

  const repairs: string[] = [];
  const rawSteps = plan.steps.filter(isPlainRecord) as MutablePlanStep[];

  // Pass 1: ids, execution modes, control characters, write targets.
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  const nextSteps = rawSteps.map((step, index) => {
    const next: MutablePlanStep = { ...step };

    // Step id → unique kebab-case.
    const originalId = typeof next.id === "string" ? next.id : undefined;
    let coerced = coerceKebabCaseStepId(originalId, index);
    if (usedIds.has(coerced)) {
      let suffix = 2;
      while (usedIds.has(`${coerced}-${suffix}`)) suffix += 1;
      coerced = `${coerced}-${suffix}`;
    }
    usedIds.add(coerced);
    if (originalId !== coerced) {
      repairs.push(
        originalId
          ? `step ${index + 1}: id "${originalId}" coerced to "${coerced}"`
          : `step ${index + 1}: missing id filled with "${coerced}"`,
      );
      if (originalId) idMap.set(originalId, coerced);
      next.id = coerced;
    }

    // Control characters in user-visible / routing string fields.
    for (const field of ["title", "assignedAgentKind", "toolName", "capability", "primaryCapability", "outputContextKey", "successCriteria", "instruction"] as const) {
      const value = next[field];
      if (typeof value === "string" && CONTROL_CHARACTER_PATTERN.test(value)) {
        next[field] = stripControlCharacters(value);
        repairs.push(`step ${coerced}: control characters stripped from ${field}`);
      }
    }

    // executionMode synonyms / invalid values.
    const { mode, dropped } = normalizeExecutionModeValue(next.executionMode);
    if (dropped) {
      repairs.push(`step ${coerced}: unknown executionMode "${String(next.executionMode)}" dropped for inference`);
      delete next.executionMode;
    } else if (mode && mode !== next.executionMode) {
      repairs.push(`step ${coerced}: executionMode "${String(next.executionMode)}" normalized to "${mode}"`);
      next.executionMode = mode;
    }

    // file.writeText is always a direct tool call.
    if (next.toolName === "file.writeText" && next.executionMode !== "direct_tool_call") {
      next.executionMode = "direct_tool_call";
      repairs.push(`step ${coerced}: file.writeText pinned to executionMode "direct_tool_call"`);
    }

    // Relativize absolute write targets inside the selected workspace.
    if (next.toolName === "file.writeText" && isPlainRecord(next.toolInput)) {
      const targetPath = next.toolInput.targetPath;
      if (
        typeof targetPath === "string" &&
        (isAbsolutePathLike(targetPath) || targetPath.includes("\\")) &&
        !hasPathTraversalSegment(targetPath)
      ) {
        try {
          const relative = normalizeWorkspaceRelativeTextTargetPath(targetPath, options.workspacePath);
          if (relative !== targetPath) {
            next.toolInput = { ...next.toolInput, targetPath: relative };
            repairs.push(`step ${coerced}: targetPath "${targetPath}" relativized to "${relative}"`);
          }
        } catch {
          // Out-of-workspace or otherwise unsafe target: leave it; the
          // validator rejects it with UNSAFE_WRITE_PATH.
        }
      }
    }

    return next;
  });

  // Pass 2: rewrite dependsOn references through the id map.
  if (idMap.size > 0) {
    for (const next of nextSteps) {
      if (!Array.isArray(next.dependsOn)) continue;
      next.dependsOn = next.dependsOn.map((dep) =>
        typeof dep === "string" ? idMap.get(dep) ?? dep : dep,
      );
    }
  }

  // Plan-level control characters.
  const nextPlan: Record<string, unknown> = { ...plan, steps: nextSteps };
  for (const field of ["title", "reasoning"] as const) {
    const value = nextPlan[field];
    if (typeof value === "string" && CONTROL_CHARACTER_PATTERN.test(value)) {
      nextPlan[field] = stripControlCharacters(value);
      repairs.push(`plan: control characters stripped from ${field}`);
    }
  }

  return { plan: nextPlan as T, repairs };
}
