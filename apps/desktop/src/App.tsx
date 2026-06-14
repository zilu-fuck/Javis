import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGoalEvaluationFromDecision,
  createInitialTaskSnapshot,
  getAdapter,
  hasImageAttachments,
  injectDocumentContext,
  isGoalTerminal,
  isTerminalTaskStatus,
  PROVIDER_DEFINITIONS,
  type ChatMessage,
  type GoalDecision,
  type GoalEvaluation,
  type GoalEvent,
  type GoalState,
  type TaskSnapshot,
} from "@javis/core";
import { bridgeVisionIfNeeded } from "./vision-bridge";
import { buildRuntimeCapabilityVerification } from "./capability-verification";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type {
  ActiveView,
  WorkbenchPermissionDecision,
  WorkbenchModelConfiguration,
  WorkbenchModelProfile,
  WorkbenchScheduledTask,
  WorkbenchSkillEntry,
  WorkbenchSkillSearchKind,
  WorkbenchSkillSearchResult,
  WorkbenchSkillSearchSource,
  WorkbenchNewChatRecommendations,
  WorkbenchSystemResources,
  WorkbenchAgentCatalogEntry,
  WorkbenchAgentSessionContext,
  WorkbenchChatMessage,
  WorkbenchFileEntry,
  WorkbenchFileService,
  WorkbenchFileSearchResult,
  WorkbenchTerminalService,
  WorkbenchAgentStyleState,
  BrowserQuickRequest,
  BrowserQuickResult,
  GitCommitExecutionQuickResult,
  GitCommitPlanQuickResult,
  GitCommentPullRequestExecutionQuickResult,
  GitCommentPullRequestPlanQuickResult,
  GitCreatePullRequestExecutionQuickResult,
  GitCreatePullRequestPlanQuickResult,
  GitPushExecutionQuickResult,
  GitPushPlanQuickResult,
  GitStageExecutionQuickResult,
  GitStagePlanQuickResult,
  WorkbenchAgentMemorySummary,
  WorkbenchSkillSuggestion,
  WorkbenchUserProfileMemorySummary,
  WorkbenchScheduledTaskDraft,
  WorkbenchRuntimePreferences,
  WorkbenchDryRunAction,
  WorkbenchSubmitGoalIntent,
  WorkbenchSubmitGoalOptions,
  WorkbenchTerminalSession,
  WorkbenchBrowserWriteApprovalPreview,
  WorkbenchWorkspaceToolRequest,
} from "@javis/ui";
import { JavisWorkbench, zhCNWorkbenchLocale, defaultWorkbenchLocale } from "@javis/ui";
import {
  getTaskWorkspacePath,
  getTaskUpdatedAt,
  isArchivableTask,
  loadTaskHistory,
  upsertTaskHistory,
} from "./task-history";
import { useTaskRuntime, type ScheduledTasksRepositoryLike, type TaskHistoryRepositoryLike } from "./use-task-runtime";
import {
  createApprovalRecordFromPermissionRequest,
  expireApprovalRecord,
  isApprovalRecordExpired,
  loadApprovalRecords,
  resolveApprovalRecord,
  upsertApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";
import {
  APPROVAL_RECORDS_MIGRATIONS,
  createApprovalRecordsRepository,
} from "./approval-records-persistence";
import {
  createJavisRuntime,
  type BrowserWriteApprovalDecision,
  type BrowserWriteApprovalRequest,
  type RuntimeWorkspaceToolActivity,
  loadComputerUseConfigFromStorage,
  loadComputerUseLocalVisionSettingsFromStorage,
  loadComputerUseSettingsFromStorage,
  saveComputerUseLocalVisionSettingsToStorage,
  saveComputerUseSettingsToStorage,
} from "./app-runtime";
import {
  addTrustedComputerApp,
  extractTrustedComputerAppTitleFromPermissionRequest,
  loadTrustedComputerAppsFromPrefs,
  removeTrustedComputerApp,
  serializeTrustedComputerApps,
} from "./computer-trust";
import {
  CURRENT_GOAL_MIGRATIONS,
  createCurrentGoalRepository,
  loadCurrentGoal,
  saveCurrentGoal,
  type CurrentGoalRepository,
} from "./goal-persistence";
import {
  GOAL_EVENT_MIGRATIONS,
  createGoalTimelineRepository,
  type GoalTimelineRepository,
} from "./goal-event-persistence";
import {
  applyGoalEvaluationTransition,
  applyGoalStrategies,
  createGoalCreatedTransition,
  createGoalContinuationPrompt,
  createGoalEvaluatedEvent,
  createGoalStrategyContext,
  createGoalTaskBoundTransition,
  createGoalTaskTerminalEvent,
  createManualGoalTransition,
  findLatestGoalEvaluation as findGoalEvaluation,
  findLatestGoalTaskSnapshot,
  goalDecisionFromEvaluation,
  parseGoalCommand,
  reconcileGoalWithPersistedEvaluation,
} from "./goal-runtime";
import { createDefaultGoalStrategies } from "./goal-strategies";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  CODE_PATCH_APPROVAL_TITLE,
  CODE_PATCH_APPROVAL_TOOL_NAME,
  GIT_CREATE_PR_APPROVAL_TOOL_NAME,
  GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
  GIT_COMMIT_APPROVAL_TOOL_NAME,
  GIT_PUSH_APPROVAL_TOOL_NAME,
  GIT_STAGE_APPROVAL_TOOL_NAME,
  applyRestoredCodePatch,
  createRestoredCodePatchApprovalTask,
  createRestoredCodePatchApprovedTask,
  createRestoredCodePatchDeniedTask,
  createRestoredCodePatchFailedTask,
  createRestoredGitCreatePullRequestApprovalTask,
  createRestoredGitCreatePullRequestApprovedTask,
  createRestoredGitCreatePullRequestDeniedTask,
  createRestoredGitCreatePullRequestFailedTask,
  createRestoredGitCommentPullRequestApprovalTask,
  createRestoredGitCommentPullRequestApprovedTask,
  createRestoredGitCommentPullRequestDeniedTask,
  createRestoredGitCommentPullRequestFailedTask,
  createRestoredGitCommitApprovalTask,
  createRestoredGitCommitApprovedTask,
  createRestoredGitCommitDeniedTask,
  createRestoredGitCommitFailedTask,
  createRestoredGitPushApprovalTask,
  createRestoredGitPushApprovedTask,
  createRestoredGitPushDeniedTask,
  createRestoredGitPushFailedTask,
  createRestoredGitStageApprovalTask,
  createRestoredGitStageApprovedTask,
  createRestoredGitStageDeniedTask,
  createRestoredGitStageFailedTask,
  createRestoredPdfApprovalTask,
  createRestoredPdfApprovedTask,
  createRestoredPdfDeniedTask,
  createRestoredPdfFailedTask,
  findRestorableApprovalRecord,
  getDurableApprovalToolName,
  getDurableApprovalWorkspacePath,
  isDurableApprovalRequestTitle,
  runRestoredCodePatchVerification,
  runRestoredGitCreatePullRequest,
  runRestoredGitCommentPullRequest,
  runRestoredGitCommit,
  runRestoredGitPush,
  runRestoredGitStage,
  runRestoredPdfOrganization,
} from "./restored-approval";
import { useModelSettingsControls } from "./use-model-settings";
import { normalizeModelConfigurationConnections } from "./model-settings";
import { createConfiguredModelProvider } from "./model-provider";
import { fetchProviderModels } from "./provider-models";
import { useModelProfiles, type ModelProfileRepositoryLike } from "./use-model-profiles";
import { useScannedData } from "./use-scanned-data";
import {
  APP_CLASSIFICATION_MIGRATIONS,
  createAppClassificationRepository,
  type AppClassificationRepository,
} from "./app-classification-persistence";
import { useScheduledTasks } from "./use-scheduled-tasks";
import { useWorkspaceSessionControls } from "./use-workspace-session";
import {
  computeNextRun,
  createScheduledTask,
  loadScheduledTasks,
  saveScheduledTasks,
  clearStaleGuards,
  type ScheduledTask,
} from "./scheduled-tasks";
import {
  createScheduledTasksRepository,
  SCHEDULED_TASKS_MIGRATIONS,
} from "./scheduled-tasks-persistence";
import { loadMcpConfig, saveMcpConfig, type McpServerConfig } from "./mcp-config";
import {
  readFileChunk,
} from "./local-knowledge";
import {
  FILE_CLASSIFICATION_MIGRATIONS,
  createFileClassificationRepository,
  type FileClassificationRepository,
} from "./file-classification-persistence";
import {
  RESOURCE_SCAN_ROOTS_MIGRATION,
  createResourceScanRootRepository,
  type ResourceScanRootRepository,
} from "./resource-scan-roots";
import {
  RESOURCE_FILE_CACHE_MIGRATION,
  RESOURCE_FILE_CACHE_INDEX_MIGRATION,
  createResourceCacheRepository,
  type ResourceCacheRepository,
} from "./resource-scan-cache";
import {
  invokeDesktopDatabase,
  runDesktopDatabaseMigrations,
  type DesktopDatabase,
} from "./desktop-database";
import {
  createTaskHistoryRepository,
  TASK_HISTORY_SCHEMA_MIGRATIONS,
} from "./task-history";
import {
  createWorkspaceSessionRepository,
  type WorkspaceSessionRepository,
} from "./workspace-session";
import { WORKSPACE_SETTINGS_MIGRATIONS } from "./workspace-settings-persistence";
import { RECENT_WORKSPACES_SCHEMA_MIGRATIONS } from "./recent-workspaces";
import {
  createModelSettingsRepository,
  MODEL_SETTINGS_MIGRATIONS,
  type ModelSettingsRepository,
} from "./model-settings-persistence";
import {
  createModelProfileRepository,
  MODEL_PROFILES_MIGRATIONS,
} from "./model-profile-persistence";
import {
  TOOL_CALL_AUDIT_MIGRATIONS,
  appendToolCallAuditJsonLine,
  appendTaskSnapshotAuditJsonLines,
  createFileBackedTaskAuditJsonLineWriter,
  listRecentToolCallAuditRecords,
  upsertToolCallAuditRecord,
  type ToolCallAuditRecord,
} from "./tool-call-audit";
import {
  GIT_PUSH_AUDIT_TOOL_NAME,
  createGitPushExecutionAuditRecord,
  createGitPushFailedAuditRecord,
  createGitPushPermissionRequest,
  createGitPushPlanAuditRecord,
} from "./git-push-audit";
import {
  GIT_STAGE_AUDIT_TOOL_NAME,
  createGitStageExecutionAuditRecord,
  createGitStageFailedAuditRecord,
  createGitStagePermissionRequest,
  createGitStagePlanAuditRecord,
} from "./git-stage-audit";
import {
  createGitCommitExecutionAuditRecord,
  createGitCommitFailedAuditRecord,
  createGitCommitPermissionRequest,
  createGitCommitPlanAuditRecord,
} from "./git-commit-audit";
import {
  GIT_CREATE_PR_AUDIT_TOOL_NAME,
  createGitCreatePullRequestExecutionAuditRecord,
  createGitCreatePullRequestFailedAuditRecord,
  createGitCreatePullRequestPermissionRequest,
  createGitCreatePullRequestPlanAuditRecord,
} from "./git-create-pr-audit";
import {
  createGitCommentPullRequestExecutionAuditRecord,
  createGitCommentPullRequestFailedAuditRecord,
  createGitCommentPullRequestPermissionRequest,
  createGitCommentPullRequestPlanAuditRecord,
} from "./git-comment-pr-audit";
import {
  createTerminalCreateExecutionAuditRecord,
  createTerminalFailedAuditRecord,
  createTerminalInputExecutionAuditRecord,
  createTerminalPlanAuditRecord,
  type TerminalPlanResult,
} from "./terminal-audit";
import {
  appendTaskSessionSnapshotJsonLine,
  createFileBackedTaskSessionJsonLineWriter,
} from "./task-session-log";
import {
  createUserPreferencesRepository,
  PENDING_USER_PREFERENCES_STORAGE_KEY,
  PREF_KEYS,
  USER_PREFERENCES_MIGRATIONS,
  type UserPreferencesRepository,
} from "./user-preferences-persistence";
import {
  createSqliteTaskSessionWriter,
  importTaskSessionJsonlFromLocalStorage,
  importToolCallAuditJsonlFromLocalStorage,
  JSONL_LOG_MIGRATIONS,
} from "./jsonl-log-persistence";
import type { ToolDescriptor, TrustedComputerApp } from "@javis/tools";
import { decodeMcpToolServerName, encodeMcpToolServerName, initialToolDescriptors, isDisabledBrowserWriteToolName } from "@javis/tools";
import {
  buildMcpListToolsDescriptor,
  buildMcpToolDescriptorsFromList,
  isAllowlistedMcpCallToolRequest,
  isExecutableMcpServer,
  isRunnableMcpServerConfig,
  mcpRuntimeServerKey,
  type McpRuntimeServerConfig,
} from "./mcp-tool-descriptors";
import {
  getFreshCachedMcpToolDescriptors,
  loadMcpToolDescriptorCache,
  pruneMcpToolDescriptorCache,
  saveMcpToolDescriptorCache,
  setCachedMcpToolDescriptors,
  type McpToolDescriptorCache,
} from "./mcp-tool-descriptor-cache";
import {
  formatEnabledSkillContext,
  type EnabledUserSkillContext,
  type SkillContextSelectionRequest,
} from "./skill-context";
import {
  createDefaultAgentRegistry,
  createWorkflowRegistry,
  createRouteRegistry,
  demoAgents,
  WORKBENCH_WORKFLOWS,
} from "@javis/core";
import type {
  AgentRegistry,
  WorkflowRegistry,
  RouteRegistry,
  WorkspaceDefinition,
} from "@javis/core";
import {
  buildWorkspaceNavItems,
  loadWorkspaceDefinitions,
  registerWorkspaceAgents,
  registerWorkspaceWorkflows,
  registerWorkspaceRoutes,
} from "./workspace-loader";
import {
  createNewChatRecommendations,
  createUserProfileMemoryRepository,
  createUserProfileMemory,
  updateUserProfileMemory,
  clearUserProfileMemory,
  loadUserProfileMemory,
  saveUserProfileMemory,
  USER_PROFILE_MEMORY_MIGRATIONS,
  type UserProfileMemory,
  type UserProfileMemoryRepository,
} from "./user-profile-memory";
import {
  AGENT_MEMORY_MIGRATIONS,
  createAgentMemoryRepository,
  createCanonicalWorkspaceId,
  type AgentMemoryRepository,
  type AgentMemoryScopeType,
} from "./agent-memory";
import {
  VECTOR_INDEX_MIGRATIONS,
  createVectorIndexRepository,
} from "./vector-index";
import { createAgentMemoryEmbeddingProvider } from "./agent-memory-embedding-provider";
import {
  buildAgentMemoryPromptContextFromRepository,
  restoreAgentMemoryFromTaskHistory,
} from "./agent-memory-runtime";
import { extractAgentMemoryFactsFromSummary } from "./agent-memory-pipeline";
import { createAgentSessionSummaryFromTask } from "./agent-session-summary";
import { getBuiltinSidebarNavItems, mergeSidebarNavItems } from "@javis/ui";
import { TitleBar } from "./TitleBar";
import {
  DEFAULT_RUNTIME_PREFERENCES,
  composeModeForStartupPreference,
  runtimePreferencesFromPrefs,
  runtimePreferencesToPrefs,
  sanitizeRuntimePreferences,
} from "./runtime-preferences";
import "./App.css";

export const DEFAULT_DRAFT_GOAL = "";
const currentWindow =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? getCurrentWindow()
    : null;

const AGENT_MEMORY_ENABLED_PREFERENCE_KEY = "agent_memory_enabled";
const AGENT_MEMORY_HISTORY_RESTORE_DONE_PREFERENCE_KEY = "agent_memory_history_restore_done_v1";
const BUILTIN_TOOL_DISABLED_NAMES_PREFERENCE_KEY = "builtin_tool_disabled_names";
const BUILTIN_TOOL_LOCKED_NAMES = new Set([
  "commander.plan",
  "commander.synthesize",
  "commander.askUser",
  "verifier.check",
]);
const AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY = "agent_memory_query_hmac_secret";
const MCP_DISCOVERY_CONCURRENCY = 2;
const ACTIVE_COMPUTER_USE_STATUSES = new Set([
  "planning",
  "running",
  "generating",
  "waiting_permission",
  "waiting_info",
  "retrying",
  "verifying",
]);
const COMPUTER_USE_TEXT_MARKERS = [
  "computer use",
  "computer-use",
  "computer-use.loop",
];
const SKILL_MARKET_SUGGESTION_LIMIT = 8;
const SKILL_MARKET_MEMORY_KEYWORD_LIMIT = 4;
const SKILL_MARKET_KEYWORD_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "the",
  "this",
  "that",
  "with",
  "javis",
  "codex",
  "agent",
  "agents",
  "skill",
  "skills",
  "tool",
  "tools",
  "task",
  "tasks",
  "project",
  "projects",
  "workspace",
  "workspaces",
  "file",
  "files",
  "github",
  "用户",
  "需要",
  "使用",
  "可以",
  "当前",
  "相关",
  "任务",
  "项目",
  "工作区",
  "文件",
  "设置",
  "技能",
  "工具",
  "助手",
  "模型",
  "系统",
]);

type SearchWebSourceResult = {
  url: string;
  title?: string;
  excerpt: string;
  provider?: string;
};

void SKILL_MARKET_SUGGESTION_LIMIT;
void SKILL_MARKET_MEMORY_KEYWORD_LIMIT;
void SKILL_MARKET_KEYWORD_STOPWORDS;
const SEARCH_WEB_SOURCE_RESULT_TYPECHECK: SearchWebSourceResult | null = null;
void SEARCH_WEB_SOURCE_RESULT_TYPECHECK;

interface UserSkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  enabled: boolean;
  removable: boolean;
  toggleable: boolean;
}

interface CodexMcpServerSummary {
  name: string;
  transport: string;
  command?: string;
  url?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  source: string;
  removable: boolean;
}

interface InstalledMcpServerSummary {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  url?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

type SkillTranslationCache = Record<
  string,
  {
    name?: string;
    description?: string;
    agentOwners?: string[];
    sourceSignature?: string;
  }
>;

function scheduledTaskToWorkbench(
  task: ScheduledTask,
  history: TaskSnapshot[],
  activeScheduledTaskId: string | undefined,
): WorkbenchScheduledTask {
  let lastRunStatus: "running" | "success" | "failed" | "never" = "never";
  if (task.lastRunStartedAt && activeScheduledTaskId === task.id) {
    lastRunStatus = "running";
  } else {
    const matchingEntry = [...history]
      .reverse()
      .find((h) => h.scheduledTaskId === task.id);
    if (matchingEntry) {
      lastRunStatus =
        matchingEntry.status === "completed"
          ? "success"
          : matchingEntry.status === "failed" || matchingEntry.status === "cancelled"
            ? "failed"
            : "never";
    }
  }
  return {
    id: task.id,
    name: task.name,
    goal: task.goal,
    scheduleType: task.schedule.type,
    scheduleValue: task.schedule.value,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunStatus,
    createdAt: task.createdAt,
  };
}

function extractAtReferences(goal: string): Array<{ raw: string; path: string }> {
  const bracketRefs: Array<{ raw: string; path: string }> = [];
  const bracketPattern = /@\[((?:\\\]|[^\]])+)\]/g;
  let bracketMatch: RegExpExecArray | null;
  while ((bracketMatch = bracketPattern.exec(goal))) {
    const bracketPath = bracketMatch[1] ?? "";
    bracketRefs.push({
      raw: bracketMatch[0],
      path: bracketPath.replace(/\\]/g, "]"),
    });
  }
  if (bracketRefs.length > 0) return bracketRefs;

  const matches = goal.match(/@([^\s,，。；;]+)/g);
  if (!matches) return [];
  return matches.map((raw) => {
    const path = raw.slice(1); // strip leading @
    return { raw, path };
  });
}

function getAllowedRootScopeForReference(
  referencePath: string,
  documents: WorkbenchFileEntry[],
  workspacePath?: string,
): { workspaceRoot?: string; allowedRootIds?: string[] } {
  const referenceKey = normalizePathForReferenceMatch(referencePath);
  const matchedDocument = documents.find(
    (doc) => normalizePathForReferenceMatch(doc.path) === referenceKey,
  );
  const allowedRootIds = matchedDocument?.sourceRootId?.trim()
    ? [matchedDocument.sourceRootId.trim()]
    : undefined;
  return {
    workspaceRoot: workspacePath?.trim() || undefined,
    allowedRootIds,
  };
}

function normalizePathForReferenceMatch(path: string): string {
  return path.trim().replace(/\\/g, "/").toLocaleLowerCase();
}

function getConversationMessages(task: TaskSnapshot): ChatMessage[] {
  if (task.conversationMessages?.length) {
    return task.conversationMessages;
  }
  if (!task.userGoal.trim() || !task.commanderMessage.trim()) {
    return [];
  }
  return [
    { role: "user", content: task.userGoal },
    { role: "assistant", content: task.commanderMessage },
  ];
}

function inferSubmitGoalIntent(input: {
  goalId?: string;
  scheduledTaskId?: string;
  forceStart?: boolean;
  activeHistoryEntryId?: string;
  task: TaskSnapshot;
}): WorkbenchSubmitGoalIntent {
  if (input.goalId) return "goal";
  if (input.scheduledTaskId) return "scheduled";
  if (input.forceStart) return "queued_continuation";
  if (input.activeHistoryEntryId || isArchivableTask(input.task)) {
    return "continue_history";
  }
  return "new_chat";
}

function shouldRouteAsDirectChat(
  rawGoal: string,
  composeMode: "chat" | "project",
  submitIntent: WorkbenchSubmitGoalIntent,
  imageDataUrls?: string[],
): boolean {
  return (
    composeMode === "project" &&
    (submitIntent === "new_chat" || submitIntent === "continue_history") &&
    !imageDataUrls?.length &&
    isLightweightChatGoal(rawGoal)
  );
}

function isLightweightChatGoal(goal: string): boolean {
  const normalized = goal.trim().replace(/[。！？!?~～\s]+$/g, "").toLowerCase();
  if (!normalized) return false;
  const exactGreetings = new Set([
    "你好",
    "您好",
    "嗨",
    "哈喽",
    "在吗",
    "你是谁",
    "谢谢",
    "多谢",
    "hello",
    "hi",
    "hey",
    "thanks",
    "thank you",
  ]);
  if (exactGreetings.has(normalized)) {
    return true;
  }
  return /^帮我解释一下.{0,80}$/.test(normalized) && !hasExecutionIntent(normalized);
}

function hasExecutionIntent(value: string): boolean {
  return /修改|修复|创建|新建|删除|移动|运行|执行|测试|部署|提交|commit|push|pr|打开|点击|浏览器|文件|代码|项目|规划|计划|实现/.test(value);
}

function logNonFatalError(context: string, error: unknown) {
  console.warn(context, error);
}

function logTaskContext(action: string, context: Record<string, unknown>) {
  if (typeof console === "undefined" || typeof console.debug !== "function") {
    return;
  }
  console.debug("[task-context]", { action, ...context });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function getOrCreateAgentMemoryQueryHmacSecret(
  repository: UserPreferencesRepository | null,
): Promise<string> {
  const pendingValue = loadPendingPreferencesFromLocalStorage()[AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY];
  if (pendingValue?.trim()) {
    if (repository) {
      await repository.set(AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY, pendingValue);
    }
    return pendingValue;
  }

  if (repository) {
    const existing = await repository.get(AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY);
    if (existing?.trim()) {
      return existing;
    }
  }

  const secret = createRandomAgentMemorySecret();
  if (repository) {
    await repository.set(AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY, secret);
  } else {
    persistPendingPreferenceToLocalStorage(AGENT_MEMORY_QUERY_HMAC_SECRET_PREFERENCE_KEY, secret);
  }
  return secret;
}

function createAgentMemoryInjectionLogId(taskId: string | undefined): string {
  const safeTaskId = (taskId?.trim() || "task-unknown").replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 80);
  const unique = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `mem-injection:${safeTaskId}:${unique}`;
}

