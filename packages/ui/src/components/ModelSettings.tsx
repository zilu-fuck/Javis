import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
  WorkbenchLocale,
  WorkbenchAgentCatalogEntry,
  WorkbenchModelConfiguration,
  WorkbenchModelProfile,
  WorkbenchModelSettings,
  WorkbenchComputerUseLocalVisionMode,
  WorkbenchComputerUseLocalVisionRuntime,
  WorkbenchComputerUseLocalVisionSettings,
  WorkbenchComputerUseSettings,
  WorkbenchRuntimePreferences,
  WorkbenchDefaultStartupMode,
  WorkbenchContextStrategy,
  WorkbenchAgentMaxRoundsPreset,
  WorkbenchTaskTimeoutPreset,
  WorkbenchAgentMemoryScopeMode,
  WorkbenchAgentMemoryEmbeddingMode,
  WorkbenchTaskQueuePolicy,
  WorkbenchFailureRecoveryPolicy,
  WorkbenchUserWaitTimeoutPreset,
  WorkbenchAppearanceTheme,
  WorkbenchModelSlot,
  WorkbenchAgentStyleState,
  WorkbenchUserProfileMemorySummary,
  WorkbenchAgentMemorySummary,
  WorkbenchTrustedComputerApp,
} from "../types";
import type { ProviderCatalogEntry } from "../types";
import { translateWorkbenchText } from "../utils";
import { AgentStyleEditor } from "./AgentStyleEditor";
import { withInferredContextTokens } from "../model-context-window";

interface ProviderCapabilities {
  vision: boolean;
  code: boolean;
  longContext: boolean;
}

interface ModelSettingsProps {
  labels: WorkbenchLocale["labels"];
  locale?: WorkbenchLocale;
  agentCatalog?: WorkbenchAgentCatalogEntry[];
  modelSettings: WorkbenchModelSettings;
  modelConfiguration?: WorkbenchModelConfiguration;
  computerUseSettings?: WorkbenchComputerUseSettings;
  computerUseLocalVisionSettings?: WorkbenchComputerUseLocalVisionSettings;
  trustedComputerApps?: WorkbenchTrustedComputerApp[];
  runtimePreferences?: WorkbenchRuntimePreferences;
  userProfileMemorySummary?: WorkbenchUserProfileMemorySummary | null;
  agentMemorySummary?: WorkbenchAgentMemorySummary | null;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onTestModelConnection?: (settings: WorkbenchModelSettings) => Promise<string | void>;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
  onComputerUseSettingsChange?: (settings: WorkbenchComputerUseSettings) => void;
  onComputerUseLocalVisionSettingsChange?: (settings: WorkbenchComputerUseLocalVisionSettings) => void;
  onRemoveTrustedComputerApp?: (title: string) => void;
  onRuntimePreferencesChange?: (preferences: WorkbenchRuntimePreferences) => void;
  onRebuildUserProfileMemory?: () => void;
  onClearUserProfileMemory?: () => void;
  onAgentMemoryEnabledChange?: (enabled: boolean) => void;
  onClearAgentMemory?: () => void;
  onClearWorkspaceAgentMemory?: () => void;
  onDeleteAgentMemoryFact?: (id: string) => void;
  onReadAgentStyle?: (kind: string) => Promise<WorkbenchAgentStyleState>;
  onSaveAgentStyle?: (kind: string, content: string) => Promise<WorkbenchAgentStyleState | void>;
  onResetAgentStyle?: (kind: string) => Promise<WorkbenchAgentStyleState | void>;
  /** Save a per-provider API key to the OS credential store immediately. */
  onSaveProviderApiKey?: (keyReference: string, apiKey: string) => Promise<void>;
  /**
   * Fetch available model IDs from the provider API.
   * When apiKey is empty, the desktop layer resolves the key from the OS credential store.
   */
  onFetchProviderModels?: (params: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    apiType: string;
    keyReference: string;
    modelListMode: ModelListMode;
  }) => Promise<string[]>;
  /**
   * External provider catalog. When provided, replaces the built-in PROVIDER_CATALOG.
   * The desktop layer passes this to centralize provider metadata in @javis/core.
   */
  providerCatalog?: readonly ProviderCatalogEntry[];
  /** Resolve default capabilities for a provider. Falls back to all-false when omitted. */
  getProviderCapabilities?: (provider: string) => ProviderCapabilities;
}

type SettingsTab = "general" | "ai" | "privacy" | "about";
type SettingsTabIcon = "general" | "ai" | "privacy" | "about";

const SLOT_LABELS: Record<WorkbenchModelSlot, { zh: string; en: string }> = {
  primary: { zh: "主力模型", en: "Primary" },
  secondary: { zh: "轻量模型", en: "Secondary" },
  multimodal: { zh: "视觉模型", en: "Multimodal" },
};

const MODEL_SLOTS = ["primary", "secondary", "multimodal"] as const;

const FALLBACK_AGENT_CATALOG: WorkbenchAgentCatalogEntry[] = [
  { kind: "commander", displayName: "Commander" },
  { kind: "code", displayName: "Code Agent" },
  { kind: "verifier", displayName: "Verifier" },
  { kind: "scheduler", displayName: "Scheduler Agent" },
  { kind: "research", displayName: "Research Agent" },
  { kind: "file", displayName: "File Agent" },
  { kind: "shell", displayName: "Shell Agent" },
  { kind: "computer", displayName: "Computer Agent" },
  { kind: "browser", displayName: "Browser Agent" },
  { kind: "workspace", displayName: "Workspace Agent" },
  { kind: "vision", displayName: "Vision Agent" },
];

const API_TYPE_OPTIONS = [
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
] as const;

type ApiType = (typeof API_TYPE_OPTIONS)[number]["value"];
type ModelListMode = "openai" | "anthropic" | "unsupported";

const PROVIDER_CATALOG = [
  { id: "openai", label: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "deepseek-anthropic", label: "DeepSeek Anthropic", defaultBaseUrl: "https://api.deepseek.com/anthropic", apiType: "anthropic-messages", modelListMode: "anthropic" },
  { id: "anthropic", label: "Anthropic", defaultBaseUrl: "https://api.anthropic.com", apiType: "anthropic-messages", modelListMode: "anthropic" },
  { id: "dashscope", label: "阿里云百炼 (DashScope)", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "dashscope-coding", label: "百炼 Coding Plan", defaultBaseUrl: "https://coding.dashscope.aliyuncs.com/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "siliconflow", label: "SiliconFlow (硅基流动)", defaultBaseUrl: "https://api.siliconflow.cn/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "zhipu", label: "智谱 AI (GLM)", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "moonshot", label: "Moonshot (Kimi)", defaultBaseUrl: "https://api.moonshot.cn/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "baichuan", label: "百川智能", defaultBaseUrl: "https://api.baichuan-ai.com/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "stepfun", label: "阶跃星辰 (StepFun)", defaultBaseUrl: "https://api.stepfun.com/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "volcengine", label: "火山引擎 (豆包)", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "volcengine-coding", label: "火山引擎 Coding Plan", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "hunyuan", label: "腾讯混元", defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "baidu-cloud", label: "百度智能云 (文心)", defaultBaseUrl: "https://qianfan.baidubce.com/v2", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "modelscope", label: "魔搭 (ModelScope)", defaultBaseUrl: "https://api-inference.modelscope.cn/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "infini", label: "无问芯穹 (Infini)", defaultBaseUrl: "https://cloud.infini-ai.com/maas/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "mimo", label: "Xiaomi (MiMo)", defaultBaseUrl: "https://api.xiaomimimo.com/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "openrouter", label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "groq", label: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "together", label: "Together AI", defaultBaseUrl: "https://api.together.xyz/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "fireworks", label: "Fireworks AI", defaultBaseUrl: "https://api.fireworks.ai/inference/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "mistral", label: "Mistral AI", defaultBaseUrl: "https://api.mistral.ai/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "perplexity", label: "Perplexity", defaultBaseUrl: "https://api.perplexity.ai", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "xai", label: "xAI (Grok)", defaultBaseUrl: "https://api.x.ai/v1", apiType: "openai-compatible", modelListMode: "openai" },
  { id: "gemini", label: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "minimax-token-plan", label: "MiniMax Token Plan", defaultBaseUrl: "https://api.minimax.io/v1", apiType: "openai-compatible", modelListMode: "unsupported" },
  { id: "ollama", label: "Ollama (本地)", defaultBaseUrl: "http://localhost:11434/v1", apiType: "openai-compatible", modelListMode: "openai" },
] as const satisfies readonly ProviderCatalogEntry[];

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider.label]),
);

const PROVIDERS_BY_ID = new Map<string, ProviderCatalogEntry>(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
);

const DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS: WorkbenchComputerUseLocalVisionSettings = {
  mode: "off",
  modelPath: "models/local-vision/yolo26n-ui.onnx",
  runtime: "auto",
  runtimeAdapterPath: "",
  imgsz: 640,
  timeoutMs: 120,
  maxDetections: 20,
  minConfidence: 0.75,
  iouThreshold: 0.45,
  promptTopK: 8,
  disableAfterConsecutiveTimeouts: 2,
  disableAfterConsecutiveErrors: 2,
  disableAfterConsecutiveActionFailures: 2,
  reuseWorker: true,
};

const DEFAULT_COMPUTER_USE_SETTINGS: WorkbenchComputerUseSettings = {
  enabled: false,
  maxStepsPerTask: 20,
  mouseSpeed: "instant",
  mouseDurationMs: 200,
  typeDelayMs: 50,
  deniedWindowPatterns: [],
};

