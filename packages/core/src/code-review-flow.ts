import type {
  CodeTool,
  CommanderTool,
  PermissionRequest as ToolPermissionRequest,
  ShellTool,
} from "@javis/tools";
import type { PendingPermissionHandler } from "./confirmed-write";
import type { FlowController } from "./flow-controller";
import { createCodeReviewPlan, markStep } from "./plans";
import { createPendingPermissionRequest, resolvePermissionRequest } from "./permission-state";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";
import type { ID, TaskSnapshot, TaskStep } from "./index";
import { createScopedAgentTracker, setTrackedAgentStates } from "./flow-agent-utils";
import { safeSynthesizeConclusion } from "./workflow-executor";
import { runWorkspaceReadOnlyCommand } from "./workflow-step-helpers";
import type { WorkspaceRuntime } from "./workspace-runtime";

export interface CodeReviewFlowOptions {
  controller: FlowController;
  taskId: ID;
  userGoal: string;
  codeTool: CodeTool;
  shellTool: ShellTool;
  commanderTool?: CommanderTool;
  workspaceRuntime?: WorkspaceRuntime;
  setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
}

export async function runCodeReviewTask({
  controller,
  taskId,
  userGoal,
  codeTool,
  shellTool,
  commanderTool,
  workspaceRuntime,
  setPendingPermissionHandler,
}: CodeReviewFlowOptions) {
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }
  const wait = controller.wait;
  const plan = createCodeReviewPlan();
  const agentTracker = createScopedAgentTracker(["commander", "code", "verifier"]);

  emit({
    id: taskId,
    title: "Reviewing code changes",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a code review goal and will collect a diff preview before read-only verification. Patch proposals require the Commander OpenCode runtime.",
    plan,
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "planning", task: "Create code review plan" },
      { agentId: "agent-code", status: "queued", task: "Waiting for repository diff preview" },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for diff evidence" },
    ]),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the code review goal to Core.",
      },
    ],
  });

  await wait();

  emit({
    ...snapshot,
    status: "running",
    commanderMessage: "Code Agent is gathering changed files and a diff preview from the current workspace.",
    plan: markStep(snapshot.plan, "step-inspect-code", "running"),
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
      { agentId: "agent-code", status: "running", task: "Collecting repository diff preview" },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for diff evidence" },
    ]),
    logs: appendLog(snapshot, {
      id: `${taskId}-preview-started`,
      kind: "tool",
      title: "tool_call.planned",
      detail: "code.inspectRepository and read-only git checks collect the current diff preview.",
    }),
  });

  try {
    const codeReviewPreview = await codeTool.inspectRepository();
    const changedFileCount = codeReviewPreview.changedFiles.length;
    if (changedFileCount === 0 && !codeReviewPreview.diff.trim()) {
      emit({
        ...snapshot,
        title: "No code changes found",
        status: "completed",
        commanderMessage:
          "Code Agent did not find local code changes, so no review or verification step was needed.",
        plan: snapshot.plan.map((step) => ({
          ...step,
            status: step.id === "step-inspect-code" ? "completed" : "skipped",
        })),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Task finished" },
          { agentId: "agent-code", status: "completed", task: "No local diff" },
          { agentId: "agent-verifier", status: "completed", task: "Verified no-op result" },
        ]),
        codeReviewPreview,
        logs: appendLog(snapshot, {
          id: `${taskId}-no-diff`,
          kind: "verification",
          title: "task.completed",
          detail: "Repository diff preview was empty, so no confirmation was needed.",
        }),
        verificationSummary: "verified: no local code changes were found.",
      });
      return;
    }

    const permissionRequest: ToolPermissionRequest = createPendingPermissionRequest({
      id: `${taskId}-permission`,
      level: "preview",
      title: "Approve code review continuation",
      reason: "Review the current diff preview before running a read-only verification check.",
      dryRun: {
        operation: "Run git diff --check after diff review",
        affectedPaths: codeReviewPreview.changedFiles.map((file) => ({
          source: file,
          target: file,
          action: "modify",
        })),
        riskSummary: "Read-only review of changed files before verification.",
        reversible: true,
      },
    });

    emit({
      ...snapshot,
      title: "Code review preview ready",
      status: "waiting_permission",
      commanderMessage:
        "Diff preview is ready. Review the changed files before approving the read-only verification check.",
      plan: markStep(snapshot.plan, "step-inspect-code", "completed", "step-review-code", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "waiting_permission", task: "Waiting for code review approval" },
        { agentId: "agent-code", status: "completed", task: "Repository diff preview collected" },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for approval" },
      ]),
      codeReviewPreview,
      permissionRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: `${changedFileCount} changed file(s) require review before verification continues.`,
      }),
    });

    setPendingPermissionHandler(permissionRequest.id, async (decision) => {
      const resolvedRequest: ToolPermissionRequest = resolvePermissionRequest(
        permissionRequest,
        decision,
      );
      setPendingPermissionHandler(permissionRequest.id, undefined);

      if (decision === "denied") {
        emit({
          ...snapshot,
          title: "Code review denied",
          status: "completed",
          commanderMessage:
            "Permission was denied. Javis kept the diff preview read-only and did not run verification.",
          plan: snapshot.plan.map((step) => ({
            ...step,
          status:
            step.id === "step-verify-code" ||
            step.id === "step-propose-code-edit" ||
            step.id === "step-apply-code-edit"
              ? "skipped"
              : "completed",
          })),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
            { agentId: "agent-code", status: "completed", task: "Diff preview kept read-only" },
            { agentId: "agent-verifier", status: "completed", task: "Verified denial record" },
          ]),
          codeReviewPreview,
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-permission-denied`,
            kind: "permission",
            title: "permission.resolved",
            detail: `User denied ${permissionRequest.id}; no verification command was run.`,
          }),
          verificationSummary: "verified: code review was denied and no read-only verification command was executed.",
        });
        return;
      }

      emit({
        ...snapshot,
        title: "Running code review verification",
        status: "running",
        commanderMessage:
          "Code Agent will run a read-only diff check against the current repository state.",
        plan: markStep(snapshot.plan, "step-review-code", "completed", "step-verify-code", "running"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
          { agentId: "agent-code", status: "running", task: "Running read-only diff verification" },
          { agentId: "agent-verifier", status: "queued", task: "Waiting for diff check result" },
        ]),
        codeReviewPreview,
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-verify-started`,
          kind: "permission",
          title: "permission.resolved",
          detail: `User approved ${permissionRequest.id}; running git diff --check.`,
        }),
      });

      try {
        const verification = await runWorkspaceReadOnlyCommand({
          program: "git",
          args: ["diff", "--check"],
          workspacePath: null,
        }, shellTool, workspaceRuntime);
        const verificationStatus = verification.exitCode === 0 ? "completed" : "failed";
        const logs = appendLog(snapshot, {
          id: `${taskId}-done`,
          kind: "verification",
          title:
            verificationStatus === "completed" ? "verification.completed" : "verification.failed",
          detail: `Verifier checked the repository diff with exit code ${verification.exitCode ?? "unknown"}.`,
        });

        if (verificationStatus === "failed") {
          emit({
            ...snapshot,
            title: "Code review verification failed",
            status: "failed",
            commanderMessage:
              "Code Agent reviewed the current diff, but the read-only verification check failed.",
            plan: markCodeReviewFailedAfterVerification(snapshot.plan),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "failed", task: "Verification failed" },
              { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
              { agentId: "agent-verifier", status: "failed", task: `${verification.exitCode ?? "unknown"} diff check exit code` },
            ]),
            codeReviewPreview,
            commands: [verification],
            permissionRequest: resolvedRequest,
            logs,
            verificationSummary: `failed: ${changedFileCount} changed file(s) reviewed and git diff --check returned exit code ${verification.exitCode ?? "unknown"}.`,
          });
          return;
        }

        const synthesis = await safeSynthesizeConclusion(
          commanderTool, userGoal, "Code review completed", {
            codeReviewPreview,
            changedFileCount,
            verification,
          },
        );
        emit({
          ...snapshot,
          title: "Code review completed",
          status: "completed",
          commanderMessage: synthesis?.message
            ?? "Code Agent reviewed the current diff and the read-only verification check passed. Patch proposals are available only through the Commander OpenCode runtime.",
          plan: snapshot.plan.map((step) => ({
            ...step,
            status:
              step.id === "step-propose-code-edit" || step.id === "step-apply-code-edit"
                ? "skipped"
                : "completed",
          })),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Task finished" },
            { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
            { agentId: "agent-verifier", status: "completed", task: `${verification.exitCode ?? "unknown"} diff check exit code` },
          ]),
          codeReviewPreview,
          commands: [verification],
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-proposal-skipped`,
            kind: "verification",
            title: "code.proposeEdit.skipped",
            detail: "The degraded code-review path is read-only; patch proposals require the Commander OpenCode runtime.",
          }),
          verificationSummary: `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed; no patch was generated in the degraded code-review path.`,
        });

      } catch (error) {
        emit({
          ...snapshot,
          title: "Code review verification failed",
          status: "failed",
          commanderMessage:
            "Code Agent reviewed the diff preview, but the read-only verification command failed to run.",
          plan: markCodeReviewFailedAfterVerification(snapshot.plan),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
            { agentId: "agent-code", status: "completed", task: "Diff preview reviewed" },
            { agentId: "agent-verifier", status: "failed", task: "Verification command failed" },
          ]),
          codeReviewPreview,
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-failed`,
            kind: "tool",
            title: "task.failed",
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    });
  } catch (error) {
    emit({
      ...snapshot,
      title: "Code review preview failed",
      status: "failed",
      commanderMessage:
        "Code Agent could not collect a diff preview. Check repository access or try a narrower code review goal.",
      plan: markCodeReviewPreviewFailed(snapshot.plan),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-code", status: "failed", task: "Diff preview unavailable" },
        { agentId: "agent-verifier", status: "cancelled", task: "No diff to verify" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

function markCodeReviewFailedAfterVerification(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-verify-code") {
      return { ...step, status: "failed" };
    }
    if (step.id === "step-propose-code-edit" || step.id === "step-apply-code-edit") {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}
function markCodeReviewPreviewFailed(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-inspect-code") {
      return { ...step, status: "failed" };
    }
    if (
      step.id === "step-review-code" ||
      step.id === "step-verify-code" ||
      step.id === "step-propose-code-edit" ||
      step.id === "step-apply-code-edit"
    ) {
      return { ...step, status: "skipped" };
    }
    return step;
  });
}
