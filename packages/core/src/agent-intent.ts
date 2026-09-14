import { inferVisionMode, isImageContentAnalysisRequest } from "./vision-utils";

export interface AgentRoutingHint {
  agentKind: string;
  displayName: string;
  capabilities: string[];
  reason: string;
}

export function isCodebaseUnderstandingRequest(text: string): boolean {
  const hasCodebaseSubject = /\u9879\u76ee|\u5de5\u7a0b|\u4ee3\u7801\u5e93|\u4ed3\u5e93|repo|repository|codebase|source code|\u6e90\u7801|\u5b9e\u9645\u4ee3\u7801|\u4ee3\u7801\u60c5\u51b5|readme|\u5165\u53e3|\u6a21\u5757|\u67b6\u6784/i.test(text);
  const asksForUnderstanding = /\u5e72\u561b|\u505a\u4ec0\u4e48|\u529f\u80fd|\u60c5\u51b5|\u770b\u770b|\u5206\u6790|\u68b3\u7406|\u8bf4\u660e|\u7406\u89e3|\u9605\u8bfb|\u4e0d\u8981\u5149\u770b|\u522b\u53ea\u770b|\u7ed3\u5408\u5b9e\u9645|\u5b9e\u9645.*\u60c5\u51b5|understand|inspect|explain|what.*does|purpose|architecture/i.test(text);
  return hasCodebaseSubject && asksForUnderstanding;
}

export function inferSpecialistAgentHints(text: string): AgentRoutingHint[] {
  const hints: AgentRoutingHint[] = [];

  const visionMode = inferVisionMode(text);
  addHintIf(hints, isImageContentAnalysisRequest(text), {
    agentKind: "vision",
    displayName: "Vision Agent",
    capabilities: visionMode === "ocr"
      ? ["image_ocr", "vision.extractText"]
      : visionMode === "describe"
        ? ["image_describe", "vision.describe"]
        : ["image_analyze", "vision.analyze"],
    reason: visionMode === "ocr"
      ? "image_ocr_intent"
      : visionMode === "describe"
        ? "image_description_intent"
        : "image_analysis_intent",
  });

  addHintIf(hints, /\u5b89\u5168|\u6f0f\u6d1e|\u6743\u9650|\u8ba4\u8bc1|\u6388\u6743|security|vulnerab|auth|csrf|xss|ssrf|injection/i.test(text), {
    agentKind: "security-reviewer",
    displayName: "Security Reviewer",
    capabilities: ["security_review", "code.searchRepository", "code.traceCallChain"],
    reason: "security_review_intent",
  });
  addHintIf(hints, /\u6784\u5efa(?:\u5931\u8d25|\u9519\u8bef)|\u7f16\u8bd1\u9519\u8bef|\u7c7b\u578b\u9519\u8bef|build failed|build failure|build error|type[ -]?check(?: failed| failure| error)|failed type[ -]?check|compile error|compiler error/i.test(text), {
    agentKind: "build-fix",
    displayName: "Build Fix Agent",
    capabilities: ["build_fix", "shell.runReadOnlyCommand", "code.searchRepository"],
    reason: "build_fix_intent",
  });
  addHintIf(hints, /\u6d4b\u8bd5\u5931\u8d25|\u8dd1(?:\u4e00\u4e0b|\u4e0b)?[^\n]{0,12}\u6d4b\u8bd5|\u5355\u6d4b|\u96c6\u6210\u6d4b\u8bd5|\u7c7b\u578b\u68c0\u67e5|\u7c7b\u578b\u6821\u9a8c|test failed|failing test|run tests?|unit tests?|integration tests?|type[ -]?check/i.test(text), {
    agentKind: "test-runner",
    displayName: "Test Runner",
    capabilities: ["test_run", "shell.runWorkspaceCommand", "code.searchRepository"],
    reason: "test_run_intent",
  });
  addHintIf(hints, shouldUseDocUpdater(text), {
    agentKind: "doc-updater",
    displayName: "Doc Updater",
    capabilities: ["doc_update", "file.scanMarkdownDocuments", "code.searchRepository"],
    reason: "doc_update_intent",
  });
  addHintIf(hints, /\u6027\u80fd|\u6162|\u5361\u987f|\u5ef6\u8fdf|\u541e\u5410|performance|latency|slow|benchmark|profil/i.test(text), {
    agentKind: "perf-analyzer",
    displayName: "Performance Analyzer",
    capabilities: ["performance_analysis", "code.searchRepository", "shell.runReadOnlyCommand"],
    reason: "performance_analysis_intent",
  });
  addHintIf(hints, /\u91cd\u6784|\u884c\u4e3a\u4e0d\u53d8|refactor|cleanup|clean up|technical debt/i.test(text), {
    agentKind: "refactor",
    displayName: "Refactor Agent",
    capabilities: ["refactor", "code.searchRepository", "code.proposeEdit"],
    reason: "refactor_intent",
  });
  const hasLanguageSubject = /\u8bed\u8a00\u7ea7|\u4ee3\u7801\u5ba1\u67e5|typescript|javascript|rust|python|java|go|c\+\+|language review/i.test(text);
  const hasLanguageReviewIntent = /\u5ba1\u67e5|review|\u68c0\u67e5|\u5206\u6790|\u89c4\u8303|\u60ef\u7528|\u5730\u9053|\u5199\u5f97.{0,6}(?:\u600e\u4e48\u6837|\u5982\u4f55|\u597d\u4e0d\u597d)|\u4ee3\u7801\u8d28\u91cf|idiom|best practice/i.test(text);
  const isLanguageCheckCommand = /\u7c7b\u578b\u68c0\u67e5|\u7c7b\u578b\u6821\u9a8c|type[ -]?check/i.test(text);
  addHintIf(hints, hasLanguageSubject && hasLanguageReviewIntent && !isLanguageCheckCommand, {
    agentKind: "language-reviewer",
    displayName: "Language Reviewer",
    capabilities: ["language_review", "code.searchRepository", "code.traceCallChain"],
    reason: "language_review_intent",
  });
  addHintIf(hints, /\u8c03\u7528\u94fe|\u5165\u53e3|\u6a21\u5757\u5173\u7cfb|\u5b9a\u4f4d.*\u5b9e\u73b0|call chain|entrypoint|trace|where.*implemented/i.test(text), {
    agentKind: "explorer",
    displayName: "Explorer",
    capabilities: ["code_explore", "code.searchRepository", "code.traceCallChain"],
    reason: "code_explore_intent",
  });

  return uniqueHints(hints);
}

