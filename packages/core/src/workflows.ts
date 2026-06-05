import type { AgentKind, PermissionLevel } from "./index";
import type { AgentCapabilityTag } from "./agent-capability";

export type WorkbenchWorkflowId =
  | "read-current-project"
  | "research-trending-topics"
  | "plan-spring-boot-project"
  | "find-local-document"
  | "daily-reminder"
  | "scan-workspace-documents"
  | "browser-research"
  | "browser-test"
  | "pdf-organization"
  | "code-review"
  | "computer-use";

export interface WorkbenchWorkflowStep {
  id: string;
  title: string;
  agentKind: AgentKind;
  /** Capability-based dispatch: if set, executor is found by tag instead of agentKind */
  requiredCapabilities?: AgentCapabilityTag[];
  input: string;
  output: string;
  permissionLevel: PermissionLevel;
  dependsOn: string[];
  canRunInParallel: boolean;
}

export interface WorkbenchWorkflow {
  id: WorkbenchWorkflowId;
  title: string;
  triggerExamples: string[];
  goal: string;
  coordinatorAgentKind: Extract<AgentKind, "commander">;
  participatingAgentKinds: AgentKind[];
  steps: WorkbenchWorkflowStep[];
  currentSupport: "implemented" | "partial" | "planned";
  safetyNotes: string[];
}