function createRandomAgentMemorySecret(): string {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function countAgentMemoryScopes(results: Array<{ scopeType: AgentMemoryScopeType }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.scopeType] = (counts[result.scopeType] ?? 0) + 1;
  }
  return counts;
}

async function recordAgentMemoryInjectionAudit(options: {
  repository: AgentMemoryRepository;
  preferencesRepository: UserPreferencesRepository | null;
  taskId: string;
  workspaceId?: string;
  injectionType: Parameters<AgentMemoryRepository["recordMemoryInjection"]>[0]["injectionType"];
  memoryFactIds: string[];
  query?: string;
  scopeType?: AgentMemoryScopeType;
  scopeId?: string;
  promptSection: string;
  scoreSummary: Record<string, unknown>;
}) {
  const queryHashSecret = options.query?.trim()
    ? await getOrCreateAgentMemoryQueryHmacSecret(options.preferencesRepository)
    : undefined;
  await options.repository.recordMemoryInjection({
    id: createAgentMemoryInjectionLogId(options.taskId),
    sessionId: options.taskId,
    workspaceId: options.workspaceId,
    injectionType: options.injectionType,
    memoryFactIds: options.memoryFactIds,
    query: options.query,
    queryHashSecret,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    promptSection: options.promptSection,
    scoreSummary: options.scoreSummary,
  });
}

type SubmitGoalHandler = (
  goalOverride?: string,
  workspacePathOverride?: string,
  scheduledTaskId?: string,
  attachments?: File[],
  imageDataUrls?: string[],
  forceStart?: boolean,
  queuedRawGoal?: string,
  forcedMode?: "chat" | "project",
  goalId?: string,
  submitIntent?: WorkbenchSubmitGoalIntent,
) => void;

interface PendingGoalSubmission {
  goalOverride?: string;
  rawGoal: string;
  workspacePathOverride?: string;
  scheduledTaskId?: string;
  attachments?: File[];
  imageDataUrls?: string[];
  composeMode: "chat" | "project";
  forcedMode?: "chat" | "project";
  goalId?: string;
  submitIntent?: WorkbenchSubmitGoalIntent;
  clearDraftOnQueue: boolean;
}

function hasUsableAiConfiguration(
  modelConfiguration: WorkbenchModelConfiguration | undefined,
  modelSettings: { provider: string; model: string; apiKey: string; baseUrl: string },
): boolean {
  if (modelSettings.model.trim() && (modelSettings.apiKey.trim() || allowsLocalModelWithoutKey(modelSettings))) {
    return true;
  }
  return Boolean(modelConfiguration?.profiles.some(isUsableModelProfile));
}

function isUsableModelProfile(profile: WorkbenchModelProfile): boolean {
  if (!profile.provider.trim() || !profile.model.trim()) {
    return false;
  }
  return Boolean(profile.apiKey.trim() || profile.hasStoredApiKey || allowsLocalModelWithoutKey(profile));
}

function allowsLocalModelWithoutKey(settings: { provider: string; baseUrl: string }): boolean {
  const provider = settings.provider.trim().toLowerCase();
  const baseUrl = settings.baseUrl.trim().toLowerCase();
  return provider === "ollama"
    || baseUrl.startsWith("http://localhost")
    || baseUrl.startsWith("http://127.")
    || baseUrl.startsWith("http://[::1]")
    || baseUrl.startsWith("http://::1");
}

function isActiveComputerUseTaskSnapshot(task: TaskSnapshot, isTaskActive: boolean): boolean {
  if (!isTaskActive || !ACTIVE_COMPUTER_USE_STATUSES.has(task.status)) {
    return false;
  }
  if (task.permissionRequest?.dryRun.operation.startsWith("computer.")) {
    return true;
  }
  if (task.streamingAgentKind === "computer" && hasComputerUseText(task.commanderMessage)) {
    return true;
  }
  if (task.plan.some((step) =>
    ACTIVE_COMPUTER_USE_STATUSES.has(step.status) &&
    (step.agentId === "agent-computer" || hasComputerUseText(step.id)) &&
    (hasComputerUseText(step.id) || hasComputerUseText(step.title) || hasComputerUseText(step.successCriteria))
  )) {
    return true;
  }
  if (task.agents.some((agent) =>
    agent.id === "agent-computer" &&
    ACTIVE_COMPUTER_USE_STATUSES.has(agent.status) &&
    hasComputerUseText(agent.task)
  )) {
    return true;
  }
  return Boolean(task.executionTrace?.steps.some((step) =>
    step.toolName?.startsWith("computer.") ||
    hasComputerUseText(step.stepId) ||
    hasComputerUseText(step.toolName)
  ));
}

function hasComputerUseText(value: string | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return COMPUTER_USE_TEXT_MARKERS.some((marker) => normalized.includes(marker));
}

