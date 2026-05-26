import type { TaskSnapshot } from "./index";

export interface FlowController {
  emit(nextSnapshot: TaskSnapshot): void;
  getSnapshot(): TaskSnapshot;
  wait(): Promise<void>;
}
