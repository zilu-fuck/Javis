import type { ToolJsonSchema } from "./types";

/** Return a stable error message when a value does not satisfy a tool schema. */
export function validateToolSchema(
  schema: ToolJsonSchema,
  value: unknown,
  label = "Tool input",
): string | undefined {
  return validateSchemaValue(schema, value, label);
}

export const DEFAULT_MAX_DROPPED_ITEMS = 20;
export const DEFAULT_MAX_DROPPED_RATIO = 0.1;

export interface ToolSchemaRepairOptions {
  /** Upper bound on invalid array items that may be dropped before failing. */
  maxDroppedItems?: number;
  /** Upper bound on the fraction of an array that may be dropped before failing. */
  maxDroppedRatio?: number;
  /** Set false to keep coercion but never drop invalid array items. */
  pruneInvalidArrayItems?: boolean;
}

export interface ToolSchemaRepairResult {
  /** True when the (possibly repaired) value satisfies the schema. */
  ok: boolean;
  /** The repaired value: coerced fields, with bounded invalid array items removed. */
  value: unknown;
  /** Validation message for the repaired value when `ok` is false. */
  error?: string;
  /** Deterministic notes describing every coercion and drop. */
  repairs: string[];
}

/**
 * Repairs a tool payload against its own schema before validation.
 *
 * Tool *output* is produced by implementations, not by the model, so a single
 * mistyped field in one array item must not fail a whole task. Before this,
 * `code.searchRepository output.actualFound[27].line must be a integer.` and
 * `code.inspectWorkspace output.entries[0].sizeBytes must be a number.` each
 * aborted a run.
 *
 * Two bounded repairs are applied, and nothing else:
 *
 * 1. **coercion** — a value is converted only when the schema names a scalar type
 *    and the conversion is unambiguous (`"27"` for `integer`, `3` for `string`,
 *    `"true"` for `boolean`), plus `null` for an optional declared field is
 *    dropped. An `enum` is never coerced.
 * 2. **array item pruning** — invalid items are dropped only from the top-level
 *    array or from top-level array properties, and only while the count stays
 *    within `maxDroppedItems` and `maxDroppedRatio`. Beyond that the payload is
 *    reported as invalid, because that means the shape is wrong rather than one
 *    item being dirty.
 *
 * Undeclared fields, missing required fields, wrong container types and every
 * other violation still fail: this narrows no safety property, it only stops a
 * stray scalar from being fatal.
 */
export function repairToolSchemaValue(
  schema: ToolJsonSchema,
  value: unknown,
  options: ToolSchemaRepairOptions = {},
  label = "Tool output",
): ToolSchemaRepairResult {
  const repairs: string[] = [];
  const coerced = coerceSchemaValue(schema, value, label, repairs);

  const directError = validateSchemaValue(schema, coerced, label);
  if (!directError) {
    // Preserve the caller's object identity when nothing needed repairing: step
    // outputs are hashed, referenced and mutated by artifact/provenance checks,
    // and copying them unconditionally would both cost real memory and hide a
    // post-write mutation from the hash comparison.
    return { ok: true, value: repairs.length === 0 ? value : coerced, repairs };
  }

  if (options.pruneInvalidArrayItems === false) {
    return { ok: false, value: coerced, error: directError, repairs };
  }

  const pruned = pruneInvalidArrayItems(schema, coerced, label, repairs, {
    maxDroppedItems: options.maxDroppedItems ?? DEFAULT_MAX_DROPPED_ITEMS,
    maxDroppedRatio: options.maxDroppedRatio ?? DEFAULT_MAX_DROPPED_RATIO,
  });
  if (pruned === undefined) {
    return { ok: false, value: coerced, error: directError, repairs };
  }

  const prunedError = validateSchemaValue(schema, pruned, label);
  if (prunedError) {
    return { ok: false, value: coerced, error: prunedError, repairs };
  }
  return { ok: true, value: pruned, repairs };
}

interface PruneBounds {
  maxDroppedItems: number;
  maxDroppedRatio: number;
}

function withinPruneBounds(total: number, dropped: number, bounds: PruneBounds): boolean {
  if (dropped === 0) return false;
  if (dropped > bounds.maxDroppedItems) return false;
  return dropped / Math.max(1, total) <= bounds.maxDroppedRatio;
}