function App() {
  const databaseRef = useRef<DesktopDatabase | null>(null);
  const taskHistoryRepoRef = useRef<TaskHistoryRepositoryLike>(null);
  const workspaceSessionRepoRef = useRef<WorkspaceSessionRepository | null>(null);
  const approvalRecordsRepoRef = useRef<ReturnType<typeof createApprovalRecordsRepository> | null>(null);
  const modelSettingsRepoRef = useRef<ModelSettingsRepository | null>(null);
  const userProfileMemoryRepoRef = useRef<UserProfileMemoryRepository | null>(null);
  const agentMemoryRepoRef = useRef<AgentMemoryRepository | null>(null);
  const scheduledTasksRepoRef = useRef<ScheduledTasksRepositoryLike>(null);
  const preferencesRepoRef = useRef<UserPreferencesRepository | null>(null);
  const currentGoalRepoRef = useRef<CurrentGoalRepository | null>(null);
  const goalTimelineRepoRef = useRef<GoalTimelineRepository | null>(null);
  const agentRegistryRef = useRef<AgentRegistry>(createDefaultAgentRegistry());
  const workflowRegistryRef = useRef<WorkflowRegistry>(createWorkflowRegistry(WORKBENCH_WORKFLOWS));
  const routeRegistryRef = useRef<RouteRegistry>(createRouteRegistry());
  const [workspaceDefs, setWorkspaceDefs] = useState<WorkspaceDefinition[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(() =>
    clearStaleGuards(loadScheduledTasks(window.localStorage)),
  );
  const scheduledTasksInitialRef = useRef(scheduledTasks);
  const scheduledTasksCurrentRef = useRef(scheduledTasks);
  scheduledTasksCurrentRef.current = scheduledTasks;
  const submitGoalRef = useRef<SubmitGoalHandler>(() => {});
  const pendingGoalQueueRef = useRef<PendingGoalSubmission[]>([]);
  const queuedSubmissionModeRef = useRef<"chat" | "project" | null>(null);
  const queuedContinuationTaskRef = useRef<TaskSnapshot | null>(null);
  const queuedStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextQueuedGoalForTaskRef = useRef<string | null>(null);
  const emergencyStopTaskRef = useRef<() => void>(() => {});
  const pendingGoalBindRef = useRef<{ goalId: string } | null>(null);
  const evaluatedGoalTaskIdsRef = useRef<Set<string>>(new Set());
  const goalContinuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setQueuedGoalCount] = useState(0);
  const modelConfigRef = useRef<WorkbenchModelConfiguration | undefined>(undefined);
  const {
    browseWorkspacePath,
    deleteRecentWorkspacePath,
    persistWorkspaceForTask,
    replaceWorkspaceSession,
    useWorkspacePath,
    workspaceSession,
  } = useWorkspaceSessionControls(window.localStorage, workspaceSessionRepoRef);
  const { recentWorkspacePaths, workspacePath } = workspaceSession;
  const [workspaceToolRequest, setWorkspaceToolRequest] = useState<WorkbenchWorkspaceToolRequest | null>(null);
  const currentWorkspaceMemoryId = useMemo(
    () => createCanonicalWorkspaceId(workspacePath),
    [workspacePath],
  );
  const [runtimePreferences, setRuntimePreferences] = useState<WorkbenchRuntimePreferences>(
    DEFAULT_RUNTIME_PREFERENCES,
  );
  useEffect(() => {
    document.documentElement.dataset.theme = runtimePreferences.appearanceTheme;
  }, [runtimePreferences.appearanceTheme]);
  const [isAgentMemoryEnabled, setAgentMemoryEnabled] = useState(
    DEFAULT_RUNTIME_PREFERENCES.agentMemoryScope !== "off",
  );
  const [disabledBuiltinToolNames, setDisabledBuiltinToolNames] = useState<Set<string>>(
    () => parseDisabledBuiltinToolNames(loadPreference(BUILTIN_TOOL_DISABLED_NAMES_PREFERENCE_KEY)),
  );
  const { modelSettings, updateModelSettings } = useModelSettingsControls(window.localStorage);
  const [computerUseSettings, setComputerUseSettings] = useState(() =>
    loadComputerUseSettingsFromStorage(window.localStorage),
  );
  function handleComputerUseSettingsChange(settings: typeof computerUseSettings) {
    const savedSettings = saveComputerUseSettingsToStorage(window.localStorage, settings);
    setComputerUseSettings(savedSettings);
  }
  const [computerUseLocalVisionSettings, setComputerUseLocalVisionSettings] = useState(() =>
    loadComputerUseLocalVisionSettingsFromStorage(window.localStorage),
  );
  function handleComputerUseLocalVisionSettingsChange(settings: typeof computerUseLocalVisionSettings) {
    const savedSettings = saveComputerUseLocalVisionSettingsToStorage(window.localStorage, settings);
    setComputerUseLocalVisionSettings(savedSettings);
  }
  const providerCatalog = useMemo(
    () =>
      PROVIDER_DEFINITIONS.map((def) => ({
        id: def.id,
        label: def.label,
        defaultBaseUrl: def.defaultBaseUrl,
        apiType: (def.protocol === "anthropic" ? "anthropic-messages" : "openai-compatible") as "openai-compatible" | "anthropic-messages",
        modelListMode: def.modelListMode,
      })),
    [],
  );
  const getProviderCapabilities = useMemo(
    () => (providerId: string) => getAdapter(providerId).capabilities,
    [],
  );
  // Ref always holds the effective workspace for the current/next run.
  // When a scheduled task fires with its own workspace, the ref is updated
  // synchronously so the runtime reads the correct path even before React
  // re-renders. Without this, a scheduled task would silently run in the
  // currently-selected UI workspace instead of its own.
  const workspaceRef = useRef(workspacePath);
  workspaceRef.current = workspacePath;
  const runtimePreferencesRef = useRef(runtimePreferences);
  runtimePreferencesRef.current = runtimePreferences;
  const isAgentMemoryEnabledRef = useRef(isAgentMemoryEnabled);
  isAgentMemoryEnabledRef.current = isAgentMemoryEnabled;
  const disabledBuiltinToolNamesRef = useRef(disabledBuiltinToolNames);
  disabledBuiltinToolNamesRef.current = disabledBuiltinToolNames;
  const mcpConfigRef = useRef<McpServerConfig[]>([]);
  const codexMcpServersRef = useRef<CodexMcpServerSummary[]>([]);
  const mcpToolDescriptorsRef = useRef<ToolDescriptor[]>([]);
  const mcpDiscoveryErrorsRef = useRef<Record<string, string>>({});
  const mcpToolDescriptorCacheRef = useRef<McpToolDescriptorCache>(new Map());
  const mcpToolDescriptorCacheLoadedRef = useRef(false);
  const enabledSkillContextsRef = useRef<EnabledUserSkillContext[]>([]);
  const enabledSkillContextsLoadedRef = useRef(false);
  const enabledSkillContextsLoadRef = useRef<Promise<EnabledUserSkillContext[]> | null>(null);
  const currentWorkspaceMemoryIdRef = useRef(currentWorkspaceMemoryId);
  currentWorkspaceMemoryIdRef.current = currentWorkspaceMemoryId;
  const [pendingBrowserWriteApproval, setPendingBrowserWriteApproval] =
    useState<WorkbenchBrowserWriteApprovalPreview | null>(null);
  const browserWriteApprovalResolversRef = useRef(
    new Map<string, (decision: BrowserWriteApprovalDecision) => void>(),
  );
  const recentToolCallAuditRecordsRef = useRef<ToolCallAuditRecord[]>([]);

  function requestBrowserWriteApproval(
    request: BrowserWriteApprovalRequest,
  ): Promise<BrowserWriteApprovalDecision> {
    for (const resolve of browserWriteApprovalResolversRef.current.values()) {
      resolve("denied");
    }
    browserWriteApprovalResolversRef.current.clear();
    setPendingBrowserWriteApproval({
      approvalId: request.approvalId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      action: request.action,
      previewHash: request.previewHash,
      selector: request.selector,
      byteCount: request.byteCount,
      scriptByteCount: request.scriptByteCount,
    });
    return new Promise((resolve) => {
      browserWriteApprovalResolversRef.current.set(request.approvalId, resolve);
    });
  }

  function handleRuntimeWorkspaceToolActivity(activity: RuntimeWorkspaceToolActivity) {
    if (
      activity.tool !== "files" &&
      activity.tool !== "browser" &&
      activity.tool !== "review" &&
      activity.tool !== "terminal"
    ) {
      return;
    }
    setWorkspaceToolRequest({
      id: `${activity.recordedAt}:${activity.tool}:${activity.sourceToolName}`,
      tool: activity.tool,
      source: activity.sourceToolName,
    });
  }

  function resolveBrowserWriteApproval(approvalId: string, decision: BrowserWriteApprovalDecision) {
    const resolve = browserWriteApprovalResolversRef.current.get(approvalId);
    if (!resolve) return;
    browserWriteApprovalResolversRef.current.delete(approvalId);
    setPendingBrowserWriteApproval((current) => (
      current?.approvalId === approvalId ? null : current
    ));
    resolve(decision);
  }

  function getMcpToolDescriptorCache() {
    if (!mcpToolDescriptorCacheLoadedRef.current) {
      mcpToolDescriptorCacheRef.current = loadMcpToolDescriptorCache(
        typeof window === "undefined" ? undefined : window.localStorage,
      );
      mcpToolDescriptorCacheLoadedRef.current = true;
    }
    return mcpToolDescriptorCacheRef.current;
  }

  const runtime = useMemo(
    () => createJavisRuntime({
      modelSettings,
      getModelConfiguration: () => modelConfigRef.current,
      getWorkspacePath: () => workspaceRef.current,
      getScheduledTasksRepository: () => scheduledTasksRepoRef.current,
      getComputerUseConfig: () => loadComputerUseConfigFromStorage(window.localStorage),
      getAvailableToolDescriptors: () => getEnabledToolDescriptors(
        disabledBuiltinToolNamesRef.current,
        mcpConfigRef.current,
        codexMcpServersRef.current,
        mcpToolDescriptorsRef.current,
        mcpDiscoveryErrorsRef.current,
      ),
      getCapabilityVerification: () => buildRuntimeCapabilityVerification({
        toolAuditRecords: recentToolCallAuditRecordsRef.current,
      }),
      recordToolCallAudit,
      onWorkspaceToolActivity: handleRuntimeWorkspaceToolActivity,
      requestBrowserWriteApproval,
      getRuntimePreferences: () => runtimePreferencesRef.current,
      getEnabledSkillContext: async (request: SkillContextSelectionRequest) => {
        try {
          const contexts = await readEnabledSkillContextsCached();
          return formatEnabledSkillContext(contexts, request);
        } catch (error) {
          logNonFatalError("Failed to read enabled skill contexts", error);
          return "";
        }
      },
      isAgentMemoryEnabled: () => isAgentMemoryEnabledRef.current,
      searchAgentMemory: async (request) => {
        const repository = agentMemoryRepoRef.current;
        if (!repository) return [];
        const memoryScope = runtimePreferencesRef.current.agentMemoryScope;
        if (memoryScope === "off") return [];
        const scopeType = request.scopeType
          ?? (memoryScope === "global_workspace" && !currentWorkspaceMemoryIdRef.current ? "global" : "workspace");
        if (scopeType === "global" && memoryScope !== "global_workspace") return [];
        const scopeId = scopeType === "workspace" ? (request.scopeId ?? currentWorkspaceMemoryIdRef.current) : request.scopeId;
        if (scopeType === "workspace" && !scopeId) return [];
        const rawResults = await repository.searchMemory({
          query: request.query,
          tags: request.tags,
          kind: request.kind as Parameters<typeof repository.searchMemory>[0]["kind"],
          scopeType,
          scopeId,
          limit: request.limit,
        });
        const results = memoryScope === "workspace"
          ? rawResults.filter((result) => result.scopeType === "workspace")
          : rawResults;
        if (results.length > 0) {
          await recordAgentMemoryInjectionAudit({
            repository,
            preferencesRepository: preferencesRepoRef.current,
            taskId: request.taskId ?? "task-unknown",
            workspaceId: currentWorkspaceMemoryIdRef.current || undefined,
            injectionType: "retrieved_memory",
            memoryFactIds: results.map((result) => result.id),
            query: request.query,
            scopeType,
            scopeId,
            promptSection: "memory.search",
            scoreSummary: {
              resultCount: results.length,
              topScore: results[0]?.score,
              scopeCounts: countAgentMemoryScopes(results),
            },
          });
          void repository.getSummary(currentWorkspaceMemoryIdRef.current || undefined, isAgentMemoryEnabledRef.current)
            .then(setAgentMemorySummary)
            .catch((error) => logNonFatalError("Failed to refresh agent memory summary", error));
        }
        return results;
      },
      callMcpTool: async (request) => {
        if ((request.action ?? "callTool") === "callTool") {
          const enabledDescriptors = getEnabledToolDescriptors(
            disabledBuiltinToolNamesRef.current,
            mcpConfigRef.current,
            codexMcpServersRef.current,
            mcpToolDescriptorsRef.current,
            mcpDiscoveryErrorsRef.current,
          );
          if (!isAllowlistedMcpCallToolRequest(enabledDescriptors, request)) {
            throw new Error(`MCP tool ${request.toolName ?? String(request.input?.toolName ?? "")} is not allowlisted for ${request.source ?? "unknown"}:${request.serverName}.`);
          }
        }
        return invoke("call_mcp_server_tool", { request });
      },
      buildAgentMemoryPromptContext: async ({ userGoal, taskId }) => {
        const repository = agentMemoryRepoRef.current;
        if (!repository) return "";
        const memoryScope = runtimePreferencesRef.current.agentMemoryScope;
        if (memoryScope === "off") return "";
        const workspaceId = currentWorkspaceMemoryIdRef.current || undefined;
        const userProfileFacts = (userProfileMemoryRef.current?.facts ?? [])
          .slice(0, 5)
          .map((fact) => fact.text);
        const promptContext = await buildAgentMemoryPromptContextFromRepository({
          repository,
          userGoal,
          taskId,
          memoryScope,
          workspaceId,
          userProfileFacts,
          recordInjection: (injection) => recordAgentMemoryInjectionAudit({
            repository,
            preferencesRepository: preferencesRepoRef.current,
            taskId,
            workspaceId,
            ...injection,
          }),
        });
        void repository.getSummary(workspaceId, isAgentMemoryEnabledRef.current)
          .then(setAgentMemorySummary)
          .catch((error) => logNonFatalError("Failed to refresh agent memory summary", error));
        return promptContext;
      },
    }),
    [modelSettings],
  );
  const [history, setHistory] = useState<TaskSnapshot[]>(() =>
    loadTaskHistory(window.localStorage),
  );
  const [approvalRecords, setApprovalRecords] = useState(() =>
    loadApprovalRecords(window.localStorage),
  );
  const [currentGoal, setCurrentGoal] = useState<GoalState | null>(() =>
    loadCurrentGoal(window.localStorage),
  );
  const [currentGoalEvents, setCurrentGoalEvents] = useState<GoalEvent[]>([]);
  const [currentGoalEvaluations, setCurrentGoalEvaluations] = useState<GoalEvaluation[]>([]);
  const historyCurrentRef = useRef(history);
  historyCurrentRef.current = history;
  const currentGoalRef = useRef<GoalState | null>(currentGoal);
  currentGoalRef.current = currentGoal;
  const currentGoalEventsRef = useRef<GoalEvent[]>(currentGoalEvents);
  currentGoalEventsRef.current = currentGoalEvents;
  const currentGoalEvaluationsRef = useRef<GoalEvaluation[]>(currentGoalEvaluations);
  currentGoalEvaluationsRef.current = currentGoalEvaluations;
  const approvalRecordsInitialRef = useRef(approvalRecords);
  const approvalRecordsCurrentRef = useRef(approvalRecords);
  approvalRecordsCurrentRef.current = approvalRecords;
  const [areDurableApprovalRecordsReady, setDurableApprovalRecordsReady] = useState(false);
  const [isDatabaseInitializing, setDatabaseInitializing] = useState(true);
  const [knowledgeRepositoriesReadyKey, setKnowledgeRepositoriesReadyKey] = useState(0);
  const didCheckRestoredApproval = useRef(false);
  const didInitDatabaseRef = useRef(false);
  const auditRecordIdsRef = useRef(new Set<string>());
  const savedAgentSessionSummaryIdsRef = useRef(new Set<string>());
  const [draftGoal, setDraftGoal] = useState(DEFAULT_DRAFT_GOAL);
  const [composeMode, setComposeMode] = useState<"chat" | "project">(
    DEFAULT_RUNTIME_PREFERENCES.defaultStartupMode === "project" ? "project" : "chat",
  );
  const [aiConfigPrompt, setAiConfigPrompt] = useState<{ title: string; message: string } | null>(null);
  const goalStrategies = useMemo(() => createDefaultGoalStrategies(), []);

  // ── Sidebar view state ───────────────────────────────────────────
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [activeHistoryEntryId, setActiveHistoryEntryId] = useState<string | undefined>();
  const [localePreference, setLocalePreference] = useState<string>("zh-CN");
  async function testModelConnection(settings: typeof modelSettings): Promise<string> {
    if (settings.apiKey.trim()) {
      await updateModelSettings(settings);
      void modelSettingsRepoRef.current?.save(settings);
    }
    const provider = createConfiguredModelProvider(settings);
    try {
      const result = await provider.complete("Hi", {
        maxTokens: 16,
        temperature: 0,
        locale: localePreference,
      });
      const modelLabel = result.model || settings.model;
      return modelLabel ? `API 连通正常：${modelLabel}` : "API 连通正常";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Classify common failures with actionable messages (inspired by openhanako).
      if (message.includes("401") || message.includes("Unauthorized") || message.includes("invalid token")) {
        throw new Error("API Key 无效，请检查密钥是否正确");
      }
      if (message.includes("403") || message.includes("Forbidden")) {
        throw new Error("API 访问被拒，请检查权限或 Base URL");
      }
      if (message.includes("Could not read model API key secret")) {
        throw new Error("未找到 API Key。请在左侧 provider 面板保存密钥，并将模型分配到 Primary 槽位后重试");
      }
      if (message.includes("timed out") || message.includes("Timeout") || message.includes("timeout")) {
        throw new Error("连接超时，无法连接到 API 服务器，请检查网络或 Base URL");
      }
      if (message.includes("refused") || message.includes("Connection refused") || message.includes("dns error") || message.includes("Name or service not known")) {
        throw new Error("无法连接到 API 服务器，请检查 Base URL 是否正确");
      }
      // Re-throw with original message for unrecognized errors
      throw new Error(message);
    }
  }
  const [prefSidebarWidth, setPrefSidebarWidth] = useState<number | undefined>();
  const [prefActivityHeight, setPrefActivityHeight] = useState<number | undefined>();
  const [prefIsSidebarOpen, setPrefIsSidebarOpen] = useState<boolean | undefined>();
  const [prefIsActivityOpen, setPrefIsActivityOpen] = useState<boolean | undefined>();
  const [prefIsInspectorOpen, setPrefIsInspectorOpen] = useState<boolean | undefined>();
  const [systemResources, setSystemResources] = useState<WorkbenchSystemResources | undefined>();
  const [userProfileMemory, setUserProfileMemory] = useState<UserProfileMemory | null>(() =>
    loadUserProfileMemory(window.localStorage),
  );
  const userProfileMemoryRef = useRef(userProfileMemory);
  userProfileMemoryRef.current = userProfileMemory;
  const [agentMemorySummary, setAgentMemorySummary] = useState<WorkbenchAgentMemorySummary | null>(null);
  useEffect(() => {
    return () => {
      if (queuedStartTimerRef.current) {
        clearTimeout(queuedStartTimerRef.current);
        queuedStartTimerRef.current = null;
      }
      if (goalContinuationTimerRef.current) {
        clearTimeout(goalContinuationTimerRef.current);
        goalContinuationTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    if (!currentWindow) {
      return;
    }

    let cancelled = false;

    async function refreshSystemResources() {
      try {
        const snapshot = await invoke<WorkbenchSystemResources>("get_system_resource_snapshot");
        if (!cancelled) {
          setSystemResources(snapshot);
        }
      } catch (error) {
        logNonFatalError("Failed to read system resources", error);
      }
    }

    void refreshSystemResources();
    const intervalId = window.setInterval(refreshSystemResources, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);
  // ── Scheduled tasks state ─────────────────────────────────────────
  const {
    task,
    setTask,
    isTaskActive,
    setIsTaskActive,
    isTaskActiveRef,
    activeScheduledTaskId,
    setActiveScheduledTaskId,
    pendingScheduledTaskIdRef,
    clearQueuedTaskSnapshots,
  } = useTaskRuntime({
    runtime,
    setHistory,
    setActiveHistoryEntryId,
    setScheduledTasks,
    persistWorkspaceForTask,
    persistDurableApprovalRecord,
    createInitialTask: () => createInitialTaskSnapshot({
      capabilityVerification: buildRuntimeCapabilityVerification({
        toolAuditRecords: recentToolCallAuditRecordsRef.current,
      }),
    }),
    onTaskSnapshot: (nextTask) => {
      appendRuntimeJsonlLogs(nextTask);
      handleGoalTaskSnapshot(nextTask);
    },
    taskHistoryRepoRef,
    scheduledTasksRepoRef,
    workspacePathRef: workspaceRef,
  });

  // ── Local knowledge base state ────────────────────────────────────
  const isComputerUseGlobalEmergencyHotkeyActive = isActiveComputerUseTaskSnapshot(task, isTaskActive);

  useEffect(() => {
    if (!currentWindow) {
      return;
    }
    let disposed = false;
    let unlistenEvent: (() => void) | undefined;
    void listen("computer-use://emergency-stop-requested", () => {
      emergencyStopTaskRef.current();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenEvent = unlisten;
      }
    }).catch((error) => {
      logNonFatalError("Failed to listen for Computer Use emergency hotkey", error);
    });
    return () => {
      disposed = true;
      unlistenEvent?.();
    };
  }, []);

  useEffect(() => {
    if (!currentWindow) {
      return;
    }
    void invoke("computer_set_emergency_hotkey_enabled", {
      enabled: isComputerUseGlobalEmergencyHotkeyActive,
    }).catch((error) => {
      logNonFatalError("Failed to update Computer Use emergency hotkey", error);
    });

    return () => {
      if (isComputerUseGlobalEmergencyHotkeyActive) {
        void invoke("computer_set_emergency_hotkey_enabled", { enabled: false }).catch((error) => {
          logNonFatalError("Failed to disable Computer Use emergency hotkey", error);
        });
      }
    };
  }, [isComputerUseGlobalEmergencyHotkeyActive]);

  const [skillEntries, setSkillEntries] = useState<WorkbenchSkillEntry[]>([]);
  const [skillTranslationCache, setSkillTranslationCache] = useState<SkillTranslationCache>({});
  const [skillTranslationStatus, setSkillTranslationStatus] =
    useState<"idle" | "translating" | "error">("idle");
  const [skillTranslationError, setSkillTranslationError] = useState<string | null>(null);
  const [skillSearchStatus, setSkillSearchStatus] =
    useState<"idle" | "searching" | "error">("idle");
  const [skillSearchResults, setSkillSearchResults] = useState<WorkbenchSkillSearchResult[]>([]);
  const [skillMarketSuggestionStatus, setSkillMarketSuggestionStatus] =
    useState<"idle" | "refreshing" | "error">("idle");
  const [skillMarketSuggestions, setSkillMarketSuggestions] = useState<WorkbenchSkillSuggestion[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpServerConfig[]>([]);
  const [mcpConfigError, setMcpConfigError] = useState<string | null>(null);
  const [codexMcpServers, setCodexMcpServers] = useState<CodexMcpServerSummary[]>([]);
  const [mcpToolDescriptors, setMcpToolDescriptors] = useState<ToolDescriptor[]>([]);
  const [mcpDiscoveryErrors, setMcpDiscoveryErrors] = useState<Record<string, string>>({});
  mcpConfigRef.current = mcpConfig;
  codexMcpServersRef.current = codexMcpServers;
  mcpToolDescriptorsRef.current = mcpToolDescriptors;
  mcpDiscoveryErrorsRef.current = mcpDiscoveryErrors;
  const [userSkills, setUserSkills] = useState<UserSkillSummary[]>([]);
  const [trustedComputerApps, setTrustedComputerApps] = useState<TrustedComputerApp[]>(
    () => loadTrustedComputerAppsFromPrefs(loadPendingPreferencesFromLocalStorage()),
  );

  const fileClassificationRepoRef = useRef<FileClassificationRepository | null>(null);
  const appClassificationRepoRef = useRef<AppClassificationRepository | null>(null);
  const resourceScanRootRepoRef = useRef<ResourceScanRootRepository | null>(null);
  const resourceCacheRepoRef = useRef<ResourceCacheRepository | null>(null);
  const modelProfileRepoRef = useRef<ModelProfileRepositoryLike>(null);
  const {
    modelConfiguration,
    setModelConfiguration,
    handleModelConfigurationChange,
  } = useModelProfiles({
    modelProfileRepoRef,
    onSaved: () => runtime.clearProviderCache(),
  });
  modelConfigRef.current = modelConfiguration;

  const {
    installedApps,
    userDocuments,
    userImages,
    computerEntries,
    computerPath,
    appsLoading,
    docsLoading,
    imagesLoading,
    computerLoading,
    appsError,
    docsError,
    imagesError,
    computerError,
    scanProgress,
    appsProgress,
    docsProgress,
    imagesProgress,
    classifying,
    classifyProgress,
    classifyError,
    appsClassifying,
    appsClassifyProgress,
    appsClassifyError,
    mountRoots,
    categoryStats,
    appCategoryStats,
    resourceScanRoots,
    handleRefreshApps,
    handleUpdateAppCategory,
    handleUpdateFileCategory,
    handleRefreshDocuments,
    handleRefreshImages,
    handleNavigateDirectory,
    handleListDirectory,
    handleRefreshScan,
    handleRefreshResourceRoots,
    handleClassifyDocuments: runClassifyDocuments,
    handleClassifyApps: runClassifyApps,
    handleCancelClassify,
    handleCancelClassifyApps,
    handleAddScanRoot,
    handleRemoveScanRoot,
    handleToggleScanRoot,
    handleRefreshScanRoot,
    scanning,
  } = useScannedData({
    activeView,
    runtime,
    repositoriesReadyKey: knowledgeRepositoriesReadyKey,
    appClassificationRepoRef,
    fileClassificationRepoRef,
    resourceScanRootRepoRef,
    resourceCacheRepoRef,
  });

  const {
    toggleScheduledTask,
    deleteScheduledTask,
  } = useScheduledTasks({
    scheduledTasks,
    setScheduledTasks,
    submitGoalRef,
    isTaskActiveRef,
    scheduledTasksRepoRef,
  });
  submitGoalRef.current = submitGoal;
  useEffect(() => {
    setSkillEntries(applySkillTranslationCache(
      buildSkillEntries(mcpConfig, userSkills, codexMcpServers, disabledBuiltinToolNames, mcpDiscoveryErrors),
      skillTranslationCache,
    ));
  }, [codexMcpServers, disabledBuiltinToolNames, mcpConfig, mcpDiscoveryErrors, skillTranslationCache, userSkills]);

  useEffect(() => {
    enabledSkillContextsLoadedRef.current = false;
    void readEnabledSkillContextsCached(true).catch((error) => {
      logNonFatalError("Failed to refresh enabled skill context cache", error);
    });
  }, [userSkills]);

  useEffect(() => {
    let cancelled = false;
    const cache = getMcpToolDescriptorCache();
    const servers = buildMcpRuntimeServers(mcpConfig, codexMcpServers)
      .filter((server) => isExecutableMcpServer(server));
    if (servers.length === 0) {
      if (cache.size > 0) {
        cache.clear();
        saveMcpToolDescriptorCache(
          typeof window === "undefined" ? undefined : window.localStorage,
          cache,
        );
      }
      setMcpToolDescriptors([]);
      setMcpDiscoveryErrors({});
      return () => {
        cancelled = true;
      };
    }

    const activeKeys = new Set(servers.map((server) => mcpRuntimeServerKey(server)));
    const cachedResults: Array<{ key: string; descriptors: ToolDescriptor[] }> = [];
    const serversToDiscover: McpRuntimeServerConfig[] = [];
    for (const server of servers) {
      const key = mcpRuntimeServerKey(server);
      const cachedDescriptors = getFreshCachedMcpToolDescriptors(cache, server);
      if (cachedDescriptors) {
        cachedResults.push({ key, descriptors: cachedDescriptors });
      } else {
        serversToDiscover.push(server);
      }
    }
    pruneMcpToolDescriptorCache(cache, activeKeys);
    setMcpDiscoveryErrors({});
    setMcpToolDescriptors(dedupeToolDescriptors(cachedResults.flatMap((result) => result.descriptors)));
    if (serversToDiscover.length === 0) {
      saveMcpToolDescriptorCache(
        typeof window === "undefined" ? undefined : window.localStorage,
        cache,
      );
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const descriptorResults = await mapWithConcurrency(serversToDiscover, MCP_DISCOVERY_CONCURRENCY, async (server) => {
        const key = mcpRuntimeServerKey(server);
        try {
          const listToolsResult = await invoke<unknown>("call_mcp_server_tool", {
            request: {
              serverName: server.name,
              source: server.source,
              action: "listTools",
              timeoutMs: 5_000,
            },
          });
          const descriptors = buildMcpToolDescriptorsFromList(server, listToolsResult);
          setCachedMcpToolDescriptors(cache, server, descriptors);
          return { key, descriptors };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logNonFatalError(`Failed to discover MCP tools for ${server.source}:${server.name}`, error);
          return { key, descriptors: [] as ToolDescriptor[], error: message };
        }
      });
      if (cancelled) return;
      pruneMcpToolDescriptorCache(cache, activeKeys);
      saveMcpToolDescriptorCache(
        typeof window === "undefined" ? undefined : window.localStorage,
        cache,
      );
      const nextDiscoveryErrors: Record<string, string> = {};
      for (const result of descriptorResults) {
        if (result.error) {
          nextDiscoveryErrors[result.key] = `tools/list 失败：${result.error}`;
        }
      }
      setMcpDiscoveryErrors(nextDiscoveryErrors);
      setMcpToolDescriptors(dedupeToolDescriptors([
        ...cachedResults.flatMap((result) => result.descriptors),
        ...descriptorResults.flatMap((result) => result.descriptors),
      ]));
    })();

    return () => {
      cancelled = true;
    };
  }, [codexMcpServers, mcpConfig]);

  useEffect(() => {
    setSkillSearchResults((current) =>
      current.map((result) => ({
        ...result,
        installed: isSkillSearchResultInstalled(
          result.url,
          result.title,
          result.kind,
          userSkills,
          mcpConfig,
          codexMcpServers,
        ),
      })),
    );
  }, [codexMcpServers, mcpConfig, userSkills]);

  function showAiConfigRequired(feature: string) {
    setAiConfigPrompt({
      title: "需要先配置 AI",
      message: `${feature} 需要可用的 AI 模型。请先在左侧底部“设置 > AI 模式”里添加模型并保存密钥。`,
    });
  }

  function ensureAiConfigured(feature: string): boolean {
    if (hasUsableAiConfiguration(modelConfigRef.current, modelSettings)) {
      return true;
    }
    showAiConfigRequired(feature);
    return false;
  }

  async function handleClassifyDocuments() {
    if (!ensureAiConfigured("文档和图片的智能分类/检索")) {
      return;
    }
    await runClassifyDocuments();
  }

  async function handleClassifyApps() {
    if (!ensureAiConfigured("apps AI classification")) {
      return;
    }
    await runClassifyApps();
  }

  async function handleTranslateSkillsToChinese() {
    if (skillTranslationStatus === "translating") {
      return;
    }
    setSkillTranslationStatus("translating");
    setSkillTranslationError(null);
    try {
      const sourceSkills = buildSkillEntries(mcpConfig, userSkills, codexMcpServers, disabledBuiltinToolNames, mcpDiscoveryErrors);
      const missingSkills = sourceSkills.filter((skill) => {
        const cached = skillTranslationCache[skill.id];
        return !cached || cached.sourceSignature !== getSkillTranslationSourceSignature(skill);
      });
      if (missingSkills.length === 0) {
        setSkillEntries(applySkillTranslationCache(sourceSkills, skillTranslationCache));
        setSkillTranslationStatus("idle");
        return;
      }
      const translated = await runtime.translateSkillsToChinese(
        missingSkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          agentOwners: skill.agentOwners,
        })),
      );
      const sourceById = new Map(sourceSkills.map((skill) => [skill.id, skill]));
      const nextCache: SkillTranslationCache = { ...skillTranslationCache };
      for (const skill of translated) {
        const sourceSkill = sourceById.get(skill.id);
        nextCache[skill.id] = {
          name: skill.name,
          description: skill.description,
          agentOwners: skill.agentOwners,
          sourceSignature: sourceSkill ? getSkillTranslationSourceSignature(sourceSkill) : undefined,
        };
      }
      setSkillTranslationCache(nextCache);
      setSkillEntries(applySkillTranslationCache(sourceSkills, nextCache));
      persistPreference(PREF_KEYS.SKILL_TRANSLATIONS_ZH, JSON.stringify(nextCache));
      setSkillTranslationStatus("idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logNonFatalError("Failed to translate skills to Chinese", error);
      setSkillTranslationStatus("error");
      setSkillTranslationError(message);
    }
  }

  // ── Build sidebar nav items from built-in defaults + workspace defs ─
  async function handleSearchSkillMarket(
    query: string,
    source: WorkbenchSkillSearchSource,
    kind: WorkbenchSkillSearchKind,
  ) {
    const trimmed = query.trim();
    if (!trimmed || skillSearchStatus === "searching") {
      return;
    }
    setSkillSearchStatus("searching");
    try {
      const searchQuery = [
        trimmed,
        kind === "mcp"
          ? "\"MCP server\" modelcontextprotocol filename:package.json"
          : "\"SKILL.md\" filename:SKILL.md \"Codex skill\"",
        source === "github" ? "site:github.com" : "",
      ].filter(Boolean).join(" ");
      const results = await invoke<Array<{
        url: string;
        title?: string;
        excerpt: string;
        provider?: string;
      }>>("search_web_sources", {
        request: {
          query: searchQuery,
          maxResults: 8,
          searchType: source === "github" ? "code" : "auto",
        },
      });
      setSkillSearchResults(results
        .filter((result) => isSupportedSkillMarketUrl(result.url, kind))
        .map((result, index) => ({
          id: `${result.url}-${index}`,
          title: result.title?.trim() || result.url,
          description: result.excerpt,
          url: result.url,
          source: result.provider || source,
          kind,
          installed: isSkillSearchResultInstalled(result.url, result.title, kind, userSkills, mcpConfig, codexMcpServers),
        })));
      setSkillSearchStatus("idle");
    } catch (error) {
      logNonFatalError("Failed to search skill market", error);
      setSkillSearchStatus("error");
    }
  }

  async function handleRefreshSkillMarketSuggestions(
    source: WorkbenchSkillSearchSource,
    kind: WorkbenchSkillSearchKind,
  ) {
    if (skillMarketSuggestionStatus === "refreshing") {
      return;
    }
    setSkillMarketSuggestionStatus("refreshing");
    try {
      const keywords = buildSkillMarketSuggestionKeywords(userProfileMemorySummary, agentMemorySummary);
      const queries = buildSkillMarketSuggestionQueries(kind);
      const results: SearchWebSourceResult[] = [];
      const seenUrls = new Set<string>();
      let lastError: unknown = null;

      for (const searchQuery of queries) {
        try {
          const queryResults = await invoke<SearchWebSourceResult[]>("search_web_sources", {
            request: {
              query: searchQuery,
              maxResults: SKILL_MARKET_SUGGESTION_LIMIT,
              searchType: source === "github" ? "code" : "auto",
            },
          });
          for (const result of queryResults) {
            if (!isSupportedSkillMarketUrl(result.url, kind) || seenUrls.has(result.url)) {
              continue;
            }
            seenUrls.add(result.url);
            results.push(result);
            if (results.length >= SKILL_MARKET_SUGGESTION_LIMIT) {
              break;
            }
          }
        } catch (error) {
          lastError = error;
        }
        if (results.length >= SKILL_MARKET_SUGGESTION_LIMIT) {
          break;
        }
      }

      if (results.length === 0) {
        if (lastError) {
          logNonFatalError("Failed to refresh skill market suggestions", lastError);
        }
        setSkillMarketSuggestionStatus("error");
        return;
      }

      setSkillMarketSuggestions(rankSkillMarketSuggestionResults(results, keywords)
        .slice(0, SKILL_MARKET_SUGGESTION_LIMIT)
        .map((result) => ({
          title: normalizeSkillSuggestionTitle(result.title, result.url),
          description: buildSkillSuggestionDescription(
            result.excerpt,
            getSkillSuggestionMatchedKeywords(result, keywords),
          ),
          url: result.url,
          source: result.provider || source,
        })));
      setSkillMarketSuggestionStatus("idle");
    } catch (error) {
      logNonFatalError("Failed to refresh skill market suggestions", error);
      setSkillMarketSuggestionStatus("error");
    }
  }

  function updateSkillSearchResult(id: string, patch: Partial<WorkbenchSkillSearchResult>) {
    setSkillSearchResults((current) =>
      current.map((result) => result.id === id ? { ...result, ...patch } : result),
    );
  }

  async function refreshUserSkills() {
    const skills = await invoke<UserSkillSummary[]>("scan_user_skills");
    invalidateEnabledSkillContextCache();
    setUserSkills(skills);
    return skills;
  }

  function invalidateEnabledSkillContextCache() {
    enabledSkillContextsLoadedRef.current = false;
    enabledSkillContextsLoadRef.current = null;
  }

  async function readEnabledSkillContextsCached(forceRefresh = false): Promise<EnabledUserSkillContext[]> {
    if (!forceRefresh && enabledSkillContextsLoadedRef.current) {
      return enabledSkillContextsRef.current;
    }
    if (!forceRefresh && enabledSkillContextsLoadRef.current) {
      return enabledSkillContextsLoadRef.current;
    }
    const loadPromise = invoke<EnabledUserSkillContext[]>("read_enabled_user_skill_contexts")
      .then((contexts) => {
        if (enabledSkillContextsLoadRef.current === loadPromise) {
          enabledSkillContextsRef.current = contexts;
          enabledSkillContextsLoadedRef.current = true;
        }
        return contexts;
      })
      .finally(() => {
        if (enabledSkillContextsLoadRef.current === loadPromise) {
          enabledSkillContextsLoadRef.current = null;
        }
      });
    enabledSkillContextsLoadRef.current = loadPromise;
    return loadPromise;
  }

  async function refreshCodexMcpServers() {
    const servers = await invoke<CodexMcpServerSummary[]>("scan_codex_mcp_servers");
    setCodexMcpServers(servers);
    return servers;
  }

  async function setCodexMcpEnabledOnDisk(serverName: string, enabled: boolean, source?: string) {
    const servers = await invoke<CodexMcpServerSummary[]>("set_codex_mcp_server_enabled", {
      name: serverName,
      source,
      enabled,
    });
    setCodexMcpServers(servers);
    return servers;
  }

  async function handleInstallSkillMarketResult(result: WorkbenchSkillSearchResult) {
    if (result.installing || result.installed) {
      return;
    }
    updateSkillSearchResult(result.id, { installing: true, installError: undefined });
    try {
      if (result.kind === "skill") {
        const installed = await invoke<UserSkillSummary>("install_user_skill_from_github", {
          request: {
            url: result.url,
            title: result.title,
            description: result.description,
          },
        });
        invalidateEnabledSkillContextCache();
        setUserSkills((current) => {
          const next = current.filter((skill) => skill.id !== installed.id);
          return [...next, installed].sort((a, b) =>
            a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
          );
        });
      } else {
        const installed = await invoke<InstalledMcpServerSummary>("install_mcp_server_from_github", {
          request: {
            url: result.url,
            title: result.title,
          },
        });
        const servers = await refreshCodexMcpServers();
        const installedServer = servers.find((server) =>
          server.source === "codex" && server.name === installed.name
        );
        if (installedServer && isExecutableMcpServer(installedServer)) {
          try {
            const listToolsResult = await invoke<unknown>("call_mcp_server_tool", {
              request: {
                serverName: installedServer.name,
                source: installedServer.source,
                action: "listTools",
                timeoutMs: 5_000,
              },
            });
            const descriptors = buildMcpToolDescriptorsFromList(installedServer, listToolsResult);
            const cache = getMcpToolDescriptorCache();
            setCachedMcpToolDescriptors(cache, installedServer, descriptors);
            saveMcpToolDescriptorCache(
              typeof window === "undefined" ? undefined : window.localStorage,
              cache,
            );
            setMcpDiscoveryErrors((current) => {
              const next = { ...current };
              delete next[mcpRuntimeServerKey(installedServer)];
              return next;
            });
            setMcpToolDescriptors((current) =>
              dedupeToolDescriptors([
                ...current.filter((descriptor) =>
                  getMcpDescriptorServerKey(descriptor) !== mcpRuntimeServerKey(installedServer)
                ),
                ...descriptors,
              ])
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const installError = `MCP installed, but tools/list failed and the server was disabled until fixed: ${message}`;
            await setCodexMcpEnabledOnDisk(
              installedServer.name,
              false,
              installedServer.source,
            ).catch((disableError) =>
              logNonFatalError("Failed to disable MCP server after install discovery error", disableError)
            );
            setMcpDiscoveryErrors((current) => ({
              ...current,
              [mcpRuntimeServerKey(installedServer)]: installError,
            }));
            updateSkillSearchResult(result.id, {
              installing: false,
              installed: true,
              installError,
            });
            return;
          }
        }
      }
      updateSkillSearchResult(result.id, { installing: false, installed: true, installError: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logNonFatalError("Failed to install skill market result", error);
      updateSkillSearchResult(result.id, {
        installing: false,
        installed: false,
        installError: message,
      });
    }
  }

  async function handleToggleSkillEnabled(id: string, enabled: boolean) {
    if (isBuiltinToolToggleable(id)) {
      setDisabledBuiltinToolNames((current) => {
        const next = new Set(current);
        if (enabled) {
          next.delete(id);
        } else {
          next.add(id);
        }
        persistPreference(BUILTIN_TOOL_DISABLED_NAMES_PREFERENCE_KEY, serializeDisabledBuiltinToolNames(next));
        return next;
      });
      return;
    }
    if (id.startsWith("codex-mcp-")) {
      const parsed = parseCodexMcpSkillEntryId(id);
      if (!parsed) return;
      try {
        await setCodexMcpEnabledOnDisk(parsed.name, enabled, parsed.source);
      } catch (error) {
        logNonFatalError("Failed to save Codex MCP enabled state", error);
        await refreshCodexMcpServers().catch((refreshError) =>
          logNonFatalError("Failed to refresh Codex MCP servers after toggle error", refreshError),
        );
      }
      return;
    }
    if (id.startsWith("mcp-")) {
      const serverName = id.slice("mcp-".length);
      const nextConfig = mcpConfig.map((server) =>
        server.name === serverName ? { ...server, enabled } : server,
      );
      setMcpConfig(nextConfig);
      try {
        await saveMcpConfig(nextConfig);
        setMcpConfigError(null);
      } catch (error) {
        logNonFatalError("Failed to save MCP config", error);
        setMcpConfig(mcpConfig);
        setMcpConfigError(String(error));
      }
      return;
    }
    if (id.startsWith("skill-")) {
      const skillId = id.slice("skill-".length);
      try {
        const updated = await invoke<UserSkillSummary>("set_user_skill_enabled", { id: skillId, enabled });
        invalidateEnabledSkillContextCache();
        setUserSkills((current) => {
          const next = current.filter((skill) => skill.id !== updated.id);
          return [...next, updated].sort((a, b) =>
            a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
          );
        });
      } catch (error) {
        logNonFatalError("Failed to toggle user skill", error);
        await refreshUserSkills().catch((refreshError) =>
          logNonFatalError("Failed to refresh user skills after toggle error", refreshError),
        );
      }
    }
  }

  async function handleDeleteSkill(id: string) {
    if (!window.confirm("确定删除这个用户添加的技能或 MCP 吗？")) {
      return;
    }
    if (id.startsWith("skill-")) {
      const skillId = id.slice("skill-".length);
      try {
        await invoke("delete_user_skill", { id: skillId });
        const skills = await refreshUserSkills();
        const removedSkill = userSkills.find((skill) => skill.id === skillId);
        if (removedSkill) {
          setSkillSearchResults((current) =>
            current.map((result) =>
              result.title === removedSkill.name && result.kind === "skill"
                ? { ...result, installed: skills.some((skill) => skill.name === removedSkill.name) }
                : result,
            ),
          );
        }
      } catch (error) {
        logNonFatalError("Failed to delete user skill", error);
      }
      return;
    }
    if (id.startsWith("mcp-")) {
      const serverName = id.slice("mcp-".length);
      const nextConfig = mcpConfig.filter((server) => server.name !== serverName);
      setMcpConfig(nextConfig);
      try {
        await saveMcpConfig(nextConfig);
        setMcpConfigError(null);
      } catch (error) {
        logNonFatalError("Failed to delete MCP config", error);
        setMcpConfig(mcpConfig);
        setMcpConfigError(String(error));
      }
      return;
    }
    if (id.startsWith("codex-mcp-")) {
      const parsed = parseCodexMcpSkillEntryId(id);
      if (!parsed) return;
      const server = codexMcpServers.find((item) =>
        item.name === parsed.name && item.source === parsed.source
      );
      try {
        if (server?.removable) {
          const servers = await invoke<CodexMcpServerSummary[]>("delete_codex_mcp_server", {
            name: parsed.name,
            source: parsed.source,
          });
          setCodexMcpServers(servers);
        } else {
          await setCodexMcpEnabledOnDisk(parsed.name, false, parsed.source);
        }
      } catch (error) {
        logNonFatalError("Failed to delete or disable Codex MCP config", error);
        await refreshCodexMcpServers().catch((refreshError) =>
          logNonFatalError("Failed to refresh Codex MCP servers after delete error", refreshError),
        );
      }
    }
  }

  async function handleDisableAllSkills() {
    setDisabledBuiltinToolNames(() => {
      const next = new Set(
        initialToolDescriptors
          .filter((descriptor) => isBuiltinToolToggleable(descriptor.name))
          .map((descriptor) => descriptor.name),
      );
      persistPreference(BUILTIN_TOOL_DISABLED_NAMES_PREFERENCE_KEY, serializeDisabledBuiltinToolNames(next));
      return next;
    });

    for (const skill of userSkills.filter((item) => item.enabled)) {
      try {
        await invoke("set_user_skill_enabled", { id: skill.id, enabled: false });
      } catch (error) {
        logNonFatalError(`Failed to disable user skill ${skill.id}`, error);
      }
    }
    await refreshUserSkills().catch((error) =>
      logNonFatalError("Failed to refresh user skills after disabling", error),
    );

    for (const server of codexMcpServers.filter((item) => item.enabled)) {
      try {
        await setCodexMcpEnabledOnDisk(server.name, false, server.source);
      } catch (error) {
        logNonFatalError(`Failed to disable Codex MCP ${server.name}`, error);
        await refreshCodexMcpServers().catch((refreshError) =>
          logNonFatalError("Failed to refresh Codex MCP servers after bulk disable error", refreshError),
        );
      }
    }

    const nextMcpConfig = mcpConfig.map((server) => ({ ...server, enabled: false }));
    setMcpConfig(nextMcpConfig);
    try {
      await saveMcpConfig(nextMcpConfig);
      setMcpConfigError(null);
    } catch (error) {
      logNonFatalError("Failed to disable all MCP config", error);
      setMcpConfig(mcpConfig);
      setMcpConfigError(String(error));
    }
  }

  async function handleDeleteAllSkills() {
    if (!window.confirm("确定删除所有用户添加的 Skill、Javis MCP 和 Javis 安装的 Codex MCP 吗？手动配置的 Codex MCP 会保留但关闭。")) {
      return;
    }

    const deleteSkillPromises = userSkills.filter((skill) => skill.removable).map((skill) =>
      invoke("delete_user_skill", { id: skill.id }).catch((error) => {
        logNonFatalError(`Failed to delete user skill ${skill.id}`, error);
      }),
    );
    await Promise.all(deleteSkillPromises);
    await refreshUserSkills().catch((error) => logNonFatalError("Failed to refresh user skills", error));

    setMcpConfig([]);
    try {
      await saveMcpConfig([]);
      setMcpConfigError(null);
    } catch (error) {
      logNonFatalError("Failed to delete all MCP config", error);
      setMcpConfig(mcpConfig);
      setMcpConfigError(String(error));
    }

    for (const server of codexMcpServers) {
      try {
        if (server.removable) {
          const servers = await invoke<CodexMcpServerSummary[]>("delete_codex_mcp_server", {
            name: server.name,
            source: server.source,
          });
          setCodexMcpServers(servers);
        } else {
          await setCodexMcpEnabledOnDisk(server.name, false, server.source);
        }
      } catch (error) {
        logNonFatalError(`Failed to delete or disable Codex MCP ${server.name}`, error);
        await refreshCodexMcpServers().catch((refreshError) =>
          logNonFatalError("Failed to refresh Codex MCP servers after bulk delete error", refreshError),
        );
      }
    }
  }

  const sidebarNavItems = useMemo(() => {
    const labels =
      localePreference === "en" ? defaultWorkbenchLocale.labels : zhCNWorkbenchLocale.labels;
    const builtin = getBuiltinSidebarNavItems(
      labels,
      scheduledTasks.filter((t) => t.enabled).length,
      skillEntries.length,
    );
    return mergeSidebarNavItems(builtin, buildWorkspaceNavItems(workspaceDefs));
  }, [workspaceDefs, scheduledTasks, skillEntries, localePreference]);

  // ── Load MCP config on mount ──────────────────────────────────────
  useEffect(() => {
    loadMcpConfig()
      .then((config) => {
        setMcpConfig(config);
        setMcpConfigError(null);
      })
      .catch((error) => {
        logNonFatalError("Failed to load MCP config", error);
        setMcpConfigError(String(error));
      });
  }, []);

  useEffect(() => {
    invoke<UserSkillSummary[]>("scan_user_skills")
      .then((skills) => {
        invalidateEnabledSkillContextCache();
        setUserSkills(skills);
      })
      .catch((error) => {
        logNonFatalError("Failed to scan user skills", error);
      });
  }, []);

  useEffect(() => {
    invoke<CodexMcpServerSummary[]>("scan_codex_mcp_servers")
      .then((servers) => {
        setCodexMcpServers(servers);
      })
      .catch((error) => {
        logNonFatalError("Failed to scan Codex MCP servers", error);
      });
  }, []);

  // ── Initialize SQLite database ────────────────────────────────────
  useEffect(() => {
    if (didInitDatabaseRef.current) {
      return;
    }
    didInitDatabaseRef.current = true;

    void (async () => {
      setDatabaseInitializing(true);
      const database = invokeDesktopDatabase(invoke);
      databaseRef.current = database;

      // Run all schema migrations
      await runDesktopDatabaseMigrations(database, TASK_HISTORY_SCHEMA_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, RECENT_WORKSPACES_SCHEMA_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, WORKSPACE_SETTINGS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, MODEL_SETTINGS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, MODEL_PROFILES_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, APPROVAL_RECORDS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, TOOL_CALL_AUDIT_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, SCHEDULED_TASKS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, USER_PREFERENCES_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, JSONL_LOG_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, FILE_CLASSIFICATION_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, APP_CLASSIFICATION_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, [RESOURCE_SCAN_ROOTS_MIGRATION]);
      await runDesktopDatabaseMigrations(database, [RESOURCE_FILE_CACHE_MIGRATION, RESOURCE_FILE_CACHE_INDEX_MIGRATION]);
      await runDesktopDatabaseMigrations(database, USER_PROFILE_MEMORY_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, VECTOR_INDEX_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, AGENT_MEMORY_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, CURRENT_GOAL_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, GOAL_EVENT_MIGRATIONS);

      // One-time import from localStorage
      const taskHistoryRepo = createTaskHistoryRepository(database);
      const workspaceSessionRepo = createWorkspaceSessionRepository(database);
      const approvalRecordsRepo = createApprovalRecordsRepository(database);
      const modelSettingsRepo = createModelSettingsRepository(database);
      const modelProfileRepo = createModelProfileRepository(database);
      const userProfileMemoryRepo = createUserProfileMemoryRepository(database);
      const vectorIndexRepo = createVectorIndexRepository(database);
      const agentMemoryEmbeddingProvider = {
        get dimensions() {
          return runtimePreferencesRef.current.agentMemoryEmbeddingDimensions;
        },
        embedTexts: async (texts: string[]) => {
          const preferences = runtimePreferencesRef.current;
          const provider = createAgentMemoryEmbeddingProvider(
            preferences.agentMemoryEmbeddingMode === "openai_compatible"
              ? {
                  kind: "openai-compatible",
                  provider: preferences.agentMemoryEmbeddingProvider,
                  model: preferences.agentMemoryEmbeddingModel,
                  baseUrl: preferences.agentMemoryEmbeddingBaseUrl,
                  apiKeyReference: preferences.agentMemoryEmbeddingApiKeyReference,
                  dimensions: preferences.agentMemoryEmbeddingDimensions,
                }
              : {
                  kind: "local",
                  dimensions: preferences.agentMemoryEmbeddingDimensions,
                },
            {
              embedOpenAiCompatible: (request) =>
                invoke<number[][]>("embed_model_texts", { request }),
            },
          );
          return provider.embedTexts(texts);
        },
      };
      const agentMemoryRepo = createAgentMemoryRepository(database, {
        vectorIndex: vectorIndexRepo,
        embeddingProvider: agentMemoryEmbeddingProvider,
      });
      try {
        await agentMemoryRepo.backfillVectorIndex({ limit: 500 });
      } catch (error) {
        console.warn("Agent memory vector backfill failed during startup", error);
      }
      const currentGoalRepo = createCurrentGoalRepository(database);
      const goalTimelineRepo = createGoalTimelineRepository(database);

      taskHistoryRepoRef.current = taskHistoryRepo;
      workspaceSessionRepoRef.current = workspaceSessionRepo;
      approvalRecordsRepoRef.current = approvalRecordsRepo;
      modelSettingsRepoRef.current = modelSettingsRepo;
      modelProfileRepoRef.current = modelProfileRepo;
      userProfileMemoryRepoRef.current = userProfileMemoryRepo;
      agentMemoryRepoRef.current = agentMemoryRepo;
      currentGoalRepoRef.current = currentGoalRepo;
      goalTimelineRepoRef.current = goalTimelineRepo;

      // Load saved model configuration so chat/commands work on first launch
      try {
        const savedConfig = await modelProfileRepo.load();
        if (savedConfig.profiles.length > 0) {
          const uiConfig = {
            profiles: savedConfig.profiles.map((p) => ({ ...p, apiKey: "", hasStoredApiKey: true })),
            agentOverrides: savedConfig.agentOverrides,
          };
          setModelConfiguration(uiConfig as WorkbenchModelConfiguration);
          modelConfigRef.current = uiConfig as WorkbenchModelConfiguration;
          runtime.clearProviderCache();
        }
      } catch (error) {
        console.error("Failed to load model configuration:", error);
      }

      const scheduledTasksRepo = createScheduledTasksRepository(database);
      scheduledTasksRepoRef.current = scheduledTasksRepo;

      const preferencesRepo = createUserPreferencesRepository(database);
      preferencesRepoRef.current = preferencesRepo;

      const fileClassificationRepo = createFileClassificationRepository(database);
      fileClassificationRepoRef.current = fileClassificationRepo;

      const appClassificationRepo = createAppClassificationRepository(database);
      appClassificationRepoRef.current = appClassificationRepo;

      const resourceScanRootRepo = createResourceScanRootRepository(database);
      resourceScanRootRepoRef.current = resourceScanRootRepo;

      const resourceCacheRepo = createResourceCacheRepository(database);
      resourceCacheRepoRef.current = resourceCacheRepo;
      setKnowledgeRepositoriesReadyKey((value) => value + 1);

      const importedHistory = await taskHistoryRepo.importFromLocalStorage(window.localStorage);
      const importedWorkspaceSession = await workspaceSessionRepo.importFromLocalStorage(
        window.localStorage,
      );
      const importedApprovalRecords = await approvalRecordsRepo.importFromLocalStorage(
        window.localStorage,
      );
      const legacySettings = await modelSettingsRepo.importFromLocalStorage(window.localStorage);
      const importedUserProfileMemory = await userProfileMemoryRepo.importFromLocalStorage(window.localStorage);
      let importedCurrentGoal = await currentGoalRepo.importFromLocalStorage(window.localStorage);
      currentGoalRef.current = importedCurrentGoal;
      setCurrentGoal(importedCurrentGoal);
      if (importedCurrentGoal) {
        let [events, evaluations] = await Promise.all([
          goalTimelineRepo.listEvents(importedCurrentGoal.id),
          goalTimelineRepo.listEvaluations(importedCurrentGoal.id),
        ]);
        const latestEvaluation = findGoalEvaluation(importedCurrentGoal, evaluations);
        if (latestEvaluation) {
          const reconciliation = reconcileGoalWithPersistedEvaluation(
            importedCurrentGoal,
            latestEvaluation,
          );
          if (reconciliation.events.length > 0 && reconciliation.goal) {
            const reconciledGoal = await currentGoalRepo.save(reconciliation.goal);
            if (reconciledGoal) {
              importedCurrentGoal = reconciledGoal;
              currentGoalRef.current = importedCurrentGoal;
              setCurrentGoal(importedCurrentGoal);
              for (const event of reconciliation.events) {
                const savedEvent = await goalTimelineRepo.appendEvent(event);
                if (savedEvent) {
                  events = [...events.filter((item) => item.id !== savedEvent.id), savedEvent];
                }
              }
            }
          }
        }
        currentGoalEventsRef.current = events;
        currentGoalEvaluationsRef.current = evaluations;
        setCurrentGoalEvents(events);
        setCurrentGoalEvaluations(evaluations);
        evaluatedGoalTaskIdsRef.current = new Set(evaluations.map((evaluation) => evaluation.taskId));
      } else {
        currentGoalEventsRef.current = [];
        currentGoalEvaluationsRef.current = [];
        setCurrentGoalEvents([]);
        setCurrentGoalEvaluations([]);
        evaluatedGoalTaskIdsRef.current.clear();
      }
      const loadedConfig = normalizeModelConfigurationConnections(
        await modelProfileRepo.importFromLegacySettings(legacySettings),
        PROVIDER_DEFINITIONS,
      );
      const cleanOverrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(loadedConfig.agentOverrides)) {
        if (value) cleanOverrides[key] = value;
      }
      await modelProfileRepo.save(loadedConfig.profiles, cleanOverrides);
      // Check which profiles have stored API keys in the OS credential store
      const profilesWithKeyStatus = await Promise.all(
        loadedConfig.profiles.map(async (p) => {
          try {
            const status = await invoke<{ exists: boolean }>("check_model_api_key_secret", {
              keyReference: p.apiKeyReference,
            });
            return { ...p, apiKey: "", hasStoredApiKey: status.exists };
          } catch {
            return { ...p, apiKey: "", hasStoredApiKey: false };
          }
        }),
      );
      setModelConfiguration({
        profiles: profilesWithKeyStatus,
        agentOverrides: cleanOverrides,
      });

      // Always apply imported history on first database init —
      // localStorage snapshot is a placeholder; SQLite is authoritative.
      setHistory(importedHistory);
      replaceWorkspaceSession(importedWorkspaceSession);
      setUserProfileMemory(importedUserProfileMemory);
      if (approvalRecordsCurrentRef.current === approvalRecordsInitialRef.current) {
        setApprovalRecords(importedApprovalRecords);
      }
      const importedScheduledTasks = await scheduledTasksRepo.importFromLocalStorage(window.localStorage);
      if (scheduledTasksCurrentRef.current === scheduledTasksInitialRef.current) {
        setScheduledTasks(clearStaleGuards(importedScheduledTasks));
      }

      // Import user preferences from localStorage
      let importedPrefs = await preferencesRepo.importFromLocalStorage(window.localStorage);
      const pendingPrefs = loadPendingPreferencesFromLocalStorage();
      if (Object.keys(pendingPrefs).length > 0) {
        for (const [key, value] of Object.entries(pendingPrefs)) {
          await preferencesRepo.set(key, value);
        }
        importedPrefs = { ...importedPrefs, ...pendingPrefs };
        removePendingPreferencesFromLocalStorage();
      }
      setTrustedComputerApps(loadTrustedComputerAppsFromPrefs(importedPrefs));
      if (importedPrefs[PREF_KEYS.LOCALE]) setLocalePreference(importedPrefs[PREF_KEYS.LOCALE]);
      if (importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]) setPrefSidebarWidth(Number(importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]));
      if (importedPrefs[PREF_KEYS.ACTIVITY_HEIGHT]) setPrefActivityHeight(Number(importedPrefs[PREF_KEYS.ACTIVITY_HEIGHT]));
      if (importedPrefs[PREF_KEYS.IS_SIDEBAR_OPEN]) setPrefIsSidebarOpen(importedPrefs[PREF_KEYS.IS_SIDEBAR_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN]) setPrefIsActivityOpen(importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN]) setPrefIsInspectorOpen(importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN] === "true");
      const loadedRuntimePreferences = runtimePreferencesFromPrefs(
        importedPrefs,
        importedPrefs[AGENT_MEMORY_ENABLED_PREFERENCE_KEY],
      );
      setRuntimePreferences(loadedRuntimePreferences);
      setAgentMemoryEnabled(loadedRuntimePreferences.agentMemoryScope !== "off");
      setComposeMode(composeModeForStartupPreference(
        loadedRuntimePreferences.defaultStartupMode,
        importedWorkspaceSession.workspacePath,
      ));
      if (
        loadedRuntimePreferences.agentMemoryScope !== "off" &&
        importedPrefs[AGENT_MEMORY_HISTORY_RESTORE_DONE_PREFERENCE_KEY] !== "true"
      ) {
        await restoreAgentMemoryFromTaskHistory({
          repository: agentMemoryRepo,
          history: importedHistory,
          workspacePath: importedWorkspaceSession.workspacePath,
          enabled: true,
        });
        await preferencesRepo.set(AGENT_MEMORY_HISTORY_RESTORE_DONE_PREFERENCE_KEY, "true");
        importedPrefs = {
          ...importedPrefs,
          [AGENT_MEMORY_HISTORY_RESTORE_DONE_PREFERENCE_KEY]: "true",
        };
      }
      if (loadedRuntimePreferences.agentMemoryScope !== "off") {
        const workspaceMemoryId = createCanonicalWorkspaceId(importedWorkspaceSession.workspacePath);
        setAgentMemorySummary(
          await agentMemoryRepo.getSummary(workspaceMemoryId || undefined, true),
        );
      }
      if (importedPrefs[PREF_KEYS.SKILL_TRANSLATIONS_ZH]) {
        setSkillTranslationCache(parseSkillTranslationCache(importedPrefs[PREF_KEYS.SKILL_TRANSLATIONS_ZH]));
      }
      setDisabledBuiltinToolNames(parseDisabledBuiltinToolNames(importedPrefs[BUILTIN_TOOL_DISABLED_NAMES_PREFERENCE_KEY] ?? null));
      if (importedPrefs[PREF_KEYS.ACTIVE_VIEW]) {
        const validViews: ActiveView[] = ["chat", "automated", "skills", "apps", "documents", "gallery", "computer"];
        if (validViews.includes(importedPrefs[PREF_KEYS.ACTIVE_VIEW] as ActiveView)) {
          setActiveView(importedPrefs[PREF_KEYS.ACTIVE_VIEW] as ActiveView);
        }
      }

      // Import JSONL logs from localStorage into SQLite
      await importTaskSessionJsonlFromLocalStorage(database, window.localStorage);
      await importToolCallAuditJsonlFromLocalStorage(database, window.localStorage);
      recentToolCallAuditRecordsRef.current = await listRecentToolCallAuditRecords(database, 200);
      setTask((current) => current.id === "task-idle"
        ? createInitialTaskSnapshot({
            capabilityVerification: buildRuntimeCapabilityVerification({
              toolAuditRecords: recentToolCallAuditRecordsRef.current,
            }),
          })
        : current);

      // Load workspace definitions from disk
      try {
        const defs = await loadWorkspaceDefinitions();
        setWorkspaceDefs(defs);
        registerWorkspaceAgents(defs, agentRegistryRef.current);
        registerWorkspaceWorkflows(defs, workflowRegistryRef.current);
        registerWorkspaceRoutes(defs, routeRegistryRef.current);
      } catch (error) {
        logNonFatalError("Failed to load workspace definitions", error);
      }

      setDurableApprovalRecordsReady(true);
    })().catch((error) => {
      console.error("Database initialization failed, using localStorage fallback", error);
      setDurableApprovalRecordsReady(true);
    }).finally(() => {
      setDatabaseInitializing(false);
    });
  }, [replaceWorkspaceSession]);

  useEffect(() => {
    if (!areDurableApprovalRecordsReady) {
      return;
    }
    if (didCheckRestoredApproval.current) {
      return;
    }
    didCheckRestoredApproval.current = true;
    const pendingRecord = findRestorableApprovalRecord(approvalRecords);
    if (!pendingRecord) {
      return;
    }
    if (isApprovalRecordExpired(pendingRecord)) {
      updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
      return;
    }
    if (pendingRecord.toolName === CODE_PATCH_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.codeProposedEdit) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredCodePatchApprovalTask(pendingRecord));
      return;
    }
    if (pendingRecord.toolName === GIT_PUSH_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.gitPushPlan) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredGitPushApprovalTask(pendingRecord));
      return;
    }
    if (pendingRecord.toolName === GIT_COMMIT_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.gitCommitPlan) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredGitCommitApprovalTask(pendingRecord));
      return;
    }
    if (pendingRecord.toolName === GIT_STAGE_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.gitStagePlan) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredGitStageApprovalTask(pendingRecord));
      return;
    }
    if (pendingRecord.toolName === GIT_CREATE_PR_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.gitCreatePullRequestPlan) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredGitCreatePullRequestApprovalTask(pendingRecord));
      return;
    }
    if (pendingRecord.toolName === GIT_COMMENT_PR_APPROVAL_TOOL_NAME) {
      if (!pendingRecord.gitCommentPullRequestPlan) {
        updateApprovalRecord(expireApprovalRecord(pendingRecord, new Date().toISOString()));
        return;
      }
      clearQueuedTaskSnapshots();
      setTask(createRestoredGitCommentPullRequestApprovalTask(pendingRecord));
      return;
    }
    clearQueuedTaskSnapshots();
    setTask(createRestoredPdfApprovalTask(pendingRecord));
  }, [approvalRecords, areDurableApprovalRecordsReady]);

  function queueGoalSubmission(submission: PendingGoalSubmission): void {
    pendingGoalQueueRef.current.push(submission);
    setQueuedGoalCount(pendingGoalQueueRef.current.length);
    if (submission.clearDraftOnQueue) {
      setDraftGoal("");
    }
  }

  function scheduleNextQueuedGoal(): void {
    if (queuedStartTimerRef.current || pendingGoalQueueRef.current.length === 0) {
      return;
    }
    queuedStartTimerRef.current = setTimeout(() => {
      queuedStartTimerRef.current = null;
      if (isTaskActiveRef.current || pendingGoalQueueRef.current.length === 0) {
        return;
      }
      const next = pendingGoalQueueRef.current.shift();
      setQueuedGoalCount(pendingGoalQueueRef.current.length);
      if (!next) {
        return;
      }
      queuedSubmissionModeRef.current = next.composeMode;
      submitGoal(
        next.goalOverride,
        next.workspacePathOverride,
        next.scheduledTaskId,
        next.attachments,
        next.imageDataUrls,
        true,
        next.rawGoal,
        next.forcedMode,
        next.goalId,
        next.submitIntent,
      );
      queuedSubmissionModeRef.current = null;
      queuedContinuationTaskRef.current = null;
    }, 0);
  }

  function persistCurrentGoal(nextGoal: GoalState | null): GoalState | null {
    const savedGoal = saveCurrentGoal(window.localStorage, nextGoal);
    currentGoalRef.current = savedGoal;
    setCurrentGoal(savedGoal);
    const repository = currentGoalRepoRef.current;
    if (repository) {
      void (savedGoal ? repository.save(savedGoal) : repository.clear())
        .catch((error) => logNonFatalError("Failed to persist current Goal", error));
    }
    return savedGoal;
  }

  function storeGoalEvent(event: GoalEvent): void {
    if (currentGoalRef.current?.id === event.goalId) {
      const nextEvents = [...currentGoalEventsRef.current.filter((item) => item.id !== event.id), event].slice(-200);
      currentGoalEventsRef.current = nextEvents;
      setCurrentGoalEvents(nextEvents);
    }
    const repository = goalTimelineRepoRef.current;
    if (repository) {
      void repository.appendEvent(event)
        .catch((error) => logNonFatalError("Failed to persist Goal event", error));
    }
  }

  async function saveGoalDecisionEvaluation(
    goal: GoalState,
    taskSnapshot: TaskSnapshot,
    decision: GoalDecision,
  ): Promise<GoalEvaluation> {
    const evaluation = createGoalEvaluationFromDecision(goal, taskSnapshot, decision);
    if (currentGoalRef.current?.id === goal.id) {
      const nextEvaluations = [
        ...currentGoalEvaluationsRef.current.filter((item) => item.id !== evaluation.id),
        evaluation,
      ].slice(-100);
      currentGoalEvaluationsRef.current = nextEvaluations;
      setCurrentGoalEvaluations(nextEvaluations);
    }
    const repository = goalTimelineRepoRef.current;
    if (repository) {
      await repository.saveEvaluation(evaluation);
    }
    return evaluation;
  }

  function startGoalIteration(
    goal: GoalState,
    prompt?: string,
    latestTask?: TaskSnapshot,
    latestEvaluation?: GoalEvaluation,
  ): void {
    const iterationPrompt = (prompt ?? goal.objective).trim();
    if (!iterationPrompt) {
      return;
    }
    const strategyApplication = applyGoalStrategies(
      createGoalStrategyContext({
        goal,
        latestTask,
        latestEvaluation,
        events: currentGoalEventsRef.current,
      }),
      iterationPrompt,
      goalStrategies,
    );
    for (const event of strategyApplication.events) {
      storeGoalEvent(event);
    }
    submitGoal(
      strategyApplication.prompt,
      goal.workspacePath ?? workspaceRef.current,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "project",
      goal.id,
      "goal",
    );
  }

  function scheduleGoalContinuation(
    goal: GoalState,
    decision?: GoalDecision,
    latestTask?: TaskSnapshot,
    latestEvaluation?: GoalEvaluation,
  ): void {
    if (goalContinuationTimerRef.current) {
      clearTimeout(goalContinuationTimerRef.current);
      goalContinuationTimerRef.current = null;
    }
    goalContinuationTimerRef.current = setTimeout(() => {
      goalContinuationTimerRef.current = null;
      const current = currentGoalRef.current;
      if (!current || current.id !== goal.id || current.status !== "active" || isGoalTerminal(current.status)) {
        return;
      }
      startGoalIteration(
        current,
        createGoalContinuationPrompt({ goal: current, decision, latestTask, latestEvaluation }),
        latestTask,
        latestEvaluation,
      );
    }, 0);
  }

  function handleGoalTaskSnapshot(nextTask: TaskSnapshot): void {
    let goal = currentGoalRef.current;
    if (!goal || goal.status === "cleared") {
      return;
    }

    const pendingBind = pendingGoalBindRef.current;
    if (pendingBind?.goalId === goal.id && !goal.taskIds.includes(nextTask.id)) {
      const transition = createGoalTaskBoundTransition(goal, nextTask);
      goal = persistCurrentGoal(transition.goal) ?? goal;
      pendingGoalBindRef.current = null;
      transition.events.forEach(storeGoalEvent);
    }

    if (!goal.taskIds.includes(nextTask.id) || !isTerminalTaskStatus(nextTask.status)) {
      return;
    }
    if (evaluatedGoalTaskIdsRef.current.has(nextTask.id)) {
      return;
    }
    if (goal.status !== "active") {
      return;
    }
    evaluatedGoalTaskIdsRef.current.add(nextTask.id);
    storeGoalEvent(createGoalTaskTerminalEvent(goal, nextTask));

    void (async () => {
      try {
        const repository = goalTimelineRepoRef.current;
        let evaluation = repository
          ? await repository.getEvaluationForTask(goal.id, nextTask.id).catch((error) => {
              logNonFatalError("Failed to load persisted Goal evaluation", error);
              return null;
            })
          : null;
        let decision: GoalDecision | null = evaluation ? goalDecisionFromEvaluation(evaluation) : null;
        if (evaluation) {
          const restoredEvaluation = evaluation;
          const nextEvaluations = [
            ...currentGoalEvaluationsRef.current.filter((item) => item.id !== restoredEvaluation.id),
            restoredEvaluation,
          ].slice(-100);
          currentGoalEvaluationsRef.current = nextEvaluations;
          setCurrentGoalEvaluations(nextEvaluations);
        }

        if (!decision || !evaluation) {
          decision = await runtime.evaluateGoalCompletion(goal, nextTask);
          evaluation = await saveGoalDecisionEvaluation(goal, nextTask, decision);
          storeGoalEvent(createGoalEvaluatedEvent(goal, evaluation));
        }
        const latestGoal = currentGoalRef.current;
        if (!latestGoal || latestGoal.id !== goal.id || latestGoal.status !== "active") {
          return;
        }
        const transition = applyGoalEvaluationTransition(latestGoal, nextTask, decision, evaluation);
        const nextGoal = persistCurrentGoal(transition.goal);
        transition.events.forEach(storeGoalEvent);
        if (!nextGoal || nextGoal.status !== "active" || isGoalTerminal(nextGoal.status)) {
          return;
        }
        scheduleGoalContinuation(nextGoal, decision, nextTask, evaluation);
      } catch (error) {
        evaluatedGoalTaskIdsRef.current.delete(nextTask.id);
        logNonFatalError("Failed to evaluate Goal task", error);
      }
    })();
  }

  function findLatestGoalTask(goal: GoalState): TaskSnapshot | undefined {
    return findLatestGoalTaskSnapshot(goal, task, historyCurrentRef.current);
  }

  function findLatestGoalEvaluation(goal: GoalState, taskId?: string): GoalEvaluation | undefined {
    return findGoalEvaluation(goal, currentGoalEvaluationsRef.current, taskId);
  }

  function handlePauseGoal(): void {
    const goal = currentGoalRef.current;
    if (!goal || goal.status !== "active") {
      return;
    }
    if (goalContinuationTimerRef.current) {
      clearTimeout(goalContinuationTimerRef.current);
      goalContinuationTimerRef.current = null;
    }
    const transition = createManualGoalTransition(goal, "pause");
    persistCurrentGoal(transition.goal);
    transition.events.forEach(storeGoalEvent);
  }

  function handleResumeGoal(): void {
    const goal = currentGoalRef.current;
    if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) {
      return;
    }
    const transition = createManualGoalTransition(goal, "resume");
    const resumedGoal = persistCurrentGoal(transition.goal);
    if (!resumedGoal) {
      return;
    }
    transition.events.forEach(storeGoalEvent);
    const latestTask = findLatestGoalTask(resumedGoal);
    const latestEvaluation = findLatestGoalEvaluation(resumedGoal, latestTask?.id);
    if (
      latestTask &&
      isTerminalTaskStatus(latestTask.status) &&
      resumedGoal.taskIds.includes(latestTask.id) &&
      !evaluatedGoalTaskIdsRef.current.has(latestTask.id)
    ) {
      handleGoalTaskSnapshot(latestTask);
      return;
    }
    startGoalIteration(
      resumedGoal,
      createGoalContinuationPrompt({ goal: resumedGoal, latestTask, latestEvaluation }),
      latestTask,
      latestEvaluation,
    );
  }

  function handleCompleteGoal(): void {
    const goal = currentGoalRef.current;
    if (!goal || goal.status === "complete" || goal.status === "cleared") {
      return;
    }
    if (goalContinuationTimerRef.current) {
      clearTimeout(goalContinuationTimerRef.current);
      goalContinuationTimerRef.current = null;
    }
    const transition = createManualGoalTransition(goal, "complete");
    persistCurrentGoal(transition.goal);
    transition.events.forEach(storeGoalEvent);
  }

  function handleClearGoal(): void {
    const goal = currentGoalRef.current;
    if (goalContinuationTimerRef.current) {
      clearTimeout(goalContinuationTimerRef.current);
      goalContinuationTimerRef.current = null;
    }
    pendingGoalBindRef.current = null;
    if (goal) {
      createManualGoalTransition(goal, "clear").events.forEach(storeGoalEvent);
    }
    persistCurrentGoal(null);
    currentGoalEventsRef.current = [];
    currentGoalEvaluationsRef.current = [];
    setCurrentGoalEvents([]);
    setCurrentGoalEvaluations([]);
    evaluatedGoalTaskIdsRef.current.clear();
  }

  useEffect(() => {
    if (
      isDatabaseInitializing ||
      !currentGoal ||
      currentGoal.status !== "active" ||
      isTaskActive ||
      isTaskActiveRef.current ||
      goalContinuationTimerRef.current
    ) {
      return;
    }
    const latestTask = findLatestGoalTask(currentGoal);
    const latestEvaluation = findLatestGoalEvaluation(currentGoal, latestTask?.id);
    if (
      latestTask &&
      isTerminalTaskStatus(latestTask.status) &&
      currentGoal.taskIds.includes(latestTask.id) &&
      !evaluatedGoalTaskIdsRef.current.has(latestTask.id)
    ) {
      handleGoalTaskSnapshot(latestTask);
      return;
    }
    scheduleGoalContinuation(currentGoal, latestEvaluation ? goalDecisionFromEvaluation(latestEvaluation) : undefined, latestTask, latestEvaluation);
  }, [currentGoal, isDatabaseInitializing, isTaskActive]);

  function submitGoal(
    goalOverride?: string,
    workspacePathOverride?: string,
    scheduledTaskId?: string,
    _attachments?: File[],
    imageDataUrls?: string[],
    forceStart = false,
    queuedRawGoal?: string,
    forcedMode?: "chat" | "project",
    goalId?: string,
    submitIntent?: WorkbenchSubmitGoalIntent,
  ) {
    const rawGoal = (queuedRawGoal ?? goalOverride ?? draftGoal).trim();
    if (!rawGoal) {
      return;
    }

    const goalCommandObjective = !goalId && !forcedMode && !scheduledTaskId
      ? parseGoalCommand(rawGoal)
      : null;
    if (goalCommandObjective) {
      if (!ensureAiConfigured("Agent 模式")) {
        return;
      }
      const transition = createGoalCreatedTransition({
        objective: goalCommandObjective,
        workspacePath: workspaceRef.current || undefined,
      });
      const goal = persistCurrentGoal(transition.goal);
      if (!goal) {
        return;
      }
      evaluatedGoalTaskIdsRef.current.clear();
      currentGoalEventsRef.current = [];
      currentGoalEvaluationsRef.current = [];
      setCurrentGoalEvents([]);
      setCurrentGoalEvaluations([]);
      pendingGoalBindRef.current = null;
      if (goalContinuationTimerRef.current) {
        clearTimeout(goalContinuationTimerRef.current);
        goalContinuationTimerRef.current = null;
      }
      transition.events.forEach(storeGoalEvent);
      setDraftGoal("");
      startGoalIteration(goal, goal.objective);
      return;
    }

    const requestedSubmitIntent = submitIntent ?? inferSubmitGoalIntent({
      goalId,
      scheduledTaskId,
      forceStart,
      activeHistoryEntryId,
      task,
    });
    const requestedComposeMode = forcedMode ?? queuedSubmissionModeRef.current ?? composeMode;
    if (!ensureAiConfigured(requestedComposeMode === "project" ? "Agent 模式" : "Chat 模式")) {
      return;
    }
    if (isTaskActiveRef.current && !forceStart) {
      const queuePolicy = runtimePreferencesRef.current.taskQueuePolicy;
      if (queuePolicy === "current_only") {
        return;
      }
      if (queuePolicy === "queue") {
        queueGoalSubmission({
          goalOverride,
          rawGoal,
          workspacePathOverride,
          scheduledTaskId,
          attachments: _attachments,
          imageDataUrls,
          composeMode: requestedComposeMode,
          forcedMode,
          goalId,
          submitIntent: requestedSubmitIntent,
          clearDraftOnQueue: !goalOverride,
        });
        return;
      }
      queuedContinuationTaskRef.current = null;
      pendingGoalQueueRef.current = [];
      setQueuedGoalCount(0);
      runtime.stopTask();
      setIsTaskActive(false);
      isTaskActiveRef.current = false;
      submitGoal(
        goalOverride,
        workspacePathOverride,
        scheduledTaskId,
        _attachments,
        imageDataUrls,
        true,
        rawGoal,
        forcedMode,
        goalId,
        requestedSubmitIntent,
      );
      return;
    }
    const effectiveComposeMode = shouldRouteAsDirectChat(rawGoal, requestedComposeMode, requestedSubmitIntent, imageDataUrls)
      ? "chat"
      : requestedComposeMode;
    const canContinueHistory =
      requestedSubmitIntent === "continue_history" ||
      requestedSubmitIntent === "queued_continuation";
    const queuedContinuationTask =
      canContinueHistory && forceStart && !goalOverride && !workspacePathOverride && !scheduledTaskId
        ? queuedContinuationTaskRef.current
        : null;
    const continuationTask =
      queuedContinuationTask ??
      (canContinueHistory && !goalOverride && !workspacePathOverride && !scheduledTaskId
        ? activeHistoryEntryId
          ? historyCurrentRef.current.find((entry) => entry.id === activeHistoryEntryId)
          : isArchivableTask(task)
            ? task
            : undefined
        : undefined);
    const startOptions = continuationTask
      ? {
          taskId: continuationTask.id,
          priorMessages: getConversationMessages(continuationTask),
        }
      : undefined;
    const startMode =
      forcedMode ??
      (!goalOverride && !workspacePathOverride && !scheduledTaskId
        ? effectiveComposeMode
        : undefined);
    const taskWorkspacePath =
      startMode === "project" || workspacePathOverride || scheduledTaskId
        ? workspacePathOverride ?? workspaceRef.current
        : undefined;
    clearQueuedTaskSnapshots();
    pendingGoalBindRef.current = goalId ? { goalId } : null;
    if (continuationTask) {
      setActiveHistoryEntryId(continuationTask.id);
    } else {
      setActiveHistoryEntryId(undefined);
    }
    logTaskContext("submitGoal", {
      submitIntent: requestedSubmitIntent,
      rawGoal,
      requestedComposeMode,
      effectiveComposeMode,
      continuationTaskId: continuationTask?.id,
      hasPriorMessages: Boolean(startOptions?.priorMessages.length),
    });
    if (workspacePathOverride) {
      workspaceRef.current = workspacePathOverride;
      useWorkspacePath(workspacePathOverride);
    }
    setIsTaskActive(true);
    isTaskActiveRef.current = true;
    if (scheduledTaskId) {
      setActiveScheduledTaskId(scheduledTaskId);
      pendingScheduledTaskIdRef.current = scheduledTaskId;
    }
    if (!goalOverride) {
      setDraftGoal("");
    }
    auditRecordIdsRef.current.clear();

    // ── Vision Bridge: if the goal has image attachments and the primary
    //     model lacks vision, analyze images with the multimodal model first.
    async function resolveWithVisionBridge(rawGoal: string): Promise<{
      finalGoal: string;
      bridgeUsed: boolean;
    }> {
      if (!hasImageAttachments(rawGoal)) return { finalGoal: rawGoal, bridgeUsed: false };
      const config = modelConfigRef.current;
      if (!config) return { finalGoal: rawGoal, bridgeUsed: false };
      const primary = config.profiles.find((p) => p.slot === "primary");
      const multimodal = config.profiles.find((p) => p.slot === "multimodal");
      if (!primary || !multimodal) return { finalGoal: rawGoal, bridgeUsed: false };
      const { enrichedMessage, bridgeUsed } = await bridgeVisionIfNeeded({
        userMessage: rawGoal,
        primaryProfile: primary,
        multimodalProfile: multimodal,
        locale: localePreference,
      });
      return { finalGoal: enrichedMessage, bridgeUsed };
    }

    // Determine display goal and attachments.
    const hasImages = imageDataUrls?.length;
    // Construct temporary bridge input with [image: data:...] markers
    // for VisionBridge detection. The full base64 stays here, never in goal text.
    const bridgeInput = hasImages
      ? imageDataUrls!.map((url) => `[image: ${url}]`).join("\n") + "\n" + rawGoal
      : rawGoal;

    // Resolve @document references — read file content and inject into prompt
    const atRefs = extractAtReferences(bridgeInput);
    if (atRefs.length > 0) {
      void (async () => {
        let resolvedGoal = bridgeInput;
        for (const ref of atRefs) {
          try {
            const readScope = getAllowedRootScopeForReference(
              ref.path,
              userDocuments,
              taskWorkspacePath ?? workspaceRef.current,
            );
            const content = await readFileChunk(ref.path, undefined, readScope);
            resolvedGoal = injectDocumentContext(resolvedGoal, ref.path, content);
          } catch (error) {
            logNonFatalError(`Failed to read referenced file ${ref.path}`, error);
          }
        }
        // Vision bridge
        let finalGoal = resolvedGoal;
        let bridgeUsed = false;
        if (hasImages) {
          const bridgeResult = await resolveWithVisionBridge(resolvedGoal);
          bridgeUsed = bridgeResult.bridgeUsed;
          finalGoal = bridgeResult.finalGoal;
        }
        runtime.start(finalGoal, {
          ...startOptions,
          mode: bridgeUsed ? "chat" : startMode,
          displayGoal: hasImages ? rawGoal : undefined,
          displayAttachments: hasImages ? imageDataUrls : undefined,
          workspacePath: taskWorkspacePath,
        });
      })();
      return;
    }

    void (async () => {
      let finalGoal = bridgeInput;
      let bridgeUsed = false;
      if (hasImages) {
        const bridgeResult = await resolveWithVisionBridge(bridgeInput);
        bridgeUsed = bridgeResult.bridgeUsed;
        finalGoal = bridgeResult.finalGoal;
      }
      runtime.start(finalGoal, {
        ...startOptions,
        mode: bridgeUsed ? "chat" : startMode,
        displayGoal: hasImages ? rawGoal : undefined,
        displayAttachments: hasImages ? imageDataUrls : undefined,
        workspacePath: taskWorkspacePath,
      });
    })();
  }

  function handleStopTask() {
    suppressNextQueuedGoalForTaskRef.current = null;
    queuedContinuationTaskRef.current = task;
    runtime.stopTask();
    setIsTaskActive(false);
    isTaskActiveRef.current = false;
    scheduleNextQueuedGoal();
  }

  function handleEmergencyStopTask() {
    if (!isTaskActiveRef.current) {
      return;
    }
    suppressNextQueuedGoalForTaskRef.current = task.id;
    pendingGoalQueueRef.current = [];
    setQueuedGoalCount(0);
    if (queuedStartTimerRef.current) {
      clearTimeout(queuedStartTimerRef.current);
      queuedStartTimerRef.current = null;
    }
    queuedContinuationTaskRef.current = task;
    runtime.stopTask();
    setIsTaskActive(false);
    isTaskActiveRef.current = false;
  }
  emergencyStopTaskRef.current = handleEmergencyStopTask;

  function handleWorkbenchSubmitGoal(
    goalOverride?: string,
    workspacePathOverride?: string,
    scheduledTaskId?: string,
    attachments?: File[],
    imageDataUrls?: string[],
    options?: WorkbenchSubmitGoalOptions,
  ) {
    submitGoal(
      goalOverride,
      workspacePathOverride,
      scheduledTaskId,
      attachments,
      imageDataUrls,
      false,
      undefined,
      undefined,
      undefined,
      options?.intent,
    );
  }

  function retryCurrentTask() {
    const goal = task.userGoal.trim();
    if (!goal) {
      return;
    }
    clearQueuedTaskSnapshots();
    setDraftGoal(goal);
    workspaceRef.current = workspacePath;
    setIsTaskActive(true);
    isTaskActiveRef.current = true;
    auditRecordIdsRef.current.clear();
    runtime.start(goal);
  }

  function persistDurableApprovalRecord(nextTask: TaskSnapshot) {
    const request = nextTask.permissionRequest;
    if (
      nextTask.status !== "waiting_permission" ||
      !request ||
      request.status !== "pending" ||
      !isDurableApprovalRequestTitle(request.title)
    ) {
      return;
    }
    const toolName = getDurableApprovalToolName(request.title);
    if (!toolName) {
      return;
    }
    const record = createApprovalRecordFromPermissionRequest({
      taskId: nextTask.id,
      toolName,
      workspacePath: getDurableApprovalWorkspacePath(nextTask, request.title),
      permissionRequest: request,
      codeProposedEdit:
        request.title === CODE_PATCH_APPROVAL_TITLE
          ? nextTask.codeProposedEdit
          : undefined,
    });
    if (!record) {
      return;
    }
    setApprovalRecords((current) => {
      const updated = upsertApprovalRecord(current, record);
      const repository = approvalRecordsRepoRef.current;
      if (repository) {
        void repository.upsert(record);
      }
      return updated;
    });
  }

  function appendRuntimeJsonlLogs(nextTask: TaskSnapshot) {
    const database = databaseRef.current;
    void appendTaskSnapshotAuditJsonLines(
      createFileBackedTaskAuditJsonLineWriter(
        (line) => invoke("append_task_audit_jsonl_line", { request: { line } }).then(() => undefined),
        window.localStorage,
      ),
      nextTask,
      auditRecordIdsRef.current,
    );
    void appendTaskSessionSnapshotJsonLine(
      database
        ? createSqliteTaskSessionWriter(database)
        : createFileBackedTaskSessionJsonLineWriter(
            (line) => invoke("append_task_session_jsonl_line", { request: { line } }).then(() => undefined),
            window.localStorage,
          ),
      nextTask,
    );
    if (nextTask.status === "completed" || nextTask.status === "failed" || nextTask.status === "cancelled") {
      persistAgentSessionSummary(nextTask);
      if (suppressNextQueuedGoalForTaskRef.current === nextTask.id) {
        suppressNextQueuedGoalForTaskRef.current = null;
        queuedContinuationTaskRef.current = nextTask;
        return;
      }
      queuedContinuationTaskRef.current = nextTask;
      scheduleNextQueuedGoal();
    }
  }

  function recordToolCallAudit(record: ToolCallAuditRecord) {
    recentToolCallAuditRecordsRef.current = [
      ...recentToolCallAuditRecordsRef.current,
      record,
    ].slice(-200);
    const database = databaseRef.current;
    if (database) {
      void upsertToolCallAuditRecord(database, record);
    }
    void appendToolCallAuditJsonLine(
      createFileBackedTaskAuditJsonLineWriter(
        (line) => invoke("append_task_audit_jsonl_line", { request: { line } }).then(() => undefined),
        window.localStorage,
      ),
      record,
    );
  }

  function persistAgentSessionSummary(nextTask: TaskSnapshot) {
    if (!isAgentMemoryEnabledRef.current) {
      return;
    }
    const repository = agentMemoryRepoRef.current;
    if (!repository) {
      return;
    }
    const summary = createAgentSessionSummaryFromTask(nextTask, workspaceRef.current);
    if (!summary || savedAgentSessionSummaryIdsRef.current.has(summary.id)) {
      return;
    }
    savedAgentSessionSummaryIdsRef.current.add(summary.id);
    const shouldExtractLongTermFacts = nextTask.status === "completed";
    void repository.saveSessionSummary(summary)
      .then(async (savedSummary) => {
        if (shouldExtractLongTermFacts) {
          const facts = extractAgentMemoryFactsFromSummary(savedSummary);
          for (const fact of facts) {
            await repository.saveFact(fact);
          }
        }
        return repository.getSummary(currentWorkspaceMemoryIdRef.current || undefined, isAgentMemoryEnabledRef.current);
      })
      .then(setAgentMemorySummary)
      .catch((error) => {
        savedAgentSessionSummaryIdsRef.current.delete(summary.id);
        logNonFatalError("Failed to save agent session summary", error);
      });
  }

  function updateApprovalRecord(record: DurableApprovalRecord) {
    setApprovalRecords((current) => {
      const updated = upsertApprovalRecord(current, record);
      const repository = approvalRecordsRepoRef.current;
      if (repository) {
        void repository.upsert(record);
      }
      return updated;
    });
  }

  function resolveApprovalRecordById(
    approvalId: string,
    decision: "approved" | "denied",
    resolvedAt = new Date().toISOString(),
  ) {
    setApprovalRecords((current) => {
      const record = current.find((item) => item.approvalId === approvalId);
      if (!record || record.status !== "pending") {
        return current;
      }
      const resolved = resolveApprovalRecord(record, decision, resolvedAt);
      const updated = upsertApprovalRecord(current, resolved);
      const repository = approvalRecordsRepoRef.current;
      if (repository) {
        void repository.upsert(resolved);
      }
      return updated;
    });
  }

  async function resolveRestoredApproval(decision: "approved" | "denied") {
    const record = findRestorableApprovalRecord(approvalRecords);
    if (!record) {
      return;
    }
    if (record.toolName === CODE_PATCH_APPROVAL_TOOL_NAME) {
      await resolveRestoredCodePatchApproval(record, decision);
      return;
    }
    if (record.toolName === GIT_PUSH_APPROVAL_TOOL_NAME) {
      await resolveRestoredGitPushApproval(record, decision);
      return;
    }
    if (record.toolName === GIT_COMMIT_APPROVAL_TOOL_NAME) {
      await resolveRestoredGitCommitApproval(record, decision);
      return;
    }
    if (record.toolName === GIT_STAGE_APPROVAL_TOOL_NAME) {
      await resolveRestoredGitStageApproval(record, decision);
      return;
    }
    if (record.toolName === GIT_CREATE_PR_APPROVAL_TOOL_NAME) {
      await resolveRestoredGitCreatePullRequestApproval(record, decision);
      return;
    }
    if (record.toolName === GIT_COMMENT_PR_APPROVAL_TOOL_NAME) {
      await resolveRestoredGitCommentPullRequestApproval(record, decision);
      return;
    }
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      const deniedTask = createRestoredPdfDeniedTask(deniedRecord);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(deniedTask);
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredPdfOrganization(approvedRecord);
      archiveRestoredTask(createRestoredPdfApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredPdfFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredCodePatchApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredCodePatchDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const applyResult = await applyRestoredCodePatch(approvedRecord);
      const verification = await runRestoredCodePatchVerification(approvedRecord.workspacePath);
      archiveRestoredTask(
        createRestoredCodePatchApprovedTask(approvedRecord, applyResult, verification),
      );
    } catch (error) {
      archiveRestoredTask(createRestoredCodePatchFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredGitPushApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredGitPushDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredGitPush(approvedRecord);
      archiveRestoredTask(createRestoredGitPushApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredGitPushFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredGitCommitApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredGitCommitDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredGitCommit(approvedRecord);
      archiveRestoredTask(createRestoredGitCommitApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredGitCommitFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredGitStageApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredGitStageDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredGitStage(approvedRecord);
      archiveRestoredTask(createRestoredGitStageApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredGitStageFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredGitCreatePullRequestApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredGitCreatePullRequestDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredGitCreatePullRequest(approvedRecord);
      archiveRestoredTask(createRestoredGitCreatePullRequestApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredGitCreatePullRequestFailedTask(approvedRecord, error));
    }
  }

  async function resolveRestoredGitCommentPullRequestApproval(
    record: DurableApprovalRecord,
    decision: "approved" | "denied",
  ) {
    const resolvedAt = new Date().toISOString();
    if (decision === "denied") {
      const deniedRecord = resolveApprovalRecord(record, "denied", resolvedAt);
      updateApprovalRecord(deniedRecord);
      archiveRestoredTask(createRestoredGitCommentPullRequestDeniedTask(deniedRecord));
      return;
    }

    const approvedRecord = resolveApprovalRecord(record, "approved", resolvedAt);
    updateApprovalRecord(approvedRecord);
    try {
      const execution = await runRestoredGitCommentPullRequest(approvedRecord);
      archiveRestoredTask(createRestoredGitCommentPullRequestApprovedTask(approvedRecord, execution));
    } catch (error) {
      archiveRestoredTask(createRestoredGitCommentPullRequestFailedTask(approvedRecord, error));
    }
  }

  function archiveRestoredTask(restoredTask: TaskSnapshot) {
    clearQueuedTaskSnapshots();
    setTask(restoredTask);
    setHistory((current) => {
      const updated = upsertTaskHistory(current, restoredTask);
      const repository = taskHistoryRepoRef.current;
      if (repository) {
        void repository.upsert(restoredTask);
      }
      return updated;
    });
  }

  function handlePermissionDecision(decision: WorkbenchPermissionDecision) {
    const request = task.permissionRequest;
    if (
      decision === "approved_always" &&
      request?.dryRun.operation.startsWith("computer.") &&
      request.allowAlways !== false
    ) {
      const trustedTitle = extractTrustedComputerAppTitleFromPermissionRequest(request);
      if (trustedTitle) {
        setTrustedComputerApps((current) => {
          const next = addTrustedComputerApp(current, trustedTitle);
          persistTrustedComputerApps(next);
          return next;
        });
      }
    }
    if (
      task.status === "waiting_permission" &&
      request?.status === "pending" &&
      isDurableApprovalRequestTitle(request.title)
    ) {
      const record = approvalRecords.find((item) => item.approvalId === request.id);
      if (record?.status === "pending") {
        updateApprovalRecord(resolveApprovalRecord(record, decision === "approved_always" ? "approved" : decision, new Date().toISOString()));
      }
    }
    runtime.resolvePermission(decision, request?.id);
  }

  function handleAskUserAnswer(answer: string) {
    const request = task.askUserQuestion;
    if (
      (task.status === "waiting_info" || task.status === "waiting_permission" || task.status === "running") &&
      request?.status === "pending"
    ) {
      runtime.respondToAskUser(answer, request.id);
    }
  }

  function handleConversationMessagesChange(
    taskId: string | undefined,
    messages: WorkbenchChatMessage[],
  ) {
    const nextMessages = messages.map((message) => ({ ...message })) as ChatMessage[];
    const updatedAt = new Date().toISOString();
    setTask((current) =>
      !taskId || current.id === taskId
        ? { ...current, conversationMessages: nextMessages, updatedAt }
        : current,
    );
    setHistory((current) => {
      const targetId = taskId ?? activeHistoryEntryId;
      const targetTask = targetId
        ? current.find((entry) => entry.id === targetId)
        : undefined;
      if (!targetTask) {
        return current;
      }
      const updatedTask: TaskSnapshot = {
        ...targetTask,
        conversationMessages: nextMessages,
        updatedAt,
      };
      const updated = upsertTaskHistory(current, updatedTask);
      const repository = taskHistoryRepoRef.current;
      if (repository) {
        void repository.upsert(updatedTask);
      }
      return updated;
    });
  }

  function handleRemoveTrustedComputerApp(title: string) {
    setTrustedComputerApps((current) => {
      const next = removeTrustedComputerApp(current, title);
      persistTrustedComputerApps(next);
      return next;
    });
  }

  function selectHistoryEntry(id: string) {
    const entry = history.find((item) => item.id === id);
    if (entry) {
      clearQueuedTaskSnapshots();
      setTask(entry);
      setActiveHistoryEntryId(id);
      setDraftGoal("");
      setComposeMode(entry.originMode ?? (getTaskWorkspacePath(entry) ? "project" : "chat"));
      setActiveView("chat");
    }
  }

  function deleteHistoryEntry(id: string) {
    const entry = history.find((item) => item.id === id);
    if (!window.confirm(`Delete history "${entry?.title ?? id}"?`)) {
      return;
    }
    if (activeHistoryEntryId === id) {
      setActiveHistoryEntryId(undefined);
    }
    setHistory((current) => {
      const updated = current.filter((entry) => entry.id !== id);
      const repository = taskHistoryRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }

  function confirmDeleteScheduledTask(id: string) {
    const taskToDelete = scheduledTasks.find((item) => item.id === id);
    if (!window.confirm(`Delete scheduled task "${taskToDelete?.name ?? id}"?`)) {
      return;
    }
    deleteScheduledTask(id);
  }

  function handleCreateScheduledTask(draft: WorkbenchScheduledTaskDraft) {
    const schedule = {
      type: draft.scheduleType,
      value: draft.scheduleValue,
    };
    if (!computeNextRun(schedule, new Date().toISOString())) {
      window.alert(
        localePreference === "en"
          ? "Schedule value is invalid or already in the past."
          : "调度值无效，或一次性时间已经过去。",
      );
      return;
    }
    const created = createScheduledTask(
      {
        name: draft.name,
        goal: draft.goal,
        workspacePath: draft.workspacePath || workspaceRef.current,
        schedule,
      },
      "user",
    );
    setScheduledTasks((current) => {
      const updated = [...current, created].sort((left, right) =>
        left.nextRunAt.localeCompare(right.nextRunAt),
      );
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(updated);
      } else {
        saveScheduledTasks(window.localStorage, updated);
      }
      return updated;
    });
  }

  function handleChangeActiveView(view: ActiveView) {
    const shouldStartFreshChat =
      view === "chat" && (activeView !== "chat" || activeHistoryEntryId || task.id !== "task-idle");
    if (shouldStartFreshChat) {
      clearQueuedTaskSnapshots();
      setTask(createInitialTaskSnapshot({
        capabilityVerification: buildRuntimeCapabilityVerification({
          toolAuditRecords: recentToolCallAuditRecordsRef.current,
        }),
      }));
      setActiveHistoryEntryId(undefined);
      setDraftGoal(DEFAULT_DRAFT_GOAL);
    }
    setActiveView(view);
  }

  function handleOpenFile(path: string) {
    openPath(path).catch((error) => logNonFatalError(`Failed to open path ${path}`, error));
  }

  function handleOpenUrl(url: string) {
    openUrl(url).catch((error) => logNonFatalError(`Failed to open URL ${url}`, error));
  }

  const effectiveLocale = localePreference === "en" ? defaultWorkbenchLocale : zhCNWorkbenchLocale;
  const agentCatalog: WorkbenchAgentCatalogEntry[] = useMemo(
    () =>
      demoAgents.map((agent) => ({
        kind: agent.kind,
        displayName: agent.displayName,
      })),
    [],
  );
  const newChatRecommendations: WorkbenchNewChatRecommendations = useMemo(
    () => createNewChatRecommendations(userProfileMemory, localePreference === "en" ? "en" : "zh"),
    [localePreference, userProfileMemory],
  );
  const userProfileMemorySummary = useMemo(
    () => userProfileMemory
      ? {
          factCount: userProfileMemory.facts.length,
          topTags: userProfileMemory.summary.topTags,
          updatedAt: userProfileMemory.updatedAt,
          facts: userProfileMemory.facts.slice(0, 8).map((fact) => ({
            id: fact.id,
            text: fact.text,
            tags: fact.tags,
            source: fact.source,
            confidence: fact.confidence,
            hitCount: fact.hitCount,
            evidence: fact.evidence.map((item) => ({
              title: item.title,
              snippet: item.snippet,
              observedAt: item.observedAt,
              matchedKeywords: item.matchedKeywords,
            })),
          })),
        }
      : null,
    [userProfileMemory],
  );
  const displayUserImages = useMemo(
    () =>
      userImages.map((image) => ({
        ...image,
        thumbnailUrl: image.thumbnailUrl ?? convertFileSrc(image.path),
      })),
    [userImages],
  );

  useEffect(() => {
    const repository = agentMemoryRepoRef.current;
    if (!repository) {
      setAgentMemorySummary({
        enabled: isAgentMemoryEnabled,
        totalFactCount: 0,
        workspaceFactCount: 0,
        sessionSummaryCount: 0,
        injectionLogCount: 0,
        recentFacts: [],
      });
      return;
    }
    let cancelled = false;
    repository.getSummary(currentWorkspaceMemoryId || undefined, isAgentMemoryEnabled)
      .then((summary) => {
        if (!cancelled) {
          setAgentMemorySummary(summary);
        }
      })
      .catch((error) => {
        logNonFatalError("Failed to load agent memory summary", error);
        if (!cancelled) {
          setAgentMemorySummary({
            enabled: isAgentMemoryEnabled,
            totalFactCount: 0,
            workspaceFactCount: 0,
            sessionSummaryCount: 0,
            injectionLogCount: 0,
            recentFacts: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceMemoryId, isAgentMemoryEnabled, isDatabaseInitializing]);

  useEffect(() => {
    setUserProfileMemory((previous) => {
      const result = updateUserProfileMemory({
        history,
        currentWorkspacePath: workspacePath,
        recentWorkspacePaths,
        previous,
      });
      if (!result.changed) {
        return previous;
      }
      const next = result.memory;
      const repository = userProfileMemoryRepoRef.current;
      if (repository) {
        void repository.save(next).catch((error) =>
          logNonFatalError("Failed to save user profile memory", error),
        );
      } else {
        saveUserProfileMemory(window.localStorage, next);
      }
      return next;
    });
  }, [history, recentWorkspacePaths, workspacePath]);

  function persistUserProfileMemory(memory: UserProfileMemory | null): void {
    const repository = userProfileMemoryRepoRef.current;
    if (repository) {
      if (memory) {
        void repository.save(memory).catch((error) =>
          logNonFatalError("Failed to save user profile memory", error),
        );
      } else {
        void repository.clear().catch((error) =>
          logNonFatalError("Failed to clear user profile memory", error),
        );
      }
      return;
    }

    if (memory) {
      saveUserProfileMemory(window.localStorage, memory);
    } else {
      clearUserProfileMemory(window.localStorage);
    }
  }

  function handleRebuildUserProfileMemory() {
    const next = createUserProfileMemory({
      history,
      currentWorkspacePath: workspacePath,
      recentWorkspacePaths,
      previous: null,
    });
    setUserProfileMemory(next);
    persistUserProfileMemory(next);
  }

  function handleClearUserProfileMemory() {
    setUserProfileMemory(null);
    persistUserProfileMemory(null);
  }

  function handleAgentMemoryEnabledChange(enabled: boolean) {
    const current = runtimePreferencesRef.current;
    handleRuntimePreferencesChange({
      ...current,
      agentMemoryScope: enabled
        ? current.agentMemoryScope === "off" ? "workspace" : current.agentMemoryScope
        : "off",
    });
  }

  function handleRuntimePreferencesChange(preferences: WorkbenchRuntimePreferences) {
    const sanitized = sanitizeRuntimePreferences(preferences);
    setRuntimePreferences(sanitized);
    setAgentMemoryEnabled(sanitized.agentMemoryScope !== "off");
    setAgentMemorySummary((current) =>
      current ? { ...current, enabled: sanitized.agentMemoryScope !== "off" } : current,
    );
    for (const [key, value] of Object.entries(runtimePreferencesToPrefs(sanitized))) {
      persistPreference(key, value);
    }
    persistPreference(AGENT_MEMORY_ENABLED_PREFERENCE_KEY, sanitized.agentMemoryScope === "off" ? "false" : "true");
    setComposeMode(composeModeForStartupPreference(sanitized.defaultStartupMode, workspaceRef.current));
  }

  function handleClearAgentMemory() {
    const repository = agentMemoryRepoRef.current;
    if (!repository) return;
    const confirmed = window.confirm(
      localePreference === "en"
        ? "Clear all Agent memory facts, session summaries, FTS entries, and injection audit logs? Chat and task history will not be deleted."
        : "清空全部 Agent 记忆事实、会话摘要、FTS 和注入审计日志？原始聊天和任务历史不会被删除。",
    );
    if (!confirmed) return;
    markAgentMemoryHistoryRestoreDone();
    void repository.clearAll()
      .then(() => repository.getSummary(currentWorkspaceMemoryId || undefined, isAgentMemoryEnabled))
      .then(setAgentMemorySummary)
      .catch((error) => logNonFatalError("Failed to clear agent memory", error));
  }

  function handleClearWorkspaceAgentMemory() {
    const repository = agentMemoryRepoRef.current;
    if (!repository || !currentWorkspaceMemoryId) return;
    const confirmed = window.confirm(
      localePreference === "en"
        ? "Clear Agent memory for the current workspace, including related summaries and injection audit logs? Chat and task history will not be deleted."
        : "清空当前工作区的 Agent 记忆、相关摘要和注入审计日志？原始聊天和任务历史不会被删除。",
    );
    if (!confirmed) return;
    markAgentMemoryHistoryRestoreDone();
    void repository.clearWorkspace(currentWorkspaceMemoryId)
      .then(() => repository.getSummary(currentWorkspaceMemoryId, isAgentMemoryEnabled))
      .then(setAgentMemorySummary)
      .catch((error) => logNonFatalError("Failed to clear workspace agent memory", error));
  }

  function handleDeleteAgentMemoryFact(id: string) {
    const repository = agentMemoryRepoRef.current;
    if (!repository) return;
    const confirmed = window.confirm(
      localePreference === "en"
        ? "Delete this Agent memory fact and related injection audit logs? Chat and task history will not be deleted."
        : "删除这条 Agent 记忆及相关注入审计日志？原始聊天和任务历史不会被删除。",
    );
    if (!confirmed) return;
    markAgentMemoryHistoryRestoreDone();
    void repository.deleteFact(id)
      .then(() => repository.getSummary(currentWorkspaceMemoryId || undefined, isAgentMemoryEnabled))
      .then(setAgentMemorySummary)
      .catch((error) => logNonFatalError("Failed to delete agent memory fact", error));
  }

  const sidebarWidthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityHeightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function persistPreference(key: string, value: string) {
    const repo = preferencesRepoRef.current;
    if (repo) {
      void repo.set(key, value).catch((error) =>
        {
          console.warn(`Failed to persist preference "${key}"`, error);
          persistPendingPreferenceToLocalStorage(key, value);
        },
      );
      return;
    }
    persistPendingPreferenceToLocalStorage(key, value);
  }

  function persistTrustedComputerApps(apps: TrustedComputerApp[]) {
    persistPreference(PREF_KEYS.COMPUTER_TRUSTED_APPS, serializeTrustedComputerApps(apps));
  }

  function markAgentMemoryHistoryRestoreDone() {
    persistPreference(AGENT_MEMORY_HISTORY_RESTORE_DONE_PREFERENCE_KEY, "true");
  }

  const terminalService = useMemo<WorkbenchTerminalService>(
    () => ({
      async planCreate(session: WorkbenchAgentSessionContext, terminalId?: string) {
        const plan = await invoke<TerminalPlanResult>("terminal_plan_create", {
          request: {
            taskId: session.taskId,
            sessionId: session.sessionId,
            workspaceRoot: session.workspaceRoot,
            terminalId,
          },
        });
        recordToolCallAudit(createTerminalPlanAuditRecord(session, plan));
        return plan;
      },
      async executeCreate(
        session: WorkbenchAgentSessionContext,
        plan: TerminalPlanResult,
        cols: number,
        rows: number,
        terminalId?: string,
      ) {
        await invoke("terminal_approve", {
          request: {
            approvalId: plan.approvalId,
            taskId: session.taskId,
            action: plan.action,
            previewHash: plan.previewHash,
          },
        });
        const startedAt = new Date().toISOString();
        try {
          const result = await invoke<WorkbenchTerminalSession>("terminal_create", {
            request: {
              taskId: session.taskId,
              sessionId: session.sessionId,
              workspaceRoot: session.workspaceRoot,
              terminalId: plan.preview.terminalId ?? terminalId,
              permissionMode: session.permissionMode,
              approvalId: plan.approvalId,
              cols,
              rows,
            },
          });
          recordToolCallAudit(createTerminalCreateExecutionAuditRecord(session, plan.approvalId, result, startedAt));
          return result;
        } catch (error) {
          recordToolCallAudit(createTerminalFailedAuditRecord(session, plan.approvalId, plan.toolName, error, startedAt));
          throw error;
        }
      },
      async create(session: WorkbenchAgentSessionContext, cols: number, rows: number, terminalId?: string) {
        const plan = await this.planCreate!(session, terminalId);
        return this.executeCreate!(session, plan, cols, rows, terminalId);
      },
      async planInput(session: WorkbenchAgentSessionContext, terminalId: string, data: string) {
        const plan = await invoke<TerminalPlanResult>("terminal_plan_input", {
          request: {
            taskId: session.taskId,
            terminalId,
            data,
          },
        });
        recordToolCallAudit(createTerminalPlanAuditRecord(session, plan));
        return plan;
      },
      async executeInput(
        session: WorkbenchAgentSessionContext,
        plan: TerminalPlanResult,
        terminalId: string,
        data: string,
      ) {
        await invoke("terminal_approve", {
          request: {
            approvalId: plan.approvalId,
            taskId: session.taskId,
            action: plan.action,
            previewHash: plan.previewHash,
          },
        });
        const startedAt = new Date().toISOString();
        try {
          await invoke("terminal_input", {
            request: {
              taskId: session.taskId,
              terminalId,
              data,
              permissionMode: session.permissionMode,
              approvalId: plan.approvalId,
            },
          });
          recordToolCallAudit(createTerminalInputExecutionAuditRecord(session, plan.approvalId, plan, startedAt));
        } catch (error) {
          recordToolCallAudit(createTerminalFailedAuditRecord(session, plan.approvalId, plan.toolName, error, startedAt));
          throw error;
        }
      },
      async input(session: WorkbenchAgentSessionContext, terminalId: string, data: string) {
        const plan = await this.planInput!(session, terminalId, data);
        await this.executeInput!(session, plan, terminalId, data);
      },
      async resize(terminalId: string, cols: number, rows: number) {
        await invoke("terminal_resize", { request: { terminalId, cols, rows } });
      },
      async kill(terminalId: string) {
        await invoke("terminal_kill", { request: { terminalId } });
      },
      subscribe(terminalId, handlers) {
        const unlisteners: Array<() => void> = [];
        let disposed = false;
        void listen<{ terminalId: string; data: string }>("terminal://output", (event) => {
          if (event.payload.terminalId === terminalId) {
            handlers.onOutput(event.payload.data);
          }
        }).then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        });
        void listen<{ terminalId: string; exitCode: number | null }>("terminal://exit", (event) => {
          if (event.payload.terminalId === terminalId) {
            handlers.onExit?.(event.payload.exitCode);
          }
        }).then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        });
        return () => {
          disposed = true;
          for (const unlisten of unlisteners.splice(0)) {
            unlisten();
          }
        };
      },
    }),
    [],
  );

  const fileService = useMemo<WorkbenchFileService>(
    () => ({
      async list(session: WorkbenchAgentSessionContext, path?: string) {
        return await invoke("list_directory", { path: path || session.workspaceRoot });
      },
      async search(session: WorkbenchAgentSessionContext, query: string) {
        return await invoke<WorkbenchFileSearchResult[]>("files_search", {
          request: {
            sessionId: session.sessionId,
            workspaceRoot: session.workspaceRoot,
            query,
            maxResults: 80,
          },
        });
      },
      async watchStart(session: WorkbenchAgentSessionContext) {
        await invoke("files_watch_start", {
          request: { sessionId: session.sessionId, workspaceRoot: session.workspaceRoot },
        });
      },
      async watchStop(session: WorkbenchAgentSessionContext) {
        await invoke("files_watch_stop", {
          request: { sessionId: session.sessionId, workspaceRoot: session.workspaceRoot },
        });
      },
      subscribeChanged(session: WorkbenchAgentSessionContext, handler: (paths: string[]) => void) {
        const unlisteners: Array<() => void> = [];
        let disposed = false;
        void listen<{ sessionId: string; paths: string[] }>("files://changed", (event) => {
          if (event.payload.sessionId === session.sessionId) {
            handler(event.payload.paths);
          }
        }).then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        });
        return () => {
          disposed = true;
          for (const unlisten of unlisteners.splice(0)) {
            unlisten();
          }
        };
      },
    }),
    [],
  );

  async function readAgentStyle(kind: string): Promise<WorkbenchAgentStyleState> {
    const result = await invoke<{
      content: string;
      source: "global" | "workspace" | "none";
      filePath?: string;
    }>("read_agent_style", {
      kind,
      workspacePath: workspacePath.trim() || null,
    });
    return {
      kind,
      currentStyle: result.content,
      source: result.source,
      filePath: result.filePath,
    };
  }

  async function saveAgentStyle(kind: string, content: string): Promise<WorkbenchAgentStyleState> {
    await invoke("write_agent_style", {
      kind,
      content,
      workspacePath: workspacePath.trim() || null,
    });
    return readAgentStyle(kind);
  }

  async function resetAgentStyle(kind: string): Promise<WorkbenchAgentStyleState> {
    await invoke("write_agent_style", {
      kind,
      content: "",
      workspacePath: workspacePath.trim() || null,
    });
    return readAgentStyle(kind);
  }

  return (
    <div className="javis-desktop-frame">
      <TitleBar
        currentWindow={currentWindow}
        onDragError={(error) => logNonFatalError("Window drag failed", error)}
      />
      <ErrorBoundary>
      {aiConfigPrompt ? (
        <div className="javis-ai-config-modal-backdrop" role="presentation">
          <section
            aria-label={aiConfigPrompt.title}
            aria-modal="true"
            className="javis-ai-config-modal"
            role="dialog"
          >
            <h2>{aiConfigPrompt.title}</h2>
            <p>{aiConfigPrompt.message}</p>
            <div className="javis-ai-config-modal-actions">
              <button onClick={() => setAiConfigPrompt(null)} type="button">
                我知道了
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {isDatabaseInitializing ? (
        <div className="javis-database-loading" role="status">
          <strong>Javis 正在恢复工作区</strong>
          <span>正在初始化数据库、迁移旧数据并恢复历史会话...</span>
        </div>
      ) : null}
      <JavisWorkbench
        activeHistoryEntryId={activeHistoryEntryId}
        activeView={activeView}
        appsError={appsError}
        appsLoading={appsLoading}
        appsProgress={appsProgress}
        computerEntries={computerEntries}
        computerError={computerError}
        computerLoading={computerLoading}
        computerPath={computerPath}
        docsError={docsError}
        docsLoading={docsLoading}
        docsProgress={docsProgress}
        draftGoal={draftGoal}
        currentGoal={currentGoal}
        currentGoalEvents={currentGoalEvents}
        currentGoalEvaluations={currentGoalEvaluations}
        currentWorkspacePath={workspacePath}
        historyEntries={history.map((entry) => ({
          id: entry.id,
          title: entry.title,
          status: entry.status,
          userGoal: entry.userGoal,
          updatedAt: getTaskUpdatedAt(entry),
          originMode: entry.originMode,
          workspacePath: getTaskWorkspacePath(entry),
          scheduledTaskId: entry.scheduledTaskId,
        }))}
        imagesError={imagesError}
        imagesLoading={imagesLoading}
        imagesProgress={imagesProgress}
        initialActivityHeight={prefActivityHeight}
        initialIsActivityOpen={prefIsActivityOpen}
        initialIsInspectorOpen={prefIsInspectorOpen}
        initialIsSidebarOpen={prefIsSidebarOpen}
        initialSidebarWidth={prefSidebarWidth}
        installedApps={installedApps}
        isTaskActive={isTaskActive}
        agentCatalog={agentCatalog}
        locale={effectiveLocale}
        modelSettings={modelSettings}
        computerUseSettings={computerUseSettings}
        computerUseLocalVisionSettings={computerUseLocalVisionSettings}
        runtimePreferences={runtimePreferences}
        newChatRecommendations={newChatRecommendations}
        userProfileMemorySummary={userProfileMemorySummary}
        agentMemorySummary={agentMemorySummary}
        onBrowseWorkspacePath={browseWorkspacePath}
        onChangeActiveView={handleChangeActiveView}
        onSelectComposeMode={setComposeMode}
        activeComposeMode={composeMode}
        onDeleteHistoryEntry={deleteHistoryEntry}
        onDeleteRecentWorkspacePath={deleteRecentWorkspacePath}
        onDeleteScheduledTask={confirmDeleteScheduledTask}
        onCreateScheduledTask={handleCreateScheduledTask}
        onDraftGoalChange={setDraftGoal}
        onPauseGoal={handlePauseGoal}
        onResumeGoal={handleResumeGoal}
        onCompleteGoal={handleCompleteGoal}
        onClearGoal={handleClearGoal}
        onModelSettingsChange={async (settings) => {
          await updateModelSettings(settings);
          void modelSettingsRepoRef.current?.save(settings);
        }}
        onTestModelConnection={testModelConnection}
        modelConfiguration={modelConfiguration}
        onModelConfigurationChange={handleModelConfigurationChange}
        onComputerUseSettingsChange={handleComputerUseSettingsChange}
        onComputerUseLocalVisionSettingsChange={handleComputerUseLocalVisionSettingsChange}
        onRuntimePreferencesChange={handleRuntimePreferencesChange}
        onRebuildUserProfileMemory={handleRebuildUserProfileMemory}
        onClearUserProfileMemory={handleClearUserProfileMemory}
        onAgentMemoryEnabledChange={handleAgentMemoryEnabledChange}
        onClearAgentMemory={handleClearAgentMemory}
        onClearWorkspaceAgentMemory={handleClearWorkspaceAgentMemory}
        onDeleteAgentMemoryFact={handleDeleteAgentMemoryFact}
        onReadAgentStyle={readAgentStyle}
        onSaveAgentStyle={saveAgentStyle}
        onResetAgentStyle={resetAgentStyle}
        onSaveProviderApiKey={async (keyReference, apiKey) => {
          await invoke("save_model_api_key_secret", {
            request: { keyReference, apiKey },
          });
        }}
        onFetchProviderModels={fetchProviderModels}
        providerCatalog={providerCatalog}
        getProviderCapabilities={getProviderCapabilities}
        onNavigateDirectory={handleNavigateDirectory}
        onListDirectory={handleListDirectory}
        onOpenFile={handleOpenFile}
        onPermissionDecision={
          task.id.startsWith("restored-approval-")
            ? (decision) => {
                void resolveRestoredApproval(decision === "approved_always" ? "approved" : decision);
              }
            : handlePermissionDecision
        }
        onAskUserAnswer={handleAskUserAnswer}
        onConversationMessagesChange={handleConversationMessagesChange}
        onRefreshApps={handleRefreshApps}
        onUpdateAppCategory={handleUpdateAppCategory}
        onUpdateFileCategory={handleUpdateFileCategory}
        onRefreshDocuments={handleRefreshDocuments}
        onRefreshImages={handleRefreshImages}
        onRetryTask={retryCurrentTask}
        onStopTask={handleStopTask}
        onEmergencyStopTask={handleEmergencyStopTask}
        onSelectHistoryEntry={selectHistoryEntry}
        onSubmitGoal={handleWorkbenchSubmitGoal}
        onToggleScheduledTask={toggleScheduledTask}
        onUseWorkspacePath={useWorkspacePath}
        onWorkspacePathChange={useWorkspacePath}
        onSidebarWidthChange={(width) => {
          setPrefSidebarWidth(width);
          if (sidebarWidthTimerRef.current) clearTimeout(sidebarWidthTimerRef.current);
          sidebarWidthTimerRef.current = setTimeout(() => {
            persistPreference(PREF_KEYS.SIDEBAR_WIDTH, String(width));
          }, 300);
        }}
        onActivityHeightChange={(height) => {
          setPrefActivityHeight(height);
          if (activityHeightTimerRef.current) clearTimeout(activityHeightTimerRef.current);
          activityHeightTimerRef.current = setTimeout(() => {
            persistPreference(PREF_KEYS.ACTIVITY_HEIGHT, String(height));
          }, 300);
        }}
        onActiveViewChange={(view) => {
          persistPreference(PREF_KEYS.ACTIVE_VIEW, view);
        }}
        onSidebarOpenChange={(open) => {
          setPrefIsSidebarOpen(open);
          persistPreference(PREF_KEYS.IS_SIDEBAR_OPEN, String(open));
        }}
        onActivityOpenChange={(open) => {
          setPrefIsActivityOpen(open);
          persistPreference(PREF_KEYS.IS_ACTIVITY_OPEN, String(open));
        }}
        onInspectorOpenChange={(open) => {
          setPrefIsInspectorOpen(open);
          persistPreference(PREF_KEYS.IS_INSPECTOR_OPEN, String(open));
        }}
        recentWorkspacePaths={recentWorkspacePaths}
        scheduledTasks={scheduledTasks.map((t) =>
          scheduledTaskToWorkbench(t, history, activeScheduledTaskId),
        )}
        skillEntries={skillEntries}
        skillTranslationStatus={skillTranslationStatus}
        skillTranslationError={skillTranslationError}
        skillSearchResults={skillSearchResults}
        skillSearchStatus={skillSearchStatus}
        skillMarketSuggestions={skillMarketSuggestions}
        skillMarketSuggestionStatus={skillMarketSuggestionStatus}
        mcpConfigError={mcpConfigError}
        onTranslateSkillsToChinese={handleTranslateSkillsToChinese}
        onSearchSkillMarket={handleSearchSkillMarket}
        onRefreshSkillMarketSuggestions={handleRefreshSkillMarketSuggestions}
        onToggleSkillEnabled={handleToggleSkillEnabled}
        onDeleteSkill={handleDeleteSkill}
        onDisableAllSkills={handleDisableAllSkills}
        onDeleteAllSkills={handleDeleteAllSkills}
        onInstallSkillMarketResult={handleInstallSkillMarketResult}
        onOpenUrl={handleOpenUrl}
        sidebarNavItems={sidebarNavItems}
        systemResources={systemResources}
        task={task}
        userDocuments={userDocuments}
        userImages={displayUserImages}
        scanning={scanning}
        scanProgress={scanProgress}
        classifying={classifying}
        classifyProgress={classifyProgress}
        classifyError={classifyError}
        appsClassifying={appsClassifying}
        appsClassifyProgress={appsClassifyProgress}
        appsClassifyError={appsClassifyError}
        mountRoots={mountRoots}
        workspaceToolRequest={workspaceToolRequest}
        categoryStats={categoryStats}
        appCategoryStats={appCategoryStats}
        resourceScanRoots={resourceScanRoots}
        onRefreshScan={handleRefreshScan}
        onRefreshResourceRoots={handleRefreshResourceRoots}
        onClassifyDocuments={handleClassifyDocuments}
        onClassifyApps={handleClassifyApps}
        onCancelClassify={handleCancelClassify}
        onCancelClassifyApps={handleCancelClassifyApps}
        onToggleScanRoot={handleToggleScanRoot}
        onRemoveScanRoot={handleRemoveScanRoot}
        onAddScanRoot={handleAddScanRoot}
        onRefreshScanRoot={handleRefreshScanRoot}
        trustedComputerApps={trustedComputerApps}
        onRemoveTrustedComputerApp={handleRemoveTrustedComputerApp}
        terminalService={terminalService}
        fileService={fileService}
        onQuickActionBrowser={async (session, request): Promise<BrowserQuickResult> => {
          const actionRequest: BrowserQuickRequest = typeof request === "string"
            ? { action: "navigate", url: request }
            : request;
          const sessionRequest = { sessionId: session.sessionId, allowLocalhost: true };
          const normalize = (value: Partial<BrowserQuickResult>): BrowserQuickResult => ({
            url: value.url ?? "",
            title: value.title,
            content: value.content,
            screenshotDataUrl: value.screenshotDataUrl,
            loadState: value.loadState,
            sidecarRunning: value.sidecarRunning,
            canGoBack: value.canGoBack,
            canGoForward: value.canGoForward,
          });
          const snapshot = async (fallback: BrowserQuickResult): Promise<BrowserQuickResult> => {
            try {
              const nextSnapshot = await invoke<BrowserQuickResult>("browser_snapshot", {
                request: sessionRequest,
              });
              return normalize({
                ...fallback,
                ...nextSnapshot,
                url: nextSnapshot.url || fallback.url,
                title: nextSnapshot.title || fallback.title,
                loadState: nextSnapshot.loadState || fallback.loadState,
              });
            } catch {
              return normalize({
                ...fallback,
                loadState: fallback.loadState || "snapshot unavailable",
              });
            }
          };

          if (actionRequest.action === "status") {
            return normalize(await invoke<BrowserQuickResult>("browser_status", {
              request: sessionRequest,
            }));
          }
          if (actionRequest.action === "refresh") {
            return snapshot(normalize(await invoke<BrowserQuickResult>("browser_refresh", {
              request: sessionRequest,
            })));
          }
          if (actionRequest.action === "back") {
            return snapshot(normalize(await invoke<BrowserQuickResult>("browser_go_back", {
              request: sessionRequest,
            })));
          }
          if (actionRequest.action === "forward") {
            return snapshot(normalize(await invoke<BrowserQuickResult>("browser_go_forward", {
              request: sessionRequest,
            })));
          }

          const nextUrl = actionRequest.url;
          if (!nextUrl) {
            throw new Error("Browser URL is required.");
          }
          return snapshot(normalize(await invoke<BrowserQuickResult>("browser_navigate", {
            request: { ...sessionRequest, url: nextUrl },
          })));
        }}
        pendingBrowserWriteApproval={pendingBrowserWriteApproval}
        onApproveBrowserWrite={async (_session, approvalId) => {
          resolveBrowserWriteApproval(approvalId, "approved");
        }}
        onDenyBrowserWrite={async (_session, approvalId) => {
          resolveBrowserWriteApproval(approvalId, "denied");
        }}
        onQuickActionReview={async (session) => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before opening review.");
          }
          const [status, diff, remoteSummary, pullRequests, pushPreview] = await Promise.all([
            invoke<{
              files: Array<{ path: string }>;
              diffStat: string;
              workspaceRoot: string;
              branch?: string;
            }>("git_status", {
              request: { sessionId: session.sessionId, workspaceRoot: root },
            }),
            invoke<{ diff: string }>("git_diff", {
              request: { sessionId: session.sessionId, workspaceRoot: root },
            }),
            invoke<{
              branch?: string;
              upstream?: string;
              upstreamRemote?: string;
              ahead?: number;
              behind?: number;
              remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
            }>("git_remote_summary", {
              request: { sessionId: session.sessionId, workspaceRoot: root },
            }).catch(() => undefined),
            invoke<{
              provider: string;
              unavailableReason?: string;
              pullRequests: Array<{
                number: number;
                title: string;
                state: string;
                url: string;
                author?: string;
                headRefName?: string;
                baseRefName?: string;
                updatedAt?: string;
              }>;
            }>("git_list_pull_requests", {
              request: { sessionId: session.sessionId, workspaceRoot: root },
            }).catch((error) => ({
              provider: "github-cli",
              unavailableReason: error instanceof Error ? error.message : String(error),
              pullRequests: [],
            })),
            invoke<{
              branch: string;
              upstream: string;
              remoteName: string;
              remoteBranch: string;
              remoteUrl?: string;
              ahead: number;
              behind: number;
              commits: Array<{ hash: string; subject: string }>;
              dryRun: {
                operation: string;
                riskSummary: string;
                reversible: boolean;
                affectedPaths: Array<{
                  source: string;
                  target: string;
                  action: WorkbenchDryRunAction;
                  conflict?: string;
                }>;
              };
            }>("git_push_preview", {
              request: { sessionId: session.sessionId, workspaceRoot: root },
            }).catch(() => undefined),
          ]);
          return {
            changedFiles: status.files.map((file) => file.path),
            diffStat: status.diffStat,
            diff: diff.diff.slice(0, 4000),
            workspacePath: status.workspaceRoot,
            branch: remoteSummary?.branch ?? status.branch,
            upstream: remoteSummary?.upstream,
            upstreamRemote: remoteSummary?.upstreamRemote,
            ahead: remoteSummary?.ahead,
            behind: remoteSummary?.behind,
            remotes: remoteSummary?.remotes,
            pullRequests,
            pushPreview,
          };
        }}
        onQuickActionGitPushPlan={async (session): Promise<GitPushPlanQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before preparing a Git push.");
          }
          const plan = await invoke<GitPushPlanQuickResult>("git_plan_push", {
            request: {
              sessionId: session.sessionId,
              workspaceRoot: root,
              taskId: session.taskId,
            },
          });
          const permissionRequest = createGitPushPermissionRequest(plan);
          const approvalRecord = createApprovalRecordFromPermissionRequest({
            taskId: session.taskId ?? session.sessionId,
            toolName: GIT_PUSH_AUDIT_TOOL_NAME,
            workspacePath: root,
            permissionRequest,
            gitPushPlan: plan,
            now: permissionRequest.createdAt,
          });
          if (approvalRecord) {
            updateApprovalRecord(approvalRecord);
          }
          recordToolCallAudit(createGitPushPlanAuditRecord(session, plan));
          return plan;
        }}
        onQuickActionGitPushExecute={async (session, approvalId): Promise<GitPushExecutionQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before pushing.");
          }
          const startedAt = new Date().toISOString();
          try {
            await invoke("git_approve_push", {
              approvalId,
              taskId: session.taskId,
            });
            resolveApprovalRecordById(approvalId, "approved");
            const execution = await invoke<{
              workspaceRoot: string;
              branch: string;
              upstream: string;
              remoteName: string;
              remoteBranch: string;
              commitCount: number;
              pushed: boolean;
              output: string;
            }>("git_execute_push", {
              request: {
                approvalId,
                sessionId: session.sessionId,
                workspaceRoot: root,
                taskId: session.taskId,
              },
            });
            const result = {
              workspacePath: execution.workspaceRoot,
              branch: execution.branch,
              upstream: execution.upstream,
              remoteName: execution.remoteName,
              remoteBranch: execution.remoteBranch,
              commitCount: execution.commitCount,
              pushed: execution.pushed,
              output: execution.output,
            };
            recordToolCallAudit(createGitPushExecutionAuditRecord(session, approvalId, result, startedAt));
            return result;
          } catch (error) {
            recordToolCallAudit(createGitPushFailedAuditRecord(session, approvalId, error, startedAt));
            throw error;
          }
        }}
        onQuickActionGitPushCancel={async (_session, approvalId) => {
          resolveApprovalRecordById(approvalId, "denied");
        }}
        onQuickActionGitStagePlan={async (session, paths): Promise<GitStagePlanQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before preparing Git staging.");
          }
          const plan = await invoke<GitStagePlanQuickResult>("git_plan_stage_files", {
            request: {
              sessionId: session.sessionId,
              workspaceRoot: root,
              taskId: session.taskId,
              paths,
            },
          });
          const permissionRequest = createGitStagePermissionRequest(plan);
          const approvalRecord = createApprovalRecordFromPermissionRequest({
            taskId: session.taskId ?? session.sessionId,
            toolName: GIT_STAGE_AUDIT_TOOL_NAME,
            workspacePath: root,
            permissionRequest,
            gitStagePlan: plan,
            now: permissionRequest.createdAt,
          });
          if (approvalRecord) {
            updateApprovalRecord(approvalRecord);
          }
          recordToolCallAudit(createGitStagePlanAuditRecord(session, plan));
          return plan;
        }}
        onQuickActionGitStageExecute={async (session, approvalId, paths): Promise<GitStageExecutionQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before staging files.");
          }
          const startedAt = new Date().toISOString();
          try {
            await invoke("git_approve_stage_files", {
              approvalId,
              taskId: session.taskId,
            });
            resolveApprovalRecordById(approvalId, "approved");
            const execution = await invoke<{
              workspaceRoot: string;
              stagedPaths: string[];
              fileCount: number;
              staged: boolean;
              output: string;
            }>("git_execute_stage_files", {
              request: {
                approvalId,
                sessionId: session.sessionId,
                workspaceRoot: root,
                taskId: session.taskId,
                paths,
              },
            });
            const result = {
              workspacePath: execution.workspaceRoot,
              stagedPaths: execution.stagedPaths,
              fileCount: execution.fileCount,
              staged: execution.staged,
              output: execution.output,
            };
            recordToolCallAudit(createGitStageExecutionAuditRecord(session, approvalId, result, startedAt));
            return result;
          } catch (error) {
            recordToolCallAudit(createGitStageFailedAuditRecord(session, approvalId, error, startedAt));
            throw error;
          }
        }}
        onQuickActionGitStageCancel={async (_session, approvalId) => {
          resolveApprovalRecordById(approvalId, "denied");
        }}
        onQuickActionGitCommitPlan={async (session, message): Promise<GitCommitPlanQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before preparing a Git commit.");
          }
          const plan = await invoke<GitCommitPlanQuickResult>("git_plan_commit", {
            request: {
              sessionId: session.sessionId,
              workspaceRoot: root,
              taskId: session.taskId,
              message,
            },
          });
          const permissionRequest = createGitCommitPermissionRequest(plan);
          const approvalRecord = createApprovalRecordFromPermissionRequest({
            taskId: session.taskId ?? session.sessionId,
            toolName: GIT_COMMIT_APPROVAL_TOOL_NAME,
            workspacePath: root,
            permissionRequest,
            gitCommitPlan: plan,
            now: permissionRequest.createdAt,
          });
          if (approvalRecord) {
            updateApprovalRecord(approvalRecord);
          }
          recordToolCallAudit(createGitCommitPlanAuditRecord(session, plan));
          return plan;
        }}
        onQuickActionGitCommitExecute={async (session, approvalId, message): Promise<GitCommitExecutionQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before committing.");
          }
          const startedAt = new Date().toISOString();
          try {
            await invoke("git_approve_commit", {
              approvalId,
              taskId: session.taskId,
            });
            resolveApprovalRecordById(approvalId, "approved");
            const execution = await invoke<{
              workspaceRoot: string;
              branch?: string;
              commitHash: string;
              subject: string;
              fileCount: number;
              committed: boolean;
              output: string;
            }>("git_execute_commit", {
              request: {
                approvalId,
                sessionId: session.sessionId,
                workspaceRoot: root,
                taskId: session.taskId,
                message,
              },
            });
            const result = {
              workspacePath: execution.workspaceRoot,
              branch: execution.branch,
              commitHash: execution.commitHash,
              subject: execution.subject,
              fileCount: execution.fileCount,
              committed: execution.committed,
              output: execution.output,
            };
            recordToolCallAudit(createGitCommitExecutionAuditRecord(session, approvalId, result, startedAt));
            return result;
          } catch (error) {
            recordToolCallAudit(createGitCommitFailedAuditRecord(session, approvalId, error, startedAt));
            throw error;
          }
        }}
        onQuickActionGitCommitCancel={async (_session, approvalId) => {
          resolveApprovalRecordById(approvalId, "denied");
        }}
        onQuickActionGitCreatePullRequestPlan={async (session, request): Promise<GitCreatePullRequestPlanQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before preparing a Git pull request.");
          }
          const plan = await invoke<GitCreatePullRequestPlanQuickResult>("git_plan_create_pull_request", {
            request: {
              sessionId: session.sessionId,
              workspaceRoot: root,
              taskId: session.taskId,
              title: request.title,
              body: request.body ?? "",
              baseBranch: request.baseBranch,
              draft: request.draft ?? true,
            },
          });
          const permissionRequest = createGitCreatePullRequestPermissionRequest(plan);
          const approvalRecord = createApprovalRecordFromPermissionRequest({
            taskId: session.taskId ?? session.sessionId,
            toolName: GIT_CREATE_PR_AUDIT_TOOL_NAME,
            workspacePath: root,
            permissionRequest,
            gitCreatePullRequestPlan: plan,
            now: permissionRequest.createdAt,
          });
          if (approvalRecord) {
            updateApprovalRecord(approvalRecord);
          }
          recordToolCallAudit(createGitCreatePullRequestPlanAuditRecord(session, plan));
          return plan;
        }}
        onQuickActionGitCreatePullRequestExecute={async (session, approvalId, request): Promise<GitCreatePullRequestExecutionQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before creating a Git pull request.");
          }
          const startedAt = new Date().toISOString();
          try {
            await invoke("git_approve_create_pull_request", {
              approvalId,
              taskId: session.taskId,
            });
            resolveApprovalRecordById(approvalId, "approved");
            const execution = await invoke<{
              workspaceRoot: string;
              provider: string;
              url: string;
              title: string;
              baseBranch: string;
              headBranch: string;
              draft: boolean;
              created: boolean;
              output: string;
            }>("git_execute_create_pull_request", {
              request: {
                approvalId,
                sessionId: session.sessionId,
                workspaceRoot: root,
                taskId: session.taskId,
                title: request.title,
                body: request.body ?? "",
                baseBranch: request.baseBranch,
                draft: request.draft ?? true,
              },
            });
            const result = {
              workspacePath: execution.workspaceRoot,
              provider: execution.provider,
              url: execution.url,
              title: execution.title,
              baseBranch: execution.baseBranch,
              headBranch: execution.headBranch,
              draft: execution.draft,
              created: execution.created,
              output: execution.output,
            };
            recordToolCallAudit(createGitCreatePullRequestExecutionAuditRecord(session, approvalId, result, startedAt));
            return result;
          } catch (error) {
            recordToolCallAudit(createGitCreatePullRequestFailedAuditRecord(session, approvalId, error, startedAt));
            throw error;
          }
        }}
        onQuickActionGitCreatePullRequestCancel={async (_session, approvalId) => {
          resolveApprovalRecordById(approvalId, "denied");
        }}
        onQuickActionGitCommentPullRequestPlan={async (session, request): Promise<GitCommentPullRequestPlanQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before preparing a Git pull request comment.");
          }
          const plan = await invoke<GitCommentPullRequestPlanQuickResult>("git_plan_comment_pull_request", {
            request: {
              sessionId: session.sessionId,
              workspaceRoot: root,
              taskId: session.taskId,
              pullRequest: request.pullRequest,
              body: request.body,
            },
          });
          const permissionRequest = createGitCommentPullRequestPermissionRequest(plan);
          const approvalRecord = createApprovalRecordFromPermissionRequest({
            taskId: session.taskId ?? session.sessionId,
            toolName: GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
            workspacePath: root,
            permissionRequest,
            gitCommentPullRequestPlan: plan,
            now: permissionRequest.createdAt,
          });
          if (approvalRecord) {
            updateApprovalRecord(approvalRecord);
          }
          recordToolCallAudit(createGitCommentPullRequestPlanAuditRecord(session, plan));
          return plan;
        }}
        onQuickActionGitCommentPullRequestExecute={async (session, approvalId, request): Promise<GitCommentPullRequestExecutionQuickResult> => {
          const root = session.workspaceRoot;
          if (!root) {
            throw new Error("Select a workspace before commenting on a Git pull request.");
          }
          const startedAt = new Date().toISOString();
          try {
            await invoke("git_approve_comment_pull_request", {
              approvalId,
              taskId: session.taskId,
            });
            resolveApprovalRecordById(approvalId, "approved");
            const execution = await invoke<{
              workspaceRoot: string;
              provider: string;
              pullRequest: string;
              commented: boolean;
              output: string;
            }>("git_execute_comment_pull_request", {
              request: {
                approvalId,
                sessionId: session.sessionId,
                workspaceRoot: root,
                taskId: session.taskId,
                pullRequest: request.pullRequest,
                body: request.body,
              },
            });
            const result = {
              workspacePath: execution.workspaceRoot,
              provider: execution.provider,
              pullRequest: execution.pullRequest,
              commented: execution.commented,
              output: execution.output,
            };
            recordToolCallAudit(createGitCommentPullRequestExecutionAuditRecord(session, approvalId, result, startedAt));
            return result;
          } catch (error) {
            recordToolCallAudit(createGitCommentPullRequestFailedAuditRecord(session, approvalId, error, startedAt));
            throw error;
          }
        }}
        onQuickActionGitCommentPullRequestCancel={async (_session, approvalId) => {
          resolveApprovalRecordById(approvalId, "denied");
        }}
        onQuickActionSideChat={async (session, message: string) => {
          const sessionPrompt = [
            "You are Javis Commander in the Javis workbench.",
            "Never claim to be the underlying model, provider, vendor, lab, or training team.",
            "If asked who you are, answer as Javis or Javis Commander.",
            "",
            "Javis side chat context:",
            `workspaceRoot: ${session.workspaceRoot || "(none)"}`,
            `threadId: ${session.threadId}`,
            `taskId: ${session.taskId ?? "(none)"}`,
            `activeTool: ${session.activeTool ?? "(none)"}`,
            "",
            message,
          ].join("\n");
          const provider = createConfiguredModelProvider(modelSettings);
          const result = await provider.complete(sessionPrompt, {
            maxTokens: 800,
            temperature: 0.7,
            locale: localePreference,
            agentKind: "commander",
            workspacePath: session.workspaceRoot,
          });
          return result.text;
        }}
        onQuickActionTerminal={async (session, command: string) => {
          if (!session.workspaceRoot) {
            throw new Error("Select a workspace before running terminal commands.");
          }
          const parts = command.trim().split(/\s+/);
          const program = parts[0];
          const args = parts.slice(1);
          const result = await invoke<{
            stdout: string;
            stderr: string;
            exitCode: number;
            cwd: string;
          }>("run_read_only_command", {
            request: { program, args, workspacePath: session.workspaceRoot },
          });
          return {
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            cwd: result.cwd,
          };
        }}
      />
      </ErrorBoundary>
    </div>
  );
}

