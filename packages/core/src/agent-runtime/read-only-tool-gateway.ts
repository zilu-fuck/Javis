import {
  sanitizeMcpInputSchema,
  validateMcpInput,
  validateToolSchema,
  type PermissionLevel,
  type ToolDescriptor,
} from "@javis/tools";
import type {
  AgentKind,
  ToolExecutionGateway,
  ToolExecutionResult,
} from "../index";

export interface ReadOnlyToolGatewayOptions {
  descriptors: readonly ToolDescriptor[];
  getAllowedToolNames(agentKind: AgentKind): readonly string[];
  dispatch(request: {
    taskId: string;
    runId: string;
    agentKind: AgentKind;
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export type MigratedAgentRuntimePermissionLevel = Extract<
  PermissionLevel,
  "read" | "preview"
>;

export interface ScopedToolGatewayOptions extends ReadOnlyToolGatewayOptions {
  allowedPermissionLevels: readonly MigratedAgentRuntimePermissionLevel[];
}

export function createReadOnlyToolExecutionGateway(
  options: ReadOnlyToolGatewayOptions,
): ToolExecutionGateway {
  return createScopedToolExecutionGateway({
    ...options,
    allowedPermissionLevels: ["read"],
  });
}

export function createScopedToolExecutionGateway(
  options: ScopedToolGatewayOptions,
): ToolExecutionGateway {
  const descriptors = new Map(options.descriptors.map((descriptor) => [
    descriptor.name,
    descriptor,
  ]));
  const allowedPermissionLevels = new Set(options.allowedPermissionLevels);

  return {
    async execute(request): Promise<ToolExecutionResult> {
      if (request.signal?.aborted) {
        return { status: "error", reason: "Tool execution was cancelled." };
      }
      const descriptor = descriptors.get(request.toolName);
      if (!descriptor) {
        return { status: "error", reason: `Tool ${request.toolName} is not registered.` };
      }
      if (!descriptor.ownerAgentKinds.includes(request.agentKind)) {
        return {
          status: "error",
          reason: `Agent ${request.agentKind} does not own tool ${request.toolName}.`,
        };
      }
      if (!options.getAllowedToolNames(request.agentKind).includes(request.toolName)) {
        return {
          status: "error",
          reason: `Tool ${request.toolName} is outside the Agent allowlist.`,
        };
      }
      if (descriptor.permissionLevel === "confirmed_write" ||
        descriptor.permissionLevel === "dangerous") {
        return {
          status: "error",
          reason: `Agent runtime never permits ${descriptor.permissionLevel} tool ${request.toolName}.`,
        };
      }
      if (!allowedPermissionLevels.has(
        descriptor.permissionLevel as MigratedAgentRuntimePermissionLevel,
      )) {
        return {
          status: "error",
          reason: `Agent runtime does not permit ${descriptor.permissionLevel} tool ${request.toolName}.`,
        };
      }
      const inputError = validateRequiredInputs(descriptor, request.input);
      if (inputError) return { status: "error", reason: inputError };
      if (descriptor.inputSchema) {
        const schemaError = validateToolSchema(
          descriptor.inputSchema,
          request.input,
          `Tool ${descriptor.name} input`,
        );
        if (schemaError) return { status: "error", reason: schemaError };
      }
      if (descriptor.metadata?.mcpInputSchema !== undefined) {
        const schema = sanitizeMcpInputSchema(descriptor.metadata.mcpInputSchema);
        if (!schema) {
          return { status: "error", reason: `Tool ${descriptor.name} has an invalid input schema.` };
        }
        const schemaError = validateMcpInput(schema, request.input);
        if (schemaError) return { status: "error", reason: schemaError };
      }
      try {
        const output = await options.dispatch(request);
        return { status: "success", output };
      } catch (error) {
        return {
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function validateRequiredInputs(
  descriptor: ToolDescriptor,
  input: Record<string, unknown>,
): string | undefined {
  for (const required of descriptor.requiredInputs ?? []) {
    const value = input[required.name];
    const valid = required.type === "string"
      ? typeof value === "string" && (!required.nonEmpty || value.trim().length > 0)
      : required.type === "string[]"
        ? Array.isArray(value) && value.every((item) => typeof item === "string") &&
          (!required.nonEmpty || value.length > 0)
        : required.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : required.type === "number[]"
            ? Array.isArray(value) && value.every((item) =>
              typeof item === "number" && Number.isFinite(item)) &&
              (!required.nonEmpty || value.length > 0)
            : required.type === "boolean"
              ? typeof value === "boolean"
              : required.type === "boolean[]"
                ? Array.isArray(value) && value.every((item) => typeof item === "boolean") &&
                  (!required.nonEmpty || value.length > 0)
                : required.type === "object"
                  ? isRecord(value)
                  : Array.isArray(value) && value.every(isRecord) &&
                    (!required.nonEmpty || value.length > 0);
    if (!valid) {
      return `Tool ${descriptor.name} requires input.${required.name} to match type ${required.type}.`;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
