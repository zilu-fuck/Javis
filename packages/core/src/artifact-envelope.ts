import { isSensitiveFieldName, redactSensitiveText } from "./sensitive-data";

export interface ArtifactProducerRef {
  workflowId?: string;
  stepId: string;
  agentKind?: string;
  agentId?: string;
  toolName?: string;
}

export interface ArtifactEnvelopeExpectation {
  taskId?: string;
  runId?: string;
  artifactId?: string;
  createdAt?: string;
  producer?: Partial<ArtifactProducerRef>;
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
  outputSchemaRef?: string;

  taskId: string;
  runId: string;
  producer: ArtifactProducerRef;

  createdAt: string;
  contentHash: string;
  hashAlgorithm: ArtifactHashAlgorithm;
  /** Original source hash when persistence sanitizes or redacts the payload. */
  sourceContentHash?: string;

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
    outputSchemaRef?: string;
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
    ...(context.outputSchemaRef ? { outputSchemaRef: context.outputSchemaRef } : {}),
    taskId: context.taskId,
    runId: context.runId,
    producer: { ...context.producer },
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
  return sha256Hex(utf8Bytes(canonical));
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

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function sha256Hex(input: number[]): string {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = [...input, 0x80];
  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }
  const bitLength = input.length * 8;
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / (2 ** shift)) & 0xff);
  }

  const w = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const base = offset + i * 4;
      w[i] = (
        (bytes[base] << 24) |
        (bytes[base + 1] << 16) |
        (bytes[base + 2] << 8) |
        bytes[base + 3]
      ) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sanitizeArtifactForPersistence<T>(envelope: ArtifactEnvelope<T>): ArtifactEnvelope<unknown> {
  if (envelope.sensitivity === "secret") {
    const payload = "[redacted:secret]";
    return {
      ...envelope,
      payload,
      sourceContentHash: envelope.sourceContentHash ?? envelope.contentHash,
      contentHash: computeContentHash(payload),
    };
  }

  const sanitizedPayload = deepSanitize(envelope.payload);
  return {
    ...envelope,
    payload: sanitizedPayload,
    ...(computeContentHash(sanitizedPayload) === envelope.contentHash
      ? {}
      : {
          sourceContentHash: envelope.sourceContentHash ?? envelope.contentHash,
          contentHash: computeContentHash(sanitizedPayload),
        }),
  };
}

function deepSanitize(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[truncated:depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let sanitized = redactSensitiveText(
      value.replace(IMAGE_DATA_URL_PATTERN, "[redacted:image data URL]"),
    );
    if (sanitized.length > PERSISTED_TEXT_MAX_LENGTH) {
      sanitized = sanitized.slice(0, PERSISTED_TEXT_MAX_LENGTH) + "[truncated]";
    }
    return sanitized;
  }

  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value.length > PERSISTED_ARRAY_MAX_ITEMS
      ? value.slice(0, PERSISTED_ARRAY_MAX_ITEMS)
      : value;
    return items.map((item) => deepSanitize(item, depth + 1) ?? null);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const limited = keys.length > PERSISTED_OBJECT_MAX_ENTRIES
      ? keys.slice(0, PERSISTED_OBJECT_MAX_ENTRIES)
      : keys;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of limited) {
      const sanitized = isSensitiveFieldName(key)
        ? "[redacted:secret]"
        : deepSanitize(record[key], depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
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
    typeof obj.producer === "object" &&
    obj.producer !== null &&
    typeof obj.createdAt === "string" &&
    typeof obj.contentHash === "string" &&
    typeof obj.hashAlgorithm === "string" &&
    obj.payload !== undefined
  );
}

export function validateArtifactEnvelope(
  value: unknown,
  expected?: ArtifactEnvelopeExpectation,
): value is ArtifactEnvelope {
  if (!isArtifactEnvelope(value)) return false;
  if (!isValidArtifactId(value.artifactId, value.runId, value.createdAt)) return false;
  if (!hasNonEmptyText(value.type) || !hasNonEmptyText(value.taskId) || !hasNonEmptyText(value.runId)) {
    return false;
  }
  if (value.schemaVersion < 1 || !Number.isInteger(value.schemaVersion)) return false;
  if (value.hashAlgorithm !== "sha256-canonical-json-v1" && value.hashAlgorithm !== "sha256-bytes-v1") {
    return false;
  }
  if (expected?.taskId !== undefined && value.taskId !== expected.taskId) return false;
  if (expected?.runId !== undefined && value.runId !== expected.runId) return false;
  if (expected?.artifactId !== undefined && value.artifactId !== expected.artifactId) return false;
  if (expected?.createdAt !== undefined && value.createdAt !== expected.createdAt) return false;
  if (!isValidArtifactProducer(value.producer)) return false;
  if (expected?.producer && !matchesExpectedProducer(value.producer, expected.producer)) return false;
  if (value.hashAlgorithm !== "sha256-canonical-json-v1") return false;
  if (!/^[0-9a-f]{64}$/u.test(value.contentHash)) return false;
  if (computeContentHash(value.payload) !== value.contentHash) return false;
  if (value.sourceContentHash !== undefined && !/^[0-9a-f]{64}$/u.test(value.sourceContentHash)) return false;
  if (value.sensitivity !== undefined && !["public", "workspace", "secret"].includes(value.sensitivity)) {
    return false;
  }
  return true;
}

function isValidArtifactId(artifactId: string, runId: string, createdAt: string): boolean {
  if (!hasNonEmptyText(artifactId) || !hasNonEmptyText(runId) || !isCanonicalIsoDateTime(createdAt)) {
    return false;
  }
  const prefix = `art-${runId}-`;
  if (!artifactId.startsWith(prefix)) return false;
  const match = /^([1-9]\d*)-(\d{12,16})$/u.exec(artifactId.slice(prefix.length));
  if (!match) return false;
  const artifactTimestamp = Number(match[2]);
  return Number.isSafeInteger(artifactTimestamp) &&
    Math.abs(artifactTimestamp - Date.parse(createdAt)) <= 1_000;
}

function isCanonicalIsoDateTime(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isValidArtifactProducer(producer: ArtifactProducerRef): boolean {
  if (!hasNonEmptyText(producer.stepId)) return false;
  return (["workflowId", "agentKind", "agentId", "toolName"] as const).every((key) =>
    producer[key] === undefined || hasNonEmptyText(producer[key]),
  );
}

function matchesExpectedProducer(
  producer: ArtifactProducerRef,
  expected: Partial<ArtifactProducerRef>,
): boolean {
  return (["workflowId", "stepId", "agentKind", "agentId", "toolName"] as const).every((key) =>
    expected[key] === undefined || producer[key] === expected[key],
  );
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resetArtifactIdCounter(): void {
  artifactIdCounter = 0;
}

export function summarizeArtifactForHandoff(envelope: ArtifactEnvelope): {
  type: string;
  schemaVersion: number;
  outputSchemaRef?: string;
  producer: ArtifactProducerRef;
  contentHash: string;
  sensitivity: ArtifactSensitivity | "public";
  payloadType: string;
  payloadSize: number;
} {
  return {
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    ...(envelope.outputSchemaRef ? { outputSchemaRef: envelope.outputSchemaRef } : {}),
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
