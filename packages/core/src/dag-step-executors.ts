/**
 * DAG step executors for approval-gated write tools.
 *
 * Extracted from `workflow-executor.ts`, which had grown past 14,800 lines. The moved set
 * is the union of these functions' transitive closures, computed by
 * `scripts/analyze-extraction.mjs` rather than chosen by eye — an earlier attempt moved a
 * hand-picked set and failed on the dependencies it had missed.
 *
 * Behaviour is unchanged: the declarations were relocated verbatim and the original module
 * imports them back.
 */
import {
  createAgentStateTracker,
} from "./agent-state-tracker";
import {
  type CommanderDagStep,
} from "./commander-plan-schema";
import {
  type AgentKind,
  type TaskSnapshot,
} from "./index";
import {
  type PermissionDecision,
  createDryRunBindingHash,
  createPendingPermissionRequest,
  resolvePermissionRequest,
} from "./permission-state";
import {
  markStep,
} from "./plans";
import {
  type SharedTaskContext,
  resolveStepInput,
} from "./shared-context";
import {
  appendLog,
} from "./snapshot-utils";
import {
  type TaskRuntimeEvent,
} from "./task-event-bus";
import {
  withTaskTimeout,
} from "./task-wait";
import {
  canExecuteWorkspaceWrite,
  runWorkspaceGitCommitCommand,
  runWorkspaceGitStageCommand,
} from "./workflow-step-helpers";
import {
  type WorkspaceRuntime,
} from "./workspace-runtime";
import {
  type GitTool,
  type WorkspaceTool,
} from "@javis/tools";

export function mergeStepInput(
  step: CommanderDagStep,
  context: SharedTaskContext,
  extraInput?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...resolveStepInput(step.inputContextKeys, context),
    ...(isPlainRecord(step.toolInput) ? step.toolInput : {}),
    ...(extraInput ?? {}),
  };
}

export const GIT_STAGE_TOOL_NAME = "git.stageFiles";

export const GIT_COMMIT_TOOL_NAME = "git.createCommit";

export const GIT_CREATE_PR_TOOL_NAME = "git.createPullRequest";

export const GIT_COMMENT_PR_TOOL_NAME = "git.commentPullRequest";

export const WORKSPACE_CREATE_TOOL_NAME = "workspace.create";

export const WORKSPACE_DELETE_TOOL_NAME = "workspace.delete";

export function extractGitStagePaths(input: Record<string, unknown>): string[] {
  const paths = input.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("git.stageFiles requires explicit toolInput.paths: string[].");
  }
  const normalizedPaths = paths.map((path) => (typeof path === "string" ? path.trim() : ""));
  if (normalizedPaths.some((path) => path.length === 0)) {
    throw new Error("git.stageFiles requires non-empty string paths.");
  }
  return [...new Set(normalizedPaths)];
}

export function extractGitCommitInput(input: Record<string, unknown>): { message: string; paths?: string[] } {
  const rawMessage = input.message ?? input.commitMessage;
  if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
    throw new Error("git.createCommit requires explicit toolInput.message: string.");
  }
  const message = rawMessage.trim();
  if (message.length > 500) {
    throw new Error("git.createCommit message must be 500 characters or fewer.");
  }
  if (input.paths === undefined) {
    return { message };
  }
  const paths = input.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("git.createCommit paths must be a non-empty string[] when provided.");
  }
  const normalizedPaths = paths.map((path) => (typeof path === "string" ? path.trim() : ""));
  if (normalizedPaths.some((path) => path.length === 0)) {
    throw new Error("git.createCommit requires non-empty string paths.");
  }
  return { message, paths: [...new Set(normalizedPaths)] };
}

export function extractGitCreatePullRequestInput(input: Record<string, unknown>): {
  title: string;
  body?: string;
  baseBranch: string;
  draft: boolean;
} {
  const rawTitle = input.title ?? input.prTitle;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    throw new Error("git.createPullRequest requires explicit toolInput.title: string.");
  }
  const title = rawTitle.trim();
  if (title.length > 200) {
    throw new Error("git.createPullRequest title must be 200 characters or fewer.");
  }

  const rawBaseBranch = input.baseBranch ?? input.base ?? input.targetBranch;
  if (typeof rawBaseBranch !== "string" || rawBaseBranch.trim().length === 0) {
    throw new Error("git.createPullRequest requires explicit toolInput.baseBranch: string.");
  }
  const baseBranch = rawBaseBranch.trim();

  const rawBody = input.body ?? input.description;
  if (rawBody !== undefined && typeof rawBody !== "string") {
    throw new Error("git.createPullRequest body must be a string when provided.");
  }
  const body = rawBody?.trim() ?? "";
  if (body.length > 10_000) {
    throw new Error("git.createPullRequest body must be 10000 characters or fewer.");
  }

  const draftInput = input.draft;
  if (draftInput !== undefined && typeof draftInput !== "boolean") {
    throw new Error("git.createPullRequest draft must be a boolean when provided.");
  }

  return { title, body, baseBranch, draft: draftInput ?? true };
}

