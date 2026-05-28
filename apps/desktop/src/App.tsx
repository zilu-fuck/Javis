import { useEffect, useMemo, useRef, useState } from "react";
import { createInitialTaskSnapshot, injectDocumentContext, type TaskSnapshot } from "@javis/core";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  ActiveView,
  WorkbenchAppEntry,
  WorkbenchFileEntry,
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
import { getCompletedTaskWorkspacePath } from "./workspace-session";
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
import { useWorkspaceSessionControls } from "./use-workspace-session";
import {
  loadScheduledTasks,
  clearStaleGuards,
  isDue,
  computeNextRun,
  type ScheduledTask,
} from "./scheduled-tasks";
import {
  createScheduledTasksRepository,
  SCHEDULED_TASKS_MIGRATIONS,
} from "./scheduled-tasks-persistence";
import { loadMcpConfig, type McpServerConfig } from "./mcp-config";
import {
  readFileChunk,
  scanInstalledApps,
  scanUserDocuments,
  scanUserImages,
  listDirectory,
  type AppEntry,
  type FileEntry,
} from "./local-knowledge";
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
  type ModelProfileRepository,
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
import { demoAgents } from "@javis/core";
import "./App.css";

export const DEFAULT_DRAFT_GOAL = "";
const TASK_SNAPSHOT_REVEAL_DELAY_MS = 120;
const STREAMING_SNAPSHOT_REVEAL_DELAY_MS = 16;

const DOC_EXTENSIONS = [
  "docx", "doc", "txt", "pdf", "xlsx", "xls", "csv", "pptx", "ppt", "md", "rtf", "odt",
];

function fileEntryToWorkbench(entry: FileEntry): WorkbenchFileEntry {
  return {
    name: entry.name,
    path: entry.path,
    isDir: entry.isDir,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension,
  };
}

function appEntryToWorkbench(entry: AppEntry): WorkbenchAppEntry {
  return {
    name: entry.name,
    path: entry.path,
    iconPath: entry.iconPath,
    publisher: entry.publisher,
    installLocation: entry.installLocation,
  };
}

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
      .find((h) => (h as any).scheduledTaskId === task.id);
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

function isStreamingTaskSnapshot(task: TaskSnapshot): boolean {
  return Boolean(task.isStreaming || task.streamingText);
}

function extractAtReferences(goal: string): Array<{ raw: string; path: string }> {
  const matches = goal.match(/@([^\s,，。；;]+)/g);
  if (!matches) return [];
  return matches.map((raw) => {
    const path = raw.slice(1); // strip leading @
    return { raw, path };
  });
}

