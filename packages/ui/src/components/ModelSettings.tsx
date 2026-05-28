import { useEffect, useState } from "react";
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
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
}

type SettingsTab = "account" | "general" | "ai" | "privacy" | "about";

const SLOT_LABELS: Record<WorkbenchModelSlot, { zh: string; en: string }> = {
  primary: { zh: "主力模型", en: "Primary" },
  secondary: { zh: "轻量模型", en: "Secondary" },
  multimodal: { zh: "视觉模型", en: "Multimodal" },
};

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
];

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
  onModelConfigurationChange,
}: ModelSettingsProps) {
  const [isOpen, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const isWebPreview =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const isZh = labels.aiModeSettings === "AI 模式";

  // Local editing state for multi-model configuration
  const [slotProfiles, setSlotProfiles] = useState<WorkbenchModelProfile[]>([]);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  // Sync from props when configuration changes or modal opens
  useEffect(() => {
    if (modelConfiguration) {
      setSlotProfiles(
        modelConfiguration.profiles.map((p) => ({ ...p, apiKey: "" })),
      );
      setAgentOverrides({ ...modelConfiguration.agentOverrides });
    }
  }, [modelConfiguration, isOpen]);

  const tabs: Array<{ id: SettingsTab; icon: string; label: string }> = [
    { id: "account", icon: "●", label: labels.accountSettings },
    { id: "general", icon: "◆", label: labels.generalSettings },
    { id: "ai", icon: "◇", label: labels.aiModeSettings },
    { id: "privacy", icon: "✋", label: labels.privacySecuritySettings },
    { id: "about", icon: "i", label: labels.aboutFeedbackSettings },
  ];

  function updateModelSetting(field: keyof WorkbenchModelSettings, value: string) {
    onModelSettingsChange?.({
      ...modelSettings,
      [field]: value,
    });
  }

  function updateSlotProfile(slot: WorkbenchModelSlot, field: string, value: string) {
    setSlotProfiles((current) =>
      current.map((p) =>
        p.slot === slot ? { ...p, [field]: value } : p,
      ),
    );
  }

  function handleSaveConfiguration() {
    if (!onModelConfigurationChange) return;
    try {
      onModelConfigurationChange({
        profiles: slotProfiles.map((p) => ({ ...p })),
        agentOverrides: { ...agentOverrides },
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus("idle"), 2500);
  }

  function getProfileForSlot(slot: WorkbenchModelSlot): WorkbenchModelProfile {
    return slotProfiles.find((p) => p.slot === slot) ?? emptyProfile(slot);
  }

  const hasConfiguration = slotProfiles.length > 0;

  return (
    <div className="javis-settings">
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
                <section className="javis-settings-section" aria-label={labels.aiModeSettings}>
                  <h2>{labels.aiModeSettings}</h2>
                  <div className="javis-settings-card">
                    <p>{labels.modelSettingsDescription}</p>
                    {isWebPreview ? (
                      <p className="javis-model-settings-warning">
                        {labels.modelBackendUnavailable}
                      </p>
                    ) : null}
                    <label>
                      <span>{labels.modelProvider}</span>
                      <input
                        aria-label={labels.modelProvider}
                        onChange={(event) => updateModelSetting("provider", event.currentTarget.value)}
                        value={modelSettings.provider}
                      />
                    </label>
                    <label>
                      <span>{labels.modelName}</span>
                      <input
                        aria-label={labels.modelName}
                        onChange={(event) => updateModelSetting("model", event.currentTarget.value)}
                        placeholder="openai/gpt-5.1-codex"
                        value={modelSettings.model}
                      />
                    </label>
                    <label>
                      <span>{labels.modelApiKey}</span>
                      <input
                        aria-label={labels.modelApiKey}
                        onChange={(event) => updateModelSetting("apiKey", event.currentTarget.value)}
                        type="password"
                        value={modelSettings.apiKey}
                      />
                    </label>
                    <label>
                      <span>{labels.modelBaseUrl}</span>
                      <input
                        aria-label={labels.modelBaseUrl}
                        onChange={(event) => updateModelSetting("baseUrl", event.currentTarget.value)}
                        placeholder="https://api.openai.com/v1"
                        value={modelSettings.baseUrl}
                      />
                    </label>
                  </div>

                  {hasConfiguration && (
                    <>
                      <h2 style={{ marginTop: "1.5rem" }}>
                        {isZh ? "多模型配置" : "Multi-Model Configuration"}
                      </h2>
                      {(["primary", "secondary", "multimodal"] as const).map((slot) => {
                        const profile = getProfileForSlot(slot);
                        const slotLabel = isZh ? SLOT_LABELS[slot].zh : SLOT_LABELS[slot].en;
                        return (
                          <div className="javis-settings-card" key={slot} style={{ marginBottom: "1rem" }}>
                            <h3>{slotLabel}</h3>
                            <label>
                              <span>{labels.modelProvider}</span>
                              <input
                                aria-label={`${slotLabel} ${labels.modelProvider}`}
                                onChange={(event) => updateSlotProfile(slot, "provider", event.currentTarget.value)}
                                placeholder="deepseek"
                                value={profile.provider}
                              />
                            </label>
                            <label>
                              <span>{labels.modelName}</span>
                              <input
                                aria-label={`${slotLabel} ${labels.modelName}`}
                                onChange={(event) => updateSlotProfile(slot, "model", event.currentTarget.value)}
                                placeholder="deepseek-chat"
                                value={profile.model}
                              />
                            </label>
                            <label>
                              <span>{labels.modelApiKey}</span>
                              <input
                                aria-label={`${slotLabel} ${labels.modelApiKey}`}
                                onChange={(event) => updateSlotProfile(slot, "apiKey", event.currentTarget.value)}
                                type="password"
                                value={profile.apiKey}
                              />
                            </label>
                            <label>
                              <span>{labels.modelBaseUrl}</span>
                              <input
                                aria-label={`${slotLabel} ${labels.modelBaseUrl}`}
                                onChange={(event) => updateSlotProfile(slot, "baseUrl", event.currentTarget.value)}
                                placeholder="https://api.deepseek.com"
                                value={profile.baseUrl}
                              />
                            </label>
                          </div>
                        );
                      })}

                      <h2 style={{ marginTop: "1.5rem" }}>
                        {isZh ? "代理模型分配" : "Agent Model Assignment"}
                      </h2>
                      <div className="javis-settings-card">
                        {KNOWN_AGENT_KINDS.map((agentKind) => (
                          <label key={agentKind}>
                            <span>{agentKind}</span>
                            <select
                              aria-label={`${agentKind} model`}
                              onChange={(event) =>
                                setAgentOverrides((current) => ({
                                  ...current,
                                  [agentKind]: event.currentTarget.value,
                                }))
                              }
                              value={agentOverrides[agentKind] ?? ""}
                            >
                              <option value="">
                                {isZh ? "默认" : "Default"}
                              </option>
                              {(["primary", "secondary", "multimodal"] as const).map((slot) => {
                                const p = getProfileForSlot(slot);
                                const slotLabel = isZh ? SLOT_LABELS[slot].zh : SLOT_LABELS[slot].en;
                                return (
                                  <option key={slot} value={p.id}>
                                    {slotLabel}{p.model ? ` (${p.model})` : ""}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        ))}
                      </div>

                      <button
                        className="javis-settings-save-btn"
                        onClick={handleSaveConfiguration}
                        type="button"
                      >
                        {isZh ? "保存模型配置" : "Save Model Configuration"}
                      </button>
                      {saveStatus !== "idle" ? (
                        <span
                          className="javis-settings-save-toast"
                          role="status"
                          style={{
                            display: "inline-block",
                            marginLeft: "0.75rem",
                            fontSize: "0.8125rem",
                            color: saveStatus === "saved" ? "#22c55e" : "#ef4444",
                          }}
                        >
                          {saveStatus === "saved"
                            ? (isZh ? "已保存" : "Saved")
                            : (isZh ? "保存失败" : "Save failed")}
                        </span>
                      ) : null}
                    </>
                  )}
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
