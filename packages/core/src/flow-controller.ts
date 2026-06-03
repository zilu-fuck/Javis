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
}
