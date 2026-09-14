import type { ToolDescriptor, ToolJsonSchema } from "./types";

const DISABLED_BROWSER_WRITE_TOOL_NAMES = new Set([
  "browser.upload",
]);

export function isDisabledBrowserWriteToolName(toolName: string): boolean {
  return DISABLED_BROWSER_WRITE_TOOL_NAMES.has(toolName);
}

const governedToolLimits = {
  timeoutMs: 90_000,
  maxInputBytes: 16_384,
  maxOutputBytes: 262_144,
};

const stringSchema: ToolJsonSchema = { type: "string" };
const nonEmptyStringSchema: ToolJsonSchema = { type: "string", minLength: 1, pattern: "\\S" };
const finiteNumberSchema: ToolJsonSchema = { type: "number" };
const integerSchema: ToolJsonSchema = { type: "integer" };

function objectSchema(
  properties: Record<string, ToolJsonSchema>,
  required: string[] = Object.keys(properties),
): ToolJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringArraySchema(maxItems?: number): ToolJsonSchema {
  return {
    type: "array",
    items: stringSchema,
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

const markdownDocumentSchema = objectSchema({
  path: nonEmptyStringSchema,
  modifiedAt: stringSchema,
  sizeBytes: finiteNumberSchema,
  heading: stringSchema,
  excerpt: stringSchema,
}, ["path", "modifiedAt", "sizeBytes"]);

const workspaceTextReadOutputSchema = objectSchema({
  path: nonEmptyStringSchema,
  content: stringSchema,
  truncated: { type: "boolean" },
});

const computerFileCandidateSchema = objectSchema({
  name: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  isDir: { type: "boolean" },
  sizeBytes: finiteNumberSchema,
  modifiedAt: stringSchema,
  extension: stringSchema,
}, ["name", "path", "isDir"]);

const codeSearchEvidenceSchema = objectSchema({
  path: nonEmptyStringSchema,
  line: integerSchema,
  column: integerSchema,
  excerpt: stringSchema,
  matchedTerms: stringArraySchema(),
  score: finiteNumberSchema,
}, ["path", "excerpt", "matchedTerms"]);

const codeWorkspaceInspectionEntrySchema = objectSchema({
  name: nonEmptyStringSchema,
  relativePath: nonEmptyStringSchema,
  isDir: { type: "boolean" },
  depth: integerSchema,
  sizeBytes: finiteNumberSchema,
  extension: stringSchema,
}, ["name", "relativePath", "isDir", "depth"]);

const codeWorkspaceRiskIndicatorSchema = objectSchema({
  code: {
    type: "string",
    enum: ["sensitive_name", "large_file", "inspection_truncated", "manifest_missing"],
  },
  severity: { type: "string", enum: ["info", "warning"] },
  path: stringSchema,
  detail: nonEmptyStringSchema,
}, ["code", "severity", "detail"]);

const codeWorkspaceInspectionOutputSchema = objectSchema({
  workspacePath: nonEmptyStringSchema,
  entries: { type: "array", items: codeWorkspaceInspectionEntrySchema },
  topLevelDirectories: stringArraySchema(),
  moduleCandidates: stringArraySchema(),
  manifests: stringArraySchema(),
  ignoredDirectories: stringArraySchema(),
  riskIndicators: { type: "array", items: codeWorkspaceRiskIndicatorSchema },
  truncated: { type: "boolean" },
});

const codeSearchAttemptSchema = objectSchema({
  id: nonEmptyStringSchema,
  query: stringSchema,
  reason: stringSchema,
  resultCount: integerSchema,
  status: { type: "string", enum: ["completed", "failed"] },
  durationMs: finiteNumberSchema,
  error: stringSchema,
  errorKind: { type: "string", enum: ["timeout", "unavailable", "permission", "cancelled", "unknown"] },
  provider: stringSchema,
  retryCount: integerSchema,
}, ["id", "query", "reason"]);

const codeSearchOutputSchema = objectSchema({
  actualFound: { type: "array", items: codeSearchEvidenceSchema },
  inferred: stringArraySchema(),
  needsConfirmation: stringArraySchema(),
  keyFiles: stringArraySchema(),
  relatedTestFiles: stringArraySchema(),
  testFileCandidates: stringArraySchema(),
  clusters: {
    type: "array",
    items: objectSchema({
      id: nonEmptyStringSchema,
      label: nonEmptyStringSchema,
      paths: stringArraySchema(),
      resultCount: integerSchema,
      score: finiteNumberSchema,
      topTerms: stringArraySchema(),
    }),
  },
  semanticDiagnostics: {
    type: "array",
    items: objectSchema({
      provider: nonEmptyStringSchema,
      status: { type: "string", enum: ["completed", "failed", "skipped"] },
      candidateCount: integerSchema,
      rerankedCount: integerSchema,
      durationMs: finiteNumberSchema,
      error: stringSchema,
    }, ["provider", "status", "candidateCount", "rerankedCount"]),
  },
  attempts: { type: "array", items: codeSearchAttemptSchema },
}, [
  "actualFound",
  "inferred",
  "needsConfirmation",
  "keyFiles",
  "relatedTestFiles",
  "testFileCandidates",
  "clusters",
  "attempts",
]);

const traceEvidenceSchema = objectSchema({
  path: nonEmptyStringSchema,
  line: integerSchema,
  column: integerSchema,
  excerpt: stringSchema,
  matchedTerms: stringArraySchema(),
  symbol: stringSchema,
  score: finiteNumberSchema,
}, ["path", "excerpt", "matchedTerms"]);

const tracePackageHintSchema = objectSchema({
  manifestPath: nonEmptyStringSchema,
  name: stringSchema,
  main: stringSchema,
  module: stringSchema,
  types: stringSchema,
  exports: stringArraySchema(),
}, ["manifestPath"]);

const traceModuleLinkSchema = objectSchema({
  specifier: nonEmptyStringSchema,
  kind: { type: "string", enum: ["relative", "workspace", "external"] },
  evidencePaths: stringArraySchema(),
  importCount: integerSchema,
  exportCount: integerSchema,
  dynamicImportCount: integerSchema,
  confidence: finiteNumberSchema,
  resolutionStatus: { type: "string", enum: ["resolved", "unresolved", "failed"] },
  resolvedPaths: stringArraySchema(),
  resolverProvider: stringSchema,
  resolutionError: stringSchema,
  packageHints: { type: "array", items: tracePackageHintSchema },
}, [
  "specifier",
  "kind",
  "evidencePaths",
  "importCount",
  "exportCount",
  "dynamicImportCount",
  "confidence",
]);

const traceSymbolNodeSchema = objectSchema({
  id: nonEmptyStringSchema,
  kind: { type: "string", enum: ["file", "symbol"] },
  label: nonEmptyStringSchema,
  path: stringSchema,
  symbol: stringSchema,
  confidence: finiteNumberSchema,
}, ["id", "kind", "label", "confidence"]);

const traceSymbolEdgeSchema = objectSchema({
  from: nonEmptyStringSchema,
  to: nonEmptyStringSchema,
  relation: { type: "string", enum: ["declares", "references", "imports", "exports", "calls"] },
  evidencePath: nonEmptyStringSchema,
  line: integerSchema,
  confidence: finiteNumberSchema,
}, ["from", "to", "relation", "evidencePath", "confidence"]);

const traceOutputSchema = objectSchema({
  target: nonEmptyStringSchema,
  direction: { type: "string", enum: ["forward", "backward", "bidirectional"] },
  actualFound: { type: "array", items: traceEvidenceSchema },
  nodes: { type: "array", items: objectSchema({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    kind: { type: "string", enum: ["target", "entrypoint", "candidate"] },
    path: stringSchema,
    symbol: stringSchema,
    score: finiteNumberSchema,
  }, ["id", "label", "kind", "score"]) },
  edges: { type: "array", items: objectSchema({
    from: nonEmptyStringSchema,
    to: nonEmptyStringSchema,
    relation: { type: "string", enum: ["references", "may_call", "imports", "exports", "entrypoint_to_candidate"] },
    evidencePath: nonEmptyStringSchema,
    line: integerSchema,
    excerpt: stringSchema,
    confidence: finiteNumberSchema,
    moduleSpecifier: stringSchema,
    moduleKind: { type: "string", enum: ["relative", "workspace", "external"] },
  }, ["from", "to", "relation", "evidencePath", "excerpt", "confidence"]) },
  moduleLinks: { type: "array", items: traceModuleLinkSchema },
  symbolGraph: objectSchema({
    nodes: { type: "array", items: traceSymbolNodeSchema },
    edges: { type: "array", items: traceSymbolEdgeSchema },
  }),
  inferred: stringArraySchema(),
  needsConfirmation: stringArraySchema(),
  keyFiles: stringArraySchema(),
  attempts: { type: "array", items: codeSearchAttemptSchema },
});

export const initialToolDescriptors: ToolDescriptor[] = [
  // ── Commander ──────────────────────────────────────────────────────────
  {
    name: "commander.plan",
    permissionLevel: "read",
    summary: "Analyze a user goal and produce a task plan with assigned agent steps.",
    capabilityTags: ["planning"],
    ownerAgentKinds: ["commander"],
  },
  {
    name: "commander.synthesize",
    permissionLevel: "read",
    summary: "Synthesize collected evidence from all workflow steps into a user-facing conclusion.",
    capabilityTags: ["synthesis"],
    ownerAgentKinds: ["commander"],
  },
  {
    name: "commander.askUser",
    permissionLevel: "read",
    summary: "Ask the user a clarifying question when the goal is ambiguous or information is missing.",
    capabilityTags: ["clarification"],
    ownerAgentKinds: ["commander"],
  },

  // ── Verifier ───────────────────────────────────────────────────────────
  {
    name: "verifier.check",
    permissionLevel: "read",
    summary: "Check collected evidence against success criteria. Return warn, not fail, for provenance-bound partial multi-source results that contain at least one valid completed source and an explicit blocked-source outcome; never pass incomplete results.",
    capabilityTags: ["evidence_check"],
    ownerAgentKinds: ["verifier"],
  },

  // ── File ───────────────────────────────────────────────────────────────
  {
    name: "file.scanMarkdownDocuments",
    permissionLevel: "read",
    summary: "Scan Markdown documents inside the active workspace.",
    capabilityTags: ["file_scan"],
    ownerAgentKinds: ["file", "verifier", "doc-updater", "explorer"],
    inputSchema: objectSchema({}),
    outputSchema: { type: "array", items: markdownDocumentSchema },
    limits: governedToolLimits,
  },
  {
    name: "file.scanUserDocuments",
    permissionLevel: "read",
    summary: "Scan user document files across Desktop, Documents, and Downloads.",
    capabilityTags: ["file_scan"],
    ownerAgentKinds: ["file"],
  },
  {
    name: "file.classifyDocuments",
    permissionLevel: "read",
    summary: "Classify scanned local documents into predefined categories using AI.",
    capabilityTags: ["document_classify"],
    ownerAgentKinds: ["file"],
    requiredInputs: [{ name: "files", type: "object[]", nonEmpty: true }],
  },
  {
    name: "file.planPdfOrganization",
    permissionLevel: "preview",
    summary: "Create a dry-run plan for organizing PDF files without moving them.",
    capabilityTags: ["file_scan"],
    ownerAgentKinds: ["file"],
  },
  {
    name: "file.executePdfOrganization",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Move PDF files exactly as listed in an approved dry-run plan.",
    capabilityTags: ["file_execute"],
    ownerAgentKinds: ["file"],
  },

  // ── Shell ──────────────────────────────────────────────────────────────
  {
    name: "file.planWriteText",
    permissionLevel: "preview",
    requiredPlanIntent: "write",
    summary: "Create a dry-run plan for writing text content to a file.",
    capabilityTags: ["file_scan"],
    ownerAgentKinds: ["file", "doc-updater"],
    requiredInputs: [
      { name: "targetPath", type: "string", nonEmpty: true },
      { name: "content", type: "string" },
    ],
  },
  {
    name: "file.writeText",
    permissionLevel: "confirmed_write",
    requiredPlanIntent: "write",
    writeRiskLevel: "safe",
    summary: "Write approved text content to a target file.",
    capabilityTags: ["file_execute"],
    ownerAgentKinds: ["file", "doc-updater"],
    requiredInputs: [
      { name: "targetPath", type: "string", nonEmpty: true },
      { name: "content", type: "string" },
    ],
  },
  {
    name: "shell.runReadOnlyCommand",
    permissionLevel: "read",
    summary: "Run an allowlisted read-only shell command in the workspace. Requires toolInput.program and toolInput.args; use only exact safe read-only commands such as git status --short, git diff --stat, git diff --unified=1, git diff --check, node --version, pnpm --version, or cargo --version.",
    capabilityTags: ["shell_readonly"],
    ownerAgentKinds: [
      "shell",
      "code",
      "verifier",
      "language-reviewer",
      "security-reviewer",
      "build-fix",
      "test-runner",
      "doc-updater",
      "explorer",
      "perf-analyzer",
      "refactor",
    ],
    requiredInputs: [
      { name: "program", type: "string", nonEmpty: true },
      { name: "args", type: "string[]", nonEmpty: true },
    ],
  },
  {
    name: "shell.runWorkspaceCommand",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Run an approved test, typecheck, or verification command inside the selected workspace with native one-shot approval binding and workspace-write OS sandbox enforcement.",
    capabilityTags: ["shell_execute"],
    ownerAgentKinds: ["shell", "code", "verifier", "build-fix", "test-runner"],
    requiredInputs: [
      { name: "program", type: "string", nonEmpty: true },
      { name: "args", type: "string[]", nonEmpty: true },
    ],
    inputSchema: objectSchema({
      program: nonEmptyStringSchema,
      args: stringArraySchema(),
    }, ["program", "args"]),
    limits: governedToolLimits,
  },

  // ── Code ───────────────────────────────────────────────────────────────
  {
    name: "code.inspectRepository",
    permissionLevel: "preview",
    summary: "Collect changed files, diff summary, and diff preview without applying edits.",
    capabilityTags: ["git_inspect"],
    ownerAgentKinds: [
      "code",
      "language-reviewer",
      "security-reviewer",
      "build-fix",
      "test-runner",
      "doc-updater",
      "explorer",
      "perf-analyzer",
      "refactor",
    ],
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      workspacePath: nonEmptyStringSchema,
      changedFiles: stringArraySchema(),
      diffStat: stringSchema,
      diff: stringSchema,
    }),
    limits: governedToolLimits,
  },
  {
    name: "file.readWorkspaceText",
    permissionLevel: "read",
    summary: "Read a specific text file inside the selected workspace. Requires a workspace-relative path; maxLines is optional and defaults to 200. Sensitive files, symlinks, paths outside the workspace, and unsupported binary extensions are rejected by the native read boundary.",
    capabilityTags: ["workspace_text_read"],
    ownerAgentKinds: [
      "file",
      "code",
      "verifier",
      "language-reviewer",
      "security-reviewer",
      "build-fix",
      "test-runner",
      "doc-updater",
      "explorer",
      "perf-analyzer",
      "refactor",
    ],
    requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
    inputSchema: objectSchema({
      path: nonEmptyStringSchema,
      maxLines: { type: "integer", minimum: 1, maximum: 500 },
    }, ["path"]),
    outputSchema: workspaceTextReadOutputSchema,
    limits: governedToolLimits,
  },
  {
    name: "code.inspectWorkspace",
    permissionLevel: "read",
    summary: "Inspect the selected workspace tree without requiring Git, returning bounded directory evidence, module candidates, manifests, and obvious risk indicators.",
    capabilityTags: ["workspace_inspect"],
    ownerAgentKinds: ["code", "commander"],
    inputSchema: objectSchema({
      maxDepth: { type: "integer", minimum: 1, maximum: 4 },
      maxEntries: { type: "integer", minimum: 20, maximum: 1000 },
    }, []),
    outputSchema: codeWorkspaceInspectionOutputSchema,
    limits: governedToolLimits,
  },
  {
    name: "code.searchRepository",
    permissionLevel: "read",
    summary: "Search the current repository with structured fallback attempts, clustering, key files, and evidence gaps.",
    capabilityTags: ["code_search"],
    ownerAgentKinds: [
      "code",
      "research",
      "language-reviewer",
      "security-reviewer",
      "build-fix",
      "test-runner",
      "doc-updater",
      "explorer",
      "perf-analyzer",
      "refactor",
    ],
    requiredInputs: [{ name: "goal", type: "string", nonEmpty: true }],
    inputSchema: objectSchema({
      goal: nonEmptyStringSchema,
      knownTerms: stringArraySchema(64),
      entryFile: nonEmptyStringSchema,
      priorityPaths: stringArraySchema(64),
      maxAttempts: { type: "integer", minimum: 1, maximum: 20 },
      maxKeyFiles: { type: "integer", minimum: 1, maximum: 20 },
    }, ["goal"]),
    outputSchema: codeSearchOutputSchema,
    limits: governedToolLimits,
  },
  {
    name: "code.traceCallChain",
    permissionLevel: "read",
    summary: "Trace a repository call/reference chain from a generic target and optional entrypoints, returning evidence nodes, edges, module-link hints, key files, and confirmation gaps.",
    capabilityTags: ["code_trace"],
    ownerAgentKinds: [
      "code",
      "language-reviewer",
      "security-reviewer",
      "build-fix",
      "test-runner",
      "explorer",
      "perf-analyzer",
      "refactor",
    ],
    requiredInputs: [
      { name: "goal", type: "string", nonEmpty: true },
      { name: "target", type: "string", nonEmpty: true },
    ],
    inputSchema: objectSchema({
      goal: nonEmptyStringSchema,
      target: nonEmptyStringSchema,
      entrypoints: stringArraySchema(64),
      workspaceModulePrefixes: stringArraySchema(64),
      direction: { type: "string", enum: ["forward", "backward", "bidirectional"] },
      maxDepth: { type: "integer", minimum: 1, maximum: 20 },
      maxEdges: { type: "integer", minimum: 1, maximum: 100 },
      knownTerms: stringArraySchema(64),
      maxAttempts: { type: "integer", minimum: 1, maximum: 20 },
    }, ["goal", "target"]),
    outputSchema: traceOutputSchema,
    limits: governedToolLimits,
  },
  {
    name: "code.proposeEdit",
    permissionLevel: "preview",
    summary: "Produce a patch proposal for user review without modifying files.",
    capabilityTags: ["code_propose"],
    ownerAgentKinds: ["code", "build-fix", "doc-updater", "refactor"],
  },
  {
    name: "code.applyProposedEdit",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Apply only the approved Code Agent patch proposal.",
    capabilityTags: ["code_apply"],
    ownerAgentKinds: ["code", "build-fix", "doc-updater", "refactor"],
  },
  {
    name: "git.stageFiles",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Stage explicitly selected workspace files in the Git index after approval.",
    capabilityTags: ["git_stage"],
    ownerAgentKinds: ["code"],
    requiredInputs: [{ name: "paths", type: "string[]", nonEmpty: true }],
  },
  {
    name: "git.createCommit",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Stage current or explicitly selected workspace changes and create a local Git commit after approval.",
    capabilityTags: ["git_commit"],
    ownerAgentKinds: ["code"],
    requiredInputs: [{ name: "message", type: "string", nonEmpty: true }],
  },
  {
    name: "git.createPullRequest",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Create a draft GitHub pull request from the current branch after approval; requires title and baseBranch, with optional body and draft.",
    capabilityTags: ["git_pr_create"],
    ownerAgentKinds: ["code"],
    requiredInputs: [
      { name: "title", type: "string", nonEmpty: true },
      { name: "baseBranch", type: "string", nonEmpty: true },
    ],
  },
  {
    name: "git.commentPullRequest",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Add a comment to a GitHub pull request after approval; requires pullRequest and body.",
    capabilityTags: ["git_pr_comment"],
    ownerAgentKinds: ["code"],
    requiredInputs: [
      { name: "pullRequest", type: "string", nonEmpty: true },
      { name: "body", type: "string", nonEmpty: true },
    ],
  },

  // ── Research ──────────────────────────────────────────────────────────
  {
    name: "web.search",
    permissionLevel: "read",
    summary: "Search public web sources through a configured provider.",
    capabilityTags: ["web_search"],
    ownerAgentKinds: ["research"],
    requiredInputs: [{ name: "query", type: "string", nonEmpty: true }],
  },
  {
    name: "web.fetchSource",
    permissionLevel: "read",
    summary: "Fetch a user-provided public web source URL.",
    capabilityTags: ["web_fetch"],
    ownerAgentKinds: ["research"],
    requiredInputs: [{ name: "url", type: "string", nonEmpty: true }],
  },
  {
    name: "trend.fetchHotList",
    permissionLevel: "read",
    summary: "Fetch a structured public hot/trending list when the provider has a registered adapter, with item count and freshness metadata. For an unsupported site, delegate Page Agent browser navigation/content extraction instead of retrying this tool. Requires toolInput.provider; limit is optional.",
    capabilityTags: ["trend_fetch", "web_fetch"],
    ownerAgentKinds: ["research"],
    requiredInputs: [{ name: "provider", type: "string", nonEmpty: true }],
    metadata: {
      failureFallbackAgentKind: "page-agent",
      failureFallbackCapability: "browser_navigate",
    },
  },
  {
    name: "memory.search",
    permissionLevel: "read",
    summary: "Search local Agent memory facts by query, tags, kind, and scope. Does not create or edit facts; may update local access metadata.",
    capabilityTags: ["memory_search"],
    ownerAgentKinds: ["commander", "workspace"],
  },

  // ── Computer ──────────────────────────────────────────────────────────
  {
    name: "file.scanUserImages",
    permissionLevel: "read",
    summary: "Scan user image files across common user directories.",
    capabilityTags: ["image_scan"],
    ownerAgentKinds: ["computer"],
  },
  {
    name: "file.scanInstalledApps",
    permissionLevel: "read",
    summary: "Scan installed desktop applications from Start Menu and Desktop shortcuts.",
    capabilityTags: ["local_search"],
    ownerAgentKinds: ["computer"],
  },
  {
    name: "computer.searchLocalDocuments",
    permissionLevel: "read",
    summary: "Search indexed local files by name, keyword, and metadata.",
    capabilityTags: ["local_search"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "query", type: "string", nonEmpty: true }],
  },
  {
    name: "computer.listDirectory",
    permissionLevel: "read",
    summary: "List direct children of a directory for file explorer browsing. Requires toolInput.path as a non-empty string.",
    capabilityTags: ["directory_list"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
    inputSchema: objectSchema({ path: nonEmptyStringSchema }),
    outputSchema: { type: "array", items: computerFileCandidateSchema },
    limits: governedToolLimits,
  },
  {
    name: "computer.openPath",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Open a file or directory path in the native OS shell. Requires toolInput.path as a non-empty string.",
    capabilityTags: ["local_search"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
  },
  {
    name: "computer.screenshot",
    permissionLevel: "read",
    summary: "Capture the current desktop, a specific window, or a cropped region as a PNG screenshot.",
    capabilityTags: ["desktop_screenshot"],
    ownerAgentKinds: ["computer"],
  },
  {
    name: "computer.listWindows",
    permissionLevel: "read",
    summary: "Enumerate all visible windows with titles, handles, and screen positions.",
    capabilityTags: ["desktop_list_windows"],
    ownerAgentKinds: ["computer"],
  },
  {
    name: "computer.inspectUi",
    permissionLevel: "read",
    summary: "Inspect a window's UI Automation control tree without moving the mouse.",
    capabilityTags: ["desktop_ui_tree"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "windowHandle", type: "number" }],
  },
  {
    name: "computer.focusWindow",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "safe",
    summary: "Bring a specific window to the foreground by handle. Requires user approval.",
    capabilityTags: ["desktop_focus"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "handle", type: "number" }],
  },
  {
    name: "computer.moveMouse",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "safe",
    summary: "Move the mouse cursor to absolute screen coordinates. Requires user approval.",
    capabilityTags: ["desktop_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
  },
  {
    name: "computer.click",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "dangerous",
    summary: "Click at absolute screen coordinates. Requires user approval.",
    capabilityTags: ["desktop_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
    ],
  },
  {
    name: "computer.type",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "dangerous",
    summary: "Type text via keyboard input simulation. Requires user approval.",
    capabilityTags: ["desktop_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "text", type: "string" }],
  },
  {
    name: "computer.keyCombo",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "dangerous",
    summary: "Press a key combination (e.g. Ctrl+C). Requires user approval and allowlist check.",
    capabilityTags: ["desktop_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "keys", type: "string[]", nonEmpty: true }],
  },
  {
    name: "computer.scroll",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "safe",
    summary: "Scroll at absolute screen coordinates. Requires user approval.",
    capabilityTags: ["desktop_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [
      { name: "x", type: "number" },
      { name: "y", type: "number" },
      { name: "delta", type: "number" },
    ],
  },
  {
    name: "computer.invokeUi",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Invoke a UI Automation control by selector without moving the physical mouse. Requires user approval.",
    capabilityTags: ["desktop_ui_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "selector", type: "object" }],
  },
  {
    name: "computer.setUiValue",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Set a UI Automation value by selector without moving the physical mouse. Requires user approval.",
    capabilityTags: ["desktop_ui_input"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [
      { name: "selector", type: "object" },
      { name: "value", type: "string" },
    ],
  },
  {
    name: "computer.wait",
    permissionLevel: "read",
    summary: "Wait for a specified duration (max 10 seconds).",
    capabilityTags: ["desktop_screenshot"],
    ownerAgentKinds: ["computer"],
    requiredInputs: [{ name: "ms", type: "number" }],
  },

  // ── Scheduler ─────────────────────────────────────────────────────────
  {
    name: "scheduler.createTask",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "safe",
    summary: "Create a durable local scheduled task or reminder.",
    capabilityTags: ["schedule_create"],
    ownerAgentKinds: ["scheduler"],
  },
  // ── Workspace ─────────────────────────────────────────────────────────
  {
    name: "workspace.list",
    permissionLevel: "read",
    summary: "List installed custom workspace definitions.",
    capabilityTags: ["workspace_list"],
    ownerAgentKinds: ["workspace"],
  },
  {
    name: "workspace.scaffold",
    permissionLevel: "preview",
    summary: "Generate a workspace definition JSON from a natural language description.",
    capabilityTags: ["workspace_scaffold"],
    ownerAgentKinds: ["workspace"],
  },
  {
    name: "workspace.create",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "safe",
    summary: "Save a new workspace definition to disk.",
    capabilityTags: ["workspace_create"],
    ownerAgentKinds: ["workspace"],
    requiredInputs: [{ name: "definition", type: "object", nonEmpty: true }],
  },
  {
    name: "workspace.delete",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Remove a workspace definition from disk.",
    capabilityTags: ["workspace_delete"],
    ownerAgentKinds: ["workspace"],
    requiredInputs: [{ name: "workspaceId", type: "string", nonEmpty: true }],
  },

  // ── Browser ───────────────────────────────────────────────────────────
  {
    name: "browser.navigate",
    permissionLevel: "read",
    summary: "Navigate the browser to a URL and wait for page load.",
    capabilityTags: ["browser_navigate"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [{ name: "url", type: "string", nonEmpty: true }],
  },
  {
    name: "browser.screenshot",
    permissionLevel: "read",
    summary: "Capture a screenshot of the current page or a specific element.",
    capabilityTags: ["browser_navigate"],
    ownerAgentKinds: ["page-agent"],
  },
  {
    name: "browser.getContent",
    permissionLevel: "read",
    summary: "Extract text, HTML, or markdown content from the current page.",
    capabilityTags: ["browser_navigate"],
    ownerAgentKinds: ["page-agent"],
  },
  {
    name: "browser.click",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Click an element on the page after visible confirmed-write approval.",
    capabilityTags: ["browser_interact"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [{ name: "selector", type: "string", nonEmpty: true }],
  },
  {
    name: "browser.type",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Type text into an input field after visible confirmed-write approval.",
    capabilityTags: ["browser_interact"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [
      { name: "selector", type: "string", nonEmpty: true },
      { name: "text", type: "string" },
    ],
  },
  {
    name: "browser.evaluate",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "dangerous",
    summary: "Execute JavaScript in the page context after visible confirmed-write approval.",
    capabilityTags: ["browser_interact"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [{ name: "expression", type: "string", nonEmpty: true }],
  },
  {
    name: "browser.runTest",
    permissionLevel: "confirmed_write",
    writeRiskLevel: "risky",
    summary: "Run a Playwright test script after visible confirmed-write approval and return pass/fail results.",
    capabilityTags: ["browser_test"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [{ name: "script", type: "string", nonEmpty: true }],
  },
  {
    name: "browser.extractLinks",
    permissionLevel: "read",
    summary: "Extract all hyperlinks from the current page with href and text.",
    capabilityTags: ["browser_navigate"],
    ownerAgentKinds: ["page-agent"],
  },
  {
    name: "browser.followCandidateLinks",
    permissionLevel: "read",
    summary: "Follow candidate links extracted from the current page and collect content excerpts.",
    capabilityTags: ["browser_navigate"],
    ownerAgentKinds: ["page-agent"],
    requiredInputs: [{ name: "candidateLinks", type: "object[]", nonEmpty: true }],
  },

  // ── Vision ────────────────────────────────────────────────────────────
  {
    name: "vision.analyze",
    permissionLevel: "read",
    summary: "Analyze an image and answer questions about its visual content.",
    capabilityTags: ["image_analyze"],
    ownerAgentKinds: ["vision"],
    requiredInputs: [{ name: "imagePath", type: "string", nonEmpty: true }],
  },
  {
    name: "vision.describe",
    permissionLevel: "read",
    summary: "Generate a textual description of an image's visual content.",
    capabilityTags: ["image_describe"],
    ownerAgentKinds: ["vision"],
    requiredInputs: [{ name: "imagePath", type: "string", nonEmpty: true }],
  },
  {
    name: "vision.extractText",
    permissionLevel: "read",
    summary: "Extract visible text from an image using OCR.",
    capabilityTags: ["image_ocr"],
    ownerAgentKinds: ["vision"],
    requiredInputs: [{ name: "imagePath", type: "string", nonEmpty: true }],
  },
];