export function extractGitCommentPullRequestInput(input: Record<string, unknown>): {
  pullRequest: string;
  body: string;
} {
  const rawPullRequest = input.pullRequest ?? input.pr ?? input.prNumber ?? input.number;
  if (typeof rawPullRequest !== "string" && typeof rawPullRequest !== "number") {
    throw new Error("git.commentPullRequest requires explicit toolInput.pullRequest: string.");
  }
  const pullRequest = String(rawPullRequest).trim();
  if (pullRequest.length === 0) {
    throw new Error("git.commentPullRequest requires non-empty toolInput.pullRequest.");
  }
  if (pullRequest.length > 200) {
    throw new Error("git.commentPullRequest pullRequest must be 200 characters or fewer.");
  }

  const rawBody = input.body ?? input.comment;
  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    throw new Error("git.commentPullRequest requires explicit toolInput.body: string.");
  }
  const body = rawBody.trim();
  if (body.length > 10_000) {
    throw new Error("git.commentPullRequest body must be 10000 characters or fewer.");
  }

  return { pullRequest, body };
}

export async function executeWorkspaceMutationDagStep(options: {
  dagStep: CommanderDagStep;
  agentId: string;
  taskId: string;
  context: SharedTaskContext;
  workspaceTool?: WorkspaceTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingPermissionHandler?: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
  signal?: AbortSignal;
  toolTimeoutMs: number;
  userWaitTimeoutMs: number;
  beforeWrite: () => Promise<void>;
}): Promise<unknown> {
  const {
    dagStep,
    agentId,
    taskId,
    context,
    workspaceTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingPermissionHandler,
    signal,
    toolTimeoutMs,
    userWaitTimeoutMs,
    beforeWrite,
  } = options;
  if (!workspaceTool || !setPendingPermissionHandler) {
    throw new Error(`${dagStep.toolName} requires the Workspace tool and a permission handler.`);
  }

  const input = mergeStepInput(dagStep, context);
  const isCreate = dagStep.toolName === WORKSPACE_CREATE_TOOL_NAME;
  const toolName = isCreate ? WORKSPACE_CREATE_TOOL_NAME : WORKSPACE_DELETE_TOOL_NAME;
  const definition = isCreate && isPlainRecord(input.definition) ? input.definition : undefined;
  const workspaceId = isCreate
    ? (typeof definition?.id === "string" ? definition.id.trim() : "")
    : (typeof input.workspaceId === "string" ? input.workspaceId.trim() : "");
  if (!workspaceId || (isCreate && !definition)) {
    throw new Error(isCreate
      ? "workspace.create requires toolInput.definition with a non-empty id."
      : "workspace.delete requires a non-empty toolInput.workspaceId.");
  }

  const plan = await withTaskTimeout(
    () => isCreate
      ? workspaceTool.planCreate(definition!, taskId)
      : workspaceTool.planDelete(workspaceId, taskId),
    {
      label: `tool ${toolName} plan`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );
  if (plan.workspaceId !== workspaceId || plan.action !== (isCreate ? "create" : "delete")) {
    throw new Error(`${toolName} returned a preview for a different workspace mutation.`);
  }

  const permissionRequest = createPendingPermissionRequest({
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: isCreate ? "safe" : "risky",
    title: isCreate ? "Approve workspace creation" : "Approve workspace deletion",
    reason: isCreate
      ? "Creating a workspace stores a durable local definition."
      : "Deleting a workspace removes its local definition.",
    dryRun: plan.dryRun,
    allowAlways: false,
  });
  const previewHash = createDryRunBindingHash(permissionRequest.dryRun);
  let resolvedPermissionRequest = permissionRequest;

  const approved = await withTaskTimeout(
    new Promise<boolean>((resolve, reject) => {
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "waiting_permission",
          task: `Waiting for ${toolName} approval`,
          currentStepId: dagStep.id,
        });
      }
      emitSnapshot({
        ...getSnapshot(),
        status: "waiting_permission",
        commanderMessage: `${toolName} needs approval for ${workspaceId}.`,
        permissionRequest,
        agents: agentTracker.getSnapshots(),
        logs: [
          ...getSnapshot().logs,
          emitEvent({
            kind: "permission.requested",
            taskId,
            stepId: dagStep.id,
            toolName,
            previewHash,
            request: permissionRequest,
          }),
          emitEvent({
            kind: "task.waiting",
            taskId,
            phase: "waiting_user",
            label: `${toolName} approval ${permissionRequest.id}`,
            detail: `Waiting for permission to ${plan.action} workspace ${workspaceId}.`,
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName,
          }),
        ],
      });
      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        try {
          resolvedPermissionRequest = resolvePermissionRequest(
            permissionRequest,
            decision as PermissionDecision,
          );
          setPendingPermissionHandler(permissionRequest.id, undefined);
          emitSnapshot({
            ...getSnapshot(),
            permissionRequest: resolvedPermissionRequest,
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "permission.resolved",
              taskId,
              stepId: dagStep.id,
              toolName,
              previewHash,
              requestId: permissionRequest.id,
              decision: decision === "denied" ? "denied" : "approved",
            })),
          });
          resolve(decision !== "denied");
        } catch (error) {
          setPendingPermissionHandler(permissionRequest.id, undefined);
          reject(error);
        }
      });
    }),
    {
      label: `${toolName} approval ${permissionRequest.id}`,
      timeoutMs: userWaitTimeoutMs,
      signal,
      onTimeout: () => setPendingPermissionHandler(permissionRequest.id, undefined),
      onAbort: () => setPendingPermissionHandler(permissionRequest.id, undefined),
    },
  );

  if (!approved) {
    const output = { workspaceId, action: plan.action, changed: false, denied: true };
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, { status: "completed", task: `Skipped: ${dagStep.title}` });
    }
    emitSnapshot({
      ...getSnapshot(),
      status: "running",
      permissionRequest: resolvedPermissionRequest,
      plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName,
        detail: `${toolName} was denied; workspace ${workspaceId} was unchanged.`,
      })),
    });
    return output;
  }

  await beforeWrite();
  await withTaskTimeout(
    () => isCreate
      ? workspaceTool.create(definition!, plan.approvalId, taskId)
      : workspaceTool.delete(workspaceId, plan.approvalId, taskId),
    { label: `tool ${toolName} execute`, timeoutMs: toolTimeoutMs, signal },
  );
  const output = { workspaceId, action: plan.action, changed: true };
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, { status: "completed", task: `Completed: ${dagStep.title}` });
  }
  emitSnapshot({
    ...getSnapshot(),
    status: "running",
    permissionRequest: resolvedPermissionRequest,
    plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName,
      detail: `${toolName} completed for workspace ${workspaceId}.`,
    })),
  });
  return output;
}

