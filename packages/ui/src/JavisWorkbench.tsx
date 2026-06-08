import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ActivityLog } from "./components/ActivityLog";
import { AppsView } from "./components/AppsView";
import { ChatView } from "./components/ChatView";
import { ComputerView } from "./components/ComputerView";
import { DocumentsView } from "./components/DocumentsView";
import { GalleryView } from "./components/GalleryView";
import { InspectorPanel } from "./components/InspectorPanel";
import { ScheduledTasksView } from "./components/ScheduledTasksView";
import { Sidebar } from "./components/Sidebar";
import { SkillMarketView } from "./components/SkillMarketView";
import { defaultWorkbenchLocale } from "./locale";
import type {
  ActiveView,
  JavisWorkbenchProps,
  WorkbenchDetailItem,
  WorkbenchAgentSessionContext,
  WorkbenchSkillPage,
  WorkbenchWorkspaceToolTab,
  WorkbenchWorkspaceToolAction,
} from "./types";

const SIDEBAR_MIN_WIDTH = 188;
const SIDEBAR_MAX_WIDTH = 360;
const ACTIVITY_MIN_HEIGHT = 104;
const ACTIVITY_MAX_HEIGHT = 360;
const CHAT_MAIN_MIN_WIDTH = 420;
const RESOURCE_MAIN_MIN_WIDTH = 760;
const RESOURCE_WITH_DETAILS_MAIN_MIN_WIDTH = 560;
const SIDEBAR_KEYBOARD_STEP = 16;
const ACTIVITY_KEYBOARD_STEP = 16;
const CHAT_DEFAULT_SIDEBAR_WIDTH = 220;
const RESOURCE_DEFAULT_SIDEBAR_WIDTH = 248;
const ACTIVITY_DEFAULT_HEIGHT = 188;

