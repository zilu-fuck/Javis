import {
  buildRepositorySearchEvidenceReport,
  buildRepositoryTraceEvidenceReport,
  createRepositorySearchPlan,
  type RepositorySearchAttempt,
  type RepositorySearchAttemptErrorKind,
  type RepositorySearchResult,
  type RepositorySearchSemanticDiagnostic,
  type RepositoryTraceEvidence,
} from "@javis/core";
import * as ts from "typescript";
import type {
  CodeRepositoryTracePackageHint,
  CodeRepositoryTraceModuleLink,
  CodeRepositorySearchRequest,
  CodeRepositorySearchResult,
  CodeRepositorySymbolGraphEdge,
  CodeRepositoryTraceRequest,
  CodeRepositoryTraceResult,
} from "@javis/tools";
import { cosineSimilarity, createHashedTextVector } from "./local-text-embedding";

export interface RepositoryFileSearchResult {
  path: string;
  line?: number;
  preview?: string;
  provider?: string;
}

export interface RepositoryFileSearchRequest {
  query: string;
  maxResults: number;
}

export interface RepositorySearchServiceOptions {
  searchFiles(request: RepositoryFileSearchRequest): Promise<RepositoryFileSearchResult[]>;
  semanticRerank?(request: RepositorySemanticRerankRequest): Promise<RepositorySemanticRerankResult>;
  resolveModuleSpecifier?(request: RepositoryModuleResolveRequest): Promise<RepositoryModuleResolveResult>;
  readTextFile?(path: string): Promise<string>;
  listScriptFiles?(): Promise<string[]>;
  maxProjectSymbolFiles?: number;
  maxAttemptRetries?: number;
}

export interface RepositorySemanticRerankRequest {
  query: string;
  candidates: RepositorySearchResult[];
}

export interface RepositorySemanticRerankResult {
  provider?: string;
  scores: RepositorySemanticScore[];
}

export interface RepositorySemanticScore {
  path: string;
  line?: number;
  excerpt?: string;
  score: number;
}

export function createLocalTextSemanticReranker(options: {
  dimensions?: number;
  weight?: number;
  provider?: string;
} = {}): NonNullable<RepositorySearchServiceOptions["semanticRerank"]> {
  const dimensions = Math.max(32, Math.trunc(options.dimensions ?? 256));
  const weight = Number.isFinite(options.weight) ? options.weight! : 10;
  const provider = options.provider ?? "local-text-hash-embedding";
  return async ({ query, candidates }) => {
    const queryVector = createHashedTextVector(query, dimensions);
    return {
      provider,
      scores: candidates.map((candidate) => ({
        path: candidate.path,
        line: candidate.line,
        excerpt: candidate.excerpt,
        score: cosineSimilarity(queryVector, createHashedTextVector(
          `${candidate.path} ${candidate.excerpt} ${candidate.matchedTerms.join(" ")}`,
          dimensions,
        )) * weight,
      })),
    };
  };
}

type RepositoryAttemptWithDiagnostics = RepositorySearchAttempt & {
  resultCount: number;
  status: "completed" | "failed";
  durationMs: number;
  error?: string;
  errorKind?: RepositorySearchAttemptErrorKind;
  provider?: string;
  retryCount: number;
};

export interface RepositoryModuleResolveRequest {
  sourcePath: string;
  specifier: string;
  kind: "relative" | "workspace" | "external";
}

export interface RepositoryModuleResolveResult {
  resolvedPaths: string[];
  provider?: string;
  packageHints?: CodeRepositoryTracePackageHint[];
}

export interface RepositoryModuleFileSearchResolverOptions {
  searchFiles(request: RepositoryFileSearchRequest): Promise<RepositoryFileSearchResult[]>;
  readTextFile?(path: string): Promise<string>;
  externalPackageRegistry?: {
    fetch: typeof fetch;
    registryUrl?: string;
  };
  maxResults?: number;
}

const DEFAULT_ATTEMPT_RETRIES = 1;

export async function searchRepositoryWithFileSearch(
  request: CodeRepositorySearchRequest,
  options: RepositorySearchServiceOptions,
): Promise<CodeRepositorySearchResult> {
  const plan = createRepositorySearchPlan(request);
  const maxResultsPerAttempt = Math.max(5, Math.min(50, request.maxAttempts ? 120 / request.maxAttempts : 20));
  const found = new Map<string, RepositorySearchResult>();
  const attempts = plan.attempts.map(createPendingAttempt);

  for (const attempt of attempts) {
    const results = await runSearchAttempt(attempt, maxResultsPerAttempt, options);
    for (const result of results) {
      const normalized = normalizeFileSearchResult(result, attempt.query);
      const key = `${normalized.path}:${normalized.line ?? ""}:${normalized.excerpt}`;
      if (!found.has(key)) {
        found.set(key, normalized);
      }
    }
  }

  const semantic = await applySemanticRerank(request.goal, [...found.values()], options.semanticRerank);
  const report = buildRepositorySearchEvidenceReport(semantic.results, {
    maxKeyFiles: request.maxKeyFiles,
    priorityPaths: request.priorityPaths,
  });

  const reportWithAttemptDiagnostics = appendAttemptDiagnostics(report, attempts);

  return {
    ...reportWithAttemptDiagnostics,
    needsConfirmation: [
      ...reportWithAttemptDiagnostics.needsConfirmation,
      ...semantic.needsConfirmation,
    ],
    ...(semantic.diagnostics.length > 0 ? { semanticDiagnostics: semantic.diagnostics } : {}),
    attempts,
  };
}

export async function traceCallChainWithFileSearch(
  request: CodeRepositoryTraceRequest,
  options: RepositorySearchServiceOptions,
): Promise<CodeRepositoryTraceResult> {
  const plan = createRepositorySearchPlan({
    goal: request.goal,
    knownTerms: [
      request.target,
      ...(request.entrypoints ?? []),
      ...(request.knownTerms ?? []),
    ],
    maxAttempts: request.maxAttempts ?? 10,
  });
  const attempts = uniqueAttempts([
    {
      id: "trace-target",
      query: request.target,
      reason: "exact target from trace request",
    },
    ...(request.entrypoints ?? []).map((entrypoint, index) => ({
      id: `trace-entrypoint-${index + 1}`,
      query: entrypoint,
      reason: "exact entrypoint from trace request",
    })),
    ...plan.attempts,
  ]).slice(0, Math.max(1, request.maxAttempts ?? 10));
  const attemptsWithCounts = attempts.map(createPendingAttempt);
  const maxResultsPerAttempt = Math.max(5, Math.min(30, request.maxAttempts ? 90 / request.maxAttempts : 12));
  const found = new Map<string, RepositoryTraceEvidence>();

  for (const attempt of attemptsWithCounts) {
    const results = await runSearchAttempt(attempt, maxResultsPerAttempt, options);
    for (const result of results) {
      const normalized = normalizeTraceSearchResult(result, attempt.query, request.target);
      const key = `${normalized.path}:${normalized.line ?? ""}:${normalized.excerpt}`;
      if (!found.has(key)) {
        found.set(key, normalized);
      }
    }
  }
  for (const astEvidence of await collectAstTraceEvidence([...found.values()], request, options)) {
    const key = `${astEvidence.path}:${astEvidence.line ?? ""}:${astEvidence.excerpt}`;
    if (!found.has(key)) {
      found.set(key, astEvidence);
    }
  }

  const report = buildRepositoryTraceEvidenceReport([...found.values()], {
    goal: request.goal,
    target: request.target,
    entrypoints: request.entrypoints,
    workspaceModulePrefixes: request.workspaceModulePrefixes,
    direction: request.direction,
    maxDepth: request.maxDepth,
    maxEdges: request.maxEdges,
  });

  const reportWithAttempts = appendAttemptDiagnostics(report, attemptsWithCounts);
  const reportWithResolvedModules = await enrichProjectWideAstSymbolGraph(
    request,
    options,
    await enrichAstSymbolGraph(
      request,
      options,
      enrichResolvedModuleSymbolGraph(
        await appendModuleResolution(reportWithAttempts, options),
      ),
    ),
  );
  const resolvedAstEvidence = await collectResolvedModuleAstTraceEvidence(
    reportWithResolvedModules.moduleLinks,
    request,
    options,
  );
  if (resolvedAstEvidence.length > 0) {
    for (const astEvidence of resolvedAstEvidence) {
      const key = `${astEvidence.path}:${astEvidence.line ?? ""}:${astEvidence.excerpt}`;
      if (!found.has(key)) {
        found.set(key, astEvidence);
      }
    }
    const expandedReport = buildRepositoryTraceEvidenceReport([...found.values()], {
      goal: request.goal,
      target: request.target,
      entrypoints: request.entrypoints,
      workspaceModulePrefixes: request.workspaceModulePrefixes,
      direction: request.direction,
      maxDepth: request.maxDepth,
      maxEdges: request.maxEdges,
    });
    const expandedReportWithAttempts = appendAttemptDiagnostics(expandedReport, attemptsWithCounts);
    const expandedReportWithResolvedModules = await enrichProjectWideAstSymbolGraph(
      request,
      options,
      await enrichAstSymbolGraph(
        request,
        options,
        enrichResolvedModuleSymbolGraph(
          await appendModuleResolution(expandedReportWithAttempts, options),
        ),
      ),
    );
    return {
      ...expandedReportWithResolvedModules,
      attempts: attemptsWithCounts,
    };
  }

  return {
    ...reportWithResolvedModules,
    attempts: attemptsWithCounts,
  };
}