export async function executeGitStageDagStep(options: {
  dagStep: CommanderDagStep;
  agentId: string;
  taskId: string;
  context: SharedTaskContext;
  gitTool?: GitTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingPermissionHandler?: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
  signal?: AbortSignal;
  toolTimeoutMs: number;
  userWaitTimeoutMs: number;
  workspaceRuntime?: WorkspaceRuntime;
  /** Drain durable lifecycle writes before invoking the Git mutation. */
  beforeWrite: () => Promise<void>;
}): Promise<unknown> {
  const {
    dagStep,
    agentId,
    taskId,
    context,
    gitTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingPermissionHandler,
    signal,
    toolTimeoutMs,
    userWaitTimeoutMs,
    workspaceRuntime,
    beforeWrite,
  } = options;

  if (!gitTool?.planStageFiles || !gitTool.executeStageFiles) {
    throw new Error("git.stageFiles tool is not available.");
  }
  if (!setPendingPermissionHandler) {
    throw new Error("git.stageFiles requires a permission handler for confirmed-write staging.");
  }

  const input = mergeStepInput(dagStep, context);
  const paths = extractGitStagePaths(input);

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: dagStep.title,
      currentStepId: dagStep.id,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    plan: markStep(getSnapshot().plan, dagStep.id, "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: GIT_STAGE_TOOL_NAME,
      detail: `Step ${dagStep.id}: preparing Git stage preview for ${paths.length} file(s).`,
    })),
  });

  const plan = await withTaskTimeout(
    () => gitTool.planStageFiles!({ paths, taskId }),
    {
      label: `tool ${GIT_STAGE_TOOL_NAME} plan`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );

  const permissionRequest = createPendingPermissionRequest({
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: "Approve Git stage",
    reason: "Staging updates the Git index for selected workspace files.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
  });
  const previewHash = createDryRunBindingHash(permissionRequest.dryRun);

  const approved = await withTaskTimeout(
    new Promise<boolean>((resolve, reject) => {
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "waiting_permission",
          task: `Waiting for Git stage approval for ${paths.length} file(s)`,
          currentStepId: dagStep.id,
        });
      }
      emitSnapshot({
        ...getSnapshot(),
        status: "waiting_permission",
        commanderMessage: `Git stage needs approval for ${paths.length} file(s).`,
        permissionRequest,
        durableApprovalPlan: { toolName: GIT_STAGE_TOOL_NAME, payload: plan },
        agents: agentTracker.getSnapshots(),
        logs: [
          ...getSnapshot().logs,
          emitEvent({
            kind: "permission.requested",
            taskId,
            stepId: dagStep.id,
            toolName: GIT_STAGE_TOOL_NAME,
            previewHash,
            request: permissionRequest,
          }),
          emitEvent({
            kind: "task.waiting",
            taskId,
            phase: "waiting_user",
            label: `Git stage approval ${permissionRequest.id}`,
            detail: `Waiting for permission decision for ${paths.length} Git stage path(s).`,
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_STAGE_TOOL_NAME,
          }),
        ],
      });

      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        try {
          resolvePermissionRequest(permissionRequest, decision as PermissionDecision);
          setPendingPermissionHandler(permissionRequest.id, undefined);
          emitSnapshot({
            ...getSnapshot(),
            permissionRequest: undefined,
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "permission.resolved",
              taskId,
              stepId: dagStep.id,
              toolName: GIT_STAGE_TOOL_NAME,
              previewHash,
              requestId: permissionRequest.id,
              decision: decision === "denied" ? "denied" : "approved",
            })),
          });
          resolve(decision !== "denied");
        } catch (error) {
          setPendingPermissionHandler(permissionRequest.id, undefined);
          reject(error);
        }
      });
    }),
    {
      label: `Git stage approval ${permissionRequest.id}`,
      timeoutMs: userWaitTimeoutMs,
      signal,
      onTimeout: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.timeout",
            taskId,
            phase: "waiting_user",
            label: `Git stage approval ${permissionRequest.id}`,
            timeoutMs: userWaitTimeoutMs,
            detail: "Git stage approval timed out.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_STAGE_TOOL_NAME,
          })),
        });
      },
      onAbort: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `Git stage approval ${permissionRequest.id}`,
            detail: "Git stage approval cancelled.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
          })),
        });
      },
    },
  );

  if (!approved) {
    const output = {
      approvalId: plan.approvalId,
      staged: false,
      stagedPaths: [],
      fileCount: 0,
      denied: true,
    };
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, {
        status: "completed",
        task: `Skipped: ${dagStep.title}`,
      });
    }
    emitSnapshot({
      ...getSnapshot(),
      status: "running",
      commanderMessage: "Git stage was denied; no files were staged.",
      plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
      agents: agentTracker.getSnapshots(),
      verificationSummary: "verified: Git stage denied by user; no files were staged.",
      logs: appendLog(getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: GIT_STAGE_TOOL_NAME,
        detail: `Step ${dagStep.id}: Git stage denied by user; no files staged.`,
      })),
    });
    return output;
  }

  await beforeWrite();

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: `Executing Git stage for ${paths.length} file(s)`,
      currentStepId: dagStep.id,
    });
  }
  const execution = await withTaskTimeout(
    () => canExecuteWorkspaceWrite(workspaceRuntime)
      ? runWorkspaceGitStageCommand({ runtime: workspaceRuntime, plan, paths })
      : gitTool.executeStageFiles!({
        approvalId: plan.approvalId,
        paths,
        taskId,
      }),
    {
      label: `tool ${GIT_STAGE_TOOL_NAME} execute`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );
  const stagedList = execution.stagedPaths.join(", ");
  const summary = `Staged ${execution.fileCount} file(s)${stagedList ? `: ${stagedList}` : ""}.`;
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "completed",
      task: `Completed: ${dagStep.title}`,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    status: "running",
    commanderMessage: summary,
    plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
    agents: agentTracker.getSnapshots(),
    verificationSummary: `verified: ${summary}`,
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: GIT_STAGE_TOOL_NAME,
      detail: `Step ${dagStep.id}: ${summary}`,
    })),
  });
  return execution;
}

