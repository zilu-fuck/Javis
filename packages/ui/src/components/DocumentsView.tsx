import { useEffect, useState } from "react";
import type {
  ScanRootItem,
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchProgress,
} from "../types";
import { formatModifiedTime, formatSize } from "../utils";
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
  categoryStats?: { category: string; count: number }[];
  selectedCategory?: string | null;
  resourceScanRoots?: ScanRootItem[];
  onRefresh?: () => void;
  onRefreshScan?: () => void;
  onClassifyDocuments?: () => void;
  onCancelClassify?: () => void;
  onOpen?: (path: string) => void;
  onToggleScanRoot?: (id: string, enabled: boolean) => void;
  onRemoveScanRoot?: (id: string) => void;
  onAddScanRoot?: (path: string) => void;
  onRefreshScanRoot?: (id: string) => void;
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
  categoryStats = [],
  selectedCategory,
  resourceScanRoots = [],
  onRefresh,
  onRefreshScan,
  onClassifyDocuments,
  onCancelClassify,
  onOpen,
  onToggleScanRoot,
  onRemoveScanRoot,
  onAddScanRoot,
  onRefreshScanRoot,
}: DocumentsViewProps) {
  const labels = locale.labels;
  const categoryLabels = locale.categoryLabels ?? {};
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showDirPanel, setShowDirPanel] = useState(false);

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

  function handleTabChange(index: number) {
    setActiveCategory(categoryTabs[index]?.key ?? null);
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
      <ResourceIconButton label={scanning ? labels.scanInProgress : "扫描目录"} onClick={onRefreshScan}>
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
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="#"
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
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="#"
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
      activeTabIndex={activeTabIndex}
      countLabel={createCountLabel(labels.documents, filtered.length)}
      icon="#"
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
      {(scanning || classifying || classifyProgress) && (
        <div className="javis-classify-status">
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
              <tr key={doc.path}>
                <td>
                  <button
                    className="javis-doc-link"
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
