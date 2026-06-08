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

interface GalleryViewProps {
  images: WorkbenchFileEntry[];
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

export function GalleryView({
  images,
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
}: GalleryViewProps) {
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

  const filtered = images.filter((image) => {
    const q = query.toLowerCase();
    const matchesQuery =
      q === "" ||
      image.name.toLowerCase().includes(q) ||
      image.path.toLowerCase().includes(q) ||
      (image.extension ?? "").toLowerCase().includes(q) ||
      (image.category ?? "").toLowerCase().includes(q) ||
      (image.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
    const matchesCategory = activeCategory == null || image.category === activeCategory;
    return matchesQuery && matchesCategory;
  });

  const categoryTabs = [
    { key: null, label: labels.allCategories, count: images.length },
    ...buildCategoryStats(images, categoryStats).map((s) => ({
      key: s.category,
      label: categoryLabels[s.category] ?? s.category,
      count: s.count,
    })),
  ];
  const activeTabIndex = activeCategory == null
    ? 0
    : Math.max(0, categoryTabs.findIndex((t) => t.key === activeCategory));
  const unclassifiedCount = images.filter((image) => image.category == null).length;

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
      <div className="javis-resource-segment wide">
        <button aria-label="按年查看" title="按年查看" className="active" type="button">
          <span className="javis-resource-action-icon icon-calendar" aria-hidden="true" />
        </button>
        <button aria-label="按月查看" title="按月查看" type="button">
          <span className="javis-resource-action-icon icon-time" aria-hidden="true" />
        </button>
        <button aria-label="查看全部" title="查看全部" type="button">
          <span className="javis-resource-action-icon icon-grid" aria-hidden="true" />
        </button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.gallery, images.length)}
        icon="#"
        title={labels.gallery}
      >
        <div className="javis-view-loading">
          <ProgressBar
            current={loadProgress?.current}
            indeterminate={!loadProgress}
            label={labels.scanInProgress}
            startedAt={loadProgress?.startedAt}
            total={loadProgress?.total}
          />
        </div>
        <div className="javis-gallery-skeleton">
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="javis-gallery-thumb skeleton" key={i} />
          ))}
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.gallery, images.length)}
        icon="#"
        title={labels.gallery}
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
      countLabel={createCountLabel(labels.gallery, filtered.length)}
      icon="#"
      onTabChange={handleTabChange}
      tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
      title={labels.gallery}
    >
      {showDirPanel && (
        <DirectoryPanel
          activeKind="images"
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
          <p>{labels.noImagesFound}</p>
        </div>
      ) : (
        <div className="javis-gallery-grid">
          {filtered.map((image) => (
            <GalleryItem
              categoryLabels={categoryLabels}
              image={image}
              key={image.path}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </ResourceShell>
  );
}

function GalleryItem({
  image,
  categoryLabels,
  onOpen,
}: {
  image: WorkbenchFileEntry;
  categoryLabels: Record<string, string>;
  onOpen?: (path: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const showThumbnail = Boolean(image.thumbnailUrl && !failed);

  return (
    <button
      className="javis-gallery-thumb"
      onDoubleClick={() => onOpen?.(image.path)}
      title={`${image.name}\n${image.sizeBytes != null ? formatSize(image.sizeBytes) : ""}\n${image.modifiedAt ? formatModifiedTime(image.modifiedAt) : ""}`}
      type="button"
    >
      {showThumbnail ? (
        <img
          alt=""
          aria-hidden="true"
          className="javis-gallery-image"
          loading="lazy"
          onError={() => setFailed(true)}
          src={image.thumbnailUrl}
        />
      ) : (
        <span className="javis-gallery-icon">{image.name.charAt(0).toUpperCase()}</span>
      )}
      {image.category && (
        <span className="javis-gallery-category-badge">
          {categoryLabels[image.category] ?? image.category}
        </span>
      )}
      <span className="javis-gallery-name">{image.name}</span>
      {image.tags && image.tags.length > 0 && (
        <span className="javis-gallery-tags">
          {image.tags.slice(0, 2).map((tag) => (
            <span className="javis-tag" key={tag}>{tag}</span>
          ))}
        </span>
      )}
    </button>
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
