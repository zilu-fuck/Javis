export const RECENT_WORKSPACES_STORAGE_KEY = "javis.recentWorkspaces.v1";
export const RECENT_WORKSPACES_LIMIT = 8;
export const RECENT_WORKSPACES_STORAGE_VERSION = 1;

type RecentWorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

export function loadRecentWorkspacePaths(storage: RecentWorkspaceStorage): string[] {
  try {
    const raw = storage.getItem(RECENT_WORKSPACES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const paths = parseRecentWorkspaceEntries(JSON.parse(raw));
    if (!paths) {
      return [];
    }

    return sanitizeWorkspacePaths(paths).slice(0, RECENT_WORKSPACES_LIMIT);
  } catch {
    return [];
  }
}

export function saveRecentWorkspacePaths(
  storage: RecentWorkspaceStorage,
  paths: string[],
): string[] {
  const nextPaths = sanitizeWorkspacePaths(paths).slice(0, RECENT_WORKSPACES_LIMIT);
  try {
    storage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(nextPaths));
  } catch {
    // Workspace history should never block task execution.
  }
  return nextPaths;
}

export function upsertRecentWorkspacePath(paths: string[], path: string): string[] {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return paths;
  }
  const normalizedKey = normalizedPath.toLocaleLowerCase();
  return [
    normalizedPath,
    ...paths.filter((entry) => entry.toLocaleLowerCase() !== normalizedKey),
  ].slice(0, RECENT_WORKSPACES_LIMIT);
}

export function removeRecentWorkspacePath(paths: string[], path: string): string[] {
  const normalizedKey = path.trim().toLocaleLowerCase();
  if (!normalizedKey) {
    return paths;
  }
  return paths.filter((entry) => entry.toLocaleLowerCase() !== normalizedKey);
}

function sanitizeWorkspacePaths(value: unknown[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const path = entry.trim();
    if (!path) {
      continue;
    }
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    paths.push(path);
  }

  return paths;
}

function parseRecentWorkspaceEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    isRecord(value) &&
    value.version === RECENT_WORKSPACES_STORAGE_VERSION &&
    Array.isArray(value.paths)
  ) {
    return value.paths;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
