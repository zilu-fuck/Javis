import { useEffect, useMemo, useState } from "react";
import type { WorkbenchFileEntry, WorkbenchLocale } from "../types";
import { formatModifiedTime, formatSize } from "../utils";
import { createCountLabel, ResourceIconButton, ResourceShell } from "./ResourceShell";

interface ComputerViewProps {
  entries: WorkbenchFileEntry[];
  currentPath: string;
  locale: WorkbenchLocale;
  loading?: boolean;
  error?: string;
  onListDirectory?: (path: string) => Promise<WorkbenchFileEntry[]>;
  onNavigate?: (path: string) => void;
  onOpen?: (path: string) => void;
}

type ComputerLayout = "columns" | "grid" | "list";
type ComputerSort = "name" | "modified" | "size" | "type";

const ROOT_DRIVES: WorkbenchFileEntry[] = [
  { name: "系统 (C:)", path: "C:\\", isDir: true },
  { name: "固态硬盘 (E:)", path: "E:\\", isDir: true },
  { name: "机械硬盘2 (F:)", path: "F:\\", isDir: true },
  { name: "机械硬盘 (G:)", path: "G:\\", isDir: true },
];

export function ComputerView({
  entries,
  currentPath,
  locale,
  loading,
  error,
  onListDirectory,
  onNavigate,
  onOpen,
}: ComputerViewProps) {
  const labels = locale.labels;
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<ComputerSort>("name");
  const [layout, setLayout] = useState<ComputerLayout>("grid");
  const [columnPaths, setColumnPaths] = useState<string[]>([]);
  const [columnEntries, setColumnEntries] = useState<Record<string, WorkbenchFileEntry[]>>({});
  const [columnLoadingPaths, setColumnLoadingPaths] = useState<Record<string, boolean>>({});

  const normalizedCurrentPath = normalizeFilePath(currentPath);
  const rootMode = normalizedCurrentPath.length === 0;
  const sourceEntries = rootMode ? ROOT_DRIVES : entries;
  const rootEntries = useMemo(
    () => sortEntries(filterEntries(ROOT_DRIVES, query), sortBy),
    [query, sortBy],
  );
  const visibleEntries = useMemo(
    () => sortEntries(filterEntries(sourceEntries, query), sortBy),
    [query, sortBy, sourceEntries],
  );

  useEffect(() => {
    const currentKey = normalizeFilePath(normalizedCurrentPath);
    setColumnPaths((current) => {
      if (rootMode) return [];
      if (current.includes(currentKey)) {
        const sliced = current.slice(0, current.indexOf(currentKey) + 1);
        return sliced[0] === "" ? sliced : ["", ...sliced];
      }
      const ancestors = buildAncestorPaths(currentKey);
      return ancestors.length > 0 ? ancestors : [currentKey];
    });
    setColumnEntries((current) => {
      if (rootMode) return {};
      return { ...current, [currentKey]: visibleEntries };
    });
  }, [normalizedCurrentPath, rootMode, visibleEntries]);

  useEffect(() => {
    if (!rootMode && columnPaths.length > 0) {
      setColumnEntries((current) => ({ ...current, [normalizedCurrentPath]: visibleEntries }));
    }
  }, [normalizedCurrentPath, columnPaths.length, rootMode, visibleEntries]);

  useEffect(() => {
    if (layout !== "columns" || rootMode || !onListDirectory) {
      return;
    }

    let cancelled = false;
    const missingPaths = columnPaths.filter(
      (path) => path && path !== normalizedCurrentPath && !columnEntries[path],
    );
    if (missingPaths.length === 0) {
      return;
    }

    setColumnLoadingPaths((current) => {
      const next = { ...current };
      for (const path of missingPaths) next[path] = true;
      return next;
    });

    void Promise.all(
      missingPaths.map(async (path) => {
        try {
          const result = await onListDirectory(path);
          if (cancelled) return;
          setColumnEntries((current) => ({ ...current, [path]: result }));
        } catch {
          if (cancelled) return;
          setColumnEntries((current) => ({ ...current, [path]: [] }));
        } finally {
          if (cancelled) return;
          setColumnLoadingPaths((current) => {
            const next = { ...current };
            delete next[path];
            return next;
          });
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [columnEntries, columnPaths, layout, normalizedCurrentPath, onListDirectory, rootMode]);

  function navigateTo(path: string) {
    onNavigate?.(normalizeFilePath(path));
  }

  function activateEntry(entry: WorkbenchFileEntry) {
    if (entry.isDir) {
      navigateTo(entry.path);
      return;
    }
    onOpen?.(entry.path);
  }

  function selectColumnEntry(columnIndex: number, entry: WorkbenchFileEntry) {
    if (!entry.isDir) {
      onOpen?.(entry.path);
      return;
    }

    const entryPath = normalizeFilePath(entry.path);
    const basePaths = columnPaths.length > 0 ? columnPaths : [""];
    const nextPaths = [...basePaths.slice(0, columnIndex + 1), entryPath];
    setColumnPaths(nextPaths);
    navigateTo(entryPath);
  }

  function handleBack() {
    if (rootMode) return;
    const parent = getParentPath(normalizedCurrentPath);
    navigateTo(parent);
  }

  function renderEntryIcon(entry: WorkbenchFileEntry, size: "large" | "small") {
    return (
      <span
        className={`javis-computer-icon ${entry.isDir ? "folder" : "file"} ${size}`}
        aria-hidden="true"
      >
        {entry.isDir ? "" : getExtensionLabel(entry)}
      </span>
    );
  }

  const actions = (
    <>
      <label className="javis-resource-search javis-computer-search">
        <span className="javis-computer-search-icon" aria-hidden="true" />
        <input
          aria-label={labels.searchPlaceholder}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={labels.searchPlaceholder}
          value={query}
        />
      </label>
      <ResourceIconButton label="排序" onClick={() => setSortBy(nextSort(sortBy))}>
        <span className="javis-computer-sort-icon" aria-hidden="true" />
      </ResourceIconButton>
      <div className="javis-resource-segment javis-computer-view-toggle" aria-label="视图">
        <button
          aria-label="宫格视图"
          className={layout === "grid" ? "active" : ""}
          onClick={() => setLayout("grid")}
          type="button"
        >
          <span className="view-grid" aria-hidden="true" />
        </button>
        <button
          aria-label="列表视图"
          className={layout === "list" ? "active" : ""}
          onClick={() => setLayout("list")}
          type="button"
        >
          <span className="view-list" aria-hidden="true" />
        </button>
        <button
          aria-label="分栏视图"
          className={layout === "columns" ? "active" : ""}
          onClick={() => setLayout("columns")}
          type="button"
        >
          <span className="view-columns" aria-hidden="true" />
        </button>
      </div>
    </>
  );

  const countLabel = rootMode
    ? labels.thisComputer
    : createCountLabel(currentPathName(normalizedCurrentPath) || labels.thisComputer, visibleEntries.length);

  if (loading) {
    return (
      <ResourceShell
        actions={actions}
        countLabel={countLabel}
        icon=""
        onBack={rootMode ? undefined : handleBack}
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
        countLabel={countLabel}
        icon=""
        onBack={rootMode ? undefined : handleBack}
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
      countLabel={countLabel}
      icon=""
      onBack={rootMode ? undefined : handleBack}
      title={rootMode ? labels.thisComputer : currentPathName(normalizedCurrentPath)}
    >
      <nav className="javis-breadcrumb" aria-label={labels.fileExplorerBreadcrumb}>
        <button
          className="javis-breadcrumb-item"
          onClick={() => navigateTo("")}
          type="button"
        >
          {labels.thisComputer}
        </button>
        {!rootMode
          ? breadcrumbItems(normalizedCurrentPath).map((item) => (
              <span key={item.path}>
                <span className="javis-breadcrumb-sep">/</span>
                <button
                  className="javis-breadcrumb-item"
                  onClick={() => navigateTo(item.path)}
                  type="button"
                >
                  {item.label}
                </button>
              </span>
            ))
          : null}
      </nav>
      {visibleEntries.length === 0 ? (
        <div className="javis-view-empty">
          <p>{labels.fileExplorerEmpty}</p>
        </div>
      ) : layout === "grid" ? (
        <div className="javis-computer-grid">
          {visibleEntries.map((entry) => (
            <button
              className="javis-computer-tile"
              key={entry.path}
              onClick={() => activateEntry(entry)}
              type="button"
            >
              {renderEntryIcon(entry, "large")}
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      ) : layout === "list" ? (
        <div className="javis-computer-list">
          {visibleEntries.map((entry) => (
            <button
              className={`javis-computer-row ${entry.isDir ? "dir" : "file"}`}
              key={entry.path}
              onClick={() => activateEntry(entry)}
              type="button"
            >
              {renderEntryIcon(entry, "small")}
              <span className="javis-computer-name">{entry.name}</span>
              <span className="javis-computer-kind">{entry.isDir ? getDriveLabel(entry) : getExtensionLabel(entry)}</span>
              <span className="javis-computer-date">
                {entry.modifiedAt ? formatModifiedTime(entry.modifiedAt) : "--"}
              </span>
              <span className="javis-computer-size">
                {entry.sizeBytes != null ? formatSize(entry.sizeBytes) : "--"}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="javis-computer-columns">
          {(rootMode ? [""] : columnPaths).map((path, columnIndex) => {
            const entriesForColumn = path === ""
              ? rootEntries
              : sortEntries(filterEntries(columnEntries[path] ?? [], query), sortBy);
            return (
              <div className="javis-computer-column" key={path || "root"}>
                {entriesForColumn.map((entry) => (
                  <button
                    className={`javis-computer-column-row ${
                      columnPaths[columnIndex + 1] === normalizeFilePath(entry.path) ? "active" : ""
                    }`}
                    key={entry.path}
                    onClick={() => selectColumnEntry(columnIndex, entry)}
                    type="button"
                  >
                    {renderEntryIcon(entry, "small")}
                    <span>{entry.name}</span>
                    {entry.isDir ? <span className="javis-computer-chevron">›</span> : null}
                  </button>
                ))}
                {columnLoadingPaths[path] ? (
                  <div className="javis-computer-column-loading">{labels.scanInProgress}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </ResourceShell>
  );
}

function filterEntries(entries: WorkbenchFileEntry[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.path, entry.extension ?? ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

function sortEntries(entries: WorkbenchFileEntry[], sortBy: ComputerSort) {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    if (sortBy === "modified") {
      return getTime(right.modifiedAt) - getTime(left.modifiedAt);
    }
    if (sortBy === "size") {
      return (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1);
    }
    if (sortBy === "type") {
      const extCompare = (left.extension ?? "").localeCompare(right.extension ?? "");
      if (extCompare !== 0) return extCompare;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function nextSort(current: ComputerSort): ComputerSort {
  const order: ComputerSort[] = ["name", "modified", "size", "type"];
  return order[(order.indexOf(current) + 1) % order.length];
}

function getTime(value: string | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeFilePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";

  const slashNormalized = stripWindowsNamespacePrefix(trimmed.replace(/\//g, "\\"));
  if (slashNormalized.startsWith("\\\\")) {
    return "\\\\" + slashNormalized.slice(2).replace(/\\+$/g, "");
  }

  const driveRoot = slashNormalized.match(/^([A-Za-z]:)\\*$/);
  if (driveRoot) {
    return `${driveRoot[1].toUpperCase()}\\`;
  }

  const drivePath = slashNormalized.match(/^([A-Za-z]:)\\(.+)$/);
  if (drivePath) {
    return `${drivePath[1].toUpperCase()}\\${drivePath[2].replace(/\\+$/g, "")}`;
  }

  return slashNormalized.replace(/\\+$/g, "");
}

function stripWindowsNamespacePrefix(path: string) {
  return path
    .replace(/^\\+\?\\UNC\\/i, "\\\\")
    .replace(/^\\+\?\\/i, "");
}

function pathParts(path: string) {
  const normalized = normalizeFilePath(path);
  if (!normalized) return [];

  if (normalized.startsWith("\\\\")) {
    return normalized.slice(2).split("\\").filter(Boolean);
  }

  return normalized.split("\\").filter(Boolean);
}

function buildBreadcrumbPath(parts: string[], index: number) {
  if (parts[0]?.includes(":") && index === 0) {
    return `${parts[0]}\\`;
  }
  if (parts[0]?.includes(":")) {
    return normalizeFilePath(`${parts[0]}\\${parts.slice(1, index + 1).join("\\")}`);
  }
  if (!parts[0]?.includes(":") && parts.length >= 2) {
    return `\\\\${parts.slice(0, index + 1).join("\\")}`;
  }
  return normalizeFilePath(parts.slice(0, index + 1).join("\\"));
}

function buildAncestorPaths(path: string) {
  const items = breadcrumbItems(path);
  return items.length > 0 ? ["", ...items.map((item) => item.path)] : [];
}

function currentPathName(path: string) {
  const normalized = normalizeFilePath(path);
  if (!normalized) return "";
  const parts = pathParts(normalized);
  return parts[parts.length - 1] ?? normalized;
}

function getParentPath(path: string) {
  const normalized = normalizeFilePath(path);
  const parts = pathParts(normalized);
  if (parts.length <= 1) return "";
  if (parts[0]?.includes(":") && parts.length === 2) {
    return `${parts[0]}\\`;
  }
  if (parts[0]?.includes(":")) {
    return normalizeFilePath(`${parts[0]}\\${parts.slice(1, -1).join("\\")}`);
  }
  if (parts.length <= 2) {
    return "";
  }
  return `\\\\${parts.slice(0, -1).join("\\")}`;
}

function breadcrumbItems(path: string) {
  const normalized = normalizeFilePath(path);
  const parts = pathParts(normalized);
  if (parts.length === 0) return [];

  if (normalized.startsWith("\\\\")) {
    if (parts.length < 2) {
      return [{ label: normalized, path: normalized }];
    }

    const items = [
      {
        label: `\\\\${parts[0]}\\${parts[1]}`,
        path: `\\\\${parts[0]}\\${parts[1]}`,
      },
    ];
    for (let index = 2; index < parts.length; index += 1) {
      items.push({
        label: parts[index],
        path: `\\\\${parts.slice(0, index + 1).join("\\")}`,
      });
    }
    return items;
  }

  return parts.map((part, index) => ({
    label: part,
    path: buildBreadcrumbPath(parts, index),
  }));
}

function getExtensionLabel(entry: WorkbenchFileEntry) {
  if (entry.isDir) return "文件夹";
  return (entry.extension || entry.name.split(".").pop() || "文件").toUpperCase();
}

function getDriveLabel(entry: WorkbenchFileEntry) {
  const match = entry.path.match(/^([A-Z]:)/i);
  return match?.[1] ?? "文件夹";
}
