import type { DatabaseValue, DesktopDatabaseMigration } from "./desktop-database";

export const VECTOR_INDEX_ITEMS_TABLE_NAME = "vector_index_items";
export const VECTOR_INDEX_BUCKETS_TABLE_NAME = "vector_index_buckets";

export const VECTOR_INDEX_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "vector-index-v1-items-table",
    sql: `
CREATE TABLE IF NOT EXISTS ${VECTOR_INDEX_ITEMS_TABLE_NAME} (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_type TEXT,
  scope_id TEXT,
  content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  metric TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  vector_norm REAL NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`.trim(),
  },
  {
    id: "vector-index-v1-buckets-table",
    sql: `
CREATE TABLE IF NOT EXISTS ${VECTOR_INDEX_BUCKETS_TABLE_NAME} (
  namespace TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (namespace, bucket_key, item_id)
)`.trim(),
  },
  {
    id: "vector-index-v1-owner-index",
    sql: `CREATE INDEX IF NOT EXISTS idx_vector_index_owner ON ${VECTOR_INDEX_ITEMS_TABLE_NAME}(owner_type, owner_id)`,
  },
  {
    id: "vector-index-v1-scope-index",
    sql: `CREATE INDEX IF NOT EXISTS idx_vector_index_scope ON ${VECTOR_INDEX_ITEMS_TABLE_NAME}(namespace, scope_type, scope_id)`,
  },
];