function applySkillTranslationCache(
  skills: WorkbenchSkillEntry[],
  cache: SkillTranslationCache,
): WorkbenchSkillEntry[] {
  return skills.map((skill) => {
    const translated = cache[skill.id];
    if (!translated || translated.sourceSignature !== getSkillTranslationSourceSignature(skill)) {
      return skill;
    }
    return {
      ...skill,
      name: translated.name || skill.name,
      description: translated.description || skill.description,
      agentOwners: translated.agentOwners?.length ? translated.agentOwners : skill.agentOwners,
    };
  });
}

function buildSkillEntries(
  mcpConfig: McpServerConfig[],
  userSkills: UserSkillSummary[] = [],
  codexMcpServers: CodexMcpServerSummary[] = [],
  disabledBuiltinToolNames: ReadonlySet<string> = new Set(),
  mcpDiscoveryErrors: Record<string, string> = {},
): WorkbenchSkillEntry[] {
  const tools: WorkbenchSkillEntry[] = initialToolDescriptors.map((descriptor) => {
    const owners = demoAgents
      .filter((agent) => agent.allowedToolNames.includes(descriptor.name))
      .map((agent) => agent.displayName);
    const hardDisabled = isDisabledBrowserWriteToolName(descriptor.name);
    const toggleable = isBuiltinToolToggleable(descriptor.name);
    return {
      id: descriptor.name,
      name: descriptor.name,
      description: descriptor.summary,
      category: "tool",
      permissionLevel: descriptor.permissionLevel,
      agentOwners: owners,
      enabled: !hardDisabled && !disabledBuiltinToolNames.has(descriptor.name),
      source: "builtin",
      toggleable,
    };
  });
  const agents: WorkbenchSkillEntry[] = demoAgents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    description: agent.description,
    category: "agent",
    agentOwners: [],
    enabled: true,
    source: "builtin",
  }));
  const skills: WorkbenchSkillEntry[] = userSkills.map((skill) => ({
    id: `skill-${skill.id}`,
    name: skill.name,
    description: skill.description,
    category: "skill",
    agentOwners: [`${getSkillSourceLabel(skill.source)} skill`],
    enabled: skill.enabled,
    source: "user",
    path: skill.path,
    toggleable: skill.toggleable,
    removable: skill.removable,
  }));
  const mcps: WorkbenchSkillEntry[] = mcpConfig.map((server) => ({
    id: `mcp-${server.name}`,
    name: server.name,
    description: `${server.transport} · ${server.command ?? server.url ?? ""}`,
    category: "mcp",
    agentOwners: [],
    enabled: isExecutableMcpServer(server),
    source: "mcp",
    toggleable: isRunnableMcpServerConfig(server),
    removable: true,
    installError: mcpDiscoveryErrors[mcpRuntimeServerKey({ source: "javis", name: server.name })],
  }));
  const codexMcps: WorkbenchSkillEntry[] = codexMcpServers.map((server) => ({
    id: codexMcpSkillEntryId(server.source, server.name),
    name: server.name,
    description: `${server.transport} · ${server.command ?? server.url ?? ""}`,
    category: "mcp",
    agentOwners: [`${server.source} MCP`],
    enabled: isExecutableMcpServer(server),
    source: "mcp",
    toggleable: isRunnableMcpServerConfig(server),
    removable: server.removable,
    installError: mcpDiscoveryErrors[mcpRuntimeServerKey(server)],
  }));
  return [...tools, ...skills, ...agents, ...mcps, ...codexMcps];
}

