import type { FileTool } from "@javis/tools";
import { summarizeMarkdownDocuments } from "@javis/tools";
import {
  commanderSnapshot,
  fileSnapshot,
  verifierSnapshot,
} from "./agents";
import { createFileScanPlan, markStep } from "./plans";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";
import type { ID, TaskSnapshot } from "./index";

export interface FlowController {
  emit(nextSnapshot: TaskSnapshot): void;
  getSnapshot(): TaskSnapshot;
  wait(): Promise<void>;
}

export async function runFileScanTask(
  controller: FlowController,
  fileTool: FileTool,
  taskId: ID,
  userGoal: string,
) {
  const plan = createFileScanPlan();

  controller.emit({
    id: taskId,
    title: "Scanning workspace documents",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a local document scan and prepared a read-only File Tool call.",
    plan,
    agents: [
      commanderSnapshot("planning", "Create document scan plan"),
      fileSnapshot("queued", "Waiting for file.scanMarkdownDocuments"),
      verifierSnapshot("queued", "Waiting for file scan results"),
    ],
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

  controller.emit({
    ...controller.getSnapshot(),
    title: "Scanning workspace documents",
    status: "running",
    commanderMessage:
      "File Agent is scanning Markdown documents through the Tauri desktop bridge.",
    plan: markStep(controller.getSnapshot().plan, "step-scan-markdown", "running"),
    agents: [
      commanderSnapshot("completed", "Plan submitted"),
      fileSnapshot("running", "Running read-only Markdown scan"),
      verifierSnapshot("queued", "Waiting for scan results"),
    ],
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
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("completed", `Found ${documents.length} Markdown documents`),
        verifierSnapshot("queued", "Waiting for verification"),
      ],
      documents,
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-tool-done`,
        kind: "tool",
        title: "tool_call.updated",
        detail: `file.scanMarkdownDocuments succeeded with ${documents.length} records.`,
      }),
    });

    await controller.wait();

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
      agents: [
        commanderSnapshot("completed", "Waiting for verification"),
        fileSnapshot("completed", "Document scan and summaries completed"),
        verifierSnapshot("verifying", "Checking document result fields"),
      ],
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

    controller.emit({
      ...controller.getSnapshot(),
      title:
        verificationStatus === "completed"
          ? "Workspace documents scanned"
          : "Document scan verification failed",
      status: verificationStatus,
      commanderMessage:
        verificationStatus === "completed"
          ? "Document scan completed with read-only filesystem evidence."
          : "Document scan finished, but Verifier found incomplete records.",
      plan:
        verificationStatus === "completed"
          ? controller.getSnapshot().plan.map((step) => ({ ...step, status: "completed" }))
          : markStep(controller.getSnapshot().plan, "step-verify-docs", "failed"),
      agents: [
        commanderSnapshot("completed", "Task finished"),
        fileSnapshot("completed", "Read-only scan completed"),
        verifierSnapshot(
          verificationStatus === "completed" ? "completed" : "failed",
          `${validCount}/${documents.length} records verified`,
        ),
      ],
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
    controller.emit({
      ...controller.getSnapshot(),
      title: "Document scan failed",
      status: "failed",
      commanderMessage:
        "File Agent scan failed. The task stopped without running any write operation.",
      plan: markStep(controller.getSnapshot().plan, "step-scan-markdown", "failed"),
      agents: [
        commanderSnapshot("completed", "Plan submitted"),
        fileSnapshot("failed", "Scan failed"),
        verifierSnapshot("cancelled", "No result to verify"),
      ],
      logs: appendLog(controller.getSnapshot(), {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: message,
      }),
    });
  }
}
