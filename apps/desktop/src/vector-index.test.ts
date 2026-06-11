import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import {
  VECTOR_INDEX_MIGRATIONS,
  createVectorIndexRepository,
} from "./vector-index";

describe("vector index", () => {
  it("defines persistent migrations for items, buckets, and indexes", () => {
    expect(VECTOR_INDEX_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "vector-index-v1-items-table",
      "vector-index-v1-buckets-table",
      "vector-index-v1-owner-index",
      "vector-index-v1-scope-index",
    ]);
  });

  it("upserts vectors and returns cosine-ranked nearest candidates", async () => {
    const database = new MemoryVectorDatabase();
    const repository = createVectorIndexRepository(database);

    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-a",
      scopeType: "workspace",
      scopeId: "workspace-a",
      contentHash: "hash-a",
      vector: [1, 0, 0],
      metadata: { label: "alpha" },
      now: 1,
    });
    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-b",
      scopeType: "workspace",
      scopeId: "workspace-a",
      contentHash: "hash-b",
      vector: [0.9, 0.1, 0],
      now: 2,
    });

    const results = await repository.search({
      namespace: "agent-memory",
      scopeType: "workspace",
      scopeId: "workspace-a",
      vector: [1, 0, 0],
      limit: 2,
    });

    expect(results.map((result) => result.ownerId)).toEqual(["fact-a", "fact-b"]);
    expect(results[0]?.metadata).toEqual({ label: "alpha" });
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("keeps workspace scopes isolated", async () => {
    const database = new MemoryVectorDatabase();
    const repository = createVectorIndexRepository(database);

    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-a",
      scopeType: "workspace",
      scopeId: "workspace-a",
      contentHash: "hash-a",
      vector: [1, 0],
    });
    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-b",
      scopeType: "workspace",
      scopeId: "workspace-b",
      contentHash: "hash-b",
      vector: [1, 0],
    });

    const results = await repository.search({
      namespace: "agent-memory",
      scopeType: "workspace",
      scopeId: "workspace-b",
      vector: [1, 0],
    });

    expect(results.map((result) => result.ownerId)).toEqual(["fact-b"]);
  });

  it("hard-deletes vectors by owner and scope", async () => {
    const database = new MemoryVectorDatabase();
    const repository = createVectorIndexRepository(database);

    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-a",
      scopeType: "workspace",
      scopeId: "workspace-a",
      contentHash: "hash-a",
      vector: [1, 0],
    });
    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-b",
      scopeType: "workspace",
      scopeId: "workspace-a",
      contentHash: "hash-b",
      vector: [0, 1],
    });

    await repository.deleteByOwner("memory-fact", "fact-a");
    expect((await repository.search({ namespace: "agent-memory", vector: [1, 0] })).map((result) => result.ownerId))
      .toEqual(["fact-b"]);

    await repository.deleteByScope("agent-memory", "workspace", "workspace-a");
    expect(await repository.search({ namespace: "agent-memory", vector: [1, 0] })).toEqual([]);
  });

  it("rejects invalid query vectors and skips dimension mismatches", async () => {
    const database = new MemoryVectorDatabase();
    const repository = createVectorIndexRepository(database);
    await repository.upsertItem({
      namespace: "agent-memory",
      ownerType: "memory-fact",
      ownerId: "fact-a",
      contentHash: "hash-a",
      vector: [1, 0, 0],
    });

    await expect(repository.search({ namespace: "agent-memory", vector: [] }))
      .rejects.toThrow("non-empty vector");
    expect(await repository.search({ namespace: "agent-memory", vector: [1, 0] })).toEqual([]);
  });
});

interface MemoryVectorItem {
  id: string;
  namespace: string;
  owner_type: string;
  owner_id: string;
  scope_type?: string | null;
  scope_id?: string | null;
  dimensions: number;
  metric: string;
  vector_json: string;
  vector_norm: number;
  metadata_json?: string | null;
}

class MemoryVectorDatabase {
  private items = new Map<string, MemoryVectorItem>();
  private buckets = new Map<string, Set<string>>();

  async execute(sql: string, bindValues: DatabaseValue[] = []): Promise<void> {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("insert into vector_index_items")) {
      const item: MemoryVectorItem = {
        id: String(bindValues[0]),
        namespace: String(bindValues[1]),
        owner_type: String(bindValues[2]),
        owner_id: String(bindValues[3]),
        scope_type: bindValues[4] === null ? null : String(bindValues[4]),
        scope_id: bindValues[5] === null ? null : String(bindValues[5]),
        dimensions: Number(bindValues[7]),
        metric: String(bindValues[8]),
        vector_json: String(bindValues[9]),
        vector_norm: Number(bindValues[10]),
        metadata_json: bindValues[11] === null ? null : String(bindValues[11]),
      };
      this.items.set(item.id, item);
      return;
    }
    if (normalized.startsWith("delete from vector_index_buckets where item_id")) {
      for (const ids of this.buckets.values()) {
        ids.delete(String(bindValues[0]));
      }
      return;
    }
    if (normalized.startsWith("insert or ignore into vector_index_buckets")) {
      const key = `${bindValues[0]}:${bindValues[1]}`;
      const ids = this.buckets.get(key) ?? new Set<string>();
      ids.add(String(bindValues[2]));
      this.buckets.set(key, ids);
      return;
    }
    if (normalized.startsWith("delete from vector_index_items where id")) {
      this.items.delete(String(bindValues[0]));
    }
  }

  async select<T extends Record<string, unknown>>(sql: string, bindValues: DatabaseValue[] = []): Promise<T[]> {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("select id from vector_index_items where owner_type")) {
      return [...this.items.values()]
        .filter((item) => item.owner_type === bindValues[0] && item.owner_id === bindValues[1])
        .map((item) => ({ id: item.id }) as unknown as T);
    }
    if (normalized.startsWith("select id from vector_index_items") && normalized.includes("scope_type")) {
      return [...this.items.values()]
        .filter((item) => item.namespace === bindValues[0] && item.scope_type === bindValues[1] && item.scope_id === bindValues[2])
        .map((item) => ({ id: item.id }) as unknown as T);
    }
    if (normalized.startsWith("select item_id from vector_index_buckets")) {
      const ids = this.buckets.get(`${bindValues[0]}:${bindValues[1]}`) ?? new Set<string>();
      return [...ids].slice(0, Number(bindValues[2])).map((item_id) => ({ item_id }) as unknown as T);
    }
    if (normalized.startsWith("select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where id")) {
      const item = this.items.get(String(bindValues[0]));
      return item ? [item as unknown as T] : [];
    }
    if (normalized.startsWith("select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace and scope_type")) {
      return [...this.items.values()]
        .filter((item) => item.namespace === bindValues[0] && item.scope_type === bindValues[1] && item.scope_id === bindValues[2])
        .slice(0, Number(bindValues[3])) as unknown as T[];
    }
    if (normalized.startsWith("select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace")) {
      return [...this.items.values()]
        .filter((item) => item.namespace === bindValues[0])
        .slice(0, Number(bindValues[1])) as unknown as T[];
    }
    return [];
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/[(),=*]/g, " ").replace(/\s+/g, " ").trim();
}
