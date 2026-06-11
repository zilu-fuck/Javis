import { useEffect, useState } from "react";
import type {
  ScanRootItem,
  WorkbenchDetailItem,
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchProgress,
} from "../types";
import { createFileDetailItem } from "../detail-items";
import { formatModifiedTime, formatSize, isChineseLocale } from "../utils";
import { DirectoryPanel } from "./DirectoryPanel";
import { ProgressBar } from "./ProgressBar";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface DocumentsViewProps {
  documents: WorkbenchFileEntry[];
  locale: WorkbenchLocale;
  loading?: boolean;
  loadProgress?: WorkbenchProgress;
  error?: string;
  scanning?: boolean;
  scanProgress?: WorkbenchProgress;
  classifying?: boolean;
  classifyProgress?: WorkbenchProgress & { completed?: number };
  classifyError?: string;
  categoryStats?: { category: string; count: number }[];
  selectedCategory?: string | null;
  resourceScanRoots?: ScanRootItem[];
  onRefresh?: () => void;
  onRefreshScan?: () => void;
  onClassifyDocuments?: () => void;
  onCancelClassify?: () => void;
  onOpen?: (path: string) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
  onToggleScanRoot?: (id: string, enabled: boolean) => void;
  onRemoveScanRoot?: (id: string) => void;
  onAddScanRoot?: (path: string) => void;
  onRefreshScanRoot?: (id: string) => void;
  onRefreshResourceRoots?: () => void;
  onUpdateCategory?: (path: string, category: string) => void;
}