function codexMcpSkillEntryId(source: string, name: string): string {
  return `codex-mcp-${encodeMcpToolServerName(`${source}:${name}`)}`;
}

function parseCodexMcpSkillEntryId(id: string): { source: string; name: string } | null {
  const encoded = id.startsWith("codex-mcp-") ? id.slice("codex-mcp-".length) : "";
  if (!encoded) return null;
  const decoded = decodeMcpToolServerName(encoded);
  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    return decoded ? { source: "codex", name: decoded } : null;
  }
  const source = decoded.slice(0, separator);
  const name = decoded.slice(separator + 1);
  return source && name ? { source, name } : null;
}

function isBuiltinToolToggleable(toolName: string): boolean {
  return (
    initialToolDescriptors.some((descriptor) => descriptor.name === toolName) &&
    !BUILTIN_TOOL_LOCKED_NAMES.has(toolName) &&
    !isDisabledBrowserWriteToolName(toolName)
  );
}

function getSkillSourceLabel(source: string): string {
  if (source === "javis") return "Javis";
  if (source === "codex") return "Codex";
  if (source === "codex-system") return "Codex System";
  if (source === "agents") return "Agents";
  const externalMatch = source.match(/^external(\d+)?$/);
  if (externalMatch) {
    return externalMatch[1] ? `External ${externalMatch[1]}` : "External";
  }
  return source;
}

