import { isTerminalTaskStatus, type TaskSnapshot } from "@javis/core";
import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";

export const TASK_HISTORY_STORAGE_KEY = "javis.taskHistory.v1";
export const TASK_HISTORY_LIMIT = 20;
export const TASK_HISTORY_STORAGE_VERSION = 1;
export const TASK_HISTORY_TABLE_NAME = "task_history";
export const TASK_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  user_goal TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
)
`.trim();
export const TASK_HISTORY_UPDATED_AT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_task_history_updated_at ON task_history (updated_at DESC)
`.trim();
export const TASK_HISTORY_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "001_task_history",
  sql: TASK_HISTORY_SCHEMA_SQL,
};
export const TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION: DesktopDatabaseMigration = {
  id: "002_task_history_updated_at_index",
  sql: TASK_HISTORY_UPDATED_AT_INDEX_SQL,
};
export const TASK_HISTORY_SCHEMA_MIGRATIONS: DesktopDatabaseMigration[] = [
  TASK_HISTORY_SCHEMA_MIGRATION,
  TASK_HISTORY_UPDATED_AT_INDEX_MIGRATION,
];

type TaskHistoryReadStorage = Pick<Storage, "getItem">;
type TaskHistoryWriteStorage = Pick<Storage, "setItem">;
type TaskHistoryMigrationStorage = Pick<Storage, "getItem" | "removeItem">;

const ARCHIVABLE_STATUSES = new Set<TaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
]);
const REDACTED_IMAGE_DATA_URL = "[redacted image data URL]";
const IMAGE_DATA_URL_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;

export function isArchivableTask(task: TaskSnapshot): boolean {
  return task.id !== "task-idle" && ARCHIVABLE_STATUSES.has(task.status);
}

export function getTaskWorkspacePath(task: TaskSnapshot): string {
  const workspacePath =
    firstNonEmptyString(
      task.workspacePath,
      task.project?.workspacePath,
      task.codeReviewPreview?.workspacePath,
      task.codeProposedEdit?.workspacePath,
      task.codeApplyResult?.workspacePath,
    ) ?? "";
  return workspacePath;
}

export function loadTaskHistory(storage: TaskHistoryReadStorage): TaskSnapshot[] {
  try {
    const raw = storage.getItem(TASK_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const entries = parseTaskHistoryEntries(JSON.parse(raw));
    if (!entries) {
      return [];
    }

    return sanitizeTaskHistory(entries);
  } catch {
    return [];
  }
}

export function saveTaskHistory(
  storage: TaskHistoryWriteStorage,
  history: TaskSnapshot[],
): TaskSnapshot[] {
  const nextHistory = sanitizeTaskHistory(history);

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
    withHistoryTitle(sanitizedTask),
    ...current.filter((entry) => entry.id !== sanitizedTask.id),
  ].slice(0, TASK_HISTORY_LIMIT);
}

function withHistoryTitle(task: TaskSnapshot): TaskSnapshot {
  const derivedTitle = deriveHistoryTitle(task);
  return derivedTitle ? { ...task, title: derivedTitle } : task;
}

function deriveHistoryTitle(task: TaskSnapshot): string | undefined {
  if (!isGenericTaskTitle(task.title)) {
    return undefined;
  }
  const userMessages = task.conversationMessages
    ?.filter((message) => message.role === "user")
    .map((message) => message.content)
    .filter((content) => !isLowInformationTitle(content));
  const source = userMessages?.[userMessages.length - 1] || task.userGoal;
  const normalized = source.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized;
}

function isGenericTaskTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    isLowInformationTitle(title) ||
    normalized === "task" ||
    normalized === "planning task" ||
    normalized === "task completed" ||
    normalized === "answered" ||
    normalized === "answering" ||
    normalized === "ready" ||
    normalized === "已回答" ||
    normalized === "正在回答" ||
    normalized === "回答中" ||
    normalized === "已完成" ||
    normalized === "准备就绪"
  );
}

function isLowInformationTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "你好" ||
    normalized === "您好" ||
    normalized === "嗨" ||
    normalized === "哈喽" ||
    normalized === "hello" ||
    normalized === "hi" ||
    normalized === "hey"
  );
}

export function getTaskUpdatedAt(task: TaskSnapshot): string {
  if (task.updatedAt) {
    return task.updatedAt;
  }
  const timestamp = Number(task.id.replace("task-", ""));
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

export interface TaskHistoryRepository {
  list(): Promise<TaskSnapshot[]>;
  save(history: TaskSnapshot[]): Promise<TaskSnapshot[]>;
  upsert(task: TaskSnapshot): Promise<TaskSnapshot[]>;
  importFromLocalStorage(storage: TaskHistoryMigrationStorage): Promise<TaskSnapshot[]>;
}

export function createTaskHistoryRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): TaskHistoryRepository {
  return {
    async list() {
      return loadTaskHistoryFromDatabase(database);
    },

    async save(history) {
      return saveTaskHistoryToDatabase(database, history);
    },

    async upsert(task) {
      return upsertTaskHistoryInDatabase(database, task);
    },

    async importFromLocalStorage(storage) {
      return importTaskHistoryFromLocalStorage(database, storage);
    },
  };
}

