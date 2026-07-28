import type {
  CodeWorkspaceInspectionRequest,
  CodeWorkspaceInspectionResult,
  CodeWorkspaceRiskIndicator,
} from "@javis/tools";
import type { FileEntry } from "./local-knowledge";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ENTRIES = 400;
const LARGE_FILE_BYTES = 25 * 1024 * 1024;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const MANIFEST_NAMES = new Set([
  "cargo.toml",
  "deno.json",
  "deno.jsonc",
  "go.mod",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "tauri.conf.json",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
]);

const NON_MODULE_DIRECTORY_NAMES = new Set([
  ...SKIPPED_DIRECTORY_NAMES,
  ".github",
  ".vscode",
  "docs",
  "scripts",
  "test",
  "tests",
]);

interface PendingDirectory {
  path: string;
  relativePath: string;
  depth: number;
}

export interface WorkspaceInspectionDependencies {
  listDirectory(path: string): Promise<FileEntry[]>;
}

export async function inspectWorkspaceTree(
  workspacePath: string,
  request: CodeWorkspaceInspectionRequest = {},
  dependencies: WorkspaceInspectionDependencies,
): Promise<CodeWorkspaceInspectionResult> {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) {
    throw new Error("Select a workspace before inspecting its structure.");
  }

  const maxDepth = clampInteger(request.maxDepth, 1, 4, DEFAULT_MAX_DEPTH);
  const maxEntries = clampInteger(request.maxEntries, 20, 1000, DEFAULT_MAX_ENTRIES);
  const entries: CodeWorkspaceInspectionResult["entries"] = [];
  const ignoredDirectories: string[] = [];
  const queue: PendingDirectory[] = [{
    path: normalizedWorkspacePath,
    relativePath: "",
    depth: 0,
  }];
  let truncated = false;

  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift()!;
    let children: FileEntry[];
    try {
      children = await dependencies.listDirectory(current.path);
    } catch (error) {
      if (current.depth === 0) throw error;
      ignoredDirectories.push(current.relativePath);
      continue;
    }

    const sortedChildren = [...children].sort((left, right) =>
      Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name),
    );
    for (const child of sortedChildren) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      const depth = current.depth + 1;
      const relativePath = current.relativePath
        ? `${current.relativePath}/${child.name}`
        : child.name;
      const sizeBytes = normalizeOptionalSizeBytes(child.sizeBytes);
      entries.push({
        name: child.name,
        relativePath,
        isDir: child.isDir,
        depth,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(child.extension ? { extension: child.extension } : {}),
      });

      if (!child.isDir || depth >= maxDepth) continue;
      if (SKIPPED_DIRECTORY_NAMES.has(child.name.toLowerCase())) {
        ignoredDirectories.push(relativePath);
        continue;
      }
      queue.push({ path: child.path, relativePath, depth });
    }
  }

  if (queue.length > 0) truncated = true;

  const topLevelDirectories = entries
    .filter((entry) => entry.depth === 1 && entry.isDir)
    .map((entry) => entry.relativePath);
  const moduleCandidates = entries
    .filter((entry) =>
      entry.depth === 1 &&
      entry.isDir &&
      !entry.name.startsWith(".") &&
      !NON_MODULE_DIRECTORY_NAMES.has(entry.name.toLowerCase())
    )
    .map((entry) => entry.relativePath);
  const manifests = entries
    .filter((entry) => !entry.isDir && MANIFEST_NAMES.has(entry.name.toLowerCase()))
    .map((entry) => entry.relativePath);
  const riskIndicators = collectRiskIndicators(entries, manifests, truncated);

  return {
    workspacePath: normalizedWorkspacePath,
    entries,
    topLevelDirectories,
    moduleCandidates,
    manifests,
    ignoredDirectories: [...new Set(ignoredDirectories)],
    riskIndicators,
    truncated,
  };
}

function collectRiskIndicators(
  entries: CodeWorkspaceInspectionResult["entries"],
  manifests: string[],
  truncated: boolean,
): CodeWorkspaceRiskIndicator[] {
  const risks: CodeWorkspaceRiskIndicator[] = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    if (looksSensitive(entry.name)) {
      risks.push({
        code: "sensitive_name",
        severity: "warning",
        path: entry.relativePath,
        detail: "A credential- or secret-like filename is present; contents were not read.",
      });
    }
    if ((entry.sizeBytes ?? 0) > LARGE_FILE_BYTES) {
      risks.push({
        code: "large_file",
        severity: "warning",
        path: entry.relativePath,
        detail: `File exceeds ${LARGE_FILE_BYTES} bytes and may need repository or packaging review.`,
      });
    }
  }
  if (manifests.length === 0) {
    risks.push({
      code: "manifest_missing",
      severity: "info",
      detail: "No common project manifest was found within the inspected depth.",
    });
  }
  if (truncated) {
    risks.push({
      code: "inspection_truncated",
      severity: "warning",
      detail: "The workspace inventory reached its bounded entry limit; deeper structure remains uninspected.",
    });
  }
  return risks;
}

function looksSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env.example" || lower === ".env.sample" || lower === ".env.template") {
    return false;
  }
  return lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".npmrc" ||
    lower === "credentials.json" ||
    lower === "id_rsa" ||
    lower.includes("secret") ||
    lower.endsWith(".key") ||
    lower.endsWith(".pem");
}

function normalizeOptionalSizeBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}
