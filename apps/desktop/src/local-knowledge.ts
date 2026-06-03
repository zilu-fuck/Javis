import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createClassificationPrompt } from "@javis/core";
import type { ClassifiedFile } from "@javis/core";
import type { ModelProvider } from "./model-provider";

const MAX_FILES_PER_BATCH = 50;
const DEFAULT_MAX_CONCURRENT_BATCHES = 3;

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
          const prompt = createClassificationPrompt(batch.map(toClassifiable));
          const response = await provider.complete(prompt, { maxTokens: 2000, temperature: 0 });
          return parseClassificationResponse(response.text, batch);
        } catch (error) {
          console.warn(`Classification batch failed: ${error}`);
          failedBatches++;
          return batch.map(fallbackClassified);
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

function parseClassificationResponse(text: string, batch: ClassifiableInput[]): ClassifiedFile[] {
  const json = extractJsonArray(text);
  if (!Array.isArray(json)) return batch.map(fallbackClassified);

  const byName = new Map(batch.map((f) => [f.name, f]));
  const results: ClassifiedFile[] = [];
  for (const item of json) {
    if (item === null || typeof item !== "object") continue;
    const entry = typeof (item as Record<string, unknown>).name === "string"
      ? byName.get((item as Record<string, unknown>).name as string)
      : undefined;
    if (!entry) continue;
    const tags = Array.isArray((item as Record<string, unknown>).tags)
      ? ((item as Record<string, unknown>).tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    results.push({
      name: entry.name,
      path: entry.path,
      extension: entry.extension,
      sizeBytes: entry.sizeBytes,
      tags,
      category: typeof (item as Record<string, unknown>).category === "string"
        ? (item as Record<string, unknown>).category as string
        : "其他",
      confidence: typeof (item as Record<string, unknown>).confidence === "number"
        ? Math.max(0, Math.min(1, (item as Record<string, unknown>).confidence as number))
        : 0.5,
    });
  }
  return results;
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
  return {
    name: entry.name,
    path: entry.path,
    extension: entry.extension,
    sizeBytes: entry.sizeBytes,
    tags: [],
    category: "其他",
    confidence: 0,
  };
}

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
): Promise<string> {
  return invoke<string>("read_file_chunk", { path, maxLines: maxLines ?? null });
}
