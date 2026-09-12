import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_TIMEOUT_MS } from "./task-wait";
import {
  TEXT_GENERATION_STALL_TIMEOUT_MS,
  hasUsablePartialContent,
  isTextWriteGoal,
  resolveGenerationTimeoutMs,
} from "./text-write-flow";

describe("text generation budget", () => {
  it("gives long-form generation far more room than the generic task timeout", () => {
    // The observed production failure was a text-write task dying at exactly the
    // 180s task timeout and discarding the document it had already generated.
    const budget = resolveGenerationTimeoutMs(90_000);
    expect(budget).toBeGreaterThanOrEqual(270_000);
    expect(resolveGenerationTimeoutMs(180_000)).toBeGreaterThan(270_000);
  });

  it("falls back to the default task timeout when none is configured", () => {
    expect(resolveGenerationTimeoutMs(undefined)).toBeGreaterThan(DEFAULT_TASK_TIMEOUT_MS);
    expect(resolveGenerationTimeoutMs(Number.NaN)).toBeGreaterThan(DEFAULT_TASK_TIMEOUT_MS);
  });

  it("scales with an explicitly requested length", () => {
    const short = resolveGenerationTimeoutMs(90_000);
    const long = resolveGenerationTimeoutMs(90_000, { amount: 5_000, unit: "words" });
    expect(long).toBeGreaterThan(short);
  });

  it("never exceeds the hard ceiling", () => {
    expect(resolveGenerationTimeoutMs(900_000, { amount: 1_000_000, unit: "words" })).toBeLessThanOrEqual(900_000);
  });

  it("treats a stalled generation as worth keeping only when it produced real text", () => {
    expect(hasUsablePartialContent("")).toBe(false);
    expect(hasUsablePartialContent("   \n  ")).toBe(false);
    expect(hasUsablePartialContent("short")).toBe(false);
    expect(hasUsablePartialContent("A".repeat(200))).toBe(true);
  });

  it("keeps the stall window well below the generation budget", () => {
    expect(TEXT_GENERATION_STALL_TIMEOUT_MS).toBeLessThan(resolveGenerationTimeoutMs(90_000));
  });
});

describe("write intent gating", () => {
  it("accepts explicit write instructions", () => {
    expect(isTextWriteGoal("把这份总结保存到 notes.md")).toBe(true);
    expect(isTextWriteGoal("save this summary to notes.md")).toBe(true);
    expect(isTextWriteGoal("生成一份 README.md 的项目说明")).toBe(true);
    expect(isTextWriteGoal("导出这次分析结果到 report.md")).toBe(true);
  });

  it("refuses questions and review requests", () => {
    // Both of these opened a confirmed-write approval card before the gate.
    expect(isTextWriteGoal("如何创建一个 HTML 页面？")).toBe(false);
    expect(isTextWriteGoal("做一个页面设计评审")).toBe(false);
    expect(isTextWriteGoal("How do I create a report in Excel?")).toBe(false);
    expect(isTextWriteGoal("review the notes document")).toBe(false);
  });

  it("does not treat answering with code as writing a file", () => {
    expect(isTextWriteGoal("write a function that reverses a linked list")).toBe(false);
    expect(isTextWriteGoal("解释一下这个脚本")).toBe(false);
  });
});
