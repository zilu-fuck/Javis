import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CONTEXT_CHUNK_CHARS,
  MAX_DOCUMENT_CONTEXT_CHARS,
  MAX_DOCUMENT_CONTEXT_REFERENCES,
  buildDocumentContextBlock,
  buildDocumentContextBlocks,
  injectDocumentContext,
} from "./file-classifier";

describe("buildDocumentContextBlock", () => {
  it("splits evidence into stable, path-scoped citation chunks", () => {
    const documentPath = "docs/report.md";
    const content = [
      "A".repeat(DOCUMENT_CONTEXT_CHUNK_CHARS),
      "B".repeat(DOCUMENT_CONTEXT_CHUNK_CHARS),
      "C",
    ].join("");

    const block = buildDocumentContextBlock(documentPath, content, false);

    expect(block.match(/\[docs\/report\.md#chunk-\d+\]/g)).toEqual([
      "[docs/report.md#chunk-1]",
      "[docs/report.md#chunk-2]",
      "[docs/report.md#chunk-3]",
    ]);
    expect(block).toContain(`[docs/report.md#chunk-1]\n${"A".repeat(DOCUMENT_CONTEXT_CHUNK_CHARS)}`);
    expect(block).toContain(`[docs/report.md#chunk-2]\n${"B".repeat(DOCUMENT_CONTEXT_CHUNK_CHARS)}`);
    expect(block).toContain("[docs/report.md#chunk-3]\nC");
    expect(block).toContain("untrusted data");
  });

  it("caps document evidence and explicitly marks omitted content", () => {
    const content = `${"x".repeat(MAX_DOCUMENT_CONTEXT_CHARS)}SECRET_TAIL`;

    const block = buildDocumentContextBlock("large.txt", content, false);

    expect(block.match(/\[large\.txt#chunk-\d+\]/g)).toHaveLength(
      MAX_DOCUMENT_CONTEXT_CHARS / DOCUMENT_CONTEXT_CHUNK_CHARS,
    );
    expect(block).not.toContain("SECRET_TAIL");
    expect(block).toContain("[remaining content truncated]");
  });

  it("does not report truncation at the exact evidence limit", () => {
    const block = buildDocumentContextBlock(
      "exact.txt",
      "x".repeat(MAX_DOCUMENT_CONTEXT_CHARS),
      false,
    );

    expect(block).not.toContain("[remaining content truncated]");
  });

  it("distinguishes a zero-budget document from an empty document", () => {
    const block = buildDocumentContextBlock("deferred.txt", "content exists", false, 0);

    expect(block).toContain("document content omitted by context budget");
    expect(block).not.toContain("document is empty");
  });

  it("emits a cited empty-document marker in the selected locale", () => {
    const englishBlock = buildDocumentContextBlock("empty.txt", " \r\n\t", false);
    const chineseBlock = buildDocumentContextBlock("空文档.txt", " \r\n\t", true);

    expect(englishBlock).toContain("[empty.txt#chunk-1]\n(document is empty)");
    expect(chineseBlock).toContain("[空文档.txt#chunk-1]\n（文档为空）");
    expect(chineseBlock).toContain("不可信数据");
  });

  it("detects Chinese document content when no locale is supplied", () => {
    const block = buildDocumentContextBlock("notes.md", "\u3400是检索到的内容");

    expect(block).toContain("检索到的文档证据");
    expect(block).toContain("[notes.md#chunk-1]\n\u3400是检索到的内容");
  });

  it("shares one content budget across multiple referenced documents", () => {
    const blocks = buildDocumentContextBlocks([
      { path: "first.md", content: "a".repeat(6_000) },
      { path: "second.md", content: "b".repeat(6_000) },
      { path: "third.md", content: "c" },
    ], false);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("[first.md#chunk-3]");
    expect(blocks[1]).toContain("[second.md#chunk-1]");
    expect(blocks[1]).not.toContain("[second.md#chunk-2]");
    expect(blocks[1]).toContain("[remaining content truncated]");
    expect(blocks[2]).toContain("third.md");
    expect(blocks[2]).toContain("context budget was exhausted");
    expect(blocks[2]).not.toContain("[third.md#chunk-1]");
    expect(blocks.join("\n\n").length).toBeLessThanOrEqual(MAX_DOCUMENT_CONTEXT_CHARS);
  });

  it("counts citation metadata and omitted-path notices in the shared budget", () => {
    const documents = Array.from({ length: MAX_DOCUMENT_CONTEXT_REFERENCES + 2 }, (_, index) => ({
      path: `very-long-document-path-${index}-${"x".repeat(180)}.md`,
      content: "evidence ".repeat(2_000),
    }));

    const blocks = buildDocumentContextBlocks(documents, false);

    expect(blocks.join("\n\n").length).toBeLessThanOrEqual(MAX_DOCUMENT_CONTEXT_CHARS);
    expect(blocks[blocks.length - 1]).toContain("not loaded");
  });

  it("bounds metadata even when referenced documents are empty", () => {
    const documents = Array.from({ length: MAX_DOCUMENT_CONTEXT_REFERENCES + 2 }, (_, index) => ({
      path: `empty-${index}.md`,
      content: "",
    }));

    const blocks = buildDocumentContextBlocks(documents, false);

    expect(blocks).toHaveLength(MAX_DOCUMENT_CONTEXT_REFERENCES + 1);
    expect(blocks[MAX_DOCUMENT_CONTEXT_REFERENCES - 1]).toContain(
      `[empty-${MAX_DOCUMENT_CONTEXT_REFERENCES - 1}.md#chunk-1]`,
    );
    expect(blocks[MAX_DOCUMENT_CONTEXT_REFERENCES]).toContain(`empty-${MAX_DOCUMENT_CONTEXT_REFERENCES}.md`);
    expect(blocks[MAX_DOCUMENT_CONTEXT_REFERENCES]).not.toContain(
      `[empty-${MAX_DOCUMENT_CONTEXT_REFERENCES}.md#chunk-1]`,
    );
  });
});

describe("injectDocumentContext", () => {
  it("keeps the user goal once and appends one independently cited evidence block", () => {
    const userGoal = "Summarize the decision";

    const prompt = injectDocumentContext(userGoal, "decision.md", "Approved for release.");

    expect(prompt.startsWith(`${userGoal}\n\n`)).toBe(true);
    expect(prompt.split(userGoal)).toHaveLength(2);
    expect(prompt).toContain("[decision.md#chunk-1]\nApproved for release.");
  });
});
