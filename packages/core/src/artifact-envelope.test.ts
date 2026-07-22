import { describe, it, expect, beforeEach } from "vitest";
import {
  createArtifactEnvelope,
  computeContentHash,
  isArtifactEnvelope,
  validateArtifactEnvelope,
  sanitizeArtifactForPersistence,
  summarizeArtifactForHandoff,
  resetArtifactIdCounter,
} from "./artifact-envelope";
import type { ArtifactEnvelope } from "./artifact-envelope";
import { createSharedTaskContext, buildHandoffReport, formatHandoffReportMarkdown } from "./shared-context";

describe("artifact-envelope", () => {
  beforeEach(() => {
    resetArtifactIdCounter();
  });

  describe("createArtifactEnvelope", () => {
    it("creates an envelope with all required fields", () => {
      const payload = { diff: "test diff", changedFiles: ["a.ts"] };
      const envelope = createArtifactEnvelope(payload, {
        taskId: "task-1",
        runId: "run-1",
        type: "diffPreview",
        producer: { stepId: "step-1", agentKind: "code" },
      });

      expect(envelope.artifactId).toContain("run-1");
      expect(envelope.type).toBe("diffPreview");
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.taskId).toBe("task-1");
      expect(envelope.runId).toBe("run-1");
      expect(envelope.producer.stepId).toBe("step-1");
      expect(envelope.producer.agentKind).toBe("code");
      expect(envelope.contentHash).toBeTruthy();
      expect(envelope.hashAlgorithm).toBe("sha256-canonical-json-v1");
      expect(envelope.payload).toBe(payload);
      expect(envelope.createdAt).toBeTruthy();
    });

    it("includes optional sourceRefs and sensitivity", () => {
      const envelope = createArtifactEnvelope({ data: "test" }, {
        taskId: "task-1",
        runId: "run-1",
        type: "verificationResult",
        producer: { stepId: "step-2", agentKind: "verifier" },
        sourceRefs: [{ kind: "file", label: "test.ts", reference: "/src/test.ts" }],
        sensitivity: "workspace",
      });

      expect(envelope.sourceRefs).toHaveLength(1);
      expect(envelope.sourceRefs?.[0].kind).toBe("file");
      expect(envelope.sensitivity).toBe("workspace");
    });

    it("carries the declared output schema reference into handoff metadata", () => {
      const envelope = createArtifactEnvelope({ data: "test" }, {
        taskId: "task-1",
        runId: "run-1",
        type: "repoEvidence",
        outputSchemaRef: "repoEvidence",
        producer: { stepId: "step-2", agentKind: "code" },
      });

      expect(envelope.outputSchemaRef).toBe("repoEvidence");
      expect(summarizeArtifactForHandoff(envelope).outputSchemaRef).toBe("repoEvidence");
    });

    it("defaults schemaVersion to 1", () => {
      const envelope = createArtifactEnvelope({}, {
        taskId: "t",
        runId: "r",
        type: "test",
        producer: { stepId: "s" },
      });
      expect(envelope.schemaVersion).toBe(1);
    });

    it("accepts custom schemaVersion", () => {
      const envelope = createArtifactEnvelope({}, {
        taskId: "t",
        runId: "r",
        type: "test",
        schemaVersion: 3,
        producer: { stepId: "s" },
      });
      expect(envelope.schemaVersion).toBe(3);
    });
  });

  describe("computeContentHash", () => {
    it("returns the same hash for identical payloads", () => {
      const a = { x: 1, y: [2, 3] };
      const b = { x: 1, y: [2, 3] };
      expect(computeContentHash(a)).toBe(computeContentHash(b));
    });

    it("uses sha256 over canonical JSON", () => {
      expect(computeContentHash({ b: 2, a: 1 })).toBe(
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
      );
    });

    it("returns different hash for different payloads", () => {
      expect(computeContentHash({ x: 1 })).not.toBe(computeContentHash({ x: 2 }));
    });

    it("handles null and undefined", () => {
      expect(computeContentHash(null)).toBeTruthy();
      expect(computeContentHash(undefined)).toBeTruthy();
      expect(computeContentHash(null)).not.toBe(computeContentHash(undefined));
    });

    it("handles arrays", () => {
      expect(computeContentHash([1, 2, 3])).toBeTruthy();
      expect(computeContentHash([1, 2, 3])).not.toBe(computeContentHash([1, 2, 4]));
    });

    it("is key-order independent for objects", () => {
      const a = { b: 2, a: 1 };
      const b = { a: 1, b: 2 };
      expect(computeContentHash(a)).toBe(computeContentHash(b));
    });
  });

  describe("isArtifactEnvelope", () => {
    it("returns true for valid envelope", () => {
      const envelope = createArtifactEnvelope({ data: 1 }, {
        taskId: "t",
        runId: "r",
        type: "test",
        producer: { stepId: "s" },
      });
      expect(isArtifactEnvelope(envelope)).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(isArtifactEnvelope({ data: 1 })).toBe(false);
      expect(isArtifactEnvelope(null)).toBe(false);
      expect(isArtifactEnvelope("string")).toBe(false);
    });

    it("returns false for incomplete objects", () => {
      expect(isArtifactEnvelope({ artifactId: "a", type: "t" })).toBe(false);
    });
  });

  describe("validateArtifactEnvelope", () => {
    it("validates artifact identity, timestamp, and expected producer provenance", () => {
      const envelope = createArtifactEnvelope({ data: 1 }, {
        taskId: "task-1",
        runId: "run-1",
        type: "test",
        producer: {
          workflowId: "commander-dag",
          stepId: "collect-evidence",
          agentKind: "code",
          agentId: "code-agent",
          toolName: "code.searchRepository",
        },
      });

      expect(validateArtifactEnvelope(envelope, {
        taskId: "task-1",
        runId: "run-1",
        artifactId: envelope.artifactId,
        createdAt: envelope.createdAt,
        producer: {
          workflowId: "commander-dag",
          stepId: "collect-evidence",
          agentKind: "code",
          agentId: "code-agent",
          toolName: "code.searchRepository",
        },
      })).toBe(true);
    });

    it.each([
      ["workflowId", "other-workflow"],
      ["stepId", "other-step"],
      ["agentKind", "research"],
      ["agentId", "other-agent"],
      ["toolName", "web.search"],
    ] as const)("rejects a mismatched producer %s", (field, expectedValue) => {
      const envelope = createArtifactEnvelope({ data: 1 }, {
        taskId: "task-1",
        runId: "run-1",
        type: "test",
        producer: {
          workflowId: "commander-dag",
          stepId: "collect-evidence",
          agentKind: "code",
          agentId: "code-agent",
          toolName: "code.searchRepository",
        },
      });

      expect(validateArtifactEnvelope(envelope, {
        producer: { [field]: expectedValue },
      })).toBe(false);
    });

    it("rejects malformed artifact ids and non-canonical timestamps", () => {
      const envelope = createArtifactEnvelope({ data: 1 }, {
        taskId: "task-1",
        runId: "run-1",
        type: "test",
        producer: { stepId: "step-1" },
      });

      expect(validateArtifactEnvelope({ ...envelope, artifactId: "forged-artifact" })).toBe(false);
      expect(validateArtifactEnvelope({ ...envelope, createdAt: "not-a-date" })).toBe(false);
    });
  });

  describe("sanitizeArtifactForPersistence", () => {
    it("redacts secret artifacts entirely", () => {
      const envelope: ArtifactEnvelope = {
        artifactId: "art-1",
        type: "secret",
        schemaVersion: 1,
        taskId: "t",
        runId: "r",
        producer: { stepId: "s" },
        createdAt: new Date().toISOString(),
        contentHash: "hash-1",
        hashAlgorithm: "sha256-canonical-json-v1",
        payload: { apiKey: "sk-secret-123", password: "hunter2" },
        sensitivity: "secret",
      };
      const sanitized = sanitizeArtifactForPersistence(envelope);
      expect(sanitized.payload).toBe("[redacted:secret]");
      expect(sanitized.contentHash).toBe(computeContentHash("[redacted:secret]"));
      expect(sanitized.sourceContentHash).toBe("hash-1");
    });

    it("redacts image data URLs in non-secret artifacts", () => {
      const envelope: ArtifactEnvelope = {
        artifactId: "art-2",
        type: "screenshot",
        schemaVersion: 1,
        taskId: "t",
        runId: "r",
        producer: { stepId: "s" },
        createdAt: new Date().toISOString(),
        contentHash: "hash-2",
        hashAlgorithm: "sha256-canonical-json-v1",
        payload: { image: "data:image/png;base64,iVBORw0KGgo" },
      };
      const sanitized = sanitizeArtifactForPersistence(envelope);
      expect((sanitized.payload as { image: string }).image).toContain("[redacted:image data URL]");
    });

    it("redacts secret-like fields and strings in non-secret artifacts", () => {
      const envelope = createArtifactEnvelope({
        apiKey: "sk-project-secret-value",
        nested: {
          password: "hunter2",
          message: "Authorization: Bearer bearer-secret-value and token=plain-secret",
          url: "https://alice:password123@example.com/path",
        },
      }, {
        taskId: "t",
        runId: "r",
        type: "toolResult",
        producer: { stepId: "s" },
        sensitivity: "workspace",
      });

      const sanitized = sanitizeArtifactForPersistence(envelope);
      const serialized = JSON.stringify(sanitized.payload);
      expect(serialized).not.toContain("sk-project-secret-value");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("bearer-secret-value");
      expect(serialized).not.toContain("plain-secret");
      expect(serialized).not.toContain("password123");
      expect(serialized).toContain("[redacted:secret]");
      expect(sanitized.sourceContentHash).toBe(envelope.contentHash);
      expect(sanitized.contentHash).not.toBe(envelope.contentHash);
    });

    it("truncates long strings", () => {
      const longString = "x".repeat(25_000);
      const envelope: ArtifactEnvelope = {
        artifactId: "art-3",
        type: "text",
        schemaVersion: 1,
        taskId: "t",
        runId: "r",
        producer: { stepId: "s" },
        createdAt: new Date().toISOString(),
        contentHash: "hash-3",
        hashAlgorithm: "sha256-canonical-json-v1",
        payload: longString,
      };
      const sanitized = sanitizeArtifactForPersistence(envelope);
      expect((sanitized.payload as string).length).toBeLessThan(25_000);
      expect(sanitized.payload).toContain("[truncated]");
    });

    it("caps oversized arrays", () => {
      const bigArray = Array.from({ length: 500 }, (_, i) => i);
      const envelope: ArtifactEnvelope = {
        artifactId: "art-4",
        type: "list",
        schemaVersion: 1,
        taskId: "t",
        runId: "r",
        producer: { stepId: "s" },
        createdAt: new Date().toISOString(),
        contentHash: "hash-4",
        hashAlgorithm: "sha256-canonical-json-v1",
        payload: bigArray,
      };
      const sanitized = sanitizeArtifactForPersistence(envelope);
      expect((sanitized.payload as unknown[]).length).toBe(200);
    });

    it("normalizes undefined values before JSON persistence", () => {
      const envelope = createArtifactEnvelope({
        omitted: undefined,
        nested: [1, undefined, { kept: "value", omitted: undefined }],
      }, {
        taskId: "t",
        runId: "r",
        type: "toolResult",
        producer: { stepId: "s" },
      });

      const persisted = JSON.parse(JSON.stringify(sanitizeArtifactForPersistence(envelope)));

      expect(persisted.payload).toEqual({
        nested: [1, null, { kept: "value" }],
      });
      expect(validateArtifactEnvelope(persisted)).toBe(true);
    });

    it("preserves untrusted object keys without changing the sanitized prototype", () => {
      const payload = JSON.parse('{"__proto__":{"polluted":true},"value":"kept"}');
      const envelope = createArtifactEnvelope(payload, {
        taskId: "t",
        runId: "r",
        type: "toolResult",
        producer: { stepId: "s" },
      });

      const sanitized = sanitizeArtifactForPersistence(envelope);
      const sanitizedPayload = sanitized.payload as Record<string, unknown>;

      expect(Object.getPrototypeOf(sanitizedPayload)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(sanitizedPayload, "__proto__")).toBe(true);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      expect(validateArtifactEnvelope(JSON.parse(JSON.stringify(sanitized)))).toBe(true);
    });
  });

  describe("summarizeArtifactForHandoff", () => {
    it("returns summary with type, schema, producer, hash", () => {
      const envelope = createArtifactEnvelope({ diff: "test" }, {
        taskId: "t",
        runId: "r",
        type: "diffPreview",
        schemaVersion: 2,
        producer: { stepId: "s1", agentKind: "code", toolName: "code.proposeEdit" },
        sensitivity: "workspace",
      });
      const summary = summarizeArtifactForHandoff(envelope);

      expect(summary.type).toBe("diffPreview");
      expect(summary.schemaVersion).toBe(2);
      expect(summary.producer.stepId).toBe("s1");
      expect(summary.producer.agentKind).toBe("code");
      expect(summary.producer.toolName).toBe("code.proposeEdit");
      expect(summary.contentHash).toBeTruthy();
      expect(summary.sensitivity).toBe("workspace");
      expect(summary.payloadType).toBe("object");
      expect(summary.payloadSize).toBeGreaterThan(0);
    });
  });
});

