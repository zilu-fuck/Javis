import type {
  WorkbenchAgent,
  WorkbenchAgentCapabilityScore,
  WorkbenchLocale,
  WorkbenchRepositorySearchResult,
  WorkbenchRepositoryTraceResult,
  WorkbenchTask,
  WorkbenchWorkspaceToolAction,
} from "../../types";
import { isChineseLocale, translateWorkbenchText } from "../../utils";
import { buildAgentDetailViewModel } from "./agent-detail-model";
import { agentIcon, agentKind, agentProgress, agentStatusLabel, normalizeStatus } from "./inspector-utils";

interface AgentDetailPanelProps {
  agent: WorkbenchAgent;
  labels: WorkbenchLocale["labels"];
  locale: WorkbenchLocale;
  onQuickAction?: (action: WorkbenchWorkspaceToolAction) => void;
  task: WorkbenchTask;
}

export function AgentDetailPanel({ agent, labels, locale, onQuickAction, task }: AgentDetailPanelProps) {
  const isChinese = isChineseLocale(locale);
  const viewModel = buildAgentDetailViewModel(task, agent);
  const quickTools = getAgentQuickTools(agentKind(agent), viewModel.artifacts.length);
  const repoSearchReport = agentKind(agent) === "code" ? task.repoSearchReport : undefined;
  const repoTraceReport = agentKind(agent) === "code" ? task.repoTraceReport : undefined;
  const repairPriority = agent.capabilityScore
    ? getRepairPrioritySummary(agent.capabilityScore)
    : null;

  return (
    <>
      <section className="javis-selected-agent-detail" aria-label={translateWorkbenchText(agent.name, locale)}>
        <div className="javis-agent-card-main">
          <span className={`javis-agent-icon agent-${agentKind(agent)}`}>{agentIcon(agent)}</span>
          <span className="javis-agent-name">{translateWorkbenchText(agent.name, locale)}</span>
          <span className={`javis-agent-status status-${normalizeStatus(agent.status)}`}>
            {agentStatusLabel(agent.status, locale)}
          </span>
        </div>
        <p>{translateWorkbenchText(agent.role, locale)}</p>
        <p>{translateWorkbenchText(agent.task, locale)}</p>
        <div className="javis-agent-progress" aria-hidden="true">
          <span style={{ width: `${agentProgress(agent.status)}%` }} />
        </div>
      </section>
      <section className="javis-task-overview" aria-label={isChinese ? "Agent \u8fd0\u884c\u8be6\u60c5" : "Agent run details"}>
        {agent.capabilityScore ? (
          <article className="javis-overview-card">
            <div className="javis-overview-card-header">
              <strong>{isChinese ? "\u80fd\u529b\u8bc4\u5206" : "Capability score"}</strong>
              <span>{agent.capabilityScore.score}/100 {agent.capabilityScore.status}</span>
            </div>
            <div className="javis-overview-stats">
              <div className="javis-stat-row">
                <span className="javis-stat-label">{isChinese ? "\u5df2\u5b9e\u73b0" : "Implemented"}</span>
                <span className="javis-stat-value">{formatCapabilitySignal(agent.capabilityScore.implemented)}</span>
              </div>
              <div className="javis-stat-row">
                <span className="javis-stat-label">{isChinese ? "\u6743\u9650" : "Permission"}</span>
                <span className="javis-stat-value">
                  {formatCapabilitySignal(agent.capabilityScore.permissionReady)}
                  <small>{agent.capabilityScore.highestPermissionLevel}</small>
                </span>
              </div>
              <div className="javis-stat-row">
                <span className="javis-stat-label">QA</span>
                <span className="javis-stat-value">{formatCapabilitySignal(agent.capabilityScore.qaPassed)}</span>
              </div>
              <div className="javis-stat-row">
                <span className="javis-stat-label">Live</span>
                <span className="javis-stat-value">{formatCapabilitySignal(agent.capabilityScore.liveVerified)}</span>
              </div>
              <div className="javis-stat-row">
                <span className="javis-stat-label">{isChinese ? "\u8fd1\u671f\u5931\u8d25" : "Recent failures"}</span>
                <span className="javis-stat-value">{formatFailureRate(agent.capabilityScore.recentFailureRate)}</span>
              </div>
              <div className="javis-stat-row">
                <span className="javis-stat-label">{isChinese ? "\u8bc1\u636e" : "Evidence"}</span>
                <CapabilityEvidenceRefs refs={agent.capabilityScore.evidenceRefs} />
              </div>
              {repairPriority ? (
                <div className="javis-stat-row">
                  <span className="javis-stat-label">{isChinese ? "\u4fee\u590d\u4f18\u5148\u7ea7" : "Repair priority"}</span>
                  <span className="javis-stat-value">
                    {repairPriority.label}
                    <small>{repairPriority.reason}</small>
                  </span>
                </div>
              ) : null}
            </div>
            {agent.capabilityScore.gaps.length > 0 ? (
              <p>{agent.capabilityScore.gaps.slice(0, 3).join("; ")}</p>
            ) : null}
          </article>
        ) : null}
        {viewModel.currentStep ? (
          <article className="javis-overview-card">
            <div className="javis-overview-card-header">
              <strong>{isChinese ? "\u5f53\u524d\u6b65\u9aa4" : "Current step"}</strong>
              <span className={`javis-badge status-${viewModel.currentStep.status}`}>{viewModel.currentStep.status}</span>
            </div>
            <p>{translateWorkbenchText(viewModel.currentStep.title, locale)}</p>
            {viewModel.currentStep.successCriteria ? (
              <p>{translateWorkbenchText(viewModel.currentStep.successCriteria, locale)}</p>
            ) : null}
            <StepHandoffSummary step={viewModel.currentStep} />
          </article>
        ) : null}
        {repoSearchReport ? (
          <RepositoryEvidenceCard report={repoSearchReport} isChinese={isChinese} />
        ) : null}
        {repoTraceReport ? (
          <RepositoryTraceCard report={repoTraceReport} isChinese={isChinese} />
        ) : null}
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{labels.plan}</strong>
            <span>{viewModel.steps.length}</span>
          </div>
          {viewModel.steps.length > 0 ? (
            <ol className="javis-task-step-list javis-agent-detail-step-list">
              {viewModel.steps.map((step) => (
                <li className={`javis-task-step javis-agent-detail-step status-${step.status}`} key={step.id}>
                  <span className="javis-task-step-main">
                    <strong>{translateWorkbenchText(step.title, locale)}</strong>
                    {step.successCriteria ? <small>{translateWorkbenchText(step.successCriteria, locale)}</small> : null}
                    <StepHandoffSummary step={step} />
                  </span>
                  <span className="javis-task-step-status">{step.status}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>{isChinese ? "\u6682\u65e0\u5173\u8054\u5230\u6b64 Agent \u7684\u6b65\u9aa4\u3002" : "No steps are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "\u76f8\u5173\u4e8b\u4ef6" : "Related events"}</strong>
            <span>{viewModel.logs.length}</span>
          </div>
          {viewModel.logs.length > 0 ? (
            <ol className="javis-task-step-list javis-agent-event-list">
              {viewModel.logs.map((log) => (
                <li className="javis-task-step javis-agent-event" key={log.id}>
                  <span className="javis-task-step-main">
                    <strong>{translateWorkbenchText(log.title, locale)}</strong>
                    <small>{translateWorkbenchText(getLogMessage(log), locale)}</small>
                  </span>
                  <span className="javis-task-step-status">{log.kind}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>{isChinese ? "\u6682\u65e0\u5173\u8054\u5230\u6b64 Agent \u7684\u4e8b\u4ef6\u3002" : "No events are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "\u76f8\u5173\u4ea7\u7269" : "Related artifacts"}</strong>
            <span>{viewModel.artifacts.length}</span>
          </div>
          {viewModel.artifacts.length > 0 ? (
            <div className="javis-overview-stats">
              {viewModel.artifacts.map((artifact) => (
                <div className="javis-stat-row" key={artifact.id}>
                  <span className="javis-stat-label">{artifact.kind}</span>
                  <span className="javis-stat-value">
                    {translateWorkbenchText(artifact.title, locale)}
                    {artifact.detail ? <small>{translateWorkbenchText(artifact.detail, locale)}</small> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p>{isChinese ? "\u6682\u65e0\u5173\u8054\u5230\u6b64 Agent \u7684\u4ea7\u7269\u3002" : "No artifacts are linked to this agent yet."}</p>
          )}
        </article>
        <article className="javis-overview-card">
          <div className="javis-overview-card-header">
            <strong>{isChinese ? "\u5feb\u6377\u5de5\u5177" : "Quick tools"}</strong>
            <span>{quickTools.length}</span>
          </div>
          <div className="javis-agent-tool-shortcuts">
            {quickTools.map((tool) => (
              <button
                className="javis-agent-tool-shortcut"
                key={tool}
                onClick={() => onQuickAction?.(tool)}
                type="button"
              >
                <span aria-hidden="true">{getToolIcon(tool)}</span>
                <strong>{getToolLabel(tool, isChinese)}</strong>
              </button>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function StepHandoffSummary({
  step,
}: {
  step: {
    inputContextKeys?: string[];
    outputContextKey?: string;
  };
}) {
  if (!step.inputContextKeys?.length && !step.outputContextKey) return null;
  return (
    <small className="javis-plan-step-handoff">
      {step.inputContextKeys?.length ? `in: ${step.inputContextKeys.join(", ")}` : null}
      {step.inputContextKeys?.length && step.outputContextKey ? " -> " : null}
      {step.outputContextKey ? `out: ${step.outputContextKey}` : null}
    </small>
  );
}

function RepositoryTraceCard({
  report,
  isChinese,
}: {
  report: WorkbenchRepositoryTraceResult;
  isChinese: boolean;
}) {
  const topEdges = report.edges.slice(0, 4);
  const topMatches = report.actualFound.slice(0, 3);
  const topModuleLinks = report.moduleLinks.slice(0, 3);
  const nodeLabels = new Map(report.nodes.map((node) => [node.id, node.label]));
  return (
    <article className="javis-overview-card">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "Repository trace" : "Repository trace"}</strong>
        <span>{report.edges.length} edge(s)</span>
      </div>
      <div className="javis-overview-stats">
        <div className="javis-stat-row">
          <span className="javis-stat-label">{isChinese ? "Target" : "Target"}</span>
          <span className="javis-stat-value">
            {report.target}
            <small>{report.direction}</small>
          </span>
        </div>
        <div className="javis-stat-row">
          <span className="javis-stat-label">{isChinese ? "Key files" : "Key files"}</span>
          <span className="javis-stat-value">
            {report.keyFiles.slice(0, 3).join(", ") || "none"}
          </span>
        </div>
        {report.attempts.slice(0, 3).map((attempt) => (
          <div className="javis-stat-row" key={`trace-attempt-${attempt.id}`}>
            <span className="javis-stat-label">attempt</span>
            <span className="javis-stat-value">
              {attempt.query}
              <small>{formatRepositoryAttemptDetail(attempt)}</small>
            </span>
          </div>
        ))}
        {topEdges.map((edge) => (
          <div className="javis-stat-row" key={`${edge.from}:${edge.to}:${edge.evidencePath}:${edge.line ?? 0}`}>
            <span className="javis-stat-label">{edge.relation}</span>
            <span className="javis-stat-value">
              {formatTraceEdge(edge, nodeLabels)}
              <small>
                {formatRepositoryLocation(edge.evidencePath, edge.line)} - confidence {edge.confidence.toFixed(2)}
              </small>
              {edge.moduleSpecifier ? (
                <small>
                  module {edge.moduleSpecifier}{edge.moduleKind ? ` (${edge.moduleKind})` : ""}
                </small>
              ) : null}
              <small>{edge.excerpt}</small>
            </span>
          </div>
        ))}
        {topModuleLinks.map((link) => (
          <div className="javis-stat-row" key={`trace-module-${link.specifier}`}>
            <span className="javis-stat-label">module</span>
            <span className="javis-stat-value">
              {link.specifier}
              <small>
                {link.kind} - imports {link.importCount}, exports {link.exportCount}, dynamic {link.dynamicImportCount}
              </small>
              <small>
                confidence {link.confidence.toFixed(2)} - {link.evidencePaths.slice(0, 2).join(", ")}
              </small>
              {link.resolutionStatus ? (
                <small>
                  {link.resolutionStatus}
                  {link.resolverProvider ? ` by ${link.resolverProvider}` : ""}
                  {link.resolvedPaths?.length ? ` - ${link.resolvedPaths.slice(0, 2).join(", ")}` : ""}
                  {link.resolutionError ? ` - ${link.resolutionError}` : ""}
                </small>
              ) : null}
              {link.packageHints?.slice(0, 2).map((hint) => (
                <small key={`package-hint-${link.specifier}-${hint.manifestPath}`}>
                  package {hint.name ?? hint.manifestPath}
                  {hint.main ? ` main=${hint.main}` : ""}
                  {hint.module ? ` module=${hint.module}` : ""}
                  {hint.types ? ` types=${hint.types}` : ""}
                  {hint.exports?.length ? ` exports=${hint.exports.slice(0, 2).join(", ")}` : ""}
                </small>
              ))}
            </span>
          </div>
        ))}
        {topMatches.map((match) => (
          <div className="javis-stat-row" key={`trace-match-${match.path}:${match.line ?? 0}:${match.excerpt}`}>
            <span className="javis-stat-label">actual</span>
            <span className="javis-stat-value">
              {formatRepositoryLocation(match.path, match.line)}
              <small>{match.excerpt}</small>
            </span>
          </div>
        ))}
        {report.inferred.slice(0, 2).map((item) => (
          <div className="javis-stat-row" key={`trace-inferred-${item}`}>
            <span className="javis-stat-label">inferred</span>
            <span className="javis-stat-value">{item}</span>
          </div>
        ))}
        {report.needsConfirmation.slice(0, 2).map((item) => (
          <div className="javis-stat-row" key={`trace-confirm-${item}`}>
            <span className="javis-stat-label">confirm</span>
            <span className="javis-stat-value">{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function RepositoryEvidenceCard({
  report,
  isChinese,
}: {
  report: WorkbenchRepositorySearchResult;
  isChinese: boolean;
}) {
  const topMatches = report.actualFound.slice(0, 3);
  const topClusters = report.clusters.slice(0, 3);
  const topTestFiles = report.relatedTestFiles.slice(0, 2);
  const topTestCandidates = report.testFileCandidates.slice(0, 2);
  return (
    <article className="javis-overview-card">
      <div className="javis-overview-card-header">
        <strong>{isChinese ? "Repository evidence" : "Repository evidence"}</strong>
        <span>{report.actualFound.length} matches</span>
      </div>
      <div className="javis-overview-stats">
        <div className="javis-stat-row">
          <span className="javis-stat-label">{isChinese ? "Key files" : "Key files"}</span>
          <span className="javis-stat-value">
            {report.keyFiles.slice(0, 3).join(", ") || "none"}
          </span>
        </div>
        {report.attempts.slice(0, 3).map((attempt) => (
          <div className="javis-stat-row" key={`search-attempt-${attempt.id}`}>
            <span className="javis-stat-label">attempt</span>
            <span className="javis-stat-value">
              {attempt.query}
              <small>{formatRepositoryAttemptDetail(attempt)}</small>
            </span>
          </div>
        ))}
        {report.semanticDiagnostics?.slice(0, 2).map((diagnostic) => (
          <div className="javis-stat-row" key={`semantic-${diagnostic.provider}-${diagnostic.status}`}>
            <span className="javis-stat-label">semantic</span>
            <span className="javis-stat-value">
              {diagnostic.provider}
              <small>
                {diagnostic.status} - {diagnostic.rerankedCount}/{diagnostic.candidateCount} candidate(s)
                {typeof diagnostic.durationMs === "number" ? ` - ${diagnostic.durationMs}ms` : ""}
                {diagnostic.error ? ` - ${diagnostic.error}` : ""}
              </small>
            </span>
          </div>
        ))}
        {topMatches.map((match) => (
          <div className="javis-stat-row" key={`${match.path}:${match.line ?? 0}:${match.excerpt}`}>
            <span className="javis-stat-label">actual</span>
            <span className="javis-stat-value">
              {formatRepositoryLocation(match.path, match.line)}
              <small>{match.excerpt}</small>
            </span>
          </div>
        ))}
        {topClusters.map((cluster) => (
          <div className="javis-stat-row" key={cluster.id}>
            <span className="javis-stat-label">cluster</span>
            <span className="javis-stat-value">
              {cluster.label}
              <small>{cluster.resultCount} result(s); {cluster.topTerms.join(", ")}</small>
            </span>
          </div>
        ))}
        {topTestFiles.map((path) => (
          <div className="javis-stat-row" key={`test-file-${path}`}>
            <span className="javis-stat-label">test</span>
            <span className="javis-stat-value">{path}</span>
          </div>
        ))}
        {topTestCandidates.map((path) => (
          <div className="javis-stat-row" key={`test-candidate-${path}`}>
            <span className="javis-stat-label">test?</span>
            <span className="javis-stat-value">{path}</span>
          </div>
        ))}
        {report.inferred.slice(0, 2).map((item) => (
          <div className="javis-stat-row" key={`inferred-${item}`}>
            <span className="javis-stat-label">inferred</span>
            <span className="javis-stat-value">{item}</span>
          </div>
        ))}
        {report.needsConfirmation.slice(0, 2).map((item) => (
          <div className="javis-stat-row" key={`confirm-${item}`}>
            <span className="javis-stat-label">confirm</span>
            <span className="javis-stat-value">{item}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function formatRepositoryLocation(path: string, line?: number): string {
  return typeof line === "number" && line > 0 ? `${path}:${line}` : path;
}

function formatRepositoryAttemptDetail(attempt: {
  reason: string;
  resultCount?: number;
  status?: "completed" | "failed";
  durationMs?: number;
  error?: string;
  errorKind?: "timeout" | "unavailable" | "permission" | "cancelled" | "unknown";
  provider?: string;
  retryCount?: number;
}): string {
  const parts: string[] = [];
  if (attempt.status) {
    parts.push(attempt.status);
  }
  if (attempt.provider) {
    parts.push(attempt.provider);
  }
  if (typeof attempt.resultCount === "number") {
    parts.push(`${attempt.resultCount} result(s)`);
  }
  if (typeof attempt.durationMs === "number") {
    parts.push(`${attempt.durationMs}ms`);
  }
  if (typeof attempt.retryCount === "number" && attempt.retryCount > 0) {
    parts.push(`${attempt.retryCount} retry`);
  }
  parts.push(attempt.reason);
  if (attempt.errorKind) {
    parts.push(`kind: ${attempt.errorKind}`);
  }
  if (attempt.error) {
    parts.push(`error: ${attempt.error}`);
  }
  return parts.join(" - ");
}

function formatTraceEdge(
  edge: WorkbenchRepositoryTraceResult["edges"][number],
  nodeLabels: ReadonlyMap<string, string>,
): string {
  return `${nodeLabels.get(edge.from) ?? edge.from} -> ${nodeLabels.get(edge.to) ?? edge.to}`;
}

function getAgentQuickTools(agentKindValue: string, artifactCount: number): WorkbenchWorkspaceToolAction[] {
  switch (agentKindValue) {
    case "code":
      return ["review", "terminal", "files"];
    case "command":
      return ["terminal", "files"];
    case "computer":
      return ["browser", "terminal", "files"];
    case "browser":
      return ["browser", "files", "sideChat"];
    case "research":
      return ["browser", "sideChat"];
    case "file":
      return ["files", artifactCount > 0 ? "sideChat" : "terminal"];
    default:
      return ["sideChat", "files"];
  }
}

function formatCapabilitySignal(value: boolean): string {
  return value ? "pass" : "pending";
}

function formatFailureRate(value: number | undefined): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%`;
}

function getRepairPrioritySummary(score: WorkbenchAgentCapabilityScore): { label: string; reason: string } {
  let priorityScore = 0;
  const reasons: string[] = [];
  if (!score.implemented) {
    priorityScore += 100;
    reasons.push("implementation");
  }
  if (!score.permissionReady) {
    priorityScore += 90;
    reasons.push("permission");
  }
  if (!score.liveVerified) {
    priorityScore += 50;
    reasons.push("live evidence");
  }
  if (!score.qaPassed) {
    priorityScore += 40;
    reasons.push("QA evidence");
  }
  if (score.recentFailureRate >= 0.5) {
    priorityScore += 35;
    reasons.push("recent failures");
  } else if (score.recentFailureRate >= 0.2) {
    priorityScore += 20;
    reasons.push("recent failures");
  } else if (score.recentFailureRate > 0) {
    priorityScore += 10;
    reasons.push("recent failures");
  }
  if (score.highestPermissionLevel === "dangerous") {
    priorityScore += 15;
    reasons.push("dangerous permission");
  } else if (score.highestPermissionLevel === "confirmed_write") {
    priorityScore += 10;
    reasons.push("confirmed write");
  }
  if (priorityScore <= 0) {
    return { label: "none", reason: "no open repair signals" };
  }
  const label = priorityScore >= 120
    ? "critical"
    : priorityScore >= 80
      ? "high"
      : priorityScore >= 40
        ? "medium"
        : "low";
  return {
    label,
    reason: reasons.slice(0, 3).join(", ") || "capability gap",
  };
}

function CapabilityEvidenceRefs({ refs }: { refs: readonly string[] }) {
  const visibleRefs = refs.slice(0, 3);
  const remaining = refs.length - visibleRefs.length;
  return (
    <span className="javis-stat-value">
      {refs.length}
      {visibleRefs.map((ref) => <small key={ref}>{ref}</small>)}
      {remaining > 0 ? <small>+{remaining} more</small> : null}
    </span>
  );
}

function getToolLabel(tool: WorkbenchWorkspaceToolAction, isChinese: boolean): string {
  if (isChinese) {
    switch (tool) {
      case "browser": return "\u6d4f\u89c8\u5668";
      case "files": return "\u6587\u4ef6";
      case "review": return "\u5ba1\u67e5";
      case "sideChat": return "\u4fa7\u804a";
      case "terminal": return "\u7ec8\u7aef";
      default: return tool;
    }
  }
  switch (tool) {
    case "browser": return "Browser";
    case "files": return "Files";
    case "review": return "Review";
    case "sideChat": return "Side chat";
    case "terminal": return "Terminal";
    default: return tool;
  }
}

function getLogMessage(log: { userMessage?: string; detail: string }): string {
  const userMessage = log.userMessage?.trim();
  if (userMessage && !looksLikeStructuredText(userMessage)) {
    return userMessage;
  }
  return log.detail;
}

function looksLikeStructuredText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /\"(?:plan|toolName|assignedAgentKind|successCriteria)\"/.test(trimmed);
}

function getToolIcon(tool: WorkbenchWorkspaceToolAction): string {
  switch (tool) {
    case "browser": return "B";
    case "files": return "F";
    case "review": return "R";
    case "sideChat": return "S";
    case "terminal": return ">";
    default: return "+";
  }
}
