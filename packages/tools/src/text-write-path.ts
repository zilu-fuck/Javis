const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//u;

/**
 * Converts an absolute text-write target inside the selected workspace to the
 * relative form required by the native write command. Absolute paths outside
 * the workspace are rejected before they reach the approval boundary.
 */
export function normalizeWorkspaceRelativeTextTargetPath(
  targetPath: string,
  workspacePath?: string,
): string {
  const normalizedTarget = normalizePath(targetPath);
  if (!normalizedTarget) {
    throw new Error("Text write target path cannot be empty.");
  }
  if (hasParentTraversal(normalizedTarget)) {
    throw new Error("Text write target path cannot contain parent directory traversal.");
  }
  if (!isAbsolutePath(normalizedTarget)) {
    return normalizedTarget;
  }

  const normalizedWorkspace = normalizePath(workspacePath ?? "");
  if (!normalizedWorkspace || !isAbsolutePath(normalizedWorkspace)) {
    throw new Error("Absolute text write targets require a selected workspace.");
  }

  const caseInsensitive = isWindowsPath(normalizedTarget) || isWindowsPath(normalizedWorkspace);
  const targetKey = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  const workspaceKey = caseInsensitive ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  if (targetKey === workspaceKey) {
    throw new Error("Text write target must name a file inside the selected workspace.");
  }
  if (!targetKey.startsWith(`${workspaceKey}/`)) {
    throw new Error("Text write target path must stay inside the selected workspace.");
  }
  const relativePath = normalizedTarget.slice(normalizedWorkspace.length + 1);
  if (!relativePath || isAbsolutePath(relativePath) || hasParentTraversal(relativePath)) {
    throw new Error("Text write target path must be workspace-relative.");
  }
  return relativePath;
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/\/\?\//u, "")
    .replace(/\/+$/u, "");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || WINDOWS_DRIVE_PATH.test(value);
}

function isWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE_PATH.test(value) || value.startsWith("//");
}

function hasParentTraversal(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}