export const WORKBENCH_WORKFLOWS: WorkbenchWorkflow[] = [
  {
    id: "read-current-project",
    title: "Read current project",
    triggerExamples: [
      "\u9605\u8bfb\u5f53\u524d\u9879\u76ee",
      "\u5e2e\u6211\u7406\u89e3\u8fd9\u4e2a\u9879\u76ee",
      "inspect this project",
    ],
    goal: "Understand the local project's structure, stack, entry points, and verification commands.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "file", "shell", "code", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Only read project files and allowlisted environment commands.",
      "Do not modify files while building the project summary.",
    ],
    steps: [
      createStep(
        "scan-files",
        "File Agent scans project files and important manifests",
        "file",
        "Selected workspace path",
        "File tree, Markdown summaries, and manifest candidates",
        "read",
        [],
        true,
      ),
      createStep(
        "inspect-project",
        "Shell Agent inspects package scripts and environment",
        "shell",
        "Workspace manifests and allowlisted commands",
        "Package manager, scripts, start/test commands, and command outputs",
        "read",
        [],
        true,
      ),
      createStep(
        "analyze-code",
        "Code Agent identifies architecture and key modules",
        "code",
        "File tree, manifests, and repository metadata",
        "Stack, entry points, module map, and notable dependencies",
        "read",
        [],
        true,
      ),
      createStep(
        "summarize-project",
        "Verifier produces an evidence-backed project summary",
        "verifier",
        "Scan, command, and code analysis outputs",
        "Human-readable summary with evidence and unknowns",
        "read",
        ["scan-files", "inspect-project", "analyze-code"],
        false,
      ),
      createStep(
        "commander-synthesize",
        "Commander writes a user-facing conclusion from all collected evidence",
        "commander",
        "All step outputs and verification results",
        "Natural-language answer to the user's original goal",
        "read",
        ["summarize-project"],
        false,
      ),
    ],
  },
  {
    id: "research-trending-topics",
    title: "Research trending topics",
    triggerExamples: [
      "\u67e5\u4e00\u4e0b\u6700\u8fd1\u7684\u70ed\u641c",
      "\u4eca\u5929\u6709\u4ec0\u4e48\u70ed\u70b9",
      "latest trending topics",
    ],
    goal: "Collect current public trending topics, deduplicate them, and summarize the top items.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "research", "browser", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Use public sources only.",
      "Label provider, fetched time, and unverifiable claims.",
    ],
    steps: [
      createStep(
        "search-trends",
        "Research Agent queries public trend/search sources",
        "research",
        "Topic request and locale",
        "Candidate trend items with source URLs and excerpts",
        "read",
        [],
        true,
      ),
      createStep(
        "fetch-details",
        "Browser or Research Agent fetches selected public detail pages",
        "browser",
        "Top candidate links",
        "Page titles, excerpts, and fetch evidence",
        "read",
        ["search-trends"],
        true,
      ),
      createStep(
        "merge-trends",
        "Verifier deduplicates and ranks related topics",
        "verifier",
        "Search and fetch outputs",
        "Ranked brief with source-backed summaries",
        "read",
        ["fetch-details"],
        false,
      ),
    ],
  },
  {
    id: "plan-spring-boot-project",
    title: "Plan a Spring Boot project",
    triggerExamples: [
      "\u6211\u8981\u5199\u4e00\u4e2a Spring Boot \u7684\u9879\u76ee",
      "how do I start a Spring Boot app",
    ],
    goal: "Clarify requirements, retrieve current guidance, and produce a build plan with example code.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "research", "code", "verifier"],
    currentSupport: "planned",
    safetyNotes: [
      "Ask before creating files or running generators.",
      "Use official or source-backed guidance for version-sensitive choices.",
    ],
    steps: [
      createStep(
        "clarify-requirements",
        "Commander clarifies project type, database, and deployment assumptions",
        "commander",
        "User goal",
        "Scoped Spring Boot requirements",
        "read",
        [],
        false,
      ),
      createStep(
        "retrieve-guidance",
        "Research Agent checks current Spring Boot setup guidance",
        "research",
        "Scoped requirements",
        "Source-backed setup notes and dependency choices",
        "read",
        ["clarify-requirements"],
        true,
      ),
      createStep(
        "generate-plan",
        "Code Agent drafts project steps and example snippets",
        "code",
        "Requirements and guidance",
        "Step-by-step plan with Controller, Service, Repository, and config examples",
        "preview",
        ["retrieve-guidance"],
        false,
      ),
      createStep(
        "verify-guide",
        "Verifier checks that commands and code snippets match the stated stack",
        "verifier",
        "Generated plan",
        "Verified guide with caveats and next actions",
        "read",
        ["generate-plan"],
        false,
      ),
    ],
  },
  {
    id: "find-local-document",
    title: "Find a local document",
    triggerExamples: [
      "\u5e2e\u6211\u67e5\u627e\u7535\u8111\u4e2d\u7684 2024\u5e74\u8d22\u52a1\u62a5\u544a",
      "find my local document",
    ],
    goal: "Locate local files by name, keyword, type, date range, and relevance.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "computer", "file", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Search and preview metadata only until the user opens a result.",
      "Opening or revealing sensitive files remains a user-visible action.",
    ],
    steps: [
      createStep(
        "parse-query",
        "Commander extracts filename, keywords, type, and time hints",
        "commander",
        "User search request",
        "Structured local search query",
        "read",
        [],
        false,
      ),
      createStep(
        "search-computer",
        "Computer Agent searches indexed local locations",
        "computer",
        "Structured search query",
        "Candidate paths with metadata",
        "read",
        ["parse-query"],
        true,
      ),
      createStep(
        "rank-results",
        "Verifier ranks matches by relevance and recency",
        "verifier",
        "Candidate paths",
        "Ranked result list with open/reveal actions",
        "read",
        ["search-computer"],
        false,
      ),
    ],
  },
  {
    id: "daily-reminder",
    title: "Create a daily reminder",
    triggerExamples: [
      "\u6bcf\u5929\u4e0a\u5348 8 \u70b9\u63d0\u9192\u6211\u5403\u836f",
      "remind me every day at 8",
    ],
    goal: "Create a durable local reminder and trigger user-visible notifications on schedule.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "scheduler", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Persist only the reminder text, schedule, enabled state, and run metadata.",
      "Changing local scheduled state should be visible and reversible.",
    ],
    steps: [
      createStep(
        "parse-schedule",
        "Commander parses reminder text, time, and recurrence",
        "commander",
        "User reminder request",
        "Reminder title and schedule rule",
        "read",
        [],
        false,
      ),
      createStep(
        "persist-reminder",
        "Scheduler Agent stores and registers the reminder",
        "scheduler",
        "Reminder title and schedule rule",
        "Durable scheduled task record",
        "confirmed_write",
        ["parse-schedule"],
        false,
      ),
      createStep(
        "verify-reminder",
        "Verifier confirms the next run time and enabled state",
        "verifier",
        "Scheduled task record",
        "Confirmation with next run time",
        "read",
        ["persist-reminder"],
        false,
      ),
    ],
  },
  {
    id: "scan-workspace-documents",
    title: "Scan workspace documents",
    triggerExamples: [
      "scan my workspace documents",
      "find markdown files in this project",
      "扫描工作区文档",
      "查找项目中的文档",
    ],
    goal: "Scan the current workspace for Markdown and user documents, classify them, and produce a structured summary.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "file", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "All scanning is read-only.",
      "File paths and metadata are collected without modifying any files.",
    ],
    steps: [
      createStep(
        "scan-documents",
        "File Agent scans Markdown and user documents in the workspace",
        "file",
        "Workspace path and scan parameters",
        "Document list with paths, metadata, and excerpts",
        "read",
        [],
        true,
      ),
      createStep(
        "classify-documents",
        "File Agent classifies scanned documents by type and purpose",
        "file",
        "Scanned document list",
        "Categorized document index with tags and confidence scores",
        "read",
        ["scan-documents"],
        false,
      ),
      createStep(
        "verify-scan",
        "Verifier checks scan completeness and categorization quality",
        "verifier",
        "Categorized document index",
        "Verification summary with coverage and quality assessment",
        "read",
        ["classify-documents"],
        false,
      ),
      createStep(
        "commander-synthesize",
        "Commander writes a user-facing summary of the document scan",
        "commander",
        "All scan and verification outputs",
        "Natural-language summary of workspace documents",
        "read",
        ["verify-scan"],
        false,
      ),
    ],
  },
  {
    id: "browser-research",
    title: "Browser research",
    triggerExamples: [
      "open this page and extract the content",
      "browse the website and take a screenshot",
      "打开这个网页提取内容",
    ],
    goal: "Navigate to web pages, extract content, and collect evidence through browser automation.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "browser", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Read-only browser operations (navigate, screenshot, getContent) are safe.",
      "Click/type/evaluate operations require confirmed-write approval.",
      "Never automate account-changing actions.",
    ],
    steps: [
      createStep(
        "navigate-page",
        "Browser Agent navigates to the target URL",
        "browser",
        "Target URL from user goal",
        "Page title, URL, and load status",
        "read",
        [],
        false,
      ),
      createStep(
        "extract-content",
        "Browser Agent extracts page content and takes screenshot",
        "browser",
        "Loaded page",
        "Page text/HTML content and screenshot",
        "read",
        ["navigate-page"],
        false,
      ),
      createStep(
        "verify-extraction",
        "Verifier checks extracted content completeness",
        "verifier",
        "Extracted content and screenshot",
        "Verification of content quality and completeness",
        "read",
        ["extract-content"],
        false,
      ),
    ],
  },
  {
    id: "browser-test",
    title: "Run Playwright tests",
    triggerExamples: [
      "run playwright tests for this project",
      "generate and run e2e tests",
      "运行 Playwright 测试",
    ],
    goal: "Generate or run Playwright test scripts for the user's project.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "browser", "code", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Test execution is confirmed_write — scripts may contain page interactions.",
      "Test script generation requires code agent proposal flow.",
    ],
    steps: [
      createStep(
        "inspect-project",
        "Code Agent inspects project for test setup",
        "code",
        "Workspace path",
        "Existing test configuration and Playwright setup",
        "read",
        [],
        false,
      ),
      createStep(
        "run-tests",
        "Browser Agent runs Playwright test scripts",
        "browser",
        "Test script or existing test files",
        "Test results with pass/fail status",
        "confirmed_write",
        ["inspect-project"],
        false,
      ),
      createStep(
        "verify-results",
        "Verifier summarizes test results",
        "verifier",
        "Test execution output",
        "Test summary with pass/fail counts and failure details",
        "read",
        ["run-tests"],
        false,
      ),
    ],
  },
  {
    id: "pdf-organization",
    title: "Organize PDF files",
    triggerExamples: [
      "organize my PDFs",
      "sort downloaded PDFs by type",
      "整理我的 PDF 文件",
      "按类型分类下载的 PDF",
    ],
    goal: "Scan the Downloads folder for PDF files, classify them by content type, and organize them into folders.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "file", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "PDF operations are Downloads-scoped and move-only.",
      "Every organization plan requires user approval before execution.",
      "One-time approval — each approval is consumed after use.",
    ],
    steps: [
      createStep(
        "scan-pdfs",
        "File Agent scans Downloads for PDF files",
        "file",
        "Downloads folder path",
        "List of PDF files with metadata",
        "read",
        [],
        true,
      ),
      createStep(
        "classify-pdfs",
        "File Agent classifies PDFs by content type",
        "file",
        "Scanned PDF list",
        "Categorized PDF groups with suggested target folders",
        "read",
        ["scan-pdfs"],
        false,
      ),
      createStep(
        "preview-organization",
        "Commander presents the organization plan for user approval",
        "commander",
        "Categorized PDF groups",
        "Approved organization plan ready for execution",
        "preview",
        ["classify-pdfs"],
        false,
      ),
      createStep(
        "verify-organization",
        "Verifier checks the organization plan is safe and complete",
        "verifier",
        "Organization plan",
        "Verification summary with safety assessment",
        "read",
        ["preview-organization"],
        false,
      ),
    ],
  },
  {
    id: "code-review",
    title: "Review code changes",
    triggerExamples: [
      "review my changes",
      "code review this diff",
      "审查代码变更",
      "检查改动",
    ],
    goal: "Inspect changed files, analyze the diff, and produce a structured code review with findings and suggestions.",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "code", "verifier"],
    currentSupport: "partial",
    safetyNotes: [
      "Code review is read-only — no files are modified.",
      "All findings and suggestions are presented for user review.",
      "Code proposal/approval flow is a separate confirmed-write path.",
    ],
    steps: [
      createStep(
        "inspect-changes",
        "Code Agent inspects changed files and diff",
        "code",
        "Workspace path and git diff",
        "Changed file list with diff summary",
        "read",
        [],
        true,
      ),
      createStep(
        "review-diff",
        "Code Agent analyzes the diff for issues",
        "code",
        "Changed files and diff content",
        "Structured code review with findings by severity",
        "read",
        ["inspect-changes"],
        false,
      ),
      createStep(
        "verify-review",
        "Verifier checks review completeness and quality",
        "verifier",
        "Code review findings",
        "Verification of review coverage and actionable items",
        "read",
        ["review-diff"],
        false,
      ),
    ],
  },
  {
    id: "computer-use",
    title: "桌面自动化操控",
    triggerExamples: [
      "open the calculator",
      "打开计算器",
      "open VS Code and check settings",
      "操控桌面打开 Chrome",
      "click the Start menu and search for Notepad",
    ],
    goal: "通过桌面/窗口截图和控件结构理解界面，并使用鼠标、键盘或 UIA 控件操作完成用户目标。",
    coordinatorAgentKind: "commander",
    participatingAgentKinds: ["commander", "computer", "verifier"],
    currentSupport: "planned",
    safetyNotes: [
      "所有写入型桌面操作（点击、输入、组合键、滚动、聚焦窗口、调用控件、设置控件值）都需要用户确认。",
      "危险窗口（任务管理器、注册表编辑器、UAC）会在 Rust 层被拦截。",
      "危险组合键（Win+R、Ctrl+Alt+Del、Alt+F4）会在 Rust 层被拦截。",
      "截图数据只保存在内存中，不写入磁盘或日志。",
      "审批记录 5 分钟后过期，避免旧授权被复用。",
    ],
    steps: [
      createStep(
        "analyze-desktop",
        "Commander and Computer Agent analyze the goal and take initial screenshot",
        "computer",
        "User goal description",
        "Desktop state analysis with initial screenshot",
        "read",
        [],
        false,
      ),
      createStep(
        "execute-actions",
        "Computer Agent executes actions in a screenshot→analyze→act loop",
        "computer",
        "Desktop state analysis and user goal",
        "Completed action sequence with final screenshot",
        "confirmed_write",
        ["analyze-desktop"],
        false,
      ),
      createStep(
        "verify-outcome",
        "Verifier checks the final desktop state against the user goal",
        "verifier",
        "Action sequence and final screenshot",
        "Verification summary confirming goal achievement",
        "read",
        ["execute-actions"],
        false,
      ),
    ],
  },
];

export function listWorkbenchWorkflows(): WorkbenchWorkflow[] {
  return WORKBENCH_WORKFLOWS.map((workflow) => ({
    ...workflow,
    participatingAgentKinds: [...workflow.participatingAgentKinds],
    safetyNotes: [...workflow.safetyNotes],
    steps: workflow.steps.map((step) => ({
      ...step,
      dependsOn: [...step.dependsOn],
    })),
    triggerExamples: [...workflow.triggerExamples],
  }));
}

export function getWorkbenchWorkflow(id: WorkbenchWorkflowId): WorkbenchWorkflow | undefined {
  return listWorkbenchWorkflows().find((workflow) => workflow.id === id);
}

function createStep(
  id: string,
  title: string,
  agentKind: AgentKind,
  input: string,
  output: string,
  permissionLevel: PermissionLevel,
  dependsOn: string[],
  canRunInParallel: boolean,
): WorkbenchWorkflowStep {
  return {
    id,
    title,
    agentKind,
    input,
    output,
    permissionLevel,
    dependsOn,
    canRunInParallel,
  };
}
