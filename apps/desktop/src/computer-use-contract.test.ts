import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "@javis/tools";
import { COMPUTER_USE_ACTION_TOOL_NAMES } from "@javis/core";
import libRs from "../src-tauri/src/lib.rs?raw";
import appRuntimeTs from "./app-runtime.ts?raw";
import appTsx from "./App.tsx?raw";

type InternalCommand = {
  module: "computer" | "global_hotkey";
  tauri: string;
  bridgeSource?: string;
};

const COMPUTER_USE_ACTION_COMMANDS = [
  { tool: "computer.moveMouse", tauri: "computer_move_mouse", permission: "confirmed_write", writeRiskLevel: "safe" },
  { tool: "computer.click", tauri: "computer_click", permission: "confirmed_write", writeRiskLevel: "dangerous" },
  { tool: "computer.type", tauri: "computer_type", permission: "confirmed_write", writeRiskLevel: "dangerous" },
  { tool: "computer.keyCombo", tauri: "computer_key_combo", permission: "confirmed_write", writeRiskLevel: "dangerous" },
  { tool: "computer.scroll", tauri: "computer_scroll", permission: "confirmed_write", writeRiskLevel: "safe" },
  { tool: "computer.focusWindow", tauri: "computer_focus_window", permission: "confirmed_write", writeRiskLevel: "safe" },
  { tool: "computer.listWindows", tauri: "computer_list_windows", permission: "read" },
  { tool: "computer.inspectUi", tauri: "computer_inspect_ui", permission: "read" },
  { tool: "computer.invokeUi", tauri: "computer_invoke_ui", permission: "confirmed_write", writeRiskLevel: "risky" },
  { tool: "computer.setUiValue", tauri: "computer_set_ui_value", permission: "confirmed_write", writeRiskLevel: "risky" },
  { tool: "computer.screenshot", tauri: "computer_screenshot", permission: "read" },
  { tool: "computer.wait", tauri: "computer_wait", permission: "read" },
] as const;

const INTERNAL_COMMANDS: readonly InternalCommand[] = [
  { module: "computer", tauri: "computer_detect_ui_objects", bridgeSource: appRuntimeTs },
  { module: "computer", tauri: "computer_local_vision_default_model_path" },
  { module: "computer", tauri: "computer_approve_action", bridgeSource: appRuntimeTs },
  { module: "computer", tauri: "computer_cancel_approvals", bridgeSource: appRuntimeTs },
  { module: "global_hotkey", tauri: "computer_set_emergency_hotkey_enabled", bridgeSource: appTsx },
];

describe("Computer Use command contract", () => {
  it("keeps model action tools registered in Tauri, bridged in app-runtime, and described for the Computer Agent", () => {
    expect(COMPUTER_USE_ACTION_COMMANDS.map((entry) => entry.tool)).toEqual(COMPUTER_USE_ACTION_TOOL_NAMES);

    for (const entry of COMPUTER_USE_ACTION_COMMANDS) {
      const descriptor = initialToolDescriptors.find((tool) => tool.name === entry.tool);

      expect(libRs).toContain(`computer::${entry.tauri}`);
      expect(appRuntimeTs).toContain(`"${entry.tauri}"`);
      expect(descriptor?.ownerAgentKinds).toContain("computer");
      expect(descriptor?.permissionLevel).toBe(entry.permission);
      expect(descriptor?.writeRiskLevel).toBe("writeRiskLevel" in entry ? entry.writeRiskLevel : undefined);

      if (entry.permission === "confirmed_write") {
        expect(appRuntimeTs).toContain(`requireComputerApprovalId(approvalId, "${entry.tool}")`);
        expect(appRuntimeTs).toContain(`requireComputerTaskId(taskId, "${entry.tool}")`);
      }
    }
  });

  it("keeps internal Computer Use support commands registered and bridged where they are used", () => {
    for (const entry of INTERNAL_COMMANDS) {
      expect(libRs).toContain(`${entry.module}::${entry.tauri}`);
      if (entry.bridgeSource) {
        expect(entry.bridgeSource).toContain(`"${entry.tauri}"`);
      }
    }
  });
});
