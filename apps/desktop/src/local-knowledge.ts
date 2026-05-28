import { invoke } from "@tauri-apps/api/core";
import { createClassificationPrompt } from "@javis/core";
import type { ClassifiedFile } from "@javis/core";
import type { ModelProvider } from "./model-provider";

const MAX_FILES_PER_BATCH = 50;

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

export async function scanInstalledApps(): Promise<AppEntry[]> {
  return invoke<AppEntry[]>("scan_installed_apps");
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
): Promise<ClassifiedFile[]> {
  const results: ClassifiedFile[] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_BATCH) {
    const batch = files.slice(i, i + MAX_FILES_PER_BATCH);
    const prompt = createClassificationPrompt(batch.map(toClassifiable));
    const response = await provider.complete(prompt, { maxTokens: 2000, temperature: 0 });
    const classified = parseClassificationResponse(response.text, batch);
    results.push(...classified);
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

export async function readFileChunk(
  path: string,
  maxLines?: number,
): Promise<string> {
  return invoke<string>("read_file_chunk", { path, maxLines: maxLines ?? null });
}
