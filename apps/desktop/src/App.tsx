import { useEffect, useMemo, useRef, useState } from "react";
import {
  createInitialTaskSnapshot,
  injectDocumentContext,
  type ChatMessage,
  type TaskSnapshot,
} from "@javis/core";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  ActiveView,
  WorkbenchModelConfiguration,
  WorkbenchScheduledTask,
  WorkbenchSkillEntry,
} from "@javis/ui";
import { JavisWorkbench, zhCNWorkbenchLocale, defaultWorkbenchLocale } from "@javis/ui";
import {
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
import { createJavisRuntime } from "./app-runtime";
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
import { getBuiltinSidebarNavItems, mergeSidebarNavItems } from "@javis/ui";
import appIconUrl from "./assets/app-icon.png";
import "./App.css";

export const DEFAULT_DRAFT_GOAL = "";
const currentWindow =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? getCurrentWindow()
    : null;

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

function App() {
  const databaseRef = useRef<DesktopDatabase | null>(null);
  const taskHistoryRepoRef = useRef<TaskHistoryRepositoryLike>(null);
  const workspaceSessionRepoRef = useRef<WorkspaceSessionRepository | null>(null);
  const approvalRecordsRepoRef = useRef<ReturnType<typeof createApprovalRecordsRepository> | null>(null);
  const modelSettingsRepoRef = useRef<ModelSettingsRepository | null>(null);
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

  // ── Sidebar view state ───────────────────────────────────────────
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [activeHistoryEntryId, setActiveHistoryEntryId] = useState<string | undefined>();
  const [localePreference, setLocalePreference] = useState<string>("zh-CN");
  const [prefSidebarWidth, setPrefSidebarWidth] = useState<number | undefined>();
  const [prefIsActivityOpen, setPrefIsActivityOpen] = useState<boolean | undefined>();
  const [prefIsInspectorOpen, setPrefIsInspectorOpen] = useState<boolean | undefined>();
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
  const [skillTranslationStatus, setSkillTranslationStatus] =
    useState<"idle" | "translating" | "error">("idle");
  const [mcpConfig, setMcpConfig] = useState<McpServerConfig[]>([]);

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
    handleClassifyDocuments,
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
    const tools: WorkbenchSkillEntry[] = initialToolDescriptors.map((d) => {
      const owners = demoAgents
        .filter((a) => a.allowedToolNames.includes(d.name))
        .map((a) => a.displayName);
      return {
        id: d.name,
        name: d.name,
        description: d.summary,
        category: "tool" as const,
        permissionLevel: d.permissionLevel,
        agentOwners: owners,
        enabled: true,
      };
    });
    const agents: WorkbenchSkillEntry[] = demoAgents.map((a) => ({
      id: a.id,
      name: a.displayName,
      description: a.description,
      category: "agent" as const,
      agentOwners: [],
      enabled: true,
    }));
    const mcps: WorkbenchSkillEntry[] = mcpConfig.map((s) => ({
      id: `mcp-${s.name}`,
      name: s.name,
      description: `${s.transport} · ${s.command ?? s.url ?? ""}`,
      category: "mcp" as const,
      agentOwners: [],
      enabled: s.enabled,
    }));
    setSkillEntries([...tools, ...agents, ...mcps]);
  }, [mcpConfig]);

  async function handleTranslateSkillsToChinese() {
    if (skillTranslationStatus === "translating") {
      return;
    }
    setSkillTranslationStatus("translating");
    try {
      const translated = await runtime.translateSkillsToChinese(
        skillEntries.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          agentOwners: skill.agentOwners,
        })),
      );
      const byId = new Map(translated.map((skill) => [skill.id, skill]));
      setSkillEntries((current) =>
        current.map((skill) => {
          const next = byId.get(skill.id);
          if (!next) {
            return skill;
          }
          return {
            ...skill,
            name: next.name || skill.name,
            description: next.description || skill.description,
            agentOwners: next.agentOwners?.length ? next.agentOwners : skill.agentOwners,
          };
        }),
      );
      setSkillTranslationStatus("idle");
    } catch (error) {
      logNonFatalError("Failed to translate skills to Chinese", error);
      setSkillTranslationStatus("error");
    }
  }

  // ── Build sidebar nav items from built-in defaults + workspace defs ─
  const sidebarNavItems = useMemo(() => {
    const labels =
      localePreference === "en" ? defaultWorkbenchLocale.labels : zhCNWorkbenchLocale.labels;
    return mergeSidebarNavItems(
      getBuiltinSidebarNavItems(
        labels,
        scheduledTasks.filter((t) => t.enabled).length,
        skillEntries.length,
      ),
      buildWorkspaceNavItems(workspaceDefs),
    );
  }, [workspaceDefs, scheduledTasks, skillEntries, localePreference]);

  // ── Load MCP config on mount ──────────────────────────────────────
  useEffect(() => {
    loadMcpConfig().then(setMcpConfig).catch((error) => logNonFatalError("Failed to load MCP config", error));
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

      // One-time import from localStorage
      const taskHistoryRepo = createTaskHistoryRepository(database);
      const workspaceSessionRepo = createWorkspaceSessionRepository(database);
      const approvalRecordsRepo = createApprovalRecordsRepository(database);
      const modelSettingsRepo = createModelSettingsRepository(database);
      const modelProfileRepo = createModelProfileRepository(database);

      taskHistoryRepoRef.current = taskHistoryRepo;
      workspaceSessionRepoRef.current = workspaceSessionRepo;
      approvalRecordsRepoRef.current = approvalRecordsRepo;
      modelSettingsRepoRef.current = modelSettingsRepo;
      modelProfileRepoRef.current = modelProfileRepo;

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
      const loadedConfig = await modelProfileRepo.importFromLegacySettings(legacySettings);
      const cleanOverrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(loadedConfig.agentOverrides)) {
        if (value) cleanOverrides[key] = value;
      }
      setModelConfiguration({
        profiles: loadedConfig.profiles.map((p) => ({ ...p, apiKey: "" })),
        agentOverrides: cleanOverrides,
      });

      if (historyCurrentRef.current === historyInitialRef.current) {
        setHistory(importedHistory);
      }
      if (workspaceSessionCurrentRef.current === workspaceSessionInitialRef.current) {
        replaceWorkspaceSession(importedWorkspaceSession);
      }
      if (approvalRecordsCurrentRef.current === approvalRecordsInitialRef.current) {
        setApprovalRecords(importedApprovalRecords);
      }
      const importedScheduledTasks = await scheduledTasksRepo.importFromLocalStorage(window.localStorage);
      if (scheduledTasksCurrentRef.current === scheduledTasksInitialRef.current) {
        setScheduledTasks(clearStaleGuards(importedScheduledTasks));
      }

      // Import user preferences from localStorage
      const importedPrefs = await preferencesRepo.importFromLocalStorage(window.localStorage);
      if (importedPrefs[PREF_KEYS.LOCALE]) setLocalePreference(importedPrefs[PREF_KEYS.LOCALE]);
      if (importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]) setPrefSidebarWidth(Number(importedPrefs[PREF_KEYS.SIDEBAR_WIDTH]));
      if (importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN]) setPrefIsActivityOpen(importedPrefs[PREF_KEYS.IS_ACTIVITY_OPEN] === "true");
      if (importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN]) setPrefIsInspectorOpen(importedPrefs[PREF_KEYS.IS_INSPECTOR_OPEN] === "true");
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

  function submitGoal(goalOverride?: string, workspacePathOverride?: string, scheduledTaskId?: string) {
    const goal = (goalOverride ?? draftGoal).trim();
    if (!goal) {
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

    // Resolve @document references — read file content and inject into prompt
    const atRefs = extractAtReferences(goal);
    if (atRefs.length > 0) {
      void (async () => {
        let resolvedGoal = goal;
        for (const ref of atRefs) {
          try {
            const content = await readFileChunk(ref.path);
            resolvedGoal = injectDocumentContext(resolvedGoal, ref.path, content);
          } catch (error) {
            logNonFatalError(`Failed to read referenced file ${ref.path}`, error);
            // File not readable — leave the @reference as-is in the goal
          }
        }
        runtime.start(resolvedGoal, {
          ...startOptions,
          mode: startMode,
        });
      })();
      return;
    }

    runtime.start(goal, {
      ...startOptions,
      mode: startMode,
    });
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

  function handlePermissionDecision(decision: "approved" | "denied") {
    const request = task.permissionRequest;
    if (
      task.status === "waiting_permission" &&
      request?.status === "pending" &&
      isDurableApprovalRequestTitle(request.title)
    ) {
      const record = approvalRecords.find((item) => item.approvalId === request.id);
      if (record?.status === "pending") {
        updateApprovalRecord(resolveApprovalRecord(record, decision, new Date().toISOString()));
      }
    }
    runtime.resolvePermission(decision, request?.id);
  }

  function selectHistoryEntry(id: string) {
    const entry = history.find((item) => item.id === id);
    if (entry) {
      clearQueuedTaskSnapshots();
      setTask(entry);
      setActiveHistoryEntryId(id);
      setDraftGoal("");
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

  const sidebarWidthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function persistPreference(key: string, value: string) {
    const repo = preferencesRepoRef.current;
    if (repo) {
      void repo.set(key, value).catch((error) =>
        console.warn(`Failed to persist preference "${key}"`, error),
      );
    }
  }

  return (
    <div className="javis-desktop-frame">
      <TitleBar />
      <JavisWorkbench
        activeHistoryEntryId={activeHistoryEntryId}
        activeView={activeView}
        appsError={appsError}
        appsLoading={appsLoading}
        computerEntries={computerEntries}
        computerError={computerError}
        computerLoading={computerLoading}
        computerPath={computerPath}
        docsError={docsError}
        docsLoading={docsLoading}
        draftGoal={draftGoal}
        currentWorkspacePath={workspacePath}
        historyEntries={history.map((entry) => ({
          id: entry.id,
          title: entry.title,
          status: entry.status,
          userGoal: entry.userGoal,
          updatedAt: getTaskUpdatedAt(entry),
          workspacePath:
            entry.project?.workspacePath ??
            entry.codeReviewPreview?.workspacePath ??
            entry.codeProposedEdit?.workspacePath ??
            entry.codeApplyResult?.workspacePath ??
            "",
          scheduledTaskId: entry.scheduledTaskId,
        }))}
        imagesError={imagesError}
        imagesLoading={imagesLoading}
        initialIsActivityOpen={prefIsActivityOpen}
        initialIsInspectorOpen={prefIsInspectorOpen}
        initialSidebarWidth={prefSidebarWidth}
        installedApps={installedApps}
        isTaskActive={isTaskActive}
        locale={effectiveLocale}
        modelSettings={modelSettings}
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
        modelConfiguration={modelConfiguration}
        onModelConfigurationChange={handleModelConfigurationChange}
        onNavigateDirectory={handleNavigateDirectory}
        onListDirectory={handleListDirectory}
        onOpenFile={handleOpenFile}
        onPermissionDecision={
          task.id.startsWith("restored-approval-") ? resolveRestoredApproval : handlePermissionDecision
        }
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
        onActiveViewChange={(view) => {
          persistPreference(PREF_KEYS.ACTIVE_VIEW, view);
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
        onTranslateSkillsToChinese={handleTranslateSkillsToChinese}
        sidebarNavItems={sidebarNavItems}
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
      />
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

export default App;
