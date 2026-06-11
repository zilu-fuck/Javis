import { describe, expect, it } from "vitest";
import {
  createBrowserWriteExecutionAuditRecord,
  createBrowserWriteFailedAuditRecord,
  createBrowserWritePlanAuditRecord,
  type BrowserWritePlanResult,
} from "./browser-audit";

describe("browser write audit records", () => {
  it("records browser write plans without persisting raw input", () => {
    const plan = browserPlan("type", "browser.type");
    const record = createBrowserWritePlanAuditRecord(plan, "2026-06-10T00:00:00.000Z");
    const serialized = JSON.stringify(record);

    expect(record).toMatchObject({
      id: "task-1:browser.type:approval-browser:plan",
      taskId: "task-1",
      toolName: "browser.type",
      permissionLevel: "confirmed_write",
      status: "waiting_permission",
      permissionRequestId: "approval-browser",
    });
    expect(serialized).toContain("previewHash");
    expect(serialized).not.toContain("SECRET_BROWSER_TEXT");
  });

  it("records browser write execution summaries", () => {
    const clickRecord = createBrowserWriteExecutionAuditRecord(
      browserPlan("click", "browser.click"),
      { selector: "button.save", clicked: true, newUrl: "https://example.com/done" },
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );
    const testRecord = createBrowserWriteExecutionAuditRecord(
      browserPlan("runTest", "browser.runTest"),
      { passed: false, exitCode: 1, stdout: "ok", stderr: "bad", duration: 120 },
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );

    expect(clickRecord.outputSummary).toBe("Clicked button.save; new URL https://example.com/done");
    expect(testRecord.outputSummary).toBe("Browser test failed with exit code 1");
  });

  it("records browser write failures against the approved plan", () => {
    const record = createBrowserWriteFailedAuditRecord(
      browserPlan("evaluate", "browser.evaluate"),
      new Error("sidecar failed"),
      "2026-06-10T00:00:01.000Z",
      "2026-06-10T00:00:02.000Z",
    );

    expect(record).toMatchObject({
      toolName: "browser.evaluate",
      status: "failed",
      permissionRequestId: "approval-browser",
    });
    expect(record.errorJson).toContain("sidecar failed");
  });
});

function browserPlan(
  action: BrowserWritePlanResult["action"],
  toolName: string,
): BrowserWritePlanResult {
  return {
    approvalId: "approval-browser",
    toolName,
    sessionId: "browser-session-1",
    action,
    previewHash: "hash-browser",
    binding: {
      taskId: "task-1",
    },
  };
}
