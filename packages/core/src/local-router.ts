import { inferSpecialistAgentHints, isCodebaseUnderstandingRequest } from "./agent-intent";
import type { RouteRegistry } from "./route-registry";
import { getTopRoutes } from "./routing";

export type RouteLevel = "L1" | "L2" | "L3";

export type RouteMode = "direct_chat" | "single_agent_task" | "commander_dag";

export interface CustomRouteMatch {
  route: string;
  workflowId: string;
  score: number;
  threshold: number;
  signals: string[];
}

export interface RouteDecision {
  level: RouteLevel;
  mode: RouteMode;
  score: number;
  reasons: string[];
  customRoute?: CustomRouteMatch;
}

export interface RouteLog {
  runId: string;
  inputPreview: string;
  routeLevel: RouteLevel;
  mode: RouteMode;
  complexityScore: number;
  reasons: string[];
  customRoute?: CustomRouteMatch;
  escalated: boolean;
  downgraded: boolean;
  timestamp: number;
}

export function scoreComplexity(input: string): { score: number; reasons: string[] } {
  const text = input.trim();
  let score = 0;
  const reasons: string[] = [];

  if (text.length > 100) {
    score += 1;
    reasons.push("long_input");
  }
  if (text.length > 300) {
    score += 1;
    reasons.push("very_long_input");
  }

  const toolPatterns = [
    "读取文件",
    "读文件",
    "总结文件",
    "总结这个文件",
    "总结这份文件",
    "搜索",
    "查一下",
    "帮我找",
    "打开",
    "运行",
    "执行",
    "创建",
    "删除",
    "修改",
    "read file",
    "summarize file",
    "search",
    "run",
    "execute",
    "create",
    "delete",
    "modify",
  ];
  if (containsAny(text, toolPatterns)) {
    score += 2;
    reasons.push("tool_intent");
  }

  const analysisPatterns = ["分析", "对比", "评估", "review", "analyze", "compare", "evaluate"];
  if (containsAny(text, analysisPatterns) && text.length > 50) {
    score += 1;
    reasons.push("analysis_intent");
  }

  const designPatterns = ["方案", "架构", "设计", "重构", "系统", "architecture", "design", "refactor"];
  if (containsAny(text, designPatterns)) {
    score += 2;
    reasons.push("design_intent");
  }

  if (/先.+(?:再|然后|最后)|first.+(?:then|finally)/i.test(text)) {
    score += 3;
    reasons.push("explicit_multi_step");
  }

  const questionCount = (text.match(/[?？]/g) || []).length;
  if (questionCount >= 2) {
    score += 2;
    reasons.push("multiple_questions");
  }

  if (/@[\w/-]+/.test(text) || /附件|文件路径|workspace|file path/i.test(text)) {
    score += 2;
    reasons.push("workspace_reference");
  }

  if (isCodebaseUnderstandingRequest(text)) {
    score += 4;
    reasons.push("codebase_understanding_intent");
  }

  const specialistHints = inferSpecialistAgentHints(text);
  if (specialistHints.length > 0) {
    score += 4;
    reasons.push("specialist_agent_intent");
    for (const hint of specialistHints) {
      reasons.push(hint.reason);
    }
  }

  return { score, reasons };
}

export function routeMessage(input: string, routeRegistry?: RouteRegistry): RouteDecision {
  const text = input.trim();
  if (!text) {
    return {
      level: "L1",
      mode: "direct_chat",
      score: 0,
      reasons: ["empty_input"],
    };
  }

  const { score, reasons } = scoreComplexity(text);
  const customRoute = getCustomRouteMatch(text, routeRegistry);
  const casualGreeting = isCasualGreeting(text);

  if (customRoute) {
    const requiresCommander = score > 5 ||
      reasons.includes("codebase_understanding_intent") ||
      reasons.includes("specialist_agent_intent");
    return {
      level: requiresCommander ? "L3" : "L2",
      mode: requiresCommander ? "commander_dag" : "single_agent_task",
      score,
      reasons: [...reasons, "custom_route", `custom_route:${customRoute.route}`],
      customRoute,
    };
  }

  if (reasons.includes("codebase_understanding_intent")) {
    return {
      level: "L3",
      mode: "commander_dag",
      score,
      reasons: [...reasons, "codebase_understanding"],
    };
  }

  if (reasons.includes("specialist_agent_intent")) {
    return {
      level: "L3",
      mode: "commander_dag",
      score,
      reasons: [...reasons, "specialist_agent"],
    };
  }

  if (score <= 2 && !reasons.includes("tool_intent") && !reasons.includes("design_intent")) {
    return {
      level: "L1",
      mode: "direct_chat",
      score,
      reasons: [...reasons, ...(casualGreeting ? ["casual_greeting"] : []), "simple"],
    };
  }

  if (score <= 5 && reasons.includes("tool_intent")) {
    return {
      level: "L2",
      mode: "single_agent_task",
      score,
      reasons: [...reasons, "tool_task"],
    };
  }

  return {
    level: "L3",
    mode: "commander_dag",
    score,
    reasons: [...reasons, "complex"],
  };
}

export function createRouteLog(
  runId: string,
  input: string,
  decision: RouteDecision,
  flags: { escalated?: boolean; downgraded?: boolean } = {},
): RouteLog {
  return {
    runId,
    inputPreview: input.trim().slice(0, 80),
    routeLevel: decision.level,
    mode: decision.mode,
    complexityScore: decision.score,
    reasons: decision.reasons,
    ...(decision.customRoute ? { customRoute: decision.customRoute } : {}),
    escalated: Boolean(flags.escalated),
    downgraded: Boolean(flags.downgraded),
    timestamp: Date.now(),
  };
}

function isCasualGreeting(input: string): boolean {
  return /^(?:(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))|(?:\u4f60\u597d|\u60a8\u597d|\u55e8|\u54c8\u55bd|\u65e9\u4e0a\u597d|\u4e0b\u5348\u597d|\u665a\u4e0a\u597d))(?:\u5440|\u554a)?[\s!,.?\u3002\uff01\uff0c\uff1f]*$/iu.test(input);
}

function getCustomRouteMatch(
  input: string,
  routeRegistry?: RouteRegistry,
): CustomRouteMatch | undefined {
  if (!routeRegistry) return undefined;
  // Built-in and workspace scores share one ordered list. A workspace route
  // wins only when it is the highest confident route; built-ins win ties.
  const [match] = getTopRoutes(input, undefined, 1, routeRegistry);
  if (!match) return undefined;
  const workflowId = routeRegistry.getWorkflowId(match.route);
  if (!workflowId) return undefined;
  return {
    route: match.route,
    workflowId,
    score: match.score,
    threshold: match.threshold ?? 2,
    signals: [...match.signals],
  };
}

function containsAny(input: string, patterns: string[]): boolean {
  const lower = input.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}
