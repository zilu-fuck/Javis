/**
 * Failure guidance (E2).
 *
 * A failure the user cannot act on is just noise. Production logged generic strings
 * like `Some steps failed` (28×) and `模型请求失败` (13×) with no indication of what to
 * do next, while the actual cause — an expired key, a context overflow, a truncated
 * response, a tool whose output broke its schema — was sitting in the detail string.
 *
 * This module turns a failure into a classified, bilingual, *actionable* result:
 * a short message plus the ordered actions the UI can render as buttons. It is the
 * single classifier: `classifyModelFailureKind` in the runtime delegates here rather
 * than keeping a second list of regexes in sync.
 */

export type FailureKind =
  | "model_unconfigured"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_final_content"
  | "context_overflow"
  | "truncated_output"
  | "request_invalid"
  | "tool_schema"
  | "tool_unavailable"
  | "plan_unparsed"
  | "plan_invalid"
  | "approval_denied"
  | "cancelled"
  | "unknown";

export type FailureAction =
  | "open_settings"
  | "check_api_key"
  | "switch_model"
  | "retry"
  | "reduce_input"
  | "inspect_log"
  | "fix_tool_output"
  | "replan"
  | "adjust_permissions"
  | "none";

export interface FailureGuidance {
  kind: FailureKind;
  /** Short, user-facing and localized: what happened. */
  message: string;
  /** Ordered, concrete next steps the UI renders as buttons. */
  actions: FailureAction[];
  /** Whether retrying the same request is likely to help. */
  retryable: boolean;
  /** Original detail for the log; never the primary user message. */
  detail?: string;
}

export type FailureLocale = "en" | "zhCN";

interface FailureTemplate {
  message: Record<FailureLocale, string>;
  actions: FailureAction[];
  retryable: boolean;
}

const TEMPLATES: Record<FailureKind, FailureTemplate> = {
  model_unconfigured: {
    message: {
      en: "No model is configured for this task. Choose a provider, model and API key in Settings.",
      zhCN: "该任务还没有配置模型。请在设置里选择服务商、模型并保存 API 密钥。",
    },
    actions: ["open_settings", "check_api_key"],
    retryable: false,
  },
  auth: {
    message: {
      en: "Model authentication failed. Check the API key, base URL, and model name.",
      zhCN: "模型鉴权失败，请检查 API 密钥、基础 URL 和模型名。",
    },
    actions: ["check_api_key", "open_settings", "retry"],
    retryable: false,
  },
  rate_limit: {
    message: {
      en: "The provider is rate limiting this account. Wait a moment before continuing.",
      zhCN: "服务商对该账号限流。请稍等片刻再继续。",
    },
    actions: ["retry", "switch_model"],
    retryable: true,
  },
  timeout: {
    message: {
      en: "The model request timed out. Please retry.",
      zhCN: "模型请求超时，请重试。",
    },
    actions: ["retry", "switch_model"],
    retryable: true,
  },
  network: {
    message: {
      en: "Network error while contacting the model service.",
      zhCN: "网络异常，无法连接模型服务。",
    },
    actions: ["retry", "open_settings"],
    retryable: true,
  },
  empty_final_content: {
    message: {
      en: "The model returned only a reasoning trace and no final answer. Reasoning was kept; retry or switch models.",
      zhCN: "模型只返回了思考过程、没有最终回答。已保留思考片段，可重试或换模型。",
    },
    actions: ["retry", "switch_model", "inspect_log"],
    retryable: true,
  },
  context_overflow: {
    message: {
      en: "This request exceeds the model's context window. Shorten the input or switch to a larger-context model.",
      zhCN: "本次请求超出模型上下文窗口。请缩短输入，或改用上下文更大的模型。",
    },
    actions: ["reduce_input", "switch_model"],
    retryable: false,
  },
  truncated_output: {
    message: {
      en: "The model response was cut off by the output limit, so it could not be parsed. Retry or raise the output limit.",
      zhCN: "模型输出被长度上限截断，无法解析。请重试，或调高输出上限。",
    },
    actions: ["retry", "switch_model", "open_settings"],
    retryable: true,
  },
  plan_unparsed: {
    // Distinct from `plan_invalid`: here the model returned *nothing parseable*, so
    // "add more detail to the goal" is the right advice. When structure came back but was
    // illegal, that advice is wrong — which is why these are not one kind.
    message: {
      en: "Plan generation failed: the model did not return an executable structured plan. Retry, or add the key details (goal, paths, platform).",
      zhCN: "计划生成失败：模型没有返回可执行的结构化计划。请重试，或补充目标、路径和平台等关键信息。",
    },
    actions: ["retry", "replan", "switch_model"],
    retryable: true,
  },
  request_invalid: {
    // Distinct from `plan_invalid`: the *request* never formed (a missing prompt field),
    // so replanning will not help — the model configuration or the caller is at fault.
    message: {
      en: "The model request was built incompletely. Retry; if it persists, check the model configuration and update the app.",
      zhCN: "模型请求参数不完整。请重试当前任务；如果仍失败，请检查模型配置并更新应用。",
    },
    actions: ["retry", "open_settings", "inspect_log"],
    retryable: true,
  },
  tool_schema: {
    message: {
      en: "A tool returned data that does not match its declared shape. The step was stopped rather than guessing.",
      zhCN: "某个工具返回的数据与声明的结构不符，已停止该步骤而不是猜测。",
    },
    actions: ["inspect_log", "fix_tool_output", "retry"],
    retryable: false,
  },
  tool_unavailable: {
    message: {
      en: "A required tool is unavailable or not permitted here. Check the workspace, permissions, or configuration.",
      zhCN: "所需工具当前不可用或未被允许。请检查工作区、权限或配置。",
    },
    actions: ["adjust_permissions", "inspect_log", "replan"],
    retryable: false,
  },
  plan_invalid: {
    message: {
      en: "The plan did not pass validation and was not executed. Replanning can fix this.",
      zhCN: "计划未通过校验，因此没有执行。重新规划可以解决。",
    },
    actions: ["replan", "inspect_log"],
    retryable: false,
  },
  approval_denied: {
    message: {
      en: "The operation was not approved, so nothing was executed.",
      zhCN: "该操作未被批准，因此没有执行任何写入。",
    },
    actions: ["none"],
    retryable: false,
  },
  cancelled: {
    message: {
      en: "The task was cancelled before it finished.",
      zhCN: "任务在完成前被取消。",
    },
    actions: ["retry"],
    retryable: true,
  },
  unknown: {
    message: {
      en: "The model request failed. Any generated content was kept; check the activity log before retrying.",
      zhCN: "模型请求失败。已保留当前已生成的内容，请查看活动日志后重试。",
    },
    actions: ["inspect_log", "retry"],
    retryable: true,
  },
};

