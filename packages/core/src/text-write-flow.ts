import type {
  CommanderTool,
  FileTool,
  PermissionRequest as ToolPermissionRequest,
  WebSearchResult,
  WebTool,
} from "@javis/tools";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import {
  createConfirmedWriteApproval,
  type PendingPermissionHandler,
} from "./confirmed-write";
import type { FlowController } from "./flow-controller";
import type { ID } from "./index";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";

interface TextWriteFlowOptions {
  controller: FlowController;
  fileTool: FileTool;
  webTool?: WebTool;
  commanderTool?: CommanderTool;
  taskId: ID;
  userGoal: string;
  setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
}

export function isTextWriteGoal(userGoal: string): boolean {
  // Require an explicit "save/write/export" action verb, not just a mention
  // of "markdown" or "file" in a question context.
  const hasWriteAction =
    /\b(write|save|export|create|generate)\b.*\b(file|md|markdown|notes?|document)\b/i.test(userGoal)
    || /\b(write|save|export)\s+(to|as|a|the)\b/i.test(userGoal)
    || /\u5199\u6210|\u4fdd\u5b58|\u5bfc\u51fa|\u751f\u6210/i.test(userGoal);
  const hasFileTarget =
    /\.md\b|markdown|\u6587\u4ef6|\u6587\u6863/i.test(userGoal);
  return hasWriteAction && hasFileTarget;
}

