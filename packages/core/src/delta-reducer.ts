import type { AgentKind, TaskLogEntry, TaskSnapshot } from "./index";
import { appendTaskLogEntry, compactTaskLogs } from "./snapshot-utils";
import { taskEventToLogEntry, type TaskRuntimeEvent } from "./task-event-bus";

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
  let activeStreamingAgentKind: AgentKind | undefined = initial.streamingAgentKind;

  function pushLog(entry: TaskLogEntry): void {
    const compacted = appendTaskLogEntry(logs, entry);
    logs.length = 0;
    logs.push(...compacted);
  }

  return {
    getSnapshot(): TaskSnapshot {
      const activeStreamingText = activeStreamingAgentKind
        ? partialTexts.get(activeStreamingAgentKind)
        : undefined;
      return {
        ...current,
        logs: [...logs],
        streamingText:
          activeStreamingText ??
          partialTexts.get("commander") ??
          partialTexts.get("verifier") ??
          partialTexts.get("research") ??
          undefined,
        streamingAgentKind: activeStreamingAgentKind,
      };
    },
    syncFrom(snapshot: TaskSnapshot) {
      current = structuredClone(snapshot);
      logs.length = 0;
      logs.push(...compactTaskLogs(snapshot.logs));
      activeStreamingAgentKind = snapshot.isStreaming
        ? (snapshot.streamingAgentKind ?? activeStreamingAgentKind)
        : undefined;
      // Keep partialTexts as-is — streaming sessions may span emit boundaries
    },
    apply(event: TaskRuntimeEvent): TaskSnapshot {
      switch (event.kind) {
        case "agent.chunk_start": {
          current = { ...current, isStreaming: true };
          partialTexts.set(event.agentKind, "");
          activeStreamingAgentKind = event.agentKind;
          pushLog(taskEventToLogEntry(event));
          break;
        }
        case "agent.chunk": {
          const prev = partialTexts.get(event.agentKind) ?? "";
          partialTexts.set(event.agentKind, prev + event.text);
          break;
        }
        case "agent.chunk_end": {
          partialTexts.delete(event.agentKind);
          if (activeStreamingAgentKind === event.agentKind) {
            const nextStreamingAgentKind = partialTexts.keys().next().value;
            activeStreamingAgentKind =
              typeof nextStreamingAgentKind === "string"
                ? nextStreamingAgentKind
                : undefined;
          }
          current = { ...current, isStreaming: partialTexts.size > 0 };
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
          pushLog(taskEventToLogEntry(event));
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
          pushLog(taskEventToLogEntry(event));
          break;
        }
        case "step.completed": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId ? { ...step, status: "completed" as const } : step,
            ),
          };
          pushLog(taskEventToLogEntry(event));
          break;
        }
        case "step.failed": {
          current = {
            ...current,
            plan: current.plan.map((step) =>
              step.id === event.stepId ? { ...step, status: "failed" as const } : step,
            ),
          };
          pushLog(taskEventToLogEntry(event));
          break;
        }
        case "task.completed":
        case "task.failed": {
          current = { ...current, isStreaming: false };
          partialTexts.clear();
          activeStreamingAgentKind = undefined;
          break;
        }
        case "ask_user.requested": {
          current = { ...current, askUserQuestion: event.question };
          break;
        }
        case "ask_user.responded": {
          if (current.askUserQuestion?.id === event.requestId) {
            current = {
              ...current,
              askUserQuestion: {
                ...current.askUserQuestion,
                status: "answered",
                answer: event.answer,
                resolvedAt: new Date().toISOString(),
              },
            };
          }
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
