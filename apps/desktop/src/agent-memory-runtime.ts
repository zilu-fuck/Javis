import type { TaskSnapshot } from "@javis/core";
import type {
  AgentMemoryRepository,
  AgentMemoryScopeType,
  AgentSessionSummary,
  MemoryInjectionType,
  SearchMemoryResult,
} from "./agent-memory";
import { extractAgentMemoryFactsFromSummary } from "./agent-memory-pipeline";
import { createAgentSessionSummaryFromTask } from "./agent-session-summary";

export type AgentMemoryScopeMode = "off" | "workspace" | "global_workspace";

export interface AgentMemoryPromptContextInjection {
  injectionType: MemoryInjectionType;
  memoryFactIds: string[];
  query?: string;
  scopeType?: AgentMemoryScopeType;
  scopeId?: string;
  promptSection: string;
  scoreSummary: Record<string, unknown>;
}

export async function buildAgentMemoryPromptContextFromRepository(input: {
  repository: Pick<AgentMemoryRepository, "searchMemory" | "listRecentSessionSummaries">;
  userGoal: string;
  taskId: string;
  memoryScope: AgentMemoryScopeMode;
  workspaceId?: string;
  userProfileFacts?: string[];
  recordInjection?: (injection: AgentMemoryPromptContextInjection) => Promise<void>;
}): Promise<string> {
  if (input.memoryScope === "off") {
    return "";
  }

  const workspaceId = input.workspaceId?.trim() || undefined;
  const [rawMemoryFacts, recentSummaries] = await Promise.all([
    searchScopedPromptFacts({
      repository: input.repository,
      userGoal: input.userGoal,
      memoryScope: input.memoryScope,
      workspaceId,
    }),
    listScopedRecentSummaries({
      repository: input.repository,
      memoryScope: input.memoryScope,
      workspaceId,
    }),
  ]);
  const memoryFacts = input.memoryScope === "workspace"
    ? rawMemoryFacts.filter((fact) => fact.scopeType === "workspace")
    : rawMemoryFacts.filter((fact) => fact.scopeType === "workspace" || fact.scopeType === "global");
  const userProfileFacts = (input.userProfileFacts ?? []).filter((fact) => fact.trim()).slice(0, 5);
  const promptContext = formatAgentMemoryPromptContext({
    userProfileFacts,
    memoryFacts,
    recentSummaries,
  });

  if (!promptContext) {
    return "";
  }

  if (input.recordInjection) {
    const auditWrites: Promise<void>[] = [];
    if (userProfileFacts.length > 0) {
      auditWrites.push(input.recordInjection({
        injectionType: "user_profile",
        memoryFactIds: [],
        promptSection: "User Profile",
        scoreSummary: { factCount: userProfileFacts.length },
      }));
    }
    if (memoryFacts.length > 0) {
      auditWrites.push(input.recordInjection({
        injectionType: "workspace_memory",
        memoryFactIds: memoryFacts.map((fact) => fact.id),
        query: input.userGoal,
        scopeType: workspaceId ? "workspace" : "global",
        scopeId: workspaceId,
        promptSection: "Workspace Memory",
        scoreSummary: {
          resultCount: memoryFacts.length,
          topScore: memoryFacts[0]?.score,
          scopeCounts: countMemoryFactScopes(memoryFacts),
        },
      }));
    }
    if (recentSummaries.length > 0) {
      auditWrites.push(input.recordInjection({
        injectionType: "recent_summary",
        memoryFactIds: [],
        scopeType: workspaceId ? "workspace" : input.memoryScope === "global_workspace" ? "global" : undefined,
        scopeId: workspaceId,
        promptSection: "Recent Session Summary",
        scoreSummary: { summaryCount: recentSummaries.length },
      }));
    }
    await Promise.all(auditWrites);
  }

  return promptContext;
}

export async function restoreAgentMemoryFromTaskHistory(input: {
  repository: Pick<AgentMemoryRepository, "saveSessionSummary" | "saveFact">;
  history: TaskSnapshot[];
  workspacePath: string;
  enabled: boolean;
}): Promise<{ summaryCount: number; factCount: number }> {
  if (!input.enabled) {
    return { summaryCount: 0, factCount: 0 };
  }
  let summaryCount = 0;
  let factCount = 0;
  for (const task of input.history) {
    const summary = createAgentSessionSummaryFromTask(task, input.workspacePath);
    if (!summary) {
      continue;
    }
    const savedSummary = await input.repository.saveSessionSummary(summary);
    summaryCount += 1;
    if (task.status !== "completed") {
      continue;
    }
    const facts = extractAgentMemoryFactsFromSummary(savedSummary);
    for (const fact of facts) {
      await input.repository.saveFact(fact);
      factCount += 1;
    }
  }
  return { summaryCount, factCount };
}

export function formatAgentMemoryPromptContext(input: {
  userProfileFacts: string[];
  memoryFacts: SearchMemoryResult[];
  recentSummaries: AgentSessionSummary[];
}): string {
  if (
    input.userProfileFacts.length === 0 &&
    input.memoryFacts.length === 0 &&
    input.recentSummaries.length === 0
  ) {
    return "";
  }
  const sections: string[] = [
    "Memory may be incomplete or outdated. Use it as context, not as unquestionable truth. If it conflicts with the latest user message, follow the latest user message.",
  ];
  if (input.userProfileFacts.length > 0) {
    sections.push([
      "[User Profile]",
      ...input.userProfileFacts.slice(0, 5).map((fact) => `- ${sanitizePromptMemoryLine(fact)}`),
    ].join("\n"));
  }
  if (input.memoryFacts.length > 0) {
    sections.push([
      "[Workspace Memory]",
      ...input.memoryFacts.slice(0, 5).map((fact) =>
        `- ${sanitizePromptMemoryLine(fact.fact)} (scope=${fact.scopeType}, kind=${fact.kind}, confidence=${fact.confidence.toFixed(2)}, importance=${fact.importance})`,
      ),
    ].join("\n"));
  }
  if (input.recentSummaries.length > 0) {
    sections.push([
      "[Recent Session Summary]",
      ...input.recentSummaries.slice(0, 2).map((summary) => `- ${sanitizePromptMemoryLine(summary.summary)}`),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

async function searchScopedPromptFacts(input: {
  repository: Pick<AgentMemoryRepository, "searchMemory">;
  userGoal: string;
  memoryScope: AgentMemoryScopeMode;
  workspaceId?: string;
}): Promise<SearchMemoryResult[]> {
  if (input.workspaceId) {
    return input.repository.searchMemory({
      query: input.userGoal,
      scopeType: "workspace",
      scopeId: input.workspaceId,
      limit: 5,
    });
  }
  if (input.memoryScope === "global_workspace") {
    return input.repository.searchMemory({
      query: input.userGoal,
      scopeType: "global",
      limit: 5,
    });
  }
  return [];
}

async function listScopedRecentSummaries(input: {
  repository: Pick<AgentMemoryRepository, "listRecentSessionSummaries">;
  memoryScope: AgentMemoryScopeMode;
  workspaceId?: string;
}): Promise<AgentSessionSummary[]> {
  if (input.workspaceId) {
    return input.repository.listRecentSessionSummaries(input.workspaceId, 2);
  }
  if (input.memoryScope === "global_workspace") {
    return input.repository.listRecentSessionSummaries(undefined, 2);
  }
  return [];
}

function sanitizePromptMemoryLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function countMemoryFactScopes(facts: SearchMemoryResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fact of facts) {
    counts[fact.scopeType] = (counts[fact.scopeType] ?? 0) + 1;
  }
  return counts;
}
