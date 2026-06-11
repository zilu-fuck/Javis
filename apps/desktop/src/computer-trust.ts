import type { PermissionRequest, TrustedComputerApp } from "@javis/tools";
import { PREF_KEYS } from "./user-preferences-persistence";

export const COMPUTER_TRUSTED_APP_SOURCE_PREFIX = "local desktop window:";

const MAX_TRUSTED_APPS = 50;
const MAX_TRUSTED_APP_TITLE_LENGTH = 120;

export function loadTrustedComputerAppsFromPrefs(
  prefs: Record<string, string>,
): TrustedComputerApp[] {
  return parseTrustedComputerApps(prefs[PREF_KEYS.COMPUTER_TRUSTED_APPS] ?? null);
}

export function serializeTrustedComputerApps(apps: readonly TrustedComputerApp[]): string {
  return JSON.stringify(sanitizeTrustedComputerApps(apps));
}

export function addTrustedComputerApp(
  apps: readonly TrustedComputerApp[],
  title: string,
  trustedAt = new Date().toISOString(),
): TrustedComputerApp[] {
  const normalizedTitle = normalizeTrustedComputerAppTitle(title);
  if (!normalizedTitle) {
    return sanitizeTrustedComputerApps(apps);
  }
  return sanitizeTrustedComputerApps([
    { title: normalizedTitle, trustedAt },
    ...apps.filter((app) => app.title.trim().toLowerCase() !== normalizedTitle.toLowerCase()),
  ]);
}

export function removeTrustedComputerApp(
  apps: readonly TrustedComputerApp[],
  title: string,
): TrustedComputerApp[] {
  const normalizedTitle = normalizeTrustedComputerAppTitle(title);
  if (!normalizedTitle) {
    return sanitizeTrustedComputerApps(apps);
  }
  return sanitizeTrustedComputerApps(
    apps.filter((app) => app.title.trim().toLowerCase() !== normalizedTitle.toLowerCase()),
  );
}

export function sanitizeTrustedComputerApps(
  value: unknown,
): TrustedComputerApp[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: TrustedComputerApp[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const title = normalizeTrustedComputerAppTitle(item.title);
    if (!title) {
      continue;
    }
    const key = title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      title,
      trustedAt: normalizeTrustedAt(item.trustedAt),
    });
    if (result.length >= MAX_TRUSTED_APPS) {
      break;
    }
  }
  return result;
}

export function trustedComputerAppSource(title: string | undefined): string {
  const normalizedTitle = normalizeTrustedComputerAppTitle(title);
  return normalizedTitle
    ? `${COMPUTER_TRUSTED_APP_SOURCE_PREFIX} ${normalizedTitle}`
    : "local desktop";
}

export function extractTrustedComputerAppTitleFromPermissionRequest(
  request: Pick<PermissionRequest, "dryRun"> | undefined,
): string | undefined {
  const sources = request?.dryRun.affectedPaths.map((path) => path.source) ?? [];
  for (const source of sources) {
    const title = extractTrustedComputerAppTitleFromSource(source);
    if (title) {
      return title;
    }
  }
  return undefined;
}

function parseTrustedComputerApps(raw: string | null): TrustedComputerApp[] {
  if (!raw) {
    return [];
  }
  try {
    return sanitizeTrustedComputerApps(JSON.parse(raw));
  } catch {
    return [];
  }
}

function extractTrustedComputerAppTitleFromSource(source: string): string | undefined {
  if (!source.startsWith(COMPUTER_TRUSTED_APP_SOURCE_PREFIX)) {
    return undefined;
  }
  return normalizeTrustedComputerAppTitle(
    source.slice(COMPUTER_TRUSTED_APP_SOURCE_PREFIX.length),
  );
}

function normalizeTrustedComputerAppTitle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TRUSTED_APP_TITLE_LENGTH);
  return normalized || undefined;
}

function normalizeTrustedAt(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