export function JavisWorkbench({
  task,
  draftGoal,
  currentWorkspacePath = "",
  historyEntries = [],
  locale = defaultWorkbenchLocale,
  agentCatalog = [],
  modelSettings,
  modelConfiguration,
  newChatRecommendations,
  userProfileMemorySummary,
  recentWorkspacePaths = [],
  activeView: activeViewProp,
  activeHistoryEntryId,
  scheduledTasks = [],
  skillEntries = [],
  skillTranslationStatus = "idle",
  skillTranslationError = null,
  skillSearchResults = [],
  skillSearchStatus = "idle",
  mcpConfigError = null,
  installedApps = [],
  userDocuments = [],
  userImages = [],
  computerEntries = [],
  trustedComputerApps = [],
  computerPath = "",
  mountRoots = [],
  isTaskActive = false,
  appsLoading = false,
  docsLoading = false,
  imagesLoading = false,
  computerLoading = false,
  appsError,
  docsError,
  imagesError,
  computerError,
  scanning = false,
  scanProgress,
  appsProgress,
  docsProgress,
  imagesProgress,
  classifying = false,
  classifyProgress,
  appsClassifying = false,
  appsClassifyProgress,
  categoryStats = [],
  appCategoryStats = [],
  resourceScanRoots = [],
  onRefreshScan,
  onClassifyDocuments,
  onClassifyApps,
  onCancelClassify,
  onCancelClassifyApps,
  onToggleScanRoot,
  onRemoveScanRoot,
  onAddScanRoot,
  onRefreshScanRoot,
  onDraftGoalChange,
  onDeleteHistoryEntry,
  onDeleteRecentWorkspacePath,
  onBrowseWorkspacePath,
  onModelSettingsChange,
  onTestModelConnection,
  onModelConfigurationChange,
  onRebuildUserProfileMemory,
  onClearUserProfileMemory,
  onReadAgentStyle,
  onSaveAgentStyle,
  onResetAgentStyle,
  onSaveProviderApiKey,
  onFetchProviderModels,
  providerCatalog,
  getProviderCapabilities,
  terminalService,
  fileService,
  onSelectHistoryEntry,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onAskUserAnswer,
  onRetryTask,
  onStopTask,
  onConversationMessagesChange,
  onSubmitGoal,
  onTranslateSkillsToChinese,
  onSearchSkillMarket,
  onOpenDetail,
  onOpenWorkspaceTool,
  onChangeActiveView,
  onSelectComposeMode,
  activeComposeMode,
  onToggleScheduledTask,
  onDeleteScheduledTask,
  onRefreshApps,
  onUpdateAppCategory,
  onRefreshDocuments,
  onRefreshImages,
  onNavigateDirectory,
  onListDirectory,
  onOpenFile,
  onRemoveTrustedComputerApp,
  onSidebarWidthChange,
  onActiveViewChange,
  onSidebarOpenChange,
  onActivityOpenChange,
  onActivityHeightChange,
  onInspectorOpenChange,
  initialSidebarWidth,
  initialActivityHeight,
  initialIsSidebarOpen,
  initialIsActivityOpen,
  initialIsInspectorOpen,
  systemResources,
  openTabs: openTabsProp,
  workspaceToolTabs: workspaceToolTabsProp,
  onActiveToolChange,
  onQuickActionBrowser,
  onQuickActionReview,
  onQuickActionTerminal,
  onQuickActionSideChat,
  sidebarNavItems,
}: JavisWorkbenchProps) {
  const effectiveLocale = useMemo(
    () => ({
      ...locale,
      labels: {
        ...defaultWorkbenchLocale.labels,
        ...locale.labels,
      },
    }),
    [locale],
  );
  const labels = effectiveLocale.labels;
  const [isActivityOpen, setIsActivityOpen] = useState(initialIsActivityOpen ?? false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(initialIsInspectorOpen ?? false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(initialIsSidebarOpen ?? true);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [selectedResourceCategories, setSelectedResourceCategories] = useState<Record<string, string | null>>({});
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>(initialSidebarWidth);
  const [activityHeight, setActivityHeight] = useState<number | undefined>(initialActivityHeight);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [internalActiveView, setInternalActiveView] =
    useState<ActiveView>("chat");
  const [activeSkillPage, setActiveSkillPage] = useState<WorkbenchSkillPage>("mine");
  const [detailItem, setDetailItem] = useState<WorkbenchDetailItem | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  const [openTabs, setOpenTabs] = useState<WorkbenchWorkspaceToolTab[]>(
    workspaceToolTabsProp ?? (openTabsProp ?? []).map((tool) => createWorkspaceToolTab(tool, 0)),
  );
  const activeView = activeViewProp ?? internalActiveView;
  const [activeToolTabId, setActiveToolTabId] = useState<string | null>(openTabs[openTabs.length - 1]?.id ?? null);
  const activeToolTab = openTabs.find((tab) => tab.id === activeToolTabId) ?? openTabs[openTabs.length - 1] ?? null;
  const activeTool = activeToolTab?.tool ?? null;

  const effectiveModelSettings = modelSettings ?? {
    provider: "openai",
    model: "",
    apiKey: "",
    apiKeyReference: "default",
    baseUrl: "",
  };
  const activityCount = task.logs.length + (task.permissionRequest ? 1 : 0) + (task.askUserQuestion ? 1 : 0);
  const isChatView = activeView === "chat";
  const effectiveAppCategoryStats = useMemo(
    () => appCategoryStats.length > 0 ? appCategoryStats : buildResourceCategoryStats(installedApps),
    [appCategoryStats, installedApps],
  );
  const documentCategoryStats = useMemo(
    () => buildResourceCategoryStats(userDocuments),
    [userDocuments],
  );
  const galleryCategoryStats = useMemo(
    () => buildResourceCategoryStats(userImages),
    [userImages],
  );
  const agentSession = useMemo<WorkbenchAgentSessionContext>(
    () => ({
      sessionId: `${activeHistoryEntryId ?? "live"}:${task.id ?? "idle"}`,
      threadId: activeHistoryEntryId ?? task.id ?? "live",
      taskId: task.id,
      workspaceRoot: currentWorkspacePath || task.workspacePath || computerPath || "",
      permissionMode: task.permissionRequest ? "confirmed_write" : "read_only",
      activeModel: modelSettings?.model || modelConfiguration?.profiles[0]?.model || "",
      activeTool,
      selectedAgentId,
    }),
    [
      activeHistoryEntryId,
      task.id,
      task.workspacePath,
      task.permissionRequest,
      currentWorkspacePath,
      computerPath,
      modelSettings?.model,
      modelConfiguration?.profiles,
      activeTool,
      selectedAgentId,
    ],
  );

  useEffect(() => {
    if (sidebarWidth == null) {
      return;
    }

    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const shellElement = shell;

    function clampWidthToCurrentLayout() {
      setSidebarWidth((current) => {
        if (current == null) {
          return current;
        }
        const maxWidth = getSidebarMaxWidth(shellElement);
        const nextWidth = clampSidebarWidth(current, maxWidth);
        if (nextWidth !== current) {
          onSidebarWidthChange?.(nextWidth);
        }
        return nextWidth === current ? current : nextWidth;
      });
    }

    const frame = window.requestAnimationFrame(clampWidthToCurrentLayout);
    window.addEventListener("resize", clampWidthToCurrentLayout);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", clampWidthToCurrentLayout);
    };
  }, [activeView, isInspectorOpen, sidebarWidth]);

  function handleChangeActiveView(view: ActiveView) {
    if (view === "apps" || view === "documents" || view === "gallery") {
      setSelectedResourceCategories((current) => ({ ...current, [view]: null }));
    }
    setInternalActiveView(view);
    onChangeActiveView?.(view);
    onActiveViewChange?.(view);
    setSidebarSearchQuery("");
  }

  function handleSelectResourceCategory(view: ActiveView, category: string | null) {
    setSelectedResourceCategories((current) => ({ ...current, [view]: category }));
  }

  function handleOpenDetail(detail: WorkbenchDetailItem) {
    setDetailItem(detail);
    onOpenDetail?.(detail);
    setIsInspectorOpen(true);
    onInspectorOpenChange?.(true);
  }

  function handleSelectAgent(agentId: string) {
    setSelectedAgentId(agentId);
    setInspectorOpenState(true);
  }

  function handleWorkspaceToolAction(action: WorkbenchWorkspaceToolAction) {
    onOpenWorkspaceTool?.(action);
    if (
      action === "files" || action === "sideChat" ||
      action === "browser" || action === "review" || action === "terminal"
    ) {
      setOpenTabs((prev) => {
        const shouldReuse = action === "files" || action === "review";
        const existing = shouldReuse ? prev.find((tab) => tab.tool === action) : undefined;
        if (existing) {
          setActiveToolTabId(existing.id);
          return prev;
        }
        const nextTab = createWorkspaceToolTab(action, prev.filter((tab) => tab.tool === action).length);
        setActiveToolTabId(nextTab.id);
        return [...prev, nextTab];
      });
      onActiveToolChange?.(action);
      setInspectorOpenState(true);
      return;
    }
  }

  function handleCloseToolTab(tabId: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      if (activeToolTabId === tabId) {
        const fallback = next[next.length - 1] ?? null;
        setActiveToolTabId(fallback?.id ?? null);
        onActiveToolChange?.(fallback?.tool ?? null);
      }
      return next;
    });
  }

  function handleSelectToolTab(tabId: string) {
    const tab = openTabs.find((item) => item.id === tabId);
    setActiveToolTabId(tabId);
    onActiveToolChange?.(tab?.tool ?? null);
  }

  function handleNewToolTab(tool: WorkbenchWorkspaceToolAction) {
    const nextTab = createWorkspaceToolTab(tool, openTabs.filter((tab) => tab.tool === tool).length);
    setOpenTabs((prev) => [...prev, nextTab]);
    setActiveToolTabId(nextTab.id);
    onActiveToolChange?.(tool);
  }

  function setSidebarOpenState(open: boolean) {
    setIsSidebarOpen(open);
    onSidebarOpenChange?.(open);
  }

  function setActivityOpenState(open: boolean) {
    setIsActivityOpen(open);
    onActivityOpenChange?.(open);
  }

  function setInspectorOpenState(open: boolean) {
    if (!open) {
      setSelectedAgentId(undefined);
    }
    setIsInspectorOpen(open);
    onInspectorOpenChange?.(open);
  }

  function applyLayoutPreset(preset: "expanded" | "focus" | "chat") {
    const nextSidebarOpen = preset === "expanded" || preset === "chat";
    const nextInspectorOpen = preset === "expanded";
    const nextActivityOpen = preset === "expanded";

    setSidebarOpenState(nextSidebarOpen);
    setInspectorOpenState(nextInspectorOpen);
    setActivityOpenState(nextActivityOpen);
  }

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const shell = event.currentTarget.closest<HTMLElement>(".javis-shell");
    if (!shell) {
      return;
    }

    event.preventDefault();

    const startX = event.clientX;
    const startWidth = getSidebarTrackWidth(shell);
    const maxWidth = getSidebarMaxWidth(shell);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function updateWidth(clientX: number) {
      const newWidth = clampSidebarWidth(startWidth + clientX - startX, maxWidth);
      setSidebarWidth(newWidth);
      onSidebarWidthChange?.(newWidth);
    }

    function stopListening() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopListening);
      window.removeEventListener("pointercancel", stopListening);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      updateWidth(moveEvent.clientX);
    }

    updateWidth(event.clientX);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopListening);
    window.addEventListener("pointercancel", stopListening);
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const shell = event.currentTarget.closest<HTMLElement>(".javis-shell");
    if (!shell) {
      return;
    }

    event.preventDefault();

    const currentWidth = getSidebarTrackWidth(shell);
    const maxWidth = getSidebarMaxWidth(shell);

    if (event.key === "Home") {
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
      onSidebarWidthChange?.(SIDEBAR_MIN_WIDTH);
      return;
    }

    if (event.key === "End") {
      setSidebarWidth(maxWidth);
      onSidebarWidthChange?.(maxWidth);
      return;
    }

    const direction = event.key === "ArrowRight" ? 1 : -1;
    const newWidth = clampSidebarWidth(currentWidth + direction * SIDEBAR_KEYBOARD_STEP, maxWidth);
    setSidebarWidth(newWidth);
    onSidebarWidthChange?.(newWidth);
  }

  function handleActivityResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const shell = event.currentTarget.closest<HTMLElement>(".javis-shell");
    if (!shell) {
      return;
    }

    event.preventDefault();

    const startY = event.clientY;
    const startHeight = getActivityTrackHeight(shell);
    const maxHeight = getActivityMaxHeight(shell);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function updateHeight(clientY: number) {
      const newHeight = clampActivityHeight(startHeight + startY - clientY, maxHeight);
      setActivityHeight(newHeight);
      onActivityHeightChange?.(newHeight);
    }

    function stopListening() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopListening);
      window.removeEventListener("pointercancel", stopListening);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      updateHeight(moveEvent.clientY);
    }

    updateHeight(event.clientY);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopListening);
    window.addEventListener("pointercancel", stopListening);
  }

  function handleActivityResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const shell = event.currentTarget.closest<HTMLElement>(".javis-shell");
    if (!shell) {
      return;
    }

    event.preventDefault();

    const currentHeight = getActivityTrackHeight(shell);
    const maxHeight = getActivityMaxHeight(shell);

    if (event.key === "Home") {
      setActivityHeight(ACTIVITY_MIN_HEIGHT);
      onActivityHeightChange?.(ACTIVITY_MIN_HEIGHT);
      return;
    }

    if (event.key === "End") {
      setActivityHeight(maxHeight);
      onActivityHeightChange?.(maxHeight);
      return;
    }

    const direction = event.key === "ArrowUp" ? 1 : -1;
    const newHeight = clampActivityHeight(currentHeight + direction * ACTIVITY_KEYBOARD_STEP, maxHeight);
    setActivityHeight(newHeight);
    onActivityHeightChange?.(newHeight);
  }

  const renderChatView = useCallback(
    () => (
      <ChatView
        currentWorkspacePath={currentWorkspacePath}
        draftGoal={draftGoal}
        locale={effectiveLocale}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onPermissionDecision={onPermissionDecision}
        onAskUserAnswer={onAskUserAnswer}
        modelConfiguration={modelConfiguration}
        newChatRecommendations={newChatRecommendations}
        activeComposeMode={activeComposeMode}
        onSelectComposeMode={onSelectComposeMode}
        onRetryTask={onRetryTask}
        onStopTask={onStopTask}
        onConversationMessagesChange={(messages) => onConversationMessagesChange?.(task.id, messages)}
        onOpenDetail={handleOpenDetail}
        onOpenFile={onOpenFile}
        onOpenWorkspaceTool={handleWorkspaceToolAction}
        onSelectAgent={handleSelectAgent}
        selectedAgentId={selectedAgentId}
        onSubmitGoal={onSubmitGoal}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
        recentWorkspacePaths={recentWorkspacePaths}
        task={task}
        userDocuments={userDocuments}
      />
    ),
    [
      activeComposeMode, currentWorkspacePath, draftGoal, effectiveLocale,
      onAskUserAnswer, onBrowseWorkspacePath, onDeleteRecentWorkspacePath, onDraftGoalChange,
      onPermissionDecision, modelConfiguration, onRetryTask, onStopTask,
      onConversationMessagesChange,
      handleOpenDetail, handleWorkspaceToolAction, onOpenFile,
      onSelectComposeMode, onSubmitGoal, onUseWorkspacePath, onWorkspacePathChange,
      recentWorkspacePaths, task, userDocuments, selectedAgentId, newChatRecommendations,
    ],
  );
  const renderAutomatedView = useCallback(
    () => (
      <ScheduledTasksView
        isTaskActive={isTaskActive}
        locale={effectiveLocale}
        onDelete={onDeleteScheduledTask}
        onToggle={onToggleScheduledTask}
        tasks={scheduledTasks}
      />
    ),
    [isTaskActive, effectiveLocale, onDeleteScheduledTask, onToggleScheduledTask, scheduledTasks],
  );
  const renderSkillsView = useCallback(
    () => (
      <SkillMarketView
        activePage={activeSkillPage}
        locale={effectiveLocale}
        mcpError={mcpConfigError}
        onSearchSkillMarket={onSearchSkillMarket}
        onOpenDetail={handleOpenDetail}
        onTranslateToChinese={onTranslateSkillsToChinese}
        searchResults={skillSearchResults}
        searchStatus={skillSearchStatus}
        skills={skillEntries}
        translationStatus={skillTranslationStatus}
        translationError={skillTranslationError}
      />
    ),
    [
      activeSkillPage,
      effectiveLocale,
      mcpConfigError,
      handleOpenDetail,
      onSearchSkillMarket,
      onTranslateSkillsToChinese,
      skillEntries,
      skillSearchResults,
      skillSearchStatus,
      skillTranslationStatus,
      skillTranslationError,
    ],
  );
  const renderAppsView = useCallback(
    () => (
      <AppsView
        apps={installedApps}
        error={appsError}
        loading={appsLoading}
        locale={effectiveLocale}
        categoryStats={effectiveAppCategoryStats}
        classifying={appsClassifying}
        classifyProgress={appsClassifyProgress}
        selectedCategory={selectedResourceCategories.apps}
        onCancelClassifyApps={onCancelClassifyApps}
        onClassifyApps={onClassifyApps}
        onOpen={onOpenFile}
        onRefresh={onRefreshApps}
        onUpdateAppCategory={onUpdateAppCategory}
        progress={appsProgress}
      />
    ),
    [
      installedApps, appsError, appsLoading, effectiveLocale, effectiveAppCategoryStats,
      appsClassifying, appsClassifyProgress, selectedResourceCategories.apps, onCancelClassifyApps,
      onClassifyApps, onOpenFile, onRefreshApps, onUpdateAppCategory, appsProgress,
    ],
  );
  const renderDocumentsView = useCallback(
    () => (
      <DocumentsView
        categoryStats={galleryCategoryStats}
        classifying={classifying}
        classifyProgress={classifyProgress}
        documents={userDocuments}
        error={docsError}
        loading={docsLoading}
        locale={effectiveLocale}
        resourceScanRoots={resourceScanRoots}
        selectedCategory={selectedResourceCategories.documents}
        onAddScanRoot={(path) => onAddScanRoot?.(path, ["documents"])}
        onCancelClassify={onCancelClassify}
        onClassifyDocuments={onClassifyDocuments}
        onOpen={onOpenFile}
        onRefresh={onRefreshDocuments}
        onRefreshScan={onRefreshScan}
        onRefreshScanRoot={onRefreshScanRoot}
        onRemoveScanRoot={onRemoveScanRoot}
        onToggleScanRoot={onToggleScanRoot}
        loadProgress={docsProgress}
        scanProgress={scanProgress}
        scanning={scanning}
      />
    ),
    [
      documentCategoryStats, classifying, classifyProgress, userDocuments, docsError, docsProgress,
      docsLoading, effectiveLocale, resourceScanRoots, onAddScanRoot, onCancelClassify,
      selectedResourceCategories.documents, onClassifyDocuments, onOpenFile, onRefreshDocuments, onRefreshScan,
      onRefreshScanRoot, onRemoveScanRoot, onToggleScanRoot, scanProgress, scanning,
    ],
  );
  const renderGalleryView = useCallback(
    () => (
      <GalleryView
        categoryStats={categoryStats}
        classifying={classifying}
        classifyProgress={classifyProgress}
        error={imagesError}
        images={userImages}
        loading={imagesLoading}
        locale={effectiveLocale}
        resourceScanRoots={resourceScanRoots}
        selectedCategory={selectedResourceCategories.gallery}
        onAddScanRoot={(path) => onAddScanRoot?.(path, ["images"])}
        onCancelClassify={onCancelClassify}
        onClassifyDocuments={onClassifyDocuments}
        onOpen={onOpenFile}
        onRefresh={onRefreshImages}
        onRefreshScan={onRefreshScan}
        onRefreshScanRoot={onRefreshScanRoot}
        onRemoveScanRoot={onRemoveScanRoot}
        onToggleScanRoot={onToggleScanRoot}
        loadProgress={imagesProgress}
        scanProgress={scanProgress}
        scanning={scanning}
      />
    ),
    [
      galleryCategoryStats, classifying, classifyProgress, imagesError, userImages, imagesProgress,
      imagesLoading, effectiveLocale, resourceScanRoots, onAddScanRoot, onCancelClassify,
      selectedResourceCategories.gallery, onClassifyDocuments, onOpenFile, onRefreshImages, onRefreshScan,
      onRefreshScanRoot, onRemoveScanRoot, onToggleScanRoot, scanProgress, scanning,
    ],
  );
  const renderComputerView = useCallback(
    () => (
      <ComputerView
        currentPath={computerPath}
        entries={computerEntries}
        error={computerError}
        loading={computerLoading}
        locale={effectiveLocale}
        onListDirectory={onListDirectory}
        onNavigate={onNavigateDirectory}
        onOpen={onOpenFile}
        onRemoveTrustedApp={onRemoveTrustedComputerApp}
        trustedApps={trustedComputerApps}
      />
    ),
    [
      computerPath, computerEntries, computerError, computerLoading,
      effectiveLocale, onListDirectory, onNavigateDirectory, onOpenFile,
      onRemoveTrustedComputerApp, trustedComputerApps,
    ],
  );

  const renderUnknownView = useCallback(
    () => (
      <div className="javis-view-panel">
        <p>{labels.unknownView ?? "Unknown view"}: {activeView}</p>
      </div>
    ),
    [labels.unknownView, activeView],
  );

  const viewMap = useMemo(() => {
    const map = new Map<string, () => ReturnType<typeof renderChatView>>();
    map.set("chat", renderChatView);
    map.set("automated", renderAutomatedView);
    map.set("skills", renderSkillsView);
    map.set("apps", renderAppsView);
    map.set("documents", renderDocumentsView);
    map.set("gallery", renderGalleryView);
    map.set("computer", renderComputerView);
    return map;
  }, [
    renderChatView, renderAutomatedView, renderSkillsView, renderAppsView,
    renderDocumentsView, renderGalleryView, renderComputerView,
  ]);

  function renderMainContent() {
    const renderer = viewMap.get(activeView) ?? renderUnknownView;
    return renderer();
  }

  const shellStyle = {
    ...(sidebarWidth == null ? {} : { "--javis-sidebar-width": `${sidebarWidth}px` }),
    ...(activityHeight == null ? {} : { "--javis-activity-height": `${activityHeight}px` }),
  } as CSSProperties;
  const sidebarResizeValue =
    sidebarWidth ?? (isChatView ? CHAT_DEFAULT_SIDEBAR_WIDTH : RESOURCE_DEFAULT_SIDEBAR_WIDTH);
  const activityResizeValue = activityHeight ?? ACTIVITY_DEFAULT_HEIGHT;

  return (
    <div
      ref={shellRef}
      className={[
        "javis-shell",
        isChatView ? "mode-chat" : "mode-resource",
        isSidebarOpen ? "sidebar-open" : "sidebar-collapsed",
        isActivityOpen ? "activity-open" : "activity-collapsed",
        isInspectorOpen ? "inspector-open" : "inspector-collapsed",
      ].join(" ")}
      style={shellStyle}
    >
      <div className="javis-workspace-controls" aria-label={labels.workspaceControls}>
        <details className="javis-workspace-preset-menu">
          <summary
            aria-label={labels.layoutPresets}
            className="javis-workspace-control control-presets"
            title={labels.layoutPresets}
          >
            <span aria-hidden="true" />
          </summary>
          <div className="javis-workspace-preset-popover">
            <button onClick={() => applyLayoutPreset("expanded")} type="button">
              {labels.layoutPresetExpanded}
            </button>
            <button onClick={() => applyLayoutPreset("focus")} type="button">
              {labels.layoutPresetFocus}
            </button>
            <button onClick={() => applyLayoutPreset("chat")} type="button">
              {labels.layoutPresetChat}
            </button>
          </div>
        </details>
        <button
          aria-label={isSidebarOpen ? labels.collapseSidebar : labels.expandSidebar}
          aria-pressed={isSidebarOpen}
          className="javis-workspace-control control-sidebar"
          onClick={() => setSidebarOpenState(!isSidebarOpen)}
          title={isSidebarOpen ? labels.collapseSidebar : labels.expandSidebar}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
        <button
          aria-label={isInspectorOpen ? labels.collapseInspector : labels.expandInspector}
          aria-pressed={isInspectorOpen}
          className="javis-workspace-control control-inspector"
          onClick={() => setInspectorOpenState(!isInspectorOpen)}
          title={isInspectorOpen ? labels.collapseInspector : labels.expandInspector}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
        {isChatView ? (
          <button
            aria-label={isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}
            aria-pressed={isActivityOpen}
            className="javis-workspace-control control-activity"
            onClick={() => setActivityOpenState(!isActivityOpen)}
            title={isActivityOpen ? labels.collapseActivityLog : labels.expandActivityLog}
            type="button"
          >
            <span aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <Sidebar
        activeView={activeView}
        activeHistoryEntryId={activeHistoryEntryId}
        categoryStats={documentCategoryStats}
        appCategoryStats={effectiveAppCategoryStats}
        documentCategoryStats={documentCategoryStats}
        galleryCategoryStats={galleryCategoryStats}
        currentWorkspacePath={currentWorkspacePath}
        historyEntries={historyEntries}
        labels={labels}
        locale={effectiveLocale}
        modelSettings={effectiveModelSettings}
        modelConfiguration={modelConfiguration}
        agentCatalog={agentCatalog}
        userProfileMemorySummary={userProfileMemorySummary}
        mountRoots={mountRoots}
        recentWorkspacePaths={recentWorkspacePaths}
        onChangeActiveView={handleChangeActiveView}
        onSelectResourceCategory={handleSelectResourceCategory}
        onDeleteHistoryEntry={onDeleteHistoryEntry}
        onModelSettingsChange={onModelSettingsChange}
        onTestModelConnection={onTestModelConnection}
        onModelConfigurationChange={onModelConfigurationChange}
        onRebuildUserProfileMemory={onRebuildUserProfileMemory}
        onClearUserProfileMemory={onClearUserProfileMemory}
        onReadAgentStyle={onReadAgentStyle}
        onSaveAgentStyle={onSaveAgentStyle}
        onResetAgentStyle={onResetAgentStyle}
        onSaveProviderApiKey={onSaveProviderApiKey}
        onFetchProviderModels={onFetchProviderModels}
        providerCatalog={providerCatalog}
        getProviderCapabilities={getProviderCapabilities}
        onResizeKeyDown={handleSidebarResizeKeyDown}
        onResizeStart={handleSidebarResizeStart}
        onNavigateDirectory={onNavigateDirectory}
        onSelectComposeMode={onSelectComposeMode}
        onSelectSkillPage={setActiveSkillPage}
        sidebarResizeMax={SIDEBAR_MAX_WIDTH}
        sidebarResizeMin={SIDEBAR_MIN_WIDTH}
        sidebarResizeValue={sidebarResizeValue}
        onSelectHistoryEntry={onSelectHistoryEntry}
        onSidebarSearchQueryChange={setSidebarSearchQuery}
        scheduledTaskCount={scheduledTasks.filter((t) => t.enabled).length}
        sidebarSearchQuery={sidebarSearchQuery}
        skillCount={skillEntries.length}
        sidebarNavItems={sidebarNavItems}
        activeComposeMode={activeComposeMode}
        activeSkillPage={activeSkillPage}
      />

      <main className={`javis-main ${isChatView && task.id === "task-idle" ? "new-chat" : ""}`}>
        {renderMainContent()}
      </main>

      <InspectorPanel
        detailItem={detailItem}
        isInspectorOpen={isInspectorOpen}
        labels={labels}
        locale={effectiveLocale}
        selectedAgentId={selectedAgentId}
        systemResources={systemResources}
        openTabs={openTabs}
        activeToolTabId={activeToolTab?.id}
        session={agentSession}
        terminalService={terminalService}
        fileService={fileService}
        onQuickAction={handleWorkspaceToolAction}
        onSelectAgent={handleSelectAgent}
        onClearSelectedAgent={() => setSelectedAgentId(undefined)}
        onToggle={() => {
          setInspectorOpenState(!isInspectorOpen);
        }}
        onCloseToolTab={handleCloseToolTab}
        onSelectToolTab={handleSelectToolTab}
        onNewToolTab={handleNewToolTab}
        computerEntries={computerEntries}
        computerPath={computerPath}
        onNavigateDirectory={onNavigateDirectory}
        onOpenFile={onOpenFile}
        onSideChatSend={onQuickActionSideChat}
        onQuickActionBrowser={onQuickActionBrowser}
        onQuickActionReview={onQuickActionReview}
        onQuickActionTerminal={onQuickActionTerminal}
        task={task}
      />

      {isChatView && (
        <>
          <ActivityLog
            activityCount={activityCount}
            isActivityOpen={isActivityOpen}
            labels={labels}
            locale={effectiveLocale}
            onResizeKeyDown={handleActivityResizeKeyDown}
            onResizeStart={handleActivityResizeStart}
            onPermissionDecision={onPermissionDecision}
            onAskUserAnswer={onAskUserAnswer}
            onToggle={() => setActivityOpenState(!isActivityOpen)}
            resizeMax={ACTIVITY_MAX_HEIGHT}
            resizeMin={ACTIVITY_MIN_HEIGHT}
            resizeValue={activityResizeValue}
            task={task}
          />
        </>
      )}
    </div>
  );
}

function clampSidebarWidth(width: number, maxWidth: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), maxWidth));
}

