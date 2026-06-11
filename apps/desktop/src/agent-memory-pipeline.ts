import type {
  AgentMemoryFact,
  AgentMemoryFactKind,
  AgentMemoryScopeType,
  AgentSessionSummary,
} from "./agent-memory";

export function extractAgentMemoryFactsFromSummary(
  summary: AgentSessionSummary,
): AgentMemoryFact[] {
  const scopeType: AgentMemoryScopeType = summary.workspaceId ? "workspace" : "global";
  const now = summary.updatedAt || Date.now();
  const pointCandidates = summary.importantPoints
    .map((point) => extractFactCandidate(point))
    .filter((candidate): candidate is FactCandidate => Boolean(candidate));
  const candidates = pointCandidates.length > 0
    ? pointCandidates
    : [extractSummaryFact(summary.summary)].filter((candidate): candidate is FactCandidate => Boolean(candidate));
  const unique = new Map<string, FactCandidate>();
  for (const candidate of candidates) {
    const normalized = normalizeFactText(candidate.fact);
    if (!normalized || isLowValueFact(normalized)) {
      continue;
    }
    unique.set(normalized, { ...candidate, fact: normalized });
  }

  return [...unique.values()].slice(0, 5).map((candidate) => {
    const normalizedFact = normalizeFactText(candidate.fact);
    const tags = inferTags(normalizedFact, candidate.kind);
    const keywords = inferKeywords(normalizedFact, tags);
    return {
      id: createMemoryFactId(scopeType, summary.workspaceId, normalizedFact),
      fact: normalizedFact,
      normalizedFact,
      kind: candidate.kind,
      tags,
      keywords,
      searchText: "",
      scopeType,
      scopeId: summary.workspaceId,
      sourceSessionId: summary.sessionId,
      sourceMessageIds: [],
      confidence: candidate.confidence,
      importance: candidate.importance,
      status: "active",
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    } satisfies AgentMemoryFact;
  });
}

interface FactCandidate {
  fact: string;
  kind: AgentMemoryFactKind;
  confidence: number;
  importance: number;
}

function extractFactCandidate(point: string): FactCandidate | null {
  const text = stripKnownPrefix(point);
  if (!text) return null;
  if (/^verification:/i.test(point)) {
    return {
      fact: text,
      kind: inferKind(text),
      confidence: 0.72,
      importance: 3,
    };
  }
  if (/^user goal:/i.test(point)) {
    return {
      fact: text,
      kind: inferKind(text),
      confidence: 0.78,
      importance: inferImportance(text),
    };
  }
  return {
    fact: text,
    kind: inferKind(text),
    confidence: 0.7,
    importance: inferImportance(text),
  };
}

function extractSummaryFact(summaryText: string): FactCandidate | null {
  const userAsked = summaryText.match(/User asked:\s*([^\n]+)/i)?.[1];
  if (!userAsked) return null;
  const text = normalizeFactText(userAsked);
  if (!text) return null;
  return {
    fact: text,
    kind: inferKind(text),
    confidence: 0.74,
    importance: inferImportance(text),
  };
}

function stripKnownPrefix(value: string): string {
  return normalizeFactText(value.replace(/^(User goal|Verification):\s*/i, ""));
}

function inferKind(text: string): AgentMemoryFactKind {
  const lower = text.toLowerCase();
  if (/本地|local|sqlite|fts|vector|embedding|cloud|云|隐私|privacy|hard delete|审计|audit/.test(lower)) {
    return "technical_constraint";
  }
  if (/方案|计划|架构|设计|原则|scope|workspace|session|project/.test(lower)) {
    return "design_principle";
  }
  if (/用户希望|用户要求|user wants|user prefers|偏好|记住/.test(lower)) {
    return "user_preference";
  }
  if (/实现|修复|测试|验证|build|test|落地|pipeline|workflow|executor|调用|通过统一/.test(lower)) {
    return "workflow";
  }
  return "workspace_context";
}

function inferImportance(text: string): number {
  const lower = text.toLowerCase();
  if (/必须|must|不要|不得|hard delete|隐私|privacy|本地|local|scope|workspace/.test(lower)) return 5;
  if (/方案|架构|设计|实现|验证|test|build/.test(lower)) return 4;
  return 3;
}

function inferTags(text: string, kind: AgentMemoryFactKind): string[] {
  const lower = text.toLowerCase();
  const tags = new Set<string>([kind.replace(/_/g, "-")]);
  if (lower.includes("javis")) tags.add("Javis");
  if (/记忆|memory/.test(lower)) tags.add("memory");
  if (/workspace|工作区/.test(lower)) tags.add("workspace");
  if (/session|会话/.test(lower)) tags.add("session");
  if (/local|本地|sqlite/.test(lower)) tags.add("local-first");
  if (/privacy|隐私|hard delete|审计|audit/.test(lower)) tags.add("privacy");
  if (/vector|embedding|向量/.test(lower)) tags.add("no-vector");
  return [...tags].slice(0, 8);
}

function inferKeywords(text: string, tags: string[]): string[] {
  const words = text
    .split(/[\s,，。；;:：()[\]{}"'`]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 32);
  return [...new Set([...tags, ...words])].slice(0, 16);
}

function isLowValueFact(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    text.length < 8 ||
    /^verified:?\s*tests? passed$/i.test(text) ||
    lower.includes("secret_tool_output") ||
    lower.includes("secret_command_stdout") ||
    lower.includes("full_migration_log") ||
    /error to revisit|open question/i.test(text)
  );
}

function normalizeFactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}

function createMemoryFactId(
  scopeType: AgentMemoryScopeType,
  scopeId: string | undefined,
  normalizedFact: string,
): string {
  return `mem:${fnv1aHex(`${scopeType}:${scopeId ?? ""}:${normalizedFact.toLowerCase()}`)}`;
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
