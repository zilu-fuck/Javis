import { describe, expect, it } from "vitest";
import type { ToolJsonSchema } from "./types";
import { repairToolSchemaValue, validateToolSchema } from "./tool-schema-validation";

const schema: ToolJsonSchema = {
  type: "object",
  properties: {
    goal: { type: "string", minLength: 1, pattern: "\\S" },
    direction: { type: "string", enum: ["forward", "backward"] },
    maxDepth: { type: "integer", minimum: 1, maximum: 20 },
    terms: {
      type: "array",
      items: { type: "string" },
      maxItems: 2,
    },
  },
  required: ["goal"],
  additionalProperties: false,
};

describe("tool schema validation", () => {
  it("accepts a value that matches the declared schema", () => {
    expect(validateToolSchema(schema, {
      goal: "trace runtime",
      direction: "forward",
      maxDepth: 4,
      terms: ["runtime", "tool"],
    })).toBeUndefined();
  });

  it("rejects missing, unknown, mistyped, and out-of-range fields", () => {
    expect(validateToolSchema(schema, {})).toContain("missing required field \"goal\"");
    expect(validateToolSchema(schema, { goal: " " })).toContain("string pattern");
    expect(validateToolSchema(schema, { goal: "trace", extra: true }))
      .toContain("undeclared field: extra");
    expect(validateToolSchema(schema, { goal: "trace", maxDepth: 1.5 }))
      .toContain("must be a integer");
    expect(validateToolSchema(schema, { goal: "trace", maxDepth: 21 }))
      .toContain("less than or equal to 20");
    expect(validateToolSchema(schema, { goal: "trace", direction: "sideways" }))
      .toContain("declared values");
    expect(validateToolSchema(schema, { goal: "trace", terms: ["a", "b", "c"] }))
      .toContain("at most 2 item");
  });
});

const evidenceItemSchema: ToolJsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    line: { type: "integer" },
    score: { type: "number" },
    matchedTerms: { type: "array", items: { type: "string" } },
  },
  required: ["path", "matchedTerms"],
  additionalProperties: false,
};

const outputSchema: ToolJsonSchema = {
  type: "object",
  properties: {
    actualFound: { type: "array", items: evidenceItemSchema },
    query: { type: "string" },
    truncated: { type: "boolean" },
    attempts: { type: "array", items: { type: "string" } },
  },
  required: ["actualFound"],
  additionalProperties: false,
};

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: "src/a.ts", line: 27, matchedTerms: ["a"], ...overrides };
}

describe("tool schema repair", () => {
  it("coerces an unambiguous mistyped scalar instead of failing", () => {
    const result = repairToolSchemaValue(
      outputSchema,
      { actualFound: [evidence(), evidence({ path: "src/b.ts", line: "27" })] },
      {},
      "Tool code.searchRepository output",
    );

    expect(result.ok).toBe(true);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toContain("coerced \"27\" to integer");
    const repaired = result.value as { actualFound: Array<{ line: unknown }> };
    expect(repaired.actualFound[1].line).toBe(27);
  });

  it("coerces numbers to strings, \"true\" to boolean, and drops null for optional fields", () => {
    const result = repairToolSchemaValue(
      outputSchema,
      { actualFound: [], query: 42, truncated: "true", attempts: null },
      {},
      "Tool code.searchRepository output",
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ actualFound: [], query: "42", truncated: true });
    expect(result.repairs.join(" ")).toContain("coerced number to string");
    expect(result.repairs.join(" ")).toContain("coerced \"true\" to boolean");
    expect(result.repairs.join(" ")).toContain("dropped null for an optional field");
  });

  it("never coerces into a declared enum", () => {
    const enumSchema: ToolJsonSchema = {
      type: "object",
      properties: { status: { type: "string", enum: ["completed", "failed"] } },
      required: ["status"],
    };
    const result = repairToolSchemaValue(enumSchema, { status: 3 }, {}, "out");
    expect(result.ok).toBe(false);
    expect(result.repairs).toHaveLength(0);
  });

  it("drops a bounded number of invalid array items and reports them", () => {
    const items = Array.from({ length: 10 }, (_, index) => evidence({ path: `src/${index}.ts` }));
    // Exactly one unusable item out of ten: within the default 10% ratio bound.
    items[1] = { path: "", matchedTerms: [] };

    const result = repairToolSchemaValue(outputSchema, { actualFound: items }, {}, "out");
    expect(result.ok).toBe(true);
    expect(result.repairs.join(" ")).toContain("dropped 1 of 10 invalid item(s)");
    expect((result.value as { actualFound: unknown[] }).actualFound).toHaveLength(9);
  });

  it("fails when too many array items are invalid instead of hiding a broken shape", () => {
    const items = Array.from({ length: 4 }, (_, index) => evidence({ path: `src/${index}.ts` }));
    items[1] = { path: "", matchedTerms: [] };
    items[2] = { path: "", matchedTerms: [] };
    items[3] = { path: "", matchedTerms: [] };

    const result = repairToolSchemaValue(outputSchema, { actualFound: items }, {}, "out");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must contain at least 1 character");
  });

  it("keeps undeclared fields and missing required fields fatal", () => {
    expect(repairToolSchemaValue(outputSchema, { actualFound: [], extra: 1 }, {}, "out").ok).toBe(false);
    expect(repairToolSchemaValue(outputSchema, { actualFound: [], extra: 1 }, {}, "out").error)
      .toContain("undeclared field: extra");
    expect(repairToolSchemaValue(outputSchema, { query: "x" }, {}, "out").error)
      .toContain("missing required field \"actualFound\"");
  });

  it("can be restricted to coercion only", () => {
    const result = repairToolSchemaValue(
      outputSchema,
      { actualFound: [{ path: "", matchedTerms: [] }] },
      { pruneInvalidArrayItems: false },
      "out",
    );
    expect(result.ok).toBe(false);
    expect(result.repairs).toHaveLength(0);
  });

  it("repairs a top-level array output", () => {
    const arraySchema: ToolJsonSchema = {
      type: "array",
      items: { type: "object", properties: { heading: { type: "string" } }, required: ["heading"] },
    };
    const result = repairToolSchemaValue(
      arraySchema,
      [{ heading: "a" }, { heading: 3 }, { heading: null }],
      { maxDroppedRatio: 0.5 },
      "out",
    );
    // `heading: 3` is coerced; `heading: null` is required but not a string, so it
    // is dropped within the widened bound.
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([{ heading: "a" }, { heading: "3" }]);
  });

  it("leaves a conforming value byte-identical apart from the repair list", () => {
    const value = { actualFound: [evidence()], query: "find", truncated: false };
    const result = repairToolSchemaValue(outputSchema, value, {}, "out");
    expect(result.ok).toBe(true);
    expect(result.repairs).toHaveLength(0);
    expect(result.value).toEqual(value);
  });
});
