import {
  useEffect,
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
  scheduledTasks = [],
  skillEntries = [],
  installedApps = [],
  userDocuments = [],
  userImages = [],
  computerEntries = [],
  computerPath = "",
  isTaskActive = false,
  appsLoading = false,
  docsLoading = false,
  imagesLoading = false,
  computerLoading = false,
  appsError,
  docsError,
  imagesError,
  computerError,
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
  onChangeActiveView,
  onToggleScheduledTask,
  onDeleteScheduledTask,
  onRefreshApps,
  onRefreshDocuments,
  onRefreshImages,
  onNavigateDirectory,
  onOpenFile,
}: JavisWorkbenchProps) {
  const effectiveLocale = {
    ...locale,
    labels: {
      ...defaultWorkbenchLocale.labels,
      ...locale.labels,
    },
  };
  const labels = effectiveLocale.labels;
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>();
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
      setSidebarWidth(clampSidebarWidth(startWidth + clientX - startX, maxWidth));
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
      return;
    }

    if (event.key === "End") {
      setSidebarWidth(maxWidth);
      return;
    }

    const direction = event.key === "ArrowRight" ? 1 : -1;
    setSidebarWidth(
      clampSidebarWidth(currentWidth + direction * SIDEBAR_KEYBOARD_STEP, maxWidth),
    );
  }

  function renderMainContent() {
    switch (activeView) {
      case "chat":
        return (
          <ChatView
            currentWorkspacePath={currentWorkspacePath}
            draftGoal={draftGoal}
            locale={effectiveLocale}
            onBrowseWorkspacePath={onBrowseWorkspacePath}
            onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
            onDraftGoalChange={onDraftGoalChange}
            onPermissionDecision={onPermissionDecision}
            modelConfiguration={modelConfiguration}
            onRetryTask={onRetryTask}
            onStopTask={onStopTask}
            onSubmitGoal={onSubmitGoal}
            onUseWorkspacePath={onUseWorkspacePath}
            onWorkspacePathChange={onWorkspacePathChange}
            recentWorkspacePaths={recentWorkspacePaths}
            task={task}
          />
        );
      case "automated":
        return (
          <ScheduledTasksView
            isTaskActive={isTaskActive}
            locale={effectiveLocale}
            onDelete={onDeleteScheduledTask}
            onToggle={onToggleScheduledTask}
            tasks={scheduledTasks}
          />
        );
      case "skills":
        return (
          <SkillMarketView locale={effectiveLocale} skills={skillEntries} />
        );
      case "apps":
        return (
          <AppsView
            apps={installedApps}
            error={appsError}
            loading={appsLoading}
            locale={effectiveLocale}
            onOpen={onOpenFile}
            onRefresh={onRefreshApps}
          />
        );
      case "documents":
        return (
          <DocumentsView
            documents={userDocuments}
            error={docsError}
            loading={docsLoading}
            locale={effectiveLocale}
            onOpen={onOpenFile}
            onRefresh={onRefreshDocuments}
          />
        );
      case "gallery":
        return (
          <GalleryView
            error={imagesError}
            images={userImages}
            loading={imagesLoading}
            locale={effectiveLocale}
            onOpen={onOpenFile}
            onRefresh={onRefreshImages}
          />
        );
      case "computer":
        return (
          <ComputerView
            currentPath={computerPath}
            entries={computerEntries}
            error={computerError}
            loading={computerLoading}
            locale={effectiveLocale}
            onNavigate={onNavigateDirectory}
            onOpen={onOpenFile}
          />
        );
      default:
        return null;
    }
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
        currentWorkspacePath={currentWorkspacePath}
        historyEntries={historyEntries}
        labels={labels}
        locale={effectiveLocale}
        modelSettings={effectiveModelSettings}
        modelConfiguration={modelConfiguration}
        recentWorkspacePaths={recentWorkspacePaths}
        onChangeActiveView={handleChangeActiveView}
        onDeleteHistoryEntry={onDeleteHistoryEntry}
        onModelSettingsChange={onModelSettingsChange}
        onModelConfigurationChange={onModelConfigurationChange}
        onResizeKeyDown={handleSidebarResizeKeyDown}
        onResizeStart={handleSidebarResizeStart}
        sidebarResizeMax={SIDEBAR_MAX_WIDTH}
        sidebarResizeMin={SIDEBAR_MIN_WIDTH}
        sidebarResizeValue={sidebarResizeValue}
        onSelectHistoryEntry={onSelectHistoryEntry}
        onSidebarSearchQueryChange={setSidebarSearchQuery}
        scheduledTaskCount={scheduledTasks.filter((t) => t.enabled).length}
        sidebarSearchQuery={sidebarSearchQuery}
        skillCount={skillEntries.length}
      />

      <main className={`javis-main ${isChatView ? "new-chat" : ""}`}>
        {renderMainContent()}
      </main>

      {isChatView && (
        <>
          <InspectorPanel
            isInspectorOpen={isInspectorOpen}
            labels={labels}
            locale={effectiveLocale}
            onToggle={() => setIsInspectorOpen((current) => !current)}
            task={task}
          />
          <ActivityLog
            activityCount={activityCount}
            isActivityOpen={isActivityOpen}
            labels={labels}
            locale={effectiveLocale}
            onPermissionDecision={onPermissionDecision}
            onToggle={() => setIsActivityOpen((current) => !current)}
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
