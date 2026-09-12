/**
 * First-run setup diagnosis (E1).
 *
 * A local-first workbench has one unavoidable cold start: a provider, a model and a
 * key before anything works. Today the failure surfaces later and indirectly ("the
 * model request failed"), and the user has to infer which of five fields is wrong.
 *
 * This turns the configuration into an ordered checklist with an explicit *next*
 * step, so onboarding is "do this one thing" instead of "something is broken".
 *
 * Provider-side facts it does not have are not guessed: a provider that needs no key
 * (a local runtime) is only treated as key-free when the caller says so.
 */

export type SetupLocale = "en" | "zhCN";

export interface SetupProfileInput {
  slot: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** True when a secret is stored under the profile's key reference. */
  hasStoredApiKey?: boolean;
  /** True for providers reachable without a secret, e.g. a local runtime. */
  requiresApiKey?: boolean;
  /** True when a custom/self-hosted endpoint needs an explicit base URL. */
  requiresBaseUrl?: boolean;
}

export interface SetupDiagnosisInput {
  profiles: readonly SetupProfileInput[];
  /** Provider ids this build knows; an unknown one is a warning, not a blocker. */
  knownProviders?: readonly string[];
  workspacePath?: string;
  locale?: SetupLocale;
}

export type SetupStepId = "provider" | "model" | "api_key" | "base_url" | "provider_supported" | "workspace";
export type SetupStepStatus = "done" | "missing" | "warning";

export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
  title: string;
  detail: string;
  /** True when the app cannot do useful work until this is resolved. */
  blocking: boolean;
}

export interface SetupDiagnosis {
  ready: boolean;
  steps: SetupStep[];
  /** The first blocking step, for a single "do this next" call to action. */
  nextStep?: SetupStep;
  /** One-line summary suitable for a banner. */
  summary: string;
  /** Count of blocking steps still outstanding. */
  blockers: number;
}

const PRIMARY_SLOT = "primary";

export function diagnoseSetup(input: SetupDiagnosisInput): SetupDiagnosis {
  const isChinese = (input.locale ?? "en") === "zhCN";
  const primary = input.profiles.find((profile) => profile.slot === PRIMARY_SLOT)
    ?? input.profiles[0];
  const steps: SetupStep[] = [];

  const provider = primary?.provider?.trim();
  steps.push(provider
    ? {
        id: "provider",
        status: "done",
        title: isChinese ? "服务商" : "Provider",
        detail: provider,
        blocking: false,
      }
    : {
        id: "provider",
        status: "missing",
        title: isChinese ? "服务商" : "Provider",
        detail: isChinese
          ? "还没有给 Primary 档位选择服务商。"
          : "No provider is assigned to the Primary slot yet.",
        blocking: true,
      });

  const model = primary?.model?.trim();
  steps.push(model
    ? {
        id: "model",
        status: "done",
        title: isChinese ? "模型" : "Model",
        detail: model,
        blocking: false,
      }
    : {
        id: "model",
        status: "missing",
        title: isChinese ? "模型" : "Model",
        detail: isChinese
          ? "还没有选择模型名。"
          : "No model name is selected.",
        blocking: true,
      });

  if (primary && input.knownProviders && provider && !input.knownProviders.includes(provider)) {
    steps.push({
      id: "provider_supported",
      status: "warning",
      title: isChinese ? "服务商是否支持" : "Provider supported",
      detail: isChinese
        ? `本版本没有内置「${provider}」的定义；只有在你确定它兼容 OpenAI 接口时才可用。`
        : `This build has no built-in definition for "${provider}"; it works only if it is OpenAI-compatible.`,
      blocking: false,
    });
  }

  if (primary && primary.requiresApiKey === false) {
    steps.push({
      id: "api_key",
      status: "done",
      title: isChinese ? "API 密钥" : "API key",
      detail: isChinese ? "该服务商无需密钥。" : "This provider needs no key.",
      blocking: false,
    });
  } else {
    steps.push(primary?.hasStoredApiKey
      ? {
          id: "api_key",
          status: "done",
          title: isChinese ? "API 密钥" : "API key",
          detail: isChinese ? "已保存在系统凭据库。" : "Stored in the OS credential store.",
          blocking: false,
        }
      : {
          id: "api_key",
          status: "missing",
          title: isChinese ? "API 密钥" : "API key",
          detail: isChinese
            ? "还没有保存密钥。密钥会存进系统凭据库，不写入 localStorage。"
            : "No API key is stored yet. The key goes to the OS credential store, never localStorage.",
          blocking: true,
        });
  }

  if (primary?.requiresBaseUrl === true && !primary.baseUrl?.trim()) {
    steps.push({
      id: "base_url",
      status: "missing",
      title: isChinese ? "基础 URL" : "Base URL",
      detail: isChinese
        ? "自建或代理端点必须填写基础 URL。"
        : "A self-hosted or proxied endpoint requires an explicit base URL.",
      blocking: true,
    });
  }

  const workspacePath = input.workspacePath?.trim();
  steps.push(workspacePath
    ? {
        id: "workspace",
        status: "done",
        title: isChinese ? "工作区" : "Workspace",
        detail: workspacePath,
        blocking: false,
      }
    : {
        id: "workspace",
        status: "warning",
        title: isChinese ? "工作区" : "Workspace",
        detail: isChinese
          ? "还没有选择工作区；聊天可用，但文件与仓库相关任务需要它。"
          : "No workspace selected yet; chat works, but file and repository tasks need one.",
        blocking: false,
      });

  const blockingSteps = steps.filter((step) => step.blocking);
  const nextStep = blockingSteps[0];
  const blockers = blockingSteps.length;

  return {
    ready: blockers === 0,
    steps,
    ...(nextStep ? { nextStep } : {}),
    blockers,
    summary: blockers === 0
      ? (isChinese ? "配置已就绪，可以开始。" : "Setup is ready.")
      : (isChinese
          ? `还差 ${blockers} 步：${nextStep?.title ?? ""}`
          : `${blockers} step${blockers === 1 ? "" : "s"} left: ${nextStep?.title ?? ""}`),
  };
}