const DEFAULT_RUNTIME_PREFERENCES: WorkbenchRuntimePreferences = {
  appearanceTheme: "light",
  defaultStartupMode: "chat",
  contextStrategy: "auto",
  agentMaxRoundsPreset: "8",
  agentMaxRoundsCustom: 8,
  taskTimeoutPreset: "standard",
  taskTimeoutCustomMs: 90_000,
  agentMemoryScope: "workspace",
  agentMemoryEmbeddingMode: "local",
  agentMemoryEmbeddingProvider: "openai",
  agentMemoryEmbeddingModel: "text-embedding-3-small",
  agentMemoryEmbeddingBaseUrl: "https://api.openai.com/v1",
  agentMemoryEmbeddingApiKeyReference: "model.embedding",
  agentMemoryEmbeddingDimensions: 1536,
  taskQueuePolicy: "queue",
  failureRecoveryPolicy: "replan",
  userWaitTimeoutPreset: "standard",
  userWaitTimeoutCustomMs: 5 * 60_000,
};


interface ConfiguredModelOption {
  value: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyReference: string;
  contextTokens?: number;
}

interface RoundedSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function emptyProfile(slot: WorkbenchModelSlot): WorkbenchModelProfile {
  return {
    id: slot,
    slot,
    displayName: SLOT_LABELS[slot].en,
    provider: "",
    model: "",
    apiKeyReference: `model.${slot}`,
    baseUrl: "",
    apiKey: "",
    capabilities: { vision: false, code: false, longContext: false },
  };
}

