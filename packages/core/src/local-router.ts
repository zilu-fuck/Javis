export type RouteLevel = "L1" | "L2" | "L3";

export type RouteMode = "direct_chat" | "single_agent_task" | "commander_dag";

export interface RouteDecision {
  level: RouteLevel;
  mode: RouteMode;
  score: number;
  reasons: string[];
}

export interface RouteLog {
  runId: string;
  inputPreview: string;
  routeLevel: RouteLevel;
  mode: RouteMode;
  complexityScore: number;
  reasons: string[];
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

  return { score, reasons };
}

export function routeMessage(input: string): RouteDecision {
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

  if (score <= 2 && !reasons.includes("tool_intent") && !reasons.includes("design_intent")) {
    return {
      level: "L1",
      mode: "direct_chat",
      score,
      reasons: [...reasons, "simple"],
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
    escalated: Boolean(flags.escalated),
    downgraded: Boolean(flags.downgraded),
    timestamp: Date.now(),
  };
}

function containsAny(input: string, patterns: string[]): boolean {
  const lower = input.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}