/** Matchers are ordered: the first match wins, so put specific patterns first. */
const MATCHERS: Array<{ kind: FailureKind; pattern: RegExp }> = [
  {
    kind: "model_unconfigured",
    // The phrase order varies in the wild ("missing model settings" as well as
    // "model settings are missing"), and a miss here is the difference between an
    // actionable "configure a model" and a useless "unknown".
    pattern: /could not read model api key secret|no model (?:is )?configured|model settings (?:are )?missing|missing model settings|api key secret/i,
  },
  {
    kind: "auth",
    pattern: /\b40[13]\b|unauthori[sz]ed|forbidden|invalid (?:api[-_ ]?)?key|api key|authentication fail|鉴权|密钥无效|密钥已过期|api key 验证失败/i,
  },
  { kind: "rate_limit", pattern: /\b429\b|rate limit|too many requests|请求频率过高|限流/i },
  {
    kind: "context_overflow",
    pattern: /maximum context length|context (?:length|window).*(?:exceed|too (?:long|large))|超出.*上下文|reduce the length of the messages/i,
  },
  { kind: "timeout", pattern: /timeout|timed out|超时/i },
  { kind: "network", pattern: /network|connection (?:refused|reset|error)|dns|econn|socket hang up|无法连接|网络异常/i },
  {
    kind: "empty_final_content",
    pattern: /no final message content|empty (?:chat )?response|reasoning[- ]only|只返回了思考过程|没有最终回答/i,
  },
  {
    kind: "truncated_output",
    pattern: /truncated \(length\)|was truncated|finish_reason.*length|输出被长度上限截断/i,
  },
  {
    // Placed before `plan_invalid` so a request that never formed is not reported as a
    // planning problem: replanning cannot fix a missing prompt field.
    kind: "request_invalid",
    pattern: /complete_model_prompt|missing field [`'"]?prompt[`'"]?/i,
  },
  {
    kind: "tool_schema",
    pattern: /must be a (?:integer|number|string|boolean|object|array)|undeclared field|does not match its declared schema|output .*schema|结构不符/i,
  },
  {
    kind: "tool_unavailable",
    pattern: /not in the .*allowlist|not implemented|tool dispatch not implemented|tool .* is not available|unsupported approval|requires approval|工具不可用|未被允许/i,
  },
  {
    // Before `plan_invalid`: nothing parseable came back, which is a different problem
    // with different advice.
    kind: "plan_unparsed",
    pattern: /did not contain a JSON object|did not contain valid JSON|invalid JSON|(?:returned|contains) no JSON|没有返回可执行的结构化计划|未返回结构化/i,
  },
  {
    kind: "plan_invalid",
    // Deliberately requires validation vocabulary. Matching a bare "commander plan"
    // would classify unrelated failures that merely mention the plan (an MCP allowlist
    // rejection, for instance) and replace their specific reason with this template —
    // the same information loss as substituting a cause for an unclassified failure.
    pattern: /plan compilation failed|has no capability-tagged steps|invalid_plan_shape|plan is not valid|计划未通过校验/i,
  },
  { kind: "approval_denied", pattern: /denied by user|user denied|not approved|未被批准|已拒绝/i },
  { kind: "cancelled", pattern: /cancelled|canceled|aborted|已取消/i },
];

export function classifyFailureKind(detail: string): FailureKind {
  for (const matcher of MATCHERS) {
    if (matcher.pattern.test(detail)) {
      return matcher.kind;
    }
  }
  return "unknown";
}

function toDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return error === undefined || error === null ? "" : String(error);
}

