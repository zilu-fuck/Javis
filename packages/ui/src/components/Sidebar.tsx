import { useEffect, useMemo, useState } from "react";
import type {
  ActiveView,
  WorkbenchHistoryEntry,
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchModelSettings,
} from "../types";
import {
  filterWorkbenchHistoryEntries,
  formatModifiedTime,
  formatWorkspaceName,
  translateWorkbenchText,
} from "../utils";
import { ModelSettings } from "./ModelSettings";

interface SidebarProps {
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  modelSettings: WorkbenchModelSettings;
  modelConfiguration?: WorkbenchModelConfiguration;
  historyEntries: WorkbenchHistoryEntry[];
  currentWorkspacePath?: string;
  recentWorkspacePaths?: string[];
  sidebarSearchQuery: string;
  activeView?: ActiveView;
  scheduledTaskCount?: number;
  skillCount?: number;
  onDeleteHistoryEntry?: (id: string) => void;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
  onSelectHistoryEntry?: (id: string) => void;
  onSidebarSearchQueryChange: (query: string) => void;
  onChangeActiveView?: (view: ActiveView) => void;
}

type CollapsibleView = "documents" | "gallery" | "computer";

const HISTORY_PREVIEW_COUNT = 4;

export function Sidebar({
  labels,
  locale,
  modelSettings,
  modelConfiguration,
  historyEntries,
  currentWorkspacePath,
  recentWorkspacePaths = [],
  sidebarSearchQuery,
  activeView = "chat",
  scheduledTaskCount = 0,
  skillCount = 0,
  onDeleteHistoryEntry,
  onModelSettingsChange,
  onModelConfigurationChange,
  onSelectHistoryEntry,
  onSidebarSearchQueryChange,
  onChangeActiveView,
}: SidebarProps) {
  const filteredHistoryEntries = filterWorkbenchHistoryEntries(
    historyEntries,
    sidebarSearchQuery,
  );
  const hasHistorySearch = sidebarSearchQuery.trim().length > 0;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<CollapsibleView, boolean>>({
    documents: activeView !== "documents",
    gallery: activeView !== "gallery",
    computer: activeView !== "computer",
  });
  const [expandedHistoryGroups, setExpandedHistoryGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (activeView === "documents" || activeView === "gallery" || activeView === "computer") {
      setCollapsedGroups((current) => ({ ...current, [activeView]: false }));
    }
  }, [activeView]);

  const workspaceGroups = useMemo(
    () =>
      groupHistoryEntriesByWorkspace(
        filteredHistoryEntries,
        currentWorkspacePath ?? "",
        recentWorkspacePaths,
        labels.unknown,
      ),
    [currentWorkspacePath, filteredHistoryEntries, labels.unknown, recentWorkspacePaths],
  );

  function navItem(view: ActiveView, icon: string, label: string, badge?: number) {
    const isActive = activeView === view;
    return (
      <div
        className={`javis-nav-item ${isActive ? "active" : ""}`}
        onClick={() => onChangeActiveView?.(view)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onChangeActiveView?.(view);
          }
        }}
      >
        <span className="javis-nav-icon">{icon}</span>
        <span>{label}</span>
        {badge != null && badge > 0 ? <span className="javis-nav-badge">{badge}</span> : null}
      </div>
    );
  }

  function navCollapsibleItem(view: CollapsibleView, icon: string, label: string) {
    const isActive = activeView === view;
    const isCollapsed = collapsedGroups[view];

    function handleClick() {
      if (isActive) {
        setCollapsedGroups((current) => ({ ...current, [view]: !current[view] }));
        return;
      }
      setCollapsedGroups((current) => ({ ...current, [view]: false }));
      onChangeActiveView?.(view);
    }

    return (
      <div
        aria-expanded={!isCollapsed}
        className={`javis-nav-item collapsible ${isActive ? "active" : ""}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        <span className="javis-nav-icon">{icon}</span>
        <span>{label}</span>
        <span className="javis-nav-caret">{isCollapsed ? "v" : "^"}</span>
      </div>
    );
  }

  function navSubitem(label: string) {
    return (
      <div className="javis-nav-subitem">
        <span />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <aside className="javis-sidebar">
      <div className="javis-brand">
        <span>Javis</span>
      </div>
      <label className="javis-sidebar-search">
        <span aria-hidden="true">/</span>
        <input
          aria-label={labels.searchPlaceholder}
          onChange={(event) => onSidebarSearchQueryChange(event.currentTarget.value)}
          placeholder={labels.searchPlaceholder}
          value={sidebarSearchQuery}
        />
      </label>
      <nav className="javis-nav" aria-label={labels.workspaceNavigation}>
        <div className="javis-nav-group primary">
          {navItem("chat", "+", labels.newChat)}
          {navItem("automated", "o", labels.automatedTasks, scheduledTaskCount)}
          {navItem("skills", "#", labels.skillMarket, skillCount)}
        </div>
        <div className="javis-nav-group">
          <p className="javis-nav-section">{labels.localKnowledgeBase}</p>
          {navItem("apps", "#", labels.apps)}
          {navCollapsibleItem("documents", ">", labels.documents)}
          {!collapsedGroups.documents && (
            <>
              {navSubitem("文档识别")}
              {navSubitem("课件")}
              {navSubitem("书籍")}
              {navSubitem("论文")}
            </>
          )}
          {navCollapsibleItem("gallery", ">", labels.gallery)}
          {!collapsedGroups.gallery && (
            <>
              {navSubitem("图片识别")}
              {navSubitem("人物印象")}
              {navSubitem("足迹地点")}
              {navSubitem("时光长廊")}
            </>
          )}
          {navCollapsibleItem("computer", ">", labels.thisComputer)}
          {!collapsedGroups.computer && (
            <>
              {navSubitem("系统 (C:)")}
              {navSubitem("固态硬盘 (E:)")}
              {navSubitem("机械硬盘2 (F:)")}
              {navSubitem("机械硬盘 (G:)")}
            </>
          )}
        </div>
        <div className="javis-nav-group">
          <p className="javis-nav-section">{labels.projects}</p>
          {workspaceGroups.length > 0 ? (
            workspaceGroups.map((group) => {
              const hasPreview = group.entries.length > HISTORY_PREVIEW_COUNT;
              const isExpanded = expandedHistoryGroups[group.key] ?? false;
              const visibleEntries = isExpanded
                ? group.entries
                : group.entries.slice(0, HISTORY_PREVIEW_COUNT);

              return (
                <section className="javis-history-workspace-group" key={group.key}>
                  <button
                    className="javis-history-workspace-header"
                    onClick={() =>
                      setExpandedHistoryGroups((current) => ({
                        ...current,
                        [group.key]: !current[group.key],
                      }))
                    }
                    type="button"
                  >
                    <span className="javis-history-workspace-icon">▣</span>
                    <span className="javis-history-workspace-name">
                      {group.label}
                      {group.displayPath ? <small>{group.displayPath}</small> : null}
                    </span>
                    <span className="javis-history-workspace-caret">
                      {isExpanded || !hasPreview ? "v" : "^"}
                    </span>
                  </button>

                  <div className="javis-history-workspace-body">
                    {visibleEntries.length > 0 ? (
                      visibleEntries.map((entry) => (
                        <div className="javis-history-entry" key={entry.id}>
                          <button
                            className="javis-history-select"
                            onClick={() => onSelectHistoryEntry?.(entry.id)}
                            type="button"
                          >
                            <span className="javis-nav-icon">*</span>
                            <span>
                              <strong>{translateWorkbenchText(entry.title, locale)}</strong>
                              <small>
                                {translateWorkbenchText(entry.status, locale)} ·{" "}
                                {formatModifiedTime(entry.updatedAt)}
                              </small>
                            </span>
                          </button>
                          <button
                            aria-label={`${labels.deleteHistoryEntry}: ${entry.title}`}
                            className="javis-history-delete"
                            onClick={() => onDeleteHistoryEntry?.(entry.id)}
                            title={labels.deleteHistoryEntry}
                            type="button"
                          >
                            x
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="javis-history-empty-group">{labels.historyEmptyGroup}</div>
                    )}
                    {hasPreview && !isExpanded ? (
                      <button
                        className="javis-history-expand"
                        onClick={() =>
                          setExpandedHistoryGroups((current) => ({
                            ...current,
                            [group.key]: true,
                          }))
                        }
                        type="button"
                      >
                        {labels.expandHistoryGroup}
                      </button>
                    ) : null}
                  </div>
                </section>
              );
            })
          ) : (
            <div className="javis-nav-item muted">
              <span className="javis-nav-icon">*</span>
              <span>{hasHistorySearch ? labels.historyNoMatches : labels.historyEmpty}</span>
            </div>
          )}
        </div>
      </nav>
      <ModelSettings
        labels={labels}
        modelSettings={modelSettings}
        modelConfiguration={modelConfiguration}
        onModelSettingsChange={onModelSettingsChange}
        onModelConfigurationChange={onModelConfigurationChange}
      />
    </aside>
  );
}

interface HistoryGroup {
  key: string;
  label: string;
  displayPath?: string;
  entries: WorkbenchHistoryEntry[];
  rank: number;
  updatedAt: number;
}

function groupHistoryEntriesByWorkspace(
  entries: WorkbenchHistoryEntry[],
  currentWorkspacePath: string,
  recentWorkspacePaths: string[],
  unknownLabel: string,
): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  const normalizedCurrentWorkspacePath = normalizeWorkspacePath(currentWorkspacePath);
  const workspaceOrder = new Map<string, number>();

  if (normalizedCurrentWorkspacePath) {
    workspaceOrder.set(normalizedCurrentWorkspacePath, 0);
  }

  let orderIndex = normalizedCurrentWorkspacePath ? 1 : 0;
  for (const path of recentWorkspacePaths) {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath || workspaceOrder.has(normalizedPath)) {
      continue;
    }
    workspaceOrder.set(normalizedPath, orderIndex);
    orderIndex += 1;
  }

  for (const entry of entries) {
    const normalizedWorkspacePath = normalizeWorkspacePath(entry.workspacePath ?? "");
    const key = normalizedWorkspacePath || "__unknown__";
    const existing = groups.get(key);
    const updatedAt = getEntrySortValue(entry);
    if (existing) {
      existing.entries.push(entry);
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
      continue;
    }

    groups.set(key, {
      key,
      label: normalizedWorkspacePath
        ? formatWorkspaceName(normalizedWorkspacePath) || normalizedWorkspacePath
        : unknownLabel,
      displayPath: normalizedWorkspacePath || undefined,
      entries: [entry],
      rank:
        normalizedWorkspacePath && workspaceOrder.has(normalizedWorkspacePath)
          ? workspaceOrder.get(normalizedWorkspacePath) ?? 999
          : 999,
      updatedAt,
    });
  }

  for (const [path, rank] of workspaceOrder.entries()) {
    if (groups.has(path)) continue;
    groups.set(path, {
      key: path,
      label: formatWorkspaceName(path) || path,
      displayPath: path,
      entries: [],
      rank,
      updatedAt: Number.NEGATIVE_INFINITY,
    });
  }

  return Array.from(groups.values()).sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.label.localeCompare(right.label);
  });
}

function getEntrySortValue(entry: WorkbenchHistoryEntry | undefined): number {
  if (!entry) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}
