/**
 * Forwards streamed reasoning deltas onto the task event bus.
 *
 * Provider thinking arrives as a `reasoning` field on stream chunks, and only the
 * L1 direct-answer path used to forward it. The planner, the synthesis step, and
 * long-form generation all dropped it, so a user asking "why did it do that" got
 * nothing for exactly the steps that produce the final answer.
 *
 * One forwarder per model call keeps the three events balanced: a `start` only
 * when the first delta actually arrives, a `chunk` per delta, and one `end`
 * carrying the accumulated text (which the delta reducer turns into the durable
 * digest). A call that streams no reasoning emits nothing at all.
 */
import type { AgentKind, ID } from "./index";
import type { TaskEventBus } from "./task-event-bus";

export interface ReasoningStreamForwarder {
  /** Feed one streamed chunk; a chunk carrying answer text ends the segment. */
  push(chunk: { reasoning?: string; text?: string }): void;
  /** Close the segment, e.g. when the stream ends or fails. */
  close(error?: string): void;
}

export function createReasoningStreamForwarder(options: {
  eventBus?: TaskEventBus | undefined;
  taskId: ID;
  agentKind: AgentKind;
}): ReasoningStreamForwarder {
  let accumulated = "";
  let open = false;

  const close = (error?: string): void => {
    if (!options.eventBus || !open) return;
    open = false;
    options.eventBus.emit({
      kind: "agent.reasoning_chunk_end",
      taskId: options.taskId,
      agentKind: options.agentKind,
      fullText: accumulated,
      ...(error ? { error } : {}),
    });
  };

  return {
    push(chunk) {
      if (options.eventBus && chunk.reasoning) {
        if (!open) {
          open = true;
          options.eventBus.emit({
            kind: "agent.reasoning_chunk_start",
            taskId: options.taskId,
            agentKind: options.agentKind,
          });
        }
        accumulated += chunk.reasoning;
        options.eventBus.emit({
          kind: "agent.reasoning_chunk",
          taskId: options.taskId,
          agentKind: options.agentKind,
          text: chunk.reasoning,
        });
      }
      // The answer starting means the thinking phase is over.
      if (chunk.text) close();
    },
    close,
  };
}
