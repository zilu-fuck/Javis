import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  WorkbenchLocale,
  WorkbenchModelConfiguration,
  WorkbenchModelProfile,
  WorkbenchModelSettings,
  WorkbenchModelSlot,
} from "../types";

interface ModelSettingsProps {
  labels: WorkbenchLocale["labels"];
  modelSettings: WorkbenchModelSettings;
  modelConfiguration?: WorkbenchModelConfiguration;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onTestModelConnection?: (settings: WorkbenchModelSettings) => Promise<string | void>;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
  /** Save a per-provider API key to the OS credential store immediately. */
  onSaveProviderApiKey?: (keyReference: string, apiKey: string) => void;
}

type SettingsTab = "general" | "ai" | "privacy" | "about";

const SLOT_LABELS: Record<WorkbenchModelSlot, { zh: string; en: string }> = {
  primary: { zh: "主力模型", en: "Primary" },
  secondary: { zh: "轻量模型", en: "Secondary" },
  multimodal: { zh: "视觉模型", en: "Multimodal" },
};

const MODEL_SLOTS = ["primary", "secondary", "multimodal"] as const;

const KNOWN_AGENT_KINDS = [
  "commander",
  "code",
  "chinese-reviewer",
  "verifier",
  "scheduler",
  "research",
  "file",
  "shell",
  "computer",
  "browser",
  "workspace",
  "vision",
];

const PROVIDER_OPTIONS = [
  "openai",
  "deepseek",
  "deepseek-anthropic",
  "anthropic",
];

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  "deepseek-anthropic": "DeepSeek Anthropic",
  anthropic: "Anthropic",
};

const API_TYPE_OPTIONS = [
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
] as const;

type ApiType = (typeof API_TYPE_OPTIONS)[number]["value"];

