export interface RecoveryChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ContextSummaryTool {
  complete(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      locale?: string;
      skipAgentMemory?: boolean;
      skipSkillContext?: boolean;
    },
  ): Promise<{ text: string }>;
}

export interface ConversationSplit {
  earlierMessages: RecoveryChatMessage[];
  recentMessages: RecoveryChatMessage[];
}

const CONTEXT_RECOVERY_CHUNK_MAX_CHARS = 12_000;
const CONTEXT_RECOVERY_MESSAGE_MAX_CHARS = 4_000;
const CONTEXT_RECOVERY_SUMMARY_MAX_TOKENS = 1_200;
const CONTEXT_RECOVERY_IMAGE_DATA_URL_PATTERN =
  /data:image\/(?:png|jpe?g|webp|gif|bmp|tiff?);base64,[A-Za-z0-9+/]+={0,2}/gi;

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("maximum context length") ||
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long") ||
    lower.includes("reduce the length")
  );
}

export function splitRecentConversationRounds(
  messages: RecoveryChatMessage[],
  rounds = 5,
): ConversationSplit {
  const normalized = messages
    .map(normalizeRecoveryMessage)
    .filter((message): message is RecoveryChatMessage => Boolean(message));
  const recentMessageCount = Math.max(0, rounds) * 2;
  if (recentMessageCount === 0 || normalized.length <= recentMessageCount) {
    return { earlierMessages: [], recentMessages: normalized };
  }
  return {
    earlierMessages: normalized.slice(0, -recentMessageCount),
    recentMessages: normalized.slice(-recentMessageCount),
  };
}

export async function summarizeEarlierConversation(input: {
  messages: RecoveryChatMessage[];
  summaryTool: ContextSummaryTool;
  locale?: string;
}): Promise<string> {
  const chunks = chunkConversationForSummary(input.messages);
  if (chunks.length === 0) {
    return "";
  }
  const partialSummaries: string[] = [];
  for (const chunk of chunks) {
    const result = await input.summaryTool.complete(
      createConversationSummaryPrompt(chunk, input.locale),
      {
        maxTokens: CONTEXT_RECOVERY_SUMMARY_MAX_TOKENS,
        temperature: 0,
        locale: input.locale,
        skipAgentMemory: true,
        skipSkillContext: true,
      },
    );
    const summary = normalizeSummaryText(result.text);
    if (summary) {
      partialSummaries.push(summary);
    }
  }
  if (partialSummaries.length <= 1) {
    return partialSummaries[0] ?? "";
  }
  const result = await input.summaryTool.complete(
    createSummaryMergePrompt(partialSummaries, input.locale),
    {
      maxTokens: CONTEXT_RECOVERY_SUMMARY_MAX_TOKENS,
      temperature: 0,
      locale: input.locale,
      skipAgentMemory: true,
      skipSkillContext: true,
    },
  );
  return normalizeSummaryText(result.text);
}

export function createRecoveredConversationMessages(input: {
  earlierSummary: string;
  recentMessages: RecoveryChatMessage[];
}): RecoveryChatMessage[] {
  const summary = normalizeSummaryText(input.earlierSummary);
  const messages = input.recentMessages
    .map(normalizeRecoveryMessage)
    .filter((message): message is RecoveryChatMessage => Boolean(message));
  if (!summary) {
    return messages;
  }
  return [
    {
      role: "assistant",
      content: [
        "Earlier conversation summary:",
        summary,
        "This summary may be incomplete. If it conflicts with the recent messages, follow the recent messages.",
      ].join("\n"),
    },
    ...messages,
  ];
}

export async function createRecoveredContextMessages(input: {
  messages: RecoveryChatMessage[];
  summaryTool: ContextSummaryTool;
  locale?: string;
  recentRounds?: number;
}): Promise<RecoveryChatMessage[]> {
  const split = splitRecentConversationRounds(input.messages, input.recentRounds ?? 5);
  const earlierSummary = await summarizeEarlierConversation({
    messages: split.earlierMessages,
    summaryTool: input.summaryTool,
    locale: input.locale,
  });
  return createRecoveredConversationMessages({
    earlierSummary,
    recentMessages: split.recentMessages,
  });
}

