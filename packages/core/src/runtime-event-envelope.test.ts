import { describe, it, expect, beforeEach } from "vitest";
import {
  createRuntimeEventEnvelope,
  extractEventKind,
  extractStepId,
  extractAgentKind,
  isStructuralEvent,
  isStreamingEvent,
  nextEnvelopeSequence,
  resetEnvelopeSequence,
  STRUCTURAL_EVENT_KINDS,
  STREAMING_EVENT_KINDS,
} from "./runtime-event-envelope";
import type { RuntimeEventEnvelope } from "./runtime-event-envelope";
import type { TaskRuntimeEvent } from "./task-event-bus";

describe("runtime-event-envelope", () => {
  const testRunId = "run-test-001";
  const testTaskId = "task-test-001";

  beforeEach(() => {
    resetEnvelopeSequence(testRunId);
  });

  describe("sequence numbering", () => {
    it("returns monotonically increasing sequence numbers per runId", () => {
      expect(nextEnvelopeSequence(testRunId)).toBe(1);
      expect(nextEnvelopeSequence(testRunId)).toBe(2);
      expect(nextEnvelopeSequence(testRunId)).toBe(3);
    });

    it("maintains independent counters per runId", () => {
      const otherRunId = "run-test-002";
      resetEnvelopeSequence(otherRunId);

      expect(nextEnvelopeSequence(testRunId)).toBe(1);
      expect(nextEnvelopeSequence(otherRunId)).toBe(1);
      expect(nextEnvelopeSequence(testRunId)).toBe(2);
      expect(nextEnvelopeSequence(otherRunId)).toBe(2);
    });

    it("resets counter for a specific runId", () => {
      nextEnvelopeSequence(testRunId);
      nextEnvelopeSequence(testRunId);
      resetEnvelopeSequence(testRunId);
      expect(nextEnvelopeSequence(testRunId)).toBe(1);
    });
  });

  describe("createRuntimeEventEnvelope", () => {
    it("creates an envelope with all required fields", () => {
      const payload: TaskRuntimeEvent = {
        kind: "task.created",
        taskId: testTaskId,
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
      });

      expect(envelope.eventId).toContain(testRunId);
      expect(envelope.eventVersion).toBe(1);
      expect(envelope.sequence).toBe(1);
      expect(envelope.taskId).toBe(testTaskId);
      expect(envelope.runId).toBe(testRunId);
      expect(envelope.occurredAt).toBeTruthy();
      expect(envelope.recordedAt).toBeTruthy();
      expect(envelope.payload).toBe(payload);
      expect(envelope.correlationId).toBe(testRunId);
    });

    it("extracts stepId from payload when not provided in context", () => {
      const payload: TaskRuntimeEvent = {
        kind: "step.started",
        taskId: testTaskId,
        stepId: "step-abc",
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
      });

      expect(envelope.stepId).toBe("step-abc");
    });

    it("prefers explicit stepId from context over payload extraction", () => {
      const payload: TaskRuntimeEvent = {
        kind: "step.started",
        taskId: testTaskId,
        stepId: "step-from-payload",
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
        stepId: "step-from-context",
      });

      expect(envelope.stepId).toBe("step-from-context");
    });

    it("extracts agentKind as agentId from payload", () => {
      const payload: TaskRuntimeEvent = {
        kind: "agent.status",
        taskId: testTaskId,
        agentKind: "code",
        status: "running",
        message: "working",
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
      });

      expect(envelope.agentId).toBe("code");
    });

    it("includes optional workflowId and correlationId", () => {
      const payload: TaskRuntimeEvent = {
        kind: "task.created",
        taskId: testTaskId,
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
        workflowId: "wf-123",
        correlationId: "corr-456",
      });

      expect(envelope.workflowId).toBe("wf-123");
      expect(envelope.correlationId).toBe("corr-456");
    });

    it("occurredAt and recordedAt are ISO strings", () => {
      const payload: TaskRuntimeEvent = {
        kind: "task.created",
        taskId: testTaskId,
      };
      const envelope = createRuntimeEventEnvelope(payload, {
        taskId: testTaskId,
        runId: testRunId,
      });

      expect(() => new Date(envelope.occurredAt)).not.toThrow();
      expect(() => new Date(envelope.recordedAt)).not.toThrow();
    });
  });

  describe("extractEventKind", () => {
    it("extracts kind from envelope payload", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "step.completed", taskId: testTaskId, stepId: "s1", summary: "done" },
      };

      expect(extractEventKind(envelope)).toBe("step.completed");
    });
  });

  describe("extractStepId", () => {
    it("returns envelope.stepId when present", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        stepId: "from-envelope",
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "step.started", taskId: testTaskId, stepId: "from-payload" },
      };

      expect(extractStepId(envelope)).toBe("from-envelope");
    });

    it("falls back to payload.stepId when envelope.stepId is absent", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "step.started", taskId: testTaskId, stepId: "from-payload" },
      };

      expect(extractStepId(envelope)).toBe("from-payload");
    });

    it("returns undefined when no stepId anywhere", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "task.created", taskId: testTaskId },
      };

      expect(extractStepId(envelope)).toBeUndefined();
    });
  });

  describe("extractAgentKind", () => {
    it("extracts agentKind from payload", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "agent.status", taskId: testTaskId, agentKind: "shell", status: "running", message: "exec" },
      };

      expect(extractAgentKind(envelope)).toBe("shell");
    });

    it("returns undefined for events without agentKind", () => {
      const envelope: RuntimeEventEnvelope = {
        eventId: "evt-1",
        eventVersion: 1,
        sequence: 1,
        taskId: testTaskId,
        runId: testRunId,
        correlationId: "corr-1",
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        payload: { kind: "task.created", taskId: testTaskId },
      };

      expect(extractAgentKind(envelope)).toBeUndefined();
    });
  });

  describe("event classification", () => {
    it("structural events include task lifecycle, step lifecycle, permission, ask_user, tool planned/completed", () => {
      expect(isStructuralEvent("task.created")).toBe(true);
      expect(isStructuralEvent("task.completed")).toBe(true);
      expect(isStructuralEvent("task.failed")).toBe(true);
      expect(isStructuralEvent("step.started")).toBe(true);
      expect(isStructuralEvent("step.completed")).toBe(true);
      expect(isStructuralEvent("step.failed")).toBe(true);
      expect(isStructuralEvent("permission.requested")).toBe(true);
      expect(isStructuralEvent("permission.resolved")).toBe(true);
      expect(isStructuralEvent("ask_user.requested")).toBe(true);
      expect(isStructuralEvent("tool.planned")).toBe(true);
      expect(isStructuralEvent("tool.completed")).toBe(true);
    });

    it("streaming events include chunk and tool.partial", () => {
      expect(isStreamingEvent("agent.chunk_start")).toBe(true);
      expect(isStreamingEvent("agent.chunk")).toBe(true);
      expect(isStreamingEvent("agent.chunk_end")).toBe(true);
      expect(isStreamingEvent("tool.partial")).toBe(true);
    });

    it("streaming events are not structural", () => {
      for (const kind of STREAMING_EVENT_KINDS) {
        expect(isStructuralEvent(kind)).toBe(false);
      }
    });

    it("structural events are not streaming", () => {
      for (const kind of STRUCTURAL_EVENT_KINDS) {
        expect(isStreamingEvent(kind)).toBe(false);
      }
    });

    it("step.failed is structural", () => {
      expect(STRUCTURAL_EVENT_KINDS.has("step.failed")).toBe(true);
      expect(isStructuralEvent("step.failed")).toBe(true);
    });
  });
});
