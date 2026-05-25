import { useEffect, useState } from "react";
import type {
  ActiveView,
  WorkbenchHistoryEntry,
  WorkbenchLocale,
  WorkbenchModelSettings,
} from "../types";
import { filterWorkbenchHistoryEntries, formatModifiedTime, translateWorkbenchText } from "../utils";
import { ModelSettings } from "./ModelSettings";

interface SidebarProps {
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  modelSettings: WorkbenchModelSettings;
  historyEntries: WorkbenchHistoryEntry[];
  sidebarSearchQuery: string;
  activeView?: ActiveView;
  scheduledTaskCount?: number;
  skillCount?: number;
  onDeleteHistoryEntry?: (id: string) => void;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onSelectHistoryEntry?: (id: string) => void;
  onSidebarSearchQueryChange: (query: string) => void;
  onChangeActiveView?: (view: ActiveView) => void;
}

type CollapsibleView = "documents" | "gallery" | "computer";

export function Sidebar({
  labels,
  locale,
  modelSettings,
  historyEntries,
  sidebarSearchQuery,
  activeView = "chat",
  scheduledTaskCount = 0,
  skillCount = 0,
  onDeleteHistoryEntry,
  onModelSettingsChange,
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

  useEffect(() => {
    if (activeView === "documents" || activeView === "gallery" || activeView === "computer") {
      setCollapsedGroups((current) => ({ ...current, [activeView]: false }));
    }
  }, [activeView]);

  function navItem(
    view: ActiveView,
    icon: string,
    label: string,
    badge?: number,
  ) {
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
        {badge != null && badge > 0 && (
          <span className="javis-nav-badge">{badge}</span>
        )}
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
        <span className="javis-nav-caret">{isCollapsed ? "⌄" : "⌃"}</span>
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
        <span aria-hidden="true">⌕</span>
        <input
          aria-label={labels.searchPlaceholder}
          onChange={(event) =>
            onSidebarSearchQueryChange(event.currentTarget.value)
          }
          placeholder={labels.searchPlaceholder}
          value={sidebarSearchQuery}
        />
      </label>
      <nav className="javis-nav" aria-label={labels.workspaceNavigation}>
        <div className="javis-nav-group primary">
          {navItem("chat", "+", labels.newChat)}
          {navItem("automated", "●", labels.automatedTasks, scheduledTaskCount)}
          {navItem("skills", "#", labels.skillMarket, skillCount)}
        </div>
        <div className="javis-nav-group">
          <p className="javis-nav-section">{labels.localKnowledgeBase}</p>
          {navItem("apps", "▦", labels.apps)}
          {navCollapsibleItem("documents", "▣", labels.documents)}
          {!collapsedGroups.documents && (
            <>
              {navSubitem("文档识别")}
              {navSubitem("课件")}
              {navSubitem("书籍")}
              {navSubitem("论文")}
            </>
          )}
          {navCollapsibleItem("gallery", "□", labels.gallery)}
          {!collapsedGroups.gallery && (
            <>
              {navSubitem("图片识别")}
              {navSubitem("人物印象")}
              {navSubitem("足迹地点")}
              {navSubitem("时光长廊")}
            </>
          )}
          {navCollapsibleItem("computer", "▰", labels.thisComputer)}
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
          <p className="javis-nav-section">{labels.history}</p>
          {filteredHistoryEntries.length > 0 ? (
            filteredHistoryEntries.map((entry) => (
              <div className="javis-history-entry" key={entry.id}>
                <button
                  className="javis-history-select"
                  onClick={() => onSelectHistoryEntry?.(entry.id)}
                  type="button"
                >
                  <span className="javis-nav-icon">◒</span>
                  <span>
                    <strong>
                      {translateWorkbenchText(entry.title, locale)}
                    </strong>
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
                  ×
                </button>
              </div>
            ))
          ) : (
            <div className="javis-nav-item muted">
              <span className="javis-nav-icon">○</span>
              <span>
                {hasHistorySearch ? labels.historyNoMatches : labels.historyEmpty}
              </span>
            </div>
          )}
        </div>
      </nav>
      <ModelSettings
        labels={labels}
        modelSettings={modelSettings}
        onModelSettingsChange={onModelSettingsChange}
      />
      <div className="javis-sidebar-footer">
        <span className="javis-avatar">J</span>
        <span>{labels.profileName}</span>
        <span className="javis-device-mark">▯</span>
      </div>
    </aside>
  );
}