interface ConfiguredModelOption {
  value: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyReference: string;
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
  modelSettings,
  modelConfiguration,
  onModelSettingsChange,
  onTestModelConnection,
  onModelConfigurationChange,
  onSaveProviderApiKey,
}: ModelSettingsProps) {
  const [isOpen, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const isWebPreview =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const isZh = labels.aiModeSettings === "AI 模式";

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
  const [modelIdToAdd, setModelIdToAdd] = useState("");

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
        setProviderKeySaved((prev) => ({ ...storedStatuses, ...prev }));
      }
    }
  }, [modelConfiguration]);

  useEffect(() => {
    setSelectedProvider(modelSettings.provider || "openai");
  }, [modelSettings.provider]);

  const tabs: Array<{ id: SettingsTab; icon: string; label: string }> = [
    { id: "general", icon: "◆", label: labels.generalSettings },
    { id: "ai", icon: "◇", label: labels.aiModeSettings },
    { id: "privacy", icon: "✋", label: labels.privacySecuritySettings },
    { id: "about", icon: "i", label: labels.aboutFeedbackSettings },
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
      };
      if (!existingProfile) {
        return [...current, nextProfile];
      }
      return current.map((profile) =>
        profile.slot === slot ? nextProfile : profile,
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
          ...MODEL_SLOTS.map((slot) => ({ ...getProfileForSlot(slot) })),
        ],
        agentOverrides: { ...agentOverrides },
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus("idle"), 2500);
  }

  async function handleTestModelConnectionForProvider(provider: string, model: string, baseUrl: string) {
    if (!onTestModelConnection || testStatus === "testing") return;
    setTestStatus("testing");
    setTestMessage(isZh ? "正在测试 API 连通性..." : "Testing API connection...");
    try {
      const testSettings: WorkbenchModelSettings = {
        provider,
        model,
        apiKey: providerApiKeys[provider] ?? "",
        apiKeyReference: `model.${provider}`,
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
    if (selectedProvider === "anthropic") {
      selectProvider("anthropic");
      return;
    }
    selectProvider("openai");
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
    const baseUrl = providerBaseUrls[selectedProvider]
      ?? matchingProviderProfile?.baseUrl
      ?? modelSettings.baseUrl
      ?? "";
    // Always use per-provider key reference — not legacy "default"
    const apiKeyReference = matchingProviderProfile?.apiKeyReference ?? `model.${selectedProvider}`;
    setSlotProfiles((current) => {
      if (current.some((profile) => profile.provider === selectedProvider && profile.model === model)) {
        return current;
      }
      const id = uniqueProfileId(current, `${selectedProvider}.${model}`);
      return [
        ...current,
        {
          id,
          slot: null,
          displayName: model,
          provider: selectedProvider,
          model,
          apiKeyReference,
          baseUrl,
          apiKey: "",
          capabilities: { vision: false, code: true, longContext: false },
        },
      ];
    });
    if (modelSettings.provider === selectedProvider && modelSettings.model !== model) {
      updateModelSetting("model", model);
    }
    setModelIdToAdd("");
  }

  const configuredModels = buildConfiguredModelOptions(modelSettings, slotProfiles.filter((profile) => profile.slot === null));
  const providerModels = buildConfiguredModelOptions(
    { ...modelSettings, model: "" },
    slotProfiles.filter((profile) => profile.slot === null && profile.provider === selectedProvider),
  );
  const fetchedProviderModels = fetchedModelsByProvider[selectedProvider] ?? [];
  const addedProviderModelNames = new Set(providerModels.map((model) => model.model));
  const selectedProviderLabel = PROVIDER_LABELS[selectedProvider] ?? selectedProvider;
  const selectedApiType = getApiTypeForProvider(selectedProvider);

  function fetchProviderModels() {
    const models = buildFetchedProviderModels(selectedProvider, modelSettings, slotProfiles);
    setFetchedModelsByProvider((current) => ({
      ...current,
      [selectedProvider]: models,
    }));
    setOpenProviderModelMenu(true);
    setModelFetchMessage(
      isZh
        ? `${selectedProvider} 已添加 ${models.length} 个模型`
        : `${selectedProvider}: ${models.length} model(s) added`,
    );
  }

  return (
    <div className="javis-settings">
      <datalist id="javis-provider-options">
        {PROVIDER_OPTIONS.map((provider) => (
          <option key={provider} value={provider} />
        ))}
      </datalist>
      <button
        className="javis-settings-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="javis-nav-icon icon-settings">⚙</span>
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
                  <span>{tab.icon}</span>
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
                ×
              </button>
              {activeTab === "general" ? (
                <SettingsPlaceholder
                  labels={labels}
                  title={labels.generalSettings}
                />
              ) : activeTab === "ai" ? (
                <section className="javis-settings-section javis-ai-settings-section" aria-label={labels.aiModeSettings}>
                  <h2>{isZh ? "供应商" : "Providers"}</h2>
                  <div className="javis-ai-provider-console">
                    <aside className="javis-ai-provider-list" aria-label={isZh ? "供应商列表" : "Provider list"}>
                      <div className="javis-ai-provider-group">
                        <span>API</span>
                        {PROVIDER_OPTIONS.map((provider) => (
                          <button
                            className={selectedProvider === provider ? "active" : ""}
                            key={provider}
                            onClick={() => selectProvider(provider)}
                            type="button"
                          >
                            <span className="javis-ai-provider-dot" />
                            <strong>{PROVIDER_LABELS[provider] ?? provider}</strong>
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
                            const providerModels = slotProfiles.filter(
                              (p) => p.provider === selectedProvider && p.model,
                            );
                            const testModel = providerModels[0]?.model || modelSettings.model;
                            const testBaseUrl = providerBaseUrls[selectedProvider] || providerModels[0]?.baseUrl || modelSettings.baseUrl;
                            void handleTestModelConnectionForProvider(selectedProvider, testModel, testBaseUrl);
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
                              onChange={(event) => setProviderApiKeys((prev) => ({
                                ...prev,
                                [selectedProvider]: event.currentTarget.value,
                              }))}
                              placeholder={providerKeySaved[selectedProvider] ? "••••••••" : ""}
                              type="password"
                              value={providerApiKeys[selectedProvider] ?? ""}
                              style={{ flex: 1 }}
                            />
                            <button
                              disabled={!providerApiKeys[selectedProvider]?.trim()}
                              onClick={() => {
                                const key = providerApiKeys[selectedProvider]?.trim();
                                if (!key || !onSaveProviderApiKey) return;
                                const keyRef = `model.${selectedProvider}`;
                                onSaveProviderApiKey(keyRef, key);
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
                            onChange={(event) => setProviderBaseUrls((prev) => ({
                              ...prev,
                              [selectedProvider]: event.currentTarget.value,
                            }))}
                            placeholder={selectedProvider === "deepseek-anthropic" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com"}
                            value={providerBaseUrls[selectedProvider] ?? ""}
                          />
                        </label>
                        <label>
                          <span>{isZh ? "API 类型" : "API Type"}</span>
                          <RoundedSelect
                            aria-label={isZh ? "API 类型" : "API Type"}
                            onChange={(value) => updateApiType(value as ApiType)}
                            options={API_TYPE_OPTIONS.map((option) => ({
                              ...option,
                              disabled: !isApiTypeSupportedForProvider(selectedProvider, option.value),
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
                                <span>{PROVIDER_LABELS[model.provider] ?? model.provider}</span>
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
                            onBlur={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                setOpenProviderModelMenu(false);
                              }
                            }}
                          >
                            <button
                              aria-expanded={openProviderModelMenu}
                              aria-haspopup="listbox"
                              className="javis-ai-provider-model-trigger"
                              onClick={() => setOpenProviderModelMenu((open) => !open)}
                              type="button"
                            >
                              <span>{isZh ? "添加模型" : "Add model"}</span>
                              <span>⌄</span>
                            </button>
                            {openProviderModelMenu ? (
                              <div className="javis-ai-provider-model-menu" role="listbox">
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
                                    onChange={(event) => setModelIdToAdd(event.currentTarget.value)}
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
                              </div>
                            ) : null}
                          </div>
                          <button
                            disabled={!selectedProvider}
                            onClick={fetchProviderModels}
                            type="button"
                          >
                            {isZh ? "查看已添加" : "Show added"}
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
                                  ? `${PROVIDER_LABELS[selectedModel.provider] ?? selectedModel.provider} · ${selectedModel.model}`
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
                        {KNOWN_AGENT_KINDS.map((agentKind) => (
                          <label key={agentKind}>
                            <span>{agentKind}</span>
                            <RoundedSelect
                              aria-label={`${agentKind} model`}
                              onChange={(value) =>
                                setAgentOverrides((current) => ({
                                  ...current,
                                  [agentKind]: value,
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
                              value={agentOverrides[agentKind] ?? ""}
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
                  </>
                </section>
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
        <span className="javis-ai-rounded-select-caret">⌄</span>
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

function buildConfiguredModelOptions(
  modelSettings: WorkbenchModelSettings,
  profiles: WorkbenchModelProfile[],
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
    label: `${PROVIDER_LABELS[modelSettings.provider] ?? modelSettings.provider} / ${modelSettings.model}`,
    provider: modelSettings.provider,
    model: modelSettings.model,
    baseUrl: modelSettings.baseUrl,
    apiKeyReference: modelSettings.apiKeyReference,
  });

  profiles.forEach((profile) => {
    addOption({
      value: profile.id,
      label: `${PROVIDER_LABELS[profile.provider] ?? profile.provider} / ${profile.model}`,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKeyReference: profile.apiKeyReference,
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

function getApiTypeForProvider(provider: string): ApiType {
  return provider === "anthropic" || provider === "deepseek-anthropic"
    ? "anthropic-messages"
    : "openai-compatible";
}

function isApiTypeSupportedForProvider(provider: string, apiType: ApiType): boolean {
  if (provider === "deepseek" || provider === "deepseek-anthropic") return true;
  if (provider === "anthropic") return apiType === "anthropic-messages";
  return apiType === "openai-compatible";
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

/** Extract provider name from apiKeyReference like "model.deepseek" → "deepseek". */
function extractProviderFromKeyRef(keyRef: string): string | null {
  const match = keyRef.match(/^model\.(.+)$/);
  return match ? match[1] : null;
}

function buildFetchedProviderModels(
  provider: string,
  modelSettings: WorkbenchModelSettings,
  profiles: WorkbenchModelProfile[],
): string[] {
  const models = new Set<string>();
  if (modelSettings.provider === provider && modelSettings.model.trim()) {
    models.add(modelSettings.model.trim());
  }
  profiles.forEach((profile) => {
    if (profile.slot === null && profile.provider === provider && profile.model.trim()) {
      models.add(profile.model.trim());
    }
  });
  return [...models];
}
