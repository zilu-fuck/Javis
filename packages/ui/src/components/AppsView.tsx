import { useEffect, useState } from "react";
import type { WorkbenchAppEntry, WorkbenchDetailItem, WorkbenchLocale, WorkbenchProgress } from "../types";
import { createAppDetailItem } from "../detail-items";
import { ProgressBar } from "./ProgressBar";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

const CONTEXT_MENU_WIDTH = 220;

interface AppsViewProps {
  apps: WorkbenchAppEntry[];
  locale: WorkbenchLocale;
  loading?: boolean;
  progress?: WorkbenchProgress;
  error?: string;
  classifying?: boolean;
  classifyProgress?: WorkbenchProgress & { completed?: number };
  classifyError?: string;
  categoryStats?: { category: string; count: number }[];
  selectedCategory?: string | null;
  onRefresh?: () => void;
  onClassifyApps?: () => void;
  onCancelClassifyApps?: () => void;
  onUpdateAppCategory?: (path: string, category: string) => void;
  onOpen?: (path: string) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
}

export function AppsView({
  apps,
  locale,
  loading,
  progress,
  error,
  classifying,
  classifyProgress,
  classifyError,
  categoryStats = [],
  selectedCategory,
  onRefresh,
  onClassifyApps,
  onCancelClassifyApps,
  onUpdateAppCategory,
  onOpen,
  onOpenDetail,
}: AppsViewProps) {
  const labels = locale.labels;
  const categoryLabels = locale.categoryLabels ?? {};
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [menuAppPath, setMenuAppPath] = useState<string | null>(null);
  const [menuSide, setMenuSide] = useState<"left" | "right">("right");
  const [selectedAppPath, setSelectedAppPath] = useState<string | null>(null);
  const [customCategory, setCustomCategory] = useState("");

  useEffect(() => {
    if (selectedCategory !== undefined) {
      setActiveCategory(selectedCategory);
    }
  }, [selectedCategory]);

  const filtered = apps.filter((app) => {
    const q = query.toLowerCase();
    const matchesQuery =
      q === "" ||
      app.name.toLowerCase().includes(q) ||
      app.path.toLowerCase().includes(q) ||
      (app.publisher ?? "").toLowerCase().includes(q) ||
      (app.category ?? "").toLowerCase().includes(q) ||
      (app.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
    const matchesCategory = activeCategory == null || app.category === activeCategory;
    return matchesQuery && matchesCategory;
  });

  const effectiveCategoryStats = buildCategoryStats(apps, categoryStats);
  const categoryTabs = [
    { key: null, label: labels.allCategories, count: apps.length },
    ...effectiveCategoryStats.map((s) => ({
      key: s.category,
      label: categoryLabels[s.category] ?? s.category,
      count: s.count,
    })),
  ];
  const activeTabIndex = activeCategory == null
    ? 0
    : Math.max(0, categoryTabs.findIndex((t) => t.key === activeCategory));
  const unclassifiedCount = apps.filter((app) => app.category == null).length;

  function handleTabChange(index: number) {
    setActiveCategory(categoryTabs[index]?.key ?? null);
  }

  function closeContextMenu() {
    setMenuAppPath(null);
    setCustomCategory("");
  }

  function updateCategory(path: string, category: string) {
    const trimmed = category.trim();
    if (!trimmed) return;
    onUpdateAppCategory?.(path, trimmed);
    setActiveCategory(trimmed);
    closeContextMenu();
  }

  function selectApp(app: WorkbenchAppEntry) {
    setSelectedAppPath(app.path);
    onOpenDetail?.(createAppDetailItem(app, categoryLabels, locale));
  }

  const actions = (
    <>
      <label className="javis-resource-search">
        <span className="javis-resource-action-icon icon-search" aria-hidden="true" />
        <input
          aria-label={labels.searchPlaceholder}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={labels.searchPlaceholder}
          value={query}
        />
      </label>
      <ResourceIconButton label={labels.retry} onClick={onRefresh}>
        <span className="javis-resource-action-icon icon-refresh" aria-hidden="true" />
      </ResourceIconButton>
      {classifying ? (
        <ResourceIconButton label={labels.cancelClassify} onClick={onCancelClassifyApps}>
          <span className="javis-resource-action-icon icon-close" aria-hidden="true" />
        </ResourceIconButton>
      ) : (
        <ResourceIconButton label={labels.classifyButton} onClick={onClassifyApps}>
          <span className="javis-resource-action-icon icon-ai" aria-hidden="true" />
        </ResourceIconButton>
      )}
      <div className="javis-resource-segment">
        <button aria-label="网格视图" title="网格视图" className="active" type="button">
          <span className="javis-resource-action-icon icon-grid" aria-hidden="true" />
        </button>
        <button aria-label="列表视图" title="列表视图" type="button">
          <span className="javis-resource-action-icon icon-list" aria-hidden="true" />
        </button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        activeTabIndex={activeTabIndex}
        countLabel={createCountLabel(labels.apps, apps.length)}
        icon="#"
        onTabChange={handleTabChange}
        tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
        title={labels.apps}
      >
        <div className="javis-view-loading">
          <span className="javis-spinner" />
          <ProgressBar
            current={progress?.current}
            indeterminate={!progress}
            label={labels.scanInProgress}
            startedAt={progress?.startedAt}
            total={progress?.total}
          />
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        activeTabIndex={activeTabIndex}
        countLabel={createCountLabel(labels.apps, apps.length)}
        icon="#"
        onTabChange={handleTabChange}
        tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
        title={labels.apps}
      >
        <div className="javis-view-error">
          <p>{error}</p>
          <button onClick={onRefresh} type="button">
            {labels.retry}
          </button>
        </div>
      </ResourceShell>
    );
  }

  return (
    <ResourceShell
      actions={actions}
      activeTabIndex={activeTabIndex}
      countLabel={createCountLabel(labels.apps, filtered.length)}
      icon="#"
      onTabChange={handleTabChange}
      tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
      title={labels.apps}
    >
      {(classifying || classifyProgress || classifyError) && (
        <div className="javis-classify-status">
          {classifyError && (
            <span className="javis-classify-error">{classifyError}</span>
          )}
          {classifyProgress && (
            <ProgressBar
              current={classifyProgress.completed ?? classifyProgress.current}
              label={labels.classifyButton}
              startedAt={classifyProgress.startedAt}
              total={classifyProgress.total}
            />
          )}
          {classifying && unclassifiedCount > 0 && (
            <span className="javis-classify-pending">
              ({unclassifiedCount.toLocaleString()} pending)
            </span>
          )}
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.noAppsFound}</p>
        </div>
      ) : (
        <div className="javis-app-grid">
          {filtered.map((app) => (
            <div className="javis-app-cell" key={app.path}>
              <button
                className={`javis-app-card${selectedAppPath === app.path ? " selected" : ""}`}
                onClick={() => selectApp(app)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const hasRightRoom = rect.right + CONTEXT_MENU_WIDTH <= window.innerWidth;
                  setMenuSide(hasRightRoom ? "right" : "left");
                  setMenuAppPath(app.path);
                  setCustomCategory(app.category ?? "");
                }}
                onDoubleClick={() => onOpen?.(app.path)}
                type="button"
              >
                <AppIcon app={app} />
                <span className="javis-app-name">{app.name}</span>
                {app.category && (
                  <span className="javis-category-badge">
                    {categoryLabels[app.category] ?? app.category}
                  </span>
                )}
                {app.publisher && (
                  <span className="javis-app-publisher">{app.publisher}</span>
                )}
                {app.tags && app.tags.length > 0 && (
                  <span className="javis-doc-tags">
                    {app.tags.map((tag) => (
                      <span className="javis-tag" key={tag}>{tag}</span>
                    ))}
                  </span>
                )}
              </button>
              {menuAppPath === app.path && (
                <AppCategoryMenu
                  app={app}
                  categoryLabels={categoryLabels}
                  customCategory={customCategory}
                  effectiveCategoryStats={effectiveCategoryStats}
                  menuSide={menuSide}
                  onClose={closeContextMenu}
                  onCustomCategoryChange={setCustomCategory}
                  onUpdateCategory={updateCategory}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </ResourceShell>
  );
}

function AppIcon({ app }: { app: WorkbenchAppEntry }) {
  const [failed, setFailed] = useState(false);
  const initial = app.name.charAt(0).toUpperCase();

  if (app.iconPath && !failed) {
    return (
      <span className="javis-app-icon has-image">
        <img
          alt=""
          aria-hidden="true"
          onError={() => setFailed(true)}
          src={app.iconPath}
        />
      </span>
    );
  }

  return <span className="javis-app-icon">{initial}</span>;
}

function buildCategoryStats(
  apps: WorkbenchAppEntry[],
  fallbackStats: { category: string; count: number }[],
) {
  const counts = new Map<string, number>();
  for (const app of apps) {
    if (!app.category) continue;
    counts.set(app.category, (counts.get(app.category) ?? 0) + 1);
  }
  const derived = [...counts.entries()].map(([category, count]) => ({ category, count }));
  return (derived.length > 0 ? derived : fallbackStats).sort((a, b) => b.count - a.count);
}

function AppCategoryMenu({
  app,
  categoryLabels,
  customCategory,
  effectiveCategoryStats,
  menuSide,
  onClose,
  onCustomCategoryChange,
  onUpdateCategory,
}: {
  app: WorkbenchAppEntry;
  categoryLabels: Record<string, string>;
  customCategory: string;
  effectiveCategoryStats: { category: string; count: number }[];
  menuSide: "left" | "right";
  onClose: () => void;
  onCustomCategoryChange: (category: string) => void;
  onUpdateCategory: (path: string, category: string) => void;
}) {
  return (
    <div className={`javis-app-context-menu side-${menuSide}`} role="menu">
      <strong>{app.name}</strong>
      {effectiveCategoryStats.length > 0 && (
        <div className="javis-app-context-options">
          {effectiveCategoryStats.map((stat) => (
            <button
              key={stat.category}
              onClick={() => onUpdateCategory(app.path, stat.category)}
              type="button"
            >
              {categoryLabels[stat.category] ?? stat.category}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onUpdateCategory(app.path, customCategory);
        }}
      >
        <input
          aria-label="自定义分类"
          onChange={(event) => onCustomCategoryChange(event.currentTarget.value)}
          placeholder="自定义分类"
          value={customCategory}
        />
        <button type="submit">保存</button>
        <button onClick={onClose} type="button">取消</button>
      </form>
    </div>
  );
}
