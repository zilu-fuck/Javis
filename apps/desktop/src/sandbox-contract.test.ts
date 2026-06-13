import { describe, expect, it } from "vitest";
import terminalRs from "../src-tauri/src/terminal.rs?raw";
import shellRs from "../src-tauri/src/shell.rs?raw";
import codeRs from "../src-tauri/src/code.rs?raw";
import sandboxRs from "../src-tauri/src/sandbox.rs?raw";
import libRs from "../src-tauri/src/lib.rs?raw";

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
});
