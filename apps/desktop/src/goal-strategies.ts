import type { GoalStrategy, GoalStrategyContext } from "@javis/core";

const RISKY_ACTION_PATTERN = /(rm\s+-rf|git\s+reset|drop\s+table|delete|remove|overwrite|migration|migrate|reset|删除|清空|重置|覆盖|迁移)/i;
const SELF_REFINE_PATTERN = /(implement|code|test|review|refactor|fix|write|draft|document|ui|typescript|react|实现|代码|测试|审查|修复|重构|文档|界面)/i;

export function createDefaultGoalStrategies(): GoalStrategy[] {
  return [
    createGuardrailStrategy(),
    createRetrievalStrategy(),
    createReflectStrategy(),
    createSelfRefineStrategy(),
    createHandoffStrategy(),
  ];
}

export function createGuardrailStrategy(): GoalStrategy {
  return {
    name: "guardrail",
    beforeRun(context) {
      const target = `${context.goal.objective}\n${context.latestTask?.userGoal ?? ""}`;
      if (!RISKY_ACTION_PATTERN.test(target)) {
        return null;
      }
      return {
        nextPromptPrefix: [
          "Goal guardrail:",
          "- Treat destructive, broad, or irreversible operations as high risk.",
          "- Prefer inspection and narrow edits first.",
          "- Require explicit verification before considering the Goal complete.",
        ].join("\n"),
        event: {
          type: "strategy_applied",
          message: "Guardrail strategy added risk checks to the next Goal run.",
          payloadJson: JSON.stringify({ strategy: "guardrail" }),
        },
      };
    },
  };
}

export function createRetrievalStrategy(): GoalStrategy {
  return {
    name: "retrieval",
    beforeRun(context) {
      if (context.goal.runCount === 0 && context.events.length === 0 && !context.latestEvaluation) {
        return null;
      }
      return {
        nextPromptSuffix: [
          "Goal retrieval context:",
          "- Review the current workspace evidence and prior Goal timeline before changing files.",
          "- Use memory or repository search when prior decisions, docs, or failing checks may affect the next step.",
          formatRecentEvidence(context),
        ].filter(Boolean).join("\n"),
        event: {
          type: "strategy_applied",
          message: "Retrieval strategy attached prior Goal context to the next run.",
          payloadJson: JSON.stringify({ strategy: "retrieval" }),
        },
      };
    },
  };
}

export function createReflectStrategy(): GoalStrategy {
  return {
    name: "reflect",
    beforeRun(context) {
      const failedTask = context.latestTask?.status === "failed" || context.latestTask?.status === "cancelled";
      const uncertainEvaluation = context.latestEvaluation?.confidence === "low" ||
        context.latestEvaluation?.decision === "blocked";
      if (!failedTask && !uncertainEvaluation) {
        return null;
      }
      return {
        nextPromptPrefix: [
          "Goal reflection:",
          "- First summarize why the previous attempt did not satisfy the Goal.",
          "- Choose a different, concrete path instead of repeating the same failing action.",
          "- Keep the next edit or investigation narrowly tied to the unsatisfied criteria.",
        ].join("\n"),
        event: {
          type: "strategy_applied",
          message: "Reflect strategy requested a failure review before the next run.",
          payloadJson: JSON.stringify({ strategy: "reflect", latestTaskStatus: context.latestTask?.status }),
        },
      };
    },
  };
}

export function createSelfRefineStrategy(): GoalStrategy {
  return {
    name: "self-refine",
    beforeRun(context) {
      const target = `${context.goal.objective}\n${context.latestTask?.userGoal ?? ""}`;
      if (!SELF_REFINE_PATTERN.test(target)) {
        return null;
      }
      return {
        nextPromptSuffix: [
          "Goal self-refine loop:",
          "- Produce the change or answer.",
          "- Critique it against the Goal acceptance criteria.",
          "- Revise any weak part.",
          "- Run or name the strongest available verification before claiming completion.",
        ].join("\n"),
        event: {
          type: "self_refine_started",
          message: "Self-refine strategy added a generate, critique, revise, verify loop.",
          payloadJson: JSON.stringify({ strategy: "self-refine" }),
        },
      };
    },
  };
}

export function createHandoffStrategy(): GoalStrategy {
  return {
    name: "handoff",
    beforeRun(context) {
      if (!shouldSuggestHandoff(context)) {
        return null;
      }
      return {
        nextPromptSuffix: [
          "Goal handoff check:",
          "- If a different specialist Agent or Commander route is better suited, explicitly request that route.",
          "- State the handoff reason and the exact evidence the receiving Agent should use.",
          "- Continue directly only when the current route can still make meaningful progress.",
        ].join("\n"),
        event: {
          type: "handoff_requested",
          message: "Handoff strategy asked the next run to consider specialist routing.",
          payloadJson: JSON.stringify({
            strategy: "handoff",
            blockedStreak: context.goal.blockedStreak,
            latestDecision: context.latestEvaluation?.decision,
          }),
        },
      };
    },
  };
}

function shouldSuggestHandoff(context: GoalStrategyContext): boolean {
  if (context.goal.blockedStreak > 0 || context.latestEvaluation?.decision === "blocked") {
    return true;
  }
  const terminalFailures = context.events.filter((event) =>
    event.type === "task_terminal" && event.payloadJson?.includes("\"status\":\"failed\"")
  ).length;
  return terminalFailures >= 2;
}

function formatRecentEvidence(context: GoalStrategyContext): string {
  const evidence = context.latestEvaluation?.evidence.slice(0, 4) ?? [];
  const recentEvents = context.events
    .slice(-4)
    .map((event) => `${event.type}${event.message ? `: ${event.message}` : ""}`);
  const lines = [
    ...evidence.map((item) => `- Evidence: ${item}`),
    ...recentEvents.map((item) => `- Timeline: ${item}`),
  ];
  return lines.length > 0 ? lines.join("\n") : "";
}
