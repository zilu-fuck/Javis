import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import type { VectorIndexSearchInput, VectorIndexSearchResult } from "./vector-index";
import {
  AGENT_MEMORY_MIGRATIONS,
  createAgentMemoryRepository,
  createCanonicalWorkspaceId,
  createMemoryQueryHmac,
  type AgentMemoryFact,
} from "./agent-memory";

describe("agent memory persistence", () => {
  it("defines split migrations for tables, FTS, triggers, and indexes", () => {
    expect(AGENT_MEMORY_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "agent-memory-v1-session-summaries-table",
      "agent-memory-v1-facts-table",
      "agent-memory-v1-facts-fts-table",
      "agent-memory-v1-facts-fts-insert-trigger",
      "agent-memory-v1-facts-fts-delete-trigger",
      "agent-memory-v1-facts-fts-update-trigger",
      "agent-memory-v1-injection-logs-table",
      "agent-memory-v1-facts-scope-index",
      "agent-memory-v1-session-workspace-index",
      "agent-memory-v1-injection-session-index",
      "agent-memory-v1-injection-workspace-index",
    ]);
    expect(AGENT_MEMORY_MIGRATIONS[2].sql).toContain("CREATE VIRTUAL TABLE");
    expect(AGENT_MEMORY_MIGRATIONS[3].sql).toContain("CREATE TRIGGER");
  });

  it("saves facts, searches by workspace scope, and hard-deletes workspace memory", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact(createFact("mem-1", "用户希望 Javis 记忆本地优先", workspaceId));
    await repository.saveFact(createFact("mem-2", "另一个工作区的浏览器方案", createCanonicalWorkspaceId("E:\\Other")));

    const results = await repository.searchMemory({
      query: "Javis 记忆方案",
      scopeType: "workspace",
      scopeId: workspaceId,
      limit: 5,
      now: 1_700_000_000_000,
    });

    expect(results.map((result) => result.id)).toEqual(["mem-1"]);

    await repository.clearWorkspace(workspaceId);

    expect(await repository.searchMemory({ query: "Javis", scopeType: "workspace", scopeId: workspaceId })).toEqual([]);
    expect(database.facts.has("mem-1")).toBe(false);
    expect(database.injectionLogs.length).toBe(0);
  });

  it("optionally syncs saved and deleted facts to a vector index", async () => {
    const database = createAgentMemoryDatabase();
    const vectorIndex = new FakeMemoryVectorIndex();
    const repository = createAgentMemoryRepository(database, {
      vectorIndex,
      embeddingProvider: createFakeEmbeddingProvider(),
    });
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");

    await repository.saveFact(createFact("mem-1", "Javis memory remains local", workspaceId));
    expect(vectorIndex.items.get("mem-1")).toEqual(expect.objectContaining({
      namespace: "agent-memory",
      scopeType: "workspace",
      scopeId: workspaceId,
    }));

    await repository.deleteFact("mem-1");
    expect(vectorIndex.deletedOwners).toContain("memory-fact:mem-1");
    expect(vectorIndex.items.has("mem-1")).toBe(false);
  });

  it("backfills existing facts into the optional vector index", async () => {
    const database = createAgentMemoryDatabase();
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    const initialRepository = createAgentMemoryRepository(database);
    await initialRepository.saveFact(createFact("mem-1", "local-first memory architecture", workspaceId));
    await initialRepository.saveFact(createFact("mem-2", "other workspace memory architecture", createCanonicalWorkspaceId("E:\\Other")));

    const vectorIndex = new FakeMemoryVectorIndex();
    const indexedRepository = createAgentMemoryRepository(database, {
      vectorIndex,
      embeddingProvider: createFakeEmbeddingProvider(),
    });
    const result = await indexedRepository.backfillVectorIndex({
      scopeType: "workspace",
      scopeId: workspaceId,
    });

    expect(result).toEqual({ indexedCount: 1, skippedCount: 0, failedCount: 0 });
    expect(vectorIndex.items.get("mem-1")).toEqual(expect.objectContaining({
      namespace: "agent-memory",
      scopeType: "workspace",
      scopeId: workspaceId,
    }));
    expect(vectorIndex.items.has("mem-2")).toBe(false);
  });

  it("reports skipped vector backfill when optional vector dependencies are absent", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    await repository.saveFact(createFact("mem-1", "local-first memory architecture", createCanonicalWorkspaceId("E:\\Javis")));

    await expect(repository.backfillVectorIndex()).resolves.toEqual({
      indexedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
  });

  it("optionally merges vector candidates into memory search without leaking scopes", async () => {
    const database = createAgentMemoryDatabase();
    const vectorIndex = new FakeMemoryVectorIndex();
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    const otherWorkspaceId = createCanonicalWorkspaceId("E:\\Other");
    const repository = createAgentMemoryRepository(database, {
      vectorIndex,
      embeddingProvider: createFakeEmbeddingProvider(),
    });
    await repository.saveFact(createFact("mem-1", "local-first memory architecture", workspaceId));
    await repository.saveFact(createFact("mem-2", "other workspace memory architecture", otherWorkspaceId));
    vectorIndex.searchResults = [
      { ownerId: "mem-1", itemId: "agent-memory:memory-fact:mem-1", score: 0.9 },
      { ownerId: "mem-2", itemId: "agent-memory:memory-fact:mem-2", score: 0.9 },
    ];

    const results = await repository.searchMemory({
      query: "semantic recall",
      scopeType: "workspace",
      scopeId: workspaceId,
      limit: 5,
      now: 1_700_000_000_000,
    });

    expect(vectorIndex.lastSearch).toEqual(expect.objectContaining({
      namespace: "agent-memory",
      scopeType: "workspace",
      scopeId: workspaceId,
    }));
    expect(results.map((result) => result.id)).toEqual(["mem-1"]);
  });

  it("does not return unrelated facts only because metadata scores are high", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact(createFact("mem-1", "用户希望 Javis 记忆本地优先", workspaceId));

    await expect(
      repository.searchMemory({
        query: "浏览器自动化截图",
        scopeType: "workspace",
        scopeId: workspaceId,
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([]);
  });

  it("records access metadata for returned facts only", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact({
      ...createFact("mem-1", "Javis memory remains local", workspaceId),
      lastAccessedAt: 1_700_000_001_000,
      accessCount: 2,
    });
    await repository.saveFact({
      ...createFact("mem-2", "Browser automation screenshot plan", workspaceId),
      tags: ["browser"],
      keywords: ["screenshot"],
    });

    await expect(repository.searchMemory({
      query: "Javis memory",
      scopeType: "workspace",
      scopeId: workspaceId,
      limit: 5,
      now: 1_700_000_002_000,
    })).resolves.toEqual([
      expect.objectContaining({ id: "mem-1" }),
    ]);

    expect(database.facts.get("mem-1")).toEqual(expect.objectContaining({
      last_accessed_at: 1_700_000_002_000,
      access_count: 3,
    }));
    expect(database.facts.get("mem-2")).toEqual(expect.objectContaining({
      last_accessed_at: null,
      access_count: 0,
    }));
  });

  it("still returns search results when access metadata cannot be updated", async () => {
    const database = createAgentMemoryDatabase({ failAccessTouch: true });
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact(createFact("mem-1", "Javis memory remains local", workspaceId));

    await expect(repository.searchMemory({
      query: "Javis memory",
      scopeType: "workspace",
      scopeId: workspaceId,
      limit: 5,
      now: 1_700_000_002_000,
    })).resolves.toEqual([
      expect.objectContaining({ id: "mem-1" }),
    ]);

    expect(database.facts.get("mem-1")).toEqual(expect.objectContaining({
      last_accessed_at: null,
      access_count: 0,
    }));
  });

  it("keeps fact access metadata when history restore upserts an existing fact", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact({
      ...createFact("mem-1", "Javis memory remains local", workspaceId),
      lastAccessedAt: 1_700_000_001_000,
      accessCount: 4,
    });

    await repository.saveFact(createFact("mem-1", "Javis memory remains local", workspaceId));

    expect(database.facts.get("mem-1")).toEqual(expect.objectContaining({
      last_accessed_at: 1_700_000_001_000,
      access_count: 4,
    }));

    await repository.saveFact({
      ...createFact("mem-1", "Javis memory remains local", workspaceId),
      lastAccessedAt: 1_700_000_002_000,
      accessCount: 2,
    });

    expect(database.facts.get("mem-1")).toEqual(expect.objectContaining({
      last_accessed_at: 1_700_000_002_000,
      access_count: 4,
    }));
  });

  it("hard-deletes a single fact and its related injection logs", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact({
      ...createFact("mem-1", "Javis memory remains local", workspaceId),
      sourceSessionId: "session-1",
    });
    await repository.saveFact(createFact("mem-2", "Javis browser plan", workspaceId));
    await repository.saveSessionSummary({
      id: "summary-1",
      sessionId: "session-1",
      workspaceId,
      summary: "User asked: Javis memory remains local",
      importantPoints: ["User goal: Javis memory remains local"],
      openThreads: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await repository.recordMemoryInjection({
      id: "log-1",
      sessionId: "session-1",
      workspaceId,
      injectionType: "workspace_memory",
      memoryFactIds: ["mem-1"],
      createdAt: 1_700_000_000_000,
    });
    await repository.recordMemoryInjection({
      id: "log-2",
      sessionId: "session-1",
      workspaceId,
      injectionType: "workspace_memory",
      memoryFactIds: ["mem-2"],
      createdAt: 1_700_000_000_000,
    });

    await repository.deleteFact("mem-1");

    expect(database.facts.has("mem-1")).toBe(false);
    expect(database.facts.has("mem-2")).toBe(true);
    expect(database.summaries.has("summary-1")).toBe(false);
    expect(database.injectionLogs.map((log) => log.id)).toEqual(["log-2"]);
  });

  it("keeps a source session summary while other facts still reference it", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact({
      ...createFact("mem-1", "Javis memory remains local", workspaceId),
      sourceSessionId: "session-1",
    });
    await repository.saveFact({
      ...createFact("mem-2", "Javis uses SQLite memory", workspaceId),
      sourceSessionId: "session-1",
    });
    await repository.saveSessionSummary({
      id: "summary-1",
      sessionId: "session-1",
      workspaceId,
      summary: "User asked: Javis memory remains local",
      importantPoints: [
        "User goal: Javis memory remains local",
        "Javis uses SQLite memory",
      ],
      openThreads: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });

    await repository.deleteFact("mem-1");

    expect(database.facts.has("mem-1")).toBe(false);
    expect(database.facts.has("mem-2")).toBe(true);
    expect(database.summaries.has("summary-1")).toBe(true);
  });

  it("does not leak workspace facts when workspace scope has no scope id", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    await repository.saveFact(createFact("mem-1", "Javis 记忆方案属于当前工作区", createCanonicalWorkspaceId("E:\\Javis")));
    await repository.saveFact(createFact("mem-2", "Javis 记忆方案属于另一个工作区", createCanonicalWorkspaceId("E:\\Other")));

    await expect(
      repository.searchMemory({
        query: "Javis 记忆方案",
        scopeType: "workspace",
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([]);
  });

  it("defaults searches to global memory unless a narrower scope is provided", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    await repository.saveFact(createGlobalFact("mem-global", "Javis 记忆方案采用本地优先"));
    await repository.saveFact(createFact("mem-workspace", "Javis 记忆方案属于当前工作区", createCanonicalWorkspaceId("E:\\Javis")));

    await expect(
      repository.searchMemory({
        query: "Javis 记忆方案",
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "mem-global",
      }),
    ]);
  });

  it("includes global facts when searching a workspace scope", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact(createFact("mem-workspace", "Javis workspace memory remains local", workspaceId));
    await repository.saveFact(createGlobalFact("mem-global", "Javis global memory preference remains local"));
    await repository.saveFact(createFact("mem-other", "Javis other workspace memory remains local", createCanonicalWorkspaceId("E:\\Other")));

    await expect(
      repository.searchMemory({
        query: "Javis memory local",
        scopeType: "workspace",
        scopeId: workspaceId,
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "mem-workspace", scopeType: "workspace" }),
      expect.objectContaining({ id: "mem-global", scopeType: "global" }),
    ]);
  });

  it("loads FTS matches even when they are outside the recent facts window", async () => {
    const database = createAgentMemoryDatabase({ recentFactLimit: 1, ftsMatchRowIds: [1] });
    const repository = createAgentMemoryRepository(database);
    await repository.saveFact(createGlobalFact("mem-old", "Javis 记忆方案采用本地优先"));
    await repository.saveFact({
      ...createGlobalFact("mem-new", "完全无关但更新时间更近"),
      tags: ["browser"],
      keywords: ["screenshot"],
    });

    await expect(
      repository.searchMemory({
        query: "Javis 记忆方案",
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "mem-old",
      }),
    ]);
  });

  it("uses LIKE fallback for older Chinese facts outside the recent facts window", async () => {
    const database = createAgentMemoryDatabase({ recentFactLimit: 1 });
    const repository = createAgentMemoryRepository(database);
    await repository.saveFact(createGlobalFact("mem-old", "用户要求 Javis 记忆第一版本地优先"));
    await repository.saveFact({
      ...createGlobalFact("mem-new", "浏览器截图自动化方案"),
      tags: ["browser"],
      keywords: ["screenshot"],
    });

    await expect(
      repository.searchMemory({
        query: "本地优先",
        limit: 5,
        now: 1_700_000_000_000,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "mem-old",
      }),
    ]);
  });

  it("rejects facts with unknown scopes instead of widening them to global", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);

    await expect(repository.saveFact({
      ...createGlobalFact("mem-project", "Project scoped memory should wait for stable project ids"),
      scopeType: "project" as never,
    })).rejects.toThrow("Invalid agent memory scope.");
  });

  it("summarizes memory control data without source message ids", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);
    const workspaceId = createCanonicalWorkspaceId("E:\\Javis");
    await repository.saveFact(createFact("mem-1", "用户希望 Javis 记忆本地优先", workspaceId));
    await repository.saveSessionSummary({
      id: "summary-1",
      sessionId: "session-1",
      workspaceId,
      summary: "记忆方案讨论",
      importantPoints: ["本地优先"],
      openThreads: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await repository.recordMemoryInjection({
      id: "log-1",
      sessionId: "session-1",
      workspaceId,
      injectionType: "workspace_memory",
      memoryFactIds: ["mem-1"],
      createdAt: 1_700_000_000_000,
    });

    const summary = await repository.getSummary(workspaceId, true);

    expect(summary).toMatchObject({
      enabled: true,
      totalFactCount: 1,
      workspaceFactCount: 1,
      sessionSummaryCount: 1,
      injectionLogCount: 1,
      lastUpdatedAt: 1_700_000_000_000,
    });
    expect(summary.recentFacts).toEqual([
      expect.objectContaining({
        id: "mem-1",
        fact: "用户希望 Javis 记忆本地优先",
        scopeType: "workspace",
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain("msg-1");
  });

  it("records injection logs without storing raw query text", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);

    await repository.recordMemoryInjection({
      id: "log-1",
      sessionId: "session-1",
      injectionType: "retrieved_memory",
      memoryFactIds: ["mem-1"],
      query: "用户的完整敏感查询文本",
      queryHashSecret: "local-secret",
      scopeType: "workspace",
      scopeId: "workspace:abc",
      scoreSummary: { resultCount: 1 },
      createdAt: 1_700_000_000_000,
    });

    expect(database.injectionLogs).toHaveLength(1);
    expect(database.injectionLogs[0].query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(database.injectionLogs[0].query_terms))).toEqual([]);
    expect(database.injectionLogs[0]).not.toEqual(expect.objectContaining({ query: expect.anything() }));
    expect(JSON.stringify(database.injectionLogs[0])).not.toContain("完整敏感查询文本");
  });

  it("stores only short audit query terms when they are provided", async () => {
    const database = createAgentMemoryDatabase();
    const repository = createAgentMemoryRepository(database);

    await repository.recordMemoryInjection({
      id: "log-1",
      sessionId: "session-1",
      injectionType: "retrieved_memory",
      memoryFactIds: ["mem-1"],
      query: "FULL_PRIVATE_QUERY Javis memory local-first",
      queryHashSecret: "local-secret",
      queryTerms: ["Javis", "memory", "local-first", "用户的完整敏感查询文本"],
      createdAt: 1_700_000_000_000,
    });

    expect(JSON.parse(String(database.injectionLogs[0].query_terms))).toEqual([
      "Javis",
      "memory",
      "local-first",
    ]);
    expect(JSON.stringify(database.injectionLogs[0])).not.toContain("FULL_PRIVATE_QUERY");
    expect(JSON.stringify(database.injectionLogs[0])).not.toContain("完整敏感查询文本");
  });

  it("requires an app-local secret for query HMAC", async () => {
    await expect(createMemoryQueryHmac("query", "")).rejects.toThrow("requires an app-local HMAC secret");
    await expect(createMemoryQueryHmac("query", "secret")).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});

function createFact(id: string, fact: string, workspaceId: string): AgentMemoryFact {
  return {
    id,
    fact,
    kind: "design_principle",
    tags: ["Javis", "memory"],
    keywords: ["Javis", "记忆", "本地"],
    searchText: "",
    scopeType: "workspace",
    scopeId: workspaceId,
    sourceMessageIds: ["msg-1"],
    confidence: 0.95,
    importance: 5,
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accessCount: 0,
  };
}

function createGlobalFact(id: string, fact: string): AgentMemoryFact {
  return {
    ...createFact(id, fact, createCanonicalWorkspaceId("E:\\Javis")),
    scopeType: "global",
    scopeId: undefined,
  };
}

function createFakeEmbeddingProvider() {
  return {
    dimensions: 2,
    async embedTexts(texts: string[]) {
      return texts.map((text) => text.toLowerCase().includes("semantic") ? [0, 1] : [1, 0]);
    },
  };
}

class FakeMemoryVectorIndex {
  items = new Map<string, {
    namespace: string;
    scopeType?: string;
    scopeId?: string;
  }>();
  deletedOwners: string[] = [];
  searchResults: VectorIndexSearchResult[] = [];
  lastSearch?: VectorIndexSearchInput;

  async upsertItem(input: {
    namespace: string;
    ownerType: string;
    ownerId: string;
    scopeType?: string;
    scopeId?: string;
  }) {
    this.items.set(input.ownerId, {
      namespace: input.namespace,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    });
  }

  async deleteByOwner(ownerType: string, ownerId: string) {
    this.deletedOwners.push(`${ownerType}:${ownerId}`);
    this.items.delete(ownerId);
  }

  async deleteByScope(namespace: string, scopeType: string, scopeId: string) {
    for (const [ownerId, item] of this.items) {
      if (item.namespace === namespace && item.scopeType === scopeType && item.scopeId === scopeId) {
        this.items.delete(ownerId);
      }
    }
  }

  async clearNamespace(namespace: string) {
    for (const [ownerId, item] of this.items) {
      if (item.namespace === namespace) this.items.delete(ownerId);
    }
  }

  async search(input: VectorIndexSearchInput) {
    this.lastSearch = input;
    return this.searchResults;
  }
}

function maxNullableNumber(left: unknown, right: unknown): number | null {
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : undefined;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : undefined;
  if (leftNumber === undefined) return rightNumber ?? null;
  if (rightNumber === undefined) return leftNumber;
  return Math.max(leftNumber, rightNumber);
}

function createAgentMemoryDatabase(options: { recentFactLimit?: number; ftsMatchRowIds?: number[]; failAccessTouch?: boolean } = {}) {
  const facts = new Map<string, Record<string, unknown>>();
  const summaries = new Map<string, Record<string, unknown>>();
  const injectionLogs: Array<Record<string, unknown>> = [];

  return {
    facts,
    summaries,
    injectionLogs,
    async execute(sql: string, bindValues: DatabaseValue[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO agent_memory_facts")) {
        const previous = facts.get(String(bindValues[0]));
        const lastAccessedAt = maxNullableNumber(previous?.last_accessed_at, bindValues[16]);
        facts.set(String(bindValues[0]), {
          rowid: previous?.rowid ?? facts.size + 1,
          id: bindValues[0],
          fact: bindValues[1],
          normalized_fact: bindValues[2],
          kind: bindValues[3],
          tags_json: bindValues[4],
          keywords_json: bindValues[5],
          search_text: bindValues[6],
          scope_type: bindValues[7],
          scope_id: bindValues[8],
          source_session_id: bindValues[9],
          source_message_ids: bindValues[10],
          confidence: bindValues[11],
          importance: bindValues[12],
          status: bindValues[13],
          created_at: bindValues[14],
          updated_at: bindValues[15],
          last_accessed_at: lastAccessedAt,
          access_count: Math.max(Number(previous?.access_count ?? 0), Number(bindValues[17] ?? 0)),
          expires_at: bindValues[18],
        });
        return;
      }
      if (normalized.startsWith("INSERT INTO agent_session_summaries")) {
        summaries.set(String(bindValues[0]), {
          id: bindValues[0],
          session_id: bindValues[1],
          workspace_id: bindValues[2],
          summary: bindValues[3],
          important_points: bindValues[4],
          open_threads: bindValues[5],
          created_at: bindValues[6],
          updated_at: bindValues[7],
        });
        return;
      }
      if (normalized.startsWith("INSERT INTO memory_injection_logs")) {
        injectionLogs.push({
          id: bindValues[0],
          session_id: bindValues[1],
          message_id: bindValues[2],
          workspace_id: bindValues[3],
          injection_type: bindValues[4],
          memory_fact_ids: bindValues[5],
          query_hash: bindValues[6],
          query_terms: bindValues[7],
          query_length: bindValues[8],
          scope_type: bindValues[9],
          scope_id: bindValues[10],
          prompt_section: bindValues[11],
          score_summary: bindValues[12],
          created_at: bindValues[13],
        });
        return;
      }
      if (normalized.startsWith("UPDATE agent_memory_facts SET last_accessed_at")) {
        if (options.failAccessTouch) {
          throw new Error("Access metadata update failed.");
        }
        const fact = facts.get(String(bindValues[2]));
        if (fact && fact.status === bindValues[3]) {
          fact.last_accessed_at = maxNullableNumber(fact.last_accessed_at, bindValues[0]);
          fact.access_count = Number(fact.access_count ?? 0) + 1;
        }
        return;
      }
      if (normalized === "DELETE FROM agent_memory_facts") {
        facts.clear();
        return;
      }
      if (normalized === "DELETE FROM agent_session_summaries") {
        summaries.clear();
        return;
      }
      if (normalized === "DELETE FROM memory_injection_logs") {
        injectionLogs.length = 0;
        return;
      }
      if (normalized.startsWith("DELETE FROM agent_memory_facts WHERE id")) {
        facts.delete(String(bindValues[0]));
        return;
      }
      if (normalized.startsWith("DELETE FROM agent_memory_facts WHERE scope_type")) {
        for (const [id, fact] of facts) {
          if (fact.scope_type === bindValues[0] && fact.scope_id === bindValues[1]) {
            facts.delete(id);
          }
        }
        return;
      }
      if (normalized.startsWith("DELETE FROM agent_session_summaries WHERE workspace_id")) {
        for (const [id, summary] of summaries) {
          if (summary.workspace_id === bindValues[0]) {
            summaries.delete(id);
          }
        }
        return;
      }
      if (normalized.startsWith("DELETE FROM agent_session_summaries WHERE session_id")) {
        for (const [id, summary] of summaries) {
          if (summary.session_id === bindValues[0]) {
            summaries.delete(id);
          }
        }
        return;
      }
      if (normalized.startsWith("DELETE FROM memory_injection_logs WHERE workspace_id")) {
        const remaining = injectionLogs.filter((log) => log.workspace_id !== bindValues[0]);
        injectionLogs.splice(0, injectionLogs.length, ...remaining);
        return;
      }
      if (normalized.startsWith("DELETE FROM memory_injection_logs WHERE scope_type")) {
        const remaining = injectionLogs.filter((log) => !(log.scope_type === bindValues[0] && log.scope_id === bindValues[1]));
        injectionLogs.splice(0, injectionLogs.length, ...remaining);
        return;
      }
      if (normalized.startsWith("DELETE FROM memory_injection_logs WHERE memory_fact_ids LIKE")) {
        const needle = String(bindValues[0]).replace(/[%"]/g, "");
        const remaining = injectionLogs.filter((log) => !String(log.memory_fact_ids).includes(needle));
        injectionLogs.splice(0, injectionLogs.length, ...remaining);
      }
    },
    async select<T extends Record<string, unknown>>(sql: string, bindValues: DatabaseValue[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT COUNT(*) as count FROM agent_memory_facts WHERE status = ? AND scope_type")) {
        return [{ count: [...facts.values()].filter((fact) =>
          fact.status === bindValues[0] && fact.scope_type === bindValues[1] && fact.scope_id === bindValues[2]
        ).length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM agent_memory_facts WHERE source_session_id")) {
        return [{ count: [...facts.values()].filter((fact) => fact.source_session_id === bindValues[0]).length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM agent_memory_facts WHERE status = ?")) {
        return [{ count: [...facts.values()].filter((fact) => fact.status === bindValues[0]).length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM agent_session_summaries WHERE workspace_id")) {
        return [{ count: [...summaries.values()].filter((summary) => summary.workspace_id === bindValues[0]).length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM agent_session_summaries")) {
        return [{ count: summaries.size }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM memory_injection_logs WHERE workspace_id")) {
        return [{ count: injectionLogs.filter((log) => log.workspace_id === bindValues[0]).length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT COUNT(*) as count FROM memory_injection_logs")) {
        return [{ count: injectionLogs.length }] as unknown as T[];
      }
      if (normalized.startsWith("SELECT updated_at FROM agent_memory_facts")) {
        const latest = [...facts.values()]
          .filter((fact) => fact.status === bindValues[0])
          .sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))[0];
        return latest ? [{ updated_at: latest.updated_at }] as unknown as T[] : [];
      }
      if (normalized.startsWith("SELECT rowid FROM agent_memory_facts_fts")) {
        return (options.ftsMatchRowIds ?? []).map((rowid) => ({ rowid })) as unknown as T[];
      }
      if (normalized.startsWith("SELECT rowid, id, fact")) {
        if (normalized.includes("WHERE id = ?")) {
          return [...facts.values()].filter((fact) => fact.id === bindValues[0]) as T[];
        }
        if (normalized.includes("WHERE status = ? AND rowid IN")) {
          const rowIds = new Set(bindValues.slice(1).map(Number));
          return [...facts.values()].filter((fact) => rowIds.has(Number(fact.rowid))) as T[];
        }
        if (normalized.includes("WHERE status = ? AND scope_type = ? AND scope_id = ?")) {
          return [...facts.values()]
            .filter((fact) => fact.status === bindValues[0] && fact.scope_type === bindValues[1] && fact.scope_id === bindValues[2])
            .slice(-(options.recentFactLimit ?? facts.size))
            .reverse() as T[];
        }
        if (normalized.includes("WHERE status = ? AND ( fact LIKE ?")) {
          const needle = String(bindValues[1] ?? "").replace(/%/g, "").toLocaleLowerCase();
          return [...facts.values()]
            .filter((fact) => fact.status === bindValues[0])
            .filter((fact) =>
              [
                fact.fact,
                fact.normalized_fact,
                fact.search_text,
                fact.tags_json,
                fact.keywords_json,
              ].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))
            )
            .sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0))
            .slice(0, Number(bindValues[6] ?? 40)) as T[];
        }
        return [...facts.values()].slice(-(options.recentFactLimit ?? facts.size)).reverse() as T[];
      }
      if (normalized.startsWith("SELECT id, session_id")) {
        return [...summaries.values()] as T[];
      }
      return [];
    },
  };
}