function pruneArrayAgainstSchema(
  itemsSchema: ToolJsonSchema | undefined,
  items: unknown[],
  label: string,
  repairs: string[],
  bounds: PruneBounds,
): unknown[] | undefined {
  if (!itemsSchema) return undefined;
  const kept: unknown[] = [];
  let dropped = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (validateSchemaValue(itemsSchema, items[index], `${label}[${index}]`) === undefined) {
      kept.push(items[index]);
    } else {
      dropped += 1;
    }
  }
  if (!withinPruneBounds(items.length, dropped, bounds)) return undefined;
  repairs.push(`${label}: dropped ${dropped} of ${items.length} invalid item(s)`);
  return kept;
}

function pruneInvalidArrayItems(
  schema: ToolJsonSchema,
  value: unknown,
  label: string,
  repairs: string[],
  bounds: PruneBounds,
): unknown | undefined {
  if (Array.isArray(value)) {
    if (schema.items === undefined) return undefined;
    return pruneArrayAgainstSchema(schema.items, value, label, repairs, bounds);
  }
  if (!isRecord(value)) return undefined;

  const properties = schema.properties ?? {};
  let changed = false;
  const copy: Record<string, unknown> = { ...value };
  for (const [fieldName, propertySchema] of Object.entries(properties)) {
    const propertyValue = copy[fieldName];
    if (propertyValue === undefined) continue;
    const isArrayProperty = propertySchema.type === "array" || propertySchema.items !== undefined;
    if (!isArrayProperty || !Array.isArray(propertyValue)) continue;
    const prunedItems = pruneArrayAgainstSchema(
      propertySchema.items,
      propertyValue,
      `${label}.${fieldName}`,
      repairs,
      bounds,
    );
    if (prunedItems === undefined) return undefined;
    copy[fieldName] = prunedItems;
    changed = true;
  }
  return changed ? copy : undefined;
}

function coerceSchemaValue(
  schema: ToolJsonSchema,
  value: unknown,
  label: string,
  repairs: string[],
): unknown {
  // Declared enums are exact values; coercing into them would invent intent.
  if (schema.enum) return value;

  const targetType = typeof schema.type === "string" ? schema.type : undefined;

  if (targetType === "integer" || targetType === "number") {
    const coerced = coerceNumber(value, targetType === "integer");
    if (coerced !== undefined) {
      repairs.push(`${label}: coerced ${describeValue(value)} to ${targetType}`);
      return coerced;
    }
    return value;
  }

  if (targetType === "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      repairs.push(`${label}: coerced number to string`);
      return String(value);
    }
    if (typeof value === "boolean") {
      repairs.push(`${label}: coerced boolean to string`);
      return String(value);
    }
    return value;
  }

  if (targetType === "boolean") {
    if (value === "true") {
      repairs.push(`${label}: coerced "true" to boolean`);
      return true;
    }
    if (value === "false") {
      repairs.push(`${label}: coerced "false" to boolean`);
      return false;
    }
    return value;
  }

  if (targetType === "array" && Array.isArray(value) && schema.items) {
    return value.map((item, index) =>
      coerceSchemaValue(schema.items as ToolJsonSchema, item, `${label}[${index}]`, repairs));
  }

  if ((targetType === "object" || schema.properties !== undefined) && isRecord(value)) {
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    const copy: Record<string, unknown> = { ...value };
    for (const [fieldName, propertySchema] of Object.entries(properties)) {
      if (!hasOwn(copy, fieldName)) continue;
      const propertyValue = copy[fieldName];
      if ((propertyValue === null || propertyValue === undefined) && !required.has(fieldName)) {
        delete copy[fieldName];
        repairs.push(`${label}.${fieldName}: dropped null for an optional field`);
        continue;
      }
      copy[fieldName] = coerceSchemaValue(
        propertySchema,
        propertyValue,
        `${label}.${fieldName}`,
        repairs,
      );
    }
    return copy;
  }

  return value;
}

function coerceNumber(value: unknown, requireInteger: boolean): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  if (requireInteger && !Number.isInteger(parsed)) return undefined;
  return parsed;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value;
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
