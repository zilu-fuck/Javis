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
import type { ActiveView, JavisWorkbenchProps } from "./types";

const SIDEBAR_MIN_WIDTH = 188;
const SIDEBAR_MAX_WIDTH = 360;
const CHAT_MAIN_MIN_WIDTH = 420;
const RESOURCE_MAIN_MIN_WIDTH = 760;
const SIDEBAR_KEYBOARD_STEP = 16;
const CHAT_DEFAULT_SIDEBAR_WIDTH = 220;
const RESOURCE_DEFAULT_SIDEBAR_WIDTH = 238;

export function JavisWorkbench({
  task,
  draftGoal,
  currentWorkspacePath = "",
  historyEntries = [],
  locale = defaultWorkbenchLocale,
  modelSettings,
  modelConfiguration,
  recentWorkspacePaths = [],
  activeView: activeViewProp,
  activeHistoryEntryId,
  scheduledTasks = [],
  skillEntries = [],
  skillTranslationStatus = "idle",
  installedApps = [],
  userDocuments = [],
  userImages = [],
  computerEntries = [],
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
  classifying = false,
  classifyProgress,
  categoryStats = [],
  onRefreshScan,
  onClassifyDocuments,
  onCancelClassify,
  onDraftGoalChange,
  onDeleteHistoryEntry,
  onDeleteRecentWorkspacePath,
  onBrowseWorkspacePath,
  onModelSettingsChange,
  onModelConfigurationChange,
  onSelectHistoryEntry,
  onUseWorkspacePath,
  onWorkspacePathChange,
  onPermissionDecision,
  onRetryTask,
  onStopTask,
  onSubmitGoal,
  onTranslateSkillsToChinese,
  onChangeActiveView,
  onSelectComposeMode,
  activeComposeMode,
  onToggleScheduledTask,
  onDeleteScheduledTask,
  onRefreshApps,
  onRefreshDocuments,
  onRefreshImages,
  onNavigateDirectory,
  onListDirectory,
  onOpenFile,
  onSidebarWidthChange,
  onActiveViewChange,
  onActivityOpenChange,
  onInspectorOpenChange,
  initialSidebarWidth,
  initialIsActivityOpen,
  initialIsInspectorOpen,
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
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>(initialSidebarWidth);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [internalActiveView, setInternalActiveView] =
    useState<ActiveView>("chat");
  const activeView = activeViewProp ?? internalActiveView;

  const effectiveModelSettings = modelSettings ?? {
    provider: "openai",
    model: "",
    apiKey: "",
    apiKeyReference: "default",
    baseUrl: "",
  };
  const activityCount = task.logs.length + (task.permissionRequest ? 1 : 0);
  const isChatView = activeView === "chat";

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
    setInternalActiveView(view);
    onChangeActiveView?.(view);
    onActiveViewChange?.(view);
    setSidebarSearchQuery("");
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
        modelConfiguration={modelConfiguration}
        activeComposeMode={activeComposeMode}
        onRetryTask={onRetryTask}
        onStopTask={onStopTask}
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
      onBrowseWorkspacePath, onDeleteRecentWorkspacePath, onDraftGoalChange,
      onPermissionDecision, modelConfiguration, onRetryTask, onStopTask,
      onSubmitGoal, onUseWorkspacePath, onWorkspacePathChange,
      recentWorkspacePaths, task, userDocuments,
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
        locale={effectiveLocale}
        onTranslateToChinese={onTranslateSkillsToChinese}
        skills={skillEntries}
        translationStatus={skillTranslationStatus}
      />
    ),
    [effectiveLocale, onTranslateSkillsToChinese, skillEntries, skillTranslationStatus],
  );
  const renderAppsView = useCallback(
    () => (
      <AppsView
        apps={installedApps}
        error={appsError}
        loading={appsLoading}
        locale={effectiveLocale}
        onOpen={onOpenFile}
        onRefresh={onRefreshApps}
      />
    ),
    [installedApps, appsError, appsLoading, effectiveLocale, onOpenFile, onRefreshApps],
  );
  const renderDocumentsView = useCallback(
    () => (
      <DocumentsView
        categoryStats={categoryStats}
        classifying={classifying}
        classifyProgress={classifyProgress}
        documents={userDocuments}
        error={docsError}
        loading={docsLoading}
        locale={effectiveLocale}
        onCancelClassify={onCancelClassify}
        onClassifyDocuments={onClassifyDocuments}
        onOpen={onOpenFile}
        onRefresh={onRefreshDocuments}
        onRefreshScan={onRefreshScan}
        scanProgress={scanProgress}
        scanning={scanning}
      />
    ),
    [
      categoryStats, classifying, classifyProgress, userDocuments, docsError,
      docsLoading, effectiveLocale, onCancelClassify, onClassifyDocuments,
      onOpenFile, onRefreshDocuments, onRefreshScan, scanProgress, scanning,
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
        onCancelClassify={onCancelClassify}
        onClassifyDocuments={onClassifyDocuments}
        onOpen={onOpenFile}
        onRefresh={onRefreshImages}
        onRefreshScan={onRefreshScan}
        scanProgress={scanProgress}
        scanning={scanning}
      />
    ),
    [
      categoryStats, classifying, classifyProgress, imagesError, userImages,
      imagesLoading, effectiveLocale, onCancelClassify, onClassifyDocuments,
      onOpenFile, onRefreshImages, onRefreshScan, scanProgress, scanning,
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
      />
    ),
    [
      computerPath, computerEntries, computerError, computerLoading,
      effectiveLocale, onListDirectory, onNavigateDirectory, onOpenFile,
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

  const shellStyle =
    sidebarWidth == null
      ? undefined
      : ({
          "--javis-sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties);
  const sidebarResizeValue =
    sidebarWidth ?? (isChatView ? CHAT_DEFAULT_SIDEBAR_WIDTH : RESOURCE_DEFAULT_SIDEBAR_WIDTH);

  return (
    <div
      ref={shellRef}
      className={[
        "javis-shell",
        isChatView ? "mode-chat" : "mode-resource",
        isActivityOpen ? "activity-open" : "activity-collapsed",
        isInspectorOpen ? "inspector-open" : "inspector-collapsed",
      ].join(" ")}
      style={shellStyle}
    >
      <Sidebar
        activeView={activeView}
        activeHistoryEntryId={activeHistoryEntryId}
        categoryStats={categoryStats}
        currentWorkspacePath={currentWorkspacePath}
        historyEntries={historyEntries}
        labels={labels}
        locale={effectiveLocale}
        modelSettings={effectiveModelSettings}
        modelConfiguration={modelConfiguration}
        mountRoots={mountRoots}
        recentWorkspacePaths={recentWorkspacePaths}
        onChangeActiveView={handleChangeActiveView}
        onDeleteHistoryEntry={onDeleteHistoryEntry}
        onModelSettingsChange={onModelSettingsChange}
        onModelConfigurationChange={onModelConfigurationChange}
        onResizeKeyDown={handleSidebarResizeKeyDown}
        onResizeStart={handleSidebarResizeStart}
        onNavigateDirectory={onNavigateDirectory}
        onSelectComposeMode={onSelectComposeMode}
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
      />

      <main className={`javis-main ${isChatView && task.id === "task-idle" ? "new-chat" : ""}`}>
        {renderMainContent()}
      </main>

      {isChatView && (
        <>
          <InspectorPanel
            isInspectorOpen={isInspectorOpen}
            labels={labels}
            locale={effectiveLocale}
            onToggle={() => setIsInspectorOpen((current) => {
              const next = !current;
              onInspectorOpenChange?.(next);
              return next;
            })}
            task={task}
          />
          <ActivityLog
            activityCount={activityCount}
            isActivityOpen={isActivityOpen}
            labels={labels}
            locale={effectiveLocale}
            onPermissionDecision={onPermissionDecision}
            onToggle={() => setIsActivityOpen((current) => {
              const next = !current;
              onActivityOpenChange?.(next);
              return next;
            })}
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

function getSidebarTrackWidth(shell: HTMLElement): number {
  return getGridColumnWidths(shell)[0] ?? SIDEBAR_MIN_WIDTH;
}

function getSidebarMaxWidth(shell: HTMLElement): number {
  const columns = getGridColumnWidths(shell);
  const trailingWidth = columns.length > 2 ? columns[2] ?? 0 : 0;
  const mainMinWidth = columns.length > 2 ? CHAT_MAIN_MIN_WIDTH : RESOURCE_MAIN_MIN_WIDTH;
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
