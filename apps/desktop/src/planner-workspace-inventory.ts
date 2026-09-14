/**
 * Deterministic workspace inventory for the planner (W1).
 *
 * The Commander plans from the goal text alone otherwise: it owns no read tool,
 * so "what does this workspace actually contain" was unanswerable during
 * planning and file targets were guessed (that guess produced a `.md` file for
 * an HTML request). `code.inspectWorkspace` is the repository's deterministic
 * inventory primitive, so the planner now receives a bounded summary of it.
 *
 * Everything here degrades to an empty string: a missing tool, an unselected
 * workspace, or a malformed payload must never block planning.
 */

/** Caps keep the injected block small enough for prefix caching to stay useful. */
const TOP_LEVEL_CAP = 20;
const MODULE_CAP = 10;
const MANIFEST_CAP = 10;
const IGNORED_CAP = 6;
const RISK_CAP = 5;

export interface WorkspaceInspectionSummary {
  workspacePath: string;
  entries: number;
  topLevelDirectories: string[];
  moduleCandidates: string[];
  manifests: string[];
  ignoredDirectories: string[];
  riskIndicators: string[];
  truncated: boolean;
}

export type WorkspaceInspectFn = (request: {
  maxDepth?: number;
  maxEntries?: number;
}) => Promise<unknown>;

/** Depth 2 covers "what kind of project is this" without walking the whole tree. */
const INSPECT_REQUEST = { maxDepth: 2, maxEntries: 120 } as const;

export async function collectPlannerWorkspaceInventory(options: {
  inspectWorkspace?: WorkspaceInspectFn;
  workspacePath?: string;
}): Promise<string> {
  const workspacePath = options.workspacePath?.trim();
  if (!options.inspectWorkspace || !workspacePath) return "";
  try {
    const payload = await options.inspectWorkspace({ ...INSPECT_REQUEST });
    const summary = summarizeWorkspaceInspection(payload);
    return summary ? formatPlannerWorkspaceInventory(summary) : "";
  } catch {
    // Planning must not fail because the inventory could not be collected.
    return "";
  }
}

/** Reads the fields the planner can use and ignores the rest of the payload. */
export function summarizeWorkspaceInspection(payload: unknown): WorkspaceInspectionSummary | undefined {
  if (!isRecord(payload)) return undefined;
  const topLevelDirectories = stringArray(payload.topLevelDirectories);
  const moduleCandidates = stringArray(payload.moduleCandidates);
  const manifests = stringArray(payload.manifests);
  const ignoredDirectories = stringArray(payload.ignoredDirectories);
  if (
    topLevelDirectories.length === 0 &&
    moduleCandidates.length === 0 &&
    manifests.length === 0
  ) {
    return undefined;
  }
  return {
    workspacePath: typeof payload.workspacePath === "string" ? payload.workspacePath : "",
    entries: Array.isArray(payload.entries) ? payload.entries.length : 0,
    topLevelDirectories,
    moduleCandidates,
    manifests,
    ignoredDirectories,
    riskIndicators: Array.isArray(payload.riskIndicators)
      ? payload.riskIndicators
          .map((risk) => (isRecord(risk) && typeof risk.label === "string" ? risk.label : ""))
          .filter((label) => label.length > 0)
      : [],
    truncated: payload.truncated === true,
  };
}

/** One line per category, so the block stays compact and stable across runs. */
export function formatPlannerWorkspaceInventory(summary: WorkspaceInspectionSummary): string {
  const lines = [
    `workspace=${summary.workspacePath || "(unknown)"} entries=${summary.entries} truncated=${summary.truncated}`,
    line("top-level", summary.topLevelDirectories, TOP_LEVEL_CAP),
    line("modules", summary.moduleCandidates, MODULE_CAP),
    line("manifests", summary.manifests, MANIFEST_CAP),
    line("ignored", summary.ignoredDirectories, IGNORED_CAP),
    line("risk", summary.riskIndicators, RISK_CAP),
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}

function line(label: string, values: readonly string[], cap: number): string | undefined {
  const kept = values.slice(0, cap);
  if (kept.length === 0) return undefined;
  const suffix = values.length > kept.length ? ` (+${values.length - kept.length} more)` : "";
  return `${label}: ${kept.join(", ")}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