export function ModelSettings({
  labels,
  locale,
  agentCatalog,
  modelSettings,
  modelConfiguration,
  computerUseSettings,
  computerUseLocalVisionSettings,
  trustedComputerApps = [],
  runtimePreferences,
  userProfileMemorySummary,
  agentMemorySummary,
  onModelSettingsChange,
  onTestModelConnection,
  onModelConfigurationChange,
  onComputerUseSettingsChange,
  onComputerUseLocalVisionSettingsChange,
  onRemoveTrustedComputerApp,
  onRuntimePreferencesChange,
  onRebuildUserProfileMemory,
  onClearUserProfileMemory,
  onAgentMemoryEnabledChange,
  onClearAgentMemory,
  onClearWorkspaceAgentMemory,
  onDeleteAgentMemoryFact,
  onReadAgentStyle,
  onSaveAgentStyle,
  onResetAgentStyle,
  onSaveProviderApiKey,
  onFetchProviderModels,
  providerCatalog,
  getProviderCapabilities,
}: ModelSettingsProps) {
  const [isOpen, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const isWebPreview =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const isZh = labels.aiModeSettings === "AI 模式";
  const effectiveLocale: WorkbenchLocale = locale ?? { labels };
  const assignableAgents = useMemo(
    () => buildAssignableAgentOptions(agentCatalog, effectiveLocale),
    [agentCatalog, effectiveLocale],
  );

  // Effective catalog: external prop overrides built-in, falls back to hardcoded default.
  const effectiveCatalog = providerCatalog ?? PROVIDER_CATALOG;
  const effectiveOptions = useMemo(
    () => effectiveCatalog.map((p) => p.id),
    [effectiveCatalog],
  );
  const effectiveLabels: Record<string, string> = useMemo(
    () => Object.fromEntries(effectiveCatalog.map((p) => [p.id, p.label])),
    [effectiveCatalog],
  );
  const effectiveById = useMemo(
    () => new Map(effectiveCatalog.map((p) => [p.id, p])),
    [effectiveCatalog],
  );

  function resolveDefaultCapabilities(provider: string): ProviderCapabilities {
    return getProviderCapabilities?.(provider) ?? { vision: false, code: false, longContext: false };
  }

  // Per-provider state
  const [providerApiKeys, setProviderApiKeys] = useState<Record<string, string>>({});
  const [providerKeySaved, setProviderKeySaved] = useState<Record<string, boolean>>({});
  const [providerBaseUrls, setProviderBaseUrls] = useState<Record<string, string>>({});

  // Local editing state for multi-model configuration
  const [slotProfiles, setSlotProfiles] = useState<WorkbenchModelProfile[]>(
    () => modelConfiguration?.profiles.map((p) => ({ ...p, apiKey: "" })) ?? [],
  );
  const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>(
    () => ({ ...(modelConfiguration?.agentOverrides ?? {}) }),
  );
  const [selectedProvider, setSelectedProvider] = useState(modelSettings.provider || "openai");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [openModelSlot, setOpenModelSlot] = useState<WorkbenchModelSlot | null>(null);
  const [openProviderModelMenu, setOpenProviderModelMenu] = useState(false);
  const [fetchedModelsByProvider, setFetchedModelsByProvider] = useState<Record<string, string[]>>({});
  const [modelFetchMessage, setModelFetchMessage] = useState("");
  const [modelFetchLoading, setModelFetchLoading] = useState(false);
  const [modelIdToAdd, setModelIdToAdd] = useState("");
  const modelMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [modelMenuStyle, setModelMenuStyle] = useState<CSSProperties>({});

  function openModelMenu() {
    if (modelMenuTriggerRef.current) {
      const rect = modelMenuTriggerRef.current.getBoundingClientRect();
      setModelMenuStyle({
        position: "fixed",
        zIndex: 600,
        top: rect.bottom + 8,
        left: rect.left,
        width: rect.width,
      });
    }
    setOpenProviderModelMenu(true);
  }

  function closeModelMenu() {
    setOpenProviderModelMenu(false);
  }

  // Click-outside for the portaled menu — the onBlur approach can't work
  // because the menu is outside the container's DOM hierarchy.
  useEffect(() => {
    if (!openProviderModelMenu) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      const menu = document.querySelector(".javis-ai-provider-model-menu");
      if (menu?.contains(target)) return;
      if (modelMenuTriggerRef.current?.contains(target)) return;
      closeModelMenu();
    }
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [openProviderModelMenu]);

  // Sync from props when configuration changes (not on every modal open).
  const prevConfigRef = useRef(modelConfiguration);
  useEffect(() => {
    if (modelConfiguration && modelConfiguration !== prevConfigRef.current) {
      prevConfigRef.current = modelConfiguration;
      setSlotProfiles(
        modelConfiguration.profiles.map((p) => ({ ...p, apiKey: "" })),
      );
      setAgentOverrides({ ...modelConfiguration.agentOverrides });
      // Restore per-provider key saved status from stored profiles
      const storedStatuses: Record<string, boolean> = {};
      for (const profile of modelConfiguration.profiles) {
        if (profile.hasStoredApiKey && profile.apiKeyReference) {
          const provider = extractProviderFromKeyRef(profile.apiKeyReference);
          if (provider) storedStatuses[provider] = true;
        }
      }
      if (Object.keys(storedStatuses).length > 0) {
        setProviderKeySaved((prev) => ({ ...prev, ...storedStatuses }));
      }
      setProviderBaseUrls((prev) => ({
        ...providerBaseUrlsFromProfiles(modelConfiguration.profiles),
        ...prev,
      }));
    }
  }, [modelConfiguration]);

  useEffect(() => {
    setSelectedProvider(modelSettings.provider || "openai");
  }, [modelSettings.provider]);

  const tabs: Array<{ id: SettingsTab; icon: SettingsTabIcon; label: string }> = [
    { id: "general", icon: "general", label: labels.generalSettings },
    { id: "ai", icon: "ai", label: labels.aiModeSettings },
    { id: "privacy", icon: "privacy", label: labels.privacySecuritySettings },
    { id: "about", icon: "about", label: labels.aboutFeedbackSettings },
  ];
  const themeOptions: Array<{ value: WorkbenchAppearanceTheme; label: string }> = [
    { value: "light", label: isZh ? "亮色" : "Light" },
    { value: "dark", label: isZh ? "暗色" : "Dark" },
    { value: "glass", label: isZh ? "毛玻璃" : "Glass" },
    { value: "high_contrast", label: isZh ? "高对比" : "High contrast" },
  ];

  function updateModelSetting(field: keyof WorkbenchModelSettings, value: string) {
    setTestStatus("idle");
    setTestMessage("");
    onModelSettingsChange?.({
      ...modelSettings,
      [field]: value,
    });
    if (field === "provider") {
      setSelectedProvider(value || "openai");
    }
  }

  const effectiveLocalVisionSettings =
    computerUseLocalVisionSettings ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS;
  const effectiveComputerUseSettings =
    computerUseSettings ?? DEFAULT_COMPUTER_USE_SETTINGS;
  const effectiveRuntimePreferences =
    runtimePreferences ?? DEFAULT_RUNTIME_PREFERENCES;

  function updateComputerUseSetting(
    patch: Partial<WorkbenchComputerUseSettings>,
  ) {
    onComputerUseSettingsChange?.({
      ...effectiveComputerUseSettings,
      ...patch,
    });
  }

  function updateLocalVisionSetting(
    patch: Partial<WorkbenchComputerUseLocalVisionSettings>,
  ) {
    onComputerUseLocalVisionSettingsChange?.({
      ...effectiveLocalVisionSettings,
      ...patch,
    });
  }

  function updateRuntimePreferences(patch: Partial<WorkbenchRuntimePreferences>) {
    onRuntimePreferencesChange?.({
      ...effectiveRuntimePreferences,
      ...patch,
    });
  }

  function assignConfiguredModelToSlot(slot: WorkbenchModelSlot, optionValue: string) {
    if (!optionValue) {
      setSlotProfiles((current) => current.filter((profile) => profile.slot !== slot));
      setOpenModelSlot(null);
      return;
    }
    const option = configuredModels.find((model) => model.value === optionValue);
    if (!option) return;
    setSlotProfiles((current) => {
      const existingProfile = current.find((p) => p.slot === slot);
      const nextProfile: WorkbenchModelProfile = {
        ...(existingProfile ?? emptyProfile(slot)),
        provider: option.provider,
        model: option.model,
        apiKeyReference: option.apiKeyReference,
        baseUrl: option.baseUrl,
        contextTokens: option.contextTokens,
      };
      const inferredProfile = withInferredContextTokens(nextProfile);
      if (!existingProfile) {
        return [...current, inferredProfile];
      }
      return current.map((profile) =>
        profile.slot === slot ? inferredProfile : profile,
      );
    });
    setOpenModelSlot(null);
  }

  function handleSaveConfiguration() {
    if (!onModelConfigurationChange) return;
    try {
      const addedProfiles = slotProfiles.filter((profile) => profile.slot === null);
      onModelConfigurationChange({
        profiles: [
          ...addedProfiles.map((profile) => ({ ...profile })),
          ...MODEL_SLOTS.map((slot) =>
            normalizeSlotProfileConnection(
              getProfileForSlot(slot),
              addedProfiles,
              providerBaseUrls,
              modelSettings,
              effectiveById,
            ),
          ),
        ],
        agentOverrides: { ...agentOverrides },
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus("idle"), 2500);
  }

  async function handleTestModelConnectionForProvider(
    provider: string,
    model: string,
    baseUrl: string,
    apiKeyReference: string,
  ) {
    if (!onTestModelConnection || testStatus === "testing") return;
    setTestStatus("testing");
    setTestMessage(isZh ? "正在测试 API 连通性..." : "Testing API connection...");
    try {
      const testSettings: WorkbenchModelSettings = {
        provider,
        model,
        apiKey: providerApiKeys[provider] ?? "",
        apiKeyReference,
        baseUrl,
      };
      const message = await onTestModelConnection(testSettings);
      setTestStatus("success");
      setTestMessage(message || (isZh ? "API 连通正常" : "API connection is healthy"));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : (isZh ? "API 连通测试失败" : "API connection test failed");
      setTestStatus("error");
      setTestMessage(message);
    }
  }

  function getProfileForSlot(slot: WorkbenchModelSlot): WorkbenchModelProfile {
    return slotProfiles.find((p) => p.slot === slot) ?? emptyProfile(slot);
  }

  function selectProvider(provider: string) {
    setSelectedProvider(provider);
    updateModelSetting("provider", provider);
  }

  function updateApiType(apiType: ApiType) {
    if (selectedProvider === "deepseek" || selectedProvider === "deepseek-anthropic") {
      selectProvider(apiType === "anthropic-messages" ? "deepseek-anthropic" : "deepseek");
      return;
    }
  }

  function providerCount(provider: string): number {
    return slotProfiles.filter((profile) => profile.slot === null && profile.provider === provider).length;
  }

  function addProviderModel(model: string) {
    if (!model || !selectedProvider.trim()) return;
    const matchingProviderProfile = slotProfiles.find((profile) =>
      profile.provider === selectedProvider &&
      (profile.baseUrl || profile.apiKeyReference),
    );
    const baseUrl = getProviderBaseUrl(
      selectedProvider,
      slotProfiles,
      providerBaseUrls,
      modelSettings,
      effectiveById,
    );
    // Always use per-provider key reference — not legacy "default"
    const apiKeyReference = matchingProviderProfile?.apiKeyReference ?? `model.${selectedProvider}`;
    setSlotProfiles((current) => {
      if (current.some((profile) => profile.provider === selectedProvider && profile.model === model)) {
        return current;
      }
      const id = uniqueProfileId(current, `${selectedProvider}.${model}`);
      const apiKey = providerApiKeys[selectedProvider]?.trim() ?? "";
      const nextProfile = withInferredContextTokens({
        id,
        slot: null,
        displayName: model,
        provider: selectedProvider,
        model,
        apiKeyReference,
        baseUrl,
        apiKey,
        hasStoredApiKey: Boolean(apiKey) || providerKeySaved[selectedProvider],
        capabilities: resolveDefaultCapabilities(selectedProvider),
      });
      return [
        ...current,
        nextProfile,
      ];
    });
    if (modelSettings.provider === selectedProvider && modelSettings.model !== model) {
      updateModelSetting("model", model);
    }
    setModelIdToAdd("");
  }

  const configuredModels = buildConfiguredModelOptions(modelSettings, slotProfiles.filter((profile) => profile.slot === null), effectiveLabels);
  const providerModels = buildConfiguredModelOptions(
    { ...modelSettings, model: "" },
    slotProfiles.filter((profile) => profile.slot === null && profile.provider === selectedProvider),
    effectiveLabels,
  );
  const fetchedProviderModels = fetchedModelsByProvider[selectedProvider] ?? [];
  const addedProviderModelNames = new Set(providerModels.map((model) => model.model));
  const selectedProviderLabel = effectiveLabels[selectedProvider] ?? selectedProvider;
  const selectedApiType = resolveApiType(selectedProvider, effectiveById);
  const selectedModelListMode = getModelListModeForProvider(selectedProvider, effectiveById);

  async function fetchProviderModels() {
    const modelListMode = getModelListModeForProvider(selectedProvider, effectiveById);
    if (modelListMode === "unsupported") {
      openModelMenu();
      setModelFetchMessage(
        isZh
          ? "当前供应商暂不支持自动获取模型，请手动输入模型 ID"
          : "This provider does not support automatic model fetch yet. Enter the model ID manually.",
      );
      return;
    }

    const baseUrl = getProviderBaseUrl(
      selectedProvider,
      slotProfiles,
      providerBaseUrls,
      modelSettings,
      effectiveById,
    ).trim();
    if (!baseUrl) {
      setModelFetchMessage(isZh ? "请先配置 Base URL" : "Please configure a Base URL first");
      return;
    }

    if (!onFetchProviderModels) {
      openModelMenu();
      setModelFetchMessage(
        isZh
          ? "模型列表后端不可用，请手动输入模型 ID"
          : "Model list backend is unavailable. Enter the model ID manually.",
      );
      return;
    }

    const typedKey = providerApiKeys[selectedProvider]?.trim() ?? "";
    const selectedApiType = resolveApiType(selectedProvider, effectiveById);
    const keyRef = getProviderKeyReference(selectedProvider, slotProfiles);

    setModelFetchLoading(true);
    setModelFetchMessage(isZh ? "正在获取模型列表..." : "Fetching model list...");
    try {
      const modelIds = await onFetchProviderModels({
        provider: selectedProvider,
        baseUrl,
        apiKey: typedKey,
        apiType: selectedApiType,
        keyReference: keyRef,
        modelListMode,
      });

      if (modelIds.length === 0) {
        setModelFetchMessage(isZh ? "未找到可用模型" : "No models found");
        setModelFetchLoading(false);
        return;
      }

      setFetchedModelsByProvider((current) => ({
        ...current,
        [selectedProvider]: modelIds,
      }));
      openModelMenu();
      setModelFetchMessage("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setModelFetchMessage(
        isZh ? `获取失败：${msg}` : `Fetch failed: ${msg}`,
      );
    } finally {
      setModelFetchLoading(false);
    }
  }

  return (
    <div className="javis-settings">
      <datalist id="javis-provider-options">
        {effectiveOptions.map((provider) => (
          <option key={provider} value={provider} />
        ))}
      </datalist>
      <button
        className="javis-settings-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="javis-nav-icon icon-settings" aria-hidden="true">⚙</span>
        <span>{labels.settings}</span>
      </button>
      {isOpen && typeof document !== "undefined" ? createPortal((
        <div
          className="javis-settings-modal-backdrop"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <section
            aria-label={labels.settings}
            aria-modal="true"
            className="javis-settings-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <aside className="javis-settings-tabs">
              <p>{labels.settings}</p>
              {tabs.map((tab) => (
                <button
                  className={activeTab === tab.id ? "active" : ""}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  type="button"
                >
                  <span className={`javis-settings-tab-icon icon-${tab.icon}`} aria-hidden="true" />
                  <span>{tab.label}</span>
                </button>
              ))}
            </aside>
            <main className="javis-settings-detail">
              <button
                className="javis-settings-close"
                aria-label={labels.closeSettings}
                onClick={() => setOpen(false)}
                type="button"
              >
                <span className="javis-settings-close-icon" aria-hidden="true" />
              </button>
              {activeTab === "general" ? (
                <section className="javis-settings-section javis-computer-use-settings" aria-label={labels.generalSettings}>
                  <h2>{isZh ? "运行设置" : "Run Settings"}</h2>
                  <div className="javis-settings-card">
                    <div className="javis-settings-field javis-settings-field-wide">
                      <span>{isZh ? "主题色" : "Theme color"}</span>
                      <div
                        aria-label={isZh ? "主题色" : "Theme color"}
                        className="javis-theme-options"
                        role="radiogroup"
                      >
                        {themeOptions.map((option) => (
                          <button
                            aria-checked={effectiveRuntimePreferences.appearanceTheme === option.value}
                            className={`javis-theme-option theme-${option.value}`}
                            key={option.value}
                            onClick={() =>
                              updateRuntimePreferences({
                                appearanceTheme: option.value,
                              })}
                            role="radio"
                            type="button"
                          >
                            <span className="javis-theme-swatch" aria-hidden="true" />
                            <span>{option.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <label>
                      <span>{isZh ? "默认启动模式" : "Default startup mode"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "默认启动模式" : "Default startup mode"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            defaultStartupMode: value as WorkbenchDefaultStartupMode,
                          })}
                        options={[
                          { value: "chat", label: isZh ? "聊天" : "Chat" },
                          { value: "project", label: isZh ? "Agent 任务" : "Agent task" },
                          { value: "auto", label: isZh ? "自动" : "Auto" },
                        ]}
                        value={effectiveRuntimePreferences.defaultStartupMode}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "任务排队策略" : "Task queue policy"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "任务排队策略" : "Task queue policy"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            taskQueuePolicy: value as WorkbenchTaskQueuePolicy,
                          })}
                        options={[
                          { value: "queue", label: isZh ? "允许排队" : "Allow queue" },
                          { value: "current_only", label: isZh ? "仅当前任务" : "Current task only" },
                          { value: "interrupt", label: isZh ? "新任务打断当前任务" : "Interrupt with new task" },
                        ]}
                        value={effectiveRuntimePreferences.taskQueuePolicy}
                      />
                    </label>
                  </div>
                  <h2>Computer Use</h2>
                  <div className="javis-settings-card">
                    <label className="javis-settings-toggle">
                      <input
                        aria-label="Enable Computer Use"
                        checked={effectiveComputerUseSettings.enabled}
                        onChange={(event) =>
                          updateComputerUseSetting({ enabled: event.currentTarget.checked })}
                        type="checkbox"
                      />
                      <span>{isZh ? "启用 Computer Use" : "Enable Computer Use"}</span>
                    </label>
                    <label>
                      <span>{isZh ? "每个任务最大步数" : "Maximum steps per task"}</span>
                      <input
                        aria-label="Maximum Computer Use steps"
                        max={60}
                        min={1}
                        onChange={(event) =>
                          updateComputerUseSetting({
                            maxStepsPerTask: numberInputValue(event.currentTarget.value, 20),
                          })}
                        type="number"
                        value={effectiveComputerUseSettings.maxStepsPerTask}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "Mouse speed" : "Mouse speed"}</span>
                      <RoundedSelect
                        aria-label="Computer Use mouse speed"
                        onChange={(value) =>
                          updateComputerUseSetting({
                            mouseSpeed: value as WorkbenchComputerUseSettings["mouseSpeed"],
                          })}
                        options={[
                          { value: "instant", label: isZh ? "Instant" : "Instant" },
                          { value: "linear", label: isZh ? "Linear" : "Linear" },
                        ]}
                        value={effectiveComputerUseSettings.mouseSpeed}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "Mouse duration ms" : "Mouse duration ms"}</span>
                      <input
                        aria-label="Computer Use mouse duration"
                        max={1000}
                        min={0}
                        onChange={(event) =>
                          updateComputerUseSetting({
                            mouseDurationMs: numberInputValue(event.currentTarget.value, 200),
                          })}
                        type="number"
                        value={effectiveComputerUseSettings.mouseDurationMs}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "Type delay ms" : "Type delay ms"}</span>
                      <input
                        aria-label="Computer Use type delay"
                        max={500}
                        min={0}
                        onChange={(event) =>
                          updateComputerUseSetting({
                            typeDelayMs: numberInputValue(event.currentTarget.value, 50),
                          })}
                        type="number"
                        value={effectiveComputerUseSettings.typeDelayMs}
                      />
                    </label>
                    <label className="javis-settings-field-wide">
                      <span>{isZh ? "Denied window title patterns" : "Denied window title patterns"}</span>
                      <textarea
                        aria-label="Denied Computer Use window patterns"
                        onChange={(event) =>
                          updateComputerUseSetting({
                            deniedWindowPatterns: event.currentTarget.value.split(/\r?\n/),
                          })}
                        rows={3}
                        value={effectiveComputerUseSettings.deniedWindowPatterns.join("\n")}
                      />
                    </label>
                    <div className="javis-settings-field-wide" aria-label={labels.trustedComputerApps}>
                      <div className="javis-document-row">
                        <strong>{labels.trustedComputerApps}</strong>
                        <span>{trustedComputerApps.length}</span>
                      </div>
                      {trustedComputerApps.length > 0 ? (
                        <div className="javis-computer-list">
                          {trustedComputerApps.map((app) => (
                            <div className="javis-computer-row" key={app.title}>
                              <span className="javis-computer-icon file small" aria-hidden="true">APP</span>
                              <span className="javis-computer-name">{app.title}</span>
                              <span className="javis-computer-date">{app.trustedAt.slice(0, 10)}</span>
                              {onRemoveTrustedComputerApp ? (
                                <button
                                  onClick={() => onRemoveTrustedComputerApp(app.title)}
                                  type="button"
                                >
                                  {labels.removeTrustedApp}
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <label>
                      <span>{isZh ? "本地视觉加速" : "Local vision acceleration"}</span>
                      <RoundedSelect
                        aria-label="Local vision acceleration"
                        onChange={(value) =>
                          updateLocalVisionSetting({
                            mode: value as WorkbenchComputerUseLocalVisionMode,
                          })}
                        options={[
                          { value: "off", label: isZh ? "关闭" : "Off" },
                          { value: "passive", label: isZh ? "被动检测" : "Passive" },
                          { value: "prompt_hint", label: isZh ? "提示词线索" : "Prompt hints" },
                        ]}
                        value={effectiveLocalVisionSettings.mode}
                      />
                    </label>
                    <label className="javis-settings-field-wide">
                      <span>{isZh ? "YOLO ONNX 模型路径" : "YOLO ONNX model path"}</span>
                      <input
                        aria-label="YOLO ONNX model path"
                        onChange={(event) =>
                          updateLocalVisionSetting({ modelPath: event.currentTarget.value })}
                        placeholder="E:\\models\\yolo26n-ui.onnx"
                        value={effectiveLocalVisionSettings.modelPath}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "运行时" : "Runtime"}</span>
                      <RoundedSelect
                        aria-label="Local vision runtime"
                        onChange={(value) =>
                          updateLocalVisionSetting({
                            runtime: value as WorkbenchComputerUseLocalVisionRuntime,
                          })}
                        options={[
                          { value: "auto", label: "Auto" },
                          { value: "onnxruntime", label: "ONNX Runtime" },
                          { value: "openvino", label: "OpenVINO" },
                          { value: "tensorrt", label: "TensorRT" },
                        ]}
                        value={effectiveLocalVisionSettings.runtime}
                      />
                    </label>
                    <label className="javis-settings-field-wide">
                      <span>{isZh ? "运行时适配器路径" : "Runtime adapter path"}</span>
                      <input
                        aria-label="Runtime adapter path"
                        onChange={(event) =>
                          updateLocalVisionSetting({ runtimeAdapterPath: event.currentTarget.value })}
                        placeholder="E:\\models\\yolo26-ui-adapter.mjs"
                        value={effectiveLocalVisionSettings.runtimeAdapterPath}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "检测超时（毫秒）" : "Detection timeout (ms)"}</span>
                      <input
                        aria-label="Detection timeout"
                        max={2000}
                        min={20}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            timeoutMs: numberInputValue(event.currentTarget.value, 120),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.timeoutMs}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "图像尺寸" : "Image size"}</span>
                      <input
                        aria-label="Local vision image size"
                        max={1280}
                        min={320}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            imgsz: numberInputValue(event.currentTarget.value, 640),
                          })}
                        step={32}
                        type="number"
                        value={effectiveLocalVisionSettings.imgsz}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "最低置信度" : "Minimum confidence"}</span>
                      <input
                        aria-label="Minimum confidence"
                        max={1}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            minConfidence: numberInputFloatValue(event.currentTarget.value, 0.75),
                          })}
                        step={0.05}
                        type="number"
                        value={effectiveLocalVisionSettings.minConfidence}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "最大检测数" : "Maximum detections"}</span>
                      <input
                        aria-label="Maximum detections"
                        max={100}
                        min={1}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            maxDetections: numberInputValue(event.currentTarget.value, 20),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.maxDetections}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "IoU 阈值" : "IoU threshold"}</span>
                      <input
                        aria-label="IoU threshold"
                        max={1}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            iouThreshold: numberInputFloatValue(event.currentTarget.value, 0.45),
                          })}
                        step={0.05}
                        type="number"
                        value={effectiveLocalVisionSettings.iouThreshold}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "提示候选上限" : "Prompt candidate limit"}</span>
                      <input
                        aria-label="Prompt candidate limit"
                        max={20}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            promptTopK: numberInputValue(event.currentTarget.value, 8),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.promptTopK}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "超时后停用阈值" : "Disable after timeouts"}</span>
                      <input
                        aria-label="Disable after timeouts"
                        max={10}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            disableAfterConsecutiveTimeouts: numberInputValue(event.currentTarget.value, 2),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.disableAfterConsecutiveTimeouts}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "错误后停用阈值" : "Disable after errors"}</span>
                      <input
                        aria-label="Disable after errors"
                        max={10}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            disableAfterConsecutiveErrors: numberInputValue(event.currentTarget.value, 2),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.disableAfterConsecutiveErrors}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "动作失败后停用阈值" : "Disable after action failures"}</span>
                      <input
                        aria-label="Disable after action failures"
                        max={10}
                        min={0}
                        onChange={(event) =>
                          updateLocalVisionSetting({
                            disableAfterConsecutiveActionFailures: numberInputValue(event.currentTarget.value, 2),
                          })}
                        type="number"
                        value={effectiveLocalVisionSettings.disableAfterConsecutiveActionFailures}
                      />
                    </label>
                    <label className="javis-settings-toggle">
                      <input
                        aria-label="Reuse local vision worker"
                        checked={effectiveLocalVisionSettings.reuseWorker}
                        onChange={(event) =>
                          updateLocalVisionSetting({ reuseWorker: event.currentTarget.checked })}
                        type="checkbox"
                      />
                      <span>{isZh ? "复用本地视觉 worker" : "Reuse local vision worker"}</span>
                    </label>
                  </div>
                </section>
              ) : activeTab === "ai" ? (
                <section className="javis-settings-section javis-ai-settings-section" aria-label={labels.aiModeSettings}>
                  <h2>{isZh ? "任务运行策略" : "Task Runtime"}</h2>
                  <div className="javis-settings-card javis-ai-agent-card">
                    <label>
                      <span>{isZh ? "上下文策略" : "Context strategy"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "上下文策略" : "Context strategy"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            contextStrategy: value as WorkbenchContextStrategy,
                          })}
                        options={[
                          { value: "auto", label: isZh ? "自动" : "Auto" },
                          { value: "short", label: isZh ? "短上下文" : "Short" },
                          { value: "long", label: isZh ? "长上下文" : "Long" },
                        ]}
                        value={effectiveRuntimePreferences.contextStrategy}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "Agent 最大轮数" : "Agent max rounds"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "Agent 最大轮数" : "Agent max rounds"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            agentMaxRoundsPreset: value as WorkbenchAgentMaxRoundsPreset,
                          })}
                        options={[
                          { value: "4", label: "4" },
                          { value: "8", label: "8" },
                          { value: "12", label: "12" },
                          { value: "custom", label: isZh ? "自定义" : "Custom" },
                        ]}
                        value={effectiveRuntimePreferences.agentMaxRoundsPreset}
                      />
                    </label>
                    {effectiveRuntimePreferences.agentMaxRoundsPreset === "custom" ? (
                      <label>
                        <span>{isZh ? "自定义轮数" : "Custom rounds"}</span>
                        <input
                          aria-label={isZh ? "自定义轮数" : "Custom rounds"}
                          max={24}
                          min={1}
                          onChange={(event) =>
                            updateRuntimePreferences({
                              agentMaxRoundsCustom: numberInputValue(event.currentTarget.value, 8),
                            })}
                          type="number"
                          value={effectiveRuntimePreferences.agentMaxRoundsCustom}
                        />
                      </label>
                    ) : null}
                    <label>
                      <span>{isZh ? "任务超时策略" : "Task timeout strategy"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "任务超时策略" : "Task timeout strategy"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            taskTimeoutPreset: value as WorkbenchTaskTimeoutPreset,
                          })}
                        options={[
                          { value: "standard", label: isZh ? "标准" : "Standard" },
                          { value: "long", label: isZh ? "长任务" : "Long task" },
                          { value: "custom", label: isZh ? "自定义" : "Custom" },
                        ]}
                        value={effectiveRuntimePreferences.taskTimeoutPreset}
                      />
                    </label>
                    {effectiveRuntimePreferences.taskTimeoutPreset === "custom" ? (
                      <label>
                        <span>{isZh ? "自定义超时（秒）" : "Custom timeout (seconds)"}</span>
                        <input
                          aria-label={isZh ? "自定义超时（秒）" : "Custom timeout seconds"}
                          max={900}
                          min={30}
                          onChange={(event) =>
                            updateRuntimePreferences({
                              taskTimeoutCustomMs: numberInputValue(event.currentTarget.value, 90) * 1000,
                            })}
                          type="number"
                          value={Math.round(effectiveRuntimePreferences.taskTimeoutCustomMs / 1000)}
                        />
                      </label>
                    ) : null}
                    <label>
                      <span>{isZh ? "失败恢复策略" : "Failure recovery"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "失败恢复策略" : "Failure recovery"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            failureRecoveryPolicy: value as WorkbenchFailureRecoveryPolicy,
                          })}
                        options={[
                          { value: "replan", label: isZh ? "自动重规划" : "Auto replan" },
                          { value: "stop", label: isZh ? "直接停止" : "Stop on failure" },
                        ]}
                        value={effectiveRuntimePreferences.failureRecoveryPolicy}
                      />
                    </label>
                    <label>
                      <span>{isZh ? "等待用户超时" : "User wait timeout"}</span>
                      <RoundedSelect
                        aria-label={isZh ? "等待用户超时" : "User wait timeout"}
                        onChange={(value) =>
                          updateRuntimePreferences({
                            userWaitTimeoutPreset: value as WorkbenchUserWaitTimeoutPreset,
                          })}
                        options={[
                          { value: "standard", label: isZh ? "标准（5 分钟）" : "Standard (5 min)" },
                          { value: "long", label: isZh ? "长等待（30 分钟）" : "Long wait (30 min)" },
                          { value: "custom", label: isZh ? "自定义" : "Custom" },
                        ]}
                        value={effectiveRuntimePreferences.userWaitTimeoutPreset}
                      />
                    </label>
                    {effectiveRuntimePreferences.userWaitTimeoutPreset === "custom" ? (
                      <label>
                        <span>{isZh ? "自定义等待（分钟）" : "Custom wait (minutes)"}</span>
                        <input
                          aria-label={isZh ? "自定义等待（分钟）" : "Custom wait minutes"}
                          max={120}
                          min={1}
                          onChange={(event) =>
                            updateRuntimePreferences({
                              userWaitTimeoutCustomMs: numberInputValue(event.currentTarget.value, 5) * 60_000,
                            })}
                          type="number"
                          value={Math.round(effectiveRuntimePreferences.userWaitTimeoutCustomMs / 60_000)}
                        />
                      </label>
                    ) : null}
                  </div>
                  <h2>{isZh ? "供应商" : "Providers"}</h2>
                  <div className="javis-ai-provider-console">
                    <aside className="javis-ai-provider-list" aria-label={isZh ? "供应商列表" : "Provider list"}>
                      <div className="javis-ai-provider-group">
                        <span>API</span>
                        {effectiveOptions.map((provider) => (
                          <button
                            className={selectedProvider === provider ? "active" : ""}
                            key={provider}
                            onClick={() => selectProvider(provider)}
                            type="button"
                          >
                            <span className="javis-ai-provider-dot" />
                            <strong>{effectiveLabels[provider] ?? provider}</strong>
                            <em>{providerCount(provider)}</em>
                          </button>
                        ))}
                      </div>
                    </aside>
                    <div className="javis-ai-provider-detail">
                      <header>
                        <h3>{selectedProviderLabel}</h3>
                        <button
                          className="javis-ai-test-button"
                          disabled={!onTestModelConnection || testStatus === "testing" || !selectedProvider}
                          onClick={() => {
                            const connection = getProviderConnectionSettings(
                              selectedProvider,
                              slotProfiles,
                              modelSettings,
                              providerBaseUrls,
                              effectiveById,
                            );
                            void handleTestModelConnectionForProvider(
                              selectedProvider,
                              connection.model,
                              connection.baseUrl,
                              connection.apiKeyReference,
                            );
                          }}
                          type="button"
                        >
                          {testStatus === "testing" ? (isZh ? "测试中..." : "Testing...") : (isZh ? "测试 API" : "Test API")}
                        </button>
                      </header>
                    {isWebPreview ? (
                      <p className="javis-model-settings-warning">
                        {labels.modelBackendUnavailable}
                      </p>
                    ) : null}
                      <div className="javis-ai-provider-fields">
                        <label>
                          <span>
                            {labels.modelApiKey}
                            {providerKeySaved[selectedProvider] ? (
                              <span style={{ color: "#22c55e", fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                                ✓ {isZh ? "已存储" : "Stored"}
                              </span>
                            ) : providerApiKeys[selectedProvider]?.trim() ? (
                              <span style={{ color: "#f59e0b", fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                                {isZh ? "点击保存" : "Click to save"}
                              </span>
                            ) : null}
                          </span>
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <input
                              aria-label={labels.modelApiKey}
                              onChange={(event) => {
                                const nextValue = event.currentTarget?.value ?? "";
                                setProviderApiKeys((prev) => ({
                                  ...prev,
                                  [selectedProvider]: nextValue,
                                }));
                              }}
                              placeholder={providerKeySaved[selectedProvider] ? "••••••••" : ""}
                              type="password"
                              value={providerApiKeys[selectedProvider] ?? ""}
                              style={{ flex: 1 }}
                            />
                            <button
                              disabled={!providerApiKeys[selectedProvider]?.trim()}
                              onClick={async () => {
                                const key = providerApiKeys[selectedProvider]?.trim();
                                if (!key || !onSaveProviderApiKey) return;
                                const keyRef = getProviderKeyReference(selectedProvider, slotProfiles);
                                try {
                                  await onSaveProviderApiKey(keyRef, key);
                                } catch (error) {
                                  const msg = error instanceof Error ? error.message : String(error);
                                  setModelFetchMessage(
                                    isZh ? `密钥保存失败：${msg}` : `Failed to save key: ${msg}`,
                                  );
                                  return;
                                }
                                setSlotProfiles((current) =>
                                  current.map((profile) => {
                                    if (profile.apiKeyReference === keyRef) {
                                      return { ...profile, apiKey: key, hasStoredApiKey: true };
                                    }
                                    // Align slot profiles that share this provider
                                    // so the key reference is consistent for lookups.
                                    if (profile.provider === selectedProvider) {
                                      return { ...profile, apiKeyReference: keyRef, hasStoredApiKey: true };
                                    }
                                    return profile;
                                  }),
                                );
                                setProviderKeySaved((prev) => ({ ...prev, [selectedProvider]: true }));
                                setProviderApiKeys((prev) => ({ ...prev, [selectedProvider]: "" }));
                              }}
                              type="button"
                              style={{
                                padding: "0 0.75rem",
                                whiteSpace: "nowrap",
                                fontSize: "0.8125rem",
                              }}
                            >
                              {isZh ? "保存密钥" : "Save Key"}
                            </button>
                          </div>
                        </label>
                        <label>
                          <span>{labels.modelBaseUrl}</span>
                          <input
                            aria-label={labels.modelBaseUrl}
                            onChange={(event) => {
                              const nextValue = event.currentTarget?.value ?? "";
                              setProviderBaseUrls((prev) => ({
                                ...prev,
                                [selectedProvider]: nextValue,
                              }));
                            }}
                            placeholder={getProviderDefaultBaseUrl(selectedProvider, effectiveById)}
                            value={getProviderBaseUrl(
                              selectedProvider,
                              slotProfiles,
                              providerBaseUrls,
                              modelSettings,
                              effectiveById,
                            )}
                          />
                        </label>
                        <label>
                          <span>{isZh ? "API 类型" : "API Type"}</span>
                          <RoundedSelect
                            aria-label={isZh ? "API 类型" : "API Type"}
                            onChange={(value) => updateApiType(value as ApiType)}
                            options={API_TYPE_OPTIONS.map((option) => ({
                              ...option,
                              disabled: !isApiTypeSupportedForProvider(selectedProvider, option.value, effectiveById),
                            }))}
                            value={selectedApiType}
                          />
                        </label>
                      </div>
                      <div className="javis-ai-added-models">
                        <header>
                          <span>{isZh ? "已添加的模型" : "Added models"}</span>
                          <strong>{providerModels.length}</strong>
                        </header>
                        {providerModels.length > 0 ? (
                          <div className="javis-ai-added-model-list">
                            {providerModels.map((model) => (
                              <div className="javis-ai-added-model-row" key={model.value}>
                                <span>{effectiveLabels[model.provider] ?? model.provider}</span>
                                <em>{model.model}</em>
                                <small title={model.apiKeyReference}>{model.apiKeyReference}</small>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p>{isZh ? "还没有添加模型" : "No models added yet"}</p>
                        )}
                        <div className="javis-ai-add-model-row">
                          <div
                            className="javis-ai-provider-model-select"
                          >
                            <button
                              aria-expanded={openProviderModelMenu}
                              aria-haspopup="listbox"
                              className="javis-ai-provider-model-trigger"
                              onClick={() => {
                                  if (openProviderModelMenu) {
                                    setOpenProviderModelMenu(false);
                                  } else {
                                    openModelMenu();
                                  }
                                }}
                                ref={modelMenuTriggerRef}
                                type="button"
                              >
                              <span>{isZh ? "添加模型" : "Add model"}</span>
                              <span className="javis-ai-provider-model-caret" aria-hidden="true">⌄</span>
                            </button>
                            {openProviderModelMenu ? createPortal(
                              <div className="javis-ai-provider-model-menu" role="listbox" style={modelMenuStyle}>
                                {fetchedProviderModels.length > 0 ? fetchedProviderModels.map((model) => {
                                  const isAdded = addedProviderModelNames.has(model);
                                  return (
                                    <button
                                      aria-selected={isAdded}
                                      className={isAdded ? "active" : ""}
                                      key={model}
                                      onClick={() => addProviderModel(model)}
                                      role="option"
                                      type="button"
                                    >
                                      <span>{model}</span>
                                      {isAdded ? <strong>✓</strong> : null}
                                    </button>
                                  );
                                }) : (
                                  <p>{isZh ? "未获取到模型，可手动输入模型 ID" : "No models loaded. Enter a model ID manually."}</p>
                                )}
                                <div className="javis-ai-provider-model-manual">
                                  <input
                                    aria-label={isZh ? "输入模型 ID" : "Enter model ID"}
                                    onChange={(event) => setModelIdToAdd(event.currentTarget?.value ?? "")}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        addProviderModel(modelIdToAdd.trim());
                                      }
                                    }}
                                    placeholder={isZh ? "输入模型 ID" : "Enter model ID"}
                                    value={modelIdToAdd}
                                  />
                                  <button
                                    disabled={!modelIdToAdd.trim()}
                                    onClick={() => addProviderModel(modelIdToAdd.trim())}
                                    type="button"
                                  >
                                    {isZh ? "添加" : "Add"}
                                  </button>
                                </div>
                              </div>,
                              document.body,
                            ) : null}
                          </div>
                          <button
                            disabled={!selectedProvider || modelFetchLoading}
                            onClick={fetchProviderModels}
                            title={selectedModelListMode === "unsupported"
                              ? (isZh ? "当前供应商请手动输入模型 ID" : "Enter model ID manually for this provider")
                              : undefined}
                            type="button"
                          >
                            {modelFetchLoading
                              ? (isZh ? "获取中..." : "Fetching...")
                              : (isZh ? "获取模型" : "Fetch models")}
                          </button>
                        </div>
                        {modelFetchMessage ? (
                          <p className="javis-ai-model-fetch-message" role="status">
                            {modelFetchMessage}
                          </p>
                        ) : null}
                      </div>
                      {testMessage ? (
                        <p className={`javis-ai-test-status ${testStatus}`} role="status">
                          {testMessage}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <>
                    <h2>{isZh ? "其他模型" : "Other Models"}</h2>
                    <div className="javis-ai-model-grid">
                      {MODEL_SLOTS.map((slot) => {
                          const profile = getProfileForSlot(slot);
                          const slotLabel = isZh ? SLOT_LABELS[slot].zh : SLOT_LABELS[slot].en;
                          const selectedModelValue = getConfiguredModelValue(profile, configuredModels);
                          const selectedModel = configuredModels.find((model) => model.value === selectedModelValue);
                          const modelMenuId = `javis-model-slot-menu-${slot}`;
                          return (
                            <div className={`javis-ai-model-card ${slot === "multimodal" ? "wide" : ""}`} key={slot}>
                              <h3>{slotLabel}</h3>
                              <label>
                                <span>{isZh ? "选择模型" : "Model"}</span>
                                <div
                                  className="javis-ai-model-select"
                                  onBlur={(event) => {
                                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                      setOpenModelSlot((current) => current === slot ? null : current);
                                    }
                                  }}
                                >
                                  <button
                                    aria-controls={modelMenuId}
                                    aria-expanded={openModelSlot === slot}
                                    aria-haspopup="listbox"
                                    className="javis-ai-model-select-trigger"
                                    disabled={configuredModels.length === 0}
                                    onClick={() => setOpenModelSlot((current) => current === slot ? null : slot)}
                                    type="button"
                                  >
                                    <span>
                                      {selectedModel?.label ?? (
                                        configuredModels.length === 0
                                          ? (isZh ? "先在上方配置模型" : "Configure a provider model first")
                                          : (isZh ? "未分配" : "Unassigned")
                                      )}
                                    </span>
                                    <span className="javis-ai-model-select-caret">⌄</span>
                                  </button>
                                  {openModelSlot === slot && configuredModels.length > 0 ? (
                                    <div
                                      className="javis-ai-model-select-menu"
                                      id={modelMenuId}
                                      role="listbox"
                                    >
                                      <button
                                        aria-selected={selectedModelValue === ""}
                                        className={selectedModelValue === "" ? "active" : ""}
                                        onClick={() => assignConfiguredModelToSlot(slot, "")}
                                        role="option"
                                        type="button"
                                      >
                                        {isZh ? "未分配" : "Unassigned"}
                                      </button>
                                      {configuredModels.map((model) => (
                                        <button
                                          aria-selected={selectedModelValue === model.value}
                                          className={selectedModelValue === model.value ? "active" : ""}
                                          key={model.value}
                                          onClick={() => assignConfiguredModelToSlot(slot, model.value)}
                                          role="option"
                                          type="button"
                                        >
                                          {model.label}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              </label>
                              <p className="javis-ai-model-card-meta">
                                {selectedModel
                                  ? `${effectiveLabels[selectedModel.provider] ?? selectedModel.provider} · ${selectedModel.model}`
                                  : (isZh ? "从上方已配置模型中选择" : "Choose from configured provider models")}
                              </p>
                            </div>
                          );
                      })}
                    </div>

                      <h2>
                        {isZh ? "代理模型分配" : "Agent Model Assignment"}
                      </h2>
                      <div className="javis-settings-card javis-ai-agent-card">
                        {assignableAgents.map((agent) => (
                          <label key={agent.kind}>
                            <span>{agent.label}</span>
                            <RoundedSelect
                              aria-label={`${agent.label} model`}
                              onChange={(value) =>
                                setAgentOverrides((current) => ({
                                  ...current,
                                  [agent.kind]: value,
                                }))
                              }
                              options={[
                                { value: "", label: isZh ? "默认" : "Default" },
                                ...MODEL_SLOTS.map((slot) => {
                                  const p = getProfileForSlot(slot);
                                  const slotLabel = isZh ? SLOT_LABELS[slot].zh : SLOT_LABELS[slot].en;
                                  return {
                                    value: p.id,
                                    label: `${slotLabel}${p.model ? ` (${p.model})` : ""}`,
                                  };
                                }),
                              ]}
                              value={agentOverrides[agent.kind] ?? ""}
                            />
                          </label>
                        ))}
                      </div>

                      <div className="javis-ai-actions">
                        <button
                          className="javis-settings-save-btn"
                          onClick={handleSaveConfiguration}
                          type="button"
                        >
                          {isZh ? "保存模型配置" : "Save Model Configuration"}
                        </button>
                        {saveStatus !== "idle" ? (
                          <span
                            className={`javis-settings-save-toast ${saveStatus}`}
                            role="status"
                          >
                            {saveStatus === "saved"
                              ? (isZh ? "已保存" : "Saved")
                              : (isZh ? "保存失败" : "Save failed")}
                          </span>
                        ) : null}
                      </div>

                      <AgentStyleEditor
                        agentCatalog={agentCatalog}
                        labels={labels}
                        locale={effectiveLocale}
                        onReadAgentStyle={onReadAgentStyle}
                        onResetAgentStyle={onResetAgentStyle}
                        onSaveAgentStyle={onSaveAgentStyle}
                      />
                  </>
                </section>
              ) : activeTab === "privacy" ? (
                <div className="javis-settings-section-stack">
                  <AgentMemorySettings
                    isZh={isZh}
                    labels={labels}
                    embeddingBaseUrl={effectiveRuntimePreferences.agentMemoryEmbeddingBaseUrl}
                    embeddingDimensions={effectiveRuntimePreferences.agentMemoryEmbeddingDimensions}
                    embeddingMode={effectiveRuntimePreferences.agentMemoryEmbeddingMode}
                    embeddingModel={effectiveRuntimePreferences.agentMemoryEmbeddingModel}
                    embeddingProvider={effectiveRuntimePreferences.agentMemoryEmbeddingProvider}
                    embeddingApiKeyReference={effectiveRuntimePreferences.agentMemoryEmbeddingApiKeyReference}
                    embeddingProfileOptions={configuredModels.filter((model) =>
                      resolveApiType(model.provider) === "openai-compatible"
                    )}
                    memoryScope={effectiveRuntimePreferences.agentMemoryScope}
                    summary={agentMemorySummary}
                    onClearAll={onClearAgentMemory}
                    onClearWorkspace={onClearWorkspaceAgentMemory}
                    onDeleteFact={onDeleteAgentMemoryFact}
                    onEnabledChange={onAgentMemoryEnabledChange}
                    onEmbeddingSettingsChange={(next) =>
                      updateRuntimePreferences(next)}
                    onMemoryScopeChange={(agentMemoryScope) =>
                      updateRuntimePreferences({ agentMemoryScope })}
                  />
                  <ProfileMemorySettings
                    isZh={isZh}
                    labels={labels}
                    summary={userProfileMemorySummary}
                    onClear={onClearUserProfileMemory}
                    onRebuild={onRebuildUserProfileMemory}
                  />
                </div>
              ) : (
                <SettingsPlaceholder
                  labels={labels}
                  title={tabs.find((tab) => tab.id === activeTab)?.label ?? labels.settings}
                />
              )}
            </main>
          </section>
        </div>
      ), document.body) : null}
    </div>
  );
}

function RoundedSelect({
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: {
  "aria-label": string;
  onChange: (value: string) => void;
  options: RoundedSelectOption[];
  value: string;
}) {
  const [isOpen, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div
      className="javis-ai-rounded-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="javis-ai-rounded-select-trigger"
        onClick={() => setOpen((open) => !open)}
        type="button"
      >
        <span>{selectedOption?.label ?? ""}</span>
        <span className="javis-ai-rounded-select-caret" aria-hidden="true">⌄</span>
      </button>
      {isOpen ? (
        <div className="javis-ai-rounded-select-menu" role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={option.value === value ? "active" : ""}
              disabled={option.disabled}
              key={option.value}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function numberInputValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberInputFloatValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function SettingsPlaceholder({
  labels,
  title,
}: {
  labels: WorkbenchLocale["labels"];
  title: string;
}) {
  return (
    <section className="javis-settings-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="javis-settings-card">
        <p>{labels.settingsPlaceholder}</p>
      </div>
    </section>
  );
}

function AgentMemorySettings({
  isZh,
  embeddingApiKeyReference,
  embeddingBaseUrl,
  embeddingDimensions,
  embeddingMode,
  embeddingModel,
  embeddingProfileOptions,
  embeddingProvider,
  labels,
  memoryScope,
  summary,
  onClearAll,
  onClearWorkspace,
  onDeleteFact,
  onEnabledChange,
  onEmbeddingSettingsChange,
  onMemoryScopeChange,
}: {
  isZh: boolean;
  embeddingApiKeyReference: string;
  embeddingBaseUrl: string;
  embeddingDimensions: number;
  embeddingMode: WorkbenchAgentMemoryEmbeddingMode;
  embeddingModel: string;
  embeddingProfileOptions?: ConfiguredModelOption[];
  embeddingProvider: string;
  labels: WorkbenchLocale["labels"];
  memoryScope: WorkbenchAgentMemoryScopeMode;
  summary?: WorkbenchAgentMemorySummary | null;
  onClearAll?: () => void;
  onClearWorkspace?: () => void;
  onDeleteFact?: (id: string) => void;
  onEnabledChange?: (enabled: boolean) => void;
  onEmbeddingSettingsChange?: (next: Partial<WorkbenchRuntimePreferences>) => void;
  onMemoryScopeChange?: (scope: WorkbenchAgentMemoryScopeMode) => void;
}) {
  const enabled = memoryScope !== "off" && (summary?.enabled ?? true);
  const updatedAt = summary?.lastUpdatedAt
    ? new Date(summary.lastUpdatedAt).toLocaleString(isZh ? "zh-CN" : "en-US")
    : (isZh ? "暂无" : "Not available");

  const selectedEmbeddingProfile = embeddingProfileOptions?.find((option) =>
    option.provider === embeddingProvider &&
    option.model === embeddingModel &&
    option.baseUrl === embeddingBaseUrl &&
    option.apiKeyReference === embeddingApiKeyReference,
  )?.value ?? "";

  return (
    <section className="javis-settings-section javis-profile-memory-settings" aria-label={labels.privacySecuritySettings}>
      <h2>{isZh ? "Agent 记忆" : "Agent memory"}</h2>
      <div className="javis-settings-card">
        <label>
          <span>{isZh ? "Agent 记忆范围" : "Agent memory scope"}</span>
          <RoundedSelect
            aria-label={isZh ? "Agent 记忆范围" : "Agent memory scope"}
            onChange={(value) => {
              const scope = value as WorkbenchAgentMemoryScopeMode;
              onMemoryScopeChange?.(scope);
              onEnabledChange?.(scope !== "off");
            }}
            options={[
              { value: "off", label: isZh ? "关闭" : "Off" },
              { value: "workspace", label: isZh ? "仅当前工作区" : "Current workspace only" },
              { value: "global_workspace", label: isZh ? "全局+当前工作区" : "Global + workspace" },
            ]}
            value={enabled ? memoryScope : "off"}
          />
          </label>
        <div className="javis-profile-memory-embedding">
          <label>
            <span>{isZh ? "语义召回" : "Semantic recall"}</span>
            <RoundedSelect
              aria-label={isZh ? "Agent 记忆语义召回" : "Agent memory semantic recall"}
              onChange={(value) =>
                onEmbeddingSettingsChange?.({ agentMemoryEmbeddingMode: value as WorkbenchAgentMemoryEmbeddingMode })}
              options={[
                { value: "local", label: isZh ? "本地 text-hash" : "Local text-hash" },
                { value: "openai_compatible", label: "OpenAI compatible" },
              ]}
              value={embeddingMode}
            />
          </label>
          {embeddingMode === "openai_compatible" ? (
            <div className="javis-profile-memory-embedding-grid">
              {embeddingProfileOptions && embeddingProfileOptions.length > 0 ? (
                <label>
                  <span>{isZh ? "閰嶇疆鏉ユ簮" : "Configured source"}</span>
                  <RoundedSelect
                    aria-label={isZh ? "Agent 璁板繂 embedding 閰嶇疆鏉ユ簮" : "Agent memory embedding configured source"}
                    onChange={(value) => {
                      const option = embeddingProfileOptions.find((candidate) => candidate.value === value);
                      if (!option) return;
                      onEmbeddingSettingsChange?.({
                        agentMemoryEmbeddingProvider: option.provider,
                        agentMemoryEmbeddingModel: option.model,
                        agentMemoryEmbeddingBaseUrl: option.baseUrl,
                        agentMemoryEmbeddingApiKeyReference: option.apiKeyReference,
                      });
                    }}
                    options={[
                      { value: "", label: isZh ? "鎵嬪姩閰嶇疆" : "Manual configuration" },
                      ...embeddingProfileOptions.map((option) => ({
                        value: option.value,
                        label: `${option.label} (${option.apiKeyReference})`,
                      })),
                    ]}
                    value={selectedEmbeddingProfile}
                  />
                </label>
              ) : null}
              <label>
                <span>{isZh ? "Provider" : "Provider"}</span>
                <input
                  onChange={(event) => onEmbeddingSettingsChange?.({ agentMemoryEmbeddingProvider: event.target.value })}
                  value={embeddingProvider}
                />
              </label>
              <label>
                <span>{isZh ? "模型" : "Model"}</span>
                <input
                  onChange={(event) => onEmbeddingSettingsChange?.({ agentMemoryEmbeddingModel: event.target.value })}
                  value={embeddingModel}
                />
              </label>
              <label>
                <span>{isZh ? "Base URL" : "Base URL"}</span>
                <input
                  onChange={(event) => onEmbeddingSettingsChange?.({ agentMemoryEmbeddingBaseUrl: event.target.value })}
                  value={embeddingBaseUrl}
                />
              </label>
              <label>
                <span>{isZh ? "Key reference" : "Key reference"}</span>
                <input
                  onChange={(event) => onEmbeddingSettingsChange?.({ agentMemoryEmbeddingApiKeyReference: event.target.value })}
                  value={embeddingApiKeyReference}
                />
              </label>
              <label>
                <span>{isZh ? "维度" : "Dimensions"}</span>
                <input
                  min={32}
                  max={4096}
                  onChange={(event) => onEmbeddingSettingsChange?.({
                    agentMemoryEmbeddingDimensions: numberInputValue(event.target.value, embeddingDimensions),
                  })}
                  type="number"
                  value={embeddingDimensions}
                />
              </label>
            </div>
          ) : null}
        </div>
        <dl className="javis-profile-memory-stats">
          <div>
            <dt>{isZh ? "全部事实" : "Facts"}</dt>
            <dd>{summary?.totalFactCount ?? 0}</dd>
          </div>
          <div>
            <dt>{isZh ? "当前工作区" : "Workspace"}</dt>
            <dd>{summary?.workspaceFactCount ?? 0}</dd>
          </div>
          <div>
            <dt>{isZh ? "会话摘要" : "Summaries"}</dt>
            <dd>{summary?.sessionSummaryCount ?? 0}</dd>
          </div>
          <div>
            <dt>{isZh ? "注入审计" : "Injection logs"}</dt>
            <dd>{summary?.injectionLogCount ?? 0}</dd>
          </div>
          <div>
            <dt>{isZh ? "最近更新" : "Updated"}</dt>
            <dd>{updatedAt}</dd>
          </div>
        </dl>
        <div className="javis-profile-memory-actions">
          <button onClick={onClearWorkspace} type="button">
            {isZh ? "清空当前工作区" : "Clear workspace"}
          </button>
          <button className="danger" onClick={onClearAll} type="button">
            {isZh ? "清空全部 Agent 记忆" : "Clear all agent memory"}
          </button>
        </div>
        {summary?.recentFacts.length ? (
          <div className="javis-profile-memory-facts">
            <h3>{isZh ? "最近事实" : "Recent facts"}</h3>
            {summary.recentFacts.map((fact) => (
              <details key={fact.id}>
                <summary>
                  <span>{fact.fact}</span>
                  <small>
                    {agentMemoryScopeLabel(fact.scopeType, isZh)}
                    {" · "}
                    {agentMemoryKindLabel(fact.kind)}
                    {" · "}
                    {Math.round(fact.confidence * 100)}
                    %
                  </small>
                </summary>
                <div className="javis-profile-memory-fact-body">
                  <p>{fact.tags.length ? fact.tags.join(" / ") : (isZh ? "暂无标签" : "No tags")}</p>
                  <button
                    aria-label={`Delete memory fact ${fact.id}`}
                    className="danger"
                    onClick={() => onDeleteFact?.(fact.id)}
                    title={isZh ? "删除这条 Agent 记忆" : "Delete this Agent memory fact"}
                    type="button"
                  >
                    {isZh ? "删除" : "Delete"}
                  </button>
                </div>
              </details>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProfileMemorySettings({
  isZh,
  labels,
  summary,
  onClear,
  onRebuild,
}: {
  isZh: boolean;
  labels: WorkbenchLocale["labels"];
  summary?: WorkbenchUserProfileMemorySummary | null;
  onClear?: () => void;
  onRebuild?: () => void;
}) {
  const updatedAt = summary?.updatedAt
    ? new Date(summary.updatedAt).toLocaleString(isZh ? "zh-CN" : "en-US")
    : (isZh ? "暂无" : "Not available");
  const topTags = summary?.topTags.length ? summary.topTags.join(" / ") : (isZh ? "暂无" : "None yet");

  return (
    <section className="javis-settings-section javis-profile-memory-settings" aria-label={labels.privacySecuritySettings}>
      <h2>{isZh ? "侧写记忆" : "Profile memory"}</h2>
      <div className="javis-settings-card">
        <p>
          {isZh
            ? "Javis 会根据历史会话和当前项目生成本地侧写，用来改善新对话推荐。"
            : "Javis builds a local profile from history and the current workspace to improve new-chat recommendations."}
        </p>
        <dl className="javis-profile-memory-stats">
          <div>
            <dt>{isZh ? "事实数量" : "Facts"}</dt>
            <dd>{summary?.factCount ?? 0}</dd>
          </div>
          <div>
            <dt>{isZh ? "主要标签" : "Top tags"}</dt>
            <dd>{topTags}</dd>
          </div>
          <div>
            <dt>{isZh ? "更新时间" : "Updated"}</dt>
            <dd>{updatedAt}</dd>
          </div>
        </dl>
        <div className="javis-profile-memory-actions">
          <button onClick={onRebuild} type="button">
            {isZh ? "重新提炼" : "Rebuild profile"}
          </button>
          <button className="danger" onClick={onClear} type="button">
            {isZh ? "清空侧写" : "Clear profile"}
          </button>
        </div>
        {summary?.facts?.length ? (
          <div className="javis-profile-memory-facts">
            <h3>{isZh ? "侧写事实" : "Profile facts"}</h3>
            {summary.facts.map((fact) => (
              <details key={fact.id}>
                <summary>
                  <span>{fact.text}</span>
                  <small>
                    {profileFactSourceLabel(fact.source, isZh)}
                    {" · "}
                    {Math.round(fact.confidence * 100)}
                    %
                    {" · "}
                    {isZh ? `${fact.hitCount} 次` : `${fact.hitCount} hits`}
                  </small>
                </summary>
                <div className="javis-profile-memory-fact-body">
                  <p>{fact.tags.join(" / ")}</p>
                  {fact.evidence.length ? (
                    <ul>
                      {fact.evidence.map((evidence, index) => (
                        <li key={`${fact.id}-${index}`}>
                          <strong>{evidence.title ?? (isZh ? "当前工作区" : "Current workspace")}</strong>
                          <span>{evidence.snippet}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{isZh ? "暂无证据片段" : "No evidence snippets yet."}</p>
                  )}
                </div>
              </details>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function agentMemoryScopeLabel(scope: "global" | "workspace" | "session", isZh: boolean): string {
  if (scope === "workspace") return isZh ? "工作区" : "Workspace";
  if (scope === "session") return isZh ? "会话" : "Session";
  return isZh ? "全局" : "Global";
}

function agentMemoryKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

function profileFactSourceLabel(source: "history" | "workspace", isZh: boolean): string {
  if (source === "workspace") {
    return isZh ? "项目" : "Project";
  }
  return isZh ? "历史" : "History";
}

function buildConfiguredModelOptions(
  modelSettings: WorkbenchModelSettings,
  profiles: WorkbenchModelProfile[],
  labels: Record<string, string> = PROVIDER_LABELS,
): ConfiguredModelOption[] {
  const options: ConfiguredModelOption[] = [];
  const seen = new Set<string>();

  function addOption(option: ConfiguredModelOption) {
    if (!option.provider.trim() || !option.model.trim()) return;
    const key = [
      option.provider,
      option.model,
      option.baseUrl,
      option.apiKeyReference,
    ].join("\n");
    if (seen.has(key)) return;
    seen.add(key);
    options.push(option);
  }

  addOption({
    value: "current",
    label: `${labels[modelSettings.provider] ?? modelSettings.provider} / ${modelSettings.model}`,
    provider: modelSettings.provider,
    model: modelSettings.model,
    baseUrl: modelSettings.baseUrl,
    apiKeyReference: modelSettings.apiKeyReference,
    contextTokens: undefined,
  });

  profiles.forEach((profile) => {
    addOption({
      value: profile.id,
      label: `${labels[profile.provider] ?? profile.provider} / ${profile.model}`,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKeyReference: profile.apiKeyReference,
      contextTokens: profile.contextTokens,
    });
  });

  return options;
}

function getConfiguredModelValue(
  profile: WorkbenchModelProfile,
  options: ConfiguredModelOption[],
): string {
  const match = options.find((option) =>
    option.provider === profile.provider &&
    option.model === profile.model &&
    option.baseUrl === profile.baseUrl &&
    option.apiKeyReference === profile.apiKeyReference,
  );
  return match?.value ?? "";
}

function normalizeSlotProfileConnection(
  profile: WorkbenchModelProfile,
  providerProfiles: WorkbenchModelProfile[],
  providerBaseUrls: Record<string, string>,
  modelSettings: WorkbenchModelSettings,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): WorkbenchModelProfile {
  if (!profile.provider) return { ...profile };
  if (!providerProfiles.some((candidate) => candidate.provider === profile.provider)) {
    return withInferredContextTokens({ ...profile });
  }
  return {
    ...withInferredContextTokens(profile),
    baseUrl: getProviderBaseUrl(
      profile.provider,
      providerProfiles,
      providerBaseUrls,
      modelSettings,
      byId,
    ),
    apiKeyReference: getProviderKeyReference(profile.provider, providerProfiles),
  };
}

function providerBaseUrlsFromProfiles(
  profiles: WorkbenchModelProfile[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const profile of profiles) {
    if (profile.provider && profile.baseUrl && !result[profile.provider]) {
      result[profile.provider] = profile.baseUrl;
    }
  }
  return result;
}

function getProviderConnectionSettings(
  provider: string,
  profiles: WorkbenchModelProfile[],
  modelSettings: WorkbenchModelSettings,
  providerBaseUrls: Record<string, string>,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): Pick<WorkbenchModelSettings, "model" | "baseUrl" | "apiKeyReference"> {
  const profile = profiles.find((p) => p.provider === provider && p.model);
  return {
    model: profile?.model || modelSettings.model,
    baseUrl: getProviderBaseUrl(provider, profiles, providerBaseUrls, modelSettings, byId),
    apiKeyReference: getProviderKeyReference(provider, profiles),
  };
}

function getProviderBaseUrl(
  provider: string,
  profiles: WorkbenchModelProfile[],
  providerBaseUrls: Record<string, string>,
  modelSettings: WorkbenchModelSettings,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): string {
  if (Object.prototype.hasOwnProperty.call(providerBaseUrls, provider)) {
    return providerBaseUrls[provider] ?? "";
  }
  const profileBaseUrl = profiles.find((profile) =>
    profile.provider === provider && profile.baseUrl,
  )?.baseUrl;
  if (profileBaseUrl) return profileBaseUrl;
  if (modelSettings.provider === provider && modelSettings.baseUrl) {
    return modelSettings.baseUrl;
  }
  return getProviderDefaultBaseUrl(provider, byId);
}

function getProviderDefaultBaseUrl(
  provider: string,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): string {
  return byId.get(provider)?.defaultBaseUrl ?? "";
}

function getProviderKeyReference(
  provider: string,
  profiles: WorkbenchModelProfile[],
): string {
  return profiles.find((profile) => profile.provider === provider && profile.apiKeyReference)
    ?.apiKeyReference ?? `model.${provider}`;
}

function resolveApiType(
  provider: string,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): ApiType {
  return byId.get(provider)?.apiType ?? "openai-compatible";
}

function getModelListModeForProvider(
  provider: string,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): ModelListMode {
  return byId.get(provider)?.modelListMode ?? "unsupported";
}

function isApiTypeSupportedForProvider(
  provider: string,
  apiType: ApiType,
  byId: Map<string, ProviderCatalogEntry> = PROVIDERS_BY_ID,
): boolean {
  if (provider === "deepseek" || provider === "deepseek-anthropic") return true;
  return resolveApiType(provider, byId) === apiType;
}

function uniqueProfileId(profiles: WorkbenchModelProfile[], seed: string): string {
  const base = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "model";
  const existingIds = new Set(profiles.map((profile) => profile.id));
  if (!existingIds.has(base)) {
    return base;
  }
  let index = 2;
  while (existingIds.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function buildAssignableAgentOptions(
  agentCatalog: WorkbenchAgentCatalogEntry[] | undefined,
  locale: WorkbenchLocale,
): Array<{ kind: string; label: string }> {
  const catalog = agentCatalog?.length ? agentCatalog : FALLBACK_AGENT_CATALOG;
  const seen = new Set<string>();
  const options: Array<{ kind: string; label: string }> = [];

  for (const agent of catalog) {
    if (agent.kind === "chinese-reviewer") continue;
    if (!agent.kind || seen.has(agent.kind)) continue;
    seen.add(agent.kind);
    options.push({
      kind: agent.kind,
      label: translateWorkbenchText(agent.displayName || agent.kind, locale),
    });
  }

  return options;
}

/** Extract provider name from apiKeyReference like "model.deepseek" → "deepseek". */
function extractProviderFromKeyRef(keyRef: string): string | null {
  const match = keyRef.match(/^model\.(.+)$/);
  return match ? match[1] : null;
}