export interface VectorIndexItemInput {
  namespace: string;
  ownerType: string;
  ownerId: string;
  scopeType?: string;
  scopeId?: string;
  contentHash: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface VectorIndexSearchInput {
  namespace: string;
  vector: number[];
  scopeType?: string;
  scopeId?: string;
  limit?: number;
  candidateMultiplier?: number;
  minScore?: number;
}

export interface VectorIndexSearchResult {
  ownerId: string;
  itemId: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorIndexRepository {
  upsertItem(input: VectorIndexItemInput): Promise<void>;
  deleteByOwner(ownerType: string, ownerId: string): Promise<void>;
  deleteByScope(namespace: string, scopeType: string, scopeId: string): Promise<void>;
  clearNamespace(namespace: string): Promise<void>;
  search(input: VectorIndexSearchInput): Promise<VectorIndexSearchResult[]>;
}

interface VectorIndexRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  owner_id: string;
  scope_type?: string | null;
  scope_id?: string | null;
  dimensions: number;
  metric: string;
  vector_json: string;
  vector_norm: number;
  metadata_json?: string | null;
}

const METRIC = "cosine";
const LSH_TABLE_COUNT = 4;
const LSH_BITS_PER_TABLE = 8;

const UPSERT_VECTOR_ITEM_SQL = `
INSERT INTO ${VECTOR_INDEX_ITEMS_TABLE_NAME} (
  id, namespace, owner_type, owner_id, scope_type, scope_id, content_hash,
  dimensions, metric, vector_json, vector_norm, metadata_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  namespace = excluded.namespace,
  owner_type = excluded.owner_type,
  owner_id = excluded.owner_id,
  scope_type = excluded.scope_type,
  scope_id = excluded.scope_id,
  content_hash = excluded.content_hash,
  dimensions = excluded.dimensions,
  metric = excluded.metric,
  vector_json = excluded.vector_json,
  vector_norm = excluded.vector_norm,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at`.trim();

const INSERT_BUCKET_SQL = `
INSERT OR IGNORE INTO ${VECTOR_INDEX_BUCKETS_TABLE_NAME} (namespace, bucket_key, item_id)
VALUES (?, ?, ?)`.trim();

const DELETE_BUCKETS_BY_ITEM_SQL = `DELETE FROM ${VECTOR_INDEX_BUCKETS_TABLE_NAME} WHERE item_id = ?`;
const DELETE_ITEM_SQL = `DELETE FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME} WHERE id = ?`;
const SELECT_ITEMS_BY_OWNER_SQL = `SELECT id FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME} WHERE owner_type = ? AND owner_id = ?`;
const SELECT_ITEMS_BY_SCOPE_SQL = `SELECT id FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME} WHERE namespace = ? AND scope_type = ? AND scope_id = ?`;
const SELECT_BUCKET_ITEM_IDS_SQL = `SELECT item_id FROM ${VECTOR_INDEX_BUCKETS_TABLE_NAME} WHERE namespace = ? AND bucket_key = ? LIMIT ?`;
const SELECT_ITEM_BY_ID_SQL = `
SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME}
WHERE id = ?
LIMIT 1`.trim();
const SELECT_NAMESPACE_ITEMS_SQL = `
SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME}
WHERE namespace = ?
LIMIT ?`.trim();
const SELECT_SCOPED_ITEMS_SQL = `
SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME}
WHERE namespace = ? AND scope_type = ? AND scope_id = ?
LIMIT ?`.trim();

export function createVectorIndexRepository(
  database: Pick<{ execute(sql: string, bindValues?: DatabaseValue[]): Promise<void>; select<T extends Record<string, unknown>>(sql: string, bindValues?: DatabaseValue[]): Promise<T[]> }, "execute" | "select">,
): VectorIndexRepository {
  return {
    async upsertItem(input) {
      const item = sanitizeVectorItem(input);
      const now = input.now ?? Date.now();
      const itemId = createVectorItemId(item.namespace, item.ownerType, item.ownerId);
      await database.execute(UPSERT_VECTOR_ITEM_SQL, [
        itemId,
        item.namespace,
        item.ownerType,
        item.ownerId,
        item.scopeType ?? null,
        item.scopeId ?? null,
        item.contentHash,
        item.vector.length,
        METRIC,
        JSON.stringify(item.vector),
        vectorNorm(item.vector),
        item.metadata ? JSON.stringify(item.metadata) : null,
        now,
        now,
      ]);
      await database.execute(DELETE_BUCKETS_BY_ITEM_SQL, [itemId]);
      for (const bucketKey of createLshBucketKeys(item.vector)) {
        await database.execute(INSERT_BUCKET_SQL, [item.namespace, bucketKey, itemId]);
      }
    },

    async deleteByOwner(ownerType, ownerId) {
      const rows = await database.select<{ id: string }>(SELECT_ITEMS_BY_OWNER_SQL, [clean(ownerType), clean(ownerId)]);
      for (const row of rows) {
        await deleteItem(database, row.id);
      }
    },

    async deleteByScope(namespace, scopeType, scopeId) {
      const rows = await database.select<{ id: string }>(SELECT_ITEMS_BY_SCOPE_SQL, [clean(namespace), clean(scopeType), clean(scopeId)]);
      for (const row of rows) {
        await deleteItem(database, row.id);
      }
    },

    async clearNamespace(namespace) {
      const rows = await database.select<{ id: string }>(`SELECT id FROM ${VECTOR_INDEX_ITEMS_TABLE_NAME} WHERE namespace = ?`, [clean(namespace)]);
      for (const row of rows) {
        await deleteItem(database, row.id);
      }
    },

    async search(input) {
      const queryVector = sanitizeVector(input.vector);
      const namespace = clean(input.namespace);
      const limit = clampInteger(input.limit ?? 8, 1, 50, 8);
      const candidateLimit = limit * clampInteger(input.candidateMultiplier ?? 8, 1, 30, 8);
      const bucketItemIds = new Set<string>();
      for (const bucketKey of createLshBucketKeys(queryVector)) {
        const rows = await database.select<{ item_id: string }>(SELECT_BUCKET_ITEM_IDS_SQL, [namespace, bucketKey, candidateLimit]);
        for (const row of rows) {
          bucketItemIds.add(row.item_id);
        }
      }
      const rows = bucketItemIds.size > 0
        ? await selectRowsByIds(database, [...bucketItemIds], input, candidateLimit)
        : await selectFallbackRows(database, input, candidateLimit);
      const minScore = Number.isFinite(input.minScore) ? Number(input.minScore) : -1;
      const scored = rows
        .map((row) => scoreVectorRow(row, queryVector))
        .filter((result): result is VectorIndexSearchResult => Boolean(result));
      return scored
        .filter((result) => result.score >= minScore)
        .sort((left, right) => right.score - left.score || left.ownerId.localeCompare(right.ownerId))
        .slice(0, limit);
    },
  };
}

async function selectRowsByIds(
  database: Pick<{ select<T extends Record<string, unknown>>(sql: string, bindValues?: DatabaseValue[]): Promise<T[]> }, "select">,
  itemIds: string[],
  input: VectorIndexSearchInput,
  limit: number,
): Promise<VectorIndexRow[]> {
  const rows: VectorIndexRow[] = [];
  for (const itemId of itemIds.slice(0, limit)) {
    const matches = await database.select<VectorIndexRow>(SELECT_ITEM_BY_ID_SQL, [itemId]);
    rows.push(...matches.filter((row) => vectorRowMatchesSearch(row, input)));
  }
  return rows;
}

async function selectFallbackRows(
  database: Pick<{ select<T extends Record<string, unknown>>(sql: string, bindValues?: DatabaseValue[]): Promise<T[]> }, "select">,
  input: VectorIndexSearchInput,
  limit: number,
): Promise<VectorIndexRow[]> {
  if (input.scopeType && input.scopeId) {
    return database.select<VectorIndexRow>(SELECT_SCOPED_ITEMS_SQL, [clean(input.namespace), clean(input.scopeType), clean(input.scopeId), limit]);
  }
  return database.select<VectorIndexRow>(SELECT_NAMESPACE_ITEMS_SQL, [clean(input.namespace), limit]);
}

async function deleteItem(
  database: Pick<{ execute(sql: string, bindValues?: DatabaseValue[]): Promise<void> }, "execute">,
  itemId: string,
): Promise<void> {
  await database.execute(DELETE_BUCKETS_BY_ITEM_SQL, [itemId]);
  await database.execute(DELETE_ITEM_SQL, [itemId]);
}

function scoreVectorRow(row: VectorIndexRow, queryVector: number[]): VectorIndexSearchResult | undefined {
  if (row.metric !== METRIC || row.dimensions !== queryVector.length) return undefined;
  const vector = parseVector(row.vector_json);
  if (!vector || vector.length !== queryVector.length) return undefined;
  return {
    ownerId: row.owner_id,
    itemId: row.id,
    score: cosineSimilarity(queryVector, vector, row.vector_norm),
    metadata: parseMetadata(row.metadata_json),
  };
}

function vectorRowMatchesSearch(row: VectorIndexRow, input: VectorIndexSearchInput): boolean {
  if (row.namespace !== clean(input.namespace)) return false;
  if (!input.scopeType && !input.scopeId) return true;
  return row.scope_type === input.scopeType && row.scope_id === input.scopeId;
}

function createVectorItemId(namespace: string, ownerType: string, ownerId: string): string {
  return `${namespace}:${ownerType}:${ownerId}`;
}

function sanitizeVectorItem(input: VectorIndexItemInput): Required<Omit<VectorIndexItemInput, "metadata" | "now" | "scopeType" | "scopeId">> & Pick<VectorIndexItemInput, "metadata" | "scopeType" | "scopeId"> {
  return {
    namespace: clean(input.namespace),
    ownerType: clean(input.ownerType),
    ownerId: clean(input.ownerId),
    scopeType: input.scopeType ? clean(input.scopeType) : undefined,
    scopeId: input.scopeId ? clean(input.scopeId) : undefined,
    contentHash: clean(input.contentHash),
    vector: sanitizeVector(input.vector),
    metadata: input.metadata,
  };
}

function sanitizeVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > 4096) {
    throw new Error("Vector index requires a non-empty vector with at most 4096 dimensions.");
  }
  const output = vector.map((value) => Number(value));
  if (!output.every(Number.isFinite)) {
    throw new Error("Vector index values must be finite numbers.");
  }
  return output;
}

