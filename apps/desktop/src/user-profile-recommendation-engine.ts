import type { WorkbenchNewChatRecommendations, WorkbenchRecommendationItem } from "@javis/ui";
import {
  type RecommendationLocale,
  type UserProfileMemory,
  type UserProfileMemoryFact,
} from "./user-profile-memory";
import { TOPIC_RULES, type TopicRule } from "./user-profile-rules";

const MIN_PROFILE_CONFIDENCE = 0.4;
const MIN_PROFILE_SCORE = 0.22;
const PRIMARY_RECOMMENDATION_LIMIT = 5;

export function createNewChatRecommendations(
  memory: UserProfileMemory | null | undefined,
  locale: RecommendationLocale,
): WorkbenchNewChatRecommendations {
  const isZh = locale === "zh";
  const facts = memory?.facts ?? [];
  const byTag = createBestFactByTag(facts);
  const currentWorkspacePath = memory?.summary.currentWorkspacePath;

  const primary = TOPIC_RULES
    .map((rule) => createTopicRecommendation(rule, byTag.get(rule.tag), isZh))
    .filter((item): item is WorkbenchRecommendationItem => Boolean(item))
    .sort(compareRecommendations);

  const secondary = [
    recommendationItemWithEvidence(
      "progress-summary",
      isZh ? "梳理最近项目进度" : "Summarize recent project progress",
      isZh
        ? "根据最近历史和当前工作区，梳理 workbench、UI 美化、computer use 改造分别完成了什么、还差什么。"
        : "Use recent history and the current workspace to summarize what changed and what remains for workbench, UI polish, and computer use.",
      "profile",
      bestFactForTags(byTag, ["workbench", "ui", "computer-use", "implementation"]),
    ),
    recommendationItemWithEvidence(
      "recommendation-audit",
      isZh ? "审查推荐是否准确" : "Audit recommendation quality",
      isZh
        ? "检查新聊天推荐栏是否真的来自用户侧写、最近工作内容和当前工作区，并指出还缺哪些证据。"
        : "Check whether the new-chat recommendation bar really comes from user profile, recent work, and workspace context, then identify missing evidence.",
      "profile",
      bestFactForTags(byTag, ["memory", "workbench"]),
    ),
    recommendationItemWithEvidence(
      "computer-use-test-plan",
      isZh ? "补 computer use 测试" : "Extend computer-use tests",
      isZh
        ? "围绕 computer use 的路由、审批、屏幕/浏览器工具和执行循环补最小测试，确认改造没有回退。"
        : "Add focused tests around computer-use routing, approvals, screen/browser tools, and the action loop to prevent regressions.",
      "history",
      bestFactForTags(byTag, ["computer-use", "verification"]),
    ),
    recommendationItemWithEvidence(
      "verify-current-project",
      isZh ? "验证当前项目状态" : "Verify current project state",
      isZh
        ? "运行当前项目可用的验证命令，确认构建、测试和关键界面状态是否正常。"
        : "Run available verification commands for the current project and report build, test, and key UI status.",
      "workspace",
      bestFactForTags(byTag, ["verification", "implementation", "workspace"]),
    ),
  ].filter((item): item is WorkbenchRecommendationItem => Boolean(item));

  return {
    primary: fillPrimary(primary, isZh, currentWorkspacePath),
    secondary: secondary.slice(0, 4),
  };
}

function createBestFactByTag(facts: UserProfileMemoryFact[]): Map<string, UserProfileMemoryFact> {
  const byTag = new Map<string, UserProfileMemoryFact>();
  for (const fact of facts) {
    for (const tag of fact.tags) {
      const current = byTag.get(tag);
      if (!current || compareFacts(fact, current) < 0) {
        byTag.set(tag, fact);
      }
    }
  }
  return byTag;
}

function createTopicRecommendation(
  rule: TopicRule,
  fact: UserProfileMemoryFact | undefined,
  isZh: boolean,
): WorkbenchRecommendationItem | null {
  if (!fact || fact.confidence < MIN_PROFILE_CONFIDENCE || fact.score < MIN_PROFILE_SCORE) return null;
  return recommendationItem(
    `${rule.tag}-recommendation`,
    recommendationLabel(rule.tag, isZh),
    isZh ? rule.promptZh : rule.promptEn,
    fact.source === "workspace" ? "workspace" : fact.kind === "work_pattern" ? "history" : "profile",
    {
      ...fact,
      text: isZh ? rule.zhText : rule.enText,
    },
  );
}

function recommendationItem(
  id: string,
  label: string,
  prompt: string,
  source: WorkbenchRecommendationItem["source"],
  fact?: UserProfileMemoryFact,
): WorkbenchRecommendationItem {
  return {
    id,
    label,
    prompt,
    source,
    confidence: fact ? recommendationConfidence(fact) : undefined,
    reason: fact ? fact.text : undefined,
    evidence: fact?.evidence.map((item) => ({
      title: item.title,
      snippet: item.snippet,
      observedAt: item.observedAt,
      matchedKeywords: item.matchedKeywords,
    })),
  };
}

