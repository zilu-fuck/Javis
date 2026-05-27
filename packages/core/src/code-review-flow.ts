import type {
  CodeProposedEdit,
  CodeTool,
  CommanderTool,
  PermissionRequest as ToolPermissionRequest,
  ShellTool,
} from "@javis/tools";
import {
  createCodeApplyDryRun,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
import type { PendingPermissionHandler } from "./confirmed-write";
import type { FlowController } from "./flow-controller";
import { createCodeReviewPlan, markStep } from "./plans";
import { createPendingPermissionRequest, resolvePermissionRequest } from "./permission-state";
import { appendLog } from "./snapshot-utils";
import { addModelUsage, createEmptyTokenUsageSummary } from "./token-usage";
import type { ID, TaskSnapshot, TaskStep } from "./index";
import { createScopedAgentTracker, setTrackedAgentStates } from "./flow-agent-utils";
import { safeSynthesizeConclusion } from "./workflow-executor";

export interface CodeReviewFlowOptions {
  controller: FlowController;
  taskId: ID;
  userGoal: string;
  codeTool: CodeTool;
  shellTool: ShellTool;
  commanderTool?: CommanderTool;
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
      "Commander identified a code review goal and will collect a diff preview before read-only verification and any optional edit proposal.",
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
        const verification = await shellTool.runReadOnlyCommand({
          program: "git",
          args: ["diff", "--check"],
          workspacePath: null,
        });
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

        if (!codeTool.proposeEdit) {
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
              ?? "Code Agent reviewed the current diff and the read-only verification check passed. No edit proposal backend is configured yet.",
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
            logs,
            verificationSummary: `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed; no Code Agent edit backend is configured.`,
          });
          return;
        }

        emit({
          ...snapshot,
          title: "Preparing Code Agent patch proposal",
          status: "running",
          commanderMessage:
            "Diff verification passed. Code Agent is preparing an optional patch proposal without applying it.",
          plan: markStep(snapshot.plan, "step-verify-code", "completed", "step-propose-code-edit", "running"),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
            { agentId: "agent-code", status: "running", task: "Preparing patch proposal" },
            { agentId: "agent-verifier", status: "completed", task: "Diff check passed" },
          ]),
          codeReviewPreview,
          commands: [verification],
          permissionRequest: resolvedRequest,
          logs,
        });

        let proposedEdit: CodeProposedEdit;
        try {
          proposedEdit = await codeTool.proposeEdit({
            userGoal,
            preview: codeReviewPreview,
          });
        } catch (error) {
          emit({
            ...snapshot,
            title: "Code Agent patch proposal failed",
            status: "failed",
            commanderMessage:
              "Code Agent could not produce a patch proposal. Check the opencode model settings or provider response, then retry.",
            plan: markStep(snapshot.plan, "step-propose-code-edit", "failed", "step-apply-code-edit", "skipped"),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "failed", task: "Patch proposal unavailable" },
              { agentId: "agent-code", status: "failed", task: "Patch proposal failed" },
              { agentId: "agent-verifier", status: "cancelled", task: "No patch proposal to verify" },
            ]),
            codeReviewPreview,
            commands: [verification],
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-proposal-failed`,
              kind: "tool",
              title: "task.failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
            verificationSummary: "failed: Code Agent patch proposal failed before any write approval was requested.",
          });
          return;
        }
        const tokenUsage = proposedEdit.tokenUsage
          ? addModelUsage(snapshot.tokenUsage, "code", proposedEdit.tokenUsage)
          : snapshot.tokenUsage;
        const proposalSafetyError = validateCodeProposal(proposedEdit);
        if (proposalSafetyError) {
          emit({
            ...snapshot,
            title: "Code Agent patch proposal failed safety check",
            status: "failed",
            commanderMessage:
              "Code Agent produced a patch proposal whose hash does not match its content, so Javis refused to request write approval.",
            plan: markStep(snapshot.plan, "step-propose-code-edit", "failed", "step-apply-code-edit", "skipped"),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "failed", task: "Proposal safety check failed" },
              { agentId: "agent-code", status: "failed", task: "Patch hash mismatch" },
              { agentId: "agent-verifier", status: "cancelled", task: "No write approval requested" },
            ]),
            codeReviewPreview,
            codeProposedEdit: proposedEdit,
            commands: [verification],
            permissionRequest: resolvedRequest,
            tokenUsage,
            logs: appendLog(snapshot, {
              id: `${taskId}-proposal-hash-mismatch`,
              kind: "tool",
              title: "task.failed",
              detail: proposalSafetyError,
            }),
          });
          return;
        }

        if (!proposedEdit.patch.trim()) {
          emit({
            ...snapshot,
            title: "Code review completed",
            status: "completed",
            commanderMessage:
              "Code Agent did not produce a patch proposal, so no confirmed-write approval is needed.",
            plan: snapshot.plan.map((step) => ({
              ...step,
              status: step.id === "step-apply-code-edit" ? "skipped" : "completed",
            })),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "completed", task: "Task finished" },
              { agentId: "agent-code", status: "completed", task: "No patch proposed" },
              { agentId: "agent-verifier", status: "completed", task: "Diff check passed" },
            ]),
            codeReviewPreview,
            codeProposedEdit: proposedEdit,
            commands: [verification],
            permissionRequest: resolvedRequest,
            tokenUsage,
            logs: appendLog(snapshot, {
              id: `${taskId}-proposal-empty`,
              kind: "tool",
              title: "tool_call.updated",
              detail: "code.proposeEdit returned no patch to apply.",
            }),
            verificationSummary: `verified: ${changedFileCount} changed file(s) reviewed and git diff --check passed; no patch was proposed.`,
          });
          return;
        }

        const applyPermissionRequest: ToolPermissionRequest = createPendingPermissionRequest({
          id: `${taskId}-apply-permission`,
          level: "confirmed_write",
          title: "Approve Code Agent patch application",
          reason: "Applying the proposed patch changes local project files, so Javis needs explicit approval.",
          dryRun: createCodeApplyDryRun(proposedEdit),
        });

        emit({
          ...snapshot,
          title: "Code Agent patch approval needed",
          status: "waiting_permission",
          commanderMessage:
            "Patch proposal is ready. Review the proposed changes before approving or denying the write step.",
          plan: markStep(snapshot.plan, "step-propose-code-edit", "completed", "step-apply-code-edit", "running"),
          agents: setTrackedAgentStates(agentTracker, [
            { agentId: "agent-commander", status: "waiting_permission", task: "Waiting for patch approval" },
            { agentId: "agent-code", status: "waiting_permission", task: `${proposedEdit.changedFiles.length} proposed file change(s)` },
            { agentId: "agent-verifier", status: "queued", task: "Waiting for permission decision" },
          ]),
          codeReviewPreview,
          codeProposedEdit: proposedEdit,
          commands: [verification],
          permissionRequest: applyPermissionRequest,
          tokenUsage,
          logs: appendLog(snapshot, {
            id: `${taskId}-apply-permission-requested`,
            kind: "permission",
            title: "permission.requested",
            detail: `${proposedEdit.changedFiles.length} proposed file change(s) require confirmed_write approval.`,
          }),
        });

        setPendingPermissionHandler(applyPermissionRequest.id, async (applyDecision) => {
          const resolvedApplyRequest: ToolPermissionRequest = resolvePermissionRequest(
            applyPermissionRequest,
            applyDecision,
          );
          setPendingPermissionHandler(applyPermissionRequest.id, undefined);

          if (applyDecision === "denied") {
            emit({
              ...snapshot,
              title: "Code Agent patch denied",
              status: "completed",
              commanderMessage:
                "Permission was denied. Javis kept the patch proposal as a preview and did not modify files.",
              plan: snapshot.plan.map((step) => ({
                ...step,
                status: step.id === "step-apply-code-edit" ? "skipped" : "completed",
              })),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                { agentId: "agent-code", status: "completed", task: "Patch proposal kept read-only" },
                { agentId: "agent-verifier", status: "completed", task: "Verified denial record" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-apply-denied`,
                kind: "permission",
                title: "permission.resolved",
                detail: `User denied ${applyPermissionRequest.id}; no patch was applied.`,
              }),
              verificationSummary: "verified: Code Agent patch was denied and no write operation was executed.",
            });
            return;
          }

          const approvedProposalSafetyError = validateCodeProposal(proposedEdit);
          if (approvedProposalSafetyError) {
            emit({
              ...snapshot,
              title: "Code Agent patch approval is stale",
              status: "failed",
              commanderMessage:
                "The approved patch proposal no longer matches its recorded hash, so Javis refused to apply it.",
              plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                { agentId: "agent-code", status: "failed", task: "Approved patch hash mismatch" },
                { agentId: "agent-verifier", status: "cancelled", task: "No write result to verify" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-approved-patch-mismatch`,
                kind: "permission",
                title: "task.failed",
                detail: approvedProposalSafetyError,
              }),
            });
            return;
          }

          if (!codeTool.applyProposedEdit) {
            emit({
              ...snapshot,
              title: "Code Agent apply backend unavailable",
              status: "failed",
              commanderMessage:
                "Permission was approved, but the confirmed-write Code Agent apply backend is not configured.",
              plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                { agentId: "agent-code", status: "failed", task: "Apply backend unavailable" },
                { agentId: "agent-verifier", status: "cancelled", task: "No write result to verify" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-apply-missing`,
                kind: "tool",
                title: "task.failed",
                detail: "code.applyProposedEdit is not configured.",
              }),
            });
            return;
          }

          emit({
            ...snapshot,
            title: "Applying approved Code Agent patch",
            status: "running",
            commanderMessage:
              "Permission was approved. Code Agent is applying only the current patch proposal.",
            plan: markStep(snapshot.plan, "step-apply-code-edit", "running"),
            agents: setTrackedAgentStates(agentTracker, [
              { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
              { agentId: "agent-code", status: "running", task: "Applying approved patch" },
              { agentId: "agent-verifier", status: "queued", task: "Waiting for post-apply check" },
            ]),
            codeReviewPreview,
            codeProposedEdit: proposedEdit,
            commands: [verification],
            permissionRequest: resolvedApplyRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-apply-started`,
              kind: "permission",
              title: "permission.resolved",
              detail: `User approved ${applyPermissionRequest.id}; applying proposed patch.`,
            }),
          });

          try {
            const applyResult = await codeTool.applyProposedEdit(proposedEdit, {
              approvalId: resolvedApplyRequest.id,
            });
            const applySafetyError = validateCodeApplyResult(proposedEdit, applyResult);
            if (applySafetyError) {
              emit({
                ...snapshot,
                title: "Code Agent patch result failed safety check",
                status: "failed",
                commanderMessage:
                  "Code Agent reported an apply result that did not match the approved proposal.",
                plan: markStep(snapshot.plan, "step-apply-code-edit", "failed"),
                agents: setTrackedAgentStates(agentTracker, [
                  { agentId: "agent-commander", status: "failed", task: "Apply safety check failed" },
                  { agentId: "agent-code", status: "failed", task: applySafetyError },
                  { agentId: "agent-verifier", status: "cancelled", task: "Post-apply check skipped" },
                ]),
                codeReviewPreview,
                codeProposedEdit: proposedEdit,
                codeApplyResult: applyResult,
                commands: [verification],
                permissionRequest: resolvedApplyRequest,
                logs: appendLog(snapshot, {
                  id: `${taskId}-apply-safety-failed`,
                  kind: "tool",
                  title: "task.failed",
                  detail: applySafetyError,
                }),
                verificationSummary: `failed: ${applySafetyError}`,
              });
              return;
            }
            const postApplyVerification = await shellTool.runReadOnlyCommand({
              program: "git",
              args: ["diff", "--check"],
              workspacePath: null,
            });
            const applyStatus =
              applyResult.applied && postApplyVerification.exitCode === 0 ? "completed" : "failed";

            const applySynthesis = applyStatus === "completed"
              ? await safeSynthesizeConclusion(
                  commanderTool, userGoal, "Code Agent patch applied", {
                    codeReviewPreview,
                    codeProposedEdit: proposedEdit,
                    codeApplyResult: applyResult,
                    verification,
                    postApplyVerification,
                  },
                )
              : undefined;

            emit({
              ...snapshot,
              title:
                applyStatus === "completed"
                  ? "Code Agent patch applied"
                  : "Code Agent patch verification failed",
              status: applyStatus,
              commanderMessage: applySynthesis?.message
                ?? (applyStatus === "completed"
                  ? "Approved patch was applied and the post-apply diff check passed."
                  : "The patch apply step finished, but post-apply verification did not pass."),
              plan:
                applyStatus === "completed"
                  ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
                  : markCodeReviewApplyFailed(snapshot.plan),
              agents: setTrackedAgentStates(agentTracker, [
                {
                  agentId: "agent-commander",
                  status: applyStatus === "completed" ? "completed" : "failed",
                  task: applyStatus === "completed" ? "Task finished" : "Verification failed",
                },
                {
                  agentId: "agent-code",
                  status: applyStatus === "completed" ? "completed" : "failed",
                  task: applyResult.message,
                },
                {
                  agentId: "agent-verifier",
                  status: applyStatus === "completed" ? "completed" : "failed",
                  task: `${postApplyVerification.exitCode ?? "unknown"} post-apply diff check exit code`,
                },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              codeApplyResult: applyResult,
              commands: [verification, postApplyVerification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-apply-done`,
                kind: "verification",
                title: applyStatus === "completed" ? "task.completed" : "verification.failed",
                detail: `code.applyProposedEdit applied=${applyResult.applied}; post-apply git diff --check exit code ${postApplyVerification.exitCode ?? "unknown"}.`,
              }),
              verificationSummary:
                applyStatus === "completed"
                  ? `verified: approved Code Agent patch applied to ${applyResult.changedFiles.length} file(s), and post-apply git diff --check passed.`
                  : `failed: Code Agent apply result was ${applyResult.applied ? "applied" : "not applied"} and post-apply git diff --check returned exit code ${postApplyVerification.exitCode ?? "unknown"}.`,
            });
          } catch (error) {
            emit({
              ...snapshot,
              title: "Code Agent patch application failed",
              status: "failed",
              commanderMessage:
                "Code Agent could not apply the approved patch or run post-apply verification.",
              plan: markCodeReviewApplyFailed(snapshot.plan),
              agents: setTrackedAgentStates(agentTracker, [
                { agentId: "agent-commander", status: "completed", task: "Permission decision recorded" },
                { agentId: "agent-code", status: "failed", task: "Patch application failed" },
                { agentId: "agent-verifier", status: "failed", task: "Post-apply verification unavailable" },
              ]),
              codeReviewPreview,
              codeProposedEdit: proposedEdit,
              commands: [verification],
              permissionRequest: resolvedApplyRequest,
              logs: appendLog(snapshot, {
                id: `${taskId}-apply-failed`,
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

function markCodeReviewApplyFailed(steps: TaskStep[]): TaskStep[] {
  return steps.map((step) => {
    if (step.id === "step-apply-code-edit") {
      return { ...step, status: "failed" };
    }
    return step;
  });
}
