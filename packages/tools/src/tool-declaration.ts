import type { PermissionLevel, ToolDescriptor, ToolJsonSchema } from "./types";

/**
 * Tool registry protocol (B3).
 *
 * Builtin tools are declared in `descriptors.ts`; this module is what makes a tool
 * *declarable* from `.javis` configuration and what keeps a declaration from
 * quietly weakening the build.
 *
 * The rule that matters most: **a configuration layer may tighten a permission
 * level but never loosen it.** A project that could turn `confirmed_write` into
 * `read` would bypass the native approval boundary from a checked-in file, so it is
 * rejected at parse time with a diagnostic rather than honoured.
 */

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/u;
const CAPABILITY_TAG_PATTERN = /^[a-z][a-z0-9_]*$/u;

export interface ToolDeclarationInput {
  name: string;
  summary?: string;
  permissionLevel?: PermissionLevel;
  writeRiskLevel?: ToolDescriptor["writeRiskLevel"];
  capabilityTags?: string[];
  ownerAgentKinds?: string[];
  inputSchema?: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;
  limits?: ToolDescriptor["limits"];
  requiredPlanIntent?: ToolDescriptor["requiredPlanIntent"];
  metadata?: Record<string, unknown>;
  /** Config-only: remove a builtin tool. */
  disabled?: boolean;
}

export interface ToolDeclarationDiagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export type ToolDeclarationBase = Pick<
  ToolDescriptor,
  "name" | "permissionLevel" | "summary" | "capabilityTags" | "ownerAgentKinds"
> & Partial<ToolDescriptor>;

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  read: 0,
  preview: 1,
  confirmed_write: 2,
  dangerous: 3,
};

/** Higher number means more privileged (less restricted). */
export function permissionRank(level: PermissionLevel): number {
  return PERMISSION_ORDER[level];
}

/**
 * True when `to` is a *less* restricted level than `from`.
 *
 * Tightening (read → confirmed_write) is fine for a configuration layer; relaxing
 * (confirmed_write → read) would bypass the native approval boundary from a
 * checked-in file, so it is refused.
 */
export function isPermissionRelaxation(
  from: PermissionLevel,
  to: PermissionLevel,
): boolean {
  return permissionRank(to) < permissionRank(from);
}

