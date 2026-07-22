import type { ToolDescriptor, ToolRequiredInput } from "@javis/tools";
import type { AgentToolSpec, JsonSchema } from "./contracts";
import { createToolNameAliasMap } from "./tool-name-alias";

export function toolDescriptorsToAgentToolSpecs(
  descriptors: readonly ToolDescriptor[],
): AgentToolSpec[] {
  const aliases = createToolNameAliasMap(descriptors.map((descriptor) => descriptor.name));
  return descriptors.map((descriptor) => ({
    canonicalName: descriptor.name,
    modelName: aliases.toModelName(descriptor.name),
    description: descriptor.summary,
    inputSchema: toolDescriptorToJsonSchema(descriptor),
  }));
}

export function toolDescriptorToJsonSchema(
  descriptor: Pick<ToolDescriptor, "metadata" | "requiredInputs">,
): JsonSchema {
  const mcpSchema = descriptor.metadata?.mcpInputSchema;
  if (isJsonSchemaObject(mcpSchema)) return mcpSchema;

  const requiredInputs = descriptor.requiredInputs ?? [];
  return {
    type: "object",
    properties: Object.fromEntries(requiredInputs.map((input) => [
      input.name,
      requiredInputSchema(input),
    ])),
    required: requiredInputs.map((input) => input.name),
    additionalProperties: true,
  };
}

function requiredInputSchema(input: ToolRequiredInput): JsonSchema {
  const scalarType = input.type.replace("[]", "");
  const scalarSchema: Record<string, unknown> = {
    type: scalarType === "number" ? "number" : scalarType,
  };
  if (input.nonEmpty && scalarType === "string") scalarSchema.minLength = 1;
  if (!input.type.endsWith("[]")) return scalarSchema;
  return {
    type: "array",
    items: scalarSchema,
    ...(input.nonEmpty ? { minItems: 1 } : {}),
  };
}

function isJsonSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "object";
}
