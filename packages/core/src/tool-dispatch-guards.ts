/**
 * Tool dispatch guards (B4/G2).
 *
 * Every tool invocation in the runtime passes through this boundary, and these checks
 * previously lived inside `workflow-executor.ts` — a file that had grown past 15,000
 * lines, where a guard that fails closed is exactly the kind of code that must not be
 * hard to find or to test.
 *
 * The extracted unit is cohesive: it is *the* answer to "may this input be dispatched,
 * and may this output be accepted?". Behaviour is unchanged; the functions were moved
 * verbatim.
 *
 * Two invariants worth stating explicitly, because they are the reason this module
 * exists rather than being inlined at call sites:
 *
 *  * input validation fails **closed** — a schema violation, a missing required field
 *    or an oversized payload throws instead of dispatching a best-effort call;
 *  * output validation **repairs the bounded, mechanical problems** (a numeric string
 *    where a number was declared) and reports the repair, rather than failing a task
 *    that otherwise succeeded.
 */
import type { ToolDescriptor } from "@javis/tools";
import { repairToolSchemaValue, validateToolSchema } from "@javis/tools";
import {
  appendContextToolOutputRepairs,
  recordToolOutputRepair,
} from "./tool-output-repairs";
import { appendContextHookNotices, evaluateHooks } from "./config/hooks";

/** Defense-in-depth validation for plans that reach runtime with mutated context. */
export function validateToolDescriptorInputs(
  descriptor: Pick<ToolDescriptor, "name" | "inputSchema" | "limits" | "requiredInputs">,
  input: Record<string, unknown>,
): void {
  // Preserve the more actionable, path/command-specific guards used by the
  // concrete dispatcher while still validating every other descriptor here.
  if (descriptor.name === "shell.runReadOnlyCommand") {
    assertRequiredShellReadOnlyInput(input);
  }
  if (descriptor.name === "computer.listDirectory" || descriptor.name === "computer.openPath") {
    assertRequiredComputerPathInput(descriptor.name, input);
  }
  if (descriptor.inputSchema) {
    const schemaError = validateToolSchema(
      descriptor.inputSchema,
      input,
      `Tool ${descriptor.name} input`,
    );
    if (schemaError) throw new Error(schemaError);
  }
  validateToolPayloadSize(
    descriptor.name,
    "input",
    input,
    descriptor.limits?.maxInputBytes,
  );
  for (const required of descriptor.requiredInputs ?? []) {
    const value = input[required.name];
    const valid = required.type === "string"
      ? typeof value === "string" && (!required.nonEmpty || value.trim().length > 0)
      : required.type === "string[]"
        ? Array.isArray(value) && value.every((item) => typeof item === "string") &&
          (!required.nonEmpty || (value.length > 0 && value.every((item) => item.trim().length > 0)))
        : required.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : required.type === "number[]"
            ? Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
              (!required.nonEmpty || value.length > 0)
            : required.type === "boolean"
              ? typeof value === "boolean"
              : required.type === "boolean[]"
                ? Array.isArray(value) && value.every((item) => typeof item === "boolean") &&
                  (!required.nonEmpty || value.length > 0)
                : required.type === "object"
                  ? typeof value === "object" && value !== null && !Array.isArray(value)
                  : Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item)) &&
                    (!required.nonEmpty || value.length > 0);
    if (!valid) {
      throw new Error(
        `Tool ${descriptor.name} requires input.${required.name} to match type ${required.type}${required.nonEmpty ? " (non-empty)" : ""}.`,
      );
    }
  }
}

export function validateToolDescriptorOutput(
  descriptor: Pick<ToolDescriptor, "name" | "limits" | "outputSchema">,
  output: unknown,
): { output: unknown; repairs: string[] } {
  let resolvedOutput = output;
  let repairs: string[] = [];
  if (descriptor.outputSchema) {
    const repair = repairToolSchemaValue(
      descriptor.outputSchema,
      output,
      {},
      `Tool ${descriptor.name} output`,
    );
    if (!repair.ok) {
      throw new Error(repair.error ?? `Tool ${descriptor.name} output failed schema validation.`);
    }
    repairs = repair.repairs;
    if (repairs.length > 0) {
      console.warn(
        `[tool-schema] ${descriptor.name} output repaired: ${repairs.join("; ")}`,
      );
    }
    resolvedOutput = repair.value;
  }
  validateToolPayloadSize(
    descriptor.name,
    "output",
    resolvedOutput,
    descriptor.limits?.maxOutputBytes,
  );
  return { output: resolvedOutput, repairs };
}

