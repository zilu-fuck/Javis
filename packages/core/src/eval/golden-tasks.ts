import type { CommanderDagPlan } from "../commander-plan-schema";
import type { PlanDiagnosticCode } from "../planning";

/**
 * Golden task set: real user goals paired with the decision the harness must make.
 *
 * The goal of this set is regression protection for the *deterministic* part of the
 * harness — routing, write-intent gating and Commander plan legality — because that
 * is where production failures actually clustered (route collapse, write flows
 * opened for questions, plans that failed the five-layer legality pipeline).
 *
 * It deliberately needs no model provider or credentials, so `pnpm eval` runs
 * anywhere, including CI.
 */

export type GoldenTaskCategory = "routing" | "write-intent" | "plan-legality";

export interface GoldenClassificationExpectation {
  routeLevel?: "L1" | "L2" | "L3";
  textWrite?: boolean;
  planIntents?: Partial<{
    write: boolean;
    export: boolean;
    statistics: boolean;
    retrieval: boolean;
  }>;
}

export interface GoldenPlanExpectation {
  plan: CommanderDagPlan;
  accepted: boolean;
  /** Required diagnostic when `accepted` is false. */
  diagnosticCode?: PlanDiagnosticCode;
  planIntents?: GoldenClassificationExpectation["planIntents"];
}

export interface GoldenTask {
  id: string;
  category: GoldenTaskCategory;
  goal: string;
  expectation: GoldenClassificationExpectation | GoldenPlanExpectation;
  notes?: string;
}

function isPlanExpectation(
  expectation: GoldenClassificationExpectation | GoldenPlanExpectation,
): expectation is GoldenPlanExpectation {
  return (expectation as GoldenPlanExpectation).plan !== undefined;
}

export { isPlanExpectation };

function plan(title: string, steps: CommanderDagPlan["steps"]): CommanderDagPlan {
  return { title, reasoning: `${title} reasoning`, steps };
}