export function isToolNameWellFormed(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

function validateSchema(
  schema: ToolJsonSchema,
  path: string,
  diagnostics: ToolDeclarationDiagnostic[],
): void {
  if (schema.type === undefined && schema.enum === undefined && schema.properties === undefined) {
    diagnostics.push({
      severity: "warning",
      path,
      message: "schema declares neither type, enum nor properties; it validates nothing.",
    });
  }
  if (schema.type === "array" && schema.items === undefined) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.items`,
      message: "array schema without items accepts any element shape.",
    });
  }
  if (schema.type === "object") {
    for (const required of schema.required ?? []) {
      if (schema.properties !== undefined && !Object.prototype.hasOwnProperty.call(schema.properties, required)) {
        diagnostics.push({
          severity: "error",
          path: `${path}.required`,
          message: `required field "${required}" is not declared in properties.`,
        });
      }
    }
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      diagnostics.push({
        severity: "error",
        path: `${path}.pattern`,
        message: `pattern "${schema.pattern}" is not a valid regular expression.`,
      });
    }
  }
}

/**
 * Validates a declaration on its own, before any base descriptor is involved.
 */
export function validateToolDeclaration(
  declaration: ToolDeclarationInput,
  path = "tools[0]",
): { descriptor?: ToolDescriptor; diagnostics: ToolDeclarationDiagnostic[] } {
  const diagnostics: ToolDeclarationDiagnostic[] = [];

  if (!isToolNameWellFormed(declaration.name)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: `tool name must follow the {category}.{action} pattern, for example "code.searchRepository".`,
    });
    return { diagnostics };
  }
  // Whether a missing permission level is worth flagging depends on whether the
  // tool already exists, which only the merge step knows.
  for (const [index, tag] of (declaration.capabilityTags ?? []).entries()) {
    if (!CAPABILITY_TAG_PATTERN.test(tag)) {
      diagnostics.push({
        severity: "error",
        path: `${path}.capabilityTags[${index}]`,
        message: `capability tag "${tag}" must be lower_snake_case.`,
      });
    }
  }
  if (declaration.inputSchema) {
    validateSchema(declaration.inputSchema, `${path}.inputSchema`, diagnostics);
  }
  if (declaration.outputSchema) {
    validateSchema(declaration.outputSchema, `${path}.outputSchema`, diagnostics);
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }

  return {
    descriptor: {
      name: declaration.name,
      permissionLevel: declaration.permissionLevel ?? "read",
      summary: declaration.summary ?? declaration.name,
      capabilityTags: [...(declaration.capabilityTags ?? [])],
      ownerAgentKinds: [...(declaration.ownerAgentKinds ?? [])],
      ...(declaration.writeRiskLevel !== undefined ? { writeRiskLevel: declaration.writeRiskLevel } : {}),
      ...(declaration.inputSchema !== undefined ? { inputSchema: declaration.inputSchema } : {}),
      ...(declaration.outputSchema !== undefined ? { outputSchema: declaration.outputSchema } : {}),
      ...(declaration.limits !== undefined ? { limits: declaration.limits } : {}),
      ...(declaration.requiredPlanIntent !== undefined
        ? { requiredPlanIntent: declaration.requiredPlanIntent }
        : {}),
      ...(declaration.metadata !== undefined ? { metadata: declaration.metadata } : {}),
    },
    diagnostics,
  };
}

export interface MergeToolDeclarationsResult {
  descriptors: ToolDescriptor[];
  /** Names a declaration removed from the base set. */
  disabledNames: string[];
  /** Names created by a declaration. */
  addedNames: string[];
  /** Names a declaration overrode. */
  overriddenNames: string[];
  diagnostics: ToolDeclarationDiagnostic[];
}

/**
 * Applies declarations on top of the builtin descriptors.
 *
 * Fields merge shallowly (a declaration replaces only what it states), except for
 * `capabilityTags` / `ownerAgentKinds`, which are replaced wholesale when provided:
 * a project narrowing a tool's owners must not have the builtin owners re-added.
 */
export function mergeToolDeclarations(
  baseDescriptors: readonly ToolDescriptor[],
  declarations: readonly ToolDeclarationInput[],
): MergeToolDeclarationsResult {
  const byName = new Map<string, ToolDescriptor>();
  for (const descriptor of baseDescriptors) {
    byName.set(descriptor.name, { ...descriptor });
  }

  const disabledNames: string[] = [];
  const addedNames: string[] = [];
  const overriddenNames: string[] = [];
  const diagnostics: ToolDeclarationDiagnostic[] = [];

  declarations.forEach((declaration, index) => {
    const path = `tools[${index}]`;
    const validated = validateToolDeclaration(declaration, path);
    diagnostics.push(...validated.diagnostics);
    if (!validated.descriptor) {
      return;
    }
    const incoming = validated.descriptor;
    const base = byName.get(incoming.name);

    if (declaration.disabled === true) {
      if (!base) {
        diagnostics.push({
          severity: "warning",
          path,
          message: `cannot disable "${incoming.name}": no such tool in this build.`,
        });
        return;
      }
      byName.delete(incoming.name);
      disabledNames.push(incoming.name);
      return;
    }

    if (!base) {
      if (declaration.permissionLevel === undefined) {
        diagnostics.push({
          severity: "warning",
          path: `${path}.permissionLevel`,
          message: `new tool "${incoming.name}" declares no permission level; it defaults to "read".`,
        });
      }
      byName.set(incoming.name, incoming);
      addedNames.push(incoming.name);
      return;
    }

    if (declaration.permissionLevel !== undefined
      && isPermissionRelaxation(base.permissionLevel, declaration.permissionLevel)) {
      diagnostics.push({
        severity: "error",
        path: `${path}.permissionLevel`,
        message: `refusing to lower "${incoming.name}" from ${base.permissionLevel} to `
          + `${declaration.permissionLevel}: a configuration layer may tighten a permission level, never loosen it.`,
      });
      return;
    }

    byName.set(incoming.name, {
      ...base,
      ...incoming,
      // Keep the builtin level when the declaration omits one.
      permissionLevel: declaration.permissionLevel ?? base.permissionLevel,
      capabilityTags: declaration.capabilityTags !== undefined
        ? [...declaration.capabilityTags]
        : [...base.capabilityTags],
      ownerAgentKinds: declaration.ownerAgentKinds !== undefined
        ? [...declaration.ownerAgentKinds]
        : [...base.ownerAgentKinds],
    });
    overriddenNames.push(incoming.name);
  });

  return {
    descriptors: [...byName.values()],
    disabledNames,
    addedNames,
    overriddenNames,
    diagnostics,
  };
}
