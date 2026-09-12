/**
 * Agent customization: validating a draft and previewing its effective view (C2).
 *
 * Editing an agent is the point where a user can most easily create something that
 * looks right and behaves surprisingly: an allowlist that names a tool this build does
 * not have, a permission ceiling higher than the host's, a persona that is only written
 * in one language. Every one of those is cheap to check *before* the agent runs, which
 * is what this module is for.
 *
 * The central invariant is the same one the tool protocol uses: **an agent may lower its
 * own privileges, never raise them past the host's.** The effective ceiling is the
 * minimum of what the draft asks for and what the host grants, so a profile imported
 * from someone else cannot widen its own reach.
 *
 * The preview is deliberately computed from the *effective* configuration — the same
 * inputs the runtime would use — so "what will this agent see?" has one answer rather
 * than two that can disagree.
 */

import type { PermissionLevel } from "@javis/tools";

export type AgentPreviewLocale = "en" | "zhCN";

export interface AgentDraft {
  kind: string;
  displayName?: string;
  /** Bilingual by convention; a missing translation is surfaced, not silent. */
  persona?: { en?: string; zhCN?: string };
  modelSlot?: string;
  /** Absent means "every tool"; an explicit empty array means "no tools". */
  toolAllowlist?: readonly string[];
  /** Always wins over the allowlist. */
  toolDenylist?: readonly string[];
  /** Optional self-imposed ceiling; clamped to the host ceiling. */
  permissionCeiling?: PermissionLevel;
  contextBudgetTokens?: number;
  maxTurns?: number;
}

export interface PreviewToolSource {
  name: string;
  permissionLevel: PermissionLevel;
  ownerAgentKinds: readonly string[];
}

export interface AgentDraftDiagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface AgentViewPreview {
  diagnostics: AgentDraftDiagnostic[];
  /** Tools the agent can actually call, with the permission it gets on each. */
  availableTools: Array<{ name: string; permissionLevel: PermissionLevel }>;
  /** Tools withheld, each with the reason — so the UI can explain a missing tool. */
  withheldTools: Array<{ name: string; reason: string }>;
  /** The ceiling that will actually apply. Never above the host's. */
  effectivePermissionCeiling: PermissionLevel;
  promptPreview: string;
  promptChars: number;
  contextBudgetTokens: number;
  maxTurns: number;
}

export const DEFAULT_AGENT_CONTEXT_BUDGET_TOKENS = 64_000;
export const DEFAULT_AGENT_MAX_TURNS = 12;
/** A prompt larger than this is a context problem before it is a style problem. */
export const AGENT_PROMPT_LARGE_CHARS = 8_000;

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  read: 0,
  preview: 1,
  confirmed_write: 2,
  dangerous: 3,
};

export function effectivePermissionCeiling(
  draft: Pick<AgentDraft, "permissionCeiling">,
  hostCeiling: PermissionLevel,
): PermissionLevel {
  if (!draft.permissionCeiling) {
    return hostCeiling;
  }
  return PERMISSION_ORDER[draft.permissionCeiling] <= PERMISSION_ORDER[hostCeiling]
    ? draft.permissionCeiling
    : hostCeiling;
}

export function validateAgentDraft(draft: AgentDraft): AgentDraftDiagnostic[] {
  const diagnostics: AgentDraftDiagnostic[] = [];

  if (!/^[a-z][a-z0-9-]*$/u.test(draft.kind)) {
    diagnostics.push({
      severity: "error",
      path: "kind",
      message: 'agent kind must be lower-kebab-case, for example "release-checker".',
    });
  }
  if (!draft.persona?.en?.trim() && !draft.persona?.zhCN?.trim()) {
    diagnostics.push({
      severity: "error",
      path: "persona",
      message: "an agent needs a persona in at least one language.",
    });
  } else if (!draft.persona?.en?.trim() || !draft.persona?.zhCN?.trim()) {
    diagnostics.push({
      severity: "warning",
      path: "persona",
      message: "only one language is written; the other falls back to it, which reads as untranslated.",
    });
  }

  if (draft.toolAllowlist && draft.toolDenylist) {
    for (const name of draft.toolDenylist) {
      if (draft.toolAllowlist.includes(name)) {
        diagnostics.push({
          severity: "warning",
          path: "toolDenylist",
          message: `"${name}" is both allowed and denied; the denylist wins.`,
        });
      }
    }
  }
  if (draft.toolAllowlist && new Set(draft.toolAllowlist).size !== draft.toolAllowlist.length) {
    diagnostics.push({
      severity: "warning",
      path: "toolAllowlist",
      message: "the allowlist repeats a tool name.",
    });
  }

  if (
    draft.contextBudgetTokens !== undefined
    && (!Number.isInteger(draft.contextBudgetTokens) || draft.contextBudgetTokens <= 0)
  ) {
    diagnostics.push({
      severity: "error",
      path: "contextBudgetTokens",
      message: "context budget must be a positive integer.",
    });
  }
  if (draft.maxTurns !== undefined && (!Number.isInteger(draft.maxTurns) || draft.maxTurns <= 0)) {
    diagnostics.push({
      severity: "error",
      path: "maxTurns",
      message: "max turns must be a positive integer.",
    });
  }

  return diagnostics;
}

