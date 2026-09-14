import { describe, expect, it } from "vitest";
import { MAX_REASONING_DIGEST_CHARS, summarizeReasoningDigest } from "./reasoning-digest";

describe("reasoning digest", () => {
  it("keeps readable reasoning text", () => {
    expect(summarizeReasoningDigest("先确认目标格式，再决定文件名。")).toBe("先确认目标格式，再决定文件名。");
  });

  it("returns undefined when there is nothing to keep", () => {
    expect(summarizeReasoningDigest(undefined)).toBeUndefined();
    expect(summarizeReasoningDigest("")).toBeUndefined();
    expect(summarizeReasoningDigest("   \n\t ")).toBeUndefined();
  });

  it("redacts secrets the model may have copied from a tool observation", () => {
    const digest = summarizeReasoningDigest(
      "读取配置后发现 api_key: sk-abcdefgh12345678 ，应改用环境变量。",
    );
    expect(digest).not.toContain("sk-abcdefgh12345678");
    expect(digest).toContain("[redacted:secret]");
    expect(digest).toContain("环境变量");
  });

  it("drops reasoning wrapper tags and image payloads instead of storing them", () => {
    const digest = summarizeReasoningDigest(
      "<thinking>先看目录</thinking> 截图是 data:image/png;base64,AAAABBBBCCCC 不需要保存",
    );
    expect(digest).not.toContain("<thinking>");
    expect(digest).not.toContain("base64");
    expect(digest).toBe("先看目录 截图是 [redacted:image data URL] 不需要保存");
  });

  it("bounds the digest so durable logs stay small", () => {
    const digest = summarizeReasoningDigest("思".repeat(600));
    expect(digest).toBeDefined();
    expect([...(digest ?? "")].length).toBe(MAX_REASONING_DIGEST_CHARS + "...[truncated]".length);
    expect(digest?.endsWith("...[truncated]")).toBe(true);
  });
});