function getEnabledToolDescriptors(
  disabledBuiltinToolNames: ReadonlySet<string>,
  mcpConfig: readonly McpServerConfig[] = [],
  codexMcpServers: readonly CodexMcpServerSummary[] = [],
  mcpToolDescriptors: readonly ToolDescriptor[] = [],
  mcpDiscoveryErrors: Readonly<Record<string, string>> = {},
) {
  return [
    ...getEnabledBuiltinToolDescriptors(disabledBuiltinToolNames),
    ...getEnabledMcpToolDescriptors(mcpConfig, codexMcpServers, mcpToolDescriptors, mcpDiscoveryErrors),
  ];
}

function getEnabledBuiltinToolDescriptors(disabledBuiltinToolNames: ReadonlySet<string>) {
  return initialToolDescriptors.filter((descriptor) =>
    !isDisabledBrowserWriteToolName(descriptor.name) &&
    !disabledBuiltinToolNames.has(descriptor.name)
  );
}

function getEnabledMcpToolDescriptors(
  mcpConfig: readonly McpServerConfig[],
  codexMcpServers: readonly CodexMcpServerSummary[],
  mcpToolDescriptors: readonly ToolDescriptor[],
  mcpDiscoveryErrors: Readonly<Record<string, string>>,
) {
  const descriptors = new Map<string, ToolDescriptor>();
  const servers = buildMcpRuntimeServers(mcpConfig, codexMcpServers);
  const enabledServerKeys = new Set<string>();
  for (const server of servers) {
    if (!isExecutableMcpServer(server)) continue;
    const key = mcpRuntimeServerKey(server);
    if (mcpDiscoveryErrors[key]) continue;
    enabledServerKeys.add(key);
    const descriptor = buildMcpListToolsDescriptor(server);
    if (descriptor) {
      descriptors.set(descriptor.name, descriptor);
    }
  }
  for (const descriptor of mcpToolDescriptors) {
    const key = getMcpDescriptorServerKey(descriptor);
    if (key && enabledServerKeys.has(key)) {
      descriptors.set(descriptor.name, descriptor);
    }
  }
  return [...descriptors.values()];
}

