import type {
  DryRunSummary,
  PermissionRequest as ToolPermissionRequest,
} from "@javis/tools";
import {
  createPendingPermissionRequest,
  resolvePermissionRequest,
  type PermissionDecision,
} from "./permission-state";
import { evaluateHooks } from "./config/hooks";

export type PendingPermissionHandler = (
  decision: PermissionDecision,
) => void | Promise<void>;

interface ConfirmedWriteRequestInput {
  id: string;
  title: string;
  reason: string;
  dryRun: DryRunSummary;
  /** Tool this approval is for, when known; used to scope `beforeApproval` hooks. */
  toolName?: string;
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
  // C4b: `beforeApproval` hooks add their reasons to the card, so a policy that
  // forces a review explains itself to the reviewer. A hook cannot approve: only
  // the human decision below resolves the request.
  const approvalHooks = evaluateHooks({
    phase: "beforeApproval",
    ...(request.toolName ? { toolName: request.toolName } : {}),
    reason: request.reason,
  });
  const permissionRequest = createPendingPermissionRequest({
    ...request,
    reason: approvalHooks.reasons.length === 0
      ? request.reason
      : `${request.reason}\n\n${approvalHooks.reasons.join("\n")}`,
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
