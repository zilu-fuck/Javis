import { invoke } from "@tauri-apps/api/core";
import { createFileScanTaskRuntime } from "@javis/core";
import type {
  CodeApplyResult,
  CodeProposedEdit,
  CodeReviewPreview,
  ComputerFileCandidate,
  CommanderPlanRequest,
  CommanderPlanResult,
  FileOrganizationExecution,
  FileOrganizationPlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
  WebSourceRequest,
  WebSearchRequest,
  WebSearchResult,
  VerifierCheckRequest,
  VerifierCheckResult,
  ScheduledTaskDraft,
} from "@javis/tools";
import { parseGitStatusFiles } from "./git-status";
import { createConfiguredModelProvider, type ModelProvider } from "./model-provider";
import type { ModelSettings } from "./model-settings";
import { scanUserDocuments } from "./local-knowledge";
import {
  createScheduledTask,
  loadScheduledTasks,
  saveScheduledTasks,
} from "./scheduled-tasks";

interface CreateJavisRuntimeOptions {
  getWorkspacePath: () => string;
  modelSettings: ModelSettings;
}

export function createJavisRuntime({
  getWorkspacePath,
  modelSettings,
}: CreateJavisRuntimeOptions) {
  const modelProvider = createConfiguredModelProvider(modelSettings);
  const runReadOnlyCommand = (request: ShellCommandRequest) => {
    const workspacePath = getWorkspacePath();
    return invoke<ShellCommandOutput>("run_read_only_command", {
      request: {
        ...request,
        workspacePath: request.workspacePath ?? (workspacePath.trim() || null),
      },
    });
  };

  return createFileScanTaskRuntime({
    commanderTool: {
      plan: (request) => planWithModelProvider(request, modelProvider),
    },
    fileTool: {
      scanMarkdownDocuments: () => {
        const workspacePath = getWorkspacePath();
        return invoke<MarkdownDocument[]>("scan_markdown_documents", {
          workspacePath: workspacePath.trim() || null,
        });
      },
      planPdfOrganization: () => invoke<FileOrganizationPlan>("plan_pdf_organization"),
      executePdfOrganization: async (
        operations: PlannedPathOperation[],
        approvalId: string,
      ) => {
        await invoke("approve_pdf_organization", { approvalId });
        return invoke<FileOrganizationExecution>("execute_pdf_organization", {
          request: { approvalId, operations },
        });
      },
    },
    computerTool: {
      searchLocalDocuments: async ({ query, maxResults = 20 }) => {
        const entries = await scanUserDocuments(undefined, maxResults);
        return entries
          .filter((entry) => matchesLocalDocumentQuery(entry.name, entry.path, query))
          .slice(0, maxResults)
          .map((entry): ComputerFileCandidate => ({
            name: entry.name,
            path: entry.path,
            isDir: entry.isDir,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt,
            extension: entry.extension,
          }));
      },
    },
    shellTool: {
      runReadOnlyCommand,
    },
    codeTool: {
      inspectRepository: async (): Promise<CodeReviewPreview> => {
        const [status, diffStat, diff] = await Promise.all([
          runReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }),
          runReadOnlyCommand({ program: "git", args: ["diff", "--stat"], workspacePath: null }),
          runReadOnlyCommand({ program: "git", args: ["diff", "--unified=1"], workspacePath: null }),
        ]);

        for (const output of [status, diffStat, diff]) {
          if (output.exitCode !== 0) {
            throw new Error(output.stderr || output.stdout || `${output.command} failed`);
          }
        }

        return {
          workspacePath: status.cwd,
          changedFiles: parseGitStatusFiles(status.stdout),
          diffStat: diffStat.stdout,
          diff: diff.stdout,
        };
      },
      proposeEdit: ({ userGoal, preview }) =>
        proposeCodeEditWithModelProvider(userGoal, preview, modelProvider),
      applyProposedEdit: (edit: CodeProposedEdit, approval) =>
        invoke("approve_code_patch", {
          request: {
            approvalId: approval.approvalId,
            proposalId: edit.proposalId,
            workspacePath: edit.workspacePath,
            changedFiles: edit.changedFiles,
            patchHash: edit.patchHash,
          },
        }).then(() =>
          invoke<CodeApplyResult>("apply_code_patch", {
            request: {
              approvalId: approval.approvalId,
              proposalId: edit.proposalId,
              workspacePath: edit.workspacePath,
              changedFiles: edit.changedFiles,
              patch: edit.patch,
              patchHash: edit.patchHash,
            },
          }),
        ),
    },
    projectTool: {
      inspectProject: () => {
        const workspacePath = getWorkspacePath();
        return invoke<ProjectInspection>("inspect_project", {
          workspacePath: workspacePath.trim() || null,
        });
      },
    },
    schedulerTool: {
      createTask: async (draft: ScheduledTaskDraft) => {
        const workspacePath = getWorkspacePath();
        const task = createScheduledTask(
          {
            name: draft.name,
            goal: draft.goal,
            workspacePath: workspacePath.trim(),
            schedule: draft.schedule,
          },
          "agent",
        );
        saveScheduledTasks(window.localStorage, [
          ...loadScheduledTasks(window.localStorage).filter((item) => item.id !== task.id),
          task,
        ]);
        return {
          id: task.id,
          name: task.name,
          goal: task.goal,
          schedule: task.schedule,
          nextRunAt: task.nextRunAt,
          enabled: task.enabled,
        };
      },
    },
    webTool: {
      fetchWebSource: (request: WebSourceRequest) =>
        invoke<WebSource>("fetch_web_source", { request }),
      searchWeb: (request: WebSearchRequest) =>
        invoke<WebSearchResult[]>("search_web_sources", { request }),
    },
    verifierTool: {
      check: (request) => verifyWithModelProvider(request, modelProvider),
    },
  });
}

