import type {
  CodeApplyApproval,
  CodeApplyResult,
  CodeProposedEdit,
  CodeTool,
  GitCommitExecutionResult,
  GitCommitPlan,
  GitStageExecutionResult,
  GitStagePlan,
  ShellCommandOutput,
  ShellCommandRequest,
  ShellTool,
} from "@javis/tools";
import { createDefaultAgentRegistry } from "./agents";
import type { AgentKind, TaskStep } from "./index";
import type { WorkspaceRuntime } from "./workspace-runtime";
import { getWorkbenchWorkflow } from "./workflows";

export function workflowStepToTaskStep(
  step: NonNullable<ReturnType<typeof getWorkbenchWorkflow>>["steps"][number],
): TaskStep {
  return {
    id: step.id,
    title: step.title,
    assignedAgentKind: step.agentKind,
    agentId: createDefaultAgentRegistry().findByKind(step.agentKind)?.agent.id ?? `agent-${step.agentKind}`,
    status: "pending",
    successCriteria: step.output,
  };
}

export function runWorkspaceReadOnlyCommand(
  request: ShellCommandRequest,
  shellTool: ShellTool,
  workspaceRuntime?: WorkspaceRuntime,
): Promise<ShellCommandOutput> {
  if (!workspaceRuntime) {
    return shellTool.runReadOnlyCommand(request);
  }
  return workspaceRuntime.execute({
    program: request.program,
    args: request.args,
    cwd: request.workspacePath ?? undefined,
    permissionLevel: "read",
  });
}

export function runProjectReadOnlyCommands(
  shellTool: ShellTool,
  workspaceRuntime?: WorkspaceRuntime,
): Promise<ShellCommandOutput[]> {
  return Promise.all([
    runWorkspaceReadOnlyCommand({ program: "node", args: ["--version"], workspacePath: null }, shellTool, workspaceRuntime),
    runWorkspaceReadOnlyCommand({ program: "pnpm", args: ["--version"], workspacePath: null }, shellTool, workspaceRuntime),
    runWorkspaceReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }, shellTool, workspaceRuntime),
  ]);
}

export function canExecuteWorkspaceWrite(runtime?: WorkspaceRuntime): runtime is WorkspaceRuntime {
  return Boolean(runtime && runtime.kind !== "local");
}

export async function runWorkspaceGitStageCommand(input: {
  runtime: WorkspaceRuntime;
  plan: GitStagePlan;
  paths: string[];
}): Promise<GitStageExecutionResult> {
  const execution = await input.runtime.execute({
    program: "git",
    args: ["add", "--", ...input.paths],
    cwd: input.plan.preview.workspaceRoot || input.runtime.root,
    permissionLevel: "confirmed_write",
  });
  const output = formatWorkspaceCommandOutput(execution);
  if (execution.exitCode !== 0) {
    throw new Error(`git add failed with exit code ${execution.exitCode ?? "unknown"}: ${output || "(no output)"}`);
  }
  return {
    workspacePath: execution.cwd,
    stagedPaths: input.paths,
    fileCount: input.paths.length,
    staged: true,
    output,
  };
}

export async function runWorkspaceGitCommitCommand(input: {
  runtime: WorkspaceRuntime;
  plan: GitCommitPlan;
  message: string;
  paths?: string[];
}): Promise<GitCommitExecutionResult> {
  const stageArgs = input.paths?.length
    ? ["add", "--", ...input.paths]
    : ["add", "-A"];
  const stageExecution = await input.runtime.execute({
    program: "git",
    args: stageArgs,
    cwd: input.plan.preview.workspaceRoot || input.runtime.root,
    permissionLevel: "confirmed_write",
  });
  const stageOutput = formatWorkspaceCommandOutput(stageExecution);
  if (stageExecution.exitCode !== 0) {
    throw new Error(`git add failed with exit code ${stageExecution.exitCode ?? "unknown"}: ${stageOutput || "(no output)"}`);
  }
  const execution = await input.runtime.execute({
    program: "git",
    args: ["commit", "-m", input.message],
    cwd: input.plan.preview.workspaceRoot || input.runtime.root,
    permissionLevel: "confirmed_write",
  });
  const output = formatWorkspaceCommandOutput(execution);
  if (execution.exitCode !== 0) {
    throw new Error(`git commit failed with exit code ${execution.exitCode ?? "unknown"}: ${output || "(no output)"}`);
  }
  const commitHash = execution.stdout.match(/\b[0-9a-f]{7,40}\b/i)?.[0] ?? "";
  return {
    workspacePath: execution.cwd,
    branch: input.plan.preview.branch,
    commitHash,
    subject: input.message,
    fileCount: input.paths?.length ?? input.plan.preview.files.length,
    committed: true,
    output,
  };
}

function formatWorkspaceCommandOutput(execution: ShellCommandOutput): string {
  return [execution.stdout, execution.stderr].filter(Boolean).join("\n");
}

export async function runWorkspaceCodeApplyOperation(input: {
  workspaceRuntime?: WorkspaceRuntime;
  edit: CodeProposedEdit;
  approval: CodeApplyApproval;
  applyProposedEdit: NonNullable<CodeTool["applyProposedEdit"]>;
}): Promise<CodeApplyResult> {
  if (!canExecuteWorkspaceWrite(input.workspaceRuntime)) {
    return input.applyProposedEdit(input.edit, input.approval);
  }
  const snapshot = await input.workspaceRuntime.createSnapshot();
  const result = await input.applyProposedEdit(input.edit, input.approval);
  const diff = await input.workspaceRuntime.diff(snapshot);
  const approvedFiles = new Set(input.edit.changedFiles.map((path) =>
    normalizeWorkspaceRelativePath(path, input.workspaceRuntime!.root),
  ));
  const unexpectedFile = diff.changedFiles.find((file) =>
    !approvedFiles.has(normalizeWorkspaceRelativePath(file.path, input.workspaceRuntime!.root)),
  );
  if (unexpectedFile) {
    throw new Error(`WorkspaceRuntime diff included an unapproved Code patch file: ${unexpectedFile.path}`);
  }
  return result;
}

function normalizeWorkspaceRelativePath(path: string, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

export function formatAgentDisplayName(agentKind: AgentKind): string {
  return createDefaultAgentRegistry().findByKind(agentKind)?.agent.displayName ?? `${agentKind} Agent`;
}

export async function safeInspectRepository(codeTool: CodeTool) {
  try {
    return await codeTool.inspectRepository();
  } catch {
    return undefined;
  }
}

export function markCurrentStepFailed(plan: TaskStep[]): TaskStep[] {
  let marked = false;
  return plan.map((step) => {
    if (!marked && step.status === "running") {
      marked = true;
      return { ...step, status: "failed" };
    }
    if (step.status === "pending") {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}