export function classifyFailure(
  error: unknown,
  options: { locale?: FailureLocale } = {},
): FailureGuidance {
  return buildGuidance(classifyFailureKind(toDetail(error)), toDetail(error), options);
}

export function classifyFailureDetail(
  detail: string,
  options: { locale?: FailureLocale } = {},
): FailureGuidance {
  return buildGuidance(classifyFailureKind(detail), detail, options);
}

function buildGuidance(
  kind: FailureKind,
  detail: string,
  options: { locale?: FailureLocale },
): FailureGuidance {
  const template = TEMPLATES[kind];
  const locale = options.locale ?? "en";
  const cleaned = cleanDetail(detail);
  // An unclassified failure must not claim a cause. The runtime table this module
  // replaced kept the cleaned detail here, and substituting "the model request failed"
  // actively misattributes a persistence or provenance failure to the model — the user
  // then debugs the wrong subsystem. The template is only used when there is nothing to
  // quote.
  const message = kind === "unknown" && cleaned.length > 0
    ? cleaned
    : template.message[locale];
  return {
    kind,
    message,
    actions: [...template.actions],
    retryable: template.retryable,
    ...(detail.length > 0 ? { detail } : {}),
  };
}

/** Strips transport prefixes while keeping the original wording. */
export function cleanDetail(detail: string): string {
  return detail
    .replace(/^Error:\s*/iu, "")
    .replace(/^\[.*?\]\s*/u, "")
    .trim();
}

/** Ordered, de-duplicated actions across several failures. */
export function mergeFailureActions(guidances: readonly FailureGuidance[]): FailureAction[] {
  const seen = new Set<FailureAction>();
  const actions: FailureAction[] = [];
  for (const guidance of guidances) {
    for (const action of guidance.actions) {
      if (action === "none" || seen.has(action)) {
        continue;
      }
      seen.add(action);
      actions.push(action);
    }
  }
  return actions.length > 0 ? actions : ["none"];
}

/**
 * The message for a known kind, for callers that already classified (or that hold a
 * classification from an earlier step) and only need the wording.
 */
export function failureMessageForKind(
  kind: FailureKind,
  locale: FailureLocale = "en",
  options: { short?: boolean } = {},
): string {
  const message = TEMPLATES[kind].message[locale];
  return options.short ? firstSentence(message, locale) : message;
}

/** The localized first sentence, used where a placeholder line is needed. */
export function firstSentence(message: string, locale: FailureLocale = "en"): string {
  const terminators = locale === "zhCN" ? /[。！？]/u : /[.!?]/u;
  const match = terminators.exec(message);
  if (!match || match.index === undefined) {
    return message;
  }
  return message.slice(0, match.index + 1);
}

/** The action set for a known kind. */
export function failureActionsForKind(kind: FailureKind): FailureAction[] {
  return [...TEMPLATES[kind].actions];
}

/** True when every failure in the batch is worth retrying unchanged. */
export function isRetryableFailureSet(guidances: readonly FailureGuidance[]): boolean {
  return guidances.length > 0 && guidances.every((guidance) => guidance.retryable);
}
