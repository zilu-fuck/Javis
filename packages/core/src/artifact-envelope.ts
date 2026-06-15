export interface ArtifactProducerRef {
  stepId: string;
  agentKind?: string;
  agentId?: string;
  toolName?: string;
}

export interface EvidenceReference {
  kind: "file" | "command" | "url" | "screenshot" | "log" | "manual";
  label: string;
  reference?: string;
}

export type ArtifactHashAlgorithm = "sha256-canonical-json-v1" | "sha256-bytes-v1";

export type ArtifactSensitivity = "public" | "workspace" | "secret";

export interface ArtifactEnvelope<T = unknown> {
  artifactId: string;
  type: string;
  schemaVersion: number;

  taskId: string;
  runId: string;
  producer: ArtifactProducerRef;

  createdAt: string;
  contentHash: string;
  hashAlgorithm: ArtifactHashAlgorithm;

  payload: T;
  sourceRefs?: EvidenceReference[];
  sensitivity?: ArtifactSensitivity;
}

const PERSISTED_TEXT_MAX_LENGTH = 20_000;
const PERSISTED_ARRAY_MAX_ITEMS = 200;
const PERSISTED_OBJECT_MAX_ENTRIES = 120;
const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;

let artifactIdCounter = 0;

export function createArtifactEnvelope<T>(
  payload: T,
  context: {
    taskId: string;
    runId: string;
    type: string;
    schemaVersion?: number;
    producer: ArtifactProducerRef;
    sourceRefs?: EvidenceReference[];
    sensitivity?: ArtifactSensitivity;
  },
): ArtifactEnvelope<T> {
  artifactIdCounter += 1;
  const now = new Date().toISOString();
  return {
    artifactId: `art-${context.runId}-${artifactIdCounter}-${Date.now()}`,
    type: context.type,
    schemaVersion: context.schemaVersion ?? 1,
    taskId: context.taskId,
    runId: context.runId,
    producer: context.producer,
    createdAt: now,
    contentHash: computeContentHash(payload),
    hashAlgorithm: "sha256-canonical-json-v1",
    payload,
    sourceRefs: context.sourceRefs,
    sensitivity: context.sensitivity,
  };
}

export function computeContentHash(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  return simpleHash(canonical);
}

function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>).sort();
    const entries = sorted.map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return String(value);
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `simple-${hex}-${input.length}`;
}

export function sanitizeArtifactForPersistence<T>(envelope: ArtifactEnvelope<T>): ArtifactEnvelope<unknown> {
  if (envelope.sensitivity === "secret") {
    return {
      ...envelope,
      payload: "[redacted:secret]" as unknown as T,
      contentHash: envelope.contentHash,
    };
  }

  const sanitizedPayload = deepSanitize(envelope.payload);
  return {
    ...envelope,
    payload: sanitizedPayload,
  };
}

function deepSanitize(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[truncated:depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let sanitized = value.replace(IMAGE_DATA_URL_PATTERN, "[redacted:image data URL]");
    if (sanitized.length > PERSISTED_TEXT_MAX_LENGTH) {
      sanitized = sanitized.slice(0, PERSISTED_TEXT_MAX_LENGTH) + "[truncated]";
    }
    return sanitized;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value.length > PERSISTED_ARRAY_MAX_ITEMS
      ? value.slice(0, PERSISTED_ARRAY_MAX_ITEMS)
      : value;
    return items.map((item) => deepSanitize(item, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const limited = keys.length > PERSISTED_OBJECT_MAX_ENTRIES
      ? keys.slice(0, PERSISTED_OBJECT_MAX_ENTRIES)
      : keys;
    const result: Record<string, unknown> = {};
    for (const key of limited) {
      result[key] = deepSanitize(record[key], depth + 1);
    }
    if (keys.length > PERSISTED_OBJECT_MAX_ENTRIES) {
      result["[truncated:keys]"] = keys.length;
    }
    return result;
  }

  return value;
}

export function isArtifactEnvelope(value: unknown): value is ArtifactEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.artifactId === "string" &&
    typeof obj.type === "string" &&
    typeof obj.schemaVersion === "number" &&
    typeof obj.taskId === "string" &&
    typeof obj.runId === "string" &&
    typeof obj.contentHash === "string" &&
    obj.payload !== undefined
  );
}

export function resetArtifactIdCounter(): void {
  artifactIdCounter = 0;
}

export function summarizeArtifactForHandoff(envelope: ArtifactEnvelope): {
  type: string;
  schemaVersion: number;
  producer: ArtifactProducerRef;
  contentHash: string;
  sensitivity: ArtifactSensitivity | "public";
  payloadType: string;
  payloadSize: number;
} {
  return {
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    producer: envelope.producer,
    contentHash: envelope.contentHash,
    sensitivity: envelope.sensitivity ?? "public",
    payloadType: typeof envelope.payload === "object"
      ? Array.isArray(envelope.payload) ? "array" : "object"
      : typeof envelope.payload,
    payloadSize: estimatePayloadSize(envelope.payload),
  };
}

function estimatePayloadSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return -1;
  }
}
