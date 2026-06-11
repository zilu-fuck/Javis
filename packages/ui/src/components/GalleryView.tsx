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
}: GalleryViewProps) {
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

  function selectImage(image: WorkbenchFileEntry) {
    setSelectedFilePath(image.path);
    onOpenDetail?.(createFileDetailItem(image, {
      categoryLabels,
      kindLabel: isChineseLocale(locale) ? "图片" : "Image",
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
        addLabel="添加目录"
        countLabel={createCountLabel(labels.gallery, images.length)}
        icon="#"
        onAdd={() => setShowDirPanel(true)}
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
        addLabel="添加目录"
        countLabel={createCountLabel(labels.gallery, images.length)}
        icon="#"
        onAdd={() => setShowDirPanel(true)}
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
      addLabel="添加目录"
      activeTabIndex={activeTabIndex}
      countLabel={createCountLabel(labels.gallery, filtered.length)}
      icon="#"
      onAdd={() => setShowDirPanel(true)}
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
          <p>{labels.noImagesFound}</p>
        </div>
      ) : (
        <div className="javis-gallery-grid">
          {filtered.map((image) => (
            <GalleryItem
              categoryLabels={categoryLabels}
              customCategory={customCategory}
              effectiveCategoryStats={effectiveCategoryStats}
              image={image}
              key={image.path}
              menuOpen={menuFilePath === image.path}
              selected={selectedFilePath === image.path}
              onCloseCategoryMenu={closeCategoryMenu}
              onCustomCategoryChange={setCustomCategory}
              onOpen={onOpen}
              onOpenCategoryMenu={() => {
                setMenuFilePath(image.path);
                setCustomCategory(image.category ?? "");
              }}
              onUpdateCategory={updateCategory}
              onSelect={selectImage}
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
  customCategory,
  effectiveCategoryStats,
  menuOpen,
  onCloseCategoryMenu,
  onCustomCategoryChange,
  onOpen,
  onOpenCategoryMenu,
  onSelect,
  onUpdateCategory,
  selected,
}: {
  image: WorkbenchFileEntry;
  categoryLabels: Record<string, string>;
  customCategory: string;
  effectiveCategoryStats: { category: string; count: number }[];
  menuOpen: boolean;
  onCloseCategoryMenu: () => void;
  onCustomCategoryChange: (category: string) => void;
  onOpen?: (path: string) => void;
  onOpenCategoryMenu: () => void;
  onSelect: (image: WorkbenchFileEntry) => void;
  onUpdateCategory: (path: string, category: string) => void;
  selected: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showThumbnail = Boolean(image.thumbnailUrl && !failed);

  return (
    <div className="javis-gallery-cell">
      <button
        className={`javis-gallery-thumb${selected ? " selected" : ""}`}
        onClick={() => onSelect(image)}
        onDoubleClick={() => onOpen?.(image.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenCategoryMenu();
        }}
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
      {menuOpen && (
        <FileCategoryMenu
          categoryLabels={categoryLabels}
          customCategory={customCategory}
          effectiveCategoryStats={effectiveCategoryStats}
          entry={image}
          onClose={onCloseCategoryMenu}
          onCustomCategoryChange={onCustomCategoryChange}
          onUpdateCategory={onUpdateCategory}
        />
      )}
    </div>
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