export async function resolveModuleSpecifierWithFileSearch(
  request: RepositoryModuleResolveRequest,
  options: RepositoryModuleFileSearchResolverOptions,
): Promise<RepositoryModuleResolveResult> {
  if (request.kind === "workspace") {
    return resolveWorkspaceModuleSpecifierWithFileSearch(request, options);
  }
  if (request.kind === "external") {
    return resolveExternalModuleSpecifierWithFileSearch(request, options);
  }
  if (request.kind !== "relative") {
    return resolveTsconfigModuleSpecifierWithFileSearch(request, options);
  }
  const candidates = createRelativeModulePathCandidates(request.sourcePath, request.specifier);
  if (candidates.length === 0) {
    return {
      resolvedPaths: [],
      provider: "file-search-resolver",
    };
  }
  const query = moduleSpecifierSearchTerm(request.specifier);
  const results = await options.searchFiles({
    query,
    maxResults: options.maxResults ?? 20,
  });
  const resolvedPaths = uniqueSearchPaths(results
    .map((result) => normalizeRepositoryPath(result.path))
    .filter((path) => candidates.some((candidate) => path === candidate || path.endsWith(`/${candidate}`))));
  return {
    resolvedPaths,
    provider: summarizeResultProviders(results) ?? "file-search-resolver",
  };
}

async function resolveExternalModuleSpecifierWithFileSearch(
  request: RepositoryModuleResolveRequest,
  options: RepositoryModuleFileSearchResolverOptions,
): Promise<RepositoryModuleResolveResult> {
  const tsconfigResult = await resolveTsconfigModuleSpecifierWithFileSearch(request, options);
  const packageName = workspacePackageNameFromSpecifier(request.specifier);
  if (!packageName || !options.readTextFile) {
    return tsconfigResult;
  }
  const packageResults = await options.searchFiles({
    query: packageName,
    maxResults: options.maxResults ?? 20,
  });
  const evidencePaths = uniqueSearchPaths(packageResults
    .map((result) => normalizeRepositoryPath(result.path))
    .filter(isPackageEvidencePath));
  const packageHints = uniquePackageHints([
    ...await readExternalPackageHints(packageName, evidencePaths, options.readTextFile),
    ...await readExternalPackageRegistryHints(packageName, request.specifier, options.externalPackageRegistry),
  ]);
  return {
    resolvedPaths: uniqueSearchPaths([
      ...tsconfigResult.resolvedPaths,
      ...packageHints.map((hint) => hint.manifestPath),
    ]),
    provider: uniqueProviderSummary([
      tsconfigResult.provider,
      summarizeResultProviders(packageResults),
      packageHints.some((hint) => hint.manifestPath.startsWith("registry:")) ? "npm-registry" : undefined,
      packageHints.some((hint) => !hint.manifestPath.startsWith("registry:")) ? "external-package-manifest" : undefined,
    ]),
    ...(packageHints.length > 0 ? {
      packageHints: uniquePackageHints([
        ...(tsconfigResult.packageHints ?? []),
        ...packageHints,
      ]),
    } : tsconfigResult.packageHints ? { packageHints: tsconfigResult.packageHints } : {}),
  };
}

async function resolveWorkspaceModuleSpecifierWithFileSearch(
  request: RepositoryModuleResolveRequest,
  options: RepositoryModuleFileSearchResolverOptions,
): Promise<RepositoryModuleResolveResult> {
  const packageName = workspacePackageNameFromSpecifier(request.specifier);
  if (!packageName) {
    return resolveTsconfigModuleSpecifierWithFileSearch(request, options);
  }
  const results = await options.searchFiles({
    query: packageName,
    maxResults: options.maxResults ?? 20,
  });
  const resolvedPaths = uniqueSearchPaths(results
    .filter((result) =>
      /(^|[\\/])package\.json$/i.test(result.path) &&
      (result.preview?.includes(packageName) ?? true),
    )
    .map((result) => result.path));
  const packageHints = options.readTextFile
    ? await readPackageHints(resolvedPaths, options.readTextFile)
    : undefined;
  const tsconfigResult = await resolveTsconfigModuleSpecifierWithFileSearch(request, options);
  return {
    resolvedPaths: uniqueSearchPaths([...resolvedPaths, ...tsconfigResult.resolvedPaths]),
    provider: uniqueProviderSummary([
      summarizeResultProviders(results) ?? "workspace-package-search",
      tsconfigResult.provider,
    ]),
    ...(packageHints && packageHints.length > 0 ? { packageHints } : {}),
  };
}

async function resolveTsconfigModuleSpecifierWithFileSearch(
  request: RepositoryModuleResolveRequest,
  options: RepositoryModuleFileSearchResolverOptions,
): Promise<RepositoryModuleResolveResult> {
  if (!options.readTextFile || request.specifier.startsWith(".")) {
    return {
      resolvedPaths: [],
      provider: undefined,
    };
  }

  const configResults = await options.searchFiles({
    query: "tsconfig",
    maxResults: options.maxResults ?? 20,
  });
  const configPaths = sortConfigPathsForSource(
    uniqueSearchPaths(configResults
      .map((result) => result.path)
      .filter((path) => /(^|[\\/])tsconfig(?:\.[^\\/]+)?\.json$/i.test(path))),
    request.sourcePath,
  );
  if (configPaths.length === 0) {
    return {
      resolvedPaths: [],
      provider: summarizeResultProviders(configResults),
    };
  }

  let candidates: string[] = [];
  let selectedConfig: TsconfigResolutionConfig | undefined;
  for (const configPath of configPaths) {
    try {
      const config = await readTsconfigResolutionConfig(configPath, options.readTextFile);
      candidates = tsconfigCandidatesFromConfig(config, request.specifier);
      if (candidates.length > 0) {
        selectedConfig = config;
        break;
      }
    } catch {
      // Ignore unreadable configs; unresolved links remain candidates.
    }
  }

  if (candidates.length === 0) {
    return {
      resolvedPaths: [],
      provider: summarizeResultProviders(configResults) ?? "tsconfig-paths-resolver",
    };
  }

  const query = moduleSpecifierSearchTerm(request.specifier);
  const fileResults = await options.searchFiles({
    query,
    maxResults: options.maxResults ?? 20,
  });
  const resolvedPaths = uniqueSearchPaths(fileResults
    .map((result) => normalizeRepositoryPath(result.path))
    .filter((path) => candidates.some((candidate) => path === candidate || path.endsWith(`/${candidate}`))));
  const compilerResolvedPaths = selectedConfig
    ? resolveModuleSpecifierWithTypeScriptCompiler(request, selectedConfig, [
      ...resolvedPaths,
      ...fileResults.map((result) => result.path),
    ])
    : [];

  return {
    resolvedPaths: uniqueSearchPaths([...resolvedPaths, ...compilerResolvedPaths]),
    provider: uniqueProviderSummary([
      summarizeResultProviders(configResults),
      summarizeResultProviders(fileResults),
      "tsconfig-paths-resolver",
      compilerResolvedPaths.length > 0 ? "typescript-compiler" : undefined,
    ]),
  };
}

