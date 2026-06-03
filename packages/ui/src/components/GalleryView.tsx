import { useState } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchProgress,
} from "../types";
import { formatModifiedTime, formatSize } from "../utils";
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
  onRefresh?: () => void;
  onRefreshScan?: () => void;
  onClassifyDocuments?: () => void;
  onCancelClassify?: () => void;
  onOpen?: (path: string) => void;
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
  onRefresh,
  onRefreshScan,
  onClassifyDocuments,
  onCancelClassify,
  onOpen,
}: GalleryViewProps) {
  const labels = locale.labels;
  const categoryLabels = locale.categoryLabels ?? {};
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const filtered = images.filter((image) => {
    const matchesQuery = image.name.toLowerCase().includes(query.toLowerCase());
    const matchesCategory = activeCategory == null || image.category === activeCategory;
    return matchesQuery && matchesCategory;
  });

  const categoryTabs = [
    { key: null, label: labels.allCategories, count: images.length },
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

  const unclassifiedCount = images.filter((d) => d.category == null).length;

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
      <div className="javis-resource-slider" aria-hidden="true">
        <span>-</span>
        <span />
        <span>+</span>
      </div>
      <div className="javis-resource-segment wide">
        <button className="active" type="button">年</button>
        <button type="button">月</button>
        <button type="button">所有图片</button>
      </div>
    </>
  );

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={createCountLabel(labels.gallery, images.length)}
        icon="▣"
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
        icon="▣"
        title={labels.gallery}
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
      countLabel={createCountLabel(labels.gallery, filtered.length)}
      icon="▣"
      onTabChange={handleTabChange}
      tabs={categoryTabs.map((t) => `${t.label}(${t.count})`)}
      title={labels.gallery}
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
                  ({unclassifiedCount.toLocaleString()} pending)
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
  return (
    <button
      className="javis-gallery-thumb"
      onClick={() => onOpen?.(image.path)}
      title={`${image.name}\n${image.sizeBytes != null ? formatSize(image.sizeBytes) : ""}\n${image.modifiedAt ? formatModifiedTime(image.modifiedAt) : ""}`}
      type="button"
    >
      <span className="javis-gallery-icon">
        {image.name.charAt(0).toUpperCase()}
      </span>
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
