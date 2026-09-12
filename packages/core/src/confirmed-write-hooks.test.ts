import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHooks, resetHooks } from "./config/hooks";
import { createConfirmedWriteApproval } from "./confirmed-write";

afterEach(() => {
  resetHooks();
});

function createApproval(reason = "Writing text to a local file changes the filesystem.") {
  const handlers = new Map<string, ((decision: "approved" | "denied") => void) | undefined>();
  const approval = createConfirmedWriteApproval({
    request: {
      id: "approval-1",
      title: "Approve text file write",
      reason,
      dryRun: {
        operation: "Write text file",
        affectedPaths: [{ source: "", target: "notes.md", action: "create" }],
        riskSummary: "Creates a file.",
        reversible: true,
      },
      toolName: "file.writeText",
    },
    setPendingPermissionHandler: (id, handler) => {
      handlers.set(id, handler as ((decision: "approved" | "denied") => void) | undefined);
    },
    onDenied: vi.fn(),
    onApproved: vi.fn(),
  });
  return { approval, handlers };
}

describe("confirmed write approval and beforeApproval hooks", () => {
  it("keeps the original reason when no hook applies", () => {
    const { approval } = createApproval();
    expect(approval.permissionRequest.reason)
      .toBe("Writing text to a local file changes the filesystem.");
  });

  it("appends the reasons of matching beforeApproval hooks", () => {
    configureHooks([
      {
        id: "policy-approval",
        phase: "beforeApproval",
        tool: "file.writeText",
        action: { kind: "requireApproval", reason: "Project policy: writes are reviewed by the lead." },
      },
    ]);
    const { approval } = createApproval();
    expect(approval.permissionRequest.reason).toContain("Writing text to a local file");
    expect(approval.permissionRequest.reason)
      .toContain("Project policy: writes are reviewed by the lead.");
  });

  it("does not apply a hook scoped to another tool", () => {
    configureHooks([
      {
        id: "other-tool",
        phase: "beforeApproval",
        tool: "git.createCommit",
        action: { kind: "deny", reason: "commits are frozen" },
      },
    ]);
    const { approval } = createApproval();
    expect(approval.permissionRequest.reason).not.toContain("commits are frozen");
  });

  it("keeps the request pending: a hook can never approve it", () => {
    configureHooks([
      {
        id: "auto-approve-attempt",
        phase: "beforeApproval",
        tool: "file.writeText",
        action: { kind: "notify", message: "auto approve please" },
      },
    ]);
    const { approval } = createApproval();
    expect(approval.permissionRequest.status).toBe("pending");
    expect(approval.permissionRequest.level).toBe("confirmed_write");
  });
});
