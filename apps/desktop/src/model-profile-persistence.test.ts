import { describe, expect, it } from "vitest";
import type { DatabaseValue } from "./desktop-database";
import { createModelProfileRepository } from "./model-profile-persistence";

interface ProfileRow {
  id: string;
  slot: string | null;
  display_name: string;
  provider: string;
  model: string;
  api_key_reference: string;
  base_url: string;
  capabilities: string;
}

describe("model profile context window persistence", () => {
  it("infers missing context tokens on load and preserves explicit values", async () => {
    const database = createMemoryProfileDatabase([
      createProfileRow("deepseek", "deepseek", "deepseek-chat", "{}"),
      createProfileRow("gpt", "openai", "gpt-4.1", JSON.stringify({ contextTokens: 77_777 })),
      createProfileRow("mimo", "mimo", "mimo-v2.5-pro", "{}"),
    ]);

    const configuration = await createModelProfileRepository(database).load();

    expect(configuration.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", contextTokens: 1_000_000 }),
      expect.objectContaining({ id: "gpt", contextTokens: 77_777 }),
      expect.objectContaining({ id: "mimo", contextTokens: 1_048_576 }),
    ]));
  });

  it("persists inferred tokens for old profiles while retaining explicit overrides", async () => {
    const database = createMemoryProfileDatabase([]);
    const repository = createModelProfileRepository(database);

    const saved = await repository.save([
      createProfile("deepseek", "deepseek", "deepseek-chat"),
      createProfile("gpt", "openai", "gpt-4.1", 66_666),
      createProfile("mimo", "mimo", "mimo-v2.5-pro"),
    ], {});

    expect(saved.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", contextTokens: 1_000_000 }),
      expect.objectContaining({ id: "gpt", contextTokens: 66_666 }),
      expect.objectContaining({ id: "mimo", contextTokens: 1_048_576 }),
    ]));

    const profileWrites = database.executed.filter((entry) =>
      entry.sql.includes("INSERT INTO model_profiles"),
    );
    expect(profileWrites).toHaveLength(3);
    expect(profileWrites.map((entry) => JSON.parse(String(entry.values[7])))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contextTokens: 1_000_000 }),
        expect.objectContaining({ contextTokens: 66_666 }),
        expect.objectContaining({ contextTokens: 1_048_576 }),
      ]),
    );
  });

  it("infers the actual legacy model instead of retaining a locale default", async () => {
    const database = createMemoryProfileDatabase([]);
    const configuration = await createModelProfileRepository(database).importFromLegacySettings(
      {
        provider: "mimo",
        model: "mimo-v2.5-pro",
        apiKeyReference: "model.mimo",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
      "zh-CN",
    );

    expect(configuration.profiles.find((profile) => profile.id === "primary")).toEqual(
      expect.objectContaining({
        model: "mimo-v2.5-pro",
        contextTokens: 1_048_576,
      }),
    );
  });
});

function createProfile(
  id: string,
  provider: string,
  model: string,
  contextTokens?: number,
) {
  return {
    id,
    slot: null,
    displayName: model,
    provider,
    model,
    apiKeyReference: `model.${provider}`,
    baseUrl: "",
    ...(contextTokens === undefined ? {} : { contextTokens }),
    capabilities: { vision: false, code: true, longContext: false },
  };
}

function createProfileRow(
  id: string,
  provider: string,
  model: string,
  capabilities: string,
): ProfileRow {
  return {
    id,
    slot: null,
    display_name: model,
    provider,
    model,
    api_key_reference: `model.${provider}`,
    base_url: "",
    capabilities,
  };
}

function createMemoryProfileDatabase(initialRows: ProfileRow[]) {
  const rows = [...initialRows];
  const executed: Array<{ sql: string; values: DatabaseValue[] }> = [];
  const database = {
    executed,
    async execute(sql: string, values: DatabaseValue[] = []) {
      executed.push({ sql, values });
    },
    async select<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.includes("COUNT(*)")) {
        return [{ count: rows.length }] as unknown as T[];
      }
      if (sql.includes("SELECT id, slot")) {
        return rows as unknown as T[];
      }
      if (sql.includes("SELECT agent_kind")) {
        return [] as T[];
      }
      return [] as T[];
    },
  };
  return database;
}

describe("model profile max output tokens persistence", () => {
  it("loads and saves the configured max output tokens", async () => {
    const database = createMemoryProfileDatabase([
      createProfileRow("deepseek", "deepseek", "deepseek-chat", JSON.stringify({ maxOutputTokens: 16_384 })),
      createProfileRow("mimo", "mimo", "mimo-v2.5-pro", "{}"),
    ]);

    const loaded = await createModelProfileRepository(database).load();

    expect(loaded.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", maxOutputTokens: 16_384 }),
      expect.objectContaining({ id: "mimo", maxOutputTokens: undefined }),
    ]));

    const repository = createModelProfileRepository(database);
    await repository.save([
      { ...createProfile("deepseek", "deepseek", "deepseek-chat"), maxOutputTokens: 32_768 },
      createProfile("mimo", "mimo", "mimo-v2.5-pro"),
    ], {});

    const profileWrites = database.executed.filter((entry) =>
      entry.sql.includes("INSERT INTO model_profiles"),
    );
    const serializedCaps = profileWrites.map((entry) => JSON.parse(String(entry.values[7])));
    expect(serializedCaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ maxOutputTokens: 32_768 }),
      ]),
    );
    expect(serializedCaps.find((caps) => caps.maxOutputTokens !== undefined))
      .toEqual(expect.objectContaining({ maxOutputTokens: 32_768 }));
    expect(serializedCaps.filter((caps) => caps.maxOutputTokens === undefined)).toHaveLength(1);
  });
});