describe("SharedTaskContext envelope support", () => {
  it("setEnvelope stores both payload and envelope", () => {
    const ctx = createSharedTaskContext();
    const envelope = createArtifactEnvelope({ diff: "test", changedFiles: ["a.ts"] }, {
      taskId: "t",
      runId: "r",
      type: "diffPreview",
      producer: { stepId: "s1", agentKind: "code" },
    });
    ctx.setEnvelope("diffPreview", envelope);

    expect(ctx.get("diffPreview")).toEqual({ diff: "test", changedFiles: ["a.ts"] });
    expect(ctx.getEnvelope("diffPreview")).toBe(envelope);
    expect(ctx.hasEnvelope("diffPreview")).toBe(true);
    expect(ctx.has("diffPreview")).toBe(true);
  });

  it("getEnvelope returns undefined for non-enveloped keys", () => {
    const ctx = createSharedTaskContext();
    ctx.set("legacy", { data: 1 });

    expect(ctx.get("legacy")).toEqual({ data: 1 });
    expect(ctx.getEnvelope("legacy")).toBeUndefined();
    expect(ctx.hasEnvelope("legacy")).toBe(false);
  });

  it("clear removes both payloads and envelopes", () => {
    const ctx = createSharedTaskContext();
    ctx.setEnvelope("key1", createArtifactEnvelope({ a: 1 }, {
      taskId: "t", runId: "r", type: "test", producer: { stepId: "s" },
    }));
    ctx.clear();

    expect(ctx.has("key1")).toBe(false);
    expect(ctx.hasEnvelope("key1")).toBe(false);
  });

  it("snapshot returns payloads without envelope metadata", () => {
    const ctx = createSharedTaskContext();
    ctx.setEnvelope("diffPreview", createArtifactEnvelope({ diff: "x" }, {
      taskId: "t", runId: "r", type: "diffPreview", producer: { stepId: "s" },
    }));
    const snap = ctx.snapshot();

    expect(snap.diffPreview).toEqual({ diff: "x" });
  });
});

