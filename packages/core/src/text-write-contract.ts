/**
 * Commander artifact-contract decision.
 *
 * The text-write flow used to derive the artifact from the goal text with
 * regexes — that is how "创建一个 HTML，内容是 SVG 动画" was written to a `.md`
 * file. The Commander now decides the contract first (format, file name, and the
 * requirements the artifact must satisfy) and the executor fulfils it, which is
 * the "指挥官分析任务 → 下发" step of the intended chain.
 *
 * The regex inference in `text-write-flow` stays as the fallback for when the
 * decision cannot be taken (no model, unparseable answer, unsupported format).
 * The `source` field keeps that honest in the audit trail instead of pretending
 * every artifact was decided.
 */
import {
  type TextArtifactFormat,
  inferTextArtifactFormat,
  listTextArtifactExtensions,
  resolveTextArtifactFormatToken,
} from "./text-write-flow";
import type { ModelUsage } from "@javis/tools";
import type { ChatTool } from "./index";
import { DEFAULT_TASK_TIMEOUT_MS, throwIfTaskAborted, withTaskTimeout } from "./task-wait";

export interface TextWriteContract {
  format: TextArtifactFormat;
  /** Workspace-relative file name the artifact is written to. */
  targetPath: string;
  /** Short, checkable requirements the generated artifact must satisfy. */
  requirements: string[];
  /** How this contract was decided. */
  source: "commander" | "fallback";
  /** Why the Commander could not decide, when `source` is "fallback". */
  fallbackReason?: string;
  /** The Commander's own one-line explanation, when it gave one. */
  reasoning?: string;
}

export interface TextWriteContractDecisionInput {
  userGoal: string;
  /** Regex-derived target, used as the hint and as the fallback. */
  fallbackTargetPath: string;
  /** Optional deterministic workspace inventory to plan the file name against. */
  workspaceInventory?: string;
}

const MAX_REQUIREMENTS = 4;
const MAX_REQUIREMENT_CHARS = 200;
const MAX_FALLBACK_REASON_CHARS = 200;

/**
 * Builds the contract the executor will honour. The format is authoritative: when
 * the model names a file whose extension disagrees, the extension is corrected
 * rather than letting the two fields contradict each other.
 */
export function parseTextWriteContractDecision(
  raw: string,
  decisionInput: TextWriteContractDecisionInput,
): TextWriteContract {
  const payload = extractJsonObject(raw);
  if (!payload) return fallbackTextWriteContract(decisionInput, "The contract decision was not a JSON object.");
  const format = typeof payload.format === "string"
    ? resolveTextArtifactFormatToken(payload.format)
    : undefined;
  if (!format) return fallbackTextWriteContract(decisionInput, "The contract decision named an unsupported format.");

  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  const targetPath = fileName ? alignTargetExtension(fileName, format) : undefined;
  if (!targetPath) {
    return fallbackTextWriteContract(decisionInput, "The contract decision named an unusable file name.");
  }

  const requirements = Array.isArray(payload.requirements)
    ? payload.requirements
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_REQUIREMENTS)
        .map((entry) => entry.slice(0, MAX_REQUIREMENT_CHARS))
    : [];

  return {
    format,
    targetPath,
    requirements,
    source: "commander",
    ...(typeof payload.reasoning === "string" && payload.reasoning.trim()
      ? { reasoning: payload.reasoning.trim().slice(0, MAX_REQUIREMENT_CHARS) }
      : {}),
  };
}

/** The regex-derived contract, used whenever the Commander cannot decide. */
export function fallbackTextWriteContract(
  decisionInput: TextWriteContractDecisionInput,
  reason: string,
): TextWriteContract {
  return {
    format: inferTextArtifactFormat(decisionInput.userGoal),
    targetPath: decisionInput.fallbackTargetPath,
    requirements: [],
    source: "fallback",
    fallbackReason: reason.slice(0, MAX_FALLBACK_REASON_CHARS),
  };
}

/**
 * Asks the Commander to decide the artifact contract. Never throws: a missing
 * model, a timeout, or an unusable answer degrades to the regex contract, so a
 * write can still proceed while the audit trail records that it was not decided.
 */
export async function decideTextWriteContract(input: {
  decisionInput: TextWriteContractDecisionInput;
  chatTool?: ChatTool;
  locale: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Records the decision call's token usage, so the count stays honest. */
  onUsage?: (usage?: ModelUsage) => void;
}): Promise<TextWriteContract> {
  const chatTool = input.chatTool;
  if (!chatTool) {
    return fallbackTextWriteContract(input.decisionInput, "No text-generation model is configured.");
  }
  const prompt = buildTextWriteContractPrompt({
    userGoal: input.decisionInput.userGoal,
    fallbackTargetPath: input.decisionInput.fallbackTargetPath,
    workspaceInventory: input.decisionInput.workspaceInventory,
    locale: input.locale,
  });
  try {
    const result = await withTaskTimeout(
      () => chatTool.complete(prompt, { maxTokens: 400, temperature: 0, locale: input.locale }),
      {
        label: "Text write contract decision",
        timeoutMs: input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        signal: input.signal,
      },
    );
    input.onUsage?.(result.tokenUsage);
    throwIfTaskAborted(input.signal, "Text write contract decision");
    return parseTextWriteContractDecision(result.text, input.decisionInput);
  } catch (error) {
    return fallbackTextWriteContract(
      input.decisionInput,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Forces the file name's extension to the decided format. A name that carries a
 * different supported extension is rewritten; an unusable name is rejected.
 */
export function alignTargetExtension(fileName: string, format: TextArtifactFormat): string | undefined {
  const normalized = fileName.replace(/\\/gu, "/").trim();
  if (!normalized) return undefined;
  if (/^[A-Za-z]:/u.test(normalized)) return undefined;
  if (normalized.startsWith("/") || normalized.startsWith("~")) return undefined;
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) return undefined;
  if (normalized.includes("\u0000")) return undefined;
  const withoutExtension = normalized.replace(/\.[A-Za-z0-9]+$/u, "");
  const stem = withoutExtension.replace(/\/+$/u, "").trim();
  if (!stem) return undefined;
  return `${stem}${format.extension}`;
}

export function buildTextWriteContractPrompt(input: {
  userGoal: string;
  fallbackTargetPath: string;
  workspaceInventory?: string;
  locale: string;
}): string {
  const inventory = input.workspaceInventory?.trim();
  return [
    "You decide the artifact contract for the file the user asked for. Answer with JSON only, no prose and no code fence.",
    'Shape: {"format":"<token>","fileName":"<workspace-relative name>","requirements":["..."],"reasoning":"<one short line>"}',
    `format must be one of: ${listTextArtifactExtensions().map((extension) => extension.replace(/^\./u, "")).join(", ")}. Choose what the user asked to produce, not what is easier to write.`,
    "fileName must be workspace-relative: no drive letters, no leading slash, no .. segments. Keep it short and descriptive.",
    `requirements: at most ${MAX_REQUIREMENTS} short, checkable statements about the artifact itself (for example "self-contained", "starts with <!DOCTYPE html>"). Use [] when the request implies none.`,
    `Language: write reasoning and requirements in ${input.locale}.`,
    inventory
      ? `Workspace inventory (deterministic, read-only): follow its structure and naming; do not invent directories that are not there.\n${inventory}`
      : "No workspace inventory is available.",
    `Regex-derived name hint (may be wrong, you may override): ${input.fallbackTargetPath}`,
    `User request: ${input.userGoal}`,
  ].join("\n\n");
}

/** Pulls the first JSON object out of a model answer that may wrap it in prose. */
function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