export async function runTextWriteTask({
  controller,
  fileTool,
  webTool,
  taskId,
  userGoal,
  setPendingPermissionHandler,
}: TextWriteFlowOptions) {
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "research", "file", "verifier"].includes(agent.kind)),
  );
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: Parameters<FlowController["emit"]>[0]) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }

  const plan = [
    { id: "step-prepare-text", title: "Commander prepares Markdown content", assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-preview-write", title: "File Agent creates a text write dry-run", assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-confirm-write", title: "User reviews the confirmed-write permission card", assignedAgentKind: "commander" as const, status: "pending" as const },
    { id: "step-write-text", title: "File Agent writes the approved text file", assignedAgentKind: "file" as const, status: "pending" as const },
    { id: "step-verify-write", title: "Verifier confirms the write result", assignedAgentKind: "verifier" as const, status: "pending" as const },
  ];

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Prepare text write workflow",
    currentStepId: "step-prepare-text",
  });
  agentTracker.setState("agent-file", { status: "queued", task: "Waiting for Markdown content" });
  agentTracker.setState("agent-verifier", { status: "queued", task: "Waiting for write result" });

  emit({
    id: taskId,
    title: "Preparing text file write",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander is preparing text content and will request confirmed-write approval before writing a file.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the text file write goal to Core.",
      },
    ],
  });

  await controller.wait();

  try {
    const targetPath = inferMarkdownTargetPath(userGoal);
    const sources = await collectWriteSources(userGoal, webTool);
    const content = createMarkdownContent(userGoal, sources);

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Markdown content prepared",
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: "Creating text write dry-run",
      currentStepId: "step-preview-write",
    });

    emit({
      ...snapshot,
      status: "running",
      title: "Previewing text file write",
      commanderMessage: `File Agent is preparing a dry-run for ${targetPath}. No file has been written.`,
      plan: markTextWriteStep(snapshot.plan, "step-prepare-text", "completed", "step-preview-write", "running"),
      agents: agentTracker.getSnapshots(),
      sources,
      logs: appendLog(snapshot, {
        id: `${taskId}-preview-started`,
        kind: "tool",
        title: "tool_call.planned",
        detail: "file.planWriteText uses preview permission and does not modify local files.",
      }),
    });

    const writePlan = await fileTool.planWriteText?.({ targetPath, content }, taskId);
    if (!writePlan) {
      throw new Error("Text write preview tool is not available.");
    }

    const confirmedWriteApproval = createConfirmedWriteApproval({
      request: {
        id: `${taskId}-permission`,
        title: "Approve text file write",
        reason: "Writing text to a local file changes the filesystem, so Javis needs explicit approval.",
        dryRun: writePlan.dryRun,
      },
      setPendingPermissionHandler,
      onDenied(resolvedRequest) {
        emitDeniedTextWrite({ resolvedRequest, targetPath });
      },
      async onApproved(resolvedRequest) {
        await emitApprovedTextWrite({ resolvedRequest, targetPath, content, approvalId: writePlan.approvalId });
      },
    });
    const permissionRequest: ToolPermissionRequest = confirmedWriteApproval.permissionRequest;
    confirmedWriteApproval.listenForDecision();

    agentTracker.setState("agent-file", {
      status: "completed",
      task: "Dry-run ready",
    });
    agentTracker.setState("agent-commander", {
      status: "waiting_permission",
      task: "Waiting for write approval",
      currentStepId: "step-confirm-write",
    });

    emit({
      ...snapshot,
      status: "waiting_permission",
      title: "Text file write needs approval",
      commanderMessage:
        "Dry-run is ready. Review the target path and content size before approving or denying the write step.",
      plan: markTextWriteStep(snapshot.plan, "step-preview-write", "completed", "step-confirm-write", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest,
      sources,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-requested`,
        kind: "permission",
        title: "permission.requested",
        detail: `${writePlan.action} ${writePlan.targetPath} requires confirmed_write approval.`,
      }),
    });
  } catch (error) {
    emit({
      ...snapshot,
      status: "failed",
      commanderMessage: "Text file write preparation failed before any write approval was requested.",
      plan: markTextWriteStep(snapshot.plan, "step-preview-write", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "verification",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }

  function emitDeniedTextWrite({
    resolvedRequest,
    targetPath,
  }: {
    resolvedRequest: ToolPermissionRequest;
    targetPath: string;
  }) {
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
      title: "Text file write denied",
      status: "completed",
      commanderMessage: "Permission was denied. Javis did not write or modify any file.",
      plan: snapshot.plan.map((step) => ({
        ...step,
        status: step.id === "step-write-text" ? "skipped" : "completed",
      })),
      agents: agentTracker.getSnapshots(),
      permissionRequest: resolvedRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-permission-denied`,
        kind: "permission",
        title: "permission.resolved",
        detail: `User denied ${resolvedRequest.id}; ${targetPath} was not written.`,
      }),
      verificationSummary: "verified: permission denied; no write operation was executed.",
    });
  }

  async function emitApprovedTextWrite({
    resolvedRequest,
    targetPath,
    content,
    approvalId,
  }: {
    resolvedRequest: ToolPermissionRequest;
    targetPath: string;
    content: string;
    approvalId: string;
  }) {
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Permission decision recorded",
    });
    agentTracker.setState("agent-file", {
      status: "running",
      task: "Writing approved text file",
      currentStepId: "step-write-text",
    });

    emit({
      ...snapshot,
      status: "running",
      commanderMessage: "Permission was approved. File Agent is writing only the approved text content.",
      plan: markTextWriteStep(snapshot.plan, "step-confirm-write", "completed", "step-write-text", "running"),
      agents: agentTracker.getSnapshots(),
      permissionRequest: resolvedRequest,
      logs: appendLog(snapshot, {
        id: `${taskId}-write-started`,
        kind: "tool",
        title: "tool_call.started",
        detail: `file.writeText started for ${targetPath}.`,
      }),
    });

    try {
      if (!fileTool.writeText) {
        throw new Error("Text write execution tool is not available.");
      }
      const result = await fileTool.writeText({ targetPath, content }, approvalId, taskId);
      agentTracker.setState("agent-file", {
        status: "completed",
        task: `Wrote ${result.byteCount} bytes`,
      });
      agentTracker.setState("agent-verifier", {
        status: "completed",
        task: "Verified write result",
      });

      emit({
        ...snapshot,
        title: "Text file written",
        status: "completed",
        commanderMessage: `File Agent wrote ${result.targetPath}.`,
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "completed", "step-verify-write", "completed"),
        agents: agentTracker.getSnapshots(),
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-completed`,
          kind: "verification",
          title: "task.completed",
          detail: `file.writeText ${result.action} wrote ${result.byteCount} byte(s) to ${result.targetPath}.`,
        }),
        verificationSummary: `verified: ${result.targetPath} was written after confirmed_write approval.`,
      });
    } catch (error) {
      agentTracker.setState("agent-commander", {
        status: "completed",
        task: "Permission decision recorded",
      });
      agentTracker.setState("agent-file", {
        status: "failed",
        task: "Approved text write failed",
      });
      agentTracker.setState("agent-verifier", {
        status: "cancelled",
        task: "No complete result to verify",
      });

      emit({
        ...snapshot,
        title: "Text file write failed",
        status: "failed",
        commanderMessage:
          "The approved write step failed. Verifier has no completed file write result to validate.",
        plan: markTextWriteStep(snapshot.plan, "step-write-text", "failed"),
        agents: agentTracker.getSnapshots(),
        permissionRequest: resolvedRequest,
        logs: appendLog(snapshot, {
          id: `${taskId}-write-failed`,
          kind: "tool",
          title: "task.failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
}

function markTextWriteStep(
  plan: ReturnType<FlowController["getSnapshot"]>["plan"],
  firstStepId: string | undefined,
  firstStatus: "completed" | "failed",
  secondStepId?: string,
  secondStatus?: "running" | "completed",
) {
  return plan.map((step) => {
    if (step.id === firstStepId) {
      return { ...step, status: firstStatus };
    }
    if (step.id === secondStepId && secondStatus) {
      return { ...step, status: secondStatus };
    }
    return step;
  });
}

async function collectWriteSources(
  userGoal: string,
  webTool?: WebTool,
): Promise<WebSearchResult[]> {
  if (!webTool?.searchWeb || !/search|research|latest|hot|trend|\u641c\u7d22|\u67e5|\u6700\u8fd1|\u70ed\u70b9/i.test(userGoal)) {
    return [];
  }
  return webTool.searchWeb({ query: stripTargetPath(userGoal), maxResults: 5 }).catch(() => []);
}

function createMarkdownContent(userGoal: string, sources: WebSearchResult[]): string {
  const title = inferMarkdownTitle(userGoal);
  const lines = [`# ${title}`, "", `> Generated from request: ${userGoal}`, ""];
  if (sources.length > 0) {
    lines.push("## Sources", "");
    for (const source of sources) {
      lines.push(`- [${escapeMarkdown(source.title || source.url)}](${source.url})`);
      if (source.excerpt) {
        lines.push(`  ${source.excerpt}`);
      }
    }
    lines.push("");
  } else {
    lines.push("## Notes", "", stripTargetPath(userGoal), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function inferMarkdownTargetPath(userGoal: string): string {
  const quotedPath = userGoal.match(/["'`]([^"'`]+\.md)["'`]/i)?.[1];
  if (quotedPath) return quotedPath.trim();
  const path = userGoal.match(/([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)/i)?.[1];
  return path?.trim() || "javis-output.md";
}

function inferMarkdownTitle(userGoal: string): string {
  const cleaned = stripTargetPath(userGoal)
    .replace(/save|write|export|markdown|\.md|\u4fdd\u5b58|\u5199\u6210|\u5bfc\u51fa|md/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "Javis Notes";
}

function stripTargetPath(userGoal: string): string {
  return userGoal.replace(/["'`]?([A-Za-z]:[\\/][^\s"'`]+\.md|(?:\.{1,2}[\\/])?[^\s"'`]+\.md)["'`]?/gi, "").trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}
