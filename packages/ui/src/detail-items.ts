import type { WorkbenchAppEntry, WorkbenchDetailItem, WorkbenchFileEntry, WorkbenchLocale } from "./types";
import { formatModifiedTime, formatSize, isChineseLocale } from "./utils";

interface FileDetailOptions {
  categoryLabels?: Record<string, string>;
  kindLabel?: string;
  line?: number;
  locale?: WorkbenchLocale;
  preview?: string;
}

export function createFileDetailItem(
  entry: WorkbenchFileEntry,
  options: FileDetailOptions = {},
): WorkbenchDetailItem {
  const labels = getDetailLabels(options.locale);
  const metadata: WorkbenchDetailItem["metadata"] = [
    { label: labels.path, value: entry.path },
  ];

  if (entry.extension) metadata.push({ label: labels.extension, value: entry.extension });
  if (entry.sizeBytes != null) metadata.push({ label: labels.size, value: formatSize(entry.sizeBytes) });
  if (entry.modifiedAt) metadata.push({ label: labels.modified, value: formatModifiedTime(entry.modifiedAt) });
  if (entry.category) {
    metadata.push({
      label: labels.category,
      value: options.categoryLabels?.[entry.category] ?? entry.category,
    });
  }
  if (entry.tags?.length) metadata.push({ label: labels.tags, value: entry.tags.join(", ") });
  if (entry.sourceRootPath) metadata.push({ label: labels.sourceRoot, value: entry.sourceRootPath });
  if (typeof entry.confidence === "number") {
    metadata.push({ label: labels.confidence, value: formatConfidence(entry.confidence) });
  }
  if (options.line != null) metadata.push({ label: labels.line, value: String(options.line) });

  return {
    title: entry.name || getPathName(entry.path),
    description: options.preview ?? entry.path,
    kind: options.kindLabel ?? getFileKind(entry, options.locale),
    metadata,
  };
}

export function createPathDetailItem(
  path: string,
  options: Pick<FileDetailOptions, "kindLabel" | "line" | "locale" | "preview"> = {},
): WorkbenchDetailItem {
  const labels = getDetailLabels(options.locale);
  const metadata: WorkbenchDetailItem["metadata"] = [
    { label: labels.path, value: path },
  ];
  if (options.line != null) metadata.push({ label: labels.line, value: String(options.line) });

  return {
    title: getPathName(path),
    description: options.preview ?? path,
    kind: options.kindLabel ?? (options.locale && isChineseLocale(options.locale) ? "文件" : "File"),
    metadata,
  };
}

export function createAppDetailItem(
  app: WorkbenchAppEntry,
  categoryLabels: Record<string, string> = {},
  locale?: WorkbenchLocale,
): WorkbenchDetailItem {
  const labels = getDetailLabels(locale);
  const metadata: WorkbenchDetailItem["metadata"] = [
    { label: labels.path, value: app.path },
  ];

  if (app.publisher) metadata.push({ label: labels.publisher, value: app.publisher });
  if (app.installLocation) metadata.push({ label: labels.installLocation, value: app.installLocation });
  if (app.category) {
    metadata.push({ label: labels.category, value: categoryLabels[app.category] ?? app.category });
  }
  if (app.tags?.length) metadata.push({ label: labels.tags, value: app.tags.join(", ") });
  if (typeof app.confidence === "number") {
    metadata.push({ label: labels.confidence, value: formatConfidence(app.confidence) });
  }

  return {
    title: app.name,
    description: app.path,
    kind: locale && isChineseLocale(locale) ? "应用" : "Application",
    metadata,
  };
}

function getFileKind(entry: WorkbenchFileEntry, locale: WorkbenchLocale | undefined): string {
  const isChinese = Boolean(locale && isChineseLocale(locale));
  if (entry.isDir) return isChinese ? "文件夹" : "Folder";
  const extension = entry.extension || entry.name.split(".").pop();
  if (extension) {
    return isChinese ? `${extension.toUpperCase()} 文件` : `${extension.toUpperCase()} file`;
  }
  return isChinese ? "文件" : "File";
}

function getPathName(path: string): string {
  const normalized = path.replace(/[\\/]+$/g, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatConfidence(value: number): string {
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

function getDetailLabels(locale: WorkbenchLocale | undefined) {
  if (locale && isChineseLocale(locale)) {
    return {
      category: "分类",
      confidence: "置信度",
      extension: "扩展名",
      installLocation: "安装位置",
      line: "行号",
      modified: "修改时间",
      path: "路径",
      publisher: "发布者",
      size: "大小",
      sourceRoot: "扫描根目录",
      tags: "标签",
    };
  }

  return {
    category: "Category",
    confidence: "Confidence",
    extension: "Extension",
    installLocation: "Install location",
    line: "Line",
    modified: "Modified",
    path: "Path",
    publisher: "Publisher",
    size: "Size",
    sourceRoot: "Source root",
    tags: "Tags",
  };
}
