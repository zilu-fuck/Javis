import type {
  DryRunSummary,
  PermissionRequest as ToolPermissionRequest,
} from "@javis/tools";
import {
  createPendingPermissionRequest,
  resolvePermissionRequest,
  type PermissionDecision,
} from "./permission-state";

export type PendingPermissionHandler = (
  decision: PermissionDecision,
) => void | Promise<void>;

interface ConfirmedWriteRequestInput {
  id: string;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
}

interface ConfirmedWriteApprovalOptions {
  request: ConfirmedWriteRequestInput;
  setPendingPermissionHandler(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
  onDenied(resolvedRequest: ToolPermissionRequest): void | Promise<void>;
  onApproved(
    resolvedRequest: ToolPermissionRequest,
    options?: { alwaysAllow: boolean },
  ): void | Promise<void>;
}

interface ConfirmedWriteApproval {
  permissionRequest: ToolPermissionRequest;
  listenForDecision(): void;
}

export function createConfirmedWriteApproval({
  request,
  setPendingPermissionHandler,
  onDenied,
  onApproved,
}: ConfirmedWriteApprovalOptions): ConfirmedWriteApproval {
  const permissionRequest = createPendingPermissionRequest({
    ...request,
    level: "confirmed_write",
  });

  return {
    permissionRequest,
    listenForDecision() {
      setPendingPermissionHandler(permissionRequest.id, async (decision) => {
        const resolvedRequest = resolvePermissionRequest(permissionRequest, decision);
        setPendingPermissionHandler(permissionRequest.id, undefined);

        if (decision === "denied") {
          await onDenied(resolvedRequest);
          return;
        }

        await onApproved(resolvedRequest, { alwaysAllow: decision === "approved_always" });
      });
    },
  };
}
