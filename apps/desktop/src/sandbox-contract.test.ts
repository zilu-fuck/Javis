import { describe, expect, it } from "vitest";
import terminalRs from "../src-tauri/src/terminal.rs?raw";
import shellRs from "../src-tauri/src/shell.rs?raw";
import codeRs from "../src-tauri/src/code.rs?raw";
import sandboxRs from "../src-tauri/src/sandbox.rs?raw";
import libRs from "../src-tauri/src/lib.rs?raw";
import appTsx from "./App.tsx?raw";

describe("Sandbox contract", () => {
  it("routes terminal create through interactive session backend check", () => {
    expect(terminalRs).toContain("require_interactive_session_backend");
    expect(terminalRs).toContain("workspace_write_policy");
    expect(terminalRs).toContain("Terminal sandbox check failed");
  });

  it("routes shell read-only commands through sandbox broker", () => {
    expect(shellRs).toContain("run_sandboxed_command");
    expect(shellRs).toContain("read_only_policy");
    expect(shellRs).toContain("SandboxCommandRequest");
  });

  it("routes code patch apply through workspace-write backend check", () => {
    expect(codeRs).toContain("require_workspace_write_command_launch_backend");
    expect(codeRs).toContain("workspace_write_policy");
  });

  it("routes opencode proposal through sandbox broker", () => {
    expect(codeRs).toContain("run_sandboxed_network_command(SandboxCommandRequest");
    expect(codeRs).toContain("OPENCODE_CONFIG_CONTENT");
    expect(codeRs).not.toContain("Command::new(&opencode)");
  });

  it("defines all required sandbox policy types", () => {
    expect(sandboxRs).toContain("pub(crate) enum SandboxMode");
    expect(sandboxRs).toContain("ReadOnly");
    expect(sandboxRs).toContain("WorkspaceWrite");
    expect(sandboxRs).toContain("FullAccessManual");
    expect(sandboxRs).toContain("pub(crate) struct SandboxPolicy");
    expect(sandboxRs).toContain("pub(crate) struct SandboxApprovalScope");
  });

  it("defines sandbox command request and output types", () => {
    expect(sandboxRs).toContain("pub(crate) struct SandboxCommandRequest");
    expect(sandboxRs).toContain("pub(crate) struct SandboxCommandOutput");
    expect(sandboxRs).toContain("pub(crate) struct SandboxReport");
  });

  it("defines all platform backends", () => {
    expect(sandboxRs).toContain("pub(crate) enum SandboxBackend");
    expect(sandboxRs).toContain("PolicyOnly");
    expect(sandboxRs).toContain("WindowsRestrictedToken");
    expect(sandboxRs).toContain("LinuxBubblewrap");
    expect(sandboxRs).toContain("MacSeatbelt");
  });

  it("exports sandbox broker and helpers from lib.rs", () => {
    expect(libRs).toContain("mod sandbox");
  });

  it("includes sandbox report in shell command output", () => {
    expect(shellRs).toContain("sandbox: SandboxReport");
  });

  it("defines default protected paths", () => {
    expect(sandboxRs).toContain("default_protected_paths");
    expect(sandboxRs).toContain(".git");
    expect(sandboxRs).toContain(".env");
    expect(sandboxRs).toContain(".codex");
    expect(sandboxRs).toContain(".agents");
    expect(sandboxRs).toContain(".claude");
  });

  it("includes sandbox audit events in JSONL output", () => {
    expect(sandboxRs).toContain("sandbox_audit_jsonl_line_for_output");
    expect(sandboxRs).toContain("sandbox_denied_interactive_audit_jsonl_line");
    expect(sandboxRs).toContain("sandbox_denied_workspace_write_audit_jsonl_line");
    expect(sandboxRs).toContain("sandbox_denied_network_audit_jsonl_line");
  });

  it("validates policy before execution", () => {
    expect(sandboxRs).toContain("fn validate_policy");
    expect(sandboxRs).toContain("canonicalize_roots_under_workspace");
    expect(sandboxRs).toContain("require_executable_outside_workspace");
  });

  it("defines Windows sandbox token hardening primitives", () => {
    expect(sandboxRs).toContain("WindowsTokenConfig");
    expect(sandboxRs).toContain("create_windows_sandbox_token");
    expect(sandboxRs).toContain("create_restricted_token_with_disabled_network_sid");
    expect(sandboxRs).toContain("set_token_integrity_level");
  });

  it("defines Windows sandbox process launcher", () => {
    expect(sandboxRs).toContain("fn launch_windows_sandboxed_process");
    expect(sandboxRs).toContain("create_sandbox_pipe");
    expect(sandboxRs).toContain("read_pipe_to_end");
  });

  it("defines new SandboxBoundaryStrategy variants for Windows", () => {
    expect(sandboxRs).toContain("WindowsIntegrityLevel");
    expect(sandboxRs).toContain("WindowsDisabledNetworkSid");
  });

  it("exposes pub(crate) WindowsHandle for terminal", () => {
    expect(sandboxRs).toContain("pub(crate) struct WindowsHandle");
  });

  it("exposes terminal job object helpers", () => {
    expect(sandboxRs).toContain("pub(crate) fn create_windows_terminal_job");
    expect(sandboxRs).toContain("pub(crate) fn assign_process_to_terminal_job");
  });

  it("terminal wires job object assignment after PTY spawn", () => {
    expect(terminalRs).toContain("create_windows_terminal_job");
    expect(terminalRs).toContain("assign_process_to_terminal_job");
    expect(terminalRs).toContain("job: Option<crate::sandbox::WindowsHandle>");
  });

  it("exposes temp workspace sandbox Tauri commands", () => {
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_create");
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_diff");
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_diff_and_plan");
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_approve_apply");
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_apply");
    expect(sandboxRs).toContain("fn temp_workspace_sandbox_finalize");
  });

  it("temp workspace apply uses native approval binding", () => {
    expect(sandboxRs).toContain("TEMP_WORKSPACE_APPLY_TOOL_NAME");
    expect(sandboxRs).toContain("approve_native_approval_binding");
    expect(sandboxRs).toContain("take_approved_temporary_workspace_apply");
    expect(sandboxRs).not.toContain("approved_files: Vec<PathBuf> = changed_files");
  });

  it("temp workspace types derive Serialize", () => {
    expect(sandboxRs).toContain("#[derive(Clone, Debug, PartialEq, Eq, Serialize)]");
  });

  it("temp workspace commands registered in lib.rs", () => {
    expect(libRs).toContain("sandbox_backend_status");
    expect(libRs).toContain("temp_workspace_sandbox_create");
    expect(libRs).toContain("temp_workspace_sandbox_diff_and_plan");
    expect(libRs).toContain("temp_workspace_sandbox_approve_apply");
    expect(libRs).toContain("temp_workspace_sandbox_apply");
    expect(libRs).toContain("temp_workspace_sandbox_finalize");
  });

  it("runs workspace sandbox settings migrations at startup", () => {
    expect(appTsx).toContain("WORKSPACE_SETTINGS_MIGRATIONS");
    expect(appTsx).toContain(
      "runDesktopDatabaseMigrations(database, WORKSPACE_SETTINGS_MIGRATIONS)",
    );
  });

  it("defines Linux and macOS sandbox boundary strategies", () => {
    expect(sandboxRs).toContain("LinuxBubblewrap");
    expect(sandboxRs).toContain("MacSeatbelt");
  });

  it("defines Linux bubblewrap launcher", () => {
    expect(sandboxRs).toContain("fn detect_bubblewrap");
    expect(sandboxRs).toContain("fn launch_linux_bubblewrap_process");
  });

  it("defines macOS Seatbelt launcher", () => {
    expect(sandboxRs).toContain("fn detect_sandbox_exec");
    expect(sandboxRs).toContain("fn build_seatbelt_profile");
    expect(sandboxRs).toContain("fn launch_macos_seatbelt_process");
  });

  it("dispatches WorkspaceWrite to platform-specific launcher", () => {
    expect(sandboxRs).toContain("launch_windows_sandboxed_process");
    expect(sandboxRs).toContain("launch_linux_bubblewrap_process");
    expect(sandboxRs).toContain("launch_macos_seatbelt_process");
  });
});