function clean(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Vector index values must be non-empty strings.");
  return trimmed;
}

function createLshBucketKeys(vector: number[]): string[] {
  const output: string[] = [];
  for (let table = 0; table < LSH_TABLE_COUNT; table += 1) {
    let bits = "";
    for (let bit = 0; bit < LSH_BITS_PER_TABLE; bit += 1) {
      bits += dotDeterministicPlane(vector, table, bit) >= 0 ? "1" : "0";
    }
    output.push(`lsh:${table}:${bits}`);
  }
  return output;
}

function dotDeterministicPlane(vector: number[], table: number, bit: number): number {
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) {
    total += vector[index]! * deterministicPlaneWeight(table, bit, index);
  }
  return total;
}

function deterministicPlaneWeight(table: number, bit: number, dimension: number): number {
  const hash = hashString(`${table}:${bit}:${dimension}`);
  return ((hash % 2001) / 1000) - 1;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cosineSimilarity(queryVector: number[], rowVector: number[], rowNorm: number): number {
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0 || rowNorm === 0) return 0;
  let dot = 0;
  for (let index = 0; index < queryVector.length; index += 1) {
    dot += queryVector[index]! * rowVector[index]!;
  }
  return dot / (queryNorm * rowNorm);
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

function parseVector(value: string): number[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
