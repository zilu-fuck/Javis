import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createClassificationPrompt } from "@javis/core";
import type { ClassifiedFile } from "@javis/core";
import type { ModelProvider } from "./model-provider";

const MAX_FILES_PER_BATCH = 50;
const DEFAULT_MAX_CONCURRENT_BATCHES = 3;
const OTHER_CATEGORY = "其他";

/** Progress payload emitted by the Rust scan-all-files walker. */
export interface ScanProgressPayload {
  scanId: string;
  current: number;
  total: number;
}

/** Payload emitted when scan_all_user_files completes. */
export interface ScanDonePayload {
  scanId: string;
  entries: FileEntry[];
}

/** Payload emitted when scan_all_user_files fails. */
export interface ScanErrorPayload {
  scanId: string;
  error: string;
}

export interface MountRoot {
  name: string;
  path: string;
}

/** Options for classifyDocuments enhanced mode. */
export interface ClassifyDocumentsOptions {
  onBatchProgress?: (completed: number, total: number, failed: number) => void;
  signal?: AbortSignal;
  maxConcurrentBatches?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
}

export interface AppEntry {
  name: string;
  path: string;
  iconPath?: string;
  publisher?: string;
  installLocation?: string;
}

export interface ClassifiableApp {
  name: string;
  path: string;
  publisher?: string;
  installLocation?: string;
}

export async function scanInstalledApps(
  onProgress?: (progress: ScanProgressPayload) => void,
): Promise<AppEntry[]> {
  const scanId = createScanId("apps");
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<ScanProgressPayload>(
      "scan-installed-apps-progress",
      (event) => {
        if (event.payload.scanId === scanId) {
          onProgress(event.payload);
        }
      },
    );
  }
  try {
    return await invoke<AppEntry[]>("scan_installed_apps", { scanId });
  } finally {
    unlisten?.();
  }
}

export async function scanUserDocuments(
  extensions?: string[],
  maxResults?: number,
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("scan_user_documents", {
    extensions: extensions ?? null,
    maxResults: maxResults ?? null,
  });
}

export async function scanUserImages(
  maxResults?: number,
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("scan_user_images", {
    maxResults: maxResults ?? null,
  });
}

function createScanId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listDirectory(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { path });
}

interface ClassifiableInput {
  name: string;
  path: string;
  extension?: string;
  sizeBytes?: number;
}

function toClassifiable(entry: ClassifiableInput) {
  return {
    name: entry.name,
    path: entry.path,
    extension: entry.extension,
    sizeBytes: entry.sizeBytes,
  };
}

export async function classifyDocuments(
  files: ClassifiableInput[],
  provider: ModelProvider,
  options?: ClassifyDocumentsOptions,
): Promise<ClassifiedFile[]> {
  return classifyEntries(files, provider, createDocumentPrompt, fallbackClassified, options);
}

export async function classifyApps(
  apps: ClassifiableApp[],
  provider: ModelProvider,
  options?: ClassifyDocumentsOptions,
): Promise<ClassifiedFile[]> {
  return classifyEntries(
    apps.map((app) => ({
      name: app.name,
      path: app.path,
      extension: app.publisher || app.installLocation ? [app.publisher, app.installLocation].filter(Boolean).join(" | ") : "app",
    })),
    provider,
    createAppClassificationPrompt,
    fallbackClassifiedApp,
    options,
  );
}

async function classifyEntries(
  files: ClassifiableInput[],
  provider: ModelProvider,
  createPrompt: (files: ClassifiableInput[]) => string,
  fallback: (entry: ClassifiableInput) => ClassifiedFile,
  options?: ClassifyDocumentsOptions,
): Promise<ClassifiedFile[]> {
  const results: ClassifiedFile[] = [];
  const batches: ClassifiableInput[][] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_BATCH) {
    batches.push(files.slice(i, i + MAX_FILES_PER_BATCH));
  }

  const totalBatches = batches.length;
  let completedBatches = 0;
  let failedBatches = 0;
  const maxConcurrent = options?.maxConcurrentBatches ?? DEFAULT_MAX_CONCURRENT_BATCHES;

  // Process batches with concurrency limit
  for (let i = 0; i < totalBatches; i += maxConcurrent) {
    if (options?.signal?.aborted) break;

    const chunk = batches.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      chunk.map(async (batch) => {
        try {
          const prompt = createPrompt(batch);
          const response = await provider.complete(prompt, { maxTokens: 2000, temperature: 0 });
          return parseClassificationResponse(response.text, batch, fallback);
        } catch (error) {
          console.warn(`Classification batch failed: ${error}`);
          failedBatches++;
          return batch.map(fallback);
        }
      }),
    );

    for (const classified of batchResults) {
      results.push(...classified);
      completedBatches++;
      options?.onBatchProgress?.(completedBatches, totalBatches, failedBatches);
    }
  }

  return results;
}

