import { describe, expect, it } from "vitest";
import { isDisabledBrowserWriteToolName } from "@javis/tools";
import libRs from "../src-tauri/src/lib.rs?raw";
import browserRs from "../src-tauri/src/browser.rs?raw";
import appTsx from "./App.tsx?raw";
import appRuntimeTs from "./app-runtime.ts?raw";
import workflowExecutorTs from "../../../packages/core/src/workflow-executor.ts?raw";

const BROWSER_WRITE_COMMANDS = [
  { action: "click", tool: "browser.click", tauri: "browser_click" },
  { action: "type", tool: "browser.type", tauri: "browser_type" },
  { action: "evaluate", tool: "browser.evaluate", tauri: "browser_evaluate" },
  { action: "runTest", tool: "browser.runTest", tauri: "browser_run_test" },
] as const;

describe("Browser write command contract", () => {
  it("keeps browser write tools bridged through plan, approval, execution, and audit", () => {
    expect(libRs).toContain("browser::browser_plan_write");
    expect(libRs).toContain("browser::browser_approve_write");
    expect(appRuntimeTs).toContain('"browser_plan_write"');
    expect(appRuntimeTs).toContain('"browser_approve_write"');
    expect(appRuntimeTs).toContain("requestBrowserWriteApproval");
    expect(appRuntimeTs).toContain("createBrowserWritePlanAuditRecord(plan)");
    expect(appRuntimeTs).toContain("createBrowserWriteExecutionAuditRecord(plan, result, startedAt)");
    expect(appRuntimeTs).toContain("createBrowserWriteFailedAuditRecord(plan, error, startedAt)");
    expect(appRuntimeTs).toContain("if (!requestBrowserWriteApproval)");
    expect(appRuntimeTs).toContain("requires visible approval");
    expect(appRuntimeTs.indexOf("if (!requestBrowserWriteApproval)"))
      .toBeLessThan(appRuntimeTs.indexOf('await invoke("browser_approve_write"'));
    expect(appRuntimeTs).toContain("inputHash: fnv1aHash(request.text)");
    expect(appRuntimeTs).toContain("inputBytes: byteLength(request.text)");
    expect(appRuntimeTs).toContain("scriptHash: fnv1aHash(request.script)");
    expect(appRuntimeTs).toContain("scriptBytes: byteLength(request.script)");
    expect(browserRs).toContain("browser_text_hash(&request.text)");
    expect(browserRs).toContain("browser_text_hash(&script)");

    for (const entry of BROWSER_WRITE_COMMANDS) {
      expect(libRs).toContain(`browser::${entry.tauri}`);
      expect(appRuntimeTs).toContain(`runBrowserWriteAction("${entry.action}"`);
      expect(appRuntimeTs).toContain(`"${entry.tauri}"`);
    }

    expect(appRuntimeTs).not.toContain(`${BROWSER_WRITE_COMMANDS[0].tool} operation requires native approval and is disabled`);
  });

  it("keeps browser writes behind disabled agent exposure until packaged approval QA lands", () => {
    for (const entry of BROWSER_WRITE_COMMANDS) {
      expect(isDisabledBrowserWriteToolName(entry.tool)).toBe(true);
    }

    expect(appRuntimeTs).toContain("requestBrowserWriteApproval");
    expect(appRuntimeTs).toContain("requires visible approval");
    expect(appTsx).toContain("setPendingBrowserWriteApproval");
    expect(appTsx).toContain("resolveBrowserWriteApproval");
    expect(appTsx).toContain("pendingBrowserWriteApproval");
    expect(appTsx).toContain("onApproveBrowserWrite");
    expect(appTsx).toContain("onDenyBrowserWrite");
    expect(appRuntimeTs).toContain("isDisabledBrowserWriteToolName(descriptor.name)");
    expect(workflowExecutorTs).toContain("isDisabledBrowserWriteToolName(descriptor.name)");
    expect(workflowExecutorTs).toContain("findDisabledRequiredToolName(step, availableToolNames, availableTools)");
  });
});
