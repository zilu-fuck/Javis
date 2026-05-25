import { describe, expect, it } from "vitest";
import {
  createCodeApplyDryRun,
  createDryRunBindingHash,
} from "@javis/core";
import type { DryRunSummary, PermissionRequest } from "@javis/tools";
import {
  APPROVAL_RECORDS_LIMIT,
  APPROVAL_RECORDS_STORAGE_KEY,
  APPROVAL_RECORDS_STORAGE_VERSION,
  expireApprovalRecord,
  createApprovalRecordFromPermissionRequest,
  findPendingApprovalRecord,
  isApprovalRecordExpired,
  loadApprovalRecords,
  resolveApprovalRecord,
  saveApprovalRecords,
  sanitizeApprovalRecord,
  upsertApprovalRecord,
  type DurableApprovalRecord,
} from "./approval-records";

describe("durable approval records", () => {
  it("persists pending confirmed-write approval records", () => {
    const storage = createMemoryStorage();
    const record = createApprovalRecord();

    saveApprovalRecords(storage, [record]);
    const loaded = loadApprovalRecords(storage);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
    expect(storage.getItem(APPROVAL_RECORDS_STORAGE_KEY)).toContain("approval-1");
  });

  it("rejects malformed or mismatched approval records", () => {
    expect(sanitizeApprovalRecord({ ...createApprovalRecord(), previewHash: "changed" })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        id: "other-approval",
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        dryRun: {
          ...createApprovalRecord().permissionRequest.dryRun,
          affectedPaths: [{ action: "archive" }],
        },
      },
    })).toBeNull();
    const tamperedDryRun: DryRunSummary = {
      ...createApprovalRecord().permissionRequest.dryRun,
      affectedPaths: [
        {
          source: "C:/Users/example/Downloads/a.pdf",
          target: "C:/Users/example/Downloads/Other/a.pdf",
          action: "move",
        },
      ],
    };
    expect(sanitizeApprovalRecord({
      ...createApprovalRecord(),
      previewHash: createDryRunBindingHash(tamperedDryRun),
      permissionRequest: {
        ...createApprovalRecord().permissionRequest,
        bindingHash: createDryRunBindingHash(tamperedDryRun),
        dryRun: createApprovalRecord().permissionRequest.dryRun,
      },
    })).toBeNull();
  });

  it("loads versioned envelopes only", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION,
        records: [createApprovalRecord()],
      }),
    );
    expect(loadApprovalRecords(storage)).toHaveLength(1);

    storage.setItem(
      APPROVAL_RECORDS_STORAGE_KEY,
      JSON.stringify({
        version: APPROVAL_RECORDS_STORAGE_VERSION + 1,
        records: [createApprovalRecord()],
      }),
    );
    expect(loadApprovalRecords(storage)).toEqual([]);
  });

  it("upserts newest records and enforces the storage limit", () => {
    const records = Array.from({ length: APPROVAL_RECORDS_LIMIT + 2 }, (_, index) =>
      createApprovalRecord(`approval-${index}`),
    );
    const updated = {
      ...records[5],
      workspacePath: "E:/Updated",
    };

    const result = upsertApprovalRecord(records, updated);

    expect(result).toHaveLength(APPROVAL_RECORDS_LIMIT);
    expect(result[0]?.approvalId).toBe("approval-5");
    expect(result[0]?.workspacePath).toBe("E:/Updated");
  });

  it("creates records from pending permission requests", () => {
    const record = createApprovalRecord();
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-1",
      toolName: "file.executePdfOrganization",
      workspacePath: "C:/Users/example/Downloads",
      permissionRequest: record.permissionRequest,
      now: "2026-05-24T00:00:00.000Z",
    });

    expect(created).toEqual(record);
    expect(createApprovalRecordFromPermissionRequest({
      taskId: "task-1",
      toolName: "file.executePdfOrganization",
      workspacePath: "C:/Users/example/Downloads",
      permissionRequest: {
        ...record.permissionRequest,
        status: "approved",
      },
    })).toBeNull();
  });

  it("creates durable records for Code Agent patch approvals", () => {
    const codeProposedEdit = createCodeProposedEdit();
    const dryRun = createCodeApplyDryRun(codeProposedEdit);
    const created = createApprovalRecordFromPermissionRequest({
      taskId: "task-code",
      toolName: "code.applyProposedEdit",
      workspacePath: "E:/Javis",
      permissionRequest: {
        id: "task-code-apply-permission",
        level: "confirmed_write",
        title: "Approve Code Agent patch application",
        reason: "Applying the proposed patch changes local project files.",
        bindingHash: createDryRunBindingHash(dryRun),
        status: "pending",
        createdAt: "2026-05-24T00:00:00.000Z",
        dryRun,
      },
      codeProposedEdit,
      now: "2026-05-24T00:00:00.000Z",
    });

    expect(created?.toolName).toBe("code.applyProposedEdit");
    expect(created?.workspacePath).toBe("E:/Javis");
    expect(created?.permissionRequest.title).toBe("Approve Code Agent patch application");
    expect(created?.permissionRequest.dryRun.affectedPaths[0]?.action).toBe("modify");
    expect(created?.codeProposedEdit?.proposalId).toBe("proposal-1");
    expect(created?.codeProposedEdit?.patch).toContain("diff --git");
  });

  it("rejects Code Agent approval records whose dry-run files do not match the proposed edit", () => {
    const record = createCodeApprovalRecord();

    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: {
        ...record.codeProposedEdit,
        changedFiles: ["packages/core/src/other.ts"],
      },
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      workspacePath: "E:/Other",
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: undefined,
    })).toBeNull();
    expect(sanitizeApprovalRecord({
      ...record,
      codeProposedEdit: {
        ...record.codeProposedEdit,
        patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts\n+changed\n",
        patchHash: "fnv1a-other",
      },
    })).toBeNull();
    const misleadingDryRun: DryRunSummary = {
      ...record.permissionRequest.dryRun,
      affectedPaths: [
        {
          source: "packages/core/src/index.ts",
          target: "packages/core/src/index.ts",
          action: "delete",
        },
      ],
    };
    expect(sanitizeApprovalRecord({
      ...record,
      previewHash: createDryRunBindingHash(misleadingDryRun),
      permissionRequest: {
        ...record.permissionRequest,
        bindingHash: createDryRunBindingHash(misleadingDryRun),
        dryRun: misleadingDryRun,
      },
    })).toBeNull();
  });

  it("resolves and expires pending records without changing terminal records", () => {
    const pending = createApprovalRecord();
    const approved = resolveApprovalRecord(pending, "approved", "2026-05-24T00:05:00.000Z");
    const denied = resolveApprovalRecord(pending, "denied", "2026-05-24T00:06:00.000Z");
    const expired = expireApprovalRecord(pending, "2026-05-24T00:10:00.000Z");

    expect(approved.status).toBe("approved");
    expect(approved.permissionRequest.status).toBe("approved");
    expect(denied.status).toBe("denied");
    expect(expired.status).toBe("expired");
    expect(resolveApprovalRecord(approved, "denied", "2026-05-24T00:07:00.000Z")).toBe(approved);
  });

  it("detects expired pending records", () => {
    expect(isApprovalRecordExpired(
      createApprovalRecord(),
      "2026-05-24T00:09:59.999Z",
    )).toBe(false);
    expect(isApprovalRecordExpired(
      createApprovalRecord(),
      "2026-05-24T00:10:00.000Z",
    )).toBe(true);
    expect(isApprovalRecordExpired(
      resolveApprovalRecord(createApprovalRecord(), "approved", "2026-05-24T00:05:00.000Z"),
      "2026-05-24T00:10:00.000Z",
    )).toBe(false);
  });

  it("finds pending records by tool name", () => {
    const pending = createApprovalRecord("approval-pending");
    const approved = resolveApprovalRecord(
      createApprovalRecord("approval-approved"),
      "approved",
      "2026-05-24T00:05:00.000Z",
    );

    expect(findPendingApprovalRecord([approved, pending], "file.executePdfOrganization")).toBe(pending);
    expect(findPendingApprovalRecord([approved], "file.executePdfOrganization")).toBeUndefined();
  });
});

