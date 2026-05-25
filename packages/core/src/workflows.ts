import type { AgentKind, PermissionLevel } from "./index";

export type WorkbenchWorkflowId =
  | "read-current-project"
  | "research-trending-topics"
  | "plan-spring-boot-project"
  | "find-local-document"
  | "daily-reminder";

export interface WorkbenchWorkflowStep {
  id: string;
  title: string;
  agentKind: AgentKind;
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
        ["scan-files"],
        true,
      ),
      createStep(
        "analyze-code",
        "Code Agent identifies architecture and key modules",
        "code",
        "File tree, manifests, and repository metadata",
        "Stack, entry points, module map, and notable dependencies",
        "read",
        ["scan-files", "inspect-project"],
        false,
      ),
      createStep(
        "summarize-project",
        "Verifier produces an evidence-backed project summary",
        "verifier",
        "Scan, command, and code analysis outputs",
        "Human-readable summary with evidence and unknowns",
        "read",
        ["analyze-code"],
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