function createDocumentPrompt(files: ClassifiableInput[]): string {
  return createClassificationPrompt(files.map(toClassifiable));
}

function normalizeClassificationPath(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

function parseClassificationResponse(
  text: string,
  batch: ClassifiableInput[],
  fallback: (entry: ClassifiableInput) => ClassifiedFile,
): ClassifiedFile[] {
  const json = extractJsonArray(text);
  if (!Array.isArray(json)) return batch.map(fallback);

  const byPath = new Map(batch.map((f) => [normalizeClassificationPath(f.path), f]));
  const byName = new Map<string, ClassifiableInput[]>();
  for (const entry of batch) {
    const entries = byName.get(entry.name) ?? [];
    entries.push(entry);
    byName.set(entry.name, entries);
  }
  const results: ClassifiedFile[] = [];
  const seenPaths = new Set<string>();
  for (const item of json) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const itemPath = typeof record.path === "string"
      ? normalizeClassificationPath(record.path)
      : "";
    const itemName = typeof record.name === "string" ? record.name : "";
    const nameMatches = itemName ? byName.get(itemName) : undefined;
    const entry = itemPath
      ? byPath.get(itemPath)
      : nameMatches?.length === 1
        ? nameMatches[0]
        : undefined;
    if (!entry) continue;
    const normalizedEntryPath = normalizeClassificationPath(entry.path);
    if (seenPaths.has(normalizedEntryPath)) continue;
    seenPaths.add(normalizedEntryPath);
    const tags = Array.isArray(record.tags)
      ? (record.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const parsedCategory = typeof record.category === "string"
      ? record.category as string
      : OTHER_CATEGORY;
    const localFallback = fallback(entry);
    const category = parsedCategory === OTHER_CATEGORY && localFallback.category !== OTHER_CATEGORY
      ? localFallback.category
      : parsedCategory;
    const fallbackTags = localFallback.category !== OTHER_CATEGORY ? localFallback.tags : [];
    results.push({
      name: entry.name,
      path: entry.path,
      extension: entry.extension,
      sizeBytes: entry.sizeBytes,
      tags: tags.length > 0 ? tags : fallbackTags,
      category,
      confidence: typeof record.confidence === "number"
        ? Math.max(0, Math.min(1, record.confidence as number))
        : localFallback.confidence || 0.5,
    });
  }
  return [
    ...results,
    ...batch
      .filter((entry) => !seenPaths.has(normalizeClassificationPath(entry.path)))
      .map(fallback),
  ];
}

function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
}

function fallbackClassified(entry: ClassifiableInput): ClassifiedFile {
  const match = matchDocumentCategory(entry);
  return {
    name: entry.name,
    path: entry.path,
    extension: entry.extension,
    sizeBytes: entry.sizeBytes,
    tags: match?.tags ?? [],
    category: match?.category ?? OTHER_CATEGORY,
    confidence: match ? 0.62 : 0,
  };
}

const DOCUMENT_CATEGORY_RULES: Array<{
  category: string;
  tags: string[];
  keywords: string[];
  extensions?: string[];
}> = [
  {
    category: "财务",
    tags: ["财务"],
    keywords: ["发票", " invoice", "receipt", "收据", "报销", "预算", "budget", "账单", "bill", "流水", "工资", "薪资", "tax", "税", "财务"],
    extensions: ["xls", "xlsx", "csv"],
  },
  {
    category: "合同",
    tags: ["合同"],
    keywords: ["合同", "协议", "agreement", "contract", "授权", "委托", "签署"],
  },
  {
    category: "研究",
    tags: ["研究"],
    keywords: ["论文", "paper", "research", "arxiv", "实验", "调研", "研究", "报告", "report", "白皮书", "竞赛", "评审", "指南"],
  },
  {
    category: "行政",
    tags: ["行政"],
    keywords: ["流程", "通知", "公告", "公示", "确认", "申请", "审批", "操作", "指南", "说明", "毕业", "档案", "证明", "行政"],
  },
  {
    category: "技术文档",
    tags: ["技术"],
    keywords: ["config", "readme", "release", "api", "sdk", "开发", "技术", "架构", "接口", "配置", "日志", "manual", "adminregionconfig"],
    extensions: ["txt", "md", "json", "yaml", "yml", "toml", "ini", "log"],
  },
  {
    category: "个人",
    tags: ["个人"],
    keywords: ["简历", "resume", "cv", "个人", "身份证", "护照", "照片", "证件"],
  },
  {
    category: "图片",
    tags: ["图片"],
    keywords: ["image", "photo", "screenshot", "截图", "照片"],
    extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
  },
];