const readStep = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Step ${id}`,
  assignedAgentKind: "code" as const,
  toolName: "code.searchRepository",
  requiredCapabilities: ["code_search"],
  toolInput: { goal: "registry implementation" },
  dependsOn,
  successCriteria: "Evidence is collected.",
});

const writeStep = (id: string, targetPath: string) => ({
  id,
  title: `Write ${targetPath}`,
  assignedAgentKind: "file" as const,
  toolName: "file.writeText",
  requiredCapabilities: ["file_execute"],
  executionMode: "direct_tool_call" as const,
  toolInput: { targetPath, content: "hello" },
  dependsOn: [],
  successCriteria: "File is written.",
});

export const GOLDEN_TASKS: GoldenTask[] = [
  // ---------------------------------------------------------------- routing
  {
    id: "routing-casual-greeting",
    category: "routing",
    goal: "你好",
    expectation: { routeLevel: "L1", textWrite: false },
    notes: "A greeting must never open a workflow or a clarification card.",
  },
  {
    id: "routing-simple-question",
    category: "routing",
    goal: "什么是幂等性？",
    expectation: { routeLevel: "L1", textWrite: false },
  },
  {
    id: "routing-multistep-project-work",
    category: "routing",
    goal: "把整个项目的状态管理从 Context 重构成 Zustand，并补上单元测试",
    expectation: { routeLevel: "L3", textWrite: false },
    notes: "Broad project work must not collapse into a single direct chat answer.",
  },
  {
    id: "routing-repo-understanding",
    category: "routing",
    goal: "这个仓库的目录结构和模块划分是什么样的？",
    expectation: { textWrite: false },
  },
  {
    id: "routing-trend-research",
    category: "routing",
    goal: "总结今天微博热搜前 20 条",
    expectation: { textWrite: false },
  },
  {
    id: "routing-readonly-scan",
    category: "routing",
    goal: "扫描一下我文档目录里的 Markdown 文件",
    expectation: { textWrite: false },
  },

  // ----------------------------------------------------------- write-intent
  {
    id: "write-intent-explicit-chinese",
    category: "write-intent",
    goal: "把这份总结保存到 notes.md",
    expectation: { textWrite: true, planIntents: { write: true } },
  },
  {
    id: "write-intent-explicit-english",
    category: "write-intent",
    goal: "save this summary to notes.md",
    expectation: { textWrite: true, planIntents: { write: true } },
    notes: "English goals must classify the same way as the Chinese equivalent.",
  },
  {
    id: "write-intent-generate-markdown",
    category: "write-intent",
    goal: "生成一份 README.md 的项目说明",
    expectation: { textWrite: true, planIntents: { write: true } },
  },
  {
    id: "write-intent-export-report",
    category: "write-intent",
    goal: "导出这次分析结果到 report.md",
    expectation: { textWrite: true, planIntents: { write: true, export: true } },
  },
  {
    id: "write-intent-question-is-not-a-write",
    category: "write-intent",
    goal: "如何创建一个 HTML 页面？",
    expectation: { textWrite: false },
    notes: "A how-to question must not open a confirmed-write flow.",
  },
  {
    id: "write-intent-review-is-not-a-write",
    category: "write-intent",
    goal: "做一个页面设计评审",
    expectation: { textWrite: false },
  },
  {
    id: "write-intent-explain-script-is-not-a-write",
    category: "write-intent",
    goal: "请解释一下这个脚本的作用",
    expectation: { textWrite: false },
  },
  {
    id: "write-intent-summarize-is-not-a-write",
    category: "write-intent",
    goal: "总结这份文档的主要内容",
    expectation: { textWrite: false },
  },
  {
    id: "write-intent-write-function-is-not-a-file",
    category: "write-intent",
    goal: "write a function that reverses a linked list",
    expectation: { textWrite: false },
    notes: "Code-in-answer requests are not file writes.",
  },

  // -------------------------------------------------------- plan-legality
  {
    id: "plan-legality-minimal-valid-dag",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: { plan: plan("Minimal valid DAG", [readStep("scan")]), accepted: true },
  },
  {
    id: "plan-legality-duplicate-step-id",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Duplicate ids", [readStep("scan"), readStep("scan")]),
      accepted: false,
      diagnosticCode: "DUPLICATE_STEP_ID",
    },
  },
  {
    id: "plan-legality-missing-dependency",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Missing dependency", [readStep("scan", ["nope"])]),
      accepted: false,
      diagnosticCode: "MISSING_DEPENDENCY",
    },
  },
  {
    id: "plan-legality-cyclic-dependency",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Cycle", [readStep("a", ["b"]), readStep("b", ["a"])]),
      accepted: false,
      diagnosticCode: "CYCLIC_DEPENDENCY",
    },
  },
  {
    id: "plan-legality-unknown-agent",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Unknown agent", [{ ...readStep("scan"), assignedAgentKind: "does-not-exist" as never }]),
      accepted: false,
      diagnosticCode: "UNKNOWN_AGENT",
    },
  },
  {
    id: "plan-legality-unknown-tool",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Unknown tool", [{ ...readStep("scan"), toolName: "nope.nope" }]),
      accepted: false,
      diagnosticCode: "UNKNOWN_TOOL",
    },
  },
  {
    id: "plan-legality-tool-not-allowed-for-agent",
    category: "plan-legality",
    goal: "写文件",
    expectation: {
      plan: plan("Tool not allowed", [{ ...writeStep("write", "notes.md"), assignedAgentKind: "code" as never }]),
      accepted: false,
      diagnosticCode: "TOOL_NOT_ALLOWED",
    },
  },
  {
    id: "plan-legality-empty-plan",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: { plan: plan("Empty", []), accepted: false, diagnosticCode: "INVALID_PLAN_SHAPE" },
  },
  {
    id: "plan-legality-unsafe-write-path",
    category: "plan-legality",
    goal: "把结果写入 ../../outside.md",
    expectation: {
      plan: plan("Unsafe path", [writeStep("write", "../../outside.md")]),
      accepted: false,
      planIntents: { write: true },
    },
    notes: "Traversal must never be accepted, regardless of diagnostic wording.",
  },
  {
    id: "plan-legality-write-without-intent",
    category: "plan-legality",
    goal: "这个仓库的目录结构是什么样的？",
    expectation: {
      plan: plan("Write without intent", [writeStep("write", "notes.md")]),
      accepted: false,
      planIntents: { write: false },
    },
  },
  {
    id: "plan-legality-write-with-intent-and-safe-path",
    category: "plan-legality",
    goal: "把总结写入 notes.md",
    expectation: {
      plan: plan("Write with intent", [writeStep("write", "notes.md")]),
      accepted: true,
      planIntents: { write: true },
    },
  },
  {
    id: "plan-legality-invalid-execution-mode",
    category: "plan-legality",
    goal: "搜索仓库里的注册表实现",
    expectation: {
      plan: plan("Bad execution mode", [
        { ...readStep("scan"), executionMode: "bogus" as never },
      ]),
      accepted: false,
    },
  },
  {
    id: "plan-legality-react-without-primary-capability",
    category: "plan-legality",
    goal: "分析并修复这个 bug",
    expectation: {
      plan: plan("React without capability", [
        {
          id: "review-docs",
          title: "Review documentation",
          assignedAgentKind: "doc-updater" as never,
          requiredCapabilities: [],
          dependsOn: [],
          executionMode: "react" as const,
          successCriteria: "Findings are reported.",
        },
      ]),
      accepted: false,
      diagnosticCode: "MISSING_PRIMARY_CAPABILITY",
    },
  },
  {
    id: "write-intent-english-report-noun",
    category: "write-intent",
    goal: "write a report about prompt caching",
    expectation: { textWrite: true },
    notes: "English target nouns must behave like their Chinese equivalents.",
  },
];