async function runSearchAttempt(
  attempt: RepositoryAttemptWithDiagnostics,
  maxResults: number,
  options: RepositorySearchServiceOptions,
): Promise<RepositoryFileSearchResult[]> {
  const startedAt = Date.now();
  const maxRetries = Math.max(0, Math.trunc(options.maxAttemptRetries ?? DEFAULT_ATTEMPT_RETRIES));
  for (let tryIndex = 0; tryIndex <= maxRetries; tryIndex += 1) {
    try {
      const results = await options.searchFiles({
        query: attempt.query,
        maxResults,
      });
      attempt.resultCount = results.length;
      attempt.status = "completed";
      attempt.durationMs = Date.now() - startedAt;
      attempt.provider = summarizeResultProviders(results);
      attempt.retryCount = tryIndex;
      attempt.error = undefined;
      attempt.errorKind = undefined;
      return results;
    } catch (error) {
      attempt.resultCount = 0;
      attempt.status = "failed";
      attempt.durationMs = Date.now() - startedAt;
      attempt.retryCount = tryIndex;
      attempt.error = summarizeAttemptError(error);
      attempt.errorKind = classifyAttemptError(attempt.error);
    }
  }
  return [];
}

function createPendingAttempt(attempt: RepositorySearchAttempt): RepositoryAttemptWithDiagnostics {
  return {
    ...attempt,
    resultCount: 0,
    status: "completed",
    durationMs: 0,
    retryCount: 0,
  };
}

function summarizeResultProviders(results: ReadonlyArray<RepositoryFileSearchResult>): string | undefined {
  const providers = [...new Set(results.map((result) => result.provider?.trim()).filter(Boolean))];
  return providers.length > 0 ? providers.join(", ") : undefined;
}

function appendAttemptDiagnostics<T extends { needsConfirmation: string[] }>(
  report: T,
  attempts: ReadonlyArray<RepositoryAttemptWithDiagnostics>,
): T {
  if (!attempts.some((attempt) => attempt.status === "failed")) {
    return report;
  }
  return {
    ...report,
    needsConfirmation: [
      ...report.needsConfirmation,
      "Some repository search attempts failed; inspect attempt errors and fallback attempts before trusting coverage.",
    ],
  };
}

async function applySemanticRerank(
  query: string,
  candidates: RepositorySearchResult[],
  semanticRerank: RepositorySearchServiceOptions["semanticRerank"],
): Promise<{
  results: RepositorySearchResult[];
  diagnostics: RepositorySearchSemanticDiagnostic[];
  needsConfirmation: string[];
}> {
  if (!semanticRerank || candidates.length === 0) {
    return {
      results: candidates,
      diagnostics: [],
      needsConfirmation: [],
    };
  }

  const startedAt = Date.now();
  try {
    const result = await semanticRerank({ query, candidates });
    const scores = new Map<string, number>();
    const scoredCandidates = new Set<string>();
    for (const score of result.scores) {
      if (!Number.isFinite(score.score)) continue;
      scores.set(semanticCandidateKey(score), score.score);
      scores.set(semanticCandidatePathLineKey(score), score.score);
      scoredCandidates.add(semanticCandidatePathLineKey(score));
    }
    const reranked = candidates.map((candidate) => {
      const semanticScore = scores.get(semanticCandidateKey(candidate)) ?? scores.get(semanticCandidatePathLineKey(candidate));
      return typeof semanticScore === "number"
        ? { ...candidate, score: (candidate.score ?? 1) + semanticScore }
        : candidate;
    });
    return {
      results: reranked,
      diagnostics: [{
        provider: result.provider?.trim() || "semantic-rerank",
        status: "completed",
        candidateCount: candidates.length,
        rerankedCount: scoredCandidates.size,
        durationMs: Date.now() - startedAt,
      }],
      needsConfirmation: [],
    };
  } catch (error) {
    return {
      results: candidates,
      diagnostics: [{
        provider: "semantic-rerank",
        status: "failed",
        candidateCount: candidates.length,
        rerankedCount: 0,
        durationMs: Date.now() - startedAt,
        error: summarizeAttemptError(error),
      }],
      needsConfirmation: [
        "Semantic reranking failed; repository evidence fell back to lexical search order.",
      ],
    };
  }
}

function semanticCandidateKey(candidate: { path: string; line?: number; excerpt?: string }): string {
  return `${normalizeRepositoryPath(candidate.path)}:${candidate.line ?? ""}:${candidate.excerpt?.trim() ?? ""}`;
}

function semanticCandidatePathLineKey(candidate: { path: string; line?: number }): string {
  return `${normalizeRepositoryPath(candidate.path)}:${candidate.line ?? ""}`;
}

async function appendModuleResolution<T extends { moduleLinks: CodeRepositoryTraceModuleLink[]; needsConfirmation: string[] }>(
  report: T,
  options: RepositorySearchServiceOptions,
): Promise<T> {
  if (!options.resolveModuleSpecifier || report.moduleLinks.length === 0) {
    return report;
  }

  const moduleLinks = await Promise.all(
    report.moduleLinks.map((link) => resolveModuleLink(link, options.resolveModuleSpecifier!)),
  );
  const needsConfirmation = [...report.needsConfirmation];
  if (moduleLinks.some((link) => link.resolutionStatus === "failed")) {
    needsConfirmation.push("Some module links failed resolver confirmation; inspect resolution errors before trusting the package graph.");
  }
  if (moduleLinks.some((link) => link.resolutionStatus === "unresolved")) {
    needsConfirmation.push("Some module links were not resolved by the configured resolver and remain candidates.");
  }
  return {
    ...report,
    moduleLinks,
    needsConfirmation,
  };
}

function enrichResolvedModuleSymbolGraph<T extends Pick<CodeRepositoryTraceResult, "moduleLinks" | "symbolGraph">>(report: T): T {
  const nodes = new Map(report.symbolGraph.nodes.map((node) => [node.id, node]));
  const edges = new Map(report.symbolGraph.edges.map((edge) => [
    `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`,
    edge,
  ]));
  const addFileNode = (path: string, confidence: number) => {
    const id = `file:${path}`;
    const existing = nodes.get(id);
    nodes.set(id, existing
      ? { ...existing, confidence: Math.max(existing.confidence, confidence) }
      : {
        id,
        kind: "file",
        label: path,
        path,
        confidence,
      });
    return id;
  };
  for (const link of report.moduleLinks) {
    if (link.resolutionStatus !== "resolved" || !link.resolvedPaths?.length) continue;
    const relation: CodeRepositorySymbolGraphEdge["relation"] = link.exportCount > link.importCount ? "exports" : "imports";
    for (const evidencePath of link.evidencePaths) {
      const sourceId = addFileNode(evidencePath, link.confidence);
      for (const resolvedPath of link.resolvedPaths) {
        const targetId = addFileNode(resolvedPath, link.confidence);
        const edge = {
          from: sourceId,
          to: targetId,
          relation,
          evidencePath,
          confidence: link.confidence,
        };
        edges.set(`${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:`, edge);
      }
    }
  }
  return {
    ...report,
    symbolGraph: {
      nodes: [...nodes.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        right.confidence - left.confidence ||
        left.label.localeCompare(right.label)),
      edges: [...edges.values()].sort((left, right) =>
        right.confidence - left.confidence ||
        left.evidencePath.localeCompare(right.evidencePath) ||
        left.relation.localeCompare(right.relation)),
    },
  };
}

