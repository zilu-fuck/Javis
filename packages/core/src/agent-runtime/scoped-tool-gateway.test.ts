import { describe, expect, it, vi } from "vitest";
import { initialToolDescriptors } from "@javis/tools";
import {
  createReadOnlyToolExecutionGateway,
  createScopedToolExecutionGateway,
} from "./read-only-tool-gateway";

describe("scoped Agent runtime tool gateway", () => {
  const descriptors = initialToolDescriptors.filter((descriptor) =>
    descriptor.name === "file.scanMarkdownDocuments" ||
    descriptor.name === "file.planPdfOrganization" ||
    descriptor.name === "file.executePdfOrganization"
  );

  it("keeps the read-only wrapper fail-closed for preview tools", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const gateway = createReadOnlyToolExecutionGateway({
      descriptors,
      getAllowedToolNames: () => descriptors.map((descriptor) => descriptor.name),
      dispatch,
    });

    await expect(gateway.execute({
      taskId: "task-read",
      runId: "run-read",
      agentKind: "file",
      toolName: "file.planPdfOrganization",
      input: {},
    })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("does not permit preview"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows explicitly migrated preview tools but never confirmed writes", async () => {
    const dispatch = vi.fn(async (request) => ({ toolName: request.toolName }));
    const gateway = createScopedToolExecutionGateway({
      descriptors,
      allowedPermissionLevels: ["read", "preview"],
      getAllowedToolNames: () => descriptors.map((descriptor) => descriptor.name),
      dispatch,
    });

    await expect(gateway.execute({
      taskId: "task-preview",
      runId: "run-preview",
      agentKind: "file",
      toolName: "file.planPdfOrganization",
      input: {},
    })).resolves.toEqual({
      status: "success",
      output: { toolName: "file.planPdfOrganization" },
    });
    await expect(gateway.execute({
      taskId: "task-write",
      runId: "run-write",
      agentKind: "file",
      toolName: "file.executePdfOrganization",
      input: {},
    })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("never permits confirmed_write"),
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects write permissions even when an untyped caller injects them", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const gateway = createScopedToolExecutionGateway({
      descriptors,
      allowedPermissionLevels: ["read", "preview", "confirmed_write"] as never,
      getAllowedToolNames: () => descriptors.map((descriptor) => descriptor.name),
      dispatch,
    });

    await expect(gateway.execute({
      taskId: "task-malicious-write",
      runId: "run-malicious-write",
      agentKind: "file",
      toolName: "file.executePdfOrganization",
      input: {},
    })).resolves.toMatchObject({
      status: "error",
      reason: expect.stringContaining("never permits confirmed_write"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
