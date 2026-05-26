import type { WorkbenchLocale, WorkbenchModelSettings } from "../types";

interface ModelSettingsProps {
  labels: WorkbenchLocale["labels"];
  modelSettings: WorkbenchModelSettings;
  onModelSettingsChange?: (settings: WorkbenchModelSettings) => void;
}

export function ModelSettings({ labels, modelSettings, onModelSettingsChange }: ModelSettingsProps) {
  const isWebPreview =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

  function updateModelSetting(field: keyof WorkbenchModelSettings, value: string) {
    onModelSettingsChange?.({
      ...modelSettings,
      [field]: value,
    });
  }

  return (
    <details className="javis-model-settings">
      <summary>
        <span className="javis-nav-icon">M</span>
        <span>{labels.models}</span>
      </summary>
      <div className="javis-model-settings-panel">
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
    </details>
  );
}
