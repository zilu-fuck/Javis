import type { AgentKind, TaskLogEntry, TaskSnapshot } from "./index";
import type { TaskRuntimeEvent } from "./task-event-bus";

export interface DeltaReducer {
  getSnapshot(): TaskSnapshot;
  apply(event: TaskRuntimeEvent): TaskSnapshot;
  /** Sync internal state from an external snapshot (called by emit() to prevent divergence). */
  syncFrom(snapshot: TaskSnapshot): void;
}

/**
 * Fold incremental TaskRuntimeEvents into a full TaskSnapshot.
 * Each event type only modifies the relevant fields; the rest stay unchanged.
 */
export function createDeltaReducer(initial: TaskSnapshot): DeltaReducer {
  let current = structuredClone(initial);
  const logs: TaskLogEntry[] = [...initial.logs];
  const partialTexts = new Map<AgentKind, string>();

  return {
    getSnapshot(): TaskSnapshot {
      return {
        ...current,
        logs: [...logs],
        streamingText:
          partialTexts.get("commander") ??
          partialTexts.get("verifier") ??
          partialTexts.get("research") ??
          undefined,
      };
    },
    syncFrom(snapshot: TaskSnapshot) {
      current = structuredClone(snapshot);
      logs.length = 0;
      logs.push(...snapshot.logs);
      // Keep partialTexts as-is — streaming sessions may span emit boundaries
    },
    apply(event: TaskRuntimeEvent): TaskSnapshot {
      switch (event.kind) {
        case "agent.chunk_start": {
          current = { ...current, isStreaming: true };
          partialTexts.set(event.agentKind, "");
          logs.push({
            id: `${event.taskId}-chunk-start-${event.agentKind}-${Date.now()}`,
            kind: "event",
            title: "agent.chunk_start",
            detail: `${event.agentKind} is generating output...`,
          });
          break;
        }
        case "agent.chunk": {
          const prev = partialTexts.get(event.agentKind) ?? "";
          partialTexts.set(event.agentKind, prev + event.text);
          break;
        }
        case "agent.chunk_end": {
          current = { ...current, isStreaming: false };
          partialTexts.delete(event.agentKind);
          if (!event.error) {
            switch (event.agentKind) {
              case "commander":
                current = { ...current, commanderMessage: event.fullText };
                break;
              case "verifier":
                current = { ...current, verificationSummary: event.fullText };
                break;
              default:
                break;
            }
          }
          logs.push({
            id: `${event.taskId}-chunk-end-${event.agentKind}-${Date.now()}`,
            kind: "event",
            title: "agent.chunk_end",
            detail: event.error
              ? `${event.agentKind} failed: ${event.error}`
              : `${event.agentKind} completed output (${event.fullText.length} chars).`,
          });
          break;
        }
        case "step.progress":
        case "step.started": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId ? { ...step, status: "running" as const } : step,
            ),
          };
          break;
        }
        case "step.completed": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId ? { ...step, status: "completed" as const } : step,
            ),
          };
          break;
        }
        case "task.completed":
        case "task.failed": {
          current = { ...current, isStreaming: false };
          partialTexts.clear();
          break;
        }
        // Existing event types are handled by full emit path, not DeltaReducer
        default:
          break;
      }
      return this.getSnapshot();
    },
  };
}
