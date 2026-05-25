import { useState } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { formatModifiedTime, formatSize } from "../utils";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface ComputerViewProps {
  entries: WorkbenchFileEntry[];
  currentPath: string;
  locale: WorkbenchLocale;
  loading?: boolean;
  error?: string;
  onNavigate?: (path: string) => void;
  onOpen?: (path: string) => void;
}

export function ComputerView({
  entries,
  currentPath,
  locale,
  loading,
  error,
  onNavigate,
  onOpen,
}: ComputerViewProps) {
  const labels = locale.labels;
  const [query, setQuery] = useState("");
  const filteredEntries = entries.filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase()),
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
      <ResourceIconButton label={labels.settings}>↕</ResourceIconButton>
      <div className="javis-resource-segment">
        <button type="button">▦</button>
        <button type="button">☷</button>
        <button className="active" type="button">▥</button>
      </div>
    </>
  );

  const pathParts = currentPath
    .split(/[\\/]/)
    .filter(Boolean);

  function buildBreadcrumbPath(index: number): string {
    if (index === 0 && pathParts[0]?.includes(":")) {
      return pathParts[0] + "\\";
    }
    return pathParts.slice(0, index + 1).join("\\");
  }

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={labels.thisComputer}
        icon="▰"
        title={labels.thisComputer}
      >
        <div className="javis-view-loading">
          <span className="javis-spinner" />
        </div>
      </ResourceShell>
    );
  }

  if (error) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={labels.thisComputer}
        icon="▰"
        title={labels.thisComputer}
      >
        <div className="javis-view-error">
          <p>{error}</p>
        </div>
      </ResourceShell>
    );
  }

  return (
    <ResourceShell
      actions={actions}
      countLabel={createCountLabel(labels.thisComputer, filteredEntries.length)}
      icon="▰"
      title={labels.thisComputer}
    >
      <nav className="javis-breadcrumb" aria-label={labels.fileExplorerBreadcrumb}>
        <button
          className="javis-breadcrumb-item"
          onClick={() => onNavigate?.(pathParts[0]?.includes(":") ? pathParts[0] + "\\" : "/")}
          type="button"
        >
          {labels.thisComputer}
        </button>
        {pathParts.map((part, i) => (
          <span key={i}>
            <span className="javis-breadcrumb-sep">/</span>
            <button
              className="javis-breadcrumb-item"
              onClick={() => onNavigate?.(buildBreadcrumbPath(i))}
              type="button"
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      {filteredEntries.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.fileExplorerEmpty}</p>
        </div>
      ) : (
        <div className="javis-file-list">
          {filteredEntries.map((entry) => (
            <button
              className={`javis-file-row ${entry.isDir ? "dir" : "file"}`}
              key={entry.path}
              onClick={() =>
                entry.isDir
                  ? onNavigate?.(entry.path)
                  : onOpen?.(entry.path)
              }
              type="button"
            >
              <span className="javis-file-icon" aria-hidden="true">
                {entry.isDir ? "[+]" : "[ ]"}
              </span>
              <span className="javis-file-name">{entry.name}</span>
              <span className="javis-file-size">
                {entry.sizeBytes != null ? formatSize(entry.sizeBytes) : "—"}
              </span>
              <span className="javis-file-modified">
                {entry.modifiedAt
                  ? formatModifiedTime(entry.modifiedAt)
                  : "—"}
              </span>
            </button>
          ))}
        </div>
      )}
    </ResourceShell>
  );
}
