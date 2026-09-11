import type { AgentEvent } from "./event";

/**
 * Bounded push/await queue that buffers AgentEvents for one run and yields
 * them in order through an async iterator. Shared by all runtime adapters so
 * event ordering and close semantics stay identical across backends.
 */
export class AgentEventQueue {
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    while (!this.closed || this.buffer.length > 0) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }
}