export async function executeGitCommitDagStep(options: {
  dagStep: CommanderDagStep;
  agentId: string;
  taskId: string;
  context: SharedTaskContext;
  gitTool?: GitTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingPermissionHandler?: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
  signal?: AbortSignal;
  toolTimeoutMs: number;
  userWaitTimeoutMs: number;
  workspaceRuntime?: WorkspaceRuntime;
  /** Drain durable lifecycle writes before invoking the Git mutation. */
  beforeWrite: () => Promise<void>;
}): Promise<unknown> {
  const {
    dagStep,
    agentId,
    taskId,
    context,
    gitTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingPermissionHandler,
    signal,
    toolTimeoutMs,
    userWaitTimeoutMs,
    workspaceRuntime,
    beforeWrite,
  } = options;

  if (!gitTool?.planCommit || !gitTool.executeCommit) {
    throw new Error("git.createCommit tool is not available.");
  }
  if (!setPendingPermissionHandler) {
    throw new Error("git.createCommit requires a permission handler for confirmed-write commits.");
  }

  const input = mergeStepInput(dagStep, context);
  const { message, paths } = extractGitCommitInput(input);
  const scopeSummary = paths?.length ? `${paths.length} selected file(s)` : "current workspace changes";

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: dagStep.title,
      currentStepId: dagStep.id,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    plan: markStep(getSnapshot().plan, dagStep.id, "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: GIT_COMMIT_TOOL_NAME,
      detail: `Step ${dagStep.id}: preparing Git commit preview for ${scopeSummary}.`,
    })),
  });

  const plan = await withTaskTimeout(
    () => gitTool.planCommit!({ message, paths, taskId }),
    {
      label: `tool ${GIT_COMMIT_TOOL_NAME} plan`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );

  const permissionRequest = createPendingPermissionRequest({
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: "Approve Git commit",
    reason: paths?.length
      ? "Committing stages selected workspace files and writes a local Git commit."
      : "Committing stages current workspace changes and writes a local Git commit.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
  });
  const previewHash = createDryRunBindingHash(permissionRequest.dryRun);

  const approved = await withTaskTimeout(
    new Promise<boolean>((resolve, reject) => {
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "waiting_permission",
          task: `Waiting for Git commit approval for ${scopeSummary}`,
          currentStepId: dagStep.id,
        });
      }
      emitSnapshot({
        ...getSnapshot(),
        status: "waiting_permission",
        commanderMessage: `Git commit needs approval for ${scopeSummary}.`,
        permissionRequest,
        durableApprovalPlan: { toolName: GIT_COMMIT_TOOL_NAME, payload: plan },
        agents: agentTracker.getSnapshots(),
        logs: [
          ...getSnapshot().logs,
          emitEvent({
            kind: "permission.requested",
            taskId,
            stepId: dagStep.id,
            toolName: GIT_COMMIT_TOOL_NAME,
            previewHash,
            request: permissionRequest,
          }),
          emitEvent({
            kind: "task.waiting",
            taskId,
            phase: "waiting_user",
            label: `Git commit approval ${permissionRequest.id}`,
            detail: `Waiting for permission decision for Git commit "${message}".`,
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_COMMIT_TOOL_NAME,
          }),
        ],
      });

      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        try {
          resolvePermissionRequest(permissionRequest, decision as PermissionDecision);
          setPendingPermissionHandler(permissionRequest.id, undefined);
          emitSnapshot({
            ...getSnapshot(),
            permissionRequest: undefined,
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "permission.resolved",
              taskId,
              stepId: dagStep.id,
              toolName: GIT_COMMIT_TOOL_NAME,
              previewHash,
              requestId: permissionRequest.id,
              decision: decision === "denied" ? "denied" : "approved",
            })),
          });
          resolve(decision !== "denied");
        } catch (error) {
          setPendingPermissionHandler(permissionRequest.id, undefined);
          reject(error);
        }
      });
    }),
    {
      label: `Git commit approval ${permissionRequest.id}`,
      timeoutMs: userWaitTimeoutMs,
      signal,
      onTimeout: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.timeout",
            taskId,
            phase: "waiting_user",
            label: `Git commit approval ${permissionRequest.id}`,
            timeoutMs: userWaitTimeoutMs,
            detail: "Git commit approval timed out.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_COMMIT_TOOL_NAME,
          })),
        });
      },
      onAbort: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `Git commit approval ${permissionRequest.id}`,
            detail: "Git commit approval cancelled.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
          })),
        });
      },
    },
  );

  if (!approved) {
    const output = {
      approvalId: plan.approvalId,
      committed: false,
      fileCount: 0,
      denied: true,
    };
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, {
        status: "completed",
        task: `Skipped: ${dagStep.title}`,
      });
    }
    emitSnapshot({
      ...getSnapshot(),
      status: "running",
      commanderMessage: "Git commit was denied; no commit was created.",
      plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
      agents: agentTracker.getSnapshots(),
      verificationSummary: "verified: Git commit denied by user; no commit was created.",
      logs: appendLog(getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: GIT_COMMIT_TOOL_NAME,
        detail: `Step ${dagStep.id}: Git commit denied by user; no commit created.`,
      })),
    });
    return output;
  }

  await beforeWrite();

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: `Creating Git commit for ${scopeSummary}`,
      currentStepId: dagStep.id,
    });
  }
  const execution = await withTaskTimeout(
    () => canExecuteWorkspaceWrite(workspaceRuntime)
      ? runWorkspaceGitCommitCommand({ runtime: workspaceRuntime, plan, message, paths })
      : gitTool.executeCommit!({
        approvalId: plan.approvalId,
        message,
        paths,
        taskId,
      }),
    {
      label: `tool ${GIT_COMMIT_TOOL_NAME} execute`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );
  const shortHash = execution.commitHash.slice(0, 12);
  const summary = `Created commit ${shortHash} for ${execution.fileCount} file(s): ${execution.subject}.`;
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "completed",
      task: `Completed: ${dagStep.title}`,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    status: "running",
    commanderMessage: summary,
    plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
    agents: agentTracker.getSnapshots(),
    verificationSummary: `verified: ${summary}`,
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: GIT_COMMIT_TOOL_NAME,
      detail: `Step ${dagStep.id}: ${summary}`,
    })),
  });
  return execution;
}