export async function loadTaskHistoryWithStorageFallback(
  repository: Pick<TaskHistoryRepository, "list"> | null | undefined,
  storage: TaskHistoryReadStorage,
): Promise<TaskSnapshot[]> {
  if (!repository) {
    return loadTaskHistory(storage);
  }
  try {
    return await repository.list();
  } catch {
    return loadTaskHistory(storage);
  }
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

function sanitizeTaskHistory(history: unknown[]): TaskSnapshot[] {
  return history
    .map(sanitizeTaskSnapshot)
    .filter((task): task is TaskSnapshot => Boolean(task))
    .filter(isArchivableTask)
    .map(withHistoryTitle)
    .slice(0, TASK_HISTORY_LIMIT);
}

export async function loadTaskHistoryFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<TaskSnapshot[]> {
  const rows = await database.select<{ snapshot_json: string }>(
    `SELECT snapshot_json FROM ${TASK_HISTORY_TABLE_NAME} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    [TASK_HISTORY_LIMIT],
  );

  return sanitizeTaskHistory(
    rows.map((row) => {
      try {
        return JSON.parse(row.snapshot_json);
      } catch {
        return null;
      }
    }),
  );
}

export async function saveTaskHistoryToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  history: TaskSnapshot[],
): Promise<TaskSnapshot[]> {
  const nextHistory = sanitizeTaskHistory(history);
  await database.execute(`DELETE FROM ${TASK_HISTORY_TABLE_NAME}`);
  await saveTaskHistoryRows(database, nextHistory);
  return nextHistory;
}

export async function upsertTaskHistoryInDatabase(
  database: Pick<DesktopDatabase, "execute" | "select">,
  task: TaskSnapshot,
): Promise<TaskSnapshot[]> {
  const current = await loadTaskHistoryFromDatabase(database);
  const nextHistory = upsertTaskHistory(current, task);
  await saveTaskHistoryToDatabase(database, nextHistory);
  return nextHistory;
}

export async function importTaskHistoryFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: TaskHistoryMigrationStorage,
): Promise<TaskSnapshot[]> {
  const hasLegacyValue = storage.getItem(TASK_HISTORY_STORAGE_KEY) !== null;
  const importedHistory = loadTaskHistory(storage);
  if (importedHistory.length > 0) {
    const saved = await saveTaskHistoryToDatabase(database, importedHistory);
    removeLegacyTaskHistoryStorage(storage);
    return saved;
  }

  const currentHistory = await loadTaskHistoryFromDatabase(database);
  if (hasLegacyValue) {
    removeLegacyTaskHistoryStorage(storage);
  }
  return currentHistory;
}

async function saveTaskHistoryRows(
  database: Pick<DesktopDatabase, "execute">,
  history: TaskSnapshot[],
): Promise<void> {
  for (const task of history) {
    await database.execute(
      `INSERT INTO ${TASK_HISTORY_TABLE_NAME} (id, title, user_goal, status, updated_at, snapshot_json)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  user_goal = excluded.user_goal,
  status = excluded.status,
  updated_at = excluded.updated_at,
  snapshot_json = excluded.snapshot_json`,
      taskHistoryBindValues(task),
    );
  }
}

function taskHistoryBindValues(task: TaskSnapshot): DatabaseValue[] {
  // Strip base64 image attachments before persisting — too large for SQLite.
  const toStore = redactTaskSnapshotForPersistence(task);
  return [
    toStore.id,
    toStore.title,
    toStore.userGoal,
    toStore.status,
    getTaskUpdatedAt(toStore),
    JSON.stringify(toStore),
  ];
}

function removeLegacyTaskHistoryStorage(storage: TaskHistoryMigrationStorage): void {
  try {
    storage.removeItem(TASK_HISTORY_STORAGE_KEY);
  } catch {
    // Legacy cleanup should not block SQLite startup.
  }
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

  if (isString(value.updatedAt)) {
    snapshot.updatedAt = value.updatedAt;
  }
  if (value.originMode === "chat" || value.originMode === "project") {
    snapshot.originMode = value.originMode;
  }
  if (isString(value.workspacePath)) {
    snapshot.workspacePath = value.workspacePath;
  }
  if (isString(value.scheduledTaskId)) {
    snapshot.scheduledTaskId = value.scheduledTaskId;
  }
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
  const askUserQuestion = sanitizeAskUserQuestion(value.askUserQuestion);
  if (askUserQuestion) {
    snapshot.askUserQuestion = askUserQuestion;
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
  if (isChatMessageArray(value.conversationMessages)) {
    snapshot.conversationMessages = value.conversationMessages;
  }
  if (!snapshot.conversationMessages?.length && isTerminalTaskStatus(snapshot.status)) {
    snapshot.conversationMessages = [
      { role: "user", content: snapshot.userGoal },
      { role: "assistant", content: snapshot.commanderMessage },
    ];
  }

  return redactTaskSnapshotForPersistence(snapshot);
}

export function redactTaskSnapshotForPersistence(task: TaskSnapshot): TaskSnapshot {
  return {
    ...task,
    title: redactImageDataUrls(task.title),
    userGoal: redactImageDataUrls(task.userGoal),
    commanderMessage: redactImageDataUrls(task.commanderMessage),
    logs: task.logs.map((log) => {
      const redacted = {
        ...log,
        detail: redactImageDataUrls(log.detail),
      };
      if (log.userMessage !== undefined) {
        redacted.userMessage = redactImageDataUrls(log.userMessage);
      }
      if (log.devDetail !== undefined) {
        redacted.devDetail = redactImageDataUrls(log.devDetail);
      }
      return redacted;
    }),
    conversationMessages: task.conversationMessages?.map((message) => {
      const redacted = {
        ...message,
        content: redactImageDataUrls(message.content),
      };
      delete redacted.attachments;
      return redacted;
    }),
  };
}

function redactImageDataUrls(value: string): string {
  return value.replace(IMAGE_DATA_URL_PATTERN, REDACTED_IMAGE_DATA_URL);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTaskStatus(value: unknown): value is TaskSnapshot["status"] {
  return (
    value === "created" ||
    value === "planning" ||
    value === "waiting_info" ||
    value === "waiting_permission" ||
    value === "running" ||
    value === "generating" ||
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
    value === "computer" ||
    value === "scheduler" ||
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
        (!("agentId" in step) || isString(step.agentId)) &&
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
        isString(log.detail) &&
        (!("userMessage" in log) || isString(log.userMessage)) &&
        (!("devDetail" in log) || isString(log.devDetail)) &&
        (!("agentId" in log) || isString(log.agentId)) &&
        (!("stepId" in log) || isString(log.stepId)),
    )
  );
}

function isChatMessageArray(value: unknown): value is NonNullable<TaskSnapshot["conversationMessages"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        isRecord(message) &&
        (!("id" in message) || isString(message.id)) &&
        (!("kind" in message) || isConversationMessageKind(message.kind)) &&
        (message.role === "user" || message.role === "assistant") &&
        isString(message.content) &&
        (!("parentMessageId" in message) || isString(message.parentMessageId)) &&
        (!("createdAt" in message) || isString(message.createdAt)) &&
        (message.attachments === undefined ||
         (Array.isArray(message.attachments) && message.attachments.every(isString))) &&
        (!("askUserQuestion" in message) || isAskUserQuestionLike(message.askUserQuestion)) &&
        (!("permissionRequest" in message) || isRecord(message.permissionRequest)),
    )
  );
}

function isConversationMessageKind(value: unknown): value is NonNullable<NonNullable<TaskSnapshot["conversationMessages"]>[number]["kind"]> {
  return (
    value === "user_text" ||
    value === "assistant_text" ||
    value === "ask_user_question" ||
    value === "permission_request"
  );
}

function isAskUserQuestionLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.question) &&
    isString(value.status) &&
    (!("choices" in value) || Array.isArray(value.choices)) &&
    (!("answer" in value) || isString(value.answer))
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

function sanitizeAskUserQuestion(
  value: unknown,
): TaskSnapshot["askUserQuestion"] | undefined {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.question) ||
    !isString(value.status) ||
    !isString(value.createdAt)
  ) {
    return undefined;
  }

  if (value.status !== "answered" && value.status !== "expired" && value.status !== "cancelled") {
    return undefined;
  }

  const result: NonNullable<TaskSnapshot["askUserQuestion"]> = {
    id: value.id,
    question: value.question,
    status: value.status,
    createdAt: value.createdAt,
  };

  if (Array.isArray(value.choices)) {
    const choices: NonNullable<typeof result.choices> = [];
    for (const choice of value.choices) {
      if (isString(choice)) {
        choices.push(choice);
        continue;
      }
      if (!isRecord(choice) || !isString(choice.label) || !isString(choice.value)) {
        continue;
      }
      choices.push({
        label: choice.label,
        value: choice.value,
        isRecommended: choice.isRecommended === true,
      });
    }
    result.choices = choices;
  }
  if (isString(value.answer)) {
    result.answer = value.answer;
  }
  if (isString(value.resolvedAt)) {
    result.resolvedAt = value.resolvedAt;
  }

  return result;
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
