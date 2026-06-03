import { useState } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchProgress,
} from "../types";
import { formatModifiedTime, formatSize } from "../utils";
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
  onRefresh?: () => void;
  onRefreshScan?: () => void;
  onClassifyDocuments?: () => void;
  onCancelClassify?: () => void;
  onOpen?: (path: string) => void;
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
  onRefresh,
  onRefreshScan,
  onClassifyDocuments,
  onCancelClassify,
  onOpen,
}: DocumentsViewProps) {
  const labels = locale.labels;
  const categoryLabels = locale.categoryLabels ?? {};
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const filtered = documents.filter((doc) => {
    const matchesQuery = doc.name.toLowerCase().includes(query.toLowerCase());
    const matchesCategory = activeCategory == null || doc.category === activeCategory;
    return matchesQuery && matchesCategory;
  });

  const categoryTabs = [
    { key: null, label: labels.allCategories, count: documents.length },
    ...categoryStats.map((s) => ({
      key: s.category,
      label: categoryLabels[s.category] ?? s.category,
      count: s.count,
    })),
  ];

  const activeTabIndex = activeCategory == null
    ? 0
    : categoryTabs.findIndex((t) => t.key === activeCategory);

  function handleTabChange(index: number) {
    setActiveCategory(categoryTabs[index]?.key ?? null);
  }

  const classifiedCount = documents.filter((d) => d.category != null).length;
  const unclassifiedCount = documents.length - classifiedCount;

  const actions = (
    <>
      <label className="javis-resource-search">
        <span aria-hidden="true">⌕</span>
        <input
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={labels.searchPlaceholder}
          value={query}
        />
      </label>
      <ResourceIconButton label={labels.retry} onClick={onRefresh}>⟳</ResourceIconButton>
      <ResourceIconButton
        label={scanning ? labels.scanInProgress : labels.retry}
        onClick={onRefreshScan}
      >
        {scanning ? <span className="javis-spinner javis-spinner--small" /> : "⟳"}
      </ResourceIconButton>
      {classifying ? (
        <ResourceIconButton label={labels.cancelClassify} onClick={onCancelClassify}>
          ■
        </ResourceIconButton>
      ) : (
        <ResourceIconButton label={labels.classifyButton} onClick={onClassifyDocuments}>
          ✦
        </ResourceIconButton>
      )}
      <div className="javis-resource-segment">
        <button type="button">▦</button>
        <button className="active" type="button">☷</button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.documents, documents.length)}
        icon="▣"
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
        icon="▣"
        title={labels.documents}
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
      countLabel={createCountLabel(labels.documents, filtered.length)}
      icon="▣"
      onTabChange={handleTabChange}
      tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
      title={labels.documents}
    >
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
          {classifying && classifyProgress && (
            <>
              <ProgressBar
                current={classifyProgress.completed ?? classifyProgress.current}
                label={labels.classifyButton}
                startedAt={classifyProgress.startedAt}
                total={classifyProgress.total}
              />
              {unclassifiedCount > 0 && (
                <span className="javis-classify-pending">
                  ({unclassifiedCount.toLocaleString()} {labels.noDocumentsFound})
                </span>
              )}
            </>
          )}
          {classifyProgress && !classifying && (
            <ProgressBar
              current={classifyProgress.completed ?? classifyProgress.current}
              label={labels.classifyButton}
              startedAt={classifyProgress.startedAt}
              total={classifyProgress.total}
            />
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
                    onClick={() => onOpen?.(doc.path)}
                    type="button"
                  >
                    <span className="javis-doc-ext">
                      {doc.extension?.toUpperCase() ?? "?"}
                    </span>
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
                    <span className="javis-category-badge javis-category-badge--unclassified">
                      —
                    </span>
                  )}
                </td>
                <td>
                  {doc.modifiedAt
                    ? formatModifiedTime(doc.modifiedAt)
                    : "—"}
                </td>
                <td>
                  {doc.sizeBytes != null ? formatSize(doc.sizeBytes) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ResourceShell>
  );
}
