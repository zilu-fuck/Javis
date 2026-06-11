import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import type { VectorIndexRepository } from "./vector-index";

export const AGENT_SESSION_SUMMARIES_TABLE_NAME = "agent_session_summaries";
export const AGENT_MEMORY_FACTS_TABLE_NAME = "agent_memory_facts";
export const AGENT_MEMORY_FACTS_FTS_TABLE_NAME = "agent_memory_facts_fts";
export const MEMORY_INJECTION_LOGS_TABLE_NAME = "memory_injection_logs";

export type AgentMemoryScopeType = "global" | "workspace" | "session";

export type AgentMemoryFactKind =
  | "user_preference"
  | "workspace_context"
  | "product_decision"
  | "technical_constraint"
  | "design_principle"
  | "workflow"
  | "personal_note"
  | "other";

export type AgentMemoryFactStatus = "active" | "archived";

export type MemoryInjectionType =
  | "user_profile"
  | "workspace_memory"
  | "recent_summary"
  | "retrieved_memory";

export interface AgentMemoryFact {
  id: string;
  fact: string;
  normalizedFact?: string;
  kind: AgentMemoryFactKind;
  tags: string[];
  keywords: string[];
  searchText: string;
  scopeType: AgentMemoryScopeType;
  scopeId?: string;
  sourceSessionId?: string;
  sourceMessageIds: string[];
  confidence: number;
  importance: number;
  status: AgentMemoryFactStatus;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  expiresAt?: number;
}

