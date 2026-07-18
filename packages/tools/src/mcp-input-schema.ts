/**
 * Small, data-only subset of JSON Schema used for MCP tool arguments.
 * Server-provided schemas are untrusted, so values are sanitized and bounded
 * before they are persisted, shown to a model, or used for validation.
 */
export interface McpInputSchema {
  type: "object";
  required: string[];
  properties: Record<string, McpInputPropertySchema>;
  /** Only false is accepted; unknown nested fields fail closed by default. */
  additionalProperties?: false;
}

export interface McpInputPropertySchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  enum?: Array<string | number | boolean | null>;
  items?: McpInputPropertySchema;
  properties?: Record<string, McpInputPropertySchema>;
  required?: string[];
  /** Only false is accepted; schema-valued/true additionalProperties are rejected. */
  additionalProperties?: false;
}

const MAX_PROPERTIES = 32;
const MAX_REQUIRED = 32;
const MAX_ENUM_VALUES = 32;
const MAX_SCHEMA_DEPTH = 8;

export function sanitizeMcpInputSchema(value: unknown): McpInputSchema | undefined {
  if (!isRecord(value) || value.type !== "object") return undefined;
  return sanitizeMcpObjectSchema(value, 0, true);
}

/** Return an error string when arguments do not satisfy a sanitized schema. */
export function validateMcpInput(
  schema: McpInputSchema | undefined,
  value: unknown,
): string | undefined {
  if (!isRecord(value) || Array.isArray(value)) {
    return "MCP arguments must be a JSON object.";
  }
  if (!schema) return undefined;

  return validateMcpObject(schema, value, "MCP arguments");
}

function sanitizeMcpObjectSchema(
  value: Record<string, unknown>,
  depth: number,
  requireProperties: boolean,
): McpInputSchema | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return undefined;
  if (hasUnsupportedMcpSchemaKeys(value, [
    "type", "properties", "required", "additionalProperties", "description", "title", "$schema", "$id", "examples",
  ])) return undefined;
  const rawProperties = value.properties;
  if (rawProperties === undefined && requireProperties) return undefined;
  if (rawProperties !== undefined && !isRecord(rawProperties)) return undefined;
  const properties = sanitizeMcpProperties(rawProperties as Record<string, unknown> | undefined, depth);
  if (!properties) return undefined;
  const required = sanitizeMcpRequired(value.required, properties);
  if (!required) return undefined;
  const additionalProperties = sanitizeMcpAdditionalProperties(value.additionalProperties);
  if (additionalProperties === undefined && value.additionalProperties !== undefined) return undefined;
  return {
    type: "object",
    required,
    properties,
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

function sanitizeMcpProperties(
  rawProperties: Record<string, unknown> | undefined,
  depth: number,
): Record<string, McpInputPropertySchema> | undefined {
  const entries = Object.entries(rawProperties ?? {});
  if (entries.length > MAX_PROPERTIES) return undefined;
  const properties = Object.create(null) as Record<string, McpInputPropertySchema>;
  for (const [name, raw] of entries) {
    if (!isSafeFieldName(name) || !isRecord(raw)) return undefined;
    const property = sanitizeMcpPropertySchema(raw, depth + 1);
    if (!property) return undefined;
    properties[name] = property;
  }
  return properties;
}

function sanitizeMcpRequired(
  value: unknown,
  properties: Record<string, McpInputPropertySchema>,
): string[] | undefined {
  if (value !== undefined && !Array.isArray(value)) return undefined;
  const rawRequired = (value ?? []) as unknown[];
  if (
    rawRequired.length > MAX_REQUIRED ||
    rawRequired.some((name) =>
      typeof name !== "string" ||
      !isSafeFieldName(name) ||
      !hasOwnRecordKey(properties, name)
    )
  ) {
    return undefined;
  }
  return rawRequired as string[];
}

function sanitizeMcpAdditionalProperties(value: unknown): false | undefined {
  if (value === undefined || value === false) return value;
  // Schema-valued and true additionalProperties are intentionally unsupported:
  // accepting them would turn unknown fields into an unbounded input surface.
  return undefined;
}

function sanitizeMcpPropertySchema(
  value: Record<string, unknown>,
  depth: number,
): McpInputPropertySchema | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return undefined;
  if (hasUnsupportedMcpSchemaKeys(value, [
    "type", "enum", "items", "properties", "required", "additionalProperties", "description", "title", "$schema", "$id", "examples",
  ])) return undefined;
  const property: McpInputPropertySchema = {};
  if (value.type !== undefined) {
    if (!isPropertyType(value.type)) return undefined;
    property.type = value.type;
  }
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      value.enum.length > MAX_ENUM_VALUES ||
      !value.enum.every(isAllowedEnumValue)
    ) {
      return undefined;
    }
    property.enum = [...value.enum];
  }
  if (!property.type && !property.enum) return undefined;
  if (property.type === "array") {
    if (!isRecord(value.items)) return undefined;
    const items = sanitizeMcpPropertySchema(value.items, depth + 1);
    if (!items) return undefined;
    property.items = items;
  } else if (value.items !== undefined) {
    return undefined;
  }
  if (property.type === "object") {
    const objectSchema = sanitizeMcpObjectSchema(value, depth, false);
    if (!objectSchema || !objectSchema.properties) return undefined;
    property.properties = objectSchema.properties;
    property.required = objectSchema.required;
    if (objectSchema.additionalProperties !== undefined) {
      property.additionalProperties = objectSchema.additionalProperties;
    }
  } else if (
    value.properties !== undefined ||
    value.required !== undefined ||
    value.additionalProperties !== undefined
  ) {
    return undefined;
  }
  return property;
}

