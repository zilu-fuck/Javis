import { useEffect, useMemo, useRef, useState } from "react";
import {
  createInitialTaskSnapshot,
  getAdapter,
  hasImageAttachments,
  injectDocumentContext,
  PROVIDER_DEFINITIONS,
  type ChatMessage,
  type TaskSnapshot,
} from "@javis/core";
import { bridgeVisionIfNeeded } from "./vision-bridge";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
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
  WorkbenchAgentSessionContext,
  WorkbenchFileService,
  WorkbenchFileSearchResult,
  WorkbenchTerminalService,
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
import { createJavisRuntime, loadTrustedComputerApps, removeTrustedComputerApp } from "./app-runtime";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  CODE_PATCH_APPROVAL_TITLE,
  CODE_PATCH_APPROVAL_TOOL_NAME,
  applyRestoredCodePatch,
  createRestoredCodePatchApprovalTask,
  createRestoredCodePatchApprovedTask,
  createRestoredCodePatchDeniedTask,
  createRestoredCodePatchFailedTask,
  createRestoredPdfApprovalTask,
  createRestoredPdfApprovedTask,
  createRestoredPdfDeniedTask,
  createRestoredPdfFailedTask,
  findRestorableApprovalRecord,
  getDurableApprovalToolName,
  getDurableApprovalWorkspacePath,
  isDurableApprovalRequestTitle,
  runRestoredCodePatchVerification,
  runRestoredPdfOrganization,
} from "./restored-approval";
import { useModelSettingsControls } from "./use-model-settings";
import { createConfiguredModelProvider } from "./model-provider";
import { useModelProfiles, type ModelProfileRepositoryLike } from "./use-model-profiles";
import { useScannedData } from "./use-scanned-data";
import { useScheduledTasks } from "./use-scheduled-tasks";
import { useWorkspaceSessionControls } from "./use-workspace-session";
import {
  loadScheduledTasks,
  clearStaleGuards,
  type ScheduledTask,
} from "./scheduled-tasks";
import {
  createScheduledTasksRepository,
  SCHEDULED_TASKS_MIGRATIONS,
} from "./scheduled-tasks-persistence";
import { loadMcpConfig, type McpServerConfig } from "./mcp-config";
import {
  readFileChunk,
} from "./local-knowledge";
import {
  FILE_CLASSIFICATION_MIGRATIONS,
  createFileClassificationRepository,
  type FileClassificationRepository,
} from "./file-classification-persistence";
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
  appendTaskSnapshotAuditJsonLines,
  createFileBackedTaskAuditJsonLineWriter,
} from "./tool-call-audit";
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
import type { TrustedComputerApp } from "@javis/tools";
import { initialToolDescriptors } from "@javis/tools";
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
import { getBuiltinSidebarNavItems, mergeSidebarNavItems } from "@javis/ui";
import appIconUrl from "./assets/app-icon.png";
import "./App.css";

export const DEFAULT_DRAFT_GOAL = "";
const currentWindow =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? getCurrentWindow()
    : null;

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
  const matches = goal.match(/@([^\s,，。；;]+)/g);
  if (!matches) return [];
  return matches.map((raw) => {
    const path = raw.slice(1); // strip leading @
    return { raw, path };
  });
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

function logNonFatalError(context: string, error: unknown) {
  console.warn(context, error);
}

type SubmitGoalHandler = (goalOverride?: string, workspacePathOverride?: string, scheduledTaskId?: string) => void;

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