async function enrichAstSymbolGraph<T extends Pick<CodeRepositoryTraceResult, "moduleLinks" | "symbolGraph">>(
  request: CodeRepositoryTraceRequest,
  options: RepositorySearchServiceOptions,
  report: T,
): Promise<T> {
  if (!options.readTextFile) return report;
  const nodes = new Map(report.symbolGraph.nodes.map((node) => [node.id, node]));
  const edges = new Map(report.symbolGraph.edges.map((edge) => [
    `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`,
    edge,
  ]));
  const target = request.target.trim();
  if (!target) return report;
  const sourcePaths = uniqueSearchPaths(report.moduleLinks
    .flatMap((link) => link.evidencePaths)
    .filter(isScriptPath))
    .slice(0, 12);
  const resolvedPaths = uniqueSearchPaths(report.moduleLinks
    .filter((link) => link.resolutionStatus === "resolved")
    .flatMap((link) => link.resolvedPaths ?? [])
    .filter(isScriptPath))
    .slice(0, 12);
  const addFileNode = (path: string, confidence: number) => {
    const id = `file:${path}`;
    const existing = nodes.get(id);
    nodes.set(id, existing
      ? { ...existing, confidence: Math.max(existing.confidence, confidence) }
      : {
        id,
        kind: "file",
        label: path,
        path,
        confidence,
      });
    return id;
  };
  const addSymbolNode = (symbol: string, path: string | undefined, confidence: number) => {
    const id = symbolGraphSymbolId(symbol);
    const existing = nodes.get(id);
    nodes.set(id, {
      id,
      kind: "symbol",
      label: symbol,
      ...(path ? { path } : existing?.path ? { path: existing.path } : {}),
      symbol,
      confidence: Math.max(existing?.confidence ?? 0, confidence),
    });
    return id;
  };
  const addEdge = (edge: CodeRepositorySymbolGraphEdge) => {
    const key = `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`;
    const existing = edges.get(key);
    edges.set(key, existing
      ? { ...existing, confidence: Math.max(existing.confidence, edge.confidence) }
      : edge);
  };

  const targetSymbolId = addSymbolNode(target, undefined, 0.9);
  for (const path of sourcePaths) {
    try {
      const callers = extractAstCallersForTarget(path, await options.readTextFile(path), target);
      for (const caller of callers) {
        const fileId = addFileNode(path, 0.9);
        const callerId = addSymbolNode(caller.symbol, path, 0.9);
        addEdge({
          from: fileId,
          to: callerId,
          relation: "declares",
          evidencePath: path,
          line: caller.line,
          confidence: 0.9,
        });
        addEdge({
          from: callerId,
          to: targetSymbolId,
          relation: "calls",
          evidencePath: path,
          line: caller.callLine,
          confidence: 0.9,
        });
      }
    } catch {
      // AST symbol graph enrichment is optional; resolver/file graph evidence remains intact.
    }
  }
  for (const path of resolvedPaths) {
    try {
      const declarations = extractAstTargetDeclarations(path, await options.readTextFile(path), target);
      for (const declaration of declarations) {
        const fileId = addFileNode(path, 0.9);
        const symbolId = addSymbolNode(declaration.symbol, path, 0.9);
        addEdge({
          from: fileId,
          to: symbolId,
          relation: declaration.exported ? "exports" : "declares",
          evidencePath: path,
          line: declaration.line,
          confidence: 0.9,
        });
      }
    } catch {
      // AST symbol graph enrichment is optional; resolver/file graph evidence remains intact.
    }
  }

  return {
    ...report,
    symbolGraph: {
      nodes: [...nodes.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        right.confidence - left.confidence ||
        left.label.localeCompare(right.label)),
      edges: [...edges.values()].sort((left, right) =>
        right.confidence - left.confidence ||
        left.evidencePath.localeCompare(right.evidencePath) ||
        left.relation.localeCompare(right.relation)),
    },
  };
}

async function enrichProjectWideAstSymbolGraph<T extends Pick<CodeRepositoryTraceResult, "keyFiles" | "moduleLinks" | "symbolGraph" | "needsConfirmation">>(
  request: CodeRepositoryTraceRequest,
  options: RepositorySearchServiceOptions,
  report: T,
): Promise<T> {
  if (!options.readTextFile || !options.listScriptFiles) return report;
  const maxFiles = Math.max(1, Math.min(200, options.maxProjectSymbolFiles ?? 40));
  let scriptPaths: string[];
  try {
    scriptPaths = uniqueSearchPaths((await options.listScriptFiles()).filter(isScriptPath));
  } catch {
    return {
      ...report,
      needsConfirmation: [
        ...report.needsConfirmation,
        "Project-wide AST symbol graph file discovery failed; trace graph is limited to search and resolved-module evidence.",
      ],
    };
  }

  const selectedPaths = prioritizeProjectSymbolPaths(scriptPaths, report, request).slice(0, maxFiles);
  if (selectedPaths.length === 0) return report;

  const selectedFileContents = new Map<string, string>();
  const nodes = new Map(report.symbolGraph.nodes.map((node) => [node.id, node]));
  const edges = new Map(report.symbolGraph.edges.map((edge) => [
    `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`,
    edge,
  ]));
  const addFileNode = (path: string, confidence: number) => {
    const id = `file:${path}`;
    const existing = nodes.get(id);
    nodes.set(id, existing
      ? { ...existing, confidence: Math.max(existing.confidence, confidence) }
      : {
        id,
        kind: "file",
        label: path,
        path,
        confidence,
      });
    return id;
  };
  const addSymbolNode = (symbol: string, path: string | undefined, confidence: number) => {
    const id = symbolGraphSymbolId(symbol);
    const existing = nodes.get(id);
    nodes.set(id, {
      id,
      kind: "symbol",
      label: symbol,
      ...(path ? { path } : existing?.path ? { path: existing.path } : {}),
      symbol,
      confidence: Math.max(existing?.confidence ?? 0, confidence),
    });
    return id;
  };
  const addEdge = (edge: CodeRepositorySymbolGraphEdge) => {
    const key = `${edge.from}:${edge.relation}:${edge.to}:${edge.evidencePath}:${edge.line ?? ""}`;
    const existing = edges.get(key);
    edges.set(key, existing
      ? { ...existing, confidence: Math.max(existing.confidence, edge.confidence) }
      : edge);
  };

  for (const path of selectedPaths) {
    try {
      const content = await options.readTextFile(path);
      selectedFileContents.set(normalizeRepositoryPath(path), content);
      const facts = extractAstSymbolGraphFacts(path, content);
      const fileId = addFileNode(path, 0.7);
      const importedSymbols = new Map(facts.imports.flatMap((item) => item.symbols.map((symbol) => [symbol, item] as const)));
      for (const declaration of facts.declarations) {
        const symbolId = addSymbolNode(declaration.symbol, path, declaration.exported ? 0.82 : 0.72);
        addEdge({
          from: fileId,
          to: symbolId,
          relation: declaration.exported ? "exports" : "declares",
          evidencePath: path,
          line: declaration.line,
          confidence: declaration.exported ? 0.82 : 0.72,
        });
      }
      for (const item of facts.imports) {
        for (const symbol of item.symbols) {
          const symbolId = addSymbolNode(symbol, undefined, 0.68);
          addEdge({
            from: fileId,
            to: symbolId,
            relation: "imports",
            evidencePath: path,
            line: item.line,
            confidence: 0.68,
          });
        }
      }
      for (const call of facts.calls) {
        if (call.caller && importedSymbols.has(call.callee)) {
          const callerId = addSymbolNode(call.caller, path, 0.78);
          const calleeImport = importedSymbols.get(call.callee);
          const calleeId = addSymbolNode(call.callee, undefined, 0.78);
          addEdge({
            from: callerId,
            to: calleeId,
            relation: "calls",
            evidencePath: path,
            line: call.line,
            confidence: calleeImport?.specifier.startsWith(".") ? 0.82 : 0.72,
          });
        }
      }
    } catch {
      // Project-wide AST graph enrichment is best-effort and should not hide direct trace evidence.
    }
  }

  const typeCheckerConfirmationGaps = enrichProjectWideTypeCheckerSymbolGraph({
    paths: selectedPaths,
    fileContents: selectedFileContents,
    nodes,
    edges,
    addFileNode,
    addSymbolNode,
    addEdge,
  });

  return {
    ...report,
    needsConfirmation: [
      ...report.needsConfirmation,
      ...(scriptPaths.length > selectedPaths.length
        ? [`Project-wide AST symbol graph was capped at ${selectedPaths.length} of ${scriptPaths.length} script files.`]
        : []),
      ...typeCheckerConfirmationGaps,
    ],
    symbolGraph: {
      nodes: [...nodes.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        right.confidence - left.confidence ||
        left.label.localeCompare(right.label)),
      edges: [...edges.values()].sort((left, right) =>
        right.confidence - left.confidence ||
        left.evidencePath.localeCompare(right.evidencePath) ||
        left.relation.localeCompare(right.relation)),
    },
  };
}