function createApprovalRecord(approvalId = "approval-1"): DurableApprovalRecord {
  const dryRun: DryRunSummary = {
    operation: "Organize PDF files by filename topic",
    affectedPaths: [
      {
        source: "C:/Users/example/Downloads/a.pdf",
        target: "C:/Users/example/Downloads/Documents/a.pdf",
        action: "move",
      },
    ],
    riskSummary: "Preview only.",
    reversible: true,
  };
  const bindingHash = createDryRunBindingHash(dryRun);
  const permissionRequest: PermissionRequest = {
    id: approvalId,
    level: "confirmed_write",
    title: "Approve PDF move plan",
    reason: "Moving files changes the local filesystem, so Javis needs explicit approval.",
    bindingHash,
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    dryRun,
  };
  return {
    approvalId,
    taskId: "task-1",
    toolName: "file.executePdfOrganization",
    workspacePath: "C:/Users/example/Downloads",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-05-24T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    permissionRequest,
  };
}

function createCodeApprovalRecord(): DurableApprovalRecord {
  const codeProposedEdit = createCodeProposedEdit();
  const dryRun = createCodeApplyDryRun(codeProposedEdit);
  const bindingHash = createDryRunBindingHash(dryRun);
  return {
    approvalId: "task-code-apply-permission",
    taskId: "task-code",
    toolName: "code.applyProposedEdit",
    workspacePath: "E:/Javis",
    permissionLevel: "confirmed_write",
    previewHash: bindingHash,
    expiresAt: "2026-05-24T00:10:00.000Z",
    status: "pending",
    createdAt: "2026-05-24T00:00:00.000Z",
    permissionRequest: {
      id: "task-code-apply-permission",
      level: "confirmed_write",
      title: "Approve Code Agent patch application",
      reason: "Applying the proposed patch changes local project files.",
      bindingHash,
      status: "pending",
      createdAt: "2026-05-24T00:00:00.000Z",
      dryRun,
    },
    codeProposedEdit,
  };
}

function createCodeProposedEdit() {
  return {
    proposalId: "proposal-1",
    workspacePath: "E:/Javis",
    summary: "Tighten completion message.",
    changedFiles: ["packages/core/src/index.ts"],
    patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts\n",
    patchHash: "fnv1a-test",
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
