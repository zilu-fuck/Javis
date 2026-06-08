import type { TaskSnapshot } from "@javis/core";
import type { DatabaseValue, DesktopDatabase, DesktopDatabaseMigration } from "./desktop-database";
import { TOPIC_RULES, type TopicRule } from "./user-profile-rules";
export { createNewChatRecommendations } from "./user-profile-recommendation-engine";
import { getTaskUpdatedAt, getTaskWorkspacePath } from "./task-history";

export const USER_PROFILE_MEMORY_STORAGE_KEY = "javis.userProfileMemory.v1";
export const USER_PROFILE_MEMORY_TABLE_NAME = "user_profile_memory";
export const USER_PROFILE_MEMORY_SINGLETON_ID = "default";
export const USER_PROFILE_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profile_memory (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  memory_json TEXT NOT NULL
)
`.trim();
export const USER_PROFILE_MEMORY_SCHEMA_MIGRATION: DesktopDatabaseMigration = {
  id: "001_user_profile_memory",
  sql: USER_PROFILE_MEMORY_SCHEMA_SQL,
};
export const USER_PROFILE_MEMORY_MIGRATIONS: DesktopDatabaseMigration[] = [
  USER_PROFILE_MEMORY_SCHEMA_MIGRATION,
];

export type UserProfileMemoryFactKind =
  | "current_focus"
  | "workspace_context"
  | "work_pattern"
  | "preference";

export type UserProfileMemoryFactSource = "history" | "workspace";

export interface UserProfileMemoryEvidence {
  taskId?: string;
  title?: string;
  workspacePath?: string;
  snippet: string;
  matchedKeywords: string[];
  observedAt: string;
}

export interface UserProfileMemoryFact {
  id: string;
  kind: UserProfileMemoryFactKind;
  text: string;
  tags: string[];
  score: number;
  confidence: number;
  source: UserProfileMemoryFactSource;
  firstSeenAt: string;
  updatedAt: string;
  lastSeenAt: string;
  hitCount: number;
  evidence: UserProfileMemoryEvidence[];
}

export interface UserProfileMemory {
  version: 2;
  updatedAt: string;
  facts: UserProfileMemoryFact[];
  summary: {
    topTags: string[];
    currentWorkspacePath?: string;
    historyItemCount: number;
    inputFingerprint?: string;
    processedTaskSignatures?: string[];
  };
}

export interface UserProfileMemoryInput {
  history: TaskSnapshot[];
  currentWorkspacePath?: string;
  recentWorkspacePaths?: string[];
  previous?: UserProfileMemory | null;
  now?: Date | string;
}

export interface UserProfileMemoryRepository {
  load(): Promise<UserProfileMemory | null>;
  save(memory: UserProfileMemory): Promise<UserProfileMemory>;
  clear(): Promise<void>;
  importFromLocalStorage(storage: Pick<Storage, "getItem" | "removeItem">): Promise<UserProfileMemory | null>;
}

export type RecommendationLocale = "zh" | "en";

export interface UserProfileMemoryUpdateResult {
  memory: UserProfileMemory;
  changed: boolean;
  mode: "skipped" | "incremental" | "rebuilt";
  processedTaskIds: string[];
}

interface ScoredTopic {
  rule: TopicRule;
  hitCount: number;
  weightedHitCount: number;
  latestObservedAt: string;
  evidence: UserProfileMemoryEvidence[];
}

const MAX_FACTS = 24;
const MAX_EVIDENCE_PER_FACT = 4;
const MAX_HISTORY_ITEMS = 40;
const MAX_HIT_COUNT = 999;
const MIN_FACT_SCORE = 0.18;

export function createUserProfileMemory(input: UserProfileMemoryInput): UserProfileMemory {
  const now = toIsoString(input.now);
  const recentHistory = recentHistoryItems(input.history);
  const historyFacts = extractHistoryFacts(recentHistory, now);
  const workspaceFacts = extractWorkspaceFacts(input.currentWorkspacePath, input.recentWorkspacePaths, now);
  const facts = mergeFacts(input.previous?.facts ?? [], [...historyFacts, ...workspaceFacts], now);
  const currentWorkspacePath = normalizeWhitespace(input.currentWorkspacePath ?? "");
  const processedTaskSignatures = recentHistory.map(taskSignature);

  return {
    version: 2,
    updatedAt: now,
    facts,
    summary: {
      topTags: rankTags(facts).slice(0, 6),
      currentWorkspacePath: currentWorkspacePath || undefined,
      historyItemCount: input.history.length,
      inputFingerprint: createProfileInputFingerprint(input),
      processedTaskSignatures,
    },
  };
}

export function updateUserProfileMemory(input: UserProfileMemoryInput): UserProfileMemoryUpdateResult {
  const previous = input.previous ?? null;
  const nextFingerprint = createProfileInputFingerprint(input);
  if (previous?.summary.inputFingerprint === nextFingerprint) {
    return {
      memory: previous,
      changed: false,
      mode: "skipped",
      processedTaskIds: [],
    };
  }

  const recentHistory = recentHistoryItems(input.history);
  const previousSignatures = new Set(previous?.summary.processedTaskSignatures ?? []);
  const canIncrement = Boolean(previous && previousSignatures.size > 0);
  const changedHistory = canIncrement
    ? recentHistory.filter((task) => !previousSignatures.has(taskSignature(task)))
    : recentHistory;
  const historyForUpdate = canIncrement ? changedHistory : recentHistory;
  const memory = createUserProfileMemory({
    ...input,
    history: historyForUpdate,
    previous,
  });
  const processedTaskSignatures = recentHistory.map(taskSignature);

  return {
    memory: {
      ...memory,
      summary: {
        ...memory.summary,
        historyItemCount: input.history.length,
        inputFingerprint: nextFingerprint,
        processedTaskSignatures,
      },
    },
    changed: true,
    mode: canIncrement ? "incremental" : "rebuilt",
    processedTaskIds: historyForUpdate.map((task) => task.id),
  };
}

export function loadUserProfileMemory(storage: Pick<Storage, "getItem">): UserProfileMemory | null {
  try {
    const raw = storage.getItem(USER_PROFILE_MEMORY_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeMemory(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveUserProfileMemory(
  storage: Pick<Storage, "setItem">,
  memory: UserProfileMemory,
): boolean {
  try {
    storage.setItem(USER_PROFILE_MEMORY_STORAGE_KEY, JSON.stringify(sanitizeMemory(memory) ?? memory));
    return true;
  } catch {
    return false;
  }
}

export function clearUserProfileMemory(storage: Pick<Storage, "removeItem">): boolean {
  try {
    storage.removeItem(USER_PROFILE_MEMORY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function createUserProfileMemoryRepository(
  database: Pick<DesktopDatabase, "execute" | "select">,
): UserProfileMemoryRepository {
  return {
    async load() {
      return loadUserProfileMemoryFromDatabase(database);
    },

    async save(memory) {
      return saveUserProfileMemoryToDatabase(database, memory);
    },

    async clear() {
      await clearUserProfileMemoryFromDatabase(database);
    },

    async importFromLocalStorage(storage) {
      return importUserProfileMemoryFromLocalStorage(database, storage);
    },
  };
}

export async function loadUserProfileMemoryWithStorageFallback(
  repository: Pick<UserProfileMemoryRepository, "load"> | null | undefined,
  storage: Pick<Storage, "getItem">,
): Promise<UserProfileMemory | null> {
  if (!repository) {
    return loadUserProfileMemory(storage);
  }
  try {
    return await repository.load();
  } catch {
    return loadUserProfileMemory(storage);
  }
}

export async function loadUserProfileMemoryFromDatabase(
  database: Pick<DesktopDatabase, "select">,
): Promise<UserProfileMemory | null> {
  const rows = await database.select<{ memory_json: string }>(
    `SELECT memory_json FROM ${USER_PROFILE_MEMORY_TABLE_NAME} WHERE id = ? LIMIT 1`,
    [USER_PROFILE_MEMORY_SINGLETON_ID],
  );
  const raw = rows[0]?.memory_json;
  if (!raw) return null;
  try {
    return sanitizeMemory(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveUserProfileMemoryToDatabase(
  database: Pick<DesktopDatabase, "execute">,
  memory: UserProfileMemory,
): Promise<UserProfileMemory> {
  const sanitized = sanitizeMemory(memory) ?? memory;
  await database.execute(
    `INSERT INTO ${USER_PROFILE_MEMORY_TABLE_NAME} (id, updated_at, memory_json)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  updated_at = excluded.updated_at,
  memory_json = excluded.memory_json`,
    userProfileMemoryBindValues(sanitized),
  );
  return sanitized;
}

export async function clearUserProfileMemoryFromDatabase(
  database: Pick<DesktopDatabase, "execute">,
): Promise<void> {
  await database.execute(
    `DELETE FROM ${USER_PROFILE_MEMORY_TABLE_NAME} WHERE id = ?`,
    [USER_PROFILE_MEMORY_SINGLETON_ID],
  );
}

export async function importUserProfileMemoryFromLocalStorage(
  database: Pick<DesktopDatabase, "execute" | "select">,
  storage: Pick<Storage, "getItem" | "removeItem">,
): Promise<UserProfileMemory | null> {
  const imported = loadUserProfileMemory(storage);
  if (imported) {
    const saved = await saveUserProfileMemoryToDatabase(database, imported);
    clearUserProfileMemory(storage);
    return saved;
  }
  return loadUserProfileMemoryFromDatabase(database);
}

function userProfileMemoryBindValues(memory: UserProfileMemory): DatabaseValue[] {
  return [
    USER_PROFILE_MEMORY_SINGLETON_ID,
    memory.updatedAt,
    JSON.stringify(memory),
  ];
}

function extractHistoryFacts(history: TaskSnapshot[], now: string): UserProfileMemoryFact[] {
  const recent = recentHistoryItems(history);
  const topics = new Map<string, ScoredTopic>();

  recent.forEach((task, index) => {
    const taskText = historyText(task);
    if (!taskText) return;
    const observedAt = getTaskUpdatedAt(task);
    const recencyWeight = Math.max(0.35, 1 - index * 0.035);

    for (const rule of TOPIC_RULES) {
      const matchedKeywords = matchedRuleKeywords(taskText, rule);
      if (!matchedKeywords.length) continue;
      const existing = topics.get(rule.tag) ?? {
        rule,
        hitCount: 0,
        weightedHitCount: 0,
        latestObservedAt: observedAt,
        evidence: [],
      };
      existing.hitCount += matchedKeywords.length;
      existing.weightedHitCount += matchedKeywords.length * recencyWeight;
      existing.latestObservedAt = maxIso(existing.latestObservedAt, observedAt);
      existing.evidence.push(createEvidence(task, taskText, matchedKeywords, observedAt));
      topics.set(rule.tag, existing);
    }
  });

  return [...topics.values()].map((topic) => {
    const confidence = clamp(0.34 + topic.weightedHitCount * 0.11, 0.2, 0.96);
    const score = clamp(confidence * recencyScore(topic.latestObservedAt, now), 0, 1);
    return {
      id: `history:${topic.rule.tag}`,
      kind: topic.rule.kind,
      text: topic.rule.zhText,
      tags: [topic.rule.tag],
      score,
      confidence,
      source: "history",
      firstSeenAt: topic.latestObservedAt,
      updatedAt: now,
      lastSeenAt: topic.latestObservedAt,
      hitCount: topic.hitCount,
      evidence: dedupeEvidence(topic.evidence),
    };
  });
}

function extractWorkspaceFacts(
  currentWorkspacePath: string | undefined,
  recentWorkspacePaths: string[] | undefined,
  now: string,
): UserProfileMemoryFact[] {
  const path = normalizeWhitespace(currentWorkspacePath ?? "");
  if (!path) return [];
  const recent = uniqueStrings(recentWorkspacePaths ?? []);
  const isRepeatedWorkspace = recent.some((entry) => samePath(entry, path));
  const confidence = isRepeatedWorkspace ? 0.86 : 0.72;
  return [{
    id: "workspace:current",
    kind: "workspace_context",
    text: path,
    tags: ["workspace", "local-knowledge"],
    score: confidence,
    confidence,
    source: "workspace",
    firstSeenAt: now,
    updatedAt: now,
    lastSeenAt: now,
    hitCount: isRepeatedWorkspace ? 2 : 1,
    evidence: [{
      workspacePath: path,
      snippet: path,
      matchedKeywords: ["workspace"],
      observedAt: now,
    }],
  }];
}

function mergeFacts(
  previous: UserProfileMemoryFact[],
  next: UserProfileMemoryFact[],
  now: string,
): UserProfileMemoryFact[] {
  const byId = new Map<string, UserProfileMemoryFact>();
  const hasCurrentWorkspaceFact = next.some((fact) => fact.id === "workspace:current");

  for (const fact of previous) {
    const sanitized = sanitizeFact(fact);
    if (!sanitized) continue;
    if (hasCurrentWorkspaceFact && sanitized.source === "workspace") continue;
    const ageScore = recencyScore(sanitized.lastSeenAt, now);
    const score = clamp(sanitized.score * (0.72 + ageScore * 0.28), 0, 1);
    if (score >= MIN_FACT_SCORE) {
      byId.set(sanitized.id, { ...sanitized, score, updatedAt: now });
    }
  }

  for (const fact of next) {
    const existing = byId.get(fact.id);
    if (!existing) {
      byId.set(fact.id, fact);
      continue;
    }

    byId.set(fact.id, {
      ...existing,
      ...fact,
      firstSeenAt: minIso(existing.firstSeenAt, fact.firstSeenAt),
      lastSeenAt: maxIso(existing.lastSeenAt, fact.lastSeenAt),
      hitCount: Math.min(MAX_HIT_COUNT, existing.hitCount + fact.hitCount),
      score: Math.max(existing.score, fact.score),
      confidence: Math.max(existing.confidence, fact.confidence),
      evidence: dedupeEvidence([...fact.evidence, ...existing.evidence]),
    });
  }

  return [...byId.values()]
    .sort((a, b) =>
      b.score - a.score ||
      b.confidence - a.confidence ||
      b.lastSeenAt.localeCompare(a.lastSeenAt) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, MAX_FACTS);
}

function historyText(task: TaskSnapshot): string {
  const userMessages = task.conversationMessages
    ?.filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n") ?? "";
  const planText = task.plan.map((step) => `${step.title} ${step.successCriteria ?? ""}`).join("\n");
  const agentText = task.agents.map((agent) => `${agent.name} ${agent.role} ${agent.task}`).join("\n");
  const logText = task.logs.slice(-6).map((log) => `${log.title} ${log.detail}`).join("\n");
  const changedFilesText = taskChangedFiles(task).join("\n");
  return normalizeWhitespace([
    task.title,
    task.userGoal,
    getTaskWorkspacePath(task),
    changedFilesText,
    userMessages,
    planText,
    agentText,
    task.verificationSummary,
    logText,
  ].filter(Boolean).join("\n"));
}

function matchedRuleKeywords(text: string, rule: TopicRule): string[] {
  const lower = text.toLocaleLowerCase();
  const matched = rule.keywords.filter((keyword) => lower.includes(keyword.toLocaleLowerCase()));
  return uniqueStrings(matched);
}

function createEvidence(
  task: TaskSnapshot,
  text: string,
  matchedKeywords: string[],
  observedAt: string,
): UserProfileMemoryEvidence {
  return {
    taskId: task.id,
    title: task.title,
    workspacePath: getTaskWorkspacePath(task) || undefined,
    snippet: excerptAroundKeyword(text, matchedKeywords[0]),
    matchedKeywords,
    observedAt,
  };
}

function sanitizeMemory(value: unknown): UserProfileMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version === 1) {
    return migrateV1Memory(record);
  }
  if (record.version !== 2 || typeof record.updatedAt !== "string" || !Array.isArray(record.facts)) return null;
  const facts = record.facts
    .map(sanitizeFact)
    .filter((fact): fact is UserProfileMemoryFact => Boolean(fact))
    .slice(0, MAX_FACTS);
  return {
    version: 2,
    updatedAt: record.updatedAt,
    facts,
    summary: sanitizeSummary(record.summary, facts),
  };
}

function migrateV1Memory(record: Record<string, unknown>): UserProfileMemory | null {
  if (typeof record.updatedAt !== "string" || !Array.isArray(record.facts)) return null;
  const updatedAt = record.updatedAt;
  const facts = record.facts
    .map((value): UserProfileMemoryFact | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const fact = value as Record<string, unknown>;
      if (
        typeof fact.id !== "string" ||
        !isFactKind(fact.kind) ||
        typeof fact.text !== "string" ||
        !Array.isArray(fact.tags) ||
        !fact.tags.every((tag) => typeof tag === "string") ||
        typeof fact.score !== "number" ||
        !isFactSource(fact.source) ||
        typeof fact.updatedAt !== "string"
      ) {
        return null;
      }
      return {
        id: fact.id,
        kind: fact.kind,
        text: fact.text,
        tags: uniqueStrings(fact.tags),
        score: clamp(fact.score, 0, 1),
        confidence: clamp(fact.score, 0.2, 0.8),
        source: fact.source,
        firstSeenAt: fact.updatedAt,
        updatedAt,
        lastSeenAt: fact.updatedAt,
        hitCount: 1,
        evidence: [],
      };
    })
    .filter((fact): fact is UserProfileMemoryFact => Boolean(fact))
    .slice(0, MAX_FACTS);
  return {
    version: 2,
    updatedAt,
    facts,
    summary: {
      topTags: rankTags(facts).slice(0, 6),
      historyItemCount: 0,
    },
  };
}

function sanitizeFact(value: unknown): UserProfileMemoryFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !isFactKind(record.kind) ||
    typeof record.text !== "string" ||
    !Array.isArray(record.tags) ||
    !record.tags.every((tag) => typeof tag === "string") ||
    typeof record.score !== "number" ||
    typeof record.confidence !== "number" ||
    !isFactSource(record.source) ||
    typeof record.firstSeenAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.lastSeenAt !== "string" ||
    typeof record.hitCount !== "number" ||
    !Array.isArray(record.evidence)
  ) {
    return null;
  }

  return {
    id: normalizeWhitespace(record.id),
    kind: record.kind,
    text: normalizeWhitespace(record.text),
    tags: uniqueStrings(record.tags.map(normalizeWhitespace).filter(Boolean)),
    score: clamp(record.score, 0, 1),
    confidence: clamp(record.confidence, 0, 1),
    source: record.source,
    firstSeenAt: record.firstSeenAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    hitCount: Math.max(0, Math.floor(record.hitCount)),
    evidence: record.evidence
      .map(sanitizeEvidence)
      .filter((evidence): evidence is UserProfileMemoryEvidence => Boolean(evidence))
      .slice(0, MAX_EVIDENCE_PER_FACT),
  };
}

function sanitizeEvidence(value: unknown): UserProfileMemoryEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.snippet !== "string" ||
    !Array.isArray(record.matchedKeywords) ||
    !record.matchedKeywords.every((keyword) => typeof keyword === "string") ||
    typeof record.observedAt !== "string"
  ) {
    return null;
  }
  return {
    taskId: typeof record.taskId === "string" ? record.taskId : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    workspacePath: typeof record.workspacePath === "string" ? record.workspacePath : undefined,
    snippet: normalizeWhitespace(record.snippet).slice(0, 240),
    matchedKeywords: uniqueStrings(record.matchedKeywords.map(normalizeWhitespace).filter(Boolean)).slice(0, 8),
    observedAt: record.observedAt,
  };
}

function sanitizeSummary(value: unknown, facts: UserProfileMemoryFact[]): UserProfileMemory["summary"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { topTags: rankTags(facts).slice(0, 6), historyItemCount: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    topTags: Array.isArray(record.topTags)
      ? uniqueStrings(record.topTags.filter((tag): tag is string => typeof tag === "string")).slice(0, 6)
      : rankTags(facts).slice(0, 6),
    currentWorkspacePath: typeof record.currentWorkspacePath === "string" ? record.currentWorkspacePath : undefined,
    historyItemCount: typeof record.historyItemCount === "number" ? Math.max(0, Math.floor(record.historyItemCount)) : 0,
    inputFingerprint: typeof record.inputFingerprint === "string" ? record.inputFingerprint : undefined,
    processedTaskSignatures: Array.isArray(record.processedTaskSignatures)
      ? uniqueStrings(record.processedTaskSignatures.filter((value): value is string => typeof value === "string")).slice(0, MAX_HISTORY_ITEMS)
      : undefined,
  };
}

function createProfileInputFingerprint(input: UserProfileMemoryInput): string {
  const currentWorkspacePath = normalizeWhitespace(input.currentWorkspacePath ?? "");
  const recentWorkspacePaths = uniqueStrings(input.recentWorkspacePaths ?? []).map(normalizePathForFingerprint).sort();
  const taskSignatures = recentHistoryItems(input.history).map(taskSignature).sort();
  return [
    normalizePathForFingerprint(currentWorkspacePath),
    recentWorkspacePaths.join("|"),
    taskSignatures.join("|"),
  ].join("\n");
}

function recentHistoryItems(history: TaskSnapshot[]): TaskSnapshot[] {
  return [...history]
    .sort((a, b) => Date.parse(getTaskUpdatedAt(b)) - Date.parse(getTaskUpdatedAt(a)))
    .slice(0, MAX_HISTORY_ITEMS);
}

function taskSignature(task: TaskSnapshot): string {
  return [
    task.id,
    getTaskUpdatedAt(task),
    normalizeWhitespace(task.title),
    normalizeWhitespace(task.userGoal),
    normalizePathForFingerprint(getTaskWorkspacePath(task)),
    normalizePathForFingerprint(taskChangedFiles(task).join("|")),
  ].join(":");
}

function taskChangedFiles(task: TaskSnapshot): string[] {
  return uniqueStrings([
    ...(task.codeReviewPreview?.changedFiles ?? []),
    ...(task.codeProposedEdit?.changedFiles ?? []),
    ...(task.codeApplyResult?.changedFiles ?? []),
  ].map(normalizeWhitespace).filter(Boolean));
}

function rankTags(facts: UserProfileMemoryFact[]): string[] {
  const scores = new Map<string, number>();
  for (const fact of facts) {
    for (const tag of fact.tags) {
      scores.set(tag, (scores.get(tag) ?? 0) + fact.score);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function dedupeEvidence(evidence: UserProfileMemoryEvidence[]): UserProfileMemoryEvidence[] {
  const byKey = new Map<string, UserProfileMemoryEvidence>();
  for (const item of evidence) {
    const key = `${item.taskId ?? ""}:${item.snippet}`;
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()]
    .sort((a, b) =>
      b.observedAt.localeCompare(a.observedAt) ||
      b.matchedKeywords.length - a.matchedKeywords.length ||
      a.snippet.localeCompare(b.snippet),
    )
    .slice(0, MAX_EVIDENCE_PER_FACT);
}

function excerptAroundKeyword(text: string, keyword: string): string {
  const normalized = normalizeWhitespace(text);
  const index = normalized.toLocaleLowerCase().indexOf(keyword.toLocaleLowerCase());
  if (index < 0) return normalized.slice(0, 180);
  const start = Math.max(0, index - 70);
  return normalized.slice(start, start + 180);
}

function recencyScore(observedAt: string, now: string): number {
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(observedAt));
  if (!Number.isFinite(ageMs)) return 0.55;
  const ageDays = ageMs / 86_400_000;
  return clamp(1 / (1 + ageDays / 21), 0.28, 1);
}

function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function toIsoString(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return new Date().toISOString();
}

function samePath(a: string, b: string): boolean {
  return a.trim().replace(/\//g, "\\").toLocaleLowerCase() === b.trim().replace(/\//g, "\\").toLocaleLowerCase();
}

function normalizePathForFingerprint(value: string): string {
  return normalizeWhitespace(value).replace(/\//g, "\\").toLocaleLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isFactKind(value: unknown): value is UserProfileMemoryFactKind {
  return value === "current_focus" || value === "workspace_context" || value === "work_pattern" || value === "preference";
}

function isFactSource(value: unknown): value is UserProfileMemoryFactSource {
  return value === "history" || value === "workspace";
}