function enrichProjectWideTypeCheckerSymbolGraph(input: {
  paths: ReadonlyArray<string>;
  fileContents: ReadonlyMap<string, string>;
  nodes: Map<string, CodeRepositoryTraceResult["symbolGraph"]["nodes"][number]>;
  edges: Map<string, CodeRepositorySymbolGraphEdge>;
  addFileNode(path: string, confidence: number): string;
  addSymbolNode(symbol: string, path: string | undefined, confidence: number): string;
  addEdge(edge: CodeRepositorySymbolGraphEdge): void;
}): string[] {
  if (input.fileContents.size === 0) {
    return ["TypeScript TypeChecker symbol graph skipped because no project files could be read."];
  }
  try {
    const normalizedPaths = uniqueSearchPaths(input.paths.map(normalizeRepositoryPath));
    const program = createInMemoryTypeScriptProgram(normalizedPaths, input.fileContents);
    const checker = program.getTypeChecker();
    const sourcePaths = new Set(normalizedPaths);

    for (const sourceFile of program.getSourceFiles()) {
      const path = normalizeRepositoryPath(sourceFile.fileName);
      if (!sourcePaths.has(path)) continue;
      const fileId = input.addFileNode(path, 0.8);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          for (const imported of importBindingIdentifiers(node.importClause)) {
            const resolved = resolveCheckerSymbol(checker, imported);
            if (resolved?.path && sourcePaths.has(resolved.path)) {
              const symbolId = input.addSymbolNode(resolved.name, resolved.path, 0.9);
              input.addFileNode(resolved.path, 0.82);
              input.addEdge({
                from: fileId,
                to: symbolId,
                relation: "imports",
                evidencePath: path,
                line: sourceFile.getLineAndCharacterOfPosition(imported.getStart(sourceFile)).line + 1,
                confidence: 0.9,
              });
            }
          }
        } else if (ts.isCallExpression(node)) {
          const expression = callExpressionSymbolNode(node.expression);
          const caller = nearestNamedDeclaration(node);
          const resolved = expression ? resolveCheckerSymbol(checker, expression) : undefined;
          if (caller && resolved?.path && sourcePaths.has(resolved.path)) {
            const callerId = input.addSymbolNode(caller.symbol, path, 0.88);
            const calleeId = input.addSymbolNode(resolved.name, resolved.path, 0.92);
            input.addFileNode(resolved.path, 0.84);
            input.addEdge({
              from: callerId,
              to: calleeId,
              relation: "calls",
              evidencePath: path,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              confidence: 0.92,
            });
          }
        } else if (isCheckerDeclaration(node)) {
          const name = declarationSymbolName(node);
          if (name) {
            input.addEdge({
              from: fileId,
              to: input.addSymbolNode(name, path, declarationIsExported(node) ? 0.9 : 0.82),
              relation: declarationIsExported(node) ? "exports" : "declares",
              evidencePath: path,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              confidence: declarationIsExported(node) ? 0.9 : 0.82,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return [];
  } catch (error) {
    return [`TypeScript TypeChecker symbol graph failed: ${summarizeAttemptError(error)}`];
  }
}

function createInMemoryTypeScriptProgram(
  rootNames: ReadonlyArray<string>,
  fileContents: ReadonlyMap<string, string>,
): ts.Program {
  const files = new Set([...fileContents.keys()].map(normalizeRepositoryPath));
  const directories = createDirectorySet(files);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const normalized = normalizeRepositoryPath(fileName);
      const content = fileContents.get(normalized);
      return content === undefined
        ? undefined
        : ts.createSourceFile(normalized, content, languageVersion, true, scriptKindForPath(normalized));
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: (path) => [...directories]
      .filter((directory) => dirnameRepositoryPath(directory) === normalizeRepositoryPath(path)),
    fileExists: (fileName) => files.has(normalizeRepositoryPath(fileName)),
    readFile: (fileName) => fileContents.get(normalizeRepositoryPath(fileName)),
    directoryExists: (path) => directories.has(normalizeRepositoryPath(path)),
    getCanonicalFileName: normalizeRepositoryPath,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    realpath: normalizeRepositoryPath,
  };
  return ts.createProgram(rootNames.map(normalizeRepositoryPath), options, host);
}

function importBindingIdentifiers(clause: ts.ImportClause | undefined): ts.Identifier[] {
  if (!clause) return [];
  return [
    clause.name,
    clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name : undefined,
    ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.map((item) => item.name)
      : []),
  ].filter((value): value is ts.Identifier => Boolean(value));
}

function callExpressionSymbolNode(expression: ts.Expression): ts.Node | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression)) return expression.name;
  return undefined;
}

function resolveCheckerSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): { name: string; path: string } | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolved.declarations?.find((item) => isScriptPath(item.getSourceFile().fileName));
  if (!declaration) return undefined;
  const name = resolved.getName();
  if (!name || name === "default" || name === "__function") return undefined;
  return {
    name,
    path: normalizeRepositoryPath(declaration.getSourceFile().fileName),
  };
}

function isCheckerDeclaration(node: ts.Node): node is ts.FunctionDeclaration | ts.ClassDeclaration | ts.MethodDeclaration | ts.VariableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isVariableDeclaration(node);
}

function prioritizeProjectSymbolPaths(
  scriptPaths: string[],
  report: Pick<CodeRepositoryTraceResult, "keyFiles" | "moduleLinks" | "symbolGraph">,
  request: CodeRepositoryTraceRequest,
): string[] {
  const priority = new Map<string, number>();
  const add = (path: string | undefined, score: number) => {
    if (!path) return;
    const normalized = normalizeRepositoryPath(path);
    priority.set(normalized, Math.max(priority.get(normalized) ?? 0, score));
  };
  for (const path of report.keyFiles) add(path, 100);
  for (const link of report.moduleLinks) {
    for (const path of link.evidencePaths) add(path, 90);
    for (const path of link.resolvedPaths ?? []) add(path, 85);
  }
  for (const node of report.symbolGraph.nodes) add(node.path, node.symbol && sameSymbol(node.symbol, request.target) ? 95 : 70);
  return [...scriptPaths].sort((left, right) =>
    (priority.get(normalizeRepositoryPath(right)) ?? 0) - (priority.get(normalizeRepositoryPath(left)) ?? 0) ||
    normalizeRepositoryPath(left).localeCompare(normalizeRepositoryPath(right)));
}

