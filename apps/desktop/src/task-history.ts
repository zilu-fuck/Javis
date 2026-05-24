import type { TaskSnapshot } from "@javis/core";

export const TASK_HISTORY_STORAGE_KEY = "javis.taskHistory.v1";
export const TASK_HISTORY_LIMIT = 20;
export const TASK_HISTORY_STORAGE_VERSION = 1;

type TaskHistoryStorage = Pick<Storage, "getItem" | "setItem">;

const ARCHIVABLE_STATUSES = new Set<TaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

export function isArchivableTask(task: TaskSnapshot): boolean {
  return task.id !== "task-idle" && ARCHIVABLE_STATUSES.has(task.status);
}

export function loadTaskHistory(storage: TaskHistoryStorage): TaskSnapshot[] {
  try {
    const raw = storage.getItem(TASK_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const entries = parseTaskHistoryEntries(JSON.parse(raw));
    if (!entries) {
      return [];
    }

    return entries
      .map(sanitizeTaskSnapshot)
      .filter((task): task is TaskSnapshot => Boolean(task))
      .filter(isArchivableTask)
      .slice(0, TASK_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveTaskHistory(
  storage: TaskHistoryStorage,
  history: TaskSnapshot[],
): TaskSnapshot[] {
  const nextHistory = history
    .map(sanitizeTaskSnapshot)
    .filter((task): task is TaskSnapshot => Boolean(task))
    .filter(isArchivableTask)
    .slice(0, TASK_HISTORY_LIMIT);

  try {
    storage.setItem(TASK_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
  } catch {
    // History is helpful but must not block the live task loop.
  }
  return nextHistory;
}

export function upsertTaskHistory(
  current: TaskSnapshot[],
  task: TaskSnapshot,
): TaskSnapshot[] {
  const sanitizedTask = sanitizeTaskSnapshot(task);
  if (!sanitizedTask || !isArchivableTask(sanitizedTask)) {
    return current;
  }

  return [
    sanitizedTask,
    ...current.filter((entry) => entry.id !== sanitizedTask.id),
  ].slice(0, TASK_HISTORY_LIMIT);
}

export function getTaskUpdatedAt(task: TaskSnapshot): string {
  const timestamp = Number(task.id.replace("task-", ""));
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function parseTaskHistoryEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    isRecord(value) &&
    value.version === TASK_HISTORY_STORAGE_VERSION &&
    Array.isArray(value.tasks)
  ) {
    return value.tasks;
  }

  return null;
}

export function sanitizeTaskSnapshot(value: unknown): TaskSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    !isString(value.id) ||
    !isString(value.title) ||
    !isString(value.userGoal) ||
    !isTaskStatus(value.status) ||
    !isString(value.commanderMessage) ||
    !isTaskStepArray(value.plan) ||
    !isAgentSnapshotArray(value.agents) ||
    !isTaskLogArray(value.logs)
  ) {
    return null;
  }

  const snapshot: TaskSnapshot = {
    id: value.id,
    title: value.title,
    userGoal: value.userGoal,
    status: value.status,
    commanderMessage: value.commanderMessage,
    plan: value.plan,
    agents: value.agents,
    logs: value.logs,
  };

  if (isMarkdownDocumentArray(value.documents)) {
    snapshot.documents = value.documents;
  }
  if (isCommandArray(value.commands)) {
    snapshot.commands = value.commands;
  }
  if (isFileOrganizationExecution(value.fileOrganizationExecution)) {
    snapshot.fileOrganizationExecution = value.fileOrganizationExecution;
  }
  if (isFileOrganizationPlan(value.fileOrganizationPlan)) {
    snapshot.fileOrganizationPlan = value.fileOrganizationPlan;
  }
  if (isProjectInspection(value.project)) {
    snapshot.project = value.project;
  }
  if (isCodeReviewPreview(value.codeReviewPreview)) {
    snapshot.codeReviewPreview = value.codeReviewPreview;
  }
  if (isCodeProposedEdit(value.codeProposedEdit)) {
    snapshot.codeProposedEdit = {
      ...value.codeProposedEdit,
      patch: "",
    };
  }
  if (isCodeApplyResult(value.codeApplyResult)) {
    snapshot.codeApplyResult = value.codeApplyResult;
  }
  const permissionRequest = sanitizeResolvedPermissionRequest(value.permissionRequest);
  if (permissionRequest) {
    snapshot.permissionRequest = permissionRequest;
  }
  if (isResearchReport(value.researchReport)) {
    snapshot.researchReport = value.researchReport;
  }
  if (isWebSourceArray(value.sources)) {
    snapshot.sources = value.sources;
  }
  if (isTokenUsageSummary(value.tokenUsage)) {
    snapshot.tokenUsage = value.tokenUsage;
  }
  if (isString(value.verificationSummary)) {
    snapshot.verificationSummary = value.verificationSummary;
  }

  return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTaskStatus(value: unknown): value is TaskSnapshot["status"] {
  return (
    value === "created" ||
    value === "planning" ||
    value === "running" ||
    value === "waiting_permission" ||
    value === "verifying" ||
    value === "retrying" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isTaskStepStatus(value: unknown): value is TaskSnapshot["plan"][number]["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "skipped"
  );
}

function isAgentRunStatus(value: unknown): value is TaskSnapshot["agents"][number]["status"] {
  return (
    value === "queued" ||
    value === "planning" ||
    value === "running" ||
    value === "waiting_permission" ||
    value === "verifying" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isAgentKind(value: unknown): boolean {
  return (
    value === "commander" ||
    value === "file" ||
    value === "shell" ||
    value === "browser" ||
    value === "research" ||
    value === "code" ||
    value === "verifier"
  );
}

function isTaskLogKind(value: unknown): value is TaskSnapshot["logs"][number]["kind"] {
  return (
    value === "plan" ||
    value === "tool" ||
    value === "permission" ||
    value === "verification" ||
    value === "event"
  );
}

function isPlannedPathAction(
  value: unknown,
): value is NonNullable<TaskSnapshot["permissionRequest"]>["dryRun"]["affectedPaths"][number]["action"] {
  return (
    value === "create" ||
    value === "modify" ||
    value === "move" ||
    value === "copy" ||
    value === "delete" ||
    value === "overwrite"
  );
}

function isPermissionLevel(
  value: unknown,
): value is NonNullable<TaskSnapshot["permissionRequest"]>["level"] {
  return value === "preview" || value === "confirmed_write" || value === "dangerous";
}

function isResolvedPermissionStatus(
  value: unknown,
): value is Exclude<NonNullable<TaskSnapshot["permissionRequest"]>["status"], "pending"> {
  return (
    value === "approved" ||
    value === "denied" ||
    value === "expired" ||
    value === "cancelled"
  );
}

function isTaskStepArray(value: unknown): value is TaskSnapshot["plan"] {
  return (
    Array.isArray(value) &&
    value.every(
      (step) =>
        isRecord(step) &&
        isString(step.id) &&
        isString(step.title) &&
        isAgentKind(step.assignedAgentKind) &&
        isTaskStepStatus(step.status) &&
        (!("successCriteria" in step) || isString(step.successCriteria)),
    )
  );
}

function isAgentSnapshotArray(value: unknown): value is TaskSnapshot["agents"] {
  return (
    Array.isArray(value) &&
    value.every(
      (agent) =>
        isRecord(agent) &&
        isString(agent.id) &&
        isString(agent.name) &&
        isString(agent.role) &&
        isAgentRunStatus(agent.status) &&
        isString(agent.task),
    )
  );
}

function isTaskLogArray(value: unknown): value is TaskSnapshot["logs"] {
  return (
    Array.isArray(value) &&
    value.every(
      (log) =>
        isRecord(log) &&
        isString(log.id) &&
        isTaskLogKind(log.kind) &&
        isString(log.title) &&
        isString(log.detail),
    )
  );
}

function isMarkdownDocumentArray(value: unknown): value is TaskSnapshot["documents"] {
  return (
    Array.isArray(value) &&
    value.every(
      (document) =>
        isRecord(document) &&
        isString(document.path) &&
        isString(document.modifiedAt) &&
        isNumber(document.sizeBytes) &&
        isString(document.purpose) &&
        (!("heading" in document) || isString(document.heading)) &&
        (!("excerpt" in document) || isString(document.excerpt)),
    )
  );
}

function isCommandArray(value: unknown): value is TaskSnapshot["commands"] {
  return (
    Array.isArray(value) &&
    value.every(
      (command) =>
        isRecord(command) &&
        isString(command.command) &&
        isString(command.cwd) &&
        (command.exitCode === null || isNumber(command.exitCode)) &&
        isString(command.stdout) &&
        isString(command.stderr),
    )
  );
}

function isPlannedPathArray(
  value: unknown,
): value is NonNullable<TaskSnapshot["permissionRequest"]>["dryRun"]["affectedPaths"] {
  return (
    Array.isArray(value) &&
    value.every(
      (path) =>
        isRecord(path) &&
        isString(path.source) &&
        isString(path.target) &&
        isPlannedPathAction(path.action) &&
        (!("conflict" in path) || isString(path.conflict)),
    )
  );
}

function isFileOrganizationPlan(value: unknown): value is TaskSnapshot["fileOrganizationPlan"] {
  return (
    isRecord(value) &&
    isString(value.approvalId) &&
    isString(value.directoryPath) &&
    isNumber(value.fileCount) &&
    isRecord(value.dryRun) &&
    isString(value.dryRun.operation) &&
    isPlannedPathArray(value.dryRun.affectedPaths) &&
    isString(value.dryRun.riskSummary) &&
    typeof value.dryRun.reversible === "boolean"
  );
}

function isFileOrganizationExecution(
  value: unknown,
): value is TaskSnapshot["fileOrganizationExecution"] {
  return (
    isRecord(value) &&
    isNumber(value.attemptedCount) &&
    isNumber(value.movedCount) &&
    isNumber(value.skippedCount) &&
    isNumber(value.failedCount) &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) =>
        isRecord(result) &&
        isString(result.source) &&
        isString(result.target) &&
        isString(result.status) &&
        isString(result.message),
    )
  );
}

function sanitizeResolvedPermissionRequest(
  value: unknown,
): TaskSnapshot["permissionRequest"] | undefined {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.level) ||
    !isString(value.title) ||
    !isString(value.reason) ||
    !isString(value.status) ||
    !isString(value.createdAt) ||
    !isRecord(value.dryRun) ||
    ("bindingHash" in value && !isString(value.bindingHash)) ||
    ("resolvedAt" in value && !isString(value.resolvedAt))
  ) {
    return undefined;
  }

  const dryRun = value.dryRun;
  const affectedPaths = dryRun.affectedPaths;
  if (
    !isString(dryRun.operation) ||
    !isPlannedPathArray(affectedPaths) ||
    !isString(dryRun.riskSummary) ||
    typeof dryRun.reversible !== "boolean"
  ) {
    return undefined;
  }

  if (!isPermissionLevel(value.level)) {
    return undefined;
  }

  if (!isResolvedPermissionStatus(value.status)) {
    return undefined;
  }

  return {
    id: value.id,
    level: value.level,
    title: value.title,
    reason: value.reason,
    dryRun: {
      operation: dryRun.operation,
      affectedPaths,
      riskSummary: dryRun.riskSummary,
      reversible: dryRun.reversible,
    },
    bindingHash: "bindingHash" in value && isString(value.bindingHash) ? value.bindingHash : undefined,
    status: value.status,
    createdAt: value.createdAt,
    resolvedAt:
      "resolvedAt" in value && isString(value.resolvedAt) ? value.resolvedAt : undefined,
  };
}

function isProjectInspection(value: unknown): value is TaskSnapshot["project"] {
  return (
    isRecord(value) &&
    isString(value.workspacePath) &&
    (!("packageManager" in value) || isString(value.packageManager)) &&
    (!("recommendedStartCommand" in value) || isString(value.recommendedStartCommand)) &&
    (!("recommendedTestCommand" in value) || isString(value.recommendedTestCommand)) &&
    Array.isArray(value.scripts) &&
    value.scripts.every(
      (script) =>
        isRecord(script) &&
        isString(script.name) &&
        isString(script.command),
    )
  );
}

function isCodeReviewPreview(value: unknown): value is NonNullable<TaskSnapshot["codeReviewPreview"]> {
  return (
    isRecord(value) &&
    isString(value.workspacePath) &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(isString) &&
    isString(value.diffStat) &&
    isString(value.diff)
  );
}

function isCodeProposedEdit(value: unknown): value is NonNullable<TaskSnapshot["codeProposedEdit"]> {
  return (
    isRecord(value) &&
    isString(value.proposalId) &&
    isString(value.workspacePath) &&
    isString(value.summary) &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(isString) &&
    isString(value.patch) &&
    isString(value.patchHash)
  );
}

function isCodeApplyResult(value: unknown): value is NonNullable<TaskSnapshot["codeApplyResult"]> {
  return (
    isRecord(value) &&
    typeof value.applied === "boolean" &&
    isString(value.workspacePath) &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(isString) &&
    isString(value.message)
  );
}

function isResearchReport(value: unknown): value is TaskSnapshot["researchReport"] {
  return (
    isRecord(value) &&
    isString(value.title) &&
    isString(value.summary) &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row) =>
        isRecord(row) &&
        isString(row.claim) &&
        isString(row.sourceUrl) &&
        isString(row.evidence),
    ) &&
    Array.isArray(value.unknowns) &&
    value.unknowns.every(isString)
  );
}

function isWebSourceArray(value: unknown): value is TaskSnapshot["sources"] {
  return (
    Array.isArray(value) &&
    value.every(
      (source) =>
        isRecord(source) &&
        isString(source.url) &&
        isString(source.excerpt) &&
        isString(source.fetchedAt) &&
        (!("title" in source) || isString(source.title)) &&
        (!("provider" in source) || isString(source.provider)),
    )
  );
}

function isTokenUsageSummary(value: unknown): value is NonNullable<TaskSnapshot["tokenUsage"]> {
  return (
    isRecord(value) &&
    isNumber(value.inputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.totalTokens) &&
    isNumber(value.modelCalls) &&
    Array.isArray(value.byAgentKind) &&
    value.byAgentKind.every(
      (entry) =>
        isRecord(entry) &&
        isString(entry.agentKind) &&
        isNumber(entry.inputTokens) &&
        isNumber(entry.outputTokens) &&
        isNumber(entry.totalTokens) &&
        isNumber(entry.modelCalls),
    )
  );
}