function matchesLocalDocumentQuery(name: string, path: string, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}._-]/gu, ""))
    .filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return true;
  }
  const haystack = `${name} ${path}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

async function planWithModelProvider(
  request: CommanderPlanRequest,
  modelProvider: ModelProvider,
): Promise<CommanderPlanResult> {
  const response = await modelProvider.complete(
    [
      "You are Javis Commander Agent. Return JSON only.",
      "Plan the selected workflow using the available agents and tools.",
      "Schema: {\"title\":\"string\",\"reasoning\":\"string\",\"steps\":[{\"id\":\"string\",\"title\":\"string\",\"assignedAgentKind\":\"string\",\"successCriteria\":\"string\"}]}",
      `User goal: ${request.userGoal}`,
      `Workflow id: ${request.workflowId ?? "unknown"}`,
      `Available agents: ${JSON.stringify(request.availableAgents)}`,
    ].join("\n"),
    { maxTokens: 1200, temperature: 0 },
  );
  return normalizeCommanderPlan(parseJsonObject(response.text));
}

async function verifyWithModelProvider(
  request: VerifierCheckRequest,
  modelProvider: ModelProvider,
): Promise<VerifierCheckResult> {
  const response = await modelProvider.complete(
    [
      "You are Javis Verifier Agent. Return JSON only.",
      "Check whether the evidence satisfies the success criteria.",
      "Schema: {\"status\":\"pass|warn|fail\",\"summary\":\"string\",\"detail\":\"string\"}",
      `Step id: ${request.stepId}`,
      `Success criteria: ${request.successCriteria}`,
      `Evidence: ${JSON.stringify(request.evidence)}`,
    ].join("\n"),
    { maxTokens: 900, temperature: 0 },
  );
  return normalizeVerifierCheck(parseJsonObject(response.text));
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeCommanderPlan(value: unknown): CommanderPlanResult {
  if (!isRecord(value)) {
    throw new Error("Commander plan response must be an object.");
  }
  const steps = Array.isArray(value.steps)
    ? value.steps.filter(isRecord).map((step, index) => ({
        id: stringValue(step.id, `step-${index + 1}`),
        title: stringValue(step.title, `Step ${index + 1}`),
        assignedAgentKind: stringValue(step.assignedAgentKind, "commander"),
        successCriteria: stringValue(step.successCriteria, "Step completed with evidence."),
      }))
    : [];
  return {
    title: stringValue(value.title, "Project workflow plan"),
    reasoning: stringValue(value.reasoning, "Commander prepared a workflow plan."),
    steps,
  };
}

function normalizeVerifierCheck(value: unknown): VerifierCheckResult {
  if (!isRecord(value)) {
    throw new Error("Verifier check response must be an object.");
  }
  const status = value.status === "warn" || value.status === "fail" ? value.status : "pass";
  return {
    status,
    summary: stringValue(value.summary, "Evidence checked."),
    detail: stringValue(value.detail, stringValue(value.summary, "Evidence checked.")),
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function proposeCodeEditWithModelProvider(
  userGoal: string,
  preview: CodeReviewPreview,
  modelProvider: ModelProvider,
): Promise<CodeProposedEdit> {
  return invoke<CodeProposedEdit>("propose_code_edit", {
    request: {
      workspacePath: preview.workspacePath,
      userGoal,
      changedFiles: preview.changedFiles,
      diff: preview.diff,
      providerId: modelProvider.settings.provider,
      model: modelProvider.settings.model,
      apiKeyReference: modelProvider.settings.apiKeyReference,
      baseUrl: modelProvider.settings.baseUrl,
      locale: "zh-CN",
    },
  });
}
