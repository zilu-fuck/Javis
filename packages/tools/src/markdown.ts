import type { MarkdownDocument, MarkdownDocumentSummary } from "./types";

export function summarizeMarkdownDocuments(
  documents: MarkdownDocument[],
): MarkdownDocumentSummary[] {
  return documents.map((document) => ({
    ...document,
    purpose: inferMarkdownPurpose(document),
  }));
}

function inferMarkdownPurpose(document: MarkdownDocument): string {
  const normalizedPath = document.path.replace(/\\/g, "/").toLowerCase();

  if (normalizedPath.endsWith("readme.md")) {
    return "Project or module entry document.";
  }

  if (normalizedPath.includes("/docs/")) {
    return `Project design document: ${document.heading ?? "untitled topic"}.`;
  }

  if (document.heading) {
    return `Markdown document about "${document.heading}".`;
  }

  if (document.excerpt) {
    return `Content note: ${document.excerpt}`;
  }

  return "Markdown document without enough visible content to infer a precise purpose.";
}
