import type { ToolJsonSchema } from "./types";

/** Return a stable error message when a value does not satisfy a tool schema. */
export function validateToolSchema(
  schema: ToolJsonSchema,
  value: unknown,
  label = "Tool input",
): string | undefined {
  return validateSchemaValue(schema, value, label);
}

function validateSchemaValue(
  schema: ToolJsonSchema,
  value: unknown,
  label: string,
): string | undefined {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return `${label} must be one of the declared values.`;
  }

  const typeError = validateType(schema.type, value, label);
  if (typeError) return typeError;

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${label} must contain at least ${schema.minLength} character(s).`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${label} must contain at most ${schema.maxLength} character(s).`;
    }
    if (schema.pattern !== undefined) {
      let matches = false;
      try {
        matches = new RegExp(schema.pattern, "u").test(value);
      } catch {
        return `${label} declares an invalid string pattern.`;
      }
      if (!matches) return `${label} must match the declared string pattern.`;
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${label} must be greater than or equal to ${schema.minimum}.`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${label} must be less than or equal to ${schema.maximum}.`;
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${label} must contain at least ${schema.minItems} item(s).`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${label} must contain at most ${schema.maxItems} item(s).`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const itemError = validateSchemaValue(schema.items, value[index], `${label}[${index}]`);
        if (itemError) return itemError;
      }
    }
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const requiredName of schema.required ?? []) {
      if (!hasOwn(value, requiredName) || value[requiredName] === undefined) {
        return `${label} is missing required field "${requiredName}".`;
      }
    }
    if (schema.additionalProperties === false) {
      for (const fieldName of Object.keys(value)) {
        if (!hasOwn(properties, fieldName)) {
          return `${label} contains an undeclared field: ${fieldName}.`;
        }
      }
    }
    for (const [fieldName, propertySchema] of Object.entries(properties)) {
      if (!hasOwn(value, fieldName) || value[fieldName] === undefined) continue;
      const propertyError = validateSchemaValue(
        propertySchema,
        value[fieldName],
        `${label}.${fieldName}`,
      );
      if (propertyError) return propertyError;
    }
  }

  return undefined;
}

function validateType(
  type: ToolJsonSchema["type"],
  value: unknown,
  label: string,
): string | undefined {
  if (!type) return undefined;
  const valid = type === "object"
    ? isRecord(value)
    : type === "array"
      ? Array.isArray(value)
      : type === "string"
        ? typeof value === "string"
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : typeof value === "boolean";
  return valid ? undefined : `${label} must be a ${type}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