function normalizeRecoveryMessage(message: RecoveryChatMessage | undefined): RecoveryChatMessage | null {
  const content = message?.content
    .replace(CONTEXT_RECOVERY_IMAGE_DATA_URL_PATTERN, "[image data omitted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!message || !content) {
    return null;
  }
  return {
    role: message.role,
    content: clipText(content, CONTEXT_RECOVERY_MESSAGE_MAX_CHARS),
  };
}

function chunkConversationForSummary(messages: RecoveryChatMessage[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const message of messages) {
    const normalized = normalizeRecoveryMessage(message);
    if (!normalized) {
      continue;
    }
    const line = `${normalized.role === "user" ? "User" : "Javis"}: ${normalized.content}`;
    const next = current ? `${current}\n${line}` : line;
    if (current && next.length > CONTEXT_RECOVERY_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function createConversationSummaryPrompt(conversationChunk: string, locale?: string): string {
  const wantsChinese = locale?.toLowerCase().startsWith("zh");
  return [
    wantsChinese
      ? "\u8bf7\u538b\u7f29\u603b\u7ed3\u4e0b\u9762\u8fd9\u6bb5\u8f83\u65e9\u7684 Javis \u5bf9\u8bdd\uff0c\u7528\u4e8e\u4e0a\u4e0b\u6587\u7a97\u53e3\u6ea2\u51fa\u540e\u7684\u6062\u590d\u3002"
      : "Summarize this earlier Javis conversation for context-window overflow recovery.",
    wantsChinese
      ? "\u5fc5\u987b\u4fdd\u7559\uff1a\u7528\u6237\u660e\u786e\u7ea6\u675f\u3001\u5df2\u51b3\u5b9a\u4e8b\u9879\u3001\u5173\u952e\u6587\u4ef6\u8def\u5f84\u3001\u4ee3\u7801/API \u540d\u79f0\u3001\u672a\u89e3\u51b3\u95ee\u9898\u3001\u9a8c\u8bc1\u7ed3\u679c\u3002"
      : "Preserve explicit user constraints, decisions, key file paths, code/API names, open questions, and verification results.",
    wantsChinese
      ? "\u4e0d\u8981\u7f16\u9020\u7f3a\u5931\u4fe1\u606f\u3002\u8f93\u51fa\u7b80\u6d01\u9879\u76ee\u7b26\u53f7\u3002"
      : "Do not invent missing information. Return concise bullets.",
    "",
    conversationChunk,
  ].join("\n");
}

function createSummaryMergePrompt(partialSummaries: string[], locale?: string): string {
  const wantsChinese = locale?.toLowerCase().startsWith("zh");
  return [
    wantsChinese
      ? "\u8bf7\u628a\u8fd9\u4e9b\u5206\u5757\u6458\u8981\u5408\u5e76\u6210\u4e00\u4efd\u66f4\u77ed\u7684\u524d\u6587\u6458\u8981\uff0c\u7528\u4e8e Javis \u540e\u7eed\u56de\u7b54\u3002"
      : "Merge these chunk summaries into a shorter earlier-conversation summary for Javis.",
    wantsChinese
      ? "\u4fdd\u7559\u786c\u6027\u7ea6\u675f\u3001\u5173\u952e\u8def\u5f84/API\u3001\u5df2\u5b8c\u6210\u9a8c\u8bc1\u3001\u672a\u89e3\u51b3\u95ee\u9898\uff1b\u4e0d\u8981\u7f16\u9020\u3002"
      : "Preserve hard constraints, key paths/APIs, completed verification, and open questions; do not invent facts.",
    "",
    partialSummaries.map((summary, index) => `Chunk ${index + 1}:\n${summary}`).join("\n\n"),
  ].join("\n");
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+\n/g, "\n").trim();
}

function clipText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const half = Math.floor((maxChars - 7) / 2);
  return `${content.slice(0, half)} ... ${content.slice(-half)}`;
}