function createWorkspaceToolTab(tool: WorkbenchWorkspaceToolAction, index: number): WorkbenchWorkspaceToolTab {
  return {
    id: `${tool}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tool,
    title: index > 0 ? `${tool} ${index + 1}` : undefined,
  };
}

function buildResourceCategoryStats(entries: Array<{ category?: string }>): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.category) continue;
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

function getSidebarTrackWidth(shell: HTMLElement): number {
  return getGridColumnWidths(shell)[0] ?? SIDEBAR_MIN_WIDTH;
}

function getSidebarMaxWidth(shell: HTMLElement): number {
  const columns = getGridColumnWidths(shell);
  const trailingWidth = columns.length > 2 ? columns[2] ?? 0 : 0;
  const isResourceMode = shell.classList.contains("mode-resource");
  const mainMinWidth = isResourceMode
    ? (columns.length > 2 ? RESOURCE_WITH_DETAILS_MAIN_MIN_WIDTH : RESOURCE_MAIN_MIN_WIDTH)
    : CHAT_MAIN_MIN_WIDTH;
  const style = window.getComputedStyle(shell);
  const contentWidth =
    shell.clientWidth - parseCssPixelValue(style.paddingLeft) - parseCssPixelValue(style.paddingRight);
  const availableWidth = contentWidth - trailingWidth - mainMinWidth;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, availableWidth));
}

function getGridColumnWidths(shell: HTMLElement): number[] {
  return window
    .getComputedStyle(shell)
    .gridTemplateColumns.split(" ")
    .map((column) => Number.parseFloat(column))
    .filter((width) => Number.isFinite(width));
}

function parseCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampActivityHeight(height: number, maxHeight: number): number {
  return Math.round(Math.min(Math.max(height, ACTIVITY_MIN_HEIGHT), maxHeight));
}

function getActivityTrackHeight(shell: HTMLElement): number {
  const rows = getGridRowHeights(shell);
  return rows[1] ?? ACTIVITY_DEFAULT_HEIGHT;
}

function getActivityMaxHeight(shell: HTMLElement): number {
  const style = window.getComputedStyle(shell);
  const contentHeight =
    shell.clientHeight - parseCssPixelValue(style.paddingTop) - parseCssPixelValue(style.paddingBottom);
  const availableHeight = contentHeight - CHAT_MAIN_MIN_WIDTH / 2;
  return Math.max(ACTIVITY_MIN_HEIGHT, Math.min(ACTIVITY_MAX_HEIGHT, availableHeight));
}

function getGridRowHeights(shell: HTMLElement): number[] {
  return window
    .getComputedStyle(shell)
    .gridTemplateRows.split(" ")
    .map((row) => Number.parseFloat(row))
    .filter((height) => Number.isFinite(height));
}
