import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "@javis/tools";
import {
  toolDescriptorToJsonSchema,
  toolDescriptorsToAgentToolSpecs,
} from "./tool-schema";

const baseDescriptor: ToolDescriptor = {
  name: "web.search",
  permissionLevel: "read",
  summary: "Search the web.",
  capabilityTags: ["web_search"],
  ownerAgentKinds: ["research"],
  requiredInputs: [{ name: "query", type: "string", nonEmpty: true }],
};

describe("agent tool schemas", () => {
  it("converts requiredInputs to JSON Schema", () => {
    expect(toolDescriptorToJsonSchema(baseDescriptor)).toEqual({
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: true,
    });
  });

  it("uses the complete MCP schema when available", () => {
    const mcpInputSchema = {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
      additionalProperties: false,
    } as const;
    expect(toolDescriptorToJsonSchema({
      ...baseDescriptor,
      metadata: { mcpInputSchema },
    })).toBe(mcpInputSchema);
  });

  it("keeps canonical and provider names separate", () => {
    expect(toolDescriptorsToAgentToolSpecs([baseDescriptor])).toEqual([{
      canonicalName: "web.search",
      modelName: "web__search",
      description: "Search the web.",
      inputSchema: expect.any(Object),
    }]);
  });
});