/**
 * Records a repaired tool output (A4b) so it is visible and countable instead of
 * only appearing in the console.
 */
export function recordToolOutputRepairForStep(input: {
  toolName: string;
  repairs: string[];
  step?: { id: string };
  context?: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void; taskId?: string };
}): void {
  if (input.repairs.length === 0) {
    return;
  }
  const taskId = (input.context as { taskId?: string } | undefined)?.taskId;
  recordToolOutputRepair({
    toolName: input.toolName,
    ...(typeof taskId === "string" ? { taskId } : {}),
    ...(input.step ? { stepId: input.step.id } : {}),
    repairs: input.repairs,
  });
  if (input.context) {
    appendContextToolOutputRepairs(input.context, {
      ...(input.step ? { stepId: input.step.id } : {}),
      toolName: input.toolName,
      repairs: input.repairs,
    });
  }
  // C4: `afterToolCall` annotations/notices ride with the task artifacts too.
  const hookDecision = evaluateHooks({
    phase: "afterToolCall",
    toolName: input.toolName,
    ...(input.step ? { stepId: input.step.id } : {}),
  });
  if (input.context && (hookDecision.annotations.length > 0 || hookDecision.notices.length > 0)) {
    appendContextHookNotices(input.context, {
      phase: "afterToolCall",
      toolName: input.toolName,
      ...(input.step ? { stepId: input.step.id } : {}),
      ...(hookDecision.notices.length > 0 ? { notices: hookDecision.notices } : {}),
      ...(hookDecision.annotations.length > 0 ? { annotations: hookDecision.annotations } : {}),
    });
  }
}

export function validateToolPayloadSize(
  toolName: string,
  direction: "input" | "output",
  value: unknown,
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined) return;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`Tool ${toolName} ${direction} must be JSON-serializable.`);
  }
  if (serialized === undefined) {
    throw new Error(`Tool ${toolName} ${direction} must be JSON-serializable.`);
  }
  const actualBytes = new TextEncoder().encode(serialized).length;
  if (actualBytes > maxBytes) {
    throw new Error(
      `Tool ${toolName} ${direction} exceeds max${direction === "input" ? "Input" : "Output"}Bytes (${actualBytes} > ${maxBytes}).`,
    );
  }
}

export function resolveToolExecutionTimeoutMs(
  descriptor: Pick<ToolDescriptor, "limits"> | undefined,
  requestedTimeoutMs: number,
): number {
  const declaredTimeoutMs = descriptor?.limits?.timeoutMs;
  return declaredTimeoutMs === undefined
    ? requestedTimeoutMs
    : Math.min(requestedTimeoutMs, declaredTimeoutMs);
}

export function assertRequiredComputerPathInput(
  toolName: "computer.listDirectory" | "computer.openPath",
  input: Record<string, unknown>,
): asserts input is Record<string, unknown> & { path: string } {
  if (typeof input.path === "string" && input.path.trim()) {
    input.path = input.path.trim();
    return;
  }
  throw new Error(
    `${toolName} requires explicit toolInput.path: non-empty string. ` +
    "Path clarification needed: ask the user for the target directory/file path, " +
    "or first locate it with an available search/read-only discovery tool before calling this tool.",
  );
}

export function assertRequiredShellReadOnlyInput(
  input: Record<string, unknown>,
): asserts input is Record<string, unknown> & {
  program: string;
  args: string[];
  workspacePath?: string | null;
} {
  if (typeof input.program !== "string" || !input.program.trim()) {
    throw new Error("shell.runReadOnlyCommand requires explicit toolInput.program: non-empty string.");
  }
  if (!Array.isArray(input.args) || input.args.length === 0 || input.args.some((arg) => typeof arg !== "string" || !arg.trim())) {
    throw new Error("shell.runReadOnlyCommand requires explicit toolInput.args: non-empty string[].");
  }
  if (
    input.workspacePath !== undefined &&
    input.workspacePath !== null &&
    typeof input.workspacePath !== "string"
  ) {
    throw new Error("shell.runReadOnlyCommand requires toolInput.workspacePath to be a string or null when provided.");
  }
  input.program = input.program.trim();
  input.args = input.args.map((arg) => arg.trim());
}