export function previewAgentView(
  draft: AgentDraft,
  context: {
    tools: readonly PreviewToolSource[];
    /** The most the host will ever grant, regardless of what the draft asks for. */
    hostPermissionCeiling: PermissionLevel;
    locale?: AgentPreviewLocale;
  },
): AgentViewPreview {
  const locale = context.locale ?? "en";
  const isChinese = locale === "zhCN";
  const diagnostics = validateAgentDraft(draft);
  const ceiling = effectivePermissionCeiling(draft, context.hostPermissionCeiling);

  if (
    draft.permissionCeiling
    && PERMISSION_ORDER[draft.permissionCeiling] > PERMISSION_ORDER[context.hostPermissionCeiling]
  ) {
    diagnostics.push({
      severity: "warning",
      path: "permissionCeiling",
      message: `this agent asks for ${draft.permissionCeiling} but the host grants at most `
        + `${context.hostPermissionCeiling}; the host limit applies.`,
    });
  }

  const known = new Map(context.tools.map((tool) => [tool.name, tool]));
  for (const name of draft.toolAllowlist ?? []) {
    if (!known.has(name)) {
      diagnostics.push({
        severity: "warning",
        path: "toolAllowlist",
        message: `"${name}" is not a tool in this build, so it can never be called.`,
      });
    }
  }

  const allowlist = draft.toolAllowlist ? new Set(draft.toolAllowlist) : undefined;
  const denylist = new Set(draft.toolDenylist ?? []);
  const availableTools: AgentViewPreview["availableTools"] = [];
  const withheldTools: AgentViewPreview["withheldTools"] = [];

  // Registry order, so the preview lists tools the way the runtime would.
  for (const tool of context.tools) {
    if (denylist.has(tool.name)) {
      withheldTools.push({
        name: tool.name,
        reason: isChinese ? "在拒绝名单中" : "on the denylist",
      });
      continue;
    }
    if (allowlist && !allowlist.has(tool.name)) {
      withheldTools.push({
        name: tool.name,
        reason: isChinese ? "不在允许名单中" : "not on the allowlist",
      });
      continue;
    }
    if (PERMISSION_ORDER[tool.permissionLevel] > PERMISSION_ORDER[ceiling]) {
      withheldTools.push({
        name: tool.name,
        reason: isChinese
          ? `需要 ${tool.permissionLevel}，超过该 agent 的权限上限 ${ceiling}`
          : `needs ${tool.permissionLevel}, above this agent's ceiling of ${ceiling}`,
      });
      continue;
    }
    availableTools.push({ name: tool.name, permissionLevel: tool.permissionLevel });
  }

  const persona = isChinese
    ? (draft.persona?.zhCN ?? draft.persona?.en ?? "")
    : (draft.persona?.en ?? draft.persona?.zhCN ?? "");
  const contextBudgetTokens = draft.contextBudgetTokens ?? DEFAULT_AGENT_CONTEXT_BUDGET_TOKENS;
  const maxTurns = draft.maxTurns ?? DEFAULT_AGENT_MAX_TURNS;

  const promptLines = [
    persona.trim(),
    "",
    isChinese
      ? `可用工具（${availableTools.length}）：${availableTools.map((tool) => tool.name).join("、") || "无"}`
      : `Available tools (${availableTools.length}): ${availableTools.map((tool) => tool.name).join(", ") || "none"}`,
    isChinese
      ? `权限上限：${ceiling}；上下文预算：${contextBudgetTokens.toLocaleString()} tokens；最大轮次：${maxTurns}`
      : `Permission ceiling: ${ceiling}; context budget: ${contextBudgetTokens.toLocaleString()} tokens; max turns: ${maxTurns}`,
  ];
  const promptPreview = promptLines.join("\n").trim();

  if (availableTools.length === 0) {
    diagnostics.push({
      severity: "warning",
      path: "toolAllowlist",
      message: "this agent has no usable tools, so it can only answer from the prompt.",
    });
  }
  if (promptPreview.length > AGENT_PROMPT_LARGE_CHARS) {
    diagnostics.push({
      severity: "warning",
      path: "persona",
      message: `the assembled prompt is ${promptPreview.length} characters, which is large for `
        + "something repeated on every turn.",
    });
  }

  return {
    diagnostics,
    availableTools,
    withheldTools,
    effectivePermissionCeiling: ceiling,
    promptPreview,
    promptChars: promptPreview.length,
    contextBudgetTokens,
    maxTurns,
  };
}
