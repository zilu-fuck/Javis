import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_TTL_MS,
  cancelPermissionRequest,
  createDryRunBindingHash,
  createPendingPermissionRequest,
  expirePermissionRequestIfStale,
  expirePermissionRequest,
  isPermissionRequestStale,
  resolvePermissionRequest,
} from "./permission-state";

describe("permission-state", () => {
  it("creates pending permission requests with a timestamp", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    expect(request.status).toBe("pending");
    expect(request.createdAt).toBe("2026-05-24T00:00:00.000Z");
    expect(request.bindingHash).toMatch(/^dryrun-fnv1a-/);
    expect(request.resolvedAt).toBeUndefined();
  });

  it("preserves explicit single-action approval requests", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        allowAlways: false,
        dryRun: {
          operation: "computer.click",
          affectedPaths: [],
          riskSummary: "Fresh approval only.",
          reversible: false,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    expect(request.allowAlways).toBe(false);
    expect(request.bindingHash).toBe(createDryRunBindingHash(request.dryRun));
  });

  it("creates stable dry-run binding hashes", () => {
    const dryRun = {
      operation: "Move file",
      affectedPaths: [
        {
          source: "C:/Users/example/Downloads/a.pdf",
          target: "C:/Users/example/Downloads/Research/a.pdf",
          action: "move" as const,
        },
      ],
      riskSummary: "Moves one file.",
      reversible: true,
    };

    expect(createDryRunBindingHash(dryRun)).toBe(createDryRunBindingHash({ ...dryRun }));
    expect(createDryRunBindingHash({
      ...dryRun,
      affectedPaths: [{ ...dryRun.affectedPaths[0], target: "changed.pdf" }],
    })).not.toBe(createDryRunBindingHash(dryRun));
  });

  it("resolves a pending request once", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "preview",
        title: "Approve preview",
        reason: "Continue after preview.",
        dryRun: {
          operation: "Run read-only check",
          affectedPaths: [],
          riskSummary: "Read-only verification.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    const resolved = resolvePermissionRequest(
      request,
      "approved",
      () => "2026-05-24T00:00:01.000Z",
    );

    expect(resolved.status).toBe("approved");
    expect(resolved.createdAt).toBe(request.createdAt);
    expect(resolved.resolvedAt).toBe("2026-05-24T00:00:01.000Z");
  });

  it("rejects repeated resolution", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );
    const resolved = resolvePermissionRequest(
      request,
      "denied",
      () => "2026-05-24T00:00:01.000Z",
    );

    expect(() => resolvePermissionRequest(resolved, "approved")).toThrow(
      "already denied",
    );
  });

  it("expires and cancels pending requests as non-approval terminal states", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    const expired = expirePermissionRequest(
      request,
      () => "2026-05-24T00:05:00.000Z",
    );
    const cancelled = cancelPermissionRequest(
      {
        ...request,
        id: "permission-2",
      },
      () => "2026-05-24T00:06:00.000Z",
    );

    expect(expired.status).toBe("expired");
    expect(expired.resolvedAt).toBe("2026-05-24T00:05:00.000Z");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resolvedAt).toBe("2026-05-24T00:06:00.000Z");
    expect(() => resolvePermissionRequest(expired, "approved")).toThrow(
      "already expired",
    );
  });

  it("detects and expires stale pending permission requests", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    expect(
      isPermissionRequestStale(
        request,
        DEFAULT_PERMISSION_TTL_MS,
        "2026-05-24T00:09:59.999Z",
      ),
    ).toBe(false);
    expect(
      expirePermissionRequestIfStale(request, {
        now: () => "2026-05-24T00:09:59.999Z",
      }),
    ).toBe(request);

    const expired = expirePermissionRequestIfStale(request, {
      now: () => "2026-05-24T00:10:00.000Z",
    });

    expect(expired.status).toBe("expired");
    expect(expired.resolvedAt).toBe("2026-05-24T00:10:00.000Z");
  });

  it("rejects resolving stale pending permission requests", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    expect(() =>
      resolvePermissionRequest(
        request,
        "approved",
        () => "2026-05-24T00:10:00.000Z",
      ),
    ).toThrow("Permission request permission-1 is expired.");
  });


  it("does not treat terminal or malformed timestamps as stale", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "not-a-date",
    );
    const denied = resolvePermissionRequest(
      {
        ...request,
        createdAt: "2026-05-24T00:00:00.000Z",
      },
      "denied",
      () => "2026-05-24T00:00:01.000Z",
    );

    expect(isPermissionRequestStale(request, 1, "2026-05-24T00:10:00.000Z")).toBe(false);
    expect(isPermissionRequestStale(denied, 1, "2026-05-24T00:10:00.000Z")).toBe(false);
  });

  it("rejects resolution when the dry-run changed after approval was requested", () => {
    const request = createPendingPermissionRequest({
      id: "permission-1",
      level: "confirmed_write",
      title: "Approve write",
      reason: "Writing needs approval.",
      dryRun: {
        operation: "Move file",
        affectedPaths: [],
        riskSummary: "Moves one file.",
        reversible: true,
      },
    });

    expect(() =>
      resolvePermissionRequest(
        {
          ...request,
          dryRun: {
            ...request.dryRun,
            riskSummary: "Changed risk summary.",
          },
        },
        "approved",
      ),
    ).toThrow("dry-run no longer matches");
  });

  it("rejects expiration when the dry-run changed after approval was requested", () => {
    const request = createPendingPermissionRequest({
      id: "permission-1",
      level: "confirmed_write",
      title: "Approve write",
      reason: "Writing needs approval.",
      dryRun: {
        operation: "Move file",
        affectedPaths: [],
        riskSummary: "Moves one file.",
        reversible: true,
      },
    });

    expect(() =>
      expirePermissionRequest({
        ...request,
        dryRun: {
          ...request.dryRun,
          operation: "Changed operation.",
        },
      }),
    ).toThrow("dry-run no longer matches");
  });

  it("rejects stale expiration when the dry-run changed after approval was requested", () => {
    const request = createPendingPermissionRequest(
      {
        id: "permission-1",
        level: "confirmed_write",
        title: "Approve write",
        reason: "Writing needs approval.",
        dryRun: {
          operation: "Move file",
          affectedPaths: [],
          riskSummary: "Moves one file.",
          reversible: true,
        },
      },
      () => "2026-05-24T00:00:00.000Z",
    );

    expect(() =>
      expirePermissionRequestIfStale(
        {
          ...request,
          dryRun: {
            ...request.dryRun,
            riskSummary: "Changed risk summary.",
          },
        },
        {
          now: () => "2026-05-24T00:10:00.000Z",
        },
      ),
    ).toThrow("dry-run no longer matches");
  });

  it("rejects dangerous permission requests", () => {
    expect(() =>
      createPendingPermissionRequest({
        id: "permission-dangerous",
        level: "dangerous" as never,
        title: "Approve dangerous action",
        reason: "Dangerous actions are outside v1.",
        dryRun: {
          operation: "Delete project",
          affectedPaths: [],
          riskSummary: "Destructive action.",
          reversible: false,
        },
      }),
    ).toThrow("Dangerous permission requests are rejected by default.");
  });
});