export function DocumentsView({
  documents,
  locale,
  loading,
  loadProgress,
  error,
  scanning,
  scanProgress,
  classifying,
  classifyProgress,
  classifyError,
  categoryStats = [],
  selectedCategory,
  resourceScanRoots = [],
  onRefresh,
  onRefreshScan,
  onClassifyDocuments,
  onCancelClassify,
  onOpen,
  onOpenDetail,
  onToggleScanRoot,
  onRemoveScanRoot,
  onAddScanRoot,
  onRefreshScanRoot,
  onRefreshResourceRoots,
  onUpdateCategory,
}: DocumentsViewProps) {
  const labels = locale.labels;
  const categoryLabels = locale.categoryLabels ?? {};
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showDirPanel, setShowDirPanel] = useState(false);
  const [menuFilePath, setMenuFilePath] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [customCategory, setCustomCategory] = useState("");

  useEffect(() => {
    if (selectedCategory !== undefined) {
      setActiveCategory(selectedCategory);
    }
  }, [selectedCategory]);

  const filtered = documents.filter((doc) => {
    const q = query.toLowerCase();
    const matchesQuery =
      q === "" ||
      doc.name.toLowerCase().includes(q) ||
      doc.path.toLowerCase().includes(q) ||
      (doc.extension ?? "").toLowerCase().includes(q) ||
      (doc.category ?? "").toLowerCase().includes(q) ||
      (doc.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
    const matchesCategory = activeCategory == null || doc.category === activeCategory;
    return matchesQuery && matchesCategory;
  });

  const categoryTabs = [
    { key: null, label: labels.allCategories, count: documents.length },
    ...buildCategoryStats(documents, categoryStats).map((s) => ({
      key: s.category,
      label: categoryLabels[s.category] ?? s.category,
      count: s.count,
    })),
  ];
  const activeTabIndex = activeCategory == null
    ? 0
    : Math.max(0, categoryTabs.findIndex((t) => t.key === activeCategory));
  const unclassifiedCount = documents.filter((doc) => doc.category == null).length;
  const effectiveCategoryStats = categoryTabs
    .slice(1)
    .map((tab) => ({ category: tab.key ?? "", count: tab.count }))
    .filter((stat) => stat.category);

  function handleTabChange(index: number) {
    setActiveCategory(categoryTabs[index]?.key ?? null);
  }

  function closeCategoryMenu() {
    setMenuFilePath(null);
    setCustomCategory("");
  }

  function updateCategory(path: string, category: string) {
    const trimmed = category.trim();
    if (!trimmed) return;
    onUpdateCategory?.(path, trimmed);
    setActiveCategory(trimmed);
    closeCategoryMenu();
  }

  function selectDocument(doc: WorkbenchFileEntry) {
    setSelectedFilePath(doc.path);
    onOpenDetail?.(createFileDetailItem(doc, {
      categoryLabels,
      kindLabel: isChineseLocale(locale) ? labels.documents : "Document",
      locale,
    }));
  }

  useEffect(() => {
    if (activeCategory != null && !categoryTabs.some((tab) => tab.key === activeCategory)) {
      setActiveCategory(null);
    }
  }, [activeCategory, categoryTabs]);

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
      <ResourceIconButton label={showDirPanel ? "关闭目录" : "目录"} onClick={() => setShowDirPanel((v) => !v)}>
        <span
          className={`javis-resource-action-icon ${showDirPanel ? "icon-close" : "icon-folder"}`}
          aria-hidden="true"
        />
      </ResourceIconButton>
      <ResourceIconButton label={labels.retry} onClick={onRefresh}>
        <span className="javis-resource-action-icon icon-refresh" aria-hidden="true" />
      </ResourceIconButton>
      <ResourceIconButton label={scanning ? labels.scanInProgress : "扫描目录"} onClick={onRefreshResourceRoots ?? onRefreshScan}>
        {scanning ? (
          <span className="javis-spinner javis-spinner--small" />
        ) : (
          <span className="javis-resource-action-icon icon-folder-scan" aria-hidden="true" />
        )}
      </ResourceIconButton>
      {classifying ? (
        <ResourceIconButton label={labels.cancelClassify} onClick={onCancelClassify}>
          <span className="javis-resource-action-icon icon-close" aria-hidden="true" />
        </ResourceIconButton>
      ) : (
        <ResourceIconButton label={labels.classifyButton} onClick={onClassifyDocuments}>
          <span className="javis-resource-action-icon icon-ai" aria-hidden="true" />
        </ResourceIconButton>
      )}
      <div className="javis-resource-segment">
        <button aria-label="网格视图" title="网格视图" type="button">
          <span className="javis-resource-action-icon icon-grid" aria-hidden="true" />
        </button>
        <button aria-label="列表视图" title="列表视图" className="active" type="button">
          <span className="javis-resource-action-icon icon-list" aria-hidden="true" />
        </button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        addLabel="添加目录"
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="#"
        onAdd={() => setShowDirPanel(true)}
        title={labels.documents}
      >
        <div className="javis-view-loading">
          <span className="javis-spinner" />
          <ProgressBar
            current={loadProgress?.current}
            indeterminate={!loadProgress}
            label={labels.scanInProgress}
            startedAt={loadProgress?.startedAt}
            total={loadProgress?.total}
          />
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        addLabel="添加目录"
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="#"
        onAdd={() => setShowDirPanel(true)}
        title={labels.documents}
      >
        <div className="javis-view-error">
          <p>{error}</p>
          <button onClick={onRefresh} type="button">{labels.retry}</button>
        </div>
      </ResourceShell>
    );
  }

  return (
    <ResourceShell
      actions={actions}
      addLabel="添加目录"
      activeTabIndex={activeTabIndex}
      countLabel={createCountLabel(labels.documents, filtered.length)}
      icon="#"
      onAdd={() => setShowDirPanel(true)}
      onTabChange={handleTabChange}
      tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
      title={labels.documents}
    >
      {showDirPanel && (
        <DirectoryPanel
          activeKind="documents"
          roots={resourceScanRoots}
          onAdd={(path) => onAddScanRoot?.(path)}
          onClose={() => setShowDirPanel(false)}
          onRefresh={(id) => onRefreshScanRoot?.(id)}
          onRemove={(id) => onRemoveScanRoot?.(id)}
          onToggle={(id, enabled) => onToggleScanRoot?.(id, enabled)}
        />
      )}
      {(scanning || classifying || classifyProgress || classifyError) && (
        <div className="javis-classify-status">
          {classifyError && (
            <span className="javis-classify-error">{classifyError}</span>
          )}
          {scanning && (
            <ProgressBar
              current={scanProgress?.current}
              indeterminate={!scanProgress}
              label={labels.scanInProgress}
              startedAt={scanProgress?.startedAt}
              total={scanProgress?.total}
            />
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
          <p>{labels.noDocumentsFound}</p>
        </div>
      ) : (
        <table className="javis-doc-table">
          <thead>
            <tr>
              <th>{labels.documents}</th>
              <th>{labels.categoryBadge}</th>
              <th>{labels.modified}</th>
              <th>{labels.status}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((doc) => (
              <tr
                className={selectedFilePath === doc.path ? "selected" : undefined}
                key={doc.path}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuFilePath(doc.path);
                  setCustomCategory(doc.category ?? "");
                }}
              >
                <td>
                  <button
                    className="javis-doc-link"
                    onClick={() => selectDocument(doc)}
                    onDoubleClick={() => onOpen?.(doc.path)}
                    type="button"
                  >
                    <span className="javis-doc-ext">{doc.extension?.toUpperCase() ?? "?"}</span>
                    {doc.name}
                  </button>
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="javis-doc-tags">
                      {doc.tags.map((tag) => (
                        <span className="javis-tag" key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                  {menuFilePath === doc.path && (
                    <FileCategoryMenu
                      categoryLabels={categoryLabels}
                      customCategory={customCategory}
                      effectiveCategoryStats={effectiveCategoryStats}
                      entry={doc}
                      onClose={closeCategoryMenu}
                      onCustomCategoryChange={setCustomCategory}
                      onUpdateCategory={updateCategory}
                    />
                  )}
                </td>
                <td>
                  {doc.category ? (
                    <span className="javis-category-badge">
                      {categoryLabels[doc.category] ?? doc.category}
                    </span>
                  ) : (
                    <span className="javis-category-badge javis-category-badge--unclassified">-</span>
                  )}
                </td>
                <td>{doc.modifiedAt ? formatModifiedTime(doc.modifiedAt) : "-"}</td>
                <td>{doc.sizeBytes != null ? formatSize(doc.sizeBytes) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ResourceShell>
  );
}

function buildCategoryStats(
  entries: WorkbenchFileEntry[],
  fallbackStats: { category: string; count: number }[],
) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.category) continue;
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  const derived = [...counts.entries()].map(([category, count]) => ({ category, count }));
  return (derived.length > 0 ? derived : fallbackStats).sort((a, b) => b.count - a.count);
}

function FileCategoryMenu({
  entry,
  categoryLabels,
  customCategory,
  effectiveCategoryStats,
  onClose,
  onCustomCategoryChange,
  onUpdateCategory,
}: {
  entry: WorkbenchFileEntry;
  categoryLabels: Record<string, string>;
  customCategory: string;
  effectiveCategoryStats: { category: string; count: number }[];
  onClose: () => void;
  onCustomCategoryChange: (category: string) => void;
  onUpdateCategory: (path: string, category: string) => void;
}) {
  return (
    <div className="javis-app-context-menu javis-file-context-menu" role="menu">
      <strong>{entry.name}</strong>
      {effectiveCategoryStats.length > 0 && (
        <div className="javis-app-context-options">
          {effectiveCategoryStats.map((stat) => (
            <button
              key={stat.category}
              onClick={() => onUpdateCategory(entry.path, stat.category)}
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
          onUpdateCategory(entry.path, customCategory);
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
