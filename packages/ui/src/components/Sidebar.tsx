import React, {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ActiveView,
  SidebarNavItem,
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
import { normalizeWorkspacePath } from "../utils";
import { getBuiltinSidebarNavItems, mergeSidebarNavItems } from "../builtin-nav";

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
  activeHistoryEntryId?: string;
  scheduledTaskCount?: number;
  sidebarResizeMax?: number;
  sidebarResizeMin?: number;
  sidebarResizeValue?: number;
  skillCount?: number;
  /** Custom sidebar nav items. Falls back to built-in defaults when omitted. */
  sidebarNavItems?: SidebarNavItem[];
  onDeleteHistoryEntry?: (id: string) => void;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
  onResizeKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectHistoryEntry?: (id: string) => void;
  onSidebarSearchQueryChange: (query: string) => void;
  onChangeActiveView?: (view: ActiveView) => void;
  onNavigateDirectory?: (path: string) => void;
}

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
  activeHistoryEntryId,
  scheduledTaskCount = 0,
  sidebarResizeMax,
  sidebarResizeMin,
  sidebarResizeValue,
  skillCount = 0,
  sidebarNavItems,
  onDeleteHistoryEntry,
  onModelSettingsChange,
  onModelConfigurationChange,
  onResizeKeyDown,
  onResizeStart,
  onSelectHistoryEntry,
  onSidebarSearchQueryChange,
  onChangeActiveView,
  onNavigateDirectory,
}: SidebarProps) {
  const filteredHistoryEntries = filterWorkbenchHistoryEntries(
    historyEntries,
    sidebarSearchQuery,
  );
  const hasHistorySearch = sidebarSearchQuery.trim().length > 0;

  const effectiveNavItems = useMemo(
    () =>
      sidebarNavItems
        ? mergeSidebarNavItems(
            getBuiltinSidebarNavItems(labels, scheduledTaskCount, skillCount),
            sidebarNavItems,
          )
        : getBuiltinSidebarNavItems(labels, scheduledTaskCount, skillCount),
    [labels, scheduledTaskCount, skillCount, sidebarNavItems],
  );

  // Derive collapsible view IDs from nav items
  const collapsibleViewIds = useMemo(
    () => effectiveNavItems.filter((ni) => ni.collapsible).map((ni) => ni.viewId),
    [effectiveNavItems],
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const vid of collapsibleViewIds) {
      initial[vid] = activeView !== vid;
    }
    return initial;
  });
  const [expandedHistoryGroups, setExpandedHistoryGroups] = useState<Record<string, boolean>>({});
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    if (collapsibleViewIds.includes(activeView)) {
      setCollapsedGroups((current) => ({ ...current, [activeView]: false }));
    }
  }, [activeView, collapsibleViewIds]);

  // Seed newly loaded collapsible items into collapsedGroups (handles async workspace loading)
  useEffect(() => {
    setCollapsedGroups((current) => {
      const next = { ...current };
      let changed = false;
      for (const vid of collapsibleViewIds) {
        if (!(vid in next)) {
          next[vid] = activeView !== vid;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [collapsibleViewIds, activeView]);

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
    const isActive =
      view === "chat"
        ? activeView === view && !activeHistoryEntryId
        : activeView === view;
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
        <span className={`javis-nav-icon icon-${view}`}>{icon}</span>
        <span>{label}</span>
        {badge != null && badge > 0 ? <span className="javis-nav-badge">{badge}</span> : null}
      </div>
    );
  }

  function navCollapsibleItem(viewId: string, icon: string, label: string) {
    const isActive = activeView === viewId;
    const isCollapsed = collapsedGroups[viewId] ?? true;

    function handleClick() {
      if (isActive) {
        setCollapsedGroups((current) => ({ ...current, [viewId]: !current[viewId] }));
        return;
      }
      setCollapsedGroups((current) => ({ ...current, [viewId]: false }));
      onChangeActiveView?.(viewId);
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
        <span className={`javis-nav-icon icon-${viewId}`}>{icon}</span>
        <span>{label}</span>
        <span className="javis-nav-caret">{isCollapsed ? "v" : "^"}</span>
      </div>
    );
  }

  function navSubitem(viewId: string, label: string, path?: string) {
    function handleClick() {
      onChangeActiveView?.(viewId);
      if (path) {
        onNavigateDirectory?.(path);
      }
    }

    return (
      <button
        className="javis-nav-subitem"
        onClick={handleClick}
        type="button"
      >
        <span />
        <span>{label}</span>
      </button>
    );
  }

  function renderNavGroups() {
    const groups = new Map<string, SidebarNavItem[]>();
    for (const item of effectiveNavItems) {
      const existing = groups.get(item.group);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(item.group, [item]);
      }
    }

    const groupLabels: Record<string, string | undefined> = {
      primary: undefined, // no section header for primary
      knowledge: labels.localKnowledgeBase,
      custom: labels.plugins,
    };

    return [...groups.entries()].map(([groupType, items]) => (
      <div className={`javis-nav-group ${groupType}`} key={groupType}>
        {groupLabels[groupType] && (
          <p className="javis-nav-section">{groupLabels[groupType]}</p>
        )}
        {items.map((item) => {
          if (item.collapsible) {
            const isCollapsed = collapsedGroups[item.viewId] ?? true;
            return (
              <React.Fragment key={item.viewId}>
                {navCollapsibleItem(item.viewId, item.icon, item.label)}
                {!isCollapsed &&
                  item.subitems?.map((sub) => (
                    navSubitem(item.viewId, sub.label, sub.path)
                  ))}
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={item.viewId}>
              {navItem(item.viewId, item.icon, item.label, item.badge)}
            </React.Fragment>
          );
        })}
      </div>
    ));
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
        {renderNavGroups()}
        <div className="javis-nav-group">
          <p className="javis-nav-section">{labels.projects}</p>
          {workspaceGroups.length > 0 ? (
            workspaceGroups.map((group) => {
              const hasPreview = group.entries.length > HISTORY_PREVIEW_COUNT;
              const isExpanded = expandedHistoryGroups[group.key] ?? false;
              const isCollapsed = collapsedWorkspaceGroups[group.key] ?? false;
              const visibleEntries = isExpanded
                ? group.entries
                : group.entries.slice(0, HISTORY_PREVIEW_COUNT);

              return (
                <section className="javis-history-workspace-group" key={group.key}>
                  <button
                    aria-expanded={!isCollapsed}
                    className="javis-history-workspace-header"
                    onClick={() =>
                      setCollapsedWorkspaceGroups((current) => ({
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
                      {isCollapsed ? ">" : "v"}
                    </span>
                  </button>

                  {!isCollapsed ? (
                    <div className="javis-history-workspace-body">
                    {visibleEntries.length > 0 ? (
                      visibleEntries.map((entry) => {
                        const isActiveHistoryEntry =
                          activeView === "chat" && activeHistoryEntryId === entry.id;

                        return (
                        <div
                          className={`javis-history-entry ${isActiveHistoryEntry ? "active" : ""}`}
                          key={entry.id}
                        >
                          <button
                            aria-current={isActiveHistoryEntry ? "page" : undefined}
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
                        );
                      })
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
                  ) : null}
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
      <div
        aria-label={labels.sidebarResize}
        aria-orientation="vertical"
        aria-valuemax={sidebarResizeMax}
        aria-valuemin={sidebarResizeMin}
        aria-valuenow={sidebarResizeValue}
        className="javis-sidebar-resize-handle"
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
        role="separator"
        tabIndex={0}
        title={labels.sidebarResize}
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