function App() {
  const databaseRef = useRef<DesktopDatabase | null>(null);
  const taskHistoryRepoRef = useRef<TaskHistoryRepositoryLike>(null);
  const workspaceSessionRepoRef = useRef<WorkspaceSessionRepository | null>(null);
  const approvalRecordsRepoRef = useRef<ReturnType<typeof createApprovalRecordsRepository> | null>(null);
  const modelSettingsRepoRef = useRef<ModelSettingsRepository | null>(null);
  const userProfileMemoryRepoRef = useRef<UserProfileMemoryRepository | null>(null);
  const scheduledTasksRepoRef = useRef<ScheduledTasksRepositoryLike>(null);
  const preferencesRepoRef = useRef<UserPreferencesRepository | null>(null);
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
  const { modelSettings, updateModelSettings } = useModelSettingsControls(window.localStorage);
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
  const runtime = useMemo(
    () => createJavisRuntime({
      modelSettings,
      getModelConfiguration: () => modelConfigRef.current,
      getWorkspacePath: () => workspaceRef.current,
      getScheduledTasksRepository: () => scheduledTasksRepoRef.current,
    }),
    [modelSettings],
  );
  const [history, setHistory] = useState<TaskSnapshot[]>(() =>
    loadTaskHistory(window.localStorage),
  );
  const [approvalRecords, setApprovalRecords] = useState(() =>
    loadApprovalRecords(window.localStorage),
  );
  const historyInitialRef = useRef(history);
  const historyCurrentRef = useRef(history);
  historyCurrentRef.current = history;
  const approvalRecordsInitialRef = useRef(approvalRecords);
  const approvalRecordsCurrentRef = useRef(approvalRecords);
  approvalRecordsCurrentRef.current = approvalRecords;
  const workspaceSessionInitialRef = useRef(workspaceSession);
  const workspaceSessionCurrentRef = useRef(workspaceSession);
  workspaceSessionCurrentRef.current = workspaceSession;
  const [areDurableApprovalRecordsReady, setDurableApprovalRecordsReady] = useState(false);
  const didCheckRestoredApproval = useRef(false);
  const didInitDatabaseRef = useRef(false);
  const auditRecordIdsRef = useRef(new Set<string>());
  const [draftGoal, setDraftGoal] = useState(DEFAULT_DRAFT_GOAL);
  const [composeMode, setComposeMode] = useState<"chat" | "project">("chat");
  const [aiConfigPrompt, setAiConfigPrompt] = useState<{ title: string; message: string } | null>(null);

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
    setScheduledTasks,
    persistWorkspaceForTask,
    persistDurableApprovalRecord,
    onTaskSnapshot: appendRuntimeJsonlLogs,
    taskHistoryRepoRef,
    scheduledTasksRepoRef,
    workspacePathRef: workspaceRef,
  });

  // ── Local knowledge base state ────────────────────────────────────
  const [skillEntries, setSkillEntries] = useState<WorkbenchSkillEntry[]>([]);
  const [skillTranslationCache, setSkillTranslationCache] = useState<SkillTranslationCache>({});
  const [skillTranslationStatus, setSkillTranslationStatus] =
    useState<"idle" | "translating" | "error">("idle");
  const [skillTranslationError, setSkillTranslationError] = useState<string | null>(null);
  const [skillSearchStatus, setSkillSearchStatus] =
    useState<"idle" | "searching" | "error">("idle");
  const [skillSearchResults, setSkillSearchResults] = useState<WorkbenchSkillSearchResult[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpServerConfig[]>([]);
  const [mcpConfigError, setMcpConfigError] = useState<string | null>(null);
  const [trustedComputerApps, setTrustedComputerApps] = useState<TrustedComputerApp[]>(
    () => loadTrustedComputerApps(),
  );

  const fileClassificationRepoRef = useRef<FileClassificationRepository | null>(null);
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
    mountRoots,
    categoryStats,
    handleRefreshApps,
    handleRefreshDocuments,
    handleRefreshImages,
    handleNavigateDirectory,
    handleListDirectory,
    handleRefreshScan,
    handleClassifyDocuments: runClassifyDocuments,
    handleCancelClassify,
    scanning,
  } = useScannedData({
    activeView,
    runtime,
    fileClassificationRepoRef,
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
    setSkillEntries(applySkillTranslationCache(buildSkillEntries(mcpConfig), skillTranslationCache));
  }, [mcpConfig, skillTranslationCache]);

  // Keep trusted computer apps in sync with localStorage writes from app-runtime.
  useEffect(() => {
    const handler = () => setTrustedComputerApps(loadTrustedComputerApps());
    window.addEventListener("javis:computer-trusted-apps-changed", handler);
    return () => window.removeEventListener("javis:computer-trusted-apps-changed", handler);
  }, []);

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

  async function handleTranslateSkillsToChinese() {
    if (skillTranslationStatus === "translating") {
      return;
    }
    setSkillTranslationStatus("translating");
    setSkillTranslationError(null);
    try {
      const sourceSkills = buildSkillEntries(mcpConfig);
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
        kind === "mcp" ? "MCP server" : "Codex skill",
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
        },
      });
      setSkillSearchResults(results.map((result, index) => ({
        id: `${result.url}-${index}`,
        title: result.title?.trim() || result.url,
        description: result.excerpt,
        url: result.url,
        source: result.provider || source,
        kind,
      })));
      setSkillSearchStatus("idle");
    } catch (error) {
      logNonFatalError("Failed to search skill market", error);
      setSkillSearchStatus("error");
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

  // ── Initialize SQLite database ────────────────────────────────────
  useEffect(() => {
    if (didInitDatabaseRef.current) {
      return;
    }
    didInitDatabaseRef.current = true;

    void (async () => {
      const database = invokeDesktopDatabase(invoke);
      databaseRef.current = database;

      // Run all schema migrations
      await runDesktopDatabaseMigrations(database, TASK_HISTORY_SCHEMA_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, RECENT_WORKSPACES_SCHEMA_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, MODEL_SETTINGS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, MODEL_PROFILES_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, APPROVAL_RECORDS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, TOOL_CALL_AUDIT_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, SCHEDULED_TASKS_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, USER_PREFERENCES_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, JSONL_LOG_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, FILE_CLASSIFICATION_MIGRATIONS);
      await runDesktopDatabaseMigrations(database, USER_PROFILE_MEMORY_MIGRATIONS);

      // One-time import from localStorage
      const taskHistoryRepo = createTaskHistoryRepository(database);
      const workspaceSessionRepo = createWorkspaceSessionRepository(database);
      const approvalRecordsRepo = createApprovalRecordsRepository(database);
      const modelSettingsRepo = createModelSettingsRepository(database);
      const modelProfileRepo = createModelProfileRepository(database);
      const userProfileMemoryRepo = createUserProfileMemoryRepository(database);

      taskHistoryRepoRef.current = taskHistoryRepo;
      workspaceSessionRepoRef.current = workspaceSessionRepo;
      approvalRecordsRepoRef.current = approvalRecordsRepo;
      modelSettingsRepoRef.current = modelSettingsRepo;
      modelProfileRepoRef.current = modelProfileRepo;
      userProfileMemoryRepoRef.current = userProfileMemoryRepo;

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

      const importedHistory = await taskHistoryRepo.importFromLocalStorage(window.localStorage);
      const importedWorkspaceSession = await workspaceSessionRepo.importFromLocalStorage(
        window.localStorage,
      );
      const importedApprovalRecords = await approvalRecordsRepo.importFromLocalStorage(
        window.localStorage,
      );
      const legacySettings = await modelSettingsRepo.importFromLocalStorage(window.localStorage);
      const importedUserProfileMemory = await userProfileMemoryRepo.importFromLocalStorage(window.localStorage);
      const loadedConfig = await modelProfileRepo.importFromLegacySettings(legacySettings);
      const cleanOverrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(loadedConfig.agentOverrides)) {
        if (value) cleanOverrides[key] = value;
      }
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

      if (historyCurrentRef.current === historyInitialRef.current) {
        setHistory(importedHistory);
      }
      if (workspaceSessionCurrentRef.current === workspaceSessionInitialRef.current) {
        replaceWorkspaceSession(importedWorkspaceSession);
      }
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
      if (importedPrefs[PREF_KEYS.LOCALE]) setLocalePreference(importedPrefs[PREF_KEYS.LOCALE]);
      if (importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]) setPrefSidebarWidth(Number(importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]));
      if (importedPrefs[PREF_KEYS.ACTIVITY_HEIGHT]) setPrefActivityHeight(Number(importedPrefs[PREF_KEYS.ACTIVITY_HEIGHT]));
      if (importedPrefs[PREF_KEYS.IS_SIDEBAR_OPEN]) setPrefIsSidebarOpen(importedPrefs[PREF_KEYS.IS_SIDEBAR_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN]) setPrefIsActivityOpen(importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN]) setPrefIsInspectorOpen(importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.SKILL_TRANSLATIONS_ZH]) {
        setSkillTranslationCache(parseSkillTranslationCache(importedPrefs[PREF_KEYS.SKILL_TRANSLATIONS_ZH]));
      }
      if (importedPrefs[PREF_KEYS.ACTIVE_VIEW]) {
        const validViews: ActiveView[] = ["chat", "automated", "skills", "apps", "documents", "gallery", "computer"];
        if (validViews.includes(importedPrefs[PREF_KEYS.ACTIVE_VIEW] as ActiveView)) {
          setActiveView(importedPrefs[PREF_KEYS.ACTIVE_VIEW] as ActiveView);
        }
      }

      // Import JSONL logs from localStorage into SQLite
      await importTaskSessionJsonlFromLocalStorage(database, window.localStorage);
      await importToolCallAuditJsonlFromLocalStorage(database, window.localStorage);

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
    clearQueuedTaskSnapshots();
    setTask(createRestoredPdfApprovalTask(pendingRecord));
  }, [approvalRecords, areDurableApprovalRecordsReady]);

  function submitGoal(goalOverride?: string, workspacePathOverride?: string, scheduledTaskId?: string, _attachments?: File[], imageDataUrls?: string[]) {
    const rawGoal = (goalOverride ?? draftGoal).trim();
    if (!rawGoal) {
      return;
    }
    if (!ensureAiConfigured(composeMode === "project" ? "Agent 模式" : "Chat 模式")) {
      return;
    }
    const continuationTask =
      !goalOverride && !workspacePathOverride && !scheduledTaskId
        ? activeHistoryEntryId
          ? historyCurrentRef.current.find((entry) => entry.id === activeHistoryEntryId)
          : isArchivableTask(task)
            ? task
            : undefined
        : undefined;
    const startOptions = continuationTask
      ? {
          taskId: continuationTask.id,
          priorMessages: getConversationMessages(continuationTask),
        }
      : undefined;
    const startMode =
      !goalOverride && !workspacePathOverride && !scheduledTaskId
        ? composeMode
        : undefined;
    const taskWorkspacePath =
      startMode === "project" || workspacePathOverride || scheduledTaskId
        ? workspacePathOverride ?? workspaceRef.current
        : undefined;
    clearQueuedTaskSnapshots();
    if (continuationTask) {
      setActiveHistoryEntryId(continuationTask.id);
    } else {
      setActiveHistoryEntryId(undefined);
    }
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
            const content = await readFileChunk(ref.path);
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
    runtime.stopTask();
    setIsTaskActive(false);
    isTaskActiveRef.current = false;
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

  async function resolveRestoredApproval(decision: "approved" | "denied") {
    const record = findRestorableApprovalRecord(approvalRecords);
    if (!record) {
      return;
    }
    if (record.toolName === CODE_PATCH_APPROVAL_TOOL_NAME) {
      await resolveRestoredCodePatchApproval(record, decision);
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
      (task.status === "waiting_permission" || task.status === "running") &&
      request?.status === "pending"
    ) {
      runtime.respondToAskUser(answer, request.id);
    }
  }

  function handleRemoveTrustedComputerApp(title: string) {
    setTrustedComputerApps(removeTrustedComputerApp(title));
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

  function handleChangeActiveView(view: ActiveView) {
    const shouldStartFreshChat =
      view === "chat" && (activeView !== "chat" || activeHistoryEntryId || task.id !== "task-idle");
    if (shouldStartFreshChat) {
      clearQueuedTaskSnapshots();
      setTask(createInitialTaskSnapshot());
      setActiveHistoryEntryId(undefined);
      setDraftGoal(DEFAULT_DRAFT_GOAL);
    }
    setActiveView(view);
  }

  function handleOpenFile(path: string) {
    openPath(path).catch((error) => logNonFatalError(`Failed to open path ${path}`, error));
  }

  const effectiveLocale = localePreference === "en" ? defaultWorkbenchLocale : zhCNWorkbenchLocale;
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

  const terminalService = useMemo<WorkbenchTerminalService>(
    () => ({
      async create(session: WorkbenchAgentSessionContext, cols: number, rows: number, terminalId?: string) {
        return await invoke("terminal_create", {
          request: {
            sessionId: session.sessionId,
            workspaceRoot: session.workspaceRoot,
            terminalId,
            permissionMode: session.permissionMode,
            cols,
            rows,
          },
        });
      },
      async input(terminalId: string, data: string) {
        await invoke("terminal_input", { request: { terminalId, data, permissionMode: "full_access" } });
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

  return (
    <div className="javis-desktop-frame">
      <TitleBar />
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
        locale={effectiveLocale}
        modelSettings={modelSettings}
        newChatRecommendations={newChatRecommendations}
        userProfileMemorySummary={userProfileMemorySummary}
        onBrowseWorkspacePath={browseWorkspacePath}
        onChangeActiveView={handleChangeActiveView}
        onSelectComposeMode={setComposeMode}
        activeComposeMode={composeMode}
        onDeleteHistoryEntry={deleteHistoryEntry}
        onDeleteRecentWorkspacePath={deleteRecentWorkspacePath}
        onDeleteScheduledTask={deleteScheduledTask}
        onDraftGoalChange={setDraftGoal}
        onModelSettingsChange={async (settings) => {
          await updateModelSettings(settings);
          void modelSettingsRepoRef.current?.save(settings);
        }}
        onTestModelConnection={testModelConnection}
        modelConfiguration={modelConfiguration}
        onModelConfigurationChange={handleModelConfigurationChange}
        onRebuildUserProfileMemory={handleRebuildUserProfileMemory}
        onClearUserProfileMemory={handleClearUserProfileMemory}
        onSaveProviderApiKey={async (keyReference, apiKey) => {
          await invoke("save_model_api_key_secret", {
            request: { keyReference, apiKey },
          });
        }}
        onFetchProviderModels={async ({ provider: _provider, baseUrl, apiKey, apiType, keyReference, modelListMode }) => {
          if (modelListMode === "unsupported") {
            throw new Error("This provider does not support automatic model fetch yet. Enter the model ID manually.");
          }
          // If user typed a key, fetch directly from JS
          if (apiKey) {
            const normalizedBase = baseUrl.replace(/\/+$/, "");
            const url = modelListMode === "anthropic"
              ? `${normalizedBase}/v1/models?limit=1000`
              : `${normalizedBase}/models`;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (modelListMode === "anthropic") {
              headers["x-api-key"] = apiKey;
              headers["anthropic-version"] = "2023-06-01";
            } else {
              headers["Authorization"] = `Bearer ${apiKey}`;
            }
            const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
            if (!response.ok) {
              const text = await response.text().catch(() => "");
              throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
            }
            const data = await response.json() as { data?: Array<{ id: string }> };
            return (data.data || []).map((m) => m.id);
          }
          // Key is in OS credential store — proxy through Rust
          const result = await invoke<{ models: string[]; error: string | null }>("fetch_provider_models", {
            request: { keyReference, baseUrl, apiType, modelListMode },
          });
          if (result.error) throw new Error(result.error);
          return result.models;
        }}
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
        onRefreshApps={handleRefreshApps}
        onRefreshDocuments={handleRefreshDocuments}
        onRefreshImages={handleRefreshImages}
        onRetryTask={retryCurrentTask}
        onStopTask={handleStopTask}
        onSelectHistoryEntry={selectHistoryEntry}
        onSubmitGoal={submitGoal}
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
        mcpConfigError={mcpConfigError}
        onTranslateSkillsToChinese={handleTranslateSkillsToChinese}
        onSearchSkillMarket={handleSearchSkillMarket}
        sidebarNavItems={sidebarNavItems}
        systemResources={systemResources}
        task={task}
        userDocuments={userDocuments}
        userImages={userImages}
        scanning={scanning}
        scanProgress={scanProgress}
        classifying={classifying}
        classifyProgress={classifyProgress}
        mountRoots={mountRoots}
        categoryStats={categoryStats}
        onRefreshScan={handleRefreshScan}
        onClassifyDocuments={handleClassifyDocuments}
        onCancelClassify={handleCancelClassify}
        trustedComputerApps={trustedComputerApps}
        onRemoveTrustedComputerApp={handleRemoveTrustedComputerApp}
        terminalService={terminalService}
        fileService={fileService}
        onQuickActionBrowser={async (url: string) => {
          const navResult = await invoke<{ url: string; title?: string }>("browser_navigate", {
            request: { url, sessionId: activeHistoryEntryId ?? task.id, allowLocalhost: true },
          });
          const [screenshot, content] = await Promise.all([
            invoke<{ dataUrl: string }>("browser_screenshot", { request: { fullPage: false } }),
            invoke<{ content: string; title?: string }>("browser_get_content", {
              request: { format: "text", maxLength: 2000 },
            }),
          ]);
          return {
            url: navResult.url,
            title: navResult.title ?? content.title,
            content: content.content,
            screenshotDataUrl: screenshot.dataUrl,
          };
        }}
        onQuickActionReview={async () => {
          const root = workspacePath || computerPath;
          const sessionId = `${activeHistoryEntryId ?? "live"}:${task.id ?? "idle"}`;
          const [status, diff] = await Promise.all([
            invoke<{
              files: Array<{ path: string }>;
              diffStat: string;
              workspaceRoot: string;
              branch?: string;
            }>("git_status", {
              request: { sessionId, workspaceRoot: root },
            }),
            invoke<{ diff: string }>("git_diff", {
              request: { sessionId, workspaceRoot: root },
            }),
          ]);
          return {
            changedFiles: status.files.map((file) => file.path),
            diffStat: status.diffStat,
            diff: diff.diff.slice(0, 4000),
            workspacePath: status.workspaceRoot,
            branch: status.branch,
          };
        }}
        onQuickActionSideChat={async (message: string) => {
          const sessionPrompt = [
            "Javis side chat context:",
            `workspaceRoot: ${workspacePath || computerPath || "(none)"}`,
            `threadId: ${activeHistoryEntryId ?? task.id ?? "live"}`,
            "",
            message,
          ].join("\n");
          const result = await invoke<{ text: string }>("complete_model_prompt", {
            request: {
              prompt: sessionPrompt,
              providerId: modelSettings.provider,
              model: modelSettings.model,
              apiKey: modelSettings.apiKey,
              apiKeyReference: modelSettings.apiKeyReference,
              baseUrl: modelSettings.baseUrl,
              maxTokens: 800,
              temperature: 0.7,
              locale: "zh-CN",
            },
          });
          return result.text;
        }}
        onQuickActionTerminal={async (command: string) => {
          const parts = command.trim().split(/\s+/);
          const program = parts[0];
          const args = parts.slice(1);
          const result = await invoke<{
            stdout: string;
            stderr: string;
            exitCode: number;
            cwd: string;
          }>("run_read_only_command", {
            request: { program, args, workspacePath: workspacePath || computerPath },
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

function TitleBar() {
  const isDesktop = currentWindow !== null;

  function handleDragStart() {
    currentWindow?.startDragging().catch((error) => logNonFatalError("Window drag failed", error));
  }

  async function handleMinimize() {
    await currentWindow?.minimize();
  }

  async function handleToggleMaximize() {
    await currentWindow?.toggleMaximize();
  }

  async function handleClose() {
    await currentWindow?.close();
  }

  function handleNotifications() {
    // Placeholder for future message and notification prompts.
  }

  return (
    <header
      className="javis-titlebar"
      data-tauri-drag-region={isDesktop ? true : undefined}
      onDoubleClick={handleToggleMaximize}
      onPointerDown={(event) => {
        if (event.button === 0 && event.detail === 1) {
          handleDragStart();
        }
      }}
    >
      <div className="javis-titlebar-brand" data-tauri-drag-region={isDesktop ? true : undefined}>
        <img className="javis-titlebar-icon" src={appIconUrl} alt="" aria-hidden="true" />
        <span data-tauri-drag-region={isDesktop ? true : undefined}>Javis</span>
      </div>
      {isDesktop ? (
        <div className="javis-titlebar-controls">
          <button
            aria-label="消息提示"
            className="notifications"
            onClick={handleNotifications}
            title="消息提示"
            type="button"
          >
            <span aria-hidden="true" />
          </button>
          <button aria-label="Minimize" className="minimize" onClick={handleMinimize} type="button">
            <span aria-hidden="true" />
          </button>
          <button aria-label="Maximize" className="maximize" onClick={handleToggleMaximize} type="button">
            <span aria-hidden="true" />
          </button>
          <button aria-label="Close" className="close" onClick={handleClose} type="button">
            <span aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </header>
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

function buildSkillEntries(mcpConfig: McpServerConfig[]): WorkbenchSkillEntry[] {
  const tools: WorkbenchSkillEntry[] = initialToolDescriptors.map((descriptor) => {
    const owners = demoAgents
      .filter((agent) => agent.allowedToolNames.includes(descriptor.name))
      .map((agent) => agent.displayName);
    return {
      id: descriptor.name,
      name: descriptor.name,
      description: descriptor.summary,
      category: "tool",
      permissionLevel: descriptor.permissionLevel,
      agentOwners: owners,
      enabled: true,
    };
  });
  const agents: WorkbenchSkillEntry[] = demoAgents.map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    description: agent.description,
    category: "agent",
    agentOwners: [],
    enabled: true,
  }));
  const mcps: WorkbenchSkillEntry[] = mcpConfig.map((server) => ({
    id: `mcp-${server.name}`,
    name: server.name,
    description: `${server.transport} · ${server.command ?? server.url ?? ""}`,
    category: "mcp",
    agentOwners: [],
    enabled: server.enabled,
  }));
  return [...tools, ...agents, ...mcps];
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
