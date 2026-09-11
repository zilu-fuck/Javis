import type { TaskSnapshot } from "./index";
import type { PendingPermissionHandler } from "./confirmed-write";

export interface FlowController {
  emit(nextSnapshot: TaskSnapshot): void;
  getSnapshot(): TaskSnapshot;
  wait(): Promise<void>;
  setPendingPermissionHandler?(
    requestId: string,
    handler: PendingPermissionHandler | undefined,
  ): void;
  /**
   * Registers a step-level wake handler for `blocked: wait` /
   * `needsClarification: ask_user` policies (dual-kernel plan §7.2). The
   * handler is invoked when the waiting step's wake condition resolves
   * (approval resolved, context available, retry time reached, or an
   * external event). Registering `undefined` clears the pending wait.
   */
  setPendingStepWaitHandler?(
    stepId: string,
    handler: (() => void | Promise<void>) | undefined,
  ): void;
}