function App() {
  const databaseRef = useRef<DesktopDatabase | null>(null);
  const taskHistoryRepoRef = useRef<ReturnType<typeof createTaskHistoryRepository> | null>(null);
  const workspaceSessionRepoRef = useRef<WorkspaceSessionRepository | null>(null);
  const approvalRecordsRepoRef = useRef<ReturnType<typeof createApprovalRecordsRepository> | null>(null);
  const modelSettingsRepoRef = useRef<ModelSettingsRepository | null>(null);
  const modelProfileRepoRef = useRef<ModelProfileRepository | null>(null);
  const scheduledTasksRepoRef = useRef<ReturnType<typeof createScheduledTasksRepository> | null>(null);
  const preferencesRepoRef = useRef<UserPreferencesRepository | null>(null);
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
  const [modelConfiguration, setModelConfiguration] = useState<WorkbenchModelConfiguration | undefined>();
  const modelConfigRef = useRef(modelConfiguration);
  modelConfigRef.current = modelConfiguration;
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
  const [task, setTask] = useState(createInitialTaskSnapshot);
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
  const taskQueueRef = useRef<TaskSnapshot[]>([]);
  const taskFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draftGoal, setDraftGoal] = useState(DEFAULT_DRAFT_GOAL);

  // ── Sidebar view state ────────────────────────────────────────────
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [localePreference, setLocalePreference] = useState<string>("zh-CN");
  const [prefSidebarWidth, setPrefSidebarWidth] = useState<number | undefined>();
  const [prefIsActivityOpen, setPrefIsActivityOpen] = useState<boolean | undefined>();
  const [prefIsInspectorOpen, setPrefIsInspectorOpen] = useState<boolean | undefined>();
  const [isTaskActive, setIsTaskActive] = useState(false);
  // Ref mirrors isTaskActive for synchronous reads inside setInterval callbacks
  // where React state would be stale. Both must be updated together.
  const isTaskActiveRef = useRef(false);
  const [activeScheduledTaskId, setActiveScheduledTaskId] = useState<string | undefined>();

  // ── Scheduled tasks state ─────────────────────────────────────────
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(() =>
    clearStaleGuards(loadScheduledTasks(window.localStorage)),
  );
  const scheduledTasksInitialRef = useRef(scheduledTasks);
  const scheduledTasksCurrentRef = useRef(scheduledTasks);
  scheduledTasksCurrentRef.current = scheduledTasks;

  // ── Skill entries state ───────────────────────────────────────────
  const [skillEntries, setSkillEntries] = useState<WorkbenchSkillEntry[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpServerConfig[]>([]);

  // ── Local knowledge base state ────────────────────────────────────
  const [installedApps, setInstalledApps] = useState<WorkbenchAppEntry[]>([]);
  const [userDocuments, setUserDocuments] = useState<WorkbenchFileEntry[]>([]);
  const [userImages, setUserImages] = useState<WorkbenchFileEntry[]>([]);
  const [computerEntries, setComputerEntries] = useState<WorkbenchFileEntry[]>([]);
  const [computerPath, setComputerPath] = useState("C:\\Users");
  const [appsLoading, setAppsLoading] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [computerLoading, setComputerLoading] = useState(false);
  const [appsError, setAppsError] = useState<string>();
  const [docsError, setDocsError] = useState<string>();
  const [imagesError, setImagesError] = useState<string>();
  const [computerError, setComputerError] = useState<string>();
  const scanGenerationRef = useRef(0);

  // ── Build skill entries from descriptors + agents + MCP ───────────
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

  // ── Load MCP config on mount ──────────────────────────────────────
  useEffect(() => {
    loadMcpConfig().then(setMcpConfig).catch(() => {});
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

      setDurableApprovalRecordsReady(true);
    })().catch((error) => {
      console.error("Database initialization failed, using localStorage fallback", error);
      setDurableApprovalRecordsReady(true);
    });
  }, [replaceWorkspaceSession]);

  // ── Scheduled task trigger mechanism ──────────────────────────────
  useEffect(() => {
    // Clear stale guards on mount (crash recovery)
    setScheduledTasks((current) => {
      const cleared = clearStaleGuards(current);
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(cleared);
      }
      return cleared;
    });

    const checkDue = () => {
      setScheduledTasks((current) => {
        const now = new Date();
        const updated = current.map((t) => {
          if (!isDue(t, now)) return t;
          if (isTaskActiveRef.current) return t; // defer if another task is running
          // Fire the task
          submitGoal(t.goal, t.workspacePath, t.id);
          // Compute next run
          const nextRun = computeNextRun(t.schedule, now.toISOString());
          const updatedTask: ScheduledTask = {
            ...t,
            lastRunStartedAt: now.toISOString(),
            nextRunAt: nextRun ?? t.nextRunAt,
            enabled: t.schedule.type === "once" && !nextRun ? false : t.enabled,
          };
          return updatedTask;
        });
        const repository = scheduledTasksRepoRef.current;
        if (repository) {
          void repository.save(updated);
        }
        return updated;
      });
    };

    const interval = setInterval(checkDue, 60_000);
    const handleFocus = () => checkDue();
    window.addEventListener("focus", handleFocus);
    // Initial check on mount
    checkDue();

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [runtime]);

  // ── Track task active state ───────────────────────────────────────
  useEffect(() => {
    const unsubscribe = runtime.subscribe((nextTask) => {
      // Attach scheduledTaskId from pending ref so that history entries
      // carry the source scheduled task ID for last-run status derivation.
      const sid = pendingScheduledTaskIdRef.current;
      if (sid) {
        (nextTask as any).scheduledTaskId = sid;
        pendingScheduledTaskIdRef.current = undefined;
      }
      enqueueTaskSnapshot(nextTask);
      const db = databaseRef.current;
      void appendTaskSnapshotAuditJsonLines(
        createFileBackedTaskAuditJsonLineWriter(
          (line) => invoke("append_task_audit_jsonl_line", { request: { line } }).then(() => undefined),
          window.localStorage,
        ),
        nextTask,
        auditRecordIdsRef.current,
      );
      void appendTaskSessionSnapshotJsonLine(
        db
          ? createSqliteTaskSessionWriter(db)
          : createFileBackedTaskSessionJsonLineWriter(
              (line) => invoke("append_task_session_jsonl_line", { request: { line } }).then(() => undefined),
              window.localStorage,
            ),
        nextTask,
      );
      if (isArchivableTask(nextTask)) {
        setHistory((current) => {
          const updated = upsertTaskHistory(current, nextTask);
          const repository = taskHistoryRepoRef.current;
          if (repository) {
            void repository.upsert(nextTask);
          }
          return updated;
        });
      }
      persistDurableApprovalRecord(nextTask);
      if (nextTask.status === "completed") {
        persistWorkspaceForTask(
          nextTask.status,
          getCompletedTaskWorkspacePath(nextTask) || workspaceRef.current,
        );
        setIsTaskActive(false);
        isTaskActiveRef.current = false;
        setActiveScheduledTaskId(undefined);
        // Record completion: set lastRunAt, clear lastRunStartedAt
        setScheduledTasks((current) => {
          const now = new Date().toISOString();
          const updated = current.map((t) =>
            t.lastRunStartedAt
              ? { ...t, lastRunAt: now, lastRunStartedAt: undefined }
              : t,
          );
          const repository = scheduledTasksRepoRef.current;
          if (repository) {
            void repository.save(updated);
          }
          return updated;
        });
      }
      if (nextTask.status === "failed" || nextTask.status === "cancelled") {
        setIsTaskActive(false);
        isTaskActiveRef.current = false;
        setActiveScheduledTaskId(undefined);
        // Record failure: set lastRunAt, clear lastRunStartedAt
        setScheduledTasks((current) => {
          const now = new Date().toISOString();
          const updated = current.map((t) =>
            t.lastRunStartedAt
              ? { ...t, lastRunAt: now, lastRunStartedAt: undefined }
              : t,
          );
          const repository = scheduledTasksRepoRef.current;
          if (repository) {
            void repository.save(updated);
          }
          return updated;
        });
      }
    });
    return () => {
      clearQueuedTaskSnapshots();
      unsubscribe();
      runtime.dispose();
    };
  }, [persistWorkspaceForTask, runtime]);

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

  // Incremented by refresh handlers to force re-scan even when activeView
  // hasn't changed. Without this, clicking refresh while already on a view
  // would show an empty list because the effect depends on [activeView].
  const [scanVersion, setScanVersion] = useState(0);

  // ── Scan lifecycle: abort-and-discard on view change ──────────────
  useEffect(() => {
    scanGenerationRef.current += 1;
    const gen = scanGenerationRef.current;

    if (activeView === "apps" && installedApps.length === 0 && !appsLoading) {
      setAppsLoading(true);
      setAppsError(undefined);
      scanInstalledApps()
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setInstalledApps(result.map(appEntryToWorkbench));
        })
        .catch((err) => {
          if (scanGenerationRef.current !== gen) return;
          setAppsError(String(err));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setAppsLoading(false);
        });
    }

    if (activeView === "documents" && userDocuments.length === 0 && !docsLoading) {
      setDocsLoading(true);
      setDocsError(undefined);
      scanUserDocuments(DOC_EXTENSIONS, 200)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setUserDocuments(result.map(fileEntryToWorkbench));
        })
        .catch((err) => {
          if (scanGenerationRef.current !== gen) return;
          setDocsError(String(err));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setDocsLoading(false);
        });
    }

    if (activeView === "gallery" && userImages.length === 0 && !imagesLoading) {
      setImagesLoading(true);
      setImagesError(undefined);
      scanUserImages(200)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setUserImages(result.map(fileEntryToWorkbench));
        })
        .catch((err) => {
          if (scanGenerationRef.current !== gen) return;
          setImagesError(String(err));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setImagesLoading(false);
        });
    }

    if (activeView === "computer" && computerEntries.length === 0 && !computerLoading) {
      setComputerLoading(true);
      setComputerError(undefined);
      listDirectory(computerPath)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setComputerEntries(result.map(fileEntryToWorkbench));
        })
        .catch((err) => {
          if (scanGenerationRef.current !== gen) return;
          setComputerError(String(err));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setComputerLoading(false);
        });
    }
  }, [activeView, scanVersion]);

  function clearQueuedTaskSnapshots() {
    if (taskFlushTimerRef.current) {
      clearTimeout(taskFlushTimerRef.current);
      taskFlushTimerRef.current = null;
    }
    taskQueueRef.current = [];
  }

  function scheduleQueuedTaskSnapshot(delayMs = 0) {
    if (taskFlushTimerRef.current) {
      return;
    }

    taskFlushTimerRef.current = setTimeout(() => {
      taskFlushTimerRef.current = null;
      const nextTask = taskQueueRef.current.shift();
      if (!nextTask) {
        return;
      }

      setTask(nextTask);

      if (taskQueueRef.current.length > 0) {
        scheduleQueuedTaskSnapshot(
          isStreamingTaskSnapshot(nextTask)
            ? STREAMING_SNAPSHOT_REVEAL_DELAY_MS
            : TASK_SNAPSHOT_REVEAL_DELAY_MS,
        );
      }
    }, delayMs);
  }

  function enqueueTaskSnapshot(nextTask: TaskSnapshot) {
    const queue = taskQueueRef.current;
    const lastQueuedTask = queue[queue.length - 1];
    if (
      lastQueuedTask &&
      isStreamingTaskSnapshot(lastQueuedTask) &&
      isStreamingTaskSnapshot(nextTask) &&
      lastQueuedTask.id === nextTask.id
    ) {
      queue[queue.length - 1] = nextTask;
    } else {
      queue.push(nextTask);
    }
    scheduleQueuedTaskSnapshot();
  }

  // Holds the scheduledTaskId for the currently-starting task so that
  // the subscription callback can attach it to the TaskSnapshot before
  // it's saved to history. Cleared after being consumed.
  const pendingScheduledTaskIdRef = useRef<string | undefined>(undefined);

  function submitGoal(goalOverride?: string, workspacePathOverride?: string, scheduledTaskId?: string) {
    const goal = (goalOverride ?? draftGoal).trim();
    if (!goal) {
      return;
    }
    clearQueuedTaskSnapshots();
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
          } catch {
            // File not readable — leave the @reference as-is in the goal
          }
        }
        runtime.start(resolvedGoal);
      })();
      return;
    }

    runtime.start(goal);
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
      setDraftGoal("");
      setActiveView("chat");
    }
  }

  function deleteHistoryEntry(id: string) {
    setHistory((current) => {
      const updated = current.filter((entry) => entry.id !== id);
      const repository = taskHistoryRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }

  function toggleScheduledTask(id: string) {
    setScheduledTasks((current) => {
      const updated = current.map((t) =>
        t.id === id ? { ...t, enabled: !t.enabled } : t,
      );
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }

  function deleteScheduledTask(id: string) {
    setScheduledTasks((current) => {
      const updated = current.filter((t) => t.id !== id);
      const repository = scheduledTasksRepoRef.current;
      if (repository) {
        void repository.save(updated);
      }
      return updated;
    });
  }

  function handleChangeActiveView(view: ActiveView) {
    setActiveView(view);
  }

  function handleRefreshApps() {
    setInstalledApps([]);
    setAppsError(undefined);
    setAppsLoading(false);
    setScanVersion((v) => v + 1);
    setActiveView("apps");
  }

  function handleRefreshDocuments() {
    setUserDocuments([]);
    setDocsError(undefined);
    setDocsLoading(false);
    setScanVersion((v) => v + 1);
    setActiveView("documents");
  }

  function handleRefreshImages() {
    setUserImages([]);
    setImagesError(undefined);
    setImagesLoading(false);
    setScanVersion((v) => v + 1);
    setActiveView("gallery");
  }

  function handleNavigateDirectory(path: string) {
    setComputerPath(path);
    setComputerEntries([]);
    setComputerError(undefined);
    setComputerLoading(false);
    listDirectory(path)
      .then((result) => setComputerEntries(result.map(fileEntryToWorkbench)))
      .catch((err) => setComputerError(String(err)))
      .finally(() => setComputerLoading(false));
  }

  function handleOpenFile(path: string) {
    openPath(path).catch(() => {});
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
    <JavisWorkbench
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
        scheduledTaskId: (entry as any).scheduledTaskId,
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
      onDeleteHistoryEntry={deleteHistoryEntry}
      onDeleteRecentWorkspacePath={deleteRecentWorkspacePath}
      onDeleteScheduledTask={deleteScheduledTask}
      onDraftGoalChange={setDraftGoal}
      onModelSettingsChange={async (settings) => {
        await updateModelSettings(settings);
        void modelSettingsRepoRef.current?.save(settings);
      }}
      modelConfiguration={modelConfiguration}
      onModelConfigurationChange={async (config) => {
        setModelConfiguration(config);
        const repo = modelProfileRepoRef.current;
        if (repo) {
          const { profiles, agentOverrides } = config;
          repo.save(
            profiles.map(({ apiKey: _apiKey, ...rest }) => rest),
            agentOverrides,
          ).catch((error) => console.error("Failed to save model profiles", error));
        }
        // Save or delete API keys in OS credential store
        for (const profile of config.profiles) {
          try {
            if (profile.apiKey?.trim()) {
              await invoke("save_model_api_key_secret", {
                request: {
                  keyReference: profile.apiKeyReference,
                  apiKey: profile.apiKey,
                },
              });
            } else {
              await invoke("delete_model_api_key_secret", {
                keyReference: profile.apiKeyReference,
              });
            }
          } catch (error) {
            console.error(`Failed to manage API key for ${profile.id}`, error);
          }
        }
        // Clear cached providers so new config takes effect
        runtime.clearProviderCache();
      }}
      onNavigateDirectory={handleNavigateDirectory}
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
      task={task}
      userDocuments={userDocuments}
      userImages={userImages}
    />
  );
}

export default App;