function validateMcpObject(
  schema: Pick<McpInputSchema, "properties" | "required" | "additionalProperties"> | McpInputPropertySchema,
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const properties = schema.properties ?? {};
  for (const fieldName of Object.keys(value)) {
    if (!hasOwnRecordKey(properties, fieldName)) {
      return `${name} contain an undeclared field: ${fieldName}`;
    }
  }
  for (const requiredName of schema.required ?? []) {
    if (!hasOwnRecordKey(value, requiredName) || value[requiredName] === undefined) {
      return `${name} are missing required field "${requiredName}".`;
    }
  }
  for (const [fieldName, property] of Object.entries(properties)) {
    if (!(fieldName in value) || value[fieldName] === undefined) continue;
    const error = validateMcpProperty(property, value[fieldName], `${name}.${fieldName}`);
    if (error) return error;
  }
  return undefined;
}

function validateMcpProperty(
  schema: McpInputPropertySchema,
  value: unknown,
  name: string,
): string | undefined {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return `MCP argument "${name}" is not one of the allowed values.`;
  }
  if (!schema.type) return undefined;
  const valid = schema.type === "string"
    ? typeof value === "string"
    : schema.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : schema.type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : schema.type === "boolean"
          ? typeof value === "boolean"
          : schema.type === "object"
            ? isRecord(value) && !Array.isArray(value)
            : Array.isArray(value);
  if (!valid) return `MCP argument "${name}" must be a ${schema.type}.`;
  if (schema.type === "object" && isRecord(value) && !Array.isArray(value)) {
    return validateMcpObject(schema, value, name);
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (const item of value) {
      const itemError = validateMcpProperty(schema.items, item, `${name}[]`);
      if (itemError) return itemError;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeFieldName(value: string): boolean {
  return value.length > 0 &&
    value.length <= 120 &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor" &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasOwnRecordKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasUnsupportedMcpSchemaKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).some((key) => !allowedKeys.has(key));
}

function isPropertyType(value: unknown): value is NonNullable<McpInputPropertySchema["type"]> {
  return value === "string" || value === "number" || value === "integer" ||
    value === "boolean" || value === "object" || value === "array";
}

function isAllowedEnumValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}
