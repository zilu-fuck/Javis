/**
 * Declarative agent overrides (B2).
 *
 * `agents.ts` ships the builtin cast as code. This module applies `.javis` agent
 * declarations on top of it, so adding or reshaping an agent becomes a config
 * change instead of an edit to three files:
 *
 *   { "kind": "security-reviewer", "additionalToolNames": ["code.traceCallChain"],
 *     "systemPrompt": { "zhCN": "你是安全评审员…" } }
 *
 * Two capabilities matter and are easy to get wrong:
 *
 *  * **replace vs append** — `allowedToolNames` replaces the allowlist (a project
 *    may want to narrow it), `additionalToolNames` extends it. Narrowing must not
 *    silently re-add builtins.
 *  * **creating a new kind** — a declaration with no builtin match becomes a new
 *    agent, but only when it supplies a persona. Inventing a system prompt would
 *    produce an agent that behaves arbitrarily.
 */

import type { Agent, AgentKind } from "../index";
import type { ConfigDiagnostic, JavisAgentDeclaration } from "./javis-config";

export interface DeclaredAgentRuntimeOverrides {
  modelSlot?: JavisAgentDeclaration["modelSlot"];
  maxIterations?: number;
}

export interface ApplyAgentDeclarationsResult {
  agents: Agent[];
  /**
   * Agents a caller must (re-)register: the overridden and the newly created ones.
   * Registering these into the *existing* registry matters because the runtime
   * captures the registry reference at construction, so replacing the object
   * would leave the runtime holding the old cast.
   */
  changedAgents: Agent[];
  /** Declarations that overrode a builtin agent. */
  overriddenKinds: string[];
  /** Declarations that created an agent kind the build did not ship. */
  createdKinds: string[];
  /** Runtime-only knobs, keyed by agent kind. */
  runtimeOverrides: Record<string, DeclaredAgentRuntimeOverrides>;
  diagnostics: ConfigDiagnostic[];
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function applyAgentDeclarations(
  baseAgents: readonly Agent[],
  declarations: readonly JavisAgentDeclaration[],
): ApplyAgentDeclarationsResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const byKind = new Map<string, Agent>();
  for (const agent of baseAgents) {
    byKind.set(normalizeKind(agent.kind), { ...agent, allowedToolNames: [...agent.allowedToolNames] });
  }

  const overriddenKinds: string[] = [];
  const createdKinds: string[] = [];
  const changedAgents: Agent[] = [];
  const runtimeOverrides: Record<string, DeclaredAgentRuntimeOverrides> = {};

  declarations.forEach((declaration, index) => {
    const path = `agents[${index}]`;
    const kind = normalizeKind(declaration.kind);
    if (kind.length === 0) {
      diagnostics.push({ severity: "error", path, message: "agent requires a non-empty kind." });
      return;
    }

    const existing = byKind.get(kind);
    const promptEn = declaration.systemPrompt?.en;
    const promptZh = declaration.systemPrompt?.zhCN;

    if (!existing) {
      if (promptEn === undefined && promptZh === undefined) {
        diagnostics.push({
          severity: "error",
          path: `${path}.systemPrompt`,
          message: `declared agent "${declaration.kind}" does not exist in this build and supplies no systemPrompt, `
            + "so it cannot be created.",
        });
        return;
      }
      const synthesized: Agent = {
        id: `agent-${kind}`,
        kind: kind as AgentKind,
        displayName: declaration.displayName ?? declaration.kind,
        description: declaration.description ?? "Declared by .javis configuration",
        allowedToolNames: unique([
          ...(declaration.allowedToolNames ?? []),
          ...(declaration.additionalToolNames ?? []),
        ]),
        systemPrompt: {
          en: promptEn ?? promptZh ?? "",
          zhCN: promptZh ?? promptEn ?? "",
        },
      };
      byKind.set(kind, synthesized);
      createdKinds.push(declaration.kind);
      changedAgents.push(synthesized);
    } else {
      const allowed = declaration.allowedToolNames !== undefined
        ? unique(declaration.allowedToolNames)
        : existing.allowedToolNames;
      const merged = unique([...allowed, ...(declaration.additionalToolNames ?? [])]);
      const overridden: Agent = {
        ...existing,
        ...(declaration.displayName !== undefined ? { displayName: declaration.displayName } : {}),
        ...(declaration.description !== undefined ? { description: declaration.description } : {}),
        allowedToolNames: merged,
        systemPrompt: {
          en: promptEn ?? existing.systemPrompt.en,
          zhCN: promptZh ?? existing.systemPrompt.zhCN,
        },
      };
      byKind.set(kind, overridden);
      overriddenKinds.push(declaration.kind);
      changedAgents.push(overridden);
    }

    if (declaration.modelSlot !== undefined || declaration.maxIterations !== undefined) {
      runtimeOverrides[kind] = {
        ...(declaration.modelSlot !== undefined ? { modelSlot: declaration.modelSlot } : {}),
        ...(declaration.maxIterations !== undefined ? { maxIterations: declaration.maxIterations } : {}),
      };
    }
  });

  return {
    agents: [...byKind.values()],
    changedAgents,
    overriddenKinds,
    createdKinds,
    runtimeOverrides,
    diagnostics,
  };
}

/**
 * Merges runtime knob overrides from several sources, highest priority last.
 * Used to combine `.javis` declarations with per-agent user preferences.
 */
export function mergeAgentRuntimeOverrides(
  ...sources: Array<Record<string, DeclaredAgentRuntimeOverrides> | undefined>
): Record<string, DeclaredAgentRuntimeOverrides> {
  const merged: Record<string, DeclaredAgentRuntimeOverrides> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [kind, overrides] of Object.entries(source)) {
      merged[normalizeKind(kind)] = { ...merged[normalizeKind(kind)], ...overrides };
    }
  }
  return merged;
}
