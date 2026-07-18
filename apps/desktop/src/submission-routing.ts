import { MAX_DOCUMENT_CONTEXT_REFERENCES, type TaskSnapshot } from "@javis/core";
import { isArchivableTask } from "./task-history";

export type RuntimeStartMode = "chat" | "project" | undefined;

export function extractAtReferences(goal: string): Array<{ raw: string; path: string }> {
  const references: Array<{ raw: string; path: string }> = [];
  const bracketPattern = /@\[((?:\\\]|[^\]])+)\]/g;
  let bracketMatch: RegExpExecArray | null;
  while ((bracketMatch = bracketPattern.exec(goal))) {
    const bracketPath = bracketMatch[1] ?? "";
    references.push({
      raw: bracketMatch[0],
      path: bracketPath.replace(/\\]/g, "]"),
    });
  }
  bracketPattern.lastIndex = 0;
  const goalWithoutBracketReferences = goal.replace(bracketPattern, " ");
  for (const raw of goalWithoutBracketReferences.match(/@([^\s,，。；;]+)/g) ?? []) {
    references.push({ raw, path: raw.slice(1) });
  }

  const seen = new Set<string>();
  return references
    .map((reference) => ({ ...reference, path: reference.path.trim() }))
    .filter((reference) => {
      const key = reference.path.replace(/\\/g, "/").toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DOCUMENT_CONTEXT_REFERENCES);
}

export function resolveVisionBridgeRuntimeMode(
  startMode: RuntimeStartMode,
  bridgeUsed: boolean,
): RuntimeStartMode {
  if (startMode === "project") {
    return "project";
  }
  return bridgeUsed ? "chat" : startMode;
}

export function resolveContinuationTask(input: {
  activeHistoryEntryId?: string;
  canContinueHistory: boolean;
  currentTask: TaskSnapshot;
  history: TaskSnapshot[];
  queuedContinuationTask?: TaskSnapshot | null;
}): TaskSnapshot | undefined {
  if (!input.canContinueHistory) return undefined;
  if (input.queuedContinuationTask) return input.queuedContinuationTask;
  if (input.activeHistoryEntryId) {
    if (
      input.currentTask.id === input.activeHistoryEntryId &&
      isArchivableTask(input.currentTask)
    ) {
      return input.currentTask;
    }
    return input.history.find((entry) => entry.id === input.activeHistoryEntryId);
  }
  return isArchivableTask(input.currentTask) ? input.currentTask : undefined;
}
