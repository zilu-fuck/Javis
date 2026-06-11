import { describe, expect, it } from "vitest";
import {
  buildRepositorySearchEvidenceReport,
  buildRepositoryTraceEvidenceReport,
  clusterRepositorySearchResults,
  createRepositorySearchPlan,
  type RepositorySearchResult,
  type RepositoryTraceEvidence,
} from "./repo-intelligence";

describe("repo intelligence", () => {
  it("creates direct and fallback search attempts from an uncertain goal", () => {
    const plan = createRepositorySearchPlan({
      goal: "This bug may be in the Agent detail score panel",
      knownTerms: ["capability-score"],
      entryFile: "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
      maxAttempts: 12,
    });

    expect(plan.normalizedGoal).toBe("this bug may be in the agent detail score panel");
    expect(plan.attempts.map((attempt) => attempt.query)).toContain("agent");
    expect(plan.attempts.map((attempt) => attempt.query)).toContain("capability");
    expect(plan.fallbackTerms).toContain("capability score");
    expect(plan.conceptTerms).toContain("agent detail");
    expect(plan.attempts.some((attempt) => attempt.reason.includes("fallback"))).toBe(true);
  });

  it("adds generic concept attempts for multilingual and phrase-heavy goals", () => {
    const plan = createRepositorySearchPlan({
      goal: "这个 bug 可能在任务历史恢复删除入口，不一定叫这个名字",
      knownTerms: ["task history restore delete"],
      maxAttempts: 20,
    });

    expect(plan.conceptTerms).toEqual(expect.arrayContaining([
      "任务历史",
      "历史恢复",
      "恢复删除",
      "task history",
      "history restore",
    ]));
    expect(plan.attempts.some((attempt) =>
      attempt.query === "任务历史" &&
      attempt.reason === "concept phrase from goal or known context",
    )).toBe(true);
  });

  it("clusters search results by workspace area", () => {
    const clusters = clusterRepositorySearchResults([
      result("packages/ui/src/components/InspectorPanel.tsx", ["inspector"]),
      result("packages/ui/src/components/inspector/AgentDetailPanel.tsx", ["agent", "inspector"]),
      result("packages/core/src/agent-capability.ts", ["agent"]),
      result("apps/desktop/src/App.tsx", ["agent"]),
    ]);

    expect(clusters[0].id).toBe("packages/ui");
    expect(clusters.map((cluster) => cluster.id).sort()).toEqual([
      "apps/desktop",
      "packages/core",
      "packages/ui",
    ]);
    expect(clusters[0]).toMatchObject({
      resultCount: 2,
      paths: [
        "packages/ui/src/components/InspectorPanel.tsx",
        "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
      ],
    });
  });

  it("separates actual evidence, inferences, missing confirmations, and key files", () => {
    const report = buildRepositorySearchEvidenceReport([
      result("packages/ui/src/components/inspector/AgentDetailPanel.tsx", ["agent", "score"], 20, 4),
      result("packages/core/src/agent-capability.ts", ["agent", "score"], 206, 3),
      result("packages/ui/src/index.test.tsx", ["agent", "score"], 925, 1),
      result("docs/PRODUCT_READINESS.md", ["score"], 28, 0.5),
    ]);

    expect(report.actualFound).toHaveLength(4);
    expect(report.keyFiles).toEqual([
      "packages/ui/src/components/inspector/AgentDetailPanel.tsx",
      "packages/core/src/agent-capability.ts",
      "packages/ui/src/index.test.tsx",
    ]);
    expect(report.relatedTestFiles).toEqual(["packages/ui/src/index.test.tsx"]);
    expect(report.testFileCandidates).toEqual(expect.arrayContaining([
      "packages/ui/src/components/inspector/AgentDetailPanel.test.tsx",
      "packages/core/src/agent-capability.test.ts",
    ]));
    expect(report.inferred[0]).toContain("packages/ui");
    expect(report.needsConfirmation).toEqual([]);
  });

  it("records missing evidence when search returns no results", () => {
    const report = buildRepositorySearchEvidenceReport([]);

    expect(report.actualFound).toEqual([]);
    expect(report.keyFiles).toEqual([]);
    expect(report.relatedTestFiles).toEqual([]);
    expect(report.testFileCandidates).toEqual([]);
    expect(report.needsConfirmation).toContain(
      "No repository search results were found; try fallback terms or inspect the architecture manually.",
    );
  });

  it("prioritizes caller-provided paths without inventing evidence", () => {
    const report = buildRepositorySearchEvidenceReport([
      result("packages/core/src/memory.ts", ["memory"], 10, 5),
      result("packages/ui/src/MemoryPanel.tsx", ["memory"], 12, 1),
    ], {
      priorityPaths: ["packages/ui/src/MemoryPanel.tsx"],
      maxKeyFiles: 2,
    });

    expect(report.actualFound.map((item) => item.path)).toEqual([
      "packages/ui/src/MemoryPanel.tsx",
      "packages/core/src/memory.ts",
    ]);
    expect(report.keyFiles).toEqual([
      "packages/ui/src/MemoryPanel.tsx",
      "packages/core/src/memory.ts",
    ]);
  });

  it("builds a generic trace evidence report without framework-specific assumptions", () => {
    const report = buildRepositoryTraceEvidenceReport([
      trace("packages/ui/src/TaskPanel.tsx", "onClick={() => runTask(goal)}", ["runTask"], 42, "TaskPanel"),
      trace("packages/core/src/workflow-executor.ts", "export async function runTask(goal: string)", ["runTask"], 87),
      trace("apps/desktop/src/app-runtime.ts", "invoke('start_task', { goal })", ["start_task"], 131),
    ], {
      goal: "trace UI task start to runtime",
      target: "runTask",
      entrypoints: ["packages/ui/src/TaskPanel.tsx"],
      direction: "forward",
      maxEdges: 5,
    });

    expect(report.target).toBe("runTask");
    expect(report.nodes.some((node) => node.kind === "target" && node.symbol === "runTask")).toBe(true);
    expect(report.edges.length).toBeGreaterThan(0);
    expect(report.keyFiles).toEqual(expect.arrayContaining([
      "packages/ui/src/TaskPanel.tsx",
      "packages/core/src/workflow-executor.ts",
    ]));
    expect(report.symbolGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "file:packages/ui/src/TaskPanel.tsx", kind: "file" }),
      expect.objectContaining({ id: "file:packages/core/src/workflow-executor.ts", kind: "file" }),
      expect.objectContaining({ id: "symbol:taskpanel", kind: "symbol", symbol: "TaskPanel" }),
      expect.objectContaining({ id: "symbol:runtask", kind: "symbol", symbol: "runTask" }),
    ]));
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "file:packages/ui/src/TaskPanel.tsx",
        to: "symbol:taskpanel",
        relation: "calls",
      }),
      expect.objectContaining({
        from: "file:packages/core/src/workflow-executor.ts",
        to: "symbol:runtask",
        relation: "exports",
      }),
    ]));
    expect(report.needsConfirmation).toContain(
      "Some edges are text-search candidates and need AST, runtime trace, or manual confirmation.",
    );
  });

  it("classifies import and export evidence as generic trace relations", () => {
    const report = buildRepositoryTraceEvidenceReport([
      trace("packages/ui/src/TaskPanel.tsx", "import { runTask } from '@javis/core';", ["runTask"], 4),
      trace("packages/core/src/workflow-executor.ts", "export async function runTask(goal: string)", ["runTask"], 87),
    ], {
      goal: "trace imported task launcher",
      target: "runTask",
      workspaceModulePrefixes: ["@javis/"],
      direction: "forward",
      maxEdges: 4,
    });

    expect(report.edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining(["imports", "exports"]));
    expect(report.edges.find((edge) => edge.relation === "imports")?.confidence).toBe(0.8);
    expect(report.edges.find((edge) => edge.relation === "imports")?.moduleSpecifier).toBe("@javis/core");
    expect(report.edges.find((edge) => edge.relation === "imports")?.moduleKind).toBe("workspace");
    expect(report.edges.find((edge) => edge.relation === "exports")?.confidence).toBe(0.8);
    expect(report.symbolGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: "imports",
        evidencePath: "packages/ui/src/TaskPanel.tsx",
      }),
      expect.objectContaining({
        relation: "exports",
        evidencePath: "packages/core/src/workflow-executor.ts",
      }),
    ]));
    expect(report.moduleLinks).toEqual([{
      specifier: "@javis/core",
      kind: "workspace",
      evidencePaths: ["packages/ui/src/TaskPanel.tsx"],
      importCount: 1,
      exportCount: 0,
      dynamicImportCount: 0,
      confidence: 0.8,
    }]);
    expect(report.needsConfirmation).toContain(
      "Module links are inferred from text import/export evidence and need package graph or resolver confirmation.",
    );
  });
});

function result(
  path: string,
  matchedTerms: string[],
  line?: number,
  score?: number,
): RepositorySearchResult {
  return {
    path,
    line,
    excerpt: `${path} contains ${matchedTerms.join(", ")}`,
    matchedTerms,
    score,
  };
}

function trace(
  path: string,
  excerpt: string,
  matchedTerms: string[],
  line?: number,
  symbol?: string,
): RepositoryTraceEvidence {
  return {
    path,
    line,
    excerpt,
    matchedTerms,
    symbol,
  };
}