function matchDocumentCategory(entry: ClassifiableInput): { category: string; tags: string[] } | undefined {
  const extension = normalizeExtension(entry.extension || getExtensionFromName(entry.name));
  const text = ` ${entry.name} ${entry.path} `.toLowerCase();
  return DOCUMENT_CATEGORY_RULES.find((rule) =>
    rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))
    || Boolean(extension && rule.extensions?.includes(extension))
  );
}

function getExtensionFromName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
}

function normalizeExtension(extension: string): string {
  return extension.trim().replace(/^\./, "").toLowerCase();
}

const APP_CATEGORIES = [
  "开发工具",
  "浏览器",
  "办公学习",
  "设计创作",
  "影音娱乐",
  "游戏",
  "通信社交",
  "系统工具",
  "安全隐私",
  OTHER_CATEGORY,
] as const;

function createAppClassificationPrompt(apps: ClassifiableInput[]): string {
  const appList = apps
    .map((app) => `- ${app.name}  (${app.path})  [${app.extension ?? "app"}]`)
    .join("\n");

  return [
    "You are an installed application classifier. Given a list of desktop apps, classify each app by its common purpose.",
    "",
    `Allowed categories: ${APP_CATEGORIES.join(", ")}`,
    "",
    "Use application name, executable path, publisher, and install location hints.",
    "Prefer a specific category over 其他 when the app name gives a clear signal.",
    "For each app return:",
    "- path: echo the exact input path",
    "- category: one of the allowed categories",
    "- tags: 1-3 short Chinese tags",
    "- confidence: 0.0-1.0",
    "",
    "Return ONLY a JSON array, no markdown or explanation.",
    "Schema: [{\"name\":\"...\",\"path\":\"...\",\"category\":\"开发工具\",\"tags\":[\"IDE\"],\"confidence\":0.9}]",
    "",
    "Apps:",
    appList,
  ].join("\n");
}

function fallbackClassifiedApp(entry: ClassifiableInput): ClassifiedFile {
  const text = `${entry.name} ${entry.path} ${entry.extension ?? ""}`.toLowerCase();
  const match = APP_CATEGORY_RULES.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
  const category = match?.category ?? OTHER_CATEGORY;
  return {
    name: entry.name,
    path: entry.path,
    extension: "app",
    tags: match?.tags ?? [],
    category,
    confidence: match ? 0.65 : 0.25,
  };
}

const APP_CATEGORY_RULES: Array<{
  category: (typeof APP_CATEGORIES)[number];
  tags: string[];
  keywords: string[];
}> = [
  {
    category: "浏览器",
    tags: ["浏览器"],
    keywords: ["chrome", "edge", "firefox", "browser", "uc浏览器", "brave", "opera", "vivaldi", "arc"],
  },
  {
    category: "开发工具",
    tags: ["开发"],
    keywords: ["visual studio", "vscode", "vs code", "cursor", "trae", "node.js", "python", "git", "github", "jetbrains", "intellij", "webstorm", "pycharm", "goland", "rust", "nvm", "docker", "postman", "redis desktop", "mongodb", "testmem"],
  },
  {
    category: "通信社交",
    tags: ["通信"],
    keywords: ["wechat", "微信", "qq", "telegram", "discord", "teams", "teamviewer", "teamspeak", "slack", "zoom", "dingtalk", "钉钉", "飞书", "lark"],
  },
  {
    category: "游戏",
    tags: ["游戏"],
    keywords: ["steam", "epic games", "ubisoft", "riot", "battle.net", "minecraft", "game", "tokeny"],
  },
  {
    category: "影音娱乐",
    tags: ["影音"],
    keywords: ["music", "video", "player", "vlc", "spotify", "netease", "bilibili", "youtube", "potplayer", "obs"],
  },
  {
    category: "设计创作",
    tags: ["创作"],
    keywords: ["photoshop", "illustrator", "figma", "sketch", "blender", "canva", "adobe", "clip studio", "krita"],
  },
  {
    category: "办公学习",
    tags: ["办公"],
    keywords: ["office", "word", "excel", "powerpoint", "wps", "notion", "onenote", "obsidian", "pdf", "acrobat", "typora", "zotero"],
  },
  {
    category: "安全隐私",
    tags: ["安全"],
    keywords: ["encrypt", "encrypto", "vpn", "security", "antivirus", "1password", "bitwarden", "keypass", "keepass"],
  },
  {
    category: "系统工具",
    tags: ["系统"],
    keywords: ["uninstall", "tools for desktop apps", "tools for windows store apps", "driver", "control panel", "powershell", "terminal", "7-zip", "winrar"],
  },
];

/**
 * Scan all user files via the Rust walker. The scan runs in a background
 * thread; this function resolves with the full file list when the scan
 * completes, or rejects on error. Progress events are forwarded to the
 * optional onProgress callback.
 */
