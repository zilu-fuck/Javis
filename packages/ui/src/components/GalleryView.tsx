import { useState } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { formatModifiedTime, formatSize } from "../utils";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface GalleryViewProps {
  images: WorkbenchFileEntry[];
  locale: WorkbenchLocale;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onOpen?: (path: string) => void;
}

export function GalleryView({
  images,
  locale,
  loading,
  error,
  onRefresh,
  onOpen,
}: GalleryViewProps) {
  const labels = locale.labels;
  const [query, setQuery] = useState("");
  const filtered = images.filter((image) =>
    image.name.toLowerCase().includes(query.toLowerCase()),
  );
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
      <ResourceIconButton label="Filter">▽</ResourceIconButton>
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
      countLabel={createCountLabel(labels.gallery, filtered.length)}
      icon="▣"
      tabs={["全部图片", "图片识别", "人物印象", "足迹地点", "时光长廊"]}
      title={labels.gallery}
    >
      {filtered.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.noImagesFound}</p>
        </div>
      ) : (
        <div className="javis-gallery-grid">
          {filtered.map((image) => (
            <GalleryItem image={image} key={image.path} onOpen={onOpen} />
          ))}
        </div>
      )}
    </ResourceShell>
  );
}

function GalleryItem({
  image,
  onOpen,
}: {
  image: WorkbenchFileEntry;
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
      <span className="javis-gallery-name">{image.name}</span>
    </button>
  );
}
