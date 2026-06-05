export interface SharedTaskContext {
  set<T>(key: string, value: T): void;
  get<T>(key: string): T | undefined;
  has(key: string): boolean;
  snapshot(): Record<string, unknown>;
  clear(): void;
  resolveKey(key: ContextKey, locale?: string): string;
}

export const CONTEXT_KEYS = {
  WORKSPACE_PATH: { en: "workspacePath", zhCN: "工作区路径" },
  USER_GOAL: { en: "userGoal", zhCN: "用户目标" },
  TASK_ID: { en: "taskId", zhCN: "任务标识" },
  COMMANDER_PLAN: { en: "commanderPlan", zhCN: "指挥官计划" },
  DIFF_PREVIEW: { en: "diffPreview", zhCN: "差异预览" },
  PROPOSED_EDIT: { en: "proposedEdit", zhCN: "提议编辑" },
  VERIFICATION_RESULT: { en: "verificationResult", zhCN: "验证结果" },
  APPROVAL_RECORD: { en: "approvalRecord", zhCN: "审批记录" },
  SEARCH_RESULTS: { en: "searchResults", zhCN: "搜索结果" },
  RESEARCH_SOURCES: { en: "researchSources", zhCN: "研究来源" },
  PROJECT_INSPECTION: { en: "projectInspection", zhCN: "项目检查" },
  FILE_SCAN_RESULTS: { en: "fileScanResults", zhCN: "文件扫描结果" },
  PDF_ORGANIZATION_PLAN: { en: "pdfOrganizationPlan", zhCN: "PDF整理计划" },
  ERROR_CONTEXT: { en: "errorContext", zhCN: "错误上下文" },
  AGENT_STATE: { en: "agentState", zhCN: "代理状态" },
  TOKEN_USAGE: { en: "tokenUsage", zhCN: "令牌用量" },
  WORKFLOW_ID: { en: "workflowId", zhCN: "工作流标识" },
  STEP_RESULTS: { en: "stepResults", zhCN: "步骤结果" },
  BASE_GIT_HEAD: { en: "baseGitHead", zhCN: "基准提交" },
  STRUCTURED_HUNKS: { en: "structuredHunks", zhCN: "结构化差异块" },
  ASK_USER_QUESTION: { en: "askUserQuestion", zhCN: "用户提问" },
  ASK_USER_RESPONSE: { en: "askUserResponse", zhCN: "用户回答" },
} as const;

export type ContextKey = (typeof CONTEXT_KEYS)[keyof typeof CONTEXT_KEYS];

export function contextKeyForLocale(key: ContextKey, locale = "en"): string {
  return locale.toLowerCase().startsWith("zh") ? key.zhCN : key.en;
}

export function createSharedTaskContext(
  initialValues: Record<string, unknown> = {},
): SharedTaskContext {
  const store = new Map<string, unknown>(Object.entries(initialValues));

  return {
    set(key, value) {
      store.set(key, value);
    },
    get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    has(key) {
      return store.has(key);
    },
    snapshot() {
      return Object.fromEntries(store);
    },
    clear() {
      store.clear();
    },
    resolveKey(key, locale) {
      return contextKeyForLocale(key, locale);
    },
  };
}

/**
 * Resolve the input for a step by reading its declared inputContextKeys from SharedContext.
 * Returns a record of { key: value } for each key that has data in the context.
 */
export function resolveStepInput(
  inputContextKeys: string[] | undefined,
  context: SharedTaskContext,
): Record<string, unknown> {
  if (!inputContextKeys || inputContextKeys.length === 0) {
    return {};
  }
  const input: Record<string, unknown> = {};
  for (const key of inputContextKeys) {
    const value = context.get(key);
    if (value !== undefined) {
      input[key] = value;
    }
  }
  return input;
}

/**
 * Write a step's output to SharedContext under its declared outputContextKey.
 * No-op if outputContextKey is not set.
 */
export function writeStepOutput(
  outputContextKey: string | undefined,
  output: unknown,
  context: SharedTaskContext,
): void {
  if (!outputContextKey) return;
  context.set(outputContextKey, output);
}
