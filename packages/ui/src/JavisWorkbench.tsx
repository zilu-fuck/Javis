import { useState } from "react";
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

  function handleChangeActiveView(view: ActiveView) {
    setInternalActiveView(view);
    onChangeActiveView?.(view);
    setSidebarSearchQuery("");
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
            onRetryTask={onRetryTask}
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

  const isChatView = activeView === "chat";

  return (
    <div
      className={[
        "javis-shell",
        isChatView ? "mode-chat" : "mode-resource",
        isActivityOpen ? "activity-open" : "activity-collapsed",
        isInspectorOpen ? "inspector-open" : "inspector-collapsed",
      ].join(" ")}
    >
      <Sidebar
        activeView={activeView}
        historyEntries={historyEntries}
        labels={labels}
        locale={effectiveLocale}
        modelSettings={effectiveModelSettings}
        modelConfiguration={modelConfiguration}
        onChangeActiveView={handleChangeActiveView}
        onDeleteHistoryEntry={onDeleteHistoryEntry}
        onModelSettingsChange={onModelSettingsChange}
        onModelConfigurationChange={onModelConfigurationChange}
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