function recommendationItemWithEvidence(
  id: string,
  label: string,
  prompt: string,
  source: WorkbenchRecommendationItem["source"],
  fact?: UserProfileMemoryFact,
): WorkbenchRecommendationItem | null {
  if (!fact || fact.evidence.length === 0) return null;
  return recommendationItem(id, label, prompt, source, fact);
}

function bestFactForTags(
  byTag: Map<string, UserProfileMemoryFact>,
  tags: string[],
): UserProfileMemoryFact | undefined {
  return tags
    .map((tag) => byTag.get(tag))
    .filter((fact): fact is UserProfileMemoryFact => Boolean(fact))
    .sort(compareFacts)[0];
}

function fillPrimary(
  items: WorkbenchRecommendationItem[],
  isZh: boolean,
  currentWorkspacePath: string | undefined,
): WorkbenchRecommendationItem[] {
  const filled = uniqueRecommendations(items).slice(0, PRIMARY_RECOMMENDATION_LIMIT);
  if (filled.length > 0) {
    return filled;
  }

  const defaults = contextualDefaults(isZh, currentWorkspacePath);
  return defaults.slice(0, PRIMARY_RECOMMENDATION_LIMIT);
}

function contextualDefaults(
  isZh: boolean,
  currentWorkspacePath: string | undefined,
): WorkbenchRecommendationItem[] {
  const isJavisWorkspace = (currentWorkspacePath ?? "").toLocaleLowerCase().includes("javis");
  const javisDefaults = isZh
    ? [
        recommendationItem("fallback-workbench", "继续 workbench 改造", "检查 Javis workbench 最近改动，找出新聊天推荐栏和工作区体验下一处最值得优化的点。", "default"),
        recommendationItem("fallback-ui", "继续 UI 美化", "对 Javis 当前界面做一次视觉一致性检查，优先处理推荐栏、侧边栏和图标尺寸。", "default"),
        recommendationItem("fallback-computer-use", "检查 computer use", "检查 computer use 改造的路由、审批和执行循环，补一处最关键的验证。", "default"),
      ]
    : [
        recommendationItem("fallback-workbench", "Continue workbench work", "Inspect recent Javis workbench changes and find the next useful improvement for new-chat recommendations or workspace UX.", "default"),
        recommendationItem("fallback-ui", "Continue UI polish", "Review the current Javis UI for visual consistency, prioritizing recommendations, sidebars, and icon sizing.", "default"),
        recommendationItem("fallback-computer-use", "Check computer use", "Inspect computer-use routing, approvals, and the action loop, then add the most important verification.", "default"),
      ];
  if (isJavisWorkspace) return javisDefaults;
  return isZh
    ? [
        recommendationItem("fallback-task", "创建任务", "帮我规划一个任务，并拆解成可执行步骤。", "default"),
        recommendationItem("fallback-code", "编写代码", "帮我实现一个功能，并说明改动点和验证方式。", "default"),
        recommendationItem("fallback-more", "更多", "列出你可以在当前工作区帮我完成的事情。", "default"),
      ]
    : [
        recommendationItem("fallback-task", "Create task", "Plan a task and break it into executable steps.", "default"),
        recommendationItem("fallback-code", "Write code", "Implement a feature and summarize the changes and verification.", "default"),
        recommendationItem("fallback-more", "More", "List what you can help with in this workspace.", "default"),
      ];
}

function recommendationLabel(tag: string, isZh: boolean): string {
  const labels: Record<string, [string, string]> = {
    workbench: ["继续 workbench 推荐栏", "Continue workbench recommendations"],
    ui: ["继续 UI 美化", "Continue UI polish"],
    "computer-use": ["继续 computer use 改造", "Continue computer-use work"],
    memory: ["完善侧写推荐", "Refine profile recommendations"],
    implementation: ["落地当前需求", "Implement current request"],
    verification: ["验证项目状态", "Verify project state"],
    "local-knowledge": ["整理本地知识库", "Organize local knowledge"],
    research: ["对照 study 方案", "Compare study patterns"],
  };
  const pair = labels[tag] ?? [tag, tag];
  return isZh ? pair[0] : pair[1];
}

function uniqueRecommendations(items: WorkbenchRecommendationItem[]): WorkbenchRecommendationItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compareRecommendations(a: WorkbenchRecommendationItem, b: WorkbenchRecommendationItem): number {
  return (b.confidence ?? 0) - (a.confidence ?? 0) || a.id.localeCompare(b.id);
}

function recommendationConfidence(fact: UserProfileMemoryFact): number {
  return Math.min(fact.confidence, fact.score);
}

function compareFacts(a: UserProfileMemoryFact, b: UserProfileMemoryFact): number {
  return (
    b.score - a.score ||
    b.confidence - a.confidence ||
    b.lastSeenAt.localeCompare(a.lastSeenAt) ||
    a.id.localeCompare(b.id)
  );
}