export async function executeGitCreatePullRequestDagStep(options: {
  dagStep: CommanderDagStep;
  agentId: string;
  taskId: string;
  context: SharedTaskContext;
  gitTool?: GitTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingPermissionHandler?: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
  signal?: AbortSignal;
  toolTimeoutMs: number;
  userWaitTimeoutMs: number;
  /** Drain durable lifecycle writes before invoking the remote mutation. */
  beforeWrite: () => Promise<void>;
}): Promise<unknown> {
  const {
    dagStep,
    agentId,
    taskId,
    context,
    gitTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingPermissionHandler,
    signal,
    toolTimeoutMs,
    userWaitTimeoutMs,
    beforeWrite,
  } = options;

  if (!gitTool?.planCreatePullRequest || !gitTool.executeCreatePullRequest) {
    throw new Error("git.createPullRequest tool is not available.");
  }
  if (!setPendingPermissionHandler) {
    throw new Error("git.createPullRequest requires a permission handler for confirmed-write pull request creation.");
  }

  const input = mergeStepInput(dagStep, context);
  const { title, body, baseBranch, draft } = extractGitCreatePullRequestInput(input);

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: dagStep.title,
      currentStepId: dagStep.id,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    plan: markStep(getSnapshot().plan, dagStep.id, "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: GIT_CREATE_PR_TOOL_NAME,
      detail: `Step ${dagStep.id}: preparing Git pull request preview for base branch ${baseBranch}.`,
    })),
  });

  const plan = await withTaskTimeout(
    () => gitTool.planCreatePullRequest!({ title, body, baseBranch, draft, taskId }),
    {
      label: `tool ${GIT_CREATE_PR_TOOL_NAME} plan`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );

  const permissionRequest = createPendingPermissionRequest({
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: "Approve Git pull request",
    reason: "Creating a pull request publishes the current branch to the configured GitHub remote.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
  });
  const previewHash = createDryRunBindingHash(permissionRequest.dryRun);

  const approved = await withTaskTimeout(
    new Promise<boolean>((resolve, reject) => {
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "waiting_permission",
          task: `Waiting for Git pull request approval for ${plan.preview.headBranch}`,
          currentStepId: dagStep.id,
        });
      }
      emitSnapshot({
        ...getSnapshot(),
        status: "waiting_permission",
        commanderMessage: `Git pull request creation needs approval for ${plan.preview.headBranch} -> ${plan.preview.baseBranch}.`,
        permissionRequest,
        durableApprovalPlan: { toolName: GIT_CREATE_PR_TOOL_NAME, payload: plan },
        agents: agentTracker.getSnapshots(),
        logs: [
          ...getSnapshot().logs,
          emitEvent({
            kind: "permission.requested",
            taskId,
            stepId: dagStep.id,
            toolName: GIT_CREATE_PR_TOOL_NAME,
            previewHash,
            request: permissionRequest,
          }),
          emitEvent({
            kind: "task.waiting",
            taskId,
            phase: "waiting_user",
            label: `Git pull request approval ${permissionRequest.id}`,
            detail: `Waiting for permission decision for Git pull request "${title}".`,
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_CREATE_PR_TOOL_NAME,
          }),
        ],
      });

      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        try {
          resolvePermissionRequest(permissionRequest, decision as PermissionDecision);
          setPendingPermissionHandler(permissionRequest.id, undefined);
          emitSnapshot({
            ...getSnapshot(),
            permissionRequest: undefined,
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "permission.resolved",
              taskId,
              stepId: dagStep.id,
              toolName: GIT_CREATE_PR_TOOL_NAME,
              previewHash,
              requestId: permissionRequest.id,
              decision: decision === "denied" ? "denied" : "approved",
            })),
          });
          resolve(decision !== "denied");
        } catch (error) {
          setPendingPermissionHandler(permissionRequest.id, undefined);
          reject(error);
        }
      });
    }),
    {
      label: `Git pull request approval ${permissionRequest.id}`,
      timeoutMs: userWaitTimeoutMs,
      signal,
      onTimeout: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.timeout",
            taskId,
            phase: "waiting_user",
            label: `Git pull request approval ${permissionRequest.id}`,
            timeoutMs: userWaitTimeoutMs,
            detail: "Git pull request approval timed out.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_CREATE_PR_TOOL_NAME,
          })),
        });
      },
      onAbort: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `Git pull request approval ${permissionRequest.id}`,
            detail: "Git pull request approval cancelled.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
          })),
        });
      },
    },
  );

  if (!approved) {
    const output = {
      approvalId: plan.approvalId,
      created: false,
      denied: true,
    };
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, {
        status: "completed",
        task: `Skipped: ${dagStep.title}`,
      });
    }
    emitSnapshot({
      ...getSnapshot(),
      status: "running",
      commanderMessage: "Git pull request creation was denied; no pull request was created.",
      plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
      agents: agentTracker.getSnapshots(),
      verificationSummary: "verified: Git pull request creation denied by user; no pull request was created.",
      logs: appendLog(getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: GIT_CREATE_PR_TOOL_NAME,
        detail: `Step ${dagStep.id}: Git pull request creation denied by user; no pull request created.`,
      })),
    });
    return output;
  }

  await beforeWrite();

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: `Creating Git pull request for ${plan.preview.headBranch}`,
      currentStepId: dagStep.id,
    });
  }
  const execution = await withTaskTimeout(
    () => gitTool.executeCreatePullRequest!({
      approvalId: plan.approvalId,
      title,
      body,
      baseBranch,
      draft,
      taskId,
    }),
    {
      label: `tool ${GIT_CREATE_PR_TOOL_NAME} execute`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );
  const draftLabel = execution.draft ? "draft " : "";
  const summary = `Created ${draftLabel}pull request ${execution.url} from ${execution.headBranch} to ${execution.baseBranch}.`;
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "completed",
      task: `Completed: ${dagStep.title}`,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    status: "running",
    commanderMessage: summary,
    plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
    agents: agentTracker.getSnapshots(),
    verificationSummary: `verified: ${summary}`,
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: GIT_CREATE_PR_TOOL_NAME,
      detail: `Step ${dagStep.id}: ${summary}`,
    })),
  });
  return execution;
}

