const MODEL_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_MODEL_TOOL_NAME_CHARS = 64;

export interface ToolNameAliasMap {
  toModelName(canonicalName: string): string;
  toCanonicalName(modelName: string): string;
}

export function canonicalToolNameToModelAlias(canonicalName: string): string {
  const segments = canonicalName.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid canonical tool name: ${canonicalName}`);
  }
  const rawAlias = segments
    .map((segment) => segment
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase())
    .join("__");
  if (!MODEL_TOOL_NAME_PATTERN.test(rawAlias)) {
    throw new Error(`Tool name cannot be represented as a provider alias: ${canonicalName}`);
  }
  if (rawAlias.length <= MAX_MODEL_TOOL_NAME_CHARS) return rawAlias;
  const suffix = fnv1a(canonicalName);
  return `${rawAlias.slice(0, MAX_MODEL_TOOL_NAME_CHARS - suffix.length - 1)}_${suffix}`;
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createToolNameAliasMap(canonicalNames: readonly string[]): ToolNameAliasMap {
  const canonicalToModel = new Map<string, string>();
  const modelToCanonical = new Map<string, string>();
  for (const canonicalName of canonicalNames) {
    if (canonicalToModel.has(canonicalName)) {
      throw new Error(`Duplicate canonical tool name: ${canonicalName}`);
    }
    const modelName = canonicalToolNameToModelAlias(canonicalName);
    const existing = modelToCanonical.get(modelName);
    if (existing) {
      throw new Error(`Tool alias collision: ${existing} and ${canonicalName} both map to ${modelName}`);
    }
    canonicalToModel.set(canonicalName, modelName);
    modelToCanonical.set(modelName, canonicalName);
  }

  return {
    toModelName(canonicalName) {
      const modelName = canonicalToModel.get(canonicalName);
      if (!modelName) throw new Error(`Unknown canonical tool name: ${canonicalName}`);
      return modelName;
    },
    toCanonicalName(modelName) {
      const canonicalName = modelToCanonical.get(modelName);
      if (!canonicalName) throw new Error(`Unknown model tool name: ${modelName}`);
      return canonicalName;
    },
  };
}
