import { describe, expect, it, vi } from "vitest";
import {
  createLocalTextSemanticReranker,
  resolveModuleSpecifierWithFileSearch,
  searchRepositoryWithFileSearch,
  traceCallChainWithFileSearch,
  type RepositorySemanticRerankRequest,
} from "./repo-intelligence-service";

describe("searchRepositoryWithFileSearch", () => {
  it("runs planned fallback searches and returns structured evidence", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "agent") {
        return [
          {
            path: "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
            line: 39,
            preview: "Capability score",
            provider: "rg",
          },
        ];
      }
      if (query === "capability score") {
        return [
          {
            path: "packages/core/src/agent-capability.ts",
            line: 206,
            preview: "scoreAgentCapability",
            provider: "rg",
          },
          {
            path: "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
            line: 39,
            preview: "Capability score",
            provider: "ignore",
          },
        ];
      }
      return [];
    });

    const report = await searchRepositoryWithFileSearch({
      goal: "agent capability-score panel",
      knownTerms: ["capability-score"],
      maxAttempts: 8,
    }, { searchFiles });

    expect(searchFiles.mock.calls.map(([request]) => request.query)).toContain("agent");
    expect(searchFiles.mock.calls.map(([request]) => request.query)).toContain("capability score");
    expect(report.actualFound).toHaveLength(2);
    expect(report.attempts.find((attempt) => attempt.query === "agent")?.resultCount).toBe(1);
    expect(report.attempts.find((attempt) => attempt.query === "agent")?.provider).toBe("rg");
    expect(report.attempts.find((attempt) => attempt.query === "capability score")?.resultCount).toBe(2);
    expect(report.attempts.find((attempt) => attempt.query === "capability score")?.provider).toBe("rg, ignore");
    expect(report.keyFiles).toEqual(expect.arrayContaining([
      "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
      "packages/core/src/agent-capability.ts",
    ]));
    expect(report.needsConfirmation).toContain("No related test file was found in the current search results.");
  });

  it("returns explicit confirmation gaps when no files match", async () => {
    const report = await searchRepositoryWithFileSearch({
      goal: "missing concept",
    }, {
      searchFiles: vi.fn(async () => []),
    });

    expect(report.actualFound).toEqual([]);
    expect(report.keyFiles).toEqual([]);
    expect(report.needsConfirmation[0]).toContain("No repository search results were found");
  });

  it("uses priority paths when ranking repository search evidence", async () => {
    const searchFiles = vi.fn(async () => [
      {
        path: "packages/core/src/memory.ts",
        line: 9,
        preview: "export function searchMemory() {}",
        provider: "rg",
      },
      {
        path: "packages/ui/src/MemoryPanel.tsx",
        line: 12,
        preview: "render memory results",
        provider: "rg",
      },
    ]);

    const report = await searchRepositoryWithFileSearch({
      goal: "memory",
      priorityPaths: ["packages/ui/src/MemoryPanel.tsx"],
      maxAttempts: 1,
      maxKeyFiles: 2,
    }, { searchFiles });

    expect(report.keyFiles[0]).toBe("packages/ui/src/MemoryPanel.tsx");
  });

  it("optionally reranks repository evidence with a generic semantic hook", async () => {
    const searchFiles = vi.fn(async () => [
      {
        path: "packages/core/src/memory.ts",
        line: 9,
        preview: "export function searchMemory() {}",
        provider: "rg",
      },
      {
        path: "packages/core/src/agent-memory.ts",
        line: 12,
        preview: "export function recallRelevantContext() {}",
        provider: "rg",
      },
    ]);
    const semanticRerank = vi.fn(async ({ candidates }: RepositorySemanticRerankRequest) => ({
      provider: "local-test-embedding",
      scores: candidates
        .filter((candidate) => candidate.path.endsWith("agent-memory.ts"))
        .map((candidate) => ({
          path: candidate.path,
          line: candidate.line,
          score: 50,
        })),
    }));

    const report = await searchRepositoryWithFileSearch({
      goal: "remember prior agent context",
      maxAttempts: 1,
      maxKeyFiles: 2,
    }, { searchFiles, semanticRerank });

    expect(semanticRerank).toHaveBeenCalledWith({
      query: "remember prior agent context",
      candidates: expect.arrayContaining([
        expect.objectContaining({ path: "packages/core/src/agent-memory.ts" }),
      ]),
    });
    expect(report.keyFiles[0]).toBe("packages/core/src/agent-memory.ts");
    expect(report.semanticDiagnostics).toEqual([expect.objectContaining({
      provider: "local-test-embedding",
      status: "completed",
      candidateCount: 2,
      rerankedCount: 1,
    })]);
  });

  it("falls back to lexical search order when semantic reranking fails", async () => {
    const report = await searchRepositoryWithFileSearch({
      goal: "memory",
      maxAttempts: 1,
    }, {
      searchFiles: vi.fn(async () => [{
        path: "packages/core/src/memory.ts",
        line: 9,
        preview: "export function searchMemory() {}",
        provider: "rg",
      }]),
      semanticRerank: vi.fn(async () => {
        throw new Error("embedding model unavailable");
      }),
    });

    expect(report.actualFound).toHaveLength(1);
    expect(report.semanticDiagnostics).toEqual([expect.objectContaining({
      provider: "semantic-rerank",
      status: "failed",
      candidateCount: 1,
      rerankedCount: 0,
      error: "embedding model unavailable",
    })]);
    expect(report.needsConfirmation).toContain(
      "Semantic reranking failed; repository evidence fell back to lexical search order.",
    );
  });

  it("provides a local text-hash semantic reranker without external services", async () => {
    const rerank = createLocalTextSemanticReranker({ dimensions: 64, weight: 20 });
    const result = await rerank({
      query: "approval restore after restart",
      candidates: [{
        path: "apps/desktop/src/restored-approval.ts",
        line: 12,
        excerpt: "restore approval records after desktop restart",
        matchedTerms: ["restore"],
      }, {
        path: "packages/ui/src/GalleryView.tsx",
        line: 8,
        excerpt: "render image thumbnails",
        matchedTerms: ["gallery"],
      }],
    });

    expect(result.provider).toBe("local-text-hash-embedding");
    expect(result.scores[0]!.score).toBeGreaterThan(result.scores[1]!.score);
  });

  it("records failed attempts and continues with fallback searches", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "agent") {
        throw new Error("search backend unavailable for agent");
      }
      if (query === "memory") {
        return [{
          path: "packages/core/src/memory.ts",
          line: 9,
          preview: "export function searchMemory() {}",
          provider: "ignore",
        }];
      }
      return [];
    });

    const report = await searchRepositoryWithFileSearch({
      goal: "agent memory",
      knownTerms: ["memory"],
      maxAttempts: 4,
    }, { searchFiles });

    expect(report.actualFound).toHaveLength(1);
    expect(report.attempts.find((attempt) => attempt.query === "agent")).toMatchObject({
      status: "failed",
      resultCount: 0,
      retryCount: 1,
      errorKind: "unavailable",
      error: "search backend unavailable for agent",
    });
    expect(report.attempts.find((attempt) => attempt.query === "memory")).toMatchObject({
      status: "completed",
      resultCount: 1,
      retryCount: 0,
      provider: "ignore",
    });
    expect(report.needsConfirmation).toContain(
      "Some repository search attempts failed; inspect attempt errors and fallback attempts before trusting coverage.",
    );
  });

  it("classifies permission search failures", async () => {
    const report = await searchRepositoryWithFileSearch({
      goal: "secret",
      maxAttempts: 1,
    }, {
      maxAttemptRetries: 0,
      searchFiles: vi.fn(async () => {
        throw new Error("Permission denied while reading workspace");
      }),
    });

    expect(report.attempts[0]).toMatchObject({
      query: "secret",
      status: "failed",
      resultCount: 0,
      retryCount: 0,
      errorKind: "permission",
      error: "Permission denied while reading workspace",
    });
  });

  it("retries a failed attempt once and records the retry count when it recovers", async () => {
    const seen = new Map<string, number>();
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      seen.set(query, (seen.get(query) ?? 0) + 1);
      if (query === "memory" && seen.get(query) === 1) {
        throw new Error("temporary rg failure");
      }
      if (query === "memory") {
        return [{
          path: "packages/core/src/memory.ts",
          line: 9,
          preview: "export function searchMemory() {}",
          provider: "rg",
        }];
      }
      return [];
    });

    const report = await searchRepositoryWithFileSearch({
      goal: "memory",
      knownTerms: ["memory"],
      maxAttempts: 1,
    }, { searchFiles });

    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(report.actualFound).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({
      query: "memory",
      status: "completed",
      resultCount: 1,
      retryCount: 1,
      provider: "rg",
    });
    expect(report.attempts[0].error).toBeUndefined();
  });

  it("traces a generic call chain from file-search evidence", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "runTask") {
        return [
          {
            path: "packages/ui/src/TaskPanel.tsx",
            line: 3,
            preview: "import { runTask } from '@javis/core';",
            provider: "rg",
          },
          {
            path: "packages/ui/src/TaskPanel.tsx",
            line: 42,
            preview: "onClick={() => runTask(goal)}",
            provider: "rg",
          },
          {
            path: "packages/core/src/workflow-executor.ts",
            line: 87,
            preview: "export async function runTask(goal: string)",
            provider: "rg",
          },
        ];
      }
      if (query === "TaskPanel") {
        return [
          {
            path: "packages/ui/src/TaskPanel.tsx",
            line: 12,
            preview: "export function TaskPanel()",
            provider: "ignore",
          },
        ];
      }
      return [];
    });

    const report = await traceCallChainWithFileSearch({
      goal: "trace task launch",
      target: "runTask",
      entrypoints: ["TaskPanel"],
      maxAttempts: 6,
    }, { searchFiles });

    expect(searchFiles.mock.calls.map(([request]) => request.query)).toContain("runTask");
    expect(searchFiles.mock.calls.map(([request]) => request.query)).toContain("TaskPanel");
    expect(report.edges.length).toBeGreaterThan(0);
    expect(report.edges.map((edge) => edge.relation)).toContain("imports");
    expect(report.attempts.length).toBeGreaterThan(0);
    expect(report.attempts.find((attempt) => attempt.query === "runTask")?.resultCount).toBe(3);
    expect(report.attempts.find((attempt) => attempt.query === "runTask")?.provider).toBe("rg");
    expect(report.attempts.find((attempt) => attempt.query === "TaskPanel")?.resultCount).toBe(1);
    expect(report.attempts.find((attempt) => attempt.query === "TaskPanel")?.provider).toBe("ignore");
    expect(report.keyFiles).toContain("packages/ui/src/TaskPanel.tsx");
  });

  it("adds TypeScript AST evidence from discovered candidate files", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "runTask") {
        return [{
          path: "packages/ui/src/TaskPanel.tsx",
          line: 1,
          preview: "import { runTask } from '@javis/core';",
          provider: "rg",
        }];
      }
      return [];
    });
    const readTextFile = vi.fn(async () => `
      import { runTask } from '@javis/core';
      export function TaskPanel() {
        return <button onClick={() => runTask("ship it")}>Run</button>;
      }
    `);

    const report = await traceCallChainWithFileSearch({
      goal: "trace task launch",
      target: "runTask",
      maxAttempts: 1,
    }, {
      searchFiles,
      readTextFile,
    });

    expect(readTextFile).toHaveBeenCalledWith("packages/ui/src/TaskPanel.tsx");
    expect(report.actualFound).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "packages/ui/src/TaskPanel.tsx",
        excerpt: "runTask(...)",
        matchedTerms: expect.arrayContaining(["typescript-ast"]),
      }),
    ]));
    expect(report.edges.map((edge) => edge.relation)).toContain("may_call");
  });

  it("adds optional resolver confirmation to module links without project-specific assumptions", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "runTask") {
        return [{
          path: "src/features/TaskPanel.tsx",
          line: 3,
          preview: "import { runTask } from '../core/workflow-executor';",
          provider: "rg",
        }];
      }
      return [];
    });
    const resolveModuleSpecifier = vi.fn((request) =>
      resolveModuleSpecifierWithFileSearch(request, {
        searchFiles: async ({ query }) => query === "workflow-executor"
          ? [{
            path: "src/core/workflow-executor.ts",
            line: 1,
            preview: "export async function runTask() {}",
            provider: "rg",
          }]
          : [],
      }),
    );

    const report = await traceCallChainWithFileSearch({
      goal: "trace task launch",
      target: "runTask",
      maxAttempts: 1,
    }, {
      searchFiles,
      resolveModuleSpecifier,
    });

    expect(resolveModuleSpecifier).toHaveBeenCalledWith({
      sourcePath: "src/features/TaskPanel.tsx",
      specifier: "../core/workflow-executor",
      kind: "relative",
    });
    expect(report.moduleLinks[0]).toMatchObject({
      specifier: "../core/workflow-executor",
      kind: "relative",
      resolutionStatus: "resolved",
      resolvedPaths: ["src/core/workflow-executor.ts"],
      resolverProvider: "rg",
    });
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "file:src/features/TaskPanel.tsx",
        to: "file:src/core/workflow-executor.ts",
        relation: "imports",
      }),
    ]));
  });

  it("expands trace evidence across resolved TypeScript module files", async () => {
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "runTask") {
        return [{
          path: "src/features/TaskPanel.tsx",
          line: 3,
          preview: "import { runTask } from '../core/workflow-executor';",
          provider: "rg",
        }];
      }
      return [];
    });
    const readTextFile = vi.fn(async (path: string) => {
      if (path === "src/features/TaskPanel.tsx") {
        return "import { runTask } from '../core/workflow-executor';\nexport function TaskPanel() { return runTask('goal'); }";
      }
      if (path === "src/core/workflow-executor.ts") {
        return "export function runTask(goal: string) { return goal; }";
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const report = await traceCallChainWithFileSearch({
      goal: "trace task launch",
      target: "runTask",
      maxAttempts: 1,
    }, {
      searchFiles,
      readTextFile,
      resolveModuleSpecifier: (request) =>
        request.specifier === "../core/workflow-executor"
          ? Promise.resolve({
            resolvedPaths: ["src/core/workflow-executor.ts"],
            provider: "test-resolver",
          })
          : Promise.resolve({ resolvedPaths: [], provider: "test-resolver" }),
    });

    expect(readTextFile).toHaveBeenCalledWith("src/core/workflow-executor.ts");
    expect(report.actualFound).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/core/workflow-executor.ts",
        excerpt: "export function runTask",
        matchedTerms: expect.arrayContaining(["typescript-ast"]),
      }),
    ]));
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "symbol:taskpanel",
        to: "symbol:runtask",
        relation: "calls",
        evidencePath: "src/features/TaskPanel.tsx",
      }),
      expect.objectContaining({
        from: "file:src/core/workflow-executor.ts",
        to: "symbol:runtask",
        relation: "exports",
      }),
    ]));
    expect(report.keyFiles).toContain("src/core/workflow-executor.ts");
  });

  it("enriches a bounded project-wide AST symbol graph when script file discovery is available", async () => {
    const files: Record<string, string> = {
      "src/features/TaskPanel.tsx": "import { runTask } from '../core/workflow-executor';\nexport function TaskPanel() { return runTask('goal'); }",
      "src/core/workflow-executor.ts": "export function runTask(goal: string) { return goal; }",
      "src/core/unrelated.ts": "export function ignoreMe() { return undefined; }",
    };
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "TaskPanel") {
        return [{
          path: "src/features/TaskPanel.tsx",
          line: 2,
          preview: "export function TaskPanel() { return runTask('goal'); }",
          provider: "rg",
        }];
      }
      return [];
    });

    const report = await traceCallChainWithFileSearch({
      goal: "trace project graph for task launch",
      target: "runTask",
      entrypoints: ["TaskPanel"],
      maxAttempts: 2,
    }, {
      searchFiles,
      readTextFile: vi.fn(async (path: string) => files[path] ?? ""),
      listScriptFiles: vi.fn(async () => Object.keys(files)),
      maxProjectSymbolFiles: 10,
      resolveModuleSpecifier: (request) =>
        request.specifier === "../core/workflow-executor"
          ? Promise.resolve({
            resolvedPaths: ["src/core/workflow-executor.ts"],
            provider: "test-resolver",
          })
          : Promise.resolve({ resolvedPaths: [], provider: "test-resolver" }),
    });

    expect(report.symbolGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "file:src/features/TaskPanel.tsx", kind: "file" }),
      expect.objectContaining({ id: "file:src/core/workflow-executor.ts", kind: "file" }),
      expect.objectContaining({ id: "symbol:taskpanel", kind: "symbol" }),
      expect.objectContaining({ id: "symbol:runtask", kind: "symbol" }),
    ]));
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "file:src/features/TaskPanel.tsx",
        to: "symbol:runtask",
        relation: "imports",
      }),
      expect.objectContaining({
        from: "symbol:taskpanel",
        to: "symbol:runtask",
        relation: "calls",
      }),
      expect.objectContaining({
        from: "file:src/core/workflow-executor.ts",
        to: "symbol:runtask",
        relation: "exports",
      }),
    ]));
    expect(report.needsConfirmation).not.toContain(expect.stringContaining("Project-wide AST symbol graph was capped"));
  });

  it("uses TypeScript TypeChecker evidence to link calls through barrel exports", async () => {
    const files: Record<string, string> = {
      "src/features/TaskPanel.tsx": "import { runTask } from '../core';\nexport function TaskPanel() { return runTask('goal'); }",
      "src/core/index.ts": "export { runTask } from './workflow-executor';",
      "src/core/workflow-executor.ts": "export function runTask(goal: string) { return goal; }",
    };
    const searchFiles = vi.fn(async ({ query }: { query: string }) => {
      if (query === "TaskPanel") {
        return [{
          path: "src/features/TaskPanel.tsx",
          line: 2,
          preview: "export function TaskPanel() { return runTask('goal'); }",
          provider: "rg",
        }];
      }
      return [];
    });

    const report = await traceCallChainWithFileSearch({
      goal: "trace project graph for task launch",
      target: "runTask",
      entrypoints: ["TaskPanel"],
      maxAttempts: 2,
    }, {
      searchFiles,
      readTextFile: vi.fn(async (path: string) => files[path] ?? ""),
      listScriptFiles: vi.fn(async () => Object.keys(files)),
      maxProjectSymbolFiles: 10,
    });

    expect(report.symbolGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "symbol:runtask",
        path: "src/core/workflow-executor.ts",
      }),
    ]));
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "file:src/features/TaskPanel.tsx",
        to: "symbol:runtask",
        relation: "imports",
      }),
      expect.objectContaining({
        from: "symbol:taskpanel",
        to: "symbol:runtask",
        relation: "calls",
        evidencePath: "src/features/TaskPanel.tsx",
      }),
    ]));
    expect(report.needsConfirmation).not.toContain(expect.stringContaining("TypeScript TypeChecker symbol graph failed"));
  });

  it("records a TypeChecker confirmation gap when project files cannot be read", async () => {
    const report = await traceCallChainWithFileSearch({
      goal: "trace project graph",
      target: "runTask",
      maxAttempts: 1,
    }, {
      searchFiles: vi.fn(async () => []),
      readTextFile: vi.fn(async () => {
        throw new Error("read denied");
      }),
      listScriptFiles: vi.fn(async () => ["src/core/workflow-executor.ts"]),
      maxProjectSymbolFiles: 10,
    });

    expect(report.needsConfirmation).toEqual(expect.arrayContaining([
      expect.stringContaining("TypeScript TypeChecker symbol graph skipped because no project files could be read"),
    ]));
  });

  it("resolves a scoped workspace package specifier to matching package manifests", async () => {
    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "@acme/core/runtime",
      kind: "workspace",
    }, {
      searchFiles: vi.fn(async ({ query }) => query === "@acme/core"
        ? [{
          path: "packages/core/package.json",
          line: 2,
          preview: "\"name\": \"@acme/core\",",
          provider: "rg",
        }, {
          path: "apps/web/src/App.tsx",
          line: 1,
          preview: "import { run } from '@acme/core/runtime';",
          provider: "rg",
        }]
        : []),
      readTextFile: vi.fn(async () => JSON.stringify({
        name: "@acme/core",
        main: "./dist/index.cjs",
        module: "./dist/index.mjs",
        types: "./dist/index.d.ts",
        exports: {
          ".": {
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
          },
          "./runtime": "./dist/runtime.mjs",
        },
      })),
    });

    expect(result).toEqual({
      resolvedPaths: ["packages/core/package.json"],
      provider: "rg",
      packageHints: [{
        manifestPath: "packages/core/package.json",
        name: "@acme/core",
        main: "./dist/index.cjs",
        module: "./dist/index.mjs",
        types: "./dist/index.d.ts",
        exports: [
          ". (import): ./dist/index.mjs",
          ". (require): ./dist/index.cjs",
          "./runtime: ./dist/runtime.mjs",
        ],
      }],
    });
  });

  it("adds local external package manifest hints for third-party specifiers", async () => {
    const readTextFile = vi.fn(async (path: string) => {
      if (path === "package.json") {
        return JSON.stringify({
          dependencies: {
            react: "^19.0.0",
          },
        });
      }
      if (path === "node_modules/react/package.json") {
        return JSON.stringify({
          name: "react",
          main: "./index.js",
          exports: {
            ".": "./index.js",
            "./jsx-runtime": "./jsx-runtime.js",
          },
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "react/jsx-runtime",
      kind: "external",
    }, {
      searchFiles: vi.fn(async ({ query }) => {
        if (query === "tsconfig") return [];
        if (query === "react") {
          return [{
            path: "package.json",
            line: 12,
            preview: "\"react\": \"^19.0.0\"",
            provider: "rg",
          }, {
            path: "node_modules/react/package.json",
            line: 2,
            preview: "\"name\": \"react\"",
            provider: "rg",
          }];
        }
        return [];
      }),
      readTextFile,
    });

    expect(result.provider).toBe("rg, external-package-manifest");
    expect(result.resolvedPaths).toEqual(expect.arrayContaining(["package.json", "node_modules/react/package.json"]));
    expect(result.packageHints).toEqual(expect.arrayContaining([
      {
        manifestPath: "package.json",
        name: "react",
      },
      {
        manifestPath: "node_modules/react/package.json",
        name: "react",
        main: "./index.js",
        exports: [
          ".: ./index.js",
          "./jsx-runtime: ./jsx-runtime.js",
        ],
      },
    ]));
  });

  it("adds external package registry hints for third-party specifiers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => ({
      ok: true,
      json: async () => ({
        "dist-tags": { latest: "19.0.0" },
        versions: {
          "19.0.0": {
            name: "react",
            main: "./index.js",
            exports: {
              ".": "./index.js",
              "./jsx-runtime": "./jsx-runtime.js",
            },
          },
        },
      }),
      url,
      init,
    } as unknown as Response));

    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "react/jsx-runtime",
      kind: "external",
    }, {
      searchFiles: vi.fn(async () => []),
      readTextFile: vi.fn(async () => {
        throw new Error("registry-only test should not read local package evidence");
      }),
      externalPackageRegistry: {
        fetch,
      },
    });

    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/react", {
      method: "GET",
      headers: { "accept": "application/json" },
    });
    expect(result.provider).toBe("npm-registry");
    expect(result.resolvedPaths).toEqual(["registry:npm/react"]);
    expect(result.packageHints).toEqual([{
      manifestPath: "registry:npm/react",
      name: "react",
      main: "./index.js",
      exports: [
        "./jsx-runtime: ./jsx-runtime.js",
      ],
    }]);
  });

  it("encodes scoped external package names when reading registry hints", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ({
      ok: true,
      json: async () => ({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "@scope/pkg",
            types: "./dist/index.d.ts",
          },
        },
      }),
    } as unknown as Response));

    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "@scope/pkg/plugin",
      kind: "external",
    }, {
      searchFiles: vi.fn(async () => []),
      readTextFile: vi.fn(async () => "{}"),
      externalPackageRegistry: {
        fetch,
        registryUrl: "https://registry.example.test/",
      },
    });

    expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.example.test/@scope%2Fpkg");
    expect(result.provider).toBe("npm-registry");
    expect(result.packageHints).toEqual([{
      manifestPath: "registry:npm/@scope/pkg",
      name: "@scope/pkg",
      types: "./dist/index.d.ts",
    }]);
  });

  it("resolves tsconfig paths aliases for non-relative module specifiers", async () => {
    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "@app/components/Button",
      kind: "external",
    }, {
      searchFiles: vi.fn(async ({ query }) => {
        if (query === "tsconfig") {
          return [{
            path: "apps/web/tsconfig.json",
            line: 1,
            preview: "\"compilerOptions\": {",
            provider: "rg",
          }];
        }
        if (query === "Button") {
          return [{
            path: "apps/web/src/components/Button.tsx",
            line: 3,
            preview: "export function Button() {}",
            provider: "rg",
          }];
        }
        return [];
      }),
      readTextFile: vi.fn(async () => JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@app/*": ["src/*"],
          },
        },
      })),
    });

    expect(result).toEqual({
      resolvedPaths: ["apps/web/src/components/Button.tsx"],
      provider: "rg, tsconfig-paths-resolver, typescript-compiler",
    });
  });

  it("uses tsconfig baseUrl as a conservative fallback when no path alias matches", async () => {
    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "shared/runtime",
      kind: "external",
    }, {
      searchFiles: vi.fn(async ({ query }) => {
        if (query === "tsconfig") {
          return [{
            path: "apps/web/tsconfig.json",
            line: 1,
            preview: "\"baseUrl\": \"src\"",
            provider: "rg",
          }];
        }
        if (query === "runtime") {
          return [{
            path: "apps/web/src/shared/runtime.ts",
            line: 1,
            preview: "export const runtime = {};",
            provider: "rg",
          }];
        }
        return [];
      }),
      readTextFile: vi.fn(async () => JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
        },
      })),
    });

    expect(result).toEqual({
      resolvedPaths: ["apps/web/src/shared/runtime.ts"],
      provider: "rg, tsconfig-paths-resolver, typescript-compiler",
    });
  });

  it("resolves aliases inherited through relative tsconfig extends", async () => {
    const readTextFile = vi.fn(async (path: string) => {
      if (path === "apps/web/tsconfig.json") {
        return JSON.stringify({
          extends: "../../tsconfig.base.json",
          compilerOptions: {
            baseUrl: ".",
          },
        });
      }
      if (path === "tsconfig.base.json") {
        return JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@shared/*": ["packages/shared/src/*"],
            },
          },
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });
    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "@shared/runtime",
      kind: "external",
    }, {
      searchFiles: vi.fn(async ({ query }) => {
        if (query === "tsconfig") {
          return [{
            path: "apps/web/tsconfig.json",
            line: 1,
            preview: "\"extends\": \"../../tsconfig.base.json\"",
            provider: "rg",
          }];
        }
        if (query === "runtime") {
          return [{
            path: "packages/shared/src/runtime.ts",
            line: 1,
            preview: "export const runtime = {};",
            provider: "rg",
          }];
        }
        return [];
      }),
      readTextFile,
    });

    expect(result.resolvedPaths).toEqual(["packages/shared/src/runtime.ts"]);
    expect(readTextFile).toHaveBeenCalledWith("apps/web/tsconfig.json");
    expect(readTextFile).toHaveBeenCalledWith("tsconfig.base.json");
  });

  it("prefers the nearest tsconfig when aliases overlap across workspaces", async () => {
    const result = await resolveModuleSpecifierWithFileSearch({
      sourcePath: "apps/web/src/App.tsx",
      specifier: "@app/Button",
      kind: "external",
    }, {
      searchFiles: vi.fn(async ({ query }) => {
        if (query === "tsconfig") {
          return [{
            path: "apps/admin/tsconfig.json",
            line: 1,
            preview: "\"@app/*\": [\"src/admin/*\"]",
            provider: "rg",
          }, {
            path: "apps/web/tsconfig.json",
            line: 1,
            preview: "\"@app/*\": [\"src/web/*\"]",
            provider: "rg",
          }];
        }
        if (query === "Button") {
          return [{
            path: "apps/admin/src/admin/Button.tsx",
            line: 1,
            preview: "export function Button() {}",
            provider: "rg",
          }, {
            path: "apps/web/src/web/Button.tsx",
            line: 1,
            preview: "export function Button() {}",
            provider: "rg",
          }];
        }
        return [];
      }),
      readTextFile: vi.fn(async (path: string) => JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@app/*": [path.includes("apps/web") ? "src/web/*" : "src/admin/*"],
          },
        },
      })),
    });

    expect(result.resolvedPaths).toEqual(["apps/web/src/web/Button.tsx"]);
  });
});