function buildMcpRuntimeServers(
  mcpConfig: readonly McpServerConfig[],
  codexMcpServers: readonly CodexMcpServerSummary[],
): McpRuntimeServerConfig[] {
  return [
    ...mcpConfig.map((server) => ({ ...server, source: "javis" })),
    ...codexMcpServers,
  ];
}

function getMcpDescriptorServerKey(descriptor: ToolDescriptor): string | null {
  const serverName = typeof descriptor.metadata?.mcpServerName === "string"
    ? descriptor.metadata.mcpServerName
    : "";
  const source = typeof descriptor.metadata?.mcpSource === "string"
    ? descriptor.metadata.mcpSource
    : "";
  return serverName && source ? `${source}:${serverName}` : null;
}

function dedupeToolDescriptors(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  const byName = new Map<string, ToolDescriptor>();
  for (const descriptor of descriptors) {
    byName.set(descriptor.name, descriptor);
  }
  return [...byName.values()];
}

function parseDisabledBuiltinToolNames(value: string | null): Set<string> {
  if (!value) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item): item is string => isBuiltinToolToggleable(item)));
  } catch {
    return new Set();
  }
}

function loadPreference(key: string): string | null {
  const pendingValue = loadPendingPreferencesFromLocalStorage()[key];
  if (pendingValue !== undefined) {
    return pendingValue;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem("javis.userPreferences.v1");
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const value = (parsed as Record<string, unknown>)[key];
    return value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

function serializeDisabledBuiltinToolNames(value: ReadonlySet<string>): string {
  return JSON.stringify([...value].filter(isBuiltinToolToggleable).sort());
}

function buildSkillMarketSuggestionKeywords(
  userProfileMemorySummary: WorkbenchUserProfileMemorySummary | null,
  agentMemorySummary: WorkbenchAgentMemorySummary | null,
): string[] {
  const scores = new Map<string, number>();
  for (const tag of userProfileMemorySummary?.topTags ?? []) {
    addSkillMarketKeyword(scores, tag, 8);
  }
  for (const fact of userProfileMemorySummary?.facts ?? []) {
    for (const tag of fact.tags) {
      addSkillMarketKeyword(scores, tag, 5);
    }
    addSkillMarketKeyword(scores, fact.text, 2 + fact.confidence + Math.min(fact.hitCount, 3));
  }
  for (const fact of agentMemorySummary?.recentFacts ?? []) {
    for (const tag of fact.tags) {
      addSkillMarketKeyword(scores, tag, 4);
    }
    addSkillMarketKeyword(scores, fact.fact, 2 + fact.importance + fact.confidence);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword]) => keyword)
    .slice(0, SKILL_MARKET_MEMORY_KEYWORD_LIMIT);
}