export async function scanAllUserFiles(
  extensions?: string[],
  maxResults?: number,
  onProgress?: (progress: ScanProgressPayload) => void,
): Promise<FileEntry[]> {
  const scanId = createScanId("files");

  return new Promise<FileEntry[]>((resolve, reject) => {
    const unlistenFns: (() => void)[] = [];

    const cleanup = () => {
      for (const fn of unlistenFns) fn();
    };

    void (async () => {
      try {
        // Listen for progress events (filtered by scan_id in callback)
        if (onProgress) {
          const unlisten = await listen<ScanProgressPayload>(
            "scan-all-files-progress",
            (event) => {
              if (event.payload.scanId === scanId) {
                onProgress(event.payload);
              }
            },
          );
          unlistenFns.push(unlisten);
        }

        // Listen for completion
        const unlistenDone = await listen<ScanDonePayload>(
          "scan-all-files-done",
          (event) => {
            if (event.payload.scanId === scanId) {
              cleanup();
              resolve(event.payload.entries);
            }
          },
        );
        unlistenFns.push(unlistenDone);

        // Listen for errors
        const unlistenError = await listen<ScanErrorPayload>(
          "scan-all-files-error",
          (event) => {
            if (event.payload.scanId === scanId) {
              cleanup();
              reject(new Error(event.payload.error));
            }
          },
        );
        unlistenFns.push(unlistenError);

        await invoke<string>("scan_all_user_files", {
          extensions: extensions ?? null,
          maxResults: maxResults ?? null,
          scanId,
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}

/**
 * Cancel an in-progress scan-all-files operation by its scan ID.
 */
export async function cancelScanAllFiles(scanId: string): Promise<void> {
  await invoke("cancel_scan_all_files", { scanId });
}

/**
 * List available mount roots (drive letters on Windows, ["/"] on Unix).
 */
export async function listMountRoots(): Promise<MountRoot[]> {
  return invoke<MountRoot[]>("list_mount_roots");
}

export async function readFileChunk(
  path: string,
  maxLines?: number,
  scope?: { workspaceRoot?: string; allowedRootIds?: string[] },
): Promise<string> {
  return invoke<string>("read_file_chunk", {
    path,
    maxLines: maxLines ?? null,
    workspaceRoot: scope?.workspaceRoot ?? null,
    allowedRootIds: scope?.allowedRootIds ?? null,
  });
}

// ── Resource scan types ──────────────────────────────────────────────────────

export interface ResourceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  extension?: string;
  source: string;
  sourceRootId: string;
  sourceRootPath: string;
}

export interface ScanResourceRootInput {
  id: string;
  path: string;
  source: string;
}

export interface ScanResourceDonePayload {
  scanId: string;
  kind: string;
  entries: ResourceFileEntry[];
}

export interface ScanResourceErrorPayload {
  scanId: string;
  error: string;
}

// ── User home ────────────────────────────────────────────────────────────────

export async function getUserHome(): Promise<string> {
  return invoke<string>("get_user_home");
}

// ── Resource file scan ───────────────────────────────────────────────────────

export async function scanResourceFiles(
  kind: string,
  roots: ScanResourceRootInput[],
  extensions: string[],
  maxResultsPerRoot?: number,
  onProgress?: (progress: ScanProgressPayload & { currentRootId: string }) => void,
): Promise<ResourceFileEntry[]> {
  const scanId = createScanId(`resource-${kind}`);

  return new Promise<ResourceFileEntry[]>((resolve, reject) => {
    const unlistenFns: (() => void)[] = [];

    const cleanup = () => {
      for (const fn of unlistenFns) fn();
    };

    void (async () => {
      try {
        if (onProgress) {
          const unlisten = await listen<ScanProgressPayload & { currentRootId: string }>(
            "scan-resource-files-progress",
            (event) => {
              if (event.payload.scanId === scanId) {
                onProgress(event.payload);
              }
            },
          );
          unlistenFns.push(unlisten);
        }

        const unlistenDone = await listen<ScanResourceDonePayload>(
          "scan-resource-files-done",
          (event) => {
            if (event.payload.scanId === scanId) {
              cleanup();
              resolve(event.payload.entries);
            }
          },
        );
        unlistenFns.push(unlistenDone);

        const unlistenError = await listen<ScanResourceErrorPayload>(
          "scan-resource-files-error",
          (event) => {
            if (event.payload.scanId === scanId) {
              cleanup();
              reject(new Error(event.payload.error));
            }
          },
        );
        unlistenFns.push(unlistenError);

        await invoke<string>("scan_resource_files", {
          request: {
            kind,
            roots,
            extensions,
            maxResultsPerRoot: maxResultsPerRoot ?? null,
            scanId,
          },
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}
