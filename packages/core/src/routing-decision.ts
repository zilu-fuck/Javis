/**
 * Agent routing decisions, as a visible object (D1).
 *
 * Routing already happens — a step's capability tags pick an agent, and the agent's
 * requirements pick a model — but the *decision* is not a thing anyone can look at.
 * When a step runs on the wrong agent, or a vision task lands on a text-only model, the
 * only evidence is an outcome that looks slightly wrong.
 *
 * `AgentRuntimeRoutingDecision` covers the execution *backend* (which kernel runs the
 * step). This module covers the layer above it: which agent kind, and why — including
 * **why each alternative was rejected**, because "why not the explorer?" is the question
 * that actually gets asked.
 *
 * The rule that shapes the design: an agent that lacks a *required* capability is not a
 * lower-scoring candidate, it is **ineligible**. Likewise a model that cannot hold the
 * context, or one that has no vision when the step carries an image. Mixing those into a
 * score would produce a confident-looking answer that silently routes a vision step to a
 * blind model.
 */

export interface RoutingCandidate {
  agentKind: string;
  capabilityTags: readonly string[];
  modelRequirements?: {
    prefersVision?: boolean;
    prefersCode?: boolean;
    minContextTokens?: number;
  };
  /** Defaults to available; `false` means it cannot be used at all right now. */
  available?: boolean;
  /** Optional preference weight; lower is better when scores tie. */
  costRank?: number;
}

export interface RoutingRequest {
  stepId: string;
  /** Capability tags the step declares. All of them are required. */
  requiredCapabilities?: readonly string[];
  /** The step carries an image or screenshot. */
  needsVision?: boolean;
  /** Context the step is expected to need, in tokens. */
  contextTokens?: number;
  /** The agent the plan named, if it named one. */
  preferredAgentKind?: string;
}

export interface CandidateEvaluation {
  agentKind: string;
  eligible: boolean;
  score: number;
  /** Why it scored as it did, phase by phase. */
  reasons: string[];
}

export interface RoutingDecision {
  stepId: string;
  selectedAgentKind?: string;
  /** Every candidate, so "why not X" is always answerable. */
  evaluations: CandidateEvaluation[];
  /** The winner's reasons, or empty when nothing was eligible. */
  reasons: string[];
  /** Ineligible candidates with the single reason that disqualified them. */
  rejected: Array<{ agentKind: string; reason: string }>;
  /** False when the winner was decided by a tie-break rather than by merit. */
  unambiguous: boolean;
  /** One line explaining the outcome, suitable for a UI or a log. */
  summary: string;
}

export function decideAgentRouting(
  request: RoutingRequest,
  candidates: readonly RoutingCandidate[],
): RoutingDecision {
  const required = request.requiredCapabilities ?? [];
  const evaluations: CandidateEvaluation[] = [];
  const rejected: Array<{ agentKind: string; reason: string }> = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];

    if (candidate.available === false) {
      rejected.push({ agentKind: candidate.agentKind, reason: "not available" });
      evaluations.push({ agentKind: candidate.agentKind, eligible: false, score: 0, reasons: ["not available"] });
      continue;
    }

    const missing = required.filter((tag) => !candidate.capabilityTags.includes(tag));
    if (missing.length > 0) {
      const reason = `missing required capability ${missing.join(", ")}`;
      rejected.push({ agentKind: candidate.agentKind, reason });
      evaluations.push({ agentKind: candidate.agentKind, eligible: false, score: 0, reasons: [reason] });
      continue;
    }

    if (request.needsVision === true && candidate.modelRequirements?.prefersVision !== true) {
      const reason = "no vision-capable model configured";
      rejected.push({ agentKind: candidate.agentKind, reason });
      evaluations.push({ agentKind: candidate.agentKind, eligible: false, score: 0, reasons: [reason] });
      continue;
    }

    const minContext = candidate.modelRequirements?.minContextTokens;
    if (
      request.contextTokens !== undefined
      && minContext !== undefined
      && request.contextTokens > minContext
    ) {
      const reason = `context window too small (${minContext} < ${request.contextTokens})`;
      rejected.push({ agentKind: candidate.agentKind, reason });
      evaluations.push({ agentKind: candidate.agentKind, eligible: false, score: 0, reasons: [reason] });
      continue;
    }

    let score = 0;
    if (required.length > 0) {
      score += required.length * 2;
      reasons.push(`declares all ${required.length} required capability tag(s)`);
    } else {
      reasons.push("no capability requirement to satisfy");
    }
    if (request.preferredAgentKind === candidate.agentKind) {
      score += 3;
      reasons.push("named by the plan");
    }
    if (request.needsVision === true && candidate.modelRequirements?.prefersVision === true) {
      score += 1;
      reasons.push("has the required vision capability");
    }
    if ((candidate.costRank ?? 0) > 0) {
      score -= candidate.costRank as number;
      reasons.push(`preference rank ${candidate.costRank}`);
    }

    evaluations.push({ agentKind: candidate.agentKind, eligible: true, score, reasons });
  }

  const eligible = evaluations.filter((evaluation) => evaluation.eligible);
  if (eligible.length === 0) {
    const summary = candidates.length === 0
      ? `No agent is registered for step ${request.stepId}.`
      : `No registered agent satisfies step ${request.stepId}`
        + `${required.length > 0 ? ` (needs ${required.join(", ")})` : ""}`
        + `${request.needsVision ? " and a vision-capable model" : ""}.`;
    return {
      stepId: request.stepId,
      evaluations,
      reasons: [],
      rejected,
      unambiguous: true,
      summary,
    };
  }

  const best = Math.max(...eligible.map((evaluation) => evaluation.score));
  const winners = eligible
    .filter((evaluation) => evaluation.score === best)
    .sort((left, right) => left.agentKind.localeCompare(right.agentKind));
  const winner = winners[0];
  // A tie is reported rather than hidden: it means the outcome depends on a
  // tie-break, which is exactly the kind of routing surprise worth surfacing.
  const unambiguous = winners.length === 1;

  return {
    stepId: request.stepId,
    selectedAgentKind: winner.agentKind,
    evaluations,
    reasons: [...winner.reasons],
    rejected,
    unambiguous,
    summary: unambiguous
      ? `Step ${request.stepId} routed to "${winner.agentKind}" (score ${best}): ${winner.reasons.join("; ")}.`
      : `Step ${request.stepId} routed to "${winner.agentKind}" by alphabetical tie-break among `
        + `${winners.map((evaluation) => evaluation.agentKind).join(", ")} (score ${best}).`,
  };
}

/** Renders a decision as the lines a UI would show under "why this agent?". */
export function describeRoutingDecision(decision: RoutingDecision): string[] {
  const lines: string[] = [decision.summary];
  for (const evaluation of decision.evaluations) {
    if (evaluation.eligible && evaluation.agentKind !== decision.selectedAgentKind) {
      lines.push(`Considered ${evaluation.agentKind} (score ${evaluation.score}): ${evaluation.reasons.join("; ")}.`);
    }
  }
  for (const entry of decision.rejected) {
    lines.push(`Rejected ${entry.agentKind}: ${entry.reason}.`);
  }
  return lines;
}
