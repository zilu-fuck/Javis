import { describe, expect, it } from "vitest";
import type {
  GitStageExecutionQuickResult,
  GitStagePlanQuickResult,
  WorkbenchAgentSessionContext,
} from "@javis/ui";
import { createDryRunBindingHash } from "@javis/core";
import {
  GIT_STAGE_APPROVAL_TITLE,
  GIT_STAGE_AUDIT_TOOL_NAME,
  createGitStageExecutionAuditRecord,
  createGitStageFailedAuditRecord,
  createGitStagePermissionRequest,
  createGitStagePlanAuditRecord,
} from "./git-stage-audit";

describe("git stage audit records", () => {
  it("records plan, execution, and failure audit rows", () => {
    const plan = createPlan();
    const execution = createExecution();

    const planned = createGitStagePlanAuditRecord(createSession(), plan, "2026-06-10T00:00:00.000Z");
    const succeeded = createGitStageExecutionAuditRecord(
      createSession(),
      plan.approvalId,
      execution,
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );
    const failed = createGitStageFailedAuditRecord(
      createSession(),
      plan.approvalId,
      new Error("preview hash mismatch"),
      "2026-06-10T00:00:03.000Z",
      "2026-06-10T00:00:04.000Z",
    );

    expect(planned).toMatchObject({
      taskId: "task-stage",
      toolName: GIT_STAGE_AUDIT_TOOL_NAME,
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-stage-1",
    });
    expect(planned.dryRunJson).toContain("Preview Git stage selected files");
    expect(succeeded.outputSummary).toBe("Staged 1 file(s)");
    expect(failed.status).toBe("failed");
    expect(failed.errorJson).toContain("preview hash mismatch");
  });

  it("creates approval-bound permission requests", () => {
    const plan = createPlan();
    const request = createGitStagePermissionRequest(plan, "2026-06-10T00:00:00.000Z");

    expect(request).toMatchObject({
      id: "approval-stage-1",
      level: "confirmed_write",
      writeRiskLevel: "risky",
      title: GIT_STAGE_APPROVAL_TITLE,
      reason: "Staging updates the Git index for selected workspace files.",
      allowAlways: false,
      status: "pending",
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    expect(request.bindingHash).toBe(createDryRunBindingHash(plan.preview.dryRun));
  });
});

function createSession(): WorkbenchAgentSessionContext {
  return {
    sessionId: "session-stage",
    threadId: "thread-stage",
    taskId: "task-stage",
    workspaceRoot: "E:/Javis",
    activeTool: "review",
    permissionMode: "confirmed_write",
    activeModel: "test-model",
  };
}

function createPlan(): GitStagePlanQuickResult {
  return {
    approvalId: "approval-stage-1",
    preview: {
      workspaceRoot: "E:/Javis",
      files: [
        {
          path: "README.md",
          indexStatus: "",
          worktreeStatus: "M",
          action: "stage",
          contentHash: "hash-readme",
        },
      ],
      diffStat: " README.md | 1 +",
      diff: "diff --git a/README.md b/README.md",
      dryRun: {
        operation: "Preview Git stage selected files",
        riskSummary: "Preview only. No Git write was executed.",
        reversible: true,
        affectedPaths: [
          {
            source: "README.md",
            target: "README.md",
            action: "stage",
          },
        ],
      },
    },
  };
}

function createExecution(): GitStageExecutionQuickResult {
  return {
    workspacePath: "E:/Javis",
    stagedPaths: ["README.md"],
    fileCount: 1,
    staged: true,
    output: "",
  };
}