function extractAstSymbolGraphFacts(path: string, content: string): {
  declarations: Array<{ symbol: string; line: number; exported: boolean }>;
  imports: Array<{ specifier: string; symbols: string[]; line: number }>;
  calls: Array<{ caller?: string; callee: string; line: number }>;
} {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const declarations = new Map<string, { symbol: string; line: number; exported: boolean }>();
  const imports: Array<{ specifier: string; symbols: string[]; line: number }> = [];
  const calls = new Map<string, { caller?: string; callee: string; line: number }>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      const symbols = importSymbols(node.importClause);
      if (specifier && symbols.length > 0) {
        imports.push({
          specifier,
          symbols,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }
    const symbol = declarationSymbolName(node);
    if (symbol) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      declarations.set(`${symbol}:${line}`, {
        symbol,
        line,
        exported: declarationIsExported(node),
      });
    }
    if (ts.isCallExpression(node)) {
      const callee = callExpressionSymbol(node.expression);
      if (callee) {
        const caller = nearestNamedDeclaration(node)?.symbol;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        calls.set(`${caller ?? ""}:${callee}:${line}`, { caller, callee, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    declarations: [...declarations.values()],
    imports,
    calls: [...calls.values()],
  };
}

function importSymbols(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  return [
    clause.name?.text,
    clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined,
    ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.map((item) => item.name.text)
      : []),
  ].filter((value): value is string => Boolean(value));
}

function callExpressionSymbol(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function extractAstCallersForTarget(path: string, content: string, target: string): Array<{ symbol: string; line: number; callLine: number }> {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const callers = new Map<string, { symbol: string; line: number; callLine: number }>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && expressionMatchesTarget(node.expression, target)) {
      const declaration = nearestNamedDeclaration(node);
      if (declaration) {
        const line = sourceFile.getLineAndCharacterOfPosition(declaration.node.getStart(sourceFile)).line + 1;
        const callLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        callers.set(`${declaration.symbol}:${line}:${callLine}`, {
          symbol: declaration.symbol,
          line,
          callLine,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...callers.values()];
}

function extractAstTargetDeclarations(path: string, content: string, target: string): Array<{ symbol: string; line: number; exported: boolean }> {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const declarations = new Map<string, { symbol: string; line: number; exported: boolean }>();
  const visit = (node: ts.Node) => {
    const symbol = declarationSymbolName(node);
    if (symbol && sameSymbol(symbol, target)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      declarations.set(`${symbol}:${line}`, {
        symbol,
        line,
        exported: declarationIsExported(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...declarations.values()];
}

function nearestNamedDeclaration(node: ts.Node): { symbol: string; node: ts.Node } | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const symbol = declarationSymbolName(current);
    if (symbol) return { symbol, node: current };
    current = current.parent;
  }
  return undefined;
}

function declarationSymbolName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableStatement(node)) return declarationName(node);
  return undefined;
}

function declarationIsExported(node: ts.Node): boolean {
  if (hasExportModifier(node)) return true;
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    return ts.isVariableStatement(statement) && hasExportModifier(statement);
  }
  return false;
}

function symbolGraphSymbolId(symbol: string): string {
  return `symbol:${symbol.trim().toLowerCase()}`;
}

async function resolveModuleLink(
  link: CodeRepositoryTraceModuleLink,
  resolveModuleSpecifier: NonNullable<RepositorySearchServiceOptions["resolveModuleSpecifier"]>,
): Promise<CodeRepositoryTraceModuleLink> {
  const resolvedPaths = new Set<string>();
  const providers = new Set<string>();
  const packageHints: CodeRepositoryTracePackageHint[] = [];
  const errors: string[] = [];

  for (const sourcePath of link.evidencePaths) {
    try {
      const result = await resolveModuleSpecifier({
        sourcePath,
        specifier: link.specifier,
        kind: link.kind,
      });
      for (const resolvedPath of result.resolvedPaths) {
        if (resolvedPath.trim()) resolvedPaths.add(resolvedPath.trim());
      }
      packageHints.push(...(result.packageHints ?? []));
      if (result.provider?.trim()) providers.add(result.provider.trim());
    } catch (error) {
      errors.push(summarizeAttemptError(error));
    }
  }

  const resolved = [...resolvedPaths].sort();
  if (resolved.length > 0) {
    return {
      ...link,
      resolutionStatus: "resolved",
      resolvedPaths: resolved,
      resolverProvider: [...providers].sort().join(", ") || undefined,
      packageHints: uniquePackageHints(packageHints),
      resolutionError: errors[0],
    };
  }
  if (errors.length > 0) {
    return {
      ...link,
      resolutionStatus: "failed",
      resolvedPaths: [],
      resolverProvider: [...providers].sort().join(", ") || undefined,
      resolutionError: errors[0],
    };
  }
  return {
    ...link,
    resolutionStatus: "unresolved",
    resolvedPaths: [],
    resolverProvider: [...providers].sort().join(", ") || undefined,
  };
}

function normalizeFileSearchResult(
  result: RepositoryFileSearchResult,
  query: string,
): RepositorySearchResult {
  return {
    path: result.path,
    line: result.line,
    excerpt: result.preview?.trim() || result.path,
    matchedTerms: [query],
  };
}

function normalizeTraceSearchResult(
  result: RepositoryFileSearchResult,
  query: string,
  target: string,
): RepositoryTraceEvidence {
  return {
    path: result.path,
    line: result.line,
    excerpt: result.preview?.trim() || result.path,
    matchedTerms: [query],
    symbol: inferResultSymbol(result.preview, target),
  };
}

function inferResultSymbol(preview: string | undefined, target: string): string | undefined {
  const value = preview?.trim();
  if (!value) return undefined;
  const targetLower = target.toLowerCase();
  const symbol = value.match(/\bimport\s+\{?\s*([A-Za-z_$][\w$]*)/)?.[1] ??
    value.match(/\b(?:function|class|const|let|var|export function|export class|export const)\s+([A-Za-z_$][\w$]*)/)?.[1] ??
    value.match(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(?/)?.[1];
  if (!symbol || symbol.toLowerCase() === targetLower) return undefined;
  return symbol;
}

async function collectAstTraceEvidence(
  seedEvidence: ReadonlyArray<RepositoryTraceEvidence>,
  request: CodeRepositoryTraceRequest,
  options: RepositorySearchServiceOptions,
): Promise<RepositoryTraceEvidence[]> {
  if (!options.readTextFile || seedEvidence.length === 0) return [];
  const paths = uniqueSearchPaths(seedEvidence
    .map((item) => item.path)
    .filter(isScriptPath))
    .slice(0, 8);
  const output: RepositoryTraceEvidence[] = [];
  for (const path of paths) {
    try {
      output.push(...extractAstTraceEvidence(path, await options.readTextFile(path), request));
    } catch {
      // AST evidence is an optional confidence boost; text-search evidence remains available.
    }
  }
  return output;
}

async function collectResolvedModuleAstTraceEvidence(
  moduleLinks: ReadonlyArray<CodeRepositoryTraceModuleLink>,
  request: CodeRepositoryTraceRequest,
  options: RepositorySearchServiceOptions,
): Promise<RepositoryTraceEvidence[]> {
  if (!options.readTextFile) return [];
  const paths = uniqueSearchPaths(moduleLinks
    .filter((link) => link.resolutionStatus === "resolved")
    .flatMap((link) => link.resolvedPaths ?? [])
    .filter(isScriptPath))
    .slice(0, 12);
  const output: RepositoryTraceEvidence[] = [];
  for (const path of paths) {
    try {
      output.push(...extractAstTraceEvidence(path, await options.readTextFile(path), request));
    } catch {
      // Resolved module AST evidence is an optional graph expansion.
    }
  }
  return output;
}

function extractAstTraceEvidence(
  path: string,
  content: string,
  request: CodeRepositoryTraceRequest,
): RepositoryTraceEvidence[] {
  const target = request.target.trim();
  if (!target) return [];
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
  const found = new Map<string, RepositoryTraceEvidence>();
  const addEvidence = (node: ts.Node, excerpt: string, symbol?: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const evidence: RepositoryTraceEvidence = {
      path,
      line,
      excerpt,
      matchedTerms: [target, "typescript-ast"],
      symbol,
      score: 2,
    };
    found.set(`${line}:${excerpt}`, evidence);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      const clause = node.importClause;
      if (specifier && clause) {
        const imported = [
          clause.name?.text,
          clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined,
          ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.map((item) => item.name.text)
            : []),
        ].filter((value): value is string => Boolean(value));
        if (imported.some((name) => sameSymbol(name, target))) {
          addEvidence(node, `import ${target} from "${specifier}"`, target);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier ? stringLiteralText(node.moduleSpecifier) : undefined;
      const exported = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((item) => item.name.text)
        : [];
      if (exported.some((name) => sameSymbol(name, target))) {
        addEvidence(node, specifier ? `export { ${target} } from "${specifier}"` : `export { ${target} }`, target);
      }
    } else if (isExportedDeclaration(node) && declarationName(node) && sameSymbol(declarationName(node)!, target)) {
      addEvidence(node, `export ${declarationKind(node)} ${target}`, target);
    } else if (ts.isCallExpression(node) && expressionMatchesTarget(node.expression, target)) {
      addEvidence(node, `${target}(...)`, target);
    } else if (ts.isJsxOpeningLikeElement(node) && jsxTagMatchesTarget(node.tagName, target)) {
      addEvidence(node, `<${target}>`, target);
    } else if (ts.isIdentifier(node) && sameSymbol(node.text, target) && !isDeclarationName(node)) {
      addEvidence(node, `${target} reference`, target);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found.values()].slice(0, 20);
}

function scriptKindForPath(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.ts$/i.test(path)) return ts.ScriptKind.TS;
  if (/\.js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

function isScriptPath(path: string): boolean {
  return /\.[cm]?[tj]sx?$/i.test(path);
}

function stringLiteralText(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function sameSymbol(value: string, target: string): boolean {
  return value.toLowerCase() === target.toLowerCase();
}

function isExportedDeclaration(node: ts.Node): node is ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableStatement(node)
  ) && hasExportModifier(node);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function declarationName(node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text;
  const declaration = node.declarationList.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function declarationKind(node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  return "const";
}

function expressionMatchesTarget(expression: ts.Expression, target: string): boolean {
  if (ts.isIdentifier(expression)) return sameSymbol(expression.text, target);
  if (ts.isPropertyAccessExpression(expression)) return sameSymbol(expression.name.text, target);
  return false;
}

function jsxTagMatchesTarget(tagName: ts.JsxTagNameExpression, target: string): boolean {
  if (ts.isIdentifier(tagName)) return sameSymbol(tagName.text, target);
  if (ts.isPropertyAccessExpression(tagName)) return sameSymbol(tagName.name.text, target);
  return false;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
    parent.name === node
  );
}

function summarizeAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s+/g, " ").slice(0, 240) || "Unknown search error";
}

function classifyAttemptError(message: string): RepositorySearchAttemptErrorKind {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("etimedout")) {
    return "timeout";
  }
  if (normalized.includes("cancel") || normalized.includes("abort")) {
    return "cancelled";
  }
  if (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("forbidden") ||
    normalized.includes("eacces") ||
    normalized.includes("eperm")
  ) {
    return "permission";
  }
  if (
    normalized.includes("unavailable") ||
    normalized.includes("not found") ||
    normalized.includes("could not locate") ||
    normalized.includes("enoent") ||
    normalized.includes("spawn")
  ) {
    return "unavailable";
  }
  return "unknown";
}

function uniqueAttempts<T extends { query: string }>(attempts: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const attempt of attempts) {
    const key = attempt.query.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(attempt);
  }
  return output;
}

function createRelativeModulePathCandidates(sourcePath: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const sourceParts = normalizeRepositoryPath(sourcePath).split("/").filter(Boolean);
  sourceParts.pop();
  const specifierParts = specifier.split(/[\\/]+/).filter(Boolean);
  const pathParts = [...sourceParts];
  for (const part of specifierParts) {
    if (part === ".") continue;
    if (part === "..") {
      pathParts.pop();
      continue;
    }
    pathParts.push(part);
  }
  const base = pathParts.join("/");
  if (!base) return [];
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  return uniqueSearchPaths([
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ]);
}

function moduleSpecifierSearchTerm(specifier: string): string {
  const parts = specifier.split(/[\\/]+/).filter(Boolean);
  const clean = parts[parts.length - 1] ?? specifier;
  return clean.replace(/\.[cm]?[tj]sx?$|\.json$/i, "") || specifier;
}

interface TsconfigResolutionConfig {
  configPath: string;
  baseUrl: string;
  paths?: unknown;
  pathsBaseUrl?: string;
}

async function readTsconfigResolutionConfig(
  configPath: string,
  readTextFile: (path: string) => Promise<string>,
  seen: ReadonlySet<string> = new Set(),
): Promise<TsconfigResolutionConfig> {
  const normalizedConfigPath = normalizeRepositoryPath(configPath);
  if (seen.has(normalizedConfigPath)) {
    return {
      configPath: normalizedConfigPath,
      baseUrl: dirnameRepositoryPath(normalizedConfigPath),
    };
  }

  const content = await readTextFile(normalizedConfigPath);
  const parsed = parseTsconfigRecord(normalizedConfigPath, content);
  const configDirectory = dirnameRepositoryPath(normalizedConfigPath);
  const nextSeen = new Set(seen);
  nextSeen.add(normalizedConfigPath);
  const extendedConfig = typeof parsed?.extends === "string"
    ? await readExtendedTsconfigResolutionConfig(parsed.extends, configDirectory, readTextFile, nextSeen)
    : undefined;
  const compilerOptions = isPlainObject(parsed?.compilerOptions) ? parsed.compilerOptions : {};
  const baseUrl = typeof compilerOptions.baseUrl === "string"
    ? joinRepositoryPath(configDirectory, compilerOptions.baseUrl)
    : extendedConfig?.baseUrl ?? configDirectory;
  return {
    configPath: normalizedConfigPath,
    baseUrl,
    paths: compilerOptions.paths ?? extendedConfig?.paths,
    pathsBaseUrl: compilerOptions.paths !== undefined ? baseUrl : extendedConfig?.pathsBaseUrl,
  };
}

async function readExtendedTsconfigResolutionConfig(
  extendsValue: string,
  configDirectory: string,
  readTextFile: (path: string) => Promise<string>,
  seen: ReadonlySet<string>,
): Promise<TsconfigResolutionConfig | undefined> {
  if (!extendsValue.startsWith(".")) return undefined;
  const extendedPath = normalizeRepositoryPath(extendsValue.endsWith(".json")
    ? joinRepositoryPath(configDirectory, extendsValue)
    : joinRepositoryPath(configDirectory, `${extendsValue}.json`));
  try {
    return await readTsconfigResolutionConfig(extendedPath, readTextFile, seen);
  } catch {
    return undefined;
  }
}

function tsconfigCandidatesFromConfig(
  config: TsconfigResolutionConfig,
  specifier: string,
): string[] {
  const pathCandidates = tsconfigPathAliasCandidates(config.pathsBaseUrl ?? config.baseUrl, config.paths, specifier);
  const baseUrlCandidates = pathCandidates.length > 0
    ? []
    : createModulePathCandidates(joinRepositoryPath(config.baseUrl, specifier));
  return uniqueSearchPaths([...pathCandidates, ...baseUrlCandidates]);
}

function resolveModuleSpecifierWithTypeScriptCompiler(
  request: RepositoryModuleResolveRequest,
  config: TsconfigResolutionConfig,
  discoveredPaths: ReadonlyArray<string>,
): string[] {
  const files = new Set(discoveredPaths.map(normalizeRepositoryPath));
  const directories = createDirectorySet(files);
  const paths = isPlainObject(config.paths)
    ? Object.fromEntries(Object.entries(config.paths)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).filter((item): item is string => typeof item === "string")]))
    : undefined;
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    baseUrl: config.paths ? (config.pathsBaseUrl ?? config.baseUrl) : config.baseUrl,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths,
    resolveJsonModule: true,
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => files.has(normalizeRepositoryPath(path)),
    readFile: () => undefined,
    directoryExists: (path) => directories.has(normalizeRepositoryPath(path)),
    realpath: (path) => normalizeRepositoryPath(path),
  };
  const resolved = ts.resolveModuleName(
    request.specifier,
    normalizeRepositoryPath(request.sourcePath),
    compilerOptions,
    host,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return [];
  const normalized = normalizeRepositoryPath(resolved);
  return files.has(normalized) ? [normalized] : [];
}

function tsconfigPathAliasCandidates(
  baseUrl: string,
  pathsValue: unknown,
  specifier: string,
): string[] {
  if (!isPlainObject(pathsValue)) return [];
  return uniqueSearchPaths(Object.entries(pathsValue).flatMap(([pattern, targets]) => {
    const matched = matchTsconfigPathPattern(pattern, specifier);
    if (!matched) return [];
    const targetPatterns = Array.isArray(targets) ? targets : [];
    return targetPatterns
      .filter((target): target is string => typeof target === "string")
      .flatMap((target) => createModulePathCandidates(
        joinRepositoryPath(baseUrl, target.replace(/\*/g, matched.wildcard)),
      ));
  }));
}

function matchTsconfigPathPattern(
  pattern: string,
  specifier: string,
): { wildcard: string } | undefined {
  const starIndex = pattern.indexOf("*");
  if (starIndex < 0) {
    return pattern === specifier ? { wildcard: "" } : undefined;
  }
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return {
    wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
  };
}

function sortConfigPathsForSource(configPaths: string[], sourcePath: string): string[] {
  const sourceDirectory = dirnameRepositoryPath(sourcePath);
  return [...configPaths].sort((left, right) =>
    scoreConfigPathForSource(right, sourceDirectory) - scoreConfigPathForSource(left, sourceDirectory) ||
    left.localeCompare(right));
}

function scoreConfigPathForSource(configPath: string, sourceDirectory: string): number {
  const configDirectory = dirnameRepositoryPath(configPath);
  if (!configDirectory) return 1;
  if (sourceDirectory === configDirectory || sourceDirectory.startsWith(`${configDirectory}/`)) {
    return configDirectory.split("/").filter(Boolean).length + 10;
  }
  return commonPathPrefixLength(configDirectory, sourceDirectory);
}

function commonPathPrefixLength(left: string, right: string): number {
  const leftParts = left.split("/").filter(Boolean);
  const rightParts = right.split("/").filter(Boolean);
  let count = 0;
  while (count < leftParts.length && count < rightParts.length && leftParts[count] === rightParts[count]) {
    count += 1;
  }
  return count;
}

function createDirectorySet(files: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>([""]);
  for (const file of files) {
    let directory = dirnameRepositoryPath(file);
    while (directory) {
      directories.add(directory);
      directory = dirnameRepositoryPath(directory);
    }
  }
  return directories;
}

function createModulePathCandidates(base: string): string[] {
  const normalizedBase = normalizeRepositoryPath(base);
  if (!normalizedBase) return [];
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  return uniqueSearchPaths([
    normalizedBase,
    ...extensions.map((extension) => `${normalizedBase}${extension}`),
    ...extensions.map((extension) => `${normalizedBase}/index${extension}`),
  ]);
}

async function readPackageHints(
  manifestPaths: ReadonlyArray<string>,
  readTextFile: (path: string) => Promise<string>,
): Promise<CodeRepositoryTracePackageHint[]> {
  const hints = await Promise.all(manifestPaths.map(async (manifestPath) => {
    try {
      const content = await readTextFile(manifestPath);
      return packageHintFromManifest(manifestPath, content);
    } catch {
      return undefined;
    }
  }));
  return hints.filter((hint): hint is CodeRepositoryTracePackageHint => Boolean(hint));
}

async function readExternalPackageHints(
  packageName: string,
  evidencePaths: ReadonlyArray<string>,
  readTextFile: (path: string) => Promise<string>,
): Promise<CodeRepositoryTracePackageHint[]> {
  const hints = await Promise.all(evidencePaths.map(async (path) => {
    try {
      const content = await readTextFile(path);
      if (isInstalledPackageManifestPath(path, packageName)) {
        return packageHintFromManifest(path, content);
      }
      if (/package\.json$/i.test(path) && packageManifestDependsOn(content, packageName)) {
        return {
          manifestPath: path,
          name: packageName,
        } satisfies CodeRepositoryTracePackageHint;
      }
      if (isLockfilePath(path) && content.includes(packageName)) {
        return {
          manifestPath: path,
          name: packageName,
        } satisfies CodeRepositoryTracePackageHint;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }));
  return hints.filter((hint): hint is CodeRepositoryTracePackageHint => Boolean(hint));
}

async function readExternalPackageRegistryHints(
  packageName: string,
  specifier: string,
  registry: RepositoryModuleFileSearchResolverOptions["externalPackageRegistry"],
): Promise<CodeRepositoryTracePackageHint[]> {
  if (!registry?.fetch) return [];
  try {
    const registryUrl = registry.registryUrl?.replace(/\/+$/, "") || "https://registry.npmjs.org";
    const response = await registry.fetch(`${registryUrl}/${encodeNpmPackageName(packageName)}`, {
      method: "GET",
      headers: { "accept": "application/json" },
    });
    if (!response.ok) return [];
    const metadata = await response.json() as unknown;
    const hint = packageHintFromRegistryMetadata(packageName, specifier, metadata);
    return hint ? [hint] : [];
  } catch {
    return [];
  }
}

function packageHintFromRegistryMetadata(
  packageName: string,
  specifier: string,
  metadata: unknown,
): CodeRepositoryTracePackageHint | undefined {
  if (!isPlainObject(metadata)) return undefined;
  const versions = isPlainObject(metadata.versions) ? metadata.versions : {};
  const latestVersion = isPlainObject(metadata["dist-tags"]) && typeof metadata["dist-tags"].latest === "string"
    ? metadata["dist-tags"].latest
    : Object.keys(versions).sort().slice(-1)[0];
  const latest = latestVersion && isPlainObject(versions[latestVersion]) ? versions[latestVersion] : metadata;
  const exports = extractPackageExports(latest.exports);
  const subpath = packageSubpathFromSpecifier(packageName, specifier);
  const matchingExports = subpath
    ? exports.filter((item) => item.startsWith(`${subpath}:`) || item.startsWith(`${subpath} (`))
    : exports;
  return {
    manifestPath: `registry:npm/${packageName}`,
    name: typeof latest.name === "string" ? latest.name : packageName,
    ...(typeof latest.main === "string" ? { main: latest.main } : {}),
    ...(typeof latest.module === "string" ? { module: latest.module } : {}),
    ...(typeof latest.types === "string" ? { types: latest.types } : {}),
    ...(typeof latest.typings === "string" && typeof latest.types !== "string" ? { types: latest.typings } : {}),
    ...(matchingExports.length > 0 ? { exports: matchingExports } : {}),
  };
}

function encodeNpmPackageName(packageName: string): string {
  return packageName.startsWith("@") ? packageName.replace("/", "%2F") : encodeURIComponent(packageName);
}

function packageSubpathFromSpecifier(packageName: string, specifier: string): string | undefined {
  const suffix = specifier.slice(packageName.length).replace(/^\/+/, "");
  return suffix ? `./${suffix}` : undefined;
}

function packageHintFromManifest(
  manifestPath: string,
  content: string,
): CodeRepositoryTracePackageHint | undefined {
  const parsed = parseJsonRecord(content);
  if (!parsed) return undefined;
  const exports = extractPackageExports(parsed.exports);
  return {
    manifestPath,
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(typeof parsed.main === "string" ? { main: parsed.main } : {}),
    ...(typeof parsed.module === "string" ? { module: parsed.module } : {}),
    ...(typeof parsed.types === "string" ? { types: parsed.types } : {}),
    ...(typeof parsed.typings === "string" && typeof parsed.types !== "string" ? { types: parsed.typings } : {}),
    ...(exports.length > 0 ? { exports } : {}),
  };
}

function packageManifestDependsOn(content: string, packageName: string): boolean {
  const parsed = parseJsonRecord(content);
  if (!parsed) return false;
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .some((field) => isPlainObject(parsed[field]) && typeof parsed[field][packageName] === "string");
}

function isPackageEvidencePath(path: string): boolean {
  return /(^|\/)package\.json$/i.test(path) || isLockfilePath(path);
}

function isLockfilePath(path: string): boolean {
  return /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/i.test(path);
}

function isInstalledPackageManifestPath(path: string, packageName: string): boolean {
  const normalized = normalizeRepositoryPath(path);
  return normalized === `node_modules/${packageName}/package.json` ||
    normalized.endsWith(`/node_modules/${packageName}/package.json`);
}

function parseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTsconfigRecord(configPath: string, content: string): Record<string, unknown> | undefined {
  const parsed = ts.parseConfigFileTextToJson(configPath, content);
  return isPlainObject(parsed.config) ? parsed.config : undefined;
}

function extractPackageExports(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isPlainObject(value)) return [];
  return Object.entries(value)
    .flatMap(([key, nested]) => {
      if (typeof nested === "string") return [`${key}: ${nested}`];
      if (isPlainObject(nested)) {
        return Object.entries(nested)
          .filter(([, target]) => typeof target === "string")
          .map(([condition, target]) => `${key} (${condition}): ${target}`);
      }
      return [];
    })
    .slice(0, 20);
}

function uniquePackageHints(
  hints: ReadonlyArray<CodeRepositoryTracePackageHint>,
): CodeRepositoryTracePackageHint[] {
  const seen = new Set<string>();
  const output: CodeRepositoryTracePackageHint[] = [];
  for (const hint of hints) {
    const key = hint.manifestPath;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(hint);
  }
  return output;
}

function workspacePackageNameFromSpecifier(specifier: string): string | undefined {
  const parts = specifier.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts[0]?.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  return parts[0];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function dirnameRepositoryPath(path: string): string {
  const normalized = normalizeRepositoryPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function joinRepositoryPath(...parts: string[]): string {
  const output: string[] = [];
  for (const rawPart of parts) {
    const part = normalizeRepositoryPath(rawPart);
    for (const segment of part.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        output.pop();
      } else {
        output.push(segment);
      }
    }
  }
  return output.join("/");
}

function uniqueSearchPaths(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.map((value) => normalizeRepositoryPath(value).trim()).filter(Boolean))].sort();
}

function uniqueProviderSummary(values: ReadonlyArray<string | undefined>): string | undefined {
  const providers = [...new Set(values
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean))];
  return providers.length > 0 ? providers.join(", ") : undefined;
}
