import type {
  FileTool,
  PermissionRequest as ToolPermissionRequest,
} from "@javis/tools";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import {
  createConfirmedWriteApproval,
  type PendingPermissionHandler,
} from "./confirmed-write";
import type { FlowController } from "./file-scan-flow";
import type { ID } from "./index";
import { createPdfOrganizationPlan, markStep } from "./plans";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";

interface PdfOrganizationFlowOptions {
  controller: FlowController;
  fileTool: FileTool;
  taskId: ID;
  userGoal: string;
  setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
}

export async function runPdfOrganizationPreviewTask({
  controller,
  fileTool,
  taskId,
  userGoal,
  setPendingPermissionHandler,
}: PdfOrganizationFlowOptions) {
  const plan = createPdfOrganizationPlan();
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "file", "verifier"].includes(agent.kind)),
  );
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: Parameters<FlowController["emit"]>[0]) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Create dry-run plan",
    currentStepId: "step-plan-pdf",
  });
  agentTracker.setState("agent-file", {
    status: "queued",
    task: "Waiting for file.planPdfOrganization",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for dry-run evidence",
  });

  emit({
    id: taskId,
    title: "Planning PDF organization",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a high-risk file organization request and will create a dry-run before any write action.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the PDF organization goal to Core.",
      },
    ],
  });

  await controller.wait();

  agentTracker.setState("agent-commander", {
    status: "completed",
    task: "Plan submitted",
  });
  agentTracker.setState("agent-file", {
    status: "running",
    task: "Creating PDF organization dry-run",
    currentStepId: "step-plan-pdf",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for dry-run evidence",
  });

  emit({
    ...snapshot,
    status: "running",
    commanderMessage: "File Agent is creating a preview plan. No files are being moved.",
    plan: markStep(snapshot.plan, "step-plan-pdf", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(snapshot, {
      id: `${taskId}-preview-started`,
      kind: "tool",
      title: "tool_call.planned",
      detail: "file.planPdfOrganization uses preview permission and does not modify local files.",
    }),
  });

  try {
    const organizationPlan = await fileTool.planPdfOrganization?.(taskId);
    if (!organizationPlan) {
      throw new Error("PDF organization preview tool is not available.");
    }
    if (organizationPlan.fileCount === 0) {
      agentTracker.setState("agent-commander", {
        status: "completed",
        task: "Task finished",
      });
      agentTracker.setState("agent-file", {
        status: "completed",
        task: "No PDF files found",
      });
      agentTracker.setState("agent-verifier", {
        status: "completed",
        task: "Verified no-op result",
      });

      emit({
        ...snapshot,
        title: "No PDFs found to organize",
        status: "completed",
        commanderMessage:
          "File Agent did not find PDF files in Downloads, so no permission request or write step is needed.",
        plan: snapshot.plan.map((step) => ({
          ...step,
          status: step.id === "step-plan-pdf" ? "completed" : "skipped",
        })),
        agents: agentTracker.getSnapshots(),
        fileOrganizationPlan: organizationPlan,
        logs: appendLog(snapshot, {
          id: `${taskId}-no-pdfs`,
          kind: "verification",
          title: "task.completed",
          detail: "Dry-run found 0 PDF files, so no confirmed_write request was created.",
        }),
        verificationSummary: "verified: no PDF files were found in Downloads, and no files were moved.",
      });
      return;
    }
    const confirmedWriteApproval = createConfirmedWriteApproval({
      request: {
        id: `${taskId}-permission`,
        title: "Approve PDF move plan",
        reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
        dryRun: organizationPlan.dryRun,
      },
      setPendingPermissionHandler,
      onDenied(resolvedRequest) {
        agentTracker.setState("agent-commander", {
          status: "completed",
          task: "Permission decision recorded",
        });
        agentTracker.setState("agent-file", {
          status: "completed",
          task: "No write operation executed",
        });
        agentTracker.setState("agent-verifier", {
          status: "completed",
          task: "Verified denial record",
        });

        emit({
          ...snapshot,
          title: "PDF organization denied",
          status: "completed",
          commanderMessage: "Permission was denied. Javis did not move or modify any files.",
          plan: snapshot.plan.map((step) => ({
            ...step,
            status: step.id === "step-execute-pdf" ? "skipped" : "completed",
          })),
          agents: agentTracker.getSnapshots(),
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-permission-denied`,
            kind: "permission",
            title: "permission.resolved",
            detail: `User denied ${permissionRequest.id}; no files were moved.`,
          }),
          verificationSummary: `verified: permission denied; dry-run listed ${organizationPlan.fileCount} affected PDF file(s), and no write operation was executed.`,
        });
      },
      async onApproved(resolvedRequest) {
        if (!fileTool.executePdfOrganization) {
          agentTracker.setState("agent-commander", {
            status: "completed",
            task: "Permission decision recorded",
          });
          agentTracker.setState("agent-file", {
            status: "failed",
            task: "Execution tool unavailable",
          });
          agentTracker.setState("agent-verifier", {
            status: "cancelled",
            task: "No write result to verify",
          });

          emit({
            ...snapshot,
            title: "PDF organization execution unavailable",
            status: "failed",
            commanderMessage:
              "Permission was approved, but the confirmed-write File Tool is not available.",
            plan: markStep(snapshot.plan, "step-execute-pdf", "failed"),
            agents: agentTracker.getSnapshots(),
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-execute-missing`,
              kind: "tool",
              title: "task.failed",
              detail: "file.executePdfOrganization is not configured.",
            }),
          });
          return;
        }

        agentTracker.setState("agent-commander", {
          status: "completed",
          task: "Permission decision recorded",
        });
        agentTracker.setState("agent-file", {
          status: "running",
          task: "Executing approved PDF moves",
          currentStepId: "step-execute-pdf",
        });
        agentTracker.setState("agent-verifier", {
          status: "queued",
          task: "Waiting for move results",
        });

        emit({
          ...snapshot,
          title: "Executing approved PDF organization",
          status: "running",
          commanderMessage:
            "Permission was approved. File Agent is moving only the paths from the current dry-run plan.",
          plan: markStep(snapshot.plan, "step-confirm-pdf", "completed", "step-execute-pdf", "running"),
          agents: agentTracker.getSnapshots(),
          permissionRequest: resolvedRequest,
          logs: appendLog(snapshot, {
            id: `${taskId}-execute-started`,
            kind: "permission",
            title: "permission.resolved",
            detail: `User approved ${permissionRequest.id}; executing exactly ${organizationPlan.fileCount} planned move(s).`,
          }),
        });

        try {
          const execution = await fileTool.executePdfOrganization(
            organizationPlan.dryRun.affectedPaths,
            organizationPlan.approvalId,
            taskId,
          );
          const verificationStatus = execution.failedCount === 0 ? "completed" : "failed";
          agentTracker.setState("agent-commander", {
            status: "completed",
            task: "Task finished",
          });
          agentTracker.setState("agent-file", {
            status: "completed",
            task: `${execution.movedCount} moved, ${execution.skippedCount} skipped`,
          });
          agentTracker.setState("agent-verifier", {
            status: verificationStatus === "completed" ? "completed" : "failed",
            task: `${execution.failedCount} failed`,
          });

          emit({
            ...snapshot,
            title:
              verificationStatus === "completed"
                ? "PDF organization completed"
                : "PDF organization completed with failures",
            status: verificationStatus,
            commanderMessage:
              verificationStatus === "completed"
                ? "Approved PDF moves finished and Verifier checked the execution summary."
                : "Approved PDF moves finished, but at least one operation failed.",
            plan:
              verificationStatus === "completed"
                ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
                : markStep(snapshot.plan, "step-verify-pdf", "failed"),
            agents: agentTracker.getSnapshots(),
            fileOrganizationExecution: execution,
            permissionRequest: resolvedRequest,
            logs: [
              ...appendLog(snapshot, {
                id: `${taskId}-execute-done`,
                kind: "tool",
                title: "tool_call.updated",
                detail: `file.executePdfOrganization moved=${execution.movedCount}, skipped=${execution.skippedCount}, failed=${execution.failedCount}.`,
              }),
              ...execution.results.map((result, index) => ({
                id: `${taskId}-move-${index}`,
                kind: "tool" as const,
                title: `${result.status}: ${result.source}`,
                detail: `${result.target} - ${result.message}`,
              })),
            ],
            verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${execution.movedCount}/${execution.attemptedCount} PDF move(s) completed, ${execution.skippedCount} skipped, ${execution.failedCount} failed.`,
          });
        } catch (error) {
          agentTracker.setState("agent-commander", {
            status: "completed",
            task: "Permission decision recorded",
          });
          agentTracker.setState("agent-file", {
            status: "failed",
            task: "Approved move failed",
          });
          agentTracker.setState("agent-verifier", {
            status: "cancelled",
            task: "No complete result to verify",
          });

          emit({
            ...snapshot,
            title: "PDF organization execution failed",
            status: "failed",
            commanderMessage:
              "The approved write step failed. Verifier has no completed move result to validate.",
            plan: markStep(snapshot.plan, "step-execute-pdf", "failed"),
            agents: agentTracker.getSnapshots(),
            permissionRequest: resolvedRequest,
            logs: appendLog(snapshot, {
              id: `${taskId}-execute-failed`,
              kind: "tool",
              title: "task.failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      },
    });
    const permissionRequest: ToolPermissionRequest = confirmedWriteApproval.permissionRequest;

    agentTracker.setState("agent-commander", {
      status: "waiting_permission",
      task: "Waiting for user approval",
      currentStepId: "step-confirm-pdf",
    });
    agentTracker.setState("agent-file", {
      status: "waiting_permission",
      task: `${organizationPlan.fileCount} PDF move(s) planned`,
    });
    agentTracker.setState("agent-verifier", {
      status: "queued",
      task: "Waiting for permission decision",
    });

    emit({
      ...snapshot,
      title: "PDF organization approval needed",
      status: "waiting_permission",
      commanderMessage:
        "Dry-run is ready. Review the affected paths before approving or denying the write step.",
      plan: markStep(snapshot.plan, "step-plan-pdf", "completed", "step-confirm-pdf", "running"),
      agents: agentTracker.getSnapshots(),
      fileOrganizationPlan: organizationPlan,
      permissionRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: `${organizationPlan.fileCount} planned move(s) require confirmed_write approval.`,
      }),
    });

    confirmedWriteApproval.listenForDecision();
  } catch (error) {
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Plan submitted",
    });
    agentTracker.setState("agent-file", {
      status: "failed",
      task: "Dry-run failed",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No dry-run to verify",
    });

    emit({
      ...snapshot,
      title: "PDF organization preview failed",
      status: "failed",
      commanderMessage:
        "File Agent could not create the dry-run. The task stopped without moving files.",
      plan: markStep(snapshot.plan, "step-plan-pdf", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}