describe("buildHandoffReport with artifact provenance", () => {
  it("keeps secret handoff summaries metadata-only in JSON and Markdown", () => {
    const ctx = createSharedTaskContext();
    ctx.setEnvelope("apiSecret", createArtifactEnvelope(
      { apiKey: "sk-secret-123", password: "hunter2" },
      {
        taskId: "t",
        runId: "r",
        type: "apiSecret",
        producer: { stepId: "secret-step", agentKind: "code" },
        sensitivity: "secret",
      },
    ));

    const report = buildHandoffReport(
      [{ id: "secret-step", assignedAgentKind: "code", outputContextKey: "apiSecret" }],
      ctx,
      { previewLength: 120 },
    );
    const handoff = report.handoffs[0];
    expect(handoff?.valueSummary).toEqual({ type: "object", present: true });

    const json = JSON.stringify(report);
    expect(json).not.toContain("sk-secret-123");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain('"preview"');
    expect(json).not.toContain('"keyCount"');
    expect(json).not.toContain('"itemCount"');

    const markdown = formatHandoffReportMarkdown(report);
    expect(markdown).not.toContain("sk-secret-123");
    expect(markdown).not.toContain("hunter2");
    expect(markdown).not.toContain("key(s)");
    expect(markdown).not.toContain("item(s)");
  });

  it("includes artifact info in handoffs when envelopes are present", () => {
    const ctx = createSharedTaskContext();
    ctx.setEnvelope("diffPreview", createArtifactEnvelope(
      { diff: "test", changedFiles: ["a.ts"] },
      {
        taskId: "t",
        runId: "r",
        type: "diffPreview",
        producer: { stepId: "code-step", agentKind: "code", toolName: "code.proposeEdit" },
        sensitivity: "workspace",
      },
    ));

    const report = buildHandoffReport(
      [
        {
          id: "code-step",
          assignedAgentKind: "code",
          outputContextKey: "diffPreview",
        },
        {
          id: "verify-step",
          assignedAgentKind: "verifier",
          inputContextKeys: ["diffPreview"],
          dependsOn: ["code-step"],
        },
      ],
      ctx,
    );

    const diffHandoff = report.handoffs.find((h) => h.contextKey === "diffPreview");
    expect(diffHandoff).toBeDefined();
    expect(diffHandoff?.artifact).toBeDefined();
    expect(diffHandoff?.artifact?.type).toBe("diffPreview");
    expect(diffHandoff?.artifact?.producer.stepId).toBe("code-step");
    expect(diffHandoff?.artifact?.producer.agentKind).toBe("code");
    expect(diffHandoff?.artifact?.sensitivity).toBe("workspace");
    expect(diffHandoff?.artifact?.contentHash).toBeTruthy();
  });

  it("does not include artifact info for non-enveloped keys", () => {
    const ctx = createSharedTaskContext();
    ctx.set("legacy", { data: 1 });

    const report = buildHandoffReport(
      [
        {
          id: "step-1",
          assignedAgentKind: "file",
          outputContextKey: "legacy",
        },
      ],
      ctx,
    );

    const handoff = report.handoffs.find((h) => h.contextKey === "legacy");
    expect(handoff?.artifact).toBeUndefined();
  });

  it("preserves artifact identity across replan scenarios", () => {
    const ctx = createSharedTaskContext();
    const envelope1 = createArtifactEnvelope({ diff: "v1" }, {
      taskId: "t", runId: "r", type: "diffPreview", producer: { stepId: "s1" },
    });
    ctx.setEnvelope("diffPreview", envelope1);

    const envelope2 = createArtifactEnvelope({ diff: "v2" }, {
      taskId: "t", runId: "r", type: "diffPreview", producer: { stepId: "s1-replan" },
    });
    ctx.setEnvelope("diffPreview", envelope2);

    const report = buildHandoffReport(
      [{ id: "s1-replan", assignedAgentKind: "code", outputContextKey: "diffPreview" }],
      ctx,
    );

    const handoff = report.handoffs.find((h) => h.contextKey === "diffPreview");
    expect(handoff?.artifact?.artifactId).toBe(envelope2.artifactId);
    expect(handoff?.artifact?.producer.stepId).toBe("s1-replan");
    expect(handoff?.artifact?.contentHash).not.toBe(envelope1.contentHash);
    expect(ctx.getEnvelopeHistory("diffPreview")).toEqual([envelope1]);
    expect(handoff?.artifact?.previousArtifacts).toEqual([
      {
        artifactId: envelope1.artifactId,
        contentHash: envelope1.contentHash,
        producer: { stepId: "s1", agentKind: undefined, toolName: undefined },
      },
    ]);
  });
});
