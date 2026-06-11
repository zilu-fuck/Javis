import { isTerminalTaskStatus, type TaskSnapshot } from "@javis/core";
import { getTaskWorkspacePath, getTaskUpdatedAt } from "./task-history";
import { createCanonicalWorkspaceId, type AgentSessionSummary } from "./agent-memory";

export function createAgentSessionSummaryFromTask(
  task: TaskSnapshot,
  workspacePath: string,
): AgentSessionSummary | null {
  if (task.id === "task-idle" || !isTerminalTaskStatus(task.status)) {
    return null;
  }
  const userGoal = sanitizeSummaryLine(task.userGoal);
  const assistantMessage = sanitizeSummaryLine(getFinalAssistantMessage(task));
  if (!userGoal && !assistantMessage) {
    return null;
  }
  const updatedAt = Date.parse(getTaskUpdatedAt(task));
  const timestamp = Number.isFinite(updatedAt) ? updatedAt : Date.now();
  const effectiveWorkspacePath = getTaskWorkspacePath(task) || workspacePath;
  const workspaceId = createCanonicalWorkspaceId(effectiveWorkspacePath);
  const importantPoints = [
    userGoal ? `User goal: ${userGoal}` : "",
    task.verificationSummary ? `Verification: ${sanitizeSummaryLine(task.verificationSummary)}` : "",
  ].filter(Boolean);
  const openThreads = extractOpenThreads(task);

  return {
    id: `summary:${task.id}`,
    sessionId: task.id,
    workspaceId: workspaceId || undefined,
    summary: [
      userGoal ? `User asked: ${userGoal}` : "",
      assistantMessage ? `Final response: ${assistantMessage}` : "",
    ].filter(Boolean).join("\n"),
    importantPoints,
    openThreads,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function getFinalAssistantMessage(task: TaskSnapshot): string {
  const messages = task.conversationMessages ?? [];
  const finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return finalAssistant?.content || task.commanderMessage || "";
}

function extractOpenThreads(task: TaskSnapshot): string[] {
  const threads: string[] = [];
  if (task.status === "failed" && task.userFacingError) {
    threads.push(`Error to revisit: ${sanitizeSummaryLine(task.userFacingError)}`);
  }
  if (task.askUserQuestion?.question) {
    threads.push(`Open question: ${sanitizeSummaryLine(task.askUserQuestion.question)}`);
  }
  return threads.slice(0, 3);
}

function sanitizeSummaryLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 360 ? `${normalized.slice(0, 357)}...` : normalized;
}
