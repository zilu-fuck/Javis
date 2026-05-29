import type { RouteScore, RouteScoringContext } from "./routing";

export type { RouteScore, RouteScoringContext };

/** A scoring function that evaluates a user goal against a context. */
export type RouteScoringFn = (userGoal: string, context: RouteScoringContext) => RouteScore;

export interface RouteRegistry {
  /** Register a scoring function for a route kind. Associates it with a workflow id. */
  register(routeKind: string, workflowId: string, scoringFn: RouteScoringFn): void;
  /** Remove a route kind. */
  unregister(routeKind: string): void;
  /** Run all registered scoring functions and return sorted results. */
  scoreAll(userGoal: string, context?: RouteScoringContext): RouteScore[];
  /** Get the workflow id associated with a route kind. */
  getWorkflowId(routeKind: string): string | undefined;
}

export function createRouteRegistry(): RouteRegistry {
  const scorers = new Map<string, { workflowId: string; fn: RouteScoringFn }>();

  return {
    register(routeKind, workflowId, scoringFn) {
      scorers.set(routeKind, { workflowId, fn: scoringFn });
    },

    unregister(routeKind) {
      scorers.delete(routeKind);
    },

    scoreAll(userGoal, context = {}) {
      const results: RouteScore[] = [];
      for (const { fn } of scorers.values()) {
        results.push(fn(userGoal, context));
      }
      return results.sort((left, right) => right.score - left.score);
    },

    getWorkflowId(routeKind) {
      return scorers.get(routeKind)?.workflowId;
    },
  };
}
