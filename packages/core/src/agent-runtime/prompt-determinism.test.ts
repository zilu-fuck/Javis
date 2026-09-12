import { describe, expect, it } from "vitest";
import {
  compareStringsByCodePoint,
  computeCacheProbeFingerprints,
  describeCacheProbeViolation,
  findCacheProbeViolation,
  hashPromptItem,
} from "./prompt-determinism";

describe("prompt determinism primitives", () => {
  it("hashes deterministically and differs on any content change", () => {
    expect(hashPromptItem("hello")).toBe(hashPromptItem("hello"));
    expect(hashPromptItem("hello")).not.toBe(hashPromptItem("hellp"));
    expect(hashPromptItem("")).toBe("811c9dc5");
    // FNV-1a 32-bit reference vector for "a".
    expect(hashPromptItem("a")).toBe("e40c292c");
  });

  it("compares by codepoint, independent of locale collation", () => {
    // ICU localeCompare orders "a" before "B"; codepoint order does not.
    expect("a".localeCompare("B")).toBeLessThan(0);
    expect(compareStringsByCodePoint("a", "B")).toBeGreaterThan(0);
    expect(compareStringsByCodePoint("B", "a")).toBeLessThan(0);
    expect(compareStringsByCodePoint("same", "same")).toBe(0);
    expect(compareStringsByCodePoint("工具", "file")).toBeGreaterThan(0);
  });

  it("computes one fingerprint per wire item in provider order", () => {
    const fingerprints = computeCacheProbeFingerprints({
      systemPrompt: "system rules",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
      prompt: "current ask",
    });
    expect(fingerprints).toHaveLength(4);
    expect(fingerprints[0]).toBe(hashPromptItem("system\u0000system rules"));
    expect(fingerprints[1]).toBe(hashPromptItem("user\u0000first"));
    expect(fingerprints[2]).toBe(hashPromptItem("assistant\u0000reply"));
    expect(fingerprints[3]).toBe(hashPromptItem("user\u0000current ask"));
  });

  it("treats append-only growth as prefix-safe", () => {
    const turnOne = computeCacheProbeFingerprints({
      systemPrompt: "sys",
      prompt: "turn 1",
    });
    const turnTwo = computeCacheProbeFingerprints({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "turn 1" }],
      prompt: "turn 2",
    });
    expect(findCacheProbeViolation(turnOne, turnTwo)).toBeNull();
  });

  it("catches edited and shrunk prefixes (seeded regressions)", () => {
    const previous = ["aaa", "bbb", "ccc"];
    expect(findCacheProbeViolation(previous, ["aaa", "zzz", "ccc", "ddd"]))
      .toEqual({ index: 1, kind: "changed" });
    expect(findCacheProbeViolation(previous, ["aaa", "bbb"]))
      .toEqual({ index: 2, kind: "shrunk" });
    expect(findCacheProbeViolation([], ["aaa"])).toBeNull();
    expect(findCacheProbeViolation(["aaa"], ["aaa"])).toBeNull();
  });

  it("formats violations without leaking prompt content", () => {
    const message = describeCacheProbeViolation(
      "chat:task-1",
      { index: 1, kind: "changed" },
      ["h1", "h2", "h3"],
      ["h1", "h9", "h3", "h4"],
    );
    expect(message).toContain("scope chat:task-1");
    expect(message).toContain("item 1 changed");
    expect(message).toContain("h2 -> h9");
    expect(message).not.toMatch(/user goal|transcript content/i);
  });
});