export async function executeGitCommentPullRequestDagStep(options: {
  dagStep: CommanderDagStep;
  agentId: string;
  taskId: string;
  context: SharedTaskContext;
  gitTool?: GitTool;
  getSnapshot: () => TaskSnapshot;
  emitSnapshot: (snapshot: TaskSnapshot) => void;
  emitEvent: (event: TaskRuntimeEvent) => TaskSnapshot["logs"][number];
  agentTracker: ReturnType<typeof createAgentStateTracker>;
  setPendingPermissionHandler?: (
    requestId: string,
    handler: ((decision: string) => void | Promise<void>) | undefined,
  ) => void;
  signal?: AbortSignal;
  toolTimeoutMs: number;
  userWaitTimeoutMs: number;
  /** Drain durable lifecycle writes before invoking the remote mutation. */
  beforeWrite: () => Promise<void>;
}): Promise<unknown> {
  const {
    dagStep,
    agentId,
    taskId,
    context,
    gitTool,
    getSnapshot,
    emitSnapshot,
    emitEvent,
    agentTracker,
    setPendingPermissionHandler,
    signal,
    toolTimeoutMs,
    userWaitTimeoutMs,
    beforeWrite,
  } = options;

  if (!gitTool?.planCommentPullRequest || !gitTool.executeCommentPullRequest) {
    throw new Error("git.commentPullRequest tool is not available.");
  }
  if (!setPendingPermissionHandler) {
    throw new Error("git.commentPullRequest requires a permission handler for confirmed-write pull request comments.");
  }

  const input = mergeStepInput(dagStep, context);
  const { pullRequest, body } = extractGitCommentPullRequestInput(input);

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: dagStep.title,
      currentStepId: dagStep.id,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    plan: markStep(getSnapshot().plan, dagStep.id, "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.planned",
      taskId,
      toolName: GIT_COMMENT_PR_TOOL_NAME,
      detail: `Step ${dagStep.id}: preparing Git pull request comment preview for ${pullRequest}.`,
    })),
  });

  const plan = await withTaskTimeout(
    () => gitTool.planCommentPullRequest!({ pullRequest, body, taskId }),
    {
      label: `tool ${GIT_COMMENT_PR_TOOL_NAME} plan`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );

  const permissionRequest = createPendingPermissionRequest({
    id: plan.approvalId,
    level: "confirmed_write",
    writeRiskLevel: "risky",
    title: "Approve Git pull request comment",
    reason: "Commenting on a pull request publishes text to the configured GitHub remote.",
    dryRun: plan.preview.dryRun,
    allowAlways: false,
  });
  const previewHash = createDryRunBindingHash(permissionRequest.dryRun);

  const approved = await withTaskTimeout(
    new Promise<boolean>((resolve, reject) => {
      if (agentTracker.getState(agentId)) {
        agentTracker.setState(agentId, {
          status: "waiting_permission",
          task: `Waiting for Git pull request comment approval for ${plan.preview.pullRequest}`,
          currentStepId: dagStep.id,
        });
      }
      emitSnapshot({
        ...getSnapshot(),
        status: "waiting_permission",
        commanderMessage: `Git pull request comment needs approval for ${plan.preview.pullRequest}.`,
        permissionRequest,
        durableApprovalPlan: { toolName: GIT_COMMENT_PR_TOOL_NAME, payload: plan },
        agents: agentTracker.getSnapshots(),
        logs: [
          ...getSnapshot().logs,
          emitEvent({
            kind: "permission.requested",
            taskId,
            stepId: dagStep.id,
            toolName: GIT_COMMENT_PR_TOOL_NAME,
            previewHash,
            request: permissionRequest,
          }),
          emitEvent({
            kind: "task.waiting",
            taskId,
            phase: "waiting_user",
            label: `Git pull request comment approval ${permissionRequest.id}`,
            detail: `Waiting for permission decision for Git pull request comment on ${pullRequest}.`,
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_COMMENT_PR_TOOL_NAME,
          }),
        ],
      });

      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        try {
          resolvePermissionRequest(permissionRequest, decision as PermissionDecision);
          setPendingPermissionHandler(permissionRequest.id, undefined);
          emitSnapshot({
            ...getSnapshot(),
            permissionRequest: undefined,
            logs: appendLog(getSnapshot(), emitEvent({
              kind: "permission.resolved",
              taskId,
              stepId: dagStep.id,
              toolName: GIT_COMMENT_PR_TOOL_NAME,
              previewHash,
              requestId: permissionRequest.id,
              decision: decision === "denied" ? "denied" : "approved",
            })),
          });
          resolve(decision !== "denied");
        } catch (error) {
          setPendingPermissionHandler(permissionRequest.id, undefined);
          reject(error);
        }
      });
    }),
    {
      label: `Git pull request comment approval ${permissionRequest.id}`,
      timeoutMs: userWaitTimeoutMs,
      signal,
      onTimeout: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.timeout",
            taskId,
            phase: "waiting_user",
            label: `Git pull request comment approval ${permissionRequest.id}`,
            timeoutMs: userWaitTimeoutMs,
            detail: "Git pull request comment approval timed out.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
            toolName: GIT_COMMENT_PR_TOOL_NAME,
          })),
        });
      },
      onAbort: () => {
        setPendingPermissionHandler(permissionRequest.id, undefined);
        emitSnapshot({
          ...getSnapshot(),
          permissionRequest: undefined,
          logs: appendLog(getSnapshot(), emitEvent({
            kind: "task.cancelled",
            taskId,
            label: `Git pull request comment approval ${permissionRequest.id}`,
            detail: "Git pull request comment approval cancelled.",
            stepId: dagStep.id,
            agentKind: dagStep.assignedAgentKind as AgentKind,
          })),
        });
      },
    },
  );

  if (!approved) {
    const output = {
      approvalId: plan.approvalId,
      commented: false,
      denied: true,
    };
    if (agentTracker.getState(agentId)) {
      agentTracker.setState(agentId, {
        status: "completed",
        task: `Skipped: ${dagStep.title}`,
      });
    }
    emitSnapshot({
      ...getSnapshot(),
      status: "running",
      commanderMessage: "Git pull request comment was denied; no comment was posted.",
      plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
      agents: agentTracker.getSnapshots(),
      verificationSummary: "verified: Git pull request comment denied by user; no comment was posted.",
      logs: appendLog(getSnapshot(), emitEvent({
        kind: "tool.completed",
        taskId,
        toolName: GIT_COMMENT_PR_TOOL_NAME,
        detail: `Step ${dagStep.id}: Git pull request comment denied by user; no comment posted.`,
      })),
    });
    return output;
  }

  await beforeWrite();

  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "running",
      task: `Posting Git pull request comment for ${plan.preview.pullRequest}`,
      currentStepId: dagStep.id,
    });
  }
  const execution = await withTaskTimeout(
    () => gitTool.executeCommentPullRequest!({
      approvalId: plan.approvalId,
      pullRequest,
      body,
      taskId,
    }),
    {
      label: `tool ${GIT_COMMENT_PR_TOOL_NAME} execute`,
      timeoutMs: toolTimeoutMs,
      signal,
    },
  );
  const summary = `Posted pull request comment on ${execution.pullRequest}.`;
  if (agentTracker.getState(agentId)) {
    agentTracker.setState(agentId, {
      status: "completed",
      task: `Completed: ${dagStep.title}`,
    });
  }
  emitSnapshot({
    ...getSnapshot(),
    status: "running",
    commanderMessage: summary,
    plan: markStep(getSnapshot().plan, dagStep.id, "completed"),
    agents: agentTracker.getSnapshots(),
    verificationSummary: `verified: ${summary}`,
    logs: appendLog(getSnapshot(), emitEvent({
      kind: "tool.completed",
      taskId,
      toolName: GIT_COMMENT_PR_TOOL_NAME,
      detail: `Step ${dagStep.id}: ${summary}`,
    })),
  });
  return execution;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
