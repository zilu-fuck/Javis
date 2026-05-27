import type { CommanderTool, FileTool } from "@javis/tools";
import { summarizeMarkdownDocuments } from "@javis/tools";
import { createAgentStateTracker } from "./agent-state-tracker";
import { demoAgents } from "./agents";
import { createFileScanPlan, markStep } from "./plans";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";
import type { FlowController } from "./flow-controller";
import type { ID } from "./index";
import { safeSynthesizeConclusion } from "./workflow-executor";
export type { FlowController } from "./flow-controller";

export async function runFileScanTask(
  controller: FlowController,
  fileTool: FileTool,
  taskId: ID,
  userGoal: string,
  commanderTool?: CommanderTool,
) {
  const plan = createFileScanPlan();
  const agentTracker = createAgentStateTracker(
    demoAgents.filter((agent) => ["commander", "file", "verifier"].includes(agent.kind)),
  );

  agentTracker.setState("agent-commander", {
    status: "planning",
    task: "Create document scan plan",
    currentStepId: "step-scan-markdown",
  });
  agentTracker.setState("agent-file", {
    status: "queued",
    task: "Waiting for file.scanMarkdownDocuments",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for file scan results",
  });

  controller.emit({
    id: taskId,
    title: "Scanning workspace documents",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a local document scan and prepared a read-only File Tool call.",
    plan,
    agents: agentTracker.getSnapshots(),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the user goal to Core.",
      },
      {
        id: `${taskId}-plan`,
        kind: "plan",
        title: "task.plan_updated",
        detail:
          "Plan includes read-only Markdown scan, purpose summary, and result verification.",
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
    task: "Running read-only Markdown scan",
    currentStepId: "step-scan-markdown",
  });
  agentTracker.setState("agent-verifier", {
    status: "queued",
    task: "Waiting for scan results",
  });

  controller.emit({
    ...controller.getSnapshot(),
    title: "Scanning workspace documents",
    status: "running",
    commanderMessage:
      "File Agent is scanning Markdown documents through the Tauri desktop bridge.",
    plan: markStep(controller.getSnapshot().plan, "step-scan-markdown", "running"),
    agents: agentTracker.getSnapshots(),
    logs: appendLog(controller.getSnapshot(), {
      id: `${taskId}-tool-planned`,
      kind: "tool",
      title: "tool_call.planned",
      detail:
        "file.scanMarkdownDocuments uses read permission and does not modify local files.",
    }),
  });

  try {
    const documents = summarizeMarkdownDocuments(await fileTool.scanMarkdownDocuments());

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Plan submitted",
    });
    agentTracker.setState("agent-file", {
      status: "completed",
      task: `Found ${documents.length} Markdown documents`,
    });
    agentTracker.setState("agent-verifier", {
      status: "queued",
      task: "Waiting for verification",
    });

    controller.emit({
      ...controller.getSnapshot(),
      title: "Summarizing workspace documents",
      status: "running",
      commanderMessage: `File Agent found ${documents.length} Markdown documents and generated purpose summaries.`,
      plan: markStep(
        controller.getSnapshot().plan,
        "step-scan-markdown",
        "completed",
        "step-summarize",
        "running",
      ),
      agents: agentTracker.getSnapshots(),
      documents,
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-tool-done`,
        kind: "tool",
        title: "tool_call.updated",
        detail: `file.scanMarkdownDocuments succeeded with ${documents.length} records.`,
      }),
    });

    await controller.wait();

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Waiting for verification",
    });
    agentTracker.setState("agent-file", {
      status: "completed",
      task: "Document scan and summaries completed",
    });
    agentTracker.setState("agent-verifier", {
      status: "verifying",
      task: "Checking document result fields",
      currentStepId: "step-verify-docs",
    });

    controller.emit({
      ...controller.getSnapshot(),
      title: "Verifying workspace documents",
      status: "verifying",
      commanderMessage:
        "Verifier is checking that each result includes a path, modified time, size, and purpose.",
      plan: markStep(
        controller.getSnapshot().plan,
        "step-summarize",
        "completed",
        "step-verify-docs",
        "running",
      ),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-verify`,
        kind: "verification",
        title: "verification.started",
        detail:
          "Checking each document record for path, modifiedAt, sizeBytes, and purpose.",
      }),
    });

    await controller.wait();

    const validCount = documents.filter(
      (document) =>
        Boolean(document.path) &&
        Boolean(document.modifiedAt) &&
        document.sizeBytes >= 0 &&
        Boolean(document.purpose),
    ).length;
    const verificationStatus = validCount === documents.length ? "completed" : "failed";
    const synthesis = verificationStatus === "completed"
      ? await safeSynthesizeConclusion(commanderTool, userGoal, "Workspace documents scanned", {
          fileScan: { documents, count: documents.length },
          verificationStatus,
        })
      : undefined;

    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Task finished",
    });
    agentTracker.setState("agent-file", {
      status: "completed",
      task: "Read-only scan completed",
    });
    agentTracker.setState("agent-verifier", {
      status: verificationStatus === "completed" ? "completed" : "failed",
      task: `${validCount}/${documents.length} records verified`,
    });

    controller.emit({
      ...controller.getSnapshot(),
      title:
        verificationStatus === "completed"
          ? "Workspace documents scanned"
          : "Document scan verification failed",
      status: verificationStatus,
      commanderMessage: synthesis?.message
        ?? (verificationStatus === "completed"
          ? "Document scan completed with read-only filesystem evidence."
          : "Document scan finished, but Verifier found incomplete records."),
      plan:
        verificationStatus === "completed"
          ? controller.getSnapshot().plan.map((step) => ({ ...step, status: "completed" }))
          : markStep(controller.getSnapshot().plan, "step-verify-docs", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-done`,
        kind: "verification",
        title:
          verificationStatus === "completed"
            ? "verification.completed"
            : "verification.failed",
        detail: `Verifier checked ${validCount}/${documents.length} document records.`,
      }),
      verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${documents.length} documents include path, modified time, size, and purpose.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentTracker.setState("agent-commander", {
      status: "completed",
      task: "Plan submitted",
    });
    agentTracker.setState("agent-file", {
      status: "failed",
      task: "Scan failed",
    });
    agentTracker.setState("agent-verifier", {
      status: "cancelled",
      task: "No result to verify",
    });

    controller.emit({
      ...controller.getSnapshot(),
      title: "Document scan failed",
      status: "failed",
      commanderMessage:
        "File Agent scan failed. The task stopped without running any write operation.",
      plan: markStep(controller.getSnapshot().plan, "step-scan-markdown", "failed"),
      agents: agentTracker.getSnapshots(),
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: message,
      }),
    });
  }
}
