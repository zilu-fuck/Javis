import { invoke } from "@tauri-apps/api/core";

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
