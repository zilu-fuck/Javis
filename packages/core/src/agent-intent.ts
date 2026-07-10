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

  addHintIf(hints, /\u5b89\u5168|\u6f0f\u6d1e|\u6743\u9650|\u8ba4\u8bc1|\u6388\u6743|security|vulnerab|auth|csrf|xss|ssrf|injection/i.test(text), {
    agentKind: "security-reviewer",
    displayName: "Security Reviewer",
    capabilities: ["security_review", "code.searchRepository", "code.traceCallChain"],
    reason: "security_review_intent",
  });
  addHintIf(hints, /\u6784\u5efa\u5931\u8d25|\u7f16\u8bd1\u9519\u8bef|\u7c7b\u578b\u9519\u8bef|build failed|build failure|typecheck|compile error|compiler error/i.test(text), {
    agentKind: "build-fix",
    displayName: "Build Fix Agent",
    capabilities: ["build_fix", "shell.runReadOnlyCommand", "code.searchRepository"],
    reason: "build_fix_intent",
  });
  addHintIf(hints, /\u6d4b\u8bd5\u5931\u8d25|\u8dd1\u6d4b\u8bd5|\u5355\u6d4b|\u96c6\u6210\u6d4b\u8bd5|test failed|failing test|run tests|unit test|integration test/i.test(text), {
    agentKind: "test-runner",
    displayName: "Test Runner",
    capabilities: ["test_run", "shell.runReadOnlyCommand", "code.searchRepository"],
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
  addHintIf(hints, /\u8bed\u8a00\u7ea7|\u4ee3\u7801\u5ba1\u67e5|typescript|javascript|rust|python|java|go|c\+\+|language review/i.test(text) && /\u5ba1\u67e5|review|\u68c0\u67e5|\u5206\u6790/i.test(text), {
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

function shouldUseDocUpdater(text: string): boolean {
  const hasDocTarget = /\u6587\u6863|readme|changelog|adr|documentation|\bdocs?\b/i.test(text);
  const hasUpdateAction = /\u66f4\u65b0|\u8865|\u4fee\u6539|\u7f16\u5199|\u5199|\u751f\u6210|\u6574\u7406|update|write|edit|create|generate|maintain/i.test(text);
  return hasDocTarget && hasUpdateAction;
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
