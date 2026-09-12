import { describe, expect, it } from "vitest";
import type { ToolJsonSchema, ToolRequiredInput } from "@javis/tools";
import {
  assertRequiredComputerPathInput,
  assertRequiredShellReadOnlyInput,
  resolveToolExecutionTimeoutMs,
  validateToolDescriptorInputs,
  validateToolDescriptorOutput,
  validateToolPayloadSize,
} from "./tool-dispatch-guards";

/**
 * These guards are the boundary every tool call passes through, so the tests are
 * written against the failure modes rather than the happy path: an input guard that
 * lets a malformed call through is worse than no guard at all, and an output guard
 * that rejects a repairable value fails a task that actually succeeded.
 */

describe("validateToolPayloadSize", () => {
  it("is a no-op when the descriptor declares no limit", () => {
    expect(() => validateToolPayloadSize("a.b", "input", { anything: "x" }, undefined)).not.toThrow();
  });

  it("accepts a payload at the limit and rejects one over it", () => {
    const payload = { value: "abc" };
    const size = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(() => validateToolPayloadSize("a.b", "input", payload, size)).not.toThrow();
    expect(() => validateToolPayloadSize("a.b", "input", payload, size - 1))
      .toThrow(/exceeds maxInputBytes/);
    expect(() => validateToolPayloadSize("a.b", "output", payload, size - 1))
      .toThrow(/exceeds maxOutputBytes/);
  });

  it("rejects a value that cannot be serialized rather than ignoring the limit", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateToolPayloadSize("a.b", "input", circular, 1_000))
      .toThrow(/must be JSON-serializable/);
    // `JSON.stringify(undefined)` is undefined, not a string.
    expect(() => validateToolPayloadSize("a.b", "output", undefined, 1_000))
      .toThrow(/must be JSON-serializable/);
  });
});

describe("resolveToolExecutionTimeoutMs", () => {
  it("keeps the requested timeout when the descriptor declares none", () => {
    expect(resolveToolExecutionTimeoutMs(undefined, 5_000)).toBe(5_000);
    expect(resolveToolExecutionTimeoutMs({ limits: {} }, 5_000)).toBe(5_000);
  });

  it("takes the smaller of the declared and requested timeout", () => {
    expect(resolveToolExecutionTimeoutMs({ limits: { timeoutMs: 1_000 } }, 5_000)).toBe(1_000);
    expect(resolveToolExecutionTimeoutMs({ limits: { timeoutMs: 9_000 } }, 5_000)).toBe(5_000);
  });
});

describe("assertRequiredShellReadOnlyInput", () => {
  it("accepts a well-formed command and trims it", () => {
    const input: Record<string, unknown> = { program: "  pnpm ", args: [" test "] };
    assertRequiredShellReadOnlyInput(input);
    expect(input.program).toBe("pnpm");
    expect(input.args).toEqual(["test"]);
  });

  it("rejects a missing program, empty args and non-string args", () => {
    expect(() => assertRequiredShellReadOnlyInput({ args: ["x"] })).toThrow(/requires explicit toolInput.program/);
    expect(() => assertRequiredShellReadOnlyInput({ program: "   ", args: ["x"] })).toThrow(/toolInput.program/);
    expect(() => assertRequiredShellReadOnlyInput({ program: "pnpm", args: [] })).toThrow(/toolInput.args/);
    expect(() => assertRequiredShellReadOnlyInput({ program: "pnpm", args: [7] })).toThrow(/toolInput.args/);
    expect(() => assertRequiredShellReadOnlyInput({ program: "pnpm", args: ["  "] })).toThrow(/toolInput.args/);
  });

  it("rejects a workspacePath of the wrong type but allows null and omission", () => {
    expect(() => assertRequiredShellReadOnlyInput({ program: "p", args: ["a"], workspacePath: 7 }))
      .toThrow(/workspacePath to be a string or null/);
    expect(() => assertRequiredShellReadOnlyInput({ program: "p", args: ["a"], workspacePath: null })).not.toThrow();
    expect(() => assertRequiredShellReadOnlyInput({ program: "p", args: ["a"] })).not.toThrow();
  });
});

describe("assertRequiredComputerPathInput", () => {
  it("trims a provided path", () => {
    const input: Record<string, unknown> = { path: "  C:/tmp  " };
    assertRequiredComputerPathInput("computer.listDirectory", input);
    expect(input.path).toBe("C:/tmp");
  });

  it("explains how to recover instead of only reporting the failure", () => {
    // The message is what the model sees during replanning, so it must say what to do.
    expect(() => assertRequiredComputerPathInput("computer.openPath", {}))
      .toThrow(/Path clarification needed/);
    expect(() => assertRequiredComputerPathInput("computer.openPath", { path: "  " }))
      .toThrow(/non-empty string/);
  });
});