function buildSkillMarketSuggestionQueries(kind: WorkbenchSkillSearchKind): string[] {
  const recentPush = getRecentGithubPushQualifier();
  const focusedKindTerms = kind === "mcp"
    ? ["mcp", "server", "modelcontextprotocol"]
    : ["ai", "agent", "automation"];
  const broadKindTerms = kind === "mcp"
    ? ["mcp", "server"]
    : ["developer", "tool"];
  return [
    [...focusedKindTerms, "stars:>50", recentPush].join(" "),
    [...broadKindTerms, "stars:>200", recentPush].join(" "),
    [...focusedKindTerms, "stars:>500", recentPush].join(" "),
  ].map((query) => query.trim()).filter((query, index, all) => query && all.indexOf(query) === index);
}

function addSkillMarketKeyword(scores: Map<string, number>, value: string, score: number) {
  for (const keyword of extractSkillMarketKeywords(value)) {
    scores.set(keyword, (scores.get(keyword) ?? 0) + score);
  }
}

function extractSkillMarketKeywords(value: string): string[] {
  const matches = value.match(/[A-Za-z][A-Za-z0-9+#._-]{2,}|[\u4e00-\u9fff]{2,10}/g) ?? [];
  return matches
    .map(normalizeSkillMarketKeyword)
    .filter((keyword): keyword is string => Boolean(keyword));
}

function normalizeSkillMarketKeyword(value: string): string | null {
  const trimmed = value.trim().replace(/^#+/, "").replace(/[_-]+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 28) {
    return null;
  }
  const keyword = /^[\x00-\x7F]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  if (SKILL_MARKET_KEYWORD_STOPWORDS.has(keyword)) {
    return null;
  }
  return keyword;
}

function getRecentGithubPushQualifier(): string {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  return `pushed:>${since.toISOString().slice(0, 10)}`;
}

function rankSkillMarketSuggestionResults(
  results: SearchWebSourceResult[],
  keywords: string[],
): SearchWebSourceResult[] {
  if (keywords.length === 0) {
    return results;
  }
  return results
    .map((result, index) => ({
      result,
      index,
      score: getSkillSuggestionMatchedKeywords(result, keywords).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.result);
}

function getSkillSuggestionMatchedKeywords(
  result: SearchWebSourceResult,
  keywords: string[],
): string[] {
  if (keywords.length === 0) {
    return [];
  }
  const haystack = `${result.title ?? ""} ${result.excerpt} ${result.url}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function normalizeSkillSuggestionTitle(title: string | undefined, url: string): string {
  const trimmed = title?.trim();
  if (trimmed) {
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
  }
  const repo = githubRepoParts(url, "SKILL.md") ?? githubRepoParts(url, "package.json");
  return repo ? `${repo.owner}/${repo.repo}` : url;
}

function buildSkillSuggestionDescription(excerpt: string, keywords: string[]): string {
  const summary = excerpt.trim() || "GitHub 热门项目";
  const compactSummary = summary.length > 96 ? `${summary.slice(0, 93)}...` : summary;
  const memoryHint = keywords.slice(0, 2).join(" / ");
  return memoryHint ? `${compactSummary} · 贴合：${memoryHint}` : compactSummary;
}

function isSkillSearchResultInstalled(
  url: string,
  title: string | undefined,
  kind: WorkbenchSkillSearchKind,
  userSkills: UserSkillSummary[],
  mcpConfig: McpServerConfig[],
  codexMcpServers: CodexMcpServerSummary[],
): boolean {
  if (kind === "skill") {
    const repoSkillDirName = skillDirNameFromGithubUrl(url);
    return repoSkillDirName
      ? userSkills.some((skill) => {
          const idParts = skill.id.split(":");
          return idParts[idParts.length - 1] === repoSkillDirName;
        })
      : false;
  }
  const titleName = title?.split('/').pop()?.trim();
  const repo = githubRepoParts(url, "package.json");
  const names = [
    titleName,
    titleName ? sanitizeName(titleName) : undefined,
    repo ? sanitizeName([repo.owner, repo.repo, ...repo.subdir].join("-")) : undefined,
    repo ? sanitizeName(repo.repo) : undefined,
  ].filter((name): name is string => Boolean(name));
  return [...mcpConfig, ...codexMcpServers].some((server) => names.includes(server.name));
}

function isSupportedSkillMarketUrl(url: string, kind: WorkbenchSkillSearchKind): boolean {
  return Boolean(githubRepoParts(url, kind === "mcp" ? "package.json" : "SKILL.md"));
}

function skillDirNameFromGithubUrl(url: string): string | null {
  const repo = githubRepoParts(url, "SKILL.md");
  if (!repo) return null;
  return sanitizeName([repo.owner, repo.repo, ...repo.subdir].join("-"));
}

function githubRepoParts(
  url: string,
  expectedBlobFileName: "SKILL.md" | "package.json",
): { owner: string; repo: string; subdir: string[] } | null {
  const githubPrefix = "https://github.com/";
  const trimmed = url.trim();
  if (!trimmed.startsWith(githubPrefix)) return null;
  const rawPath = trimmed.slice(githubPrefix.length).split(/[?#]/, 1)[0] ?? "";
  const parts = rawPath.split("/").filter(Boolean);
  const owner = sanitizeName(parts[0] ?? "");
  const repo = sanitizeName((parts[1] ?? "").replace(/\.git$/, ""));
  if (!owner || !repo) return null;
  if (parts.length === 2) {
    return { owner, repo, subdir: [] };
  }
  if (!["tree", "blob"].includes(parts[2] ?? "") || parts.length < 5) {
    return null;
  }
  const branch = sanitizeName(parts[3] ?? "");
  const rawSubdir = parts[2] === "blob"
    ? parts.slice(4, -1)
    : parts.slice(4);
  if (parts[2] === "blob" && parts[parts.length - 1] !== expectedBlobFileName) {
    return null;
  }
  const subdir = rawSubdir.map(sanitizeName).filter(Boolean);
  if (!branch) {
    return null;
  }
  return parts[2] === "blob" || subdir.length > 0 ? { owner, repo, subdir } : null;
}

function sanitizeName(value: string): string {
  return [...value].filter((ch) => /[A-Za-z0-9._-]/.test(ch)).join("").slice(0, 96);
}

function getSkillTranslationSourceSignature(skill: WorkbenchSkillEntry): string {
  return JSON.stringify({
    name: skill.name,
    description: skill.description,
    agentOwners: skill.agentOwners,
  });
}

function parseSkillTranslationCache(value: string): SkillTranslationCache {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: SkillTranslationCache = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      result[id] = {
        name: typeof candidate.name === "string" ? candidate.name : undefined,
        description: typeof candidate.description === "string" ? candidate.description : undefined,
        agentOwners: Array.isArray(candidate.agentOwners)
          ? candidate.agentOwners.filter((owner): owner is string => typeof owner === "string")
          : undefined,
        sourceSignature: typeof candidate.sourceSignature === "string" ? candidate.sourceSignature : undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function persistPendingPreferenceToLocalStorage(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const preferences = loadPendingPreferencesFromLocalStorage();
    window.localStorage.setItem(
      PENDING_USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...preferences, [key]: value }),
    );
  } catch (error) {
    console.warn(`Failed to persist pending preference "${key}" to localStorage`, error);
  }
}

function loadPendingPreferencesFromLocalStorage(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(PENDING_USER_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = String(value);
    }
    return result;
  } catch {
    return {};
  }
}

function removePendingPreferencesFromLocalStorage() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(PENDING_USER_PREFERENCES_STORAGE_KEY);
  } catch {
    // Pending preference cleanup should not block startup.
  }
}

export default App;
