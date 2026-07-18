import { describe, expect, it } from "vitest";
import { sanitizeMcpInputSchema, validateMcpInput } from "./mcp-input-schema";

describe("MCP input schema recursion", () => {
  it("validates nested object properties, required fields, enums, and extra fields", () => {
    const schema = sanitizeMcpInputSchema({
      type: "object",
      required: ["request"],
      additionalProperties: false,
      properties: {
        request: {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: {
            mode: { enum: ["read", "inspect"] },
            options: {
              type: "object",
              required: ["limit"],
              additionalProperties: false,
              properties: {
                limit: { type: "integer" },
              },
            },
          },
        },
      },
    });

    expect(schema).toBeDefined();
    expect(validateMcpInput(schema, {
      request: { mode: "read", options: { limit: 5 } },
    })).toBeUndefined();
    expect(validateMcpInput(schema, {
      request: { mode: "delete", options: { limit: 5 } },
    })).toContain("mode");
    expect(validateMcpInput(schema, {
      request: { mode: "read", options: {} },
    })).toContain("limit");
    expect(validateMcpInput(schema, {
      request: { mode: "read", extra: true },
    })).toContain("undeclared field: extra");
  });

  it("recursively validates arrays of objects and their enum fields", () => {
    const schema = sanitizeMcpInputSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["kind"],
            additionalProperties: false,
            properties: {
              kind: { enum: ["file", "directory"] },
              path: { type: "string" },
            },
          },
        },
      },
    });

    expect(schema).toBeDefined();
    expect(validateMcpInput(schema, {
      items: [{ kind: "file", path: "src" }],
    })).toBeUndefined();
    expect(validateMcpInput(schema, {
      items: [{ kind: "socket", path: "src" }],
    })).toContain("kind");
    expect(validateMcpInput(schema, {
      items: [{ path: "src" }],
    })).toContain("kind");
  });

  it("rejects open-ended or malformed nested object schemas", () => {
    expect(sanitizeMcpInputSchema({
      type: "object",
      properties: {
        request: {
          type: "object",
          additionalProperties: true,
          properties: {},
        },
      },
    })).toBeUndefined();
    expect(sanitizeMcpInputSchema({
      type: "object",
      properties: {
        request: {
          type: "object",
          additionalProperties: { type: "string" },
          properties: {},
        },
      },
    })).toBeUndefined();
    expect(sanitizeMcpInputSchema({
      type: "object",
      properties: {
        request: {
          type: "object",
          required: ["missing"],
          properties: {},
        },
      },
    })).toBeUndefined();
  });

  it("rejects prototype keys in schemas and arguments", () => {
    const poisonedSchema = JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}',
    );
    expect(sanitizeMcpInputSchema(poisonedSchema)).toBeUndefined();

    const schema = sanitizeMcpInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
    });
    const poisonedInput = JSON.parse('{"query":"safe","__proto__":{"unexpected":true}}');
    expect(validateMcpInput(schema, poisonedInput)).toContain("undeclared field: __proto__");
  });

  it("rejects schema constraints outside the validated subset", () => {
    expect(sanitizeMcpInputSchema({
      type: "object",
      properties: { path: { type: "string", pattern: "^safe/" } },
    })).toBeUndefined();
    expect(sanitizeMcpInputSchema({
      type: "object",
      properties: { limit: { type: "integer", maximum: 10 } },
    })).toBeUndefined();
  });
});
