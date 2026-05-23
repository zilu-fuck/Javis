import type { ID, TaskStep } from "./index";

export function createFileScanPlan(): TaskStep[] {
  return [
    {
      id: "step-scan-markdown",
      title: "File Agent scans workspace Markdown documents",
      assignedAgentKind: "file",
      status: "pending",
      successCriteria: "Return real file paths, modified times, and file sizes.",
    },
    {
      id: "step-summarize",
      title: "Commander summarizes document purpose",
      assignedAgentKind: "commander",
      status: "pending",
      successCriteria: "Each document has a one-line purpose summary.",
    },
    {
      id: "step-verify-docs",
      title: "Verifier checks scan evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result includes verifiable evidence from the file scan.",
    },
  ];
}

export function createProjectInspectionPlan(): TaskStep[] {
  return [
    {
      id: "step-inspect-project",
      title: "Project Tool inspects package scripts",
      assignedAgentKind: "shell",
      status: "pending",
      successCriteria: "Return package manager, scripts, and recommended start/test commands.",
    },
    {
      id: "step-read-env",
      title: "Shell Agent runs read-only environment and test checks",
      assignedAgentKind: "shell",
      status: "pending",
      successCriteria: "Return command, cwd, exit code, stdout, and stderr.",
    },
    {
      id: "step-verify-env",
      title: "Verifier checks command outputs",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result explains whether the environment checks succeeded.",
    },
  ];
}

export function createCodeReviewPlan(): TaskStep[] {
  return [
    {
      id: "step-inspect-code",
      title: "Code Agent inspects repository diff and changed files",
      assignedAgentKind: "code",
      status: "pending",
      successCriteria: "Return changed file names, diff summary, and a readable patch preview.",
    },
    {
      id: "step-review-code",
      title: "User reviews the diff preview and chooses whether to continue",
      assignedAgentKind: "commander",
      status: "pending",
      successCriteria: "Approve or deny the current code review preview.",
    },
    {
      id: "step-verify-code",
      title: "Verifier checks read-only diff evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result explains whether the repository diff was reviewed and checked.",
    },
  ];
}

export function createPdfOrganizationPlan(): TaskStep[] {
  return [
    {
      id: "step-plan-pdf",
      title: "File Agent creates a PDF organization dry-run",
      assignedAgentKind: "file",
      status: "pending",
      successCriteria: "List source paths, target paths, conflicts, and risk summary without moving files.",
    },
    {
      id: "step-confirm-pdf",
      title: "User reviews the confirmed-write permission card",
      assignedAgentKind: "commander",
      status: "pending",
      successCriteria: "Approve or deny only the current dry-run plan.",
    },
    {
      id: "step-execute-pdf",
      title: "File Agent executes approved moves",
      assignedAgentKind: "file",
      status: "pending",
      successCriteria: "Only execute the move operations listed in the approved dry-run.",
    },
    {
      id: "step-verify-pdf",
      title: "Verifier checks permission evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final result states whether approval was recorded and whether files changed.",
    },
  ];
}

export function createResearchSourcePlan(): TaskStep[] {
  return [
    {
      id: "step-fetch-sources",
      title: "Research Agent fetches user-provided source URLs",
      assignedAgentKind: "research",
      status: "pending",
      successCriteria: "Each source returns URL, title or excerpt, and fetched timestamp.",
    },
    {
      id: "step-verify-sources",
      title: "Verifier checks source evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final report only verifies claims with retrievable source excerpts.",
    },
  ];
}

export function createResearchSearchPlan(): TaskStep[] {
  return [
    {
      id: "step-search-sources",
      title: "Research Agent searches public sources",
      assignedAgentKind: "research",
      status: "pending",
      successCriteria: "Return source candidates with URLs, titles, and excerpts.",
    },
    {
      id: "step-fetch-sources",
      title: "Research Agent fetches selected source URLs",
      assignedAgentKind: "research",
      status: "pending",
      successCriteria: "Each selected source returns URL, title or excerpt, and fetched timestamp.",
    },
    {
      id: "step-verify-sources",
      title: "Verifier checks source evidence",
      assignedAgentKind: "verifier",
      status: "pending",
      successCriteria: "Final report only verifies claims with retrievable source excerpts.",
    },
  ];
}

export function markStep(
  steps: TaskStep[],
  firstStepId: ID,
  firstStatus: TaskStep["status"],
  secondStepId?: ID,
  secondStatus?: TaskStep["status"],
): TaskStep[] {
  return steps.map((step) => {
    if (step.id === firstStepId) {
      return { ...step, status: firstStatus };
    }
    if (step.id === secondStepId && secondStatus) {
      return { ...step, status: secondStatus };
    }
    return step;
  });
}