describe("validateToolDescriptorInputs", () => {
  const required = (name: string, type: ToolRequiredInput["type"], nonEmpty = false): ToolRequiredInput =>
    ({ name, type, nonEmpty }) as ToolRequiredInput;

  it("enforces each declared required-input type", () => {
    const descriptor = {
      name: "a.b",
      requiredInputs: [
        required("s", "string", true),
        required("list", "string[]"),
        required("n", "number"),
        required("nums", "number[]"),
        required("flag", "boolean"),
        required("flags", "boolean[]"),
        required("obj", "object"),
        required("objs", "object[]"),
      ],
    };
    const valid = {
      s: "x", list: ["a"], n: 1, nums: [1, 2], flag: true, flags: [false], obj: {}, objs: [{}, {}],
    };
    expect(() => validateToolDescriptorInputs(descriptor, valid)).not.toThrow();
  });

  it("reports the exact field and type that failed", () => {
    const descriptor = { name: "a.b", requiredInputs: [required("count", "number")] };
    expect(() => validateToolDescriptorInputs(descriptor, { count: "3" }))
      .toThrow(/requires input.count to match type number/);
    expect(() => validateToolDescriptorInputs(descriptor, {}))
      .toThrow(/requires input.count/);
  });

  it("rejects an empty value when nonEmpty is declared", () => {
    const descriptor = { name: "a.b", requiredInputs: [required("goal", "string", true)] };
    expect(() => validateToolDescriptorInputs(descriptor, { goal: "   " })).toThrow(/non-empty/);
    expect(() => validateToolDescriptorInputs(descriptor, { goal: "ok" })).not.toThrow();
  });

  it("rejects an array holding the wrong element type", () => {
    const descriptor = { name: "a.b", requiredInputs: [required("paths", "string[]")] };
    expect(() => validateToolDescriptorInputs(descriptor, { paths: ["a", 2] })).toThrow(/string\[\]/);
    expect(() => validateToolDescriptorInputs(descriptor, { paths: "a" })).toThrow(/string\[\]/);
  });

  it("routes the tool-specific guards for shell and computer tools", () => {
    // Defense in depth: these names must not be able to slip past the generic path.
    expect(() => validateToolDescriptorInputs({ name: "shell.runReadOnlyCommand" }, { program: "p" }))
      .toThrow(/toolInput.args/);
    expect(() => validateToolDescriptorInputs({ name: "computer.listDirectory" }, {}))
      .toThrow(/Path clarification needed/);
  });

  it("applies the declared payload limit", () => {
    const descriptor = { name: "a.b", limits: { maxInputBytes: 5 } };
    expect(() => validateToolDescriptorInputs(descriptor, { value: "far too long" }))
      .toThrow(/exceeds maxInputBytes/);
  });

  it("throws on a schema violation", () => {
    // Annotated so the literal types survive: an inline object widens `type` to
    // `string`, which is not assignable to the schema type.
    const inputSchema: ToolJsonSchema = {
      type: "object",
      properties: { provider: { type: "string" } },
      required: ["provider"],
    };
    const descriptor = { name: "a.b", inputSchema };
    expect(() => validateToolDescriptorInputs(descriptor, {})).toThrow();
    expect(() => validateToolDescriptorInputs(descriptor, { provider: "deepseek" })).not.toThrow();
  });
});

describe("validateToolDescriptorOutput", () => {
  it("returns the output untouched and reports no repairs when it is already valid", () => {
    const output = { actualFound: [{ line: 3 }] };
    const result = validateToolDescriptorOutput(
      { name: "a.b", outputSchema: { type: "object", properties: { actualFound: { type: "array", items: { type: "object" } } } } },
      output,
    );
    expect(result.repairs).toEqual([]);
    // Identity matters: artifact and provenance hashes are computed over this value.
    expect(result.output).toBe(output);
  });

  it("repairs a mechanical type mistake and reports it", () => {
    const result = validateToolDescriptorOutput(
      { name: "a.b", outputSchema: { type: "object", properties: { line: { type: "number" } } } },
      { line: "42" },
    );
    expect(result.repairs.length).toBeGreaterThan(0);
    expect(result.output).toEqual({ line: 42 });
  });

  it("throws when the output cannot be repaired into the declared shape", () => {
    expect(() => validateToolDescriptorOutput(
      { name: "a.b", outputSchema: { type: "object", properties: { kind: { enum: ["a", "b"] } } } },
      { kind: "not-a-member" },
    )).toThrow(/a\.b output/);
  });

  it("applies the declared output payload limit", () => {
    expect(() => validateToolDescriptorOutput(
      { name: "a.b", limits: { maxOutputBytes: 5 } },
      { value: "far too long" },
    )).toThrow(/exceeds maxOutputBytes/);
  });

  it("skips schema work when no output schema is declared, but still checks the size", () => {
    const output = { anything: true };
    expect(validateToolDescriptorOutput({ name: "a.b" }, output)).toEqual({ output, repairs: [] });
    expect(() => validateToolDescriptorOutput({ name: "a.b", limits: { maxOutputBytes: 2 } }, output))
      .toThrow(/exceeds maxOutputBytes/);
  });
});