export function isSpecialistAgentRequest(text: string): boolean {
  return inferSpecialistAgentHints(text).length > 0;
}

/** The first hint is the primary specialist; later hints may assist independently. */
export function inferPrimarySpecialistAgentHint(text: string): AgentRoutingHint | undefined {
  return inferSpecialistAgentHints(text)[0];
}

export function requiresExplicitTargetClarification(
  text: string,
  context: { hasResolvedTarget?: boolean } = {},
): boolean {
  if (context.hasResolvedTarget) return false;
  const hasAmbiguousCodeReference = /\u8fd9(?:\u5757|\u6bb5|\u90e8\u5206|\u5904)(?:\u4ee3\u7801|\u5b9e\u73b0)|\u8fd9\u4e2a(?:\u51fd\u6570|\u6587\u4ef6|\u6a21\u5757|\u7c7b)|\u8fd9\u91cc(?:\u7684)?(?:\u4ee3\u7801|\u5b9e\u73b0)|this (?:code|function|file|module|class|implementation)/i.test(text);
  const hasAmbiguousFileAction = /(?:\u5904\u7406|\u4fee\u6539|\u7f16\u8f91|\u4fee\u590d|\u5220\u9664|\u79fb\u52a8|\u6574\u7406).{0,10}(?:\u90a3\u4e2a|\u8fd9\u4e2a|\u8fd9\u4efd|\u4e0a\u8ff0)\u6587\u4ef6|(?:\u90a3\u4e2a|\u8fd9\u4e2a|\u8fd9\u4efd|\u4e0a\u8ff0)\u6587\u4ef6.{0,10}(?:\u5904\u7406|\u4fee\u6539|\u7f16\u8f91|\u4fee\u590d|\u5220\u9664|\u79fb\u52a8|\u6574\u7406)|(?:process|modify|edit|fix|delete|move|organize) (?:that|this) file|(?:that|this) file.{0,20}(?:process|modify|edit|fix|delete|move|organize)/i.test(text);
  if (!hasAmbiguousCodeReference && !hasAmbiguousFileAction) return false;
  const hasConcretePath = /(?:^|[\s'"`(])(?:[A-Za-z]:[\\/]|\.?\.?[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]+(?:$|[\s'"`),:;])/u.test(text) ||
    /(?:^|[\s'"`(])[\w.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|toml|yaml|yml)(?:$|[\s'"`),:;])/iu.test(text);
  return !hasConcretePath;
}

/** Longest message still treated as a pure self-capability question. */
export const SELF_CAPABILITY_QUESTION_MAX_CHARS = 40;

const SELF_CAPABILITY_QUESTION_ZH_PATTERNS: readonly RegExp[] = [
  // 你会（帮我）做（些）什么 / 你能干什么 / 你会做哪些事
  /^(?:请问|问下|想问下|说说|说说看|介绍一下)?(?:你|您)(?:都|还|到底|具体|究竟|平时|现在)?(?:会|能|可以|能够|擅长)(?:帮|给|为|替)?(?:我|我们|用户)?(?:做|干|提供|完成|搞|处理)?(?:些|哪些|一点)?(?:什么|啥|嘛)?(?:事情|事|工作|任务|活|东西|能力|功能)?(?:呢|啊|呀|吧)?$/u,
  // 你（都）有什么能力 / 具备哪些功能
  /^(?:请问)?(?:你|您)(?:都|还|到底|具体|究竟)?(?:有|具备)(?:些|哪些|什么|啥)?(?:能力|本领|功能|技能|特长)(?:呢|啊|呀)?$/u,
  // 你的能力是什么
  /^(?:请问)?(?:你|您)(?:的)?(?:能力|本领|功能|技能)(?:是|都有|有哪些|有什么)(?:什么|哪些)?(?:呢|啊)?$/u,
  // 介绍一下你自己 / 说说你的能力
  /^(?:请|麻烦)?(?:简单|简要|大概)?(?:介绍|说说|讲讲|聊聊|讲下|说下)(?:一下|下)?(?:你|您)(?:自己)?(?:的)?(?:能力|功能|定位|角色)?(?:呢|吧)?$/u,
  // 你是谁
  /^(?:请问)?(?:你|您)(?:是|叫)(?:谁|什么|啥|什么名字)(?:呢|啊)?$/u,
];

const SELF_CAPABILITY_QUESTION_EN_PATTERN =
  /^(?:please\s+|hey\s+|hi\s+)?(?:what\s+(?:can|do|are)\s+you(?:\s+(?:do|able\s+to\s+do|capable\s+of|good\s+at|help\s+(?:me\s+)?with|do\s+for\s+(?:me|us)))?|who\s+are\s+you|what\s+are\s+your\s+(?:capabilit(?:y|ies)|skills?|abilities|features)|tell\s+me\s+about\s+yourself)\??$/i;

/**
 * A pure question about the assistant itself ("你会做些什么", "what can you do").
 *
 * The planner prompt tells the Commander to ask before guessing when a goal is
 * ambiguous, and a capability question trivially qualifies: it names no target,
 * no workspace and no artifact. That is the wrong reading of the rule — every
 * fact the answer needs already lives in the runtime (agents, tools, permission
 * model) — and it buys a round trip that returns no information. Observed:
 * "你会做些什么" planned a single `clarify-capability-scope` step asking
 * "你希望我协助哪类任务？" instead of answering.
 *
 * Deliberately narrow: the whole (short) message must be the question, so a real
 * task that merely mentions capabilities — "你能做什么，顺便帮我建个文件" — keeps
 * whatever plan the Commander produces.
 */
export function isSelfCapabilityQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > SELF_CAPABILITY_QUESTION_MAX_CHARS) {
    return false;
  }
  if (SELF_CAPABILITY_QUESTION_EN_PATTERN.test(trimmed.replace(/\s+/g, " "))) {
    return true;
  }
  // Chinese probes are compared without spaces or trailing punctuation, so
  // "你会做些什么？" and "你会做些什么" hit the same pattern.
  const compact = trimmed.replace(/[\s\u3000]+/gu, "").replace(/[?？。.!！,，、~～…]+$/u, "");
  return SELF_CAPABILITY_QUESTION_ZH_PATTERNS.some((pattern) => pattern.test(compact));
}

function shouldUseDocUpdater(text: string): boolean {
  const hasDocTarget = /\u6587\u6863|readme|changelog|adr|documentation|\bdocs?\b/i.test(text);
  const hasUpdateAction = /\u66f4\u65b0|\u8865|\u4fee\u6539|\u7f16\u5199|\u5199|\u751f\u6210|\u6574\u7406|update|write|edit|create|generate|maintain/i.test(text);
  const hasReviewAction = /\u5bf9\u5f97\u4e0a|\u4e00\u81f4|\u8fc7\u65f6|\u51c6\u786e|\u68c0\u67e5|\u5ba1\u67e5|match|consistent|outdated|accurate|review/i.test(text);
  return hasDocTarget && (hasUpdateAction || hasReviewAction);
}

function addHintIf(
  hints: AgentRoutingHint[],
  condition: boolean,
  hint: AgentRoutingHint,
) {
  if (condition) {
    hints.push(hint);
  }
}

function uniqueHints(hints: AgentRoutingHint[]): AgentRoutingHint[] {
  const seen = new Set<string>();
  const result: AgentRoutingHint[] = [];
  for (const hint of hints) {
    if (seen.has(hint.agentKind)) {
      continue;
    }
    seen.add(hint.agentKind);
    result.push(hint);
  }
  return result;
}
