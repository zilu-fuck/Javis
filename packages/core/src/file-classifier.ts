/** Lightweight file metadata for batch classification. */
export interface ClassifiableFile {
  name: string;
  path: string;
  extension?: string;
  sizeBytes?: number;
}

/** A classified file with AI-assigned tags and category. */
export interface ClassifiedFile {
  name: string;
  path: string;
  extension?: string;
  sizeBytes?: number;
  tags: string[];
  category: string;
  confidence: number;
}

export const PREDEFINED_CATEGORIES = [
  "财务",
  "合同",
  "研究",
  "行政",
  "技术文档",
  "个人",
  "图片",
  "其他",
] as const;

export function createClassificationPrompt(files: ClassifiableFile[]): string {
  const fileList = files
    .map((f) => `- ${f.name}  (${f.path})  [${f.extension ?? "?"}]  ${formatBytes(f.sizeBytes)}`)
    .join("\n");

  return [
    "You are a document classifier. Given a list of files, classify each one.",
    "",
    `Predefined categories: ${PREDEFINED_CATEGORIES.join(", ")}`,
    "",
    "For each file return:",
    "- category: one of the predefined categories",
    "- tags: 1-3 descriptive tags inferred from filename/path (e.g. #发票, #2024Q1, #草稿)",
    "- confidence: 0.0-1.0",
    "",
    "Return ONLY a JSON array, no markdown or explanation.",
    "Schema: [{\"name\":\"...\",\"category\":\"...\",\"tags\":[\"...\"],\"confidence\":0.9}]",
    "",
    "Files:",
    fileList,
  ].join("\n");
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Inject referenced document content into the user's query context.
 * Used for RAG-lite: user @mentions a file → content is injected into the prompt.
 */
export function injectDocumentContext(
  userGoal: string,
  documentPath: string,
  documentContent: string,
): string {
  const isZh = /[一-鿿]/.test(userGoal);
  const truncated = documentContent.length > 8000
    ? documentContent.slice(0, 8000) + `\n... (${isZh ? "内容已截断" : "content truncated"})`
    : documentContent;

  return [
    isZh
      ? "以下是被引用的文档内容，请基于这些内容回答用户的问题。"
      : "Below is the content of a referenced document. Answer the user's question based on this content.",
    `\n--- ${documentPath} ---\n`,
    truncated,
    `\n--- ${isZh ? "文档结束" : "end of document"} ---\n`,
    `${isZh ? "用户问题" : "User question"}: ${userGoal}`,
  ].join("\n");
}
