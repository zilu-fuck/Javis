import { describe, expect, it } from "vitest";
import type { ToolJsonSchema } from "./types";
import { validateToolSchema } from "./tool-schema-validation";

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
