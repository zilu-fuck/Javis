/**
 * Subagent sessions, forks and lineage (D6).
 *
 * A subagent that starts from nothing repeats the parent's whole context — the expensive
 * part — and pays full price for it. Forking exists to avoid that: the child reuses the
 * parent's message prefix, the provider serves it from cache, and only the child's own
 * prompt is new.
 *
 * That benefit is conditional, and the condition is the thing worth encoding:
 * **a provider caches a prefix, not a superset.** Change the system prompt or the tool
 * list and the prefix no longer matches, so nothing is reused and the child silently
 * costs as much as a cold start. `planSubagentFork` reports that explicitly rather than
 * producing an optimistic token count that never materializes.
 *
 * Lineage is the other half: a child's trajectory is only useful if it can be traced back
 * to the parent turn that spawned it, and child context keys must not collide with the
 * parent's — hence the namespacing helpers.
 */

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export interface SessionMessage {
  role: SessionMessageRole;
  tokens: number;
}

export type SubagentSessionStatus = "running" | "completed" | "failed" | "abandoned";

export interface SubagentSession {
  id: string;
  agentKind: string;
  parentSessionId?: string;
  /** How many of the parent's messages the child inherited at fork time. */
  forkedFromMessageCount?: number;
  status: SubagentSessionStatus;
  createdAt?: string;
}

export interface ForkPlanInput {
  parentMessages: readonly SessionMessage[];
  /** Defaults to the whole parent conversation. */
  forkAtMessageCount?: number;
  /** Tokens contributed by the child's own system prompt and first instruction. */
  childSystemPromptTokens: number;
  /**
   * Whether the child's system prompt and tool list are byte-identical to the parent's.
   * This is what decides whether a provider can serve the shared prefix from cache.
   */
  sharesParentPrefix: boolean;
  budgetTokens?: number;
}

export interface ForkPlan {
  sharedPrefixMessages: number;
  sharedPrefixTokens: number;
  childOnlyTokens: number;
  /** What the child's context will actually contain. */
  totalTokens: number;
  /** True only when a provider cache can serve the shared prefix. */
  prefixCacheable: boolean;
  /** Why the prefix is (not) reusable, or why messages were dropped. */
  reason: string;
  exceededBudget: boolean;
  /** Messages trimmed off the front of the shared prefix to fit the budget. */
  droppedPrefixMessages: number;
  /** Tokens the shared prefix would have cost if it had to be sent fresh. */
  uncachedPrefixTokens: number;
}

export function planSubagentFork(input: ForkPlanInput): ForkPlan {
  const parentCount = input.parentMessages.length;
  const requested = Math.max(0, Math.min(input.forkAtMessageCount ?? parentCount, parentCount));
  const childOnlyTokens = Math.max(0, input.childSystemPromptTokens);

  let sharedMessages = input.parentMessages.slice(0, requested);
  let droppedPrefixMessages = 0;
  let limitReason: string | undefined;

  if (input.budgetTokens !== undefined) {
    const budget = Math.max(0, input.budgetTokens);
    let total = childOnlyTokens + sharedMessages.reduce((sum, message) => sum + message.tokens, 0);
    // Trim from the front: the most recent turns are what the child is being forked for.
    while (sharedMessages.length > 0 && total > budget) {
      const dropped = sharedMessages.shift();
      droppedPrefixMessages += 1;
      total -= dropped?.tokens ?? 0;
      limitReason = `the ${budget}-token budget required dropping ${droppedPrefixMessages} inherited message(s)`;
    }
    if (childOnlyTokens > budget) {
      limitReason = `the child's own prompt (${childOnlyTokens} tokens) already exceeds the ${budget}-token budget`;
    }
  }

  const sharedPrefixTokens = sharedMessages.reduce((sum, message) => sum + message.tokens, 0);
  const totalTokens = sharedPrefixTokens + childOnlyTokens;
  const exceededBudget = input.budgetTokens !== undefined && totalTokens > input.budgetTokens;

  // A changed prefix, a trimmed one, or no inherited messages at all: in every case there
  // is nothing a provider cache could serve, so the flag must agree with the reason.
  const prefixCacheable = input.sharesParentPrefix
    && droppedPrefixMessages === 0
    && sharedMessages.length > 0;
  const reason = !input.sharesParentPrefix
    ? "the child's system prompt or tool list differs from the parent's, so the inherited "
      + "messages are a different prefix and nothing can be reused from cache"
    : limitReason
      ? `${limitReason}; trimming the front of the prefix also invalidates it`
      : sharedPrefixTokens === 0
        ? "the child inherited no messages, so there is no prefix to reuse"
        : `the child reuses ${sharedMessages.length} inherited message(s) as an identical prefix`;

  return {
    sharedPrefixMessages: sharedMessages.length,
    sharedPrefixTokens,
    childOnlyTokens,
    totalTokens,
    prefixCacheable,
    reason,
    exceededBudget,
    droppedPrefixMessages,
    uncachedPrefixTokens: sharedPrefixTokens,
  };
}

export interface SessionLineage {
  /** Root first, ending with the session's direct parent; excludes the session itself. */
  ancestors: SubagentSession[];
  /** Direct and transitive children, breadth-first in creation order. */
  descendants: SubagentSession[];
  depth: number;
  /** True when the parent chain is broken (a session references a parent that is gone). */
  orphaned: boolean;
}

/**
 * Walks the session tree in both directions.
 *
 * A missing parent is reported as `orphaned` rather than throwing: a trajectory from a
 * pruned parent still needs to be displayable.
 */
export function buildSessionLineage(
  sessions: readonly SubagentSession[],
  sessionId: string,
): SessionLineage {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ancestors: SubagentSession[] = [];
  let orphaned = false;
  let cursor = byId.get(sessionId)?.parentSessionId;
  const guard = new Set<string>([sessionId]);
  while (cursor) {
    if (guard.has(cursor)) {
      orphaned = true; // A cycle in the lineage: stop rather than loop.
      break;
    }
    guard.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) {
      orphaned = true;
      break;
    }
    ancestors.unshift(parent);
    cursor = parent.parentSessionId;
  }

  const descendants: SubagentSession[] = [];
  let frontier = [sessionId];
  const seen = new Set<string>([sessionId]);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const session of sessions) {
      if (session.parentSessionId && frontier.includes(session.parentSessionId) && !seen.has(session.id)) {
        seen.add(session.id);
        descendants.push(session);
        next.push(session.id);
      }
    }
    frontier = next;
  }

  return { ancestors, descendants, depth: ancestors.length, orphaned };
}

const CHILD_KEY_PREFIX = "sub:";

/**
 * Namespaces a child's context key so it cannot collide with, or overwrite, a parent's.
 */
export function namespaceChildContextKey(childId: string, key: string): string {
  return `${CHILD_KEY_PREFIX}${childId}:${key}`;
}

export function parseChildContextKey(key: string): { childId: string; key: string } | undefined {
  if (!key.startsWith(CHILD_KEY_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(CHILD_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return undefined;
  }
  return { childId: rest.slice(0, separator), key: rest.slice(separator + 1) };
}

/** True when a child is writing to a key that belongs to a parent scope. */
export function isForeignContextWrite(childId: string, key: string): boolean {
  const parsed = parseChildContextKey(key);
  if (!parsed) {
    // An unnamespaced key from a child is a parent-scope write.
    return true;
  }
  return parsed.childId !== childId;
}