export interface AgentSessionSummary {
  id: string;
  sessionId: string;
  workspaceId?: string;
  summary: string;
  importantPoints: string[];
  openThreads: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryInjectionLogInput {
  id: string;
  sessionId: string;
  messageId?: string;
  workspaceId?: string;
  injectionType: MemoryInjectionType;
  memoryFactIds: string[];
  query?: string;
  queryHashSecret?: string;
  queryTerms?: string[];
  scopeType?: AgentMemoryScopeType;
  scopeId?: string;
  promptSection?: string;
  scoreSummary?: Record<string, unknown>;
  createdAt?: number;
}

export interface SearchMemoryInput {
  query: string;
  tags?: string[];
  kind?: AgentMemoryFactKind[];
  scopeType?: AgentMemoryScopeType;
  scopeId?: string;
  limit?: number;
  now?: number;
}

export interface SearchMemoryResult {
  id: string;
  fact: string;
  kind: AgentMemoryFactKind;
  tags: string[];
  scopeType: AgentMemoryScopeType;
  scopeId?: string;
  confidence: number;
  importance: number;
  updatedAt: number;
  sourceSessionId?: string;
  score: number;
}

export interface AgentMemoryVectorBackfillInput {
  scopeType?: AgentMemoryScopeType;
  scopeId?: string;
  limit?: number;
}

export interface AgentMemoryVectorBackfillResult {
  indexedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface AgentMemoryFactPreview {
  id: string;
  fact: string;
  kind: AgentMemoryFactKind;
  tags: string[];
  scopeType: AgentMemoryScopeType;
  scopeId?: string;
  confidence: number;
  importance: number;
  updatedAt: number;
}

export interface AgentMemorySummary {
  enabled: boolean;
  totalFactCount: number;
  workspaceFactCount: number;
  sessionSummaryCount: number;
  injectionLogCount: number;
  lastUpdatedAt?: number;
  recentFacts: AgentMemoryFactPreview[];
}

export interface AgentMemoryRepository {
  saveFact(fact: AgentMemoryFact): Promise<AgentMemoryFact>;
  deleteFact(id: string): Promise<void>;
  searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult[]>;
  getSummary(workspaceId?: string, enabled?: boolean): Promise<AgentMemorySummary>;
  saveSessionSummary(summary: AgentSessionSummary): Promise<AgentSessionSummary>;
  listRecentSessionSummaries(workspaceId?: string, limit?: number): Promise<AgentSessionSummary[]>;
  recordMemoryInjection(input: MemoryInjectionLogInput): Promise<void>;
  backfillVectorIndex(input?: AgentMemoryVectorBackfillInput): Promise<AgentMemoryVectorBackfillResult>;
  clearAll(): Promise<void>;
  clearWorkspace(workspaceId: string): Promise<void>;
}

export interface AgentMemoryEmbeddingProvider {
  dimensions: number;
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface AgentMemoryRepositoryOptions {
  vectorIndex?: Pick<VectorIndexRepository, "upsertItem" | "deleteByOwner" | "deleteByScope" | "clearNamespace" | "search">;
  embeddingProvider?: AgentMemoryEmbeddingProvider;
}

export const AGENT_MEMORY_MIGRATIONS: DesktopDatabaseMigration[] = [
  {
    id: "agent-memory-v1-session-summaries-table",
    sql: `
CREATE TABLE IF NOT EXISTS ${AGENT_SESSION_SUMMARIES_TABLE_NAME} (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  summary TEXT NOT NULL,
  important_points TEXT,
  open_threads TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`.trim(),
  },
  {
    id: "agent-memory-v1-facts-table",
    sql: `
CREATE TABLE IF NOT EXISTS ${AGENT_MEMORY_FACTS_TABLE_NAME} (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  fact TEXT NOT NULL,
  normalized_fact TEXT,
  kind TEXT NOT NULL,
  tags_json TEXT,
  keywords_json TEXT,
  search_text TEXT,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  source_session_id TEXT,
  source_message_ids TEXT,
  confidence REAL DEFAULT 0.8,
  importance INTEGER DEFAULT 3,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0,
  expires_at INTEGER
)`.trim(),
  },
  {
    id: "agent-memory-v1-facts-fts-table",
    sql: `
CREATE VIRTUAL TABLE IF NOT EXISTS ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME} USING fts5(
  fact,
  normalized_fact,
  search_text,
  content='${AGENT_MEMORY_FACTS_TABLE_NAME}',
  content_rowid='rowid'
)`.trim(),
  },
  {
    id: "agent-memory-v1-facts-fts-insert-trigger",
    sql: `
CREATE TRIGGER IF NOT EXISTS agent_memory_facts_ai
AFTER INSERT ON ${AGENT_MEMORY_FACTS_TABLE_NAME} BEGIN
  INSERT INTO ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}(rowid, fact, normalized_fact, search_text)
  VALUES (new.rowid, new.fact, new.normalized_fact, new.search_text);
END`.trim(),
  },
  {
    id: "agent-memory-v1-facts-fts-delete-trigger",
    sql: `
CREATE TRIGGER IF NOT EXISTS agent_memory_facts_ad
AFTER DELETE ON ${AGENT_MEMORY_FACTS_TABLE_NAME} BEGIN
  INSERT INTO ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}(${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}, rowid, fact, normalized_fact, search_text)
  VALUES ('delete', old.rowid, old.fact, old.normalized_fact, old.search_text);
END`.trim(),
  },
  {
    id: "agent-memory-v1-facts-fts-update-trigger",
    sql: `
CREATE TRIGGER IF NOT EXISTS agent_memory_facts_au
AFTER UPDATE ON ${AGENT_MEMORY_FACTS_TABLE_NAME} BEGIN
  INSERT INTO ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}(${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}, rowid, fact, normalized_fact, search_text)
  VALUES ('delete', old.rowid, old.fact, old.normalized_fact, old.search_text);
  INSERT INTO ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}(rowid, fact, normalized_fact, search_text)
  VALUES (new.rowid, new.fact, new.normalized_fact, new.search_text);
END`.trim(),
  },
  {
    id: "agent-memory-v1-injection-logs-table",
    sql: `
CREATE TABLE IF NOT EXISTS ${MEMORY_INJECTION_LOGS_TABLE_NAME} (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  workspace_id TEXT,
  injection_type TEXT NOT NULL,
  memory_fact_ids TEXT,
  query_hash TEXT,
  query_terms TEXT,
  query_length INTEGER,
  scope_type TEXT,
  scope_id TEXT,
  prompt_section TEXT,
  score_summary TEXT,
  created_at INTEGER NOT NULL
)`.trim(),
  },
  {
    id: "agent-memory-v1-facts-scope-index",
    sql: `
CREATE INDEX IF NOT EXISTS idx_agent_memory_facts_scope
ON ${AGENT_MEMORY_FACTS_TABLE_NAME} (scope_type, scope_id, status, updated_at)`.trim(),
  },
  {
    id: "agent-memory-v1-session-workspace-index",
    sql: `
CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_workspace
ON ${AGENT_SESSION_SUMMARIES_TABLE_NAME} (workspace_id, updated_at)`.trim(),
  },
  {
    id: "agent-memory-v1-injection-session-index",
    sql: `
CREATE INDEX IF NOT EXISTS idx_memory_injection_logs_session
ON ${MEMORY_INJECTION_LOGS_TABLE_NAME} (session_id, created_at)`.trim(),
  },
  {
    id: "agent-memory-v1-injection-workspace-index",
    sql: `
CREATE INDEX IF NOT EXISTS idx_memory_injection_logs_workspace
ON ${MEMORY_INJECTION_LOGS_TABLE_NAME} (workspace_id, created_at)`.trim(),
  },
];

const UPSERT_FACT_SQL = `
INSERT INTO ${AGENT_MEMORY_FACTS_TABLE_NAME} (
  id,
  fact,
  normalized_fact,
  kind,
  tags_json,
  keywords_json,
  search_text,
  scope_type,
  scope_id,
  source_session_id,
  source_message_ids,
  confidence,
  importance,
  status,
  created_at,
  updated_at,
  last_accessed_at,
  access_count,
  expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  fact = excluded.fact,
  normalized_fact = excluded.normalized_fact,
  kind = excluded.kind,
  tags_json = excluded.tags_json,
  keywords_json = excluded.keywords_json,
  search_text = excluded.search_text,
  scope_type = excluded.scope_type,
  scope_id = excluded.scope_id,
  source_session_id = excluded.source_session_id,
  source_message_ids = excluded.source_message_ids,
  confidence = excluded.confidence,
  importance = excluded.importance,
  status = excluded.status,
  updated_at = excluded.updated_at,
  last_accessed_at = CASE
    WHEN ${AGENT_MEMORY_FACTS_TABLE_NAME}.last_accessed_at IS NULL THEN excluded.last_accessed_at
    WHEN excluded.last_accessed_at IS NULL THEN ${AGENT_MEMORY_FACTS_TABLE_NAME}.last_accessed_at
    ELSE MAX(${AGENT_MEMORY_FACTS_TABLE_NAME}.last_accessed_at, excluded.last_accessed_at)
  END,
  access_count = MAX(${AGENT_MEMORY_FACTS_TABLE_NAME}.access_count, excluded.access_count),
  expires_at = excluded.expires_at`.trim();

const SELECT_ACTIVE_FACTS_SQL = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ?
ORDER BY updated_at DESC
LIMIT ?`.trim();

const TOUCH_FACT_ACCESS_SQL = `
UPDATE ${AGENT_MEMORY_FACTS_TABLE_NAME}
SET last_accessed_at = CASE
      WHEN last_accessed_at IS NULL OR last_accessed_at < ? THEN ?
      ELSE last_accessed_at
    END,
    access_count = COALESCE(access_count, 0) + 1
WHERE id = ? AND status = ?`.trim();

const SELECT_FACTS_BY_ROWID_PREFIX = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ? AND rowid IN`.trim();

const SELECT_FACT_BY_ID_SQL = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE id = ?
LIMIT 1`.trim();

const SELECT_FTS_ROWIDS_SQL = `
SELECT rowid
FROM ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME}
WHERE ${AGENT_MEMORY_FACTS_FTS_TABLE_NAME} MATCH ?
LIMIT ?`.trim();

const SELECT_LIKE_FACTS_SQL = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ? AND (
  fact LIKE ? OR
  normalized_fact LIKE ? OR
  search_text LIKE ? OR
  tags_json LIKE ? OR
  keywords_json LIKE ?
)
ORDER BY updated_at DESC
LIMIT ?`.trim();

const UPSERT_SUMMARY_SQL = `
INSERT INTO ${AGENT_SESSION_SUMMARIES_TABLE_NAME} (
  id,
  session_id,
  workspace_id,
  summary,
  important_points,
  open_threads,
  created_at,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id,
  workspace_id = excluded.workspace_id,
  summary = excluded.summary,
  important_points = excluded.important_points,
  open_threads = excluded.open_threads,
  updated_at = excluded.updated_at`.trim();

const SELECT_RECENT_SUMMARIES_SQL = `
SELECT id, session_id, workspace_id, summary, important_points, open_threads, created_at, updated_at
FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME}
ORDER BY updated_at DESC
LIMIT ?`.trim();

const SELECT_RECENT_WORKSPACE_SUMMARIES_SQL = `
SELECT id, session_id, workspace_id, summary, important_points, open_threads, created_at, updated_at
FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME}
WHERE workspace_id = ?
ORDER BY updated_at DESC
LIMIT ?`.trim();

const COUNT_ACTIVE_FACTS_SQL = `
SELECT COUNT(*) as count
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ?`.trim();

const COUNT_WORKSPACE_FACTS_SQL = `
SELECT COUNT(*) as count
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ? AND scope_type = ? AND scope_id = ?`.trim();

const COUNT_FACTS_BY_SOURCE_SESSION_SQL = `
SELECT COUNT(*) as count
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE source_session_id = ?`.trim();

const COUNT_SESSION_SUMMARIES_SQL = `
SELECT COUNT(*) as count
FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME}`.trim();

const COUNT_WORKSPACE_SESSION_SUMMARIES_SQL = `
SELECT COUNT(*) as count
FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME}
WHERE workspace_id = ?`.trim();

const COUNT_INJECTION_LOGS_SQL = `
SELECT COUNT(*) as count
FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME}`.trim();

const COUNT_WORKSPACE_INJECTION_LOGS_SQL = `
SELECT COUNT(*) as count
FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME}
WHERE workspace_id = ?`.trim();

const SELECT_LAST_FACT_UPDATE_SQL = `
SELECT updated_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ?
ORDER BY updated_at DESC
LIMIT 1`.trim();

const SELECT_RECENT_FACTS_SQL = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ?
ORDER BY updated_at DESC
LIMIT ?`.trim();

const SELECT_RECENT_WORKSPACE_FACTS_SQL = `
SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
       scope_type, scope_id, source_session_id, source_message_ids, confidence,
       importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}
WHERE status = ? AND scope_type = ? AND scope_id = ?
ORDER BY updated_at DESC
LIMIT ?`.trim();

const INSERT_INJECTION_LOG_SQL = `
INSERT INTO ${MEMORY_INJECTION_LOGS_TABLE_NAME} (
  id,
  session_id,
  message_id,
  workspace_id,
  injection_type,
  memory_fact_ids,
  query_hash,
  query_terms,
  query_length,
  scope_type,
  scope_id,
  prompt_section,
  score_summary,
  created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`.trim();

export function createAgentMemoryRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
  options: AgentMemoryRepositoryOptions = {},
): AgentMemoryRepository {
  return {
    async saveFact(fact) {
      const sanitized = sanitizeAgentMemoryFact(fact);
      await database.execute(UPSERT_FACT_SQL, bindAgentMemoryFact(sanitized));
      await upsertMemoryVector(options, sanitized);
      return sanitized;
    },

    async deleteFact(id) {
      const cleanId = normalizeWhitespace(id);
      if (!cleanId) return;
      await options.vectorIndex?.deleteByOwner("memory-fact", cleanId);
      const rows = await database.select<AgentMemoryFactRow>(SELECT_FACT_BY_ID_SQL, [cleanId]);
      const sourceSessionId = rows
        .map(agentMemoryFactFromRow)
        .find((fact): fact is AgentMemoryFact => Boolean(fact))?.sourceSessionId;
      await database.execute(`DELETE FROM ${AGENT_MEMORY_FACTS_TABLE_NAME} WHERE id = ?`, [cleanId]);
      if (sourceSessionId) {
        const remainingSourceFactCount = await selectCount(database, COUNT_FACTS_BY_SOURCE_SESSION_SQL, [sourceSessionId]);
        if (remainingSourceFactCount === 0) {
          await database.execute(`DELETE FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME} WHERE session_id = ?`, [sourceSessionId]);
        }
      }
      await database.execute(`DELETE FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME} WHERE memory_fact_ids LIKE ?`, [`%"${cleanId}"%`]);
    },

    async searchMemory(input) {
      return searchMemory(database, input, options);
    },

    async getSummary(workspaceId, enabled = true) {
      return getAgentMemorySummary(database, workspaceId, enabled);
    },

    async saveSessionSummary(summary) {
      const sanitized = sanitizeAgentSessionSummary(summary);
      await database.execute(UPSERT_SUMMARY_SQL, bindAgentSessionSummary(sanitized));
      return sanitized;
    },

    async listRecentSessionSummaries(workspaceId, limit = 5) {
      const boundedLimit = clampInteger(limit, 1, 20, 5);
      const rows = workspaceId
        ? await database.select<AgentSessionSummaryRow>(SELECT_RECENT_WORKSPACE_SUMMARIES_SQL, [workspaceId, boundedLimit])
        : await database.select<AgentSessionSummaryRow>(SELECT_RECENT_SUMMARIES_SQL, [boundedLimit]);
      return rows
        .map(agentSessionSummaryFromRow)
        .filter((summary): summary is AgentSessionSummary => Boolean(summary));
    },

    async recordMemoryInjection(input) {
      await recordMemoryInjection(database, input);
    },

    async backfillVectorIndex(input = {}) {
      return backfillMemoryVectorIndex(database, options, input);
    },

    async clearAll() {
      await options.vectorIndex?.clearNamespace("agent-memory");
      await database.execute(`DELETE FROM ${AGENT_MEMORY_FACTS_TABLE_NAME}`);
      await database.execute(`DELETE FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME}`);
      await database.execute(`DELETE FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME}`);
    },

    async clearWorkspace(workspaceId) {
      const cleanWorkspaceId = normalizeWhitespace(workspaceId);
      if (!cleanWorkspaceId) return;
      await options.vectorIndex?.deleteByScope("agent-memory", "workspace", cleanWorkspaceId);
      await database.execute(
        `DELETE FROM ${AGENT_MEMORY_FACTS_TABLE_NAME} WHERE scope_type = ? AND scope_id = ?`,
        ["workspace", cleanWorkspaceId],
      );
      await database.execute(`DELETE FROM ${AGENT_SESSION_SUMMARIES_TABLE_NAME} WHERE workspace_id = ?`, [cleanWorkspaceId]);
      await database.execute(`DELETE FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME} WHERE workspace_id = ?`, [cleanWorkspaceId]);
      await database.execute(
        `DELETE FROM ${MEMORY_INJECTION_LOGS_TABLE_NAME} WHERE scope_type = ? AND scope_id = ?`,
        ["workspace", cleanWorkspaceId],
      );
    },
  };
}

export async function searchMemory(
  database: Pick<DesktopDatabase, "select" | "execute">,
  input: SearchMemoryInput,
  options: AgentMemoryRepositoryOptions = {},
): Promise<SearchMemoryResult[]> {
  const query = normalizeWhitespace(input.query);
  const limit = clampInteger(input.limit ?? 6, 1, 20, 6);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const ftsRowIds = await selectFtsRowIds(database, query, limit * 4);
  const hasRetrievalCriteria = Boolean(query || input.tags?.length || input.kind?.length);
  const recentRows = await database.select<AgentMemoryFactRow>(SELECT_ACTIVE_FACTS_SQL, ["active", Math.max(80, limit * 8)]);
  const [ftsRows, likeRows, vectorRows] = await Promise.all([
    selectFactsByRowIds(database, ftsRowIds),
    selectLikeFacts(database, query, limit * 8),
    selectVectorFacts(database, input, options, limit * 4),
  ]);
  const vectorScores = new Map(vectorRows.map(({ row, score }) => [row.id, score]));
  const facts = mergeFactRows(recentRows, ftsRows, likeRows, vectorRows.map(({ row }) => row))
    .map(agentMemoryFactFromRow)
    .filter((fact): fact is AgentMemoryFact & { rowid?: number } => Boolean(fact))
    .filter((fact) => !fact.expiresAt || fact.expiresAt > now)
    .filter((fact) => factMatchesScope(fact, input))
    .filter((fact) => factMatchesKind(fact, input.kind));

  const results = facts
    .map((fact) => ({ fact, score: scoreFact(fact, input, ftsRowIds, now, vectorScores.get(fact.id)) }))
    .filter(({ score }) => !hasRetrievalCriteria || score.relevance > 0)
    .sort((a, b) =>
      b.score.total - a.score.total ||
      b.fact.importance - a.fact.importance ||
      b.fact.confidence - a.fact.confidence ||
      b.fact.updatedAt - a.fact.updatedAt ||
      a.fact.id.localeCompare(b.fact.id),
    )
    .slice(0, limit)
    .map(({ fact, score }) => ({
      id: fact.id,
      fact: fact.fact,
      kind: fact.kind,
      tags: fact.tags,
      scopeType: fact.scopeType,
      scopeId: fact.scopeId,
      confidence: fact.confidence,
      importance: fact.importance,
      updatedAt: fact.updatedAt,
      sourceSessionId: fact.sourceSessionId,
      score: score.total,
    }));
  await touchReturnedFacts(database, results.map((result) => result.id), now);
  return results;
}

async function touchReturnedFacts(
  database: Pick<DesktopDatabase, "execute">,
  ids: string[],
  accessedAt: number,
): Promise<void> {
  for (const id of ids) {
    try {
      await database.execute(TOUCH_FACT_ACCESS_SQL, [accessedAt, accessedAt, id, "active"]);
    } catch {
      // Retrieval should not fail because auxiliary access metadata could not be updated.
    }
  }
}

async function upsertMemoryVector(
  options: AgentMemoryRepositoryOptions,
  fact: AgentMemoryFact,
): Promise<boolean> {
  if (!options.vectorIndex || !options.embeddingProvider) return false;
  try {
    const [vector] = await options.embeddingProvider.embedTexts([memoryEmbeddingText(fact)]);
    if (!vector) return false;
    await options.vectorIndex.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: fact.id,
      scopeType: fact.scopeType,
      scopeId: fact.scopeId,
      contentHash: hashMemoryVectorContent(fact),
      vector,
      metadata: {
        kind: fact.kind,
        tags: fact.tags.slice(0, 12),
      },
      now: fact.updatedAt,
    });
    return true;
  } catch {
    // Memory persistence should not fail because optional vector indexing failed.
    return false;
  }
}

async function backfillMemoryVectorIndex(
  database: Pick<DesktopDatabase, "select">,
  options: AgentMemoryRepositoryOptions,
  input: AgentMemoryVectorBackfillInput,
): Promise<AgentMemoryVectorBackfillResult> {
  const limit = clampInteger(input.limit ?? 200, 1, 1000, 200);
  const rows = input.scopeType === "workspace" && input.scopeId
    ? await database.select<AgentMemoryFactRow>(SELECT_RECENT_WORKSPACE_FACTS_SQL, ["active", "workspace", input.scopeId, limit])
    : await database.select<AgentMemoryFactRow>(SELECT_ACTIVE_FACTS_SQL, ["active", limit]);
  const facts = rows
    .map(agentMemoryFactFromRow)
    .filter((fact): fact is AgentMemoryFact => Boolean(fact))
    .filter((fact) => !input.scopeType || fact.scopeType === input.scopeType)
    .filter((fact) => !input.scopeId || fact.scopeId === input.scopeId);
  let indexedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const fact of facts) {
    if (!options.vectorIndex || !options.embeddingProvider) {
      skippedCount += 1;
      continue;
    }
    const indexed = await upsertMemoryVector(options, fact);
    if (indexed) {
      indexedCount += 1;
    } else {
      failedCount += 1;
    }
  }
  return { indexedCount, skippedCount, failedCount };
}

async function selectVectorFacts(
  database: Pick<DesktopDatabase, "select">,
  input: SearchMemoryInput,
  options: AgentMemoryRepositoryOptions,
  limit: number,
): Promise<Array<{ row: AgentMemoryFactRow; score: number }>> {
  const query = normalizeWhitespace(input.query);
  if (!query || !options.vectorIndex || !options.embeddingProvider) return [];
  try {
    const [vector] = await options.embeddingProvider.embedTexts([query]);
    if (!vector) return [];
    const results = await options.vectorIndex.search({
      namespace: "agent-memory",
      vector,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      limit,
    });
    const rows = await Promise.all(results.map(async (result) => {
      const matches = await database.select<AgentMemoryFactRow>(SELECT_FACT_BY_ID_SQL, [result.ownerId]);
      const row = matches[0];
      return row ? { row, score: result.score } : undefined;
    }));
    return rows.filter((row): row is { row: AgentMemoryFactRow; score: number } => Boolean(row));
  } catch {
    return [];
  }
}

function memoryEmbeddingText(fact: AgentMemoryFact): string {
  return [fact.fact, fact.normalizedFact, fact.searchText, ...fact.tags, ...fact.keywords].filter(Boolean).join(" ");
}

function hashMemoryVectorContent(fact: AgentMemoryFact): string {
  let hash = 2166136261;
  for (const char of memoryEmbeddingText(fact)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function recordMemoryInjection(
  database: Pick<DesktopDatabase, "execute">,
  input: MemoryInjectionLogInput,
): Promise<void> {
  const id = normalizeWhitespace(input.id);
  const sessionId = normalizeWhitespace(input.sessionId);
  if (!id || !sessionId) {
    throw new Error("Memory injection log requires id and sessionId.");
  }
  const query = normalizeWhitespace(input.query ?? "");
  const queryHash = query ? await createMemoryQueryHmac(query, input.queryHashSecret) : "";
  const queryTerms = buildAuditQueryTerms(query, input.queryTerms);
  await database.execute(INSERT_INJECTION_LOG_SQL, [
    id,
    sessionId,
    nullableString(input.messageId),
    nullableString(input.workspaceId),
    input.injectionType,
    JSON.stringify(sanitizeStringArray(input.memoryFactIds, 40)),
    queryHash || null,
    JSON.stringify(queryTerms),
    query ? query.length : null,
    nullableString(input.scopeType),
    nullableString(input.scopeId),
    nullableString(input.promptSection),
    input.scoreSummary ? JSON.stringify(input.scoreSummary) : null,
    input.createdAt ?? Date.now(),
  ]);
}

export async function getAgentMemorySummary(
  database: Pick<DesktopDatabase, "select">,
  workspaceId?: string,
  enabled = true,
): Promise<AgentMemorySummary> {
  const cleanWorkspaceId = nullableString(workspaceId) ?? undefined;
  const [
    totalFactCount,
    workspaceFactCount,
    sessionSummaryCount,
    injectionLogCount,
    lastUpdatedAt,
    recentFacts,
  ] = await Promise.all([
    selectCount(database, COUNT_ACTIVE_FACTS_SQL, ["active"]),
    cleanWorkspaceId
      ? selectCount(database, COUNT_WORKSPACE_FACTS_SQL, ["active", "workspace", cleanWorkspaceId])
      : Promise.resolve(0),
    cleanWorkspaceId
      ? selectCount(database, COUNT_WORKSPACE_SESSION_SUMMARIES_SQL, [cleanWorkspaceId])
      : selectCount(database, COUNT_SESSION_SUMMARIES_SQL),
    cleanWorkspaceId
      ? selectCount(database, COUNT_WORKSPACE_INJECTION_LOGS_SQL, [cleanWorkspaceId])
      : selectCount(database, COUNT_INJECTION_LOGS_SQL),
    selectLastUpdatedAt(database),
    listRecentFacts(database, cleanWorkspaceId, 8),
  ]);

  return {
    enabled,
    totalFactCount,
    workspaceFactCount,
    sessionSummaryCount,
    injectionLogCount,
    lastUpdatedAt,
    recentFacts,
  };
}

export async function createMemoryQueryHmac(query: string, secret: string | undefined): Promise<string> {
  const cleanSecret = normalizeWhitespace(secret ?? "");
  if (!cleanSecret) {
    throw new Error("Memory query hashing requires an app-local HMAC secret.");
  }
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error("Web Crypto HMAC support is unavailable.");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(cleanSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(normalizeWhitespace(query)));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCanonicalWorkspaceId(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized) return "";
  return `workspace:${fnv1aHex(normalized)}`;
}

async function selectCount(
  database: Pick<DesktopDatabase, "select">,
  sql: string,
  bindValues: DatabaseValue[] = [],
): Promise<number> {
  const rows = await database.select<{ count: number }>(sql, bindValues);
  return Math.max(0, Math.floor(Number(rows[0]?.count ?? 0)));
}

async function selectLastUpdatedAt(database: Pick<DesktopDatabase, "select">): Promise<number | undefined> {
  const rows = await database.select<{ updated_at?: number | null }>(SELECT_LAST_FACT_UPDATE_SQL, ["active"]);
  return optionalTimestamp(rows[0]?.updated_at);
}

async function listRecentFacts(
  database: Pick<DesktopDatabase, "select">,
  workspaceId: string | undefined,
  limit: number,
): Promise<AgentMemoryFactPreview[]> {
  const boundedLimit = clampInteger(limit, 1, 20, 8);
  const rows = workspaceId
    ? await database.select<AgentMemoryFactRow>(SELECT_RECENT_WORKSPACE_FACTS_SQL, ["active", "workspace", workspaceId, boundedLimit])
    : await database.select<AgentMemoryFactRow>(SELECT_RECENT_FACTS_SQL, ["active", boundedLimit]);
  return rows
    .map(agentMemoryFactFromRow)
    .filter((fact): fact is AgentMemoryFact => Boolean(fact))
    .map((fact) => ({
      id: fact.id,
      fact: fact.fact,
      kind: fact.kind,
      tags: fact.tags,
      scopeType: fact.scopeType,
      scopeId: fact.scopeId,
      confidence: fact.confidence,
      importance: fact.importance,
      updatedAt: fact.updatedAt,
    }));
}

function bindAgentMemoryFact(fact: AgentMemoryFact): DatabaseValue[] {
  return [
    fact.id,
    fact.fact,
    fact.normalizedFact ?? null,
    fact.kind,
    JSON.stringify(fact.tags),
    JSON.stringify(fact.keywords),
    fact.searchText,
    fact.scopeType,
    fact.scopeId ?? null,
    fact.sourceSessionId ?? null,
    JSON.stringify(fact.sourceMessageIds),
    fact.confidence,
    fact.importance,
    fact.status,
    fact.createdAt,
    fact.updatedAt,
    fact.lastAccessedAt ?? null,
    fact.accessCount,
    fact.expiresAt ?? null,
  ];
}

function bindAgentSessionSummary(summary: AgentSessionSummary): DatabaseValue[] {
  return [
    summary.id,
    summary.sessionId,
    summary.workspaceId ?? null,
    summary.summary,
    JSON.stringify(summary.importantPoints),
    JSON.stringify(summary.openThreads),
    summary.createdAt,
    summary.updatedAt,
  ];
}

function sanitizeAgentMemoryFact(value: AgentMemoryFact): AgentMemoryFact {
  const id = normalizeWhitespace(value.id);
  const fact = normalizeWhitespace(value.fact);
  if (!id || !fact || !isFactKind(value.kind)) {
    throw new Error("Invalid agent memory fact.");
  }
  const normalizedFact = normalizeWhitespace(value.normalizedFact ?? fact);
  const tags = sanitizeStringArray(value.tags, 20);
  const keywords = sanitizeStringArray(value.keywords, 32);
  const scopeType = requireScopeType(value.scopeType);
  const scopeId = scopeType === "global" ? undefined : normalizeWhitespace(value.scopeId ?? "");
  if (scopeType !== "global" && !scopeId) {
    throw new Error("Scoped agent memory facts require scopeId.");
  }
  const createdAt = sanitizeTimestamp(value.createdAt);
  const updatedAt = sanitizeTimestamp(value.updatedAt || createdAt);
  return {
    id,
    fact,
    normalizedFact,
    kind: value.kind,
    tags,
    keywords,
    searchText: buildSearchText(fact, normalizedFact, tags, keywords),
    scopeType,
    scopeId,
    sourceSessionId: nullableString(value.sourceSessionId) ?? undefined,
    sourceMessageIds: sanitizeStringArray(value.sourceMessageIds, 40),
    confidence: clampNumber(value.confidence, 0, 1, 0.8),
    importance: clampInteger(value.importance, 1, 5, 3),
    status: isFactStatus(value.status) ? value.status : "active",
    createdAt,
    updatedAt,
    lastAccessedAt: optionalTimestamp(value.lastAccessedAt),
    accessCount: Math.max(0, Math.floor(value.accessCount || 0)),
    expiresAt: optionalTimestamp(value.expiresAt),
  };
}

function sanitizeAgentSessionSummary(value: AgentSessionSummary): AgentSessionSummary {
  const id = normalizeWhitespace(value.id);
  const sessionId = normalizeWhitespace(value.sessionId);
  const summary = normalizeWhitespace(value.summary);
  if (!id || !sessionId || !summary) {
    throw new Error("Invalid agent session summary.");
  }
  const createdAt = sanitizeTimestamp(value.createdAt);
  return {
    id,
    sessionId,
    workspaceId: nullableString(value.workspaceId) ?? undefined,
    summary,
    importantPoints: sanitizeStringArray(value.importantPoints, 24),
    openThreads: sanitizeStringArray(value.openThreads, 24),
    createdAt,
    updatedAt: sanitizeTimestamp(value.updatedAt || createdAt),
  };
}

interface AgentMemoryFactRow extends Record<string, unknown> {
  rowid?: number;
  id: string;
  fact: string;
  normalized_fact?: string | null;
  kind: string;
  tags_json?: string | null;
  keywords_json?: string | null;
  search_text?: string | null;
  scope_type: string;
  scope_id?: string | null;
  source_session_id?: string | null;
  source_message_ids?: string | null;
  confidence?: number | null;
  importance?: number | null;
  status?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  last_accessed_at?: number | null;
  access_count?: number | null;
  expires_at?: number | null;
}

function agentMemoryFactFromRow(row: AgentMemoryFactRow): (AgentMemoryFact & { rowid?: number }) | null {
  if (!row || typeof row.id !== "string" || typeof row.fact !== "string" || !isFactKind(row.kind)) {
    return null;
  }
  if (!isScopeType(row.scope_type)) {
    return null;
  }
  const scopeType = row.scope_type;
  const tags = parseJsonStringArray(row.tags_json);
  const keywords = parseJsonStringArray(row.keywords_json);
  const normalizedFact = nullableString(row.normalized_fact) ?? undefined;
  const fact: AgentMemoryFact & { rowid?: number } = {
    rowid: typeof row.rowid === "number" ? row.rowid : undefined,
    id: row.id,
    fact: row.fact,
    normalizedFact,
    kind: row.kind,
    tags,
    keywords,
    searchText: nullableString(row.search_text) ?? buildSearchText(row.fact, normalizedFact ?? row.fact, tags, keywords),
    scopeType,
    scopeId: nullableString(row.scope_id) ?? undefined,
    sourceSessionId: nullableString(row.source_session_id) ?? undefined,
    sourceMessageIds: parseJsonStringArray(row.source_message_ids),
    confidence: clampNumber(row.confidence ?? 0.8, 0, 1, 0.8),
    importance: clampInteger(row.importance ?? 3, 1, 5, 3),
    status: isFactStatus(row.status) ? row.status : "active",
    createdAt: sanitizeTimestamp(row.created_at ?? Date.now()),
    updatedAt: sanitizeTimestamp(row.updated_at ?? Date.now()),
    lastAccessedAt: optionalTimestamp(row.last_accessed_at),
    accessCount: Math.max(0, Math.floor(Number(row.access_count ?? 0))),
    expiresAt: optionalTimestamp(row.expires_at),
  };
  return fact;
}

interface AgentSessionSummaryRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  workspace_id?: string | null;
  summary: string;
  important_points?: string | null;
  open_threads?: string | null;
  created_at: number;
  updated_at: number;
}

function agentSessionSummaryFromRow(row: AgentSessionSummaryRow): AgentSessionSummary | null {
  if (!row || typeof row.id !== "string" || typeof row.session_id !== "string" || typeof row.summary !== "string") {
    return null;
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: nullableString(row.workspace_id) ?? undefined,
    summary: row.summary,
    importantPoints: parseJsonStringArray(row.important_points),
    openThreads: parseJsonStringArray(row.open_threads),
    createdAt: sanitizeTimestamp(row.created_at),
    updatedAt: sanitizeTimestamp(row.updated_at),
  };
}

async function selectFtsRowIds(
  database: Pick<DesktopDatabase, "select">,
  query: string,
  limit: number,
): Promise<Set<number>> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return new Set();
  try {
    const rows = await database.select<{ rowid: number }>(SELECT_FTS_ROWIDS_SQL, [ftsQuery, limit]);
    return new Set(rows.map((row) => Number(row.rowid)).filter(Number.isFinite));
  } catch {
    return new Set();
  }
}

async function selectFactsByRowIds(
  database: Pick<DesktopDatabase, "select">,
  rowIds: Set<number>,
): Promise<AgentMemoryFactRow[]> {
  const ids = [...rowIds].filter((rowId) => Number.isInteger(rowId) && rowId > 0).slice(0, 80);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database.select<AgentMemoryFactRow>(`${SELECT_FACTS_BY_ROWID_PREFIX} (${placeholders})`, ["active", ...ids]);
}

async function selectLikeFacts(
  database: Pick<DesktopDatabase, "select">,
  query: string,
  limit: number,
): Promise<AgentMemoryFactRow[]> {
  const likePattern = buildLikePattern(query);
  if (!likePattern) return [];
  try {
    const boundedLimit = clampInteger(limit, 1, 80, 40);
    return database.select<AgentMemoryFactRow>(SELECT_LIKE_FACTS_SQL, [
      "active",
      likePattern,
      likePattern,
      likePattern,
      likePattern,
      likePattern,
      boundedLimit,
    ]);
  } catch {
    return [];
  }
}

function mergeFactRows(...rowGroups: AgentMemoryFactRow[][]): AgentMemoryFactRow[] {
  const merged = new Map<string, AgentMemoryFactRow>();
  for (const row of rowGroups.flat()) {
    const key = typeof row.id === "string" && row.id ? row.id : String(row.rowid ?? "");
    if (key) merged.set(key, row);
  }
  return [...merged.values()];
}

function scoreFact(
  fact: AgentMemoryFact & { rowid?: number },
  input: SearchMemoryInput,
  ftsRowIds: Set<number>,
  now: number,
  vectorScore = 0,
): { relevance: number; total: number } {
  let relevance = 0;
  const query = normalizeForSearch(input.query);
  const queryTerms = sanitizeStringArray(extractQueryTerms(input.query), 8).map(normalizeForSearch);
  const tags = sanitizeStringArray(input.tags ?? [], 16).map(normalizeForSearch);
  const kinds = new Set(input.kind ?? []);
  const factTags = fact.tags.map(normalizeForSearch);
  const factKeywords = fact.keywords.map(normalizeForSearch);
  const haystack = normalizeForSearch([fact.fact, fact.normalizedFact, fact.searchText, ...fact.tags, ...fact.keywords].join(" "));

  if (fact.rowid && ftsRowIds.has(fact.rowid)) relevance += 3;
  if (vectorScore > 0) relevance += Math.min(2.5, vectorScore * 2.5);
  if (query && haystack.includes(query)) relevance += 2;
  for (const term of queryTerms) {
    if (haystack.includes(term)) relevance += 1;
    if (factTags.some((tag) => term.includes(tag) || tag.includes(term))) relevance += 0.8;
    if (factKeywords.some((keyword) => term.includes(keyword) || keyword.includes(term))) relevance += 0.8;
  }
  for (const tag of tags) {
    if (factTags.includes(tag)) relevance += 2.5;
    if (factKeywords.includes(tag)) relevance += 1.5;
    if (haystack.includes(tag)) relevance += 0.8;
  }
  if (kinds.size && kinds.has(fact.kind)) relevance += 1.2;

  let total = relevance;
  if (input.scopeType && fact.scopeType === input.scopeType && fact.scopeId === input.scopeId) total += 2;
  if (fact.scopeType === "global") total += 0.3;
  total += fact.importance * 0.25;
  total += fact.confidence;
  total += Math.max(0, 1 - Math.max(0, now - fact.updatedAt) / 2_592_000_000) * 0.6;
  total += Math.min(0.4, fact.accessCount * 0.04);
  return { relevance, total };
}

function factMatchesScope(fact: AgentMemoryFact, input: SearchMemoryInput): boolean {
  if (!input.scopeType) return fact.scopeType === "global";
  if (fact.scopeType === "global") return true;
  if (fact.scopeType !== input.scopeType) return false;
  if (!input.scopeId) return false;
  return fact.scopeId === input.scopeId;
}

function factMatchesKind(fact: AgentMemoryFact, kinds: AgentMemoryFactKind[] | undefined): boolean {
  if (!kinds?.length) return true;
  return new Set(kinds).has(fact.kind);
}

function buildSearchText(fact: string, normalizedFact: string, tags: string[], keywords: string[]): string {
  return normalizeWhitespace([fact, normalizedFact, ...tags, ...keywords].join(" "));
}

function buildFtsQuery(query: string): string {
  return sanitizeStringArray(extractQueryTerms(query), 8)
    .map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" OR ");
}

function buildLikePattern(query: string): string {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return "";
  const candidates = extractQueryTerms(normalized)
    .filter((term) => containsCjk(term) || term.length >= 3)
    .sort((a, b) => b.length - a.length);
  const term = candidates[0] ?? normalized;
  const safeTerm = normalizeWhitespace(term.replace(/[\\%_]/g, " ")).slice(0, 64);
  return safeTerm ? `%${safeTerm}%` : "";
}

function extractQueryTerms(query: string): string[] {
  const normalized = normalizeWhitespace(query);
  if (!normalized) return [];
  const terms = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return sanitizeStringArray(terms, 12);
}

function buildAuditQueryTerms(query: string, inputTerms: string[] | undefined): string[] {
  const normalizedQuery = normalizeForSearch(query);
  const candidates = sanitizeStringArray(inputTerms?.length ? inputTerms : extractQueryTerms(query), 24);
  return candidates
    .filter((term) => {
      const normalizedTerm = normalizeForSearch(term);
      if (!normalizedTerm || normalizedTerm === normalizedQuery) return false;
      if (normalizedTerm.length > 32) return false;
      if (containsCjk(normalizedTerm) && [...normalizedTerm].length > 4) return false;
      return true;
    })
    .slice(0, 12);
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? sanitizeStringArray(parsed.filter((item): item is string => typeof item === "string"), 80)
      : [];
  } catch {
    return [];
  }
}

function isScopeType(value: unknown): value is AgentMemoryScopeType {
  return value === "global" || value === "workspace" || value === "session";
}

function requireScopeType(value: unknown): AgentMemoryScopeType {
  if (isScopeType(value)) {
    return value;
  }
  throw new Error("Invalid agent memory scope.");
}

function isFactKind(value: unknown): value is AgentMemoryFactKind {
  return value === "user_preference" ||
    value === "workspace_context" ||
    value === "product_decision" ||
    value === "technical_constraint" ||
    value === "design_principle" ||
    value === "workflow" ||
    value === "personal_note" ||
    value === "other";
}

function isFactStatus(value: unknown): value is AgentMemoryFactStatus {
  return value === "active" || value === "archived";
}

function sanitizeStringArray(values: string[], limit: number): string[] {
  return [...new Set(values.map(normalizeWhitespace).filter(Boolean))].slice(0, limit);
}

function normalizeWorkspacePath(value: string): string {
  return normalizeWhitespace(value).replace(/\//g, "\\").toLocaleLowerCase();
}

function normalizeForSearch(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeWhitespace(value);
  return normalized || null;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function sanitizeTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : Date.now();
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  return Math.floor(clampNumber(value, min, max, fallback));
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
