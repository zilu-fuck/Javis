import { useState } from "react";
import type { WorkbenchLocale, WorkbenchModelConfiguration, WorkbenchModelSettings } from "../types";

interface ModelSettingsProps {
  labels: WorkbenchLocale["labels"];
  modelSettings: WorkbenchModelSettings;
  modelConfiguration?: WorkbenchModelConfiguration;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
  onModelConfigurationChange?: (config: WorkbenchModelConfiguration) => void;
}

type SettingsTab = "account" | "general" | "ai" | "privacy" | "about";

export function ModelSettings({
  labels,
  modelSettings,
  modelConfiguration: _modelConfiguration,
  onModelSettingsChange,
  onModelConfigurationChange: _onModelConfigurationChange,
}: ModelSettingsProps) {
  const [isOpen, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const isWebPreview =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
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

  return (
    <div className="javis-settings">
      <button
        className="javis-settings-trigger"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="javis-nav-icon">⚙</span>
        <span>{labels.settings}</span>
      </button>
      {isOpen ? (
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
