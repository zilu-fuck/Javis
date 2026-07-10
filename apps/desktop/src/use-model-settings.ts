import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModelSettings, saveModelSettings, type ModelSettings } from "./model-settings";

interface UpdateModelSettingsOptions {
  persistApiKeySecret?: boolean;
}

export function useModelSettingsControls(storage: Storage) {
  const [modelSettings, setModelSettings] = useState(() => loadModelSettings(storage));

  const updateModelSettings = useCallback(async (
    settings: ModelSettings,
    options: UpdateModelSettingsOptions = {},
  ) => {
    const savedSettings = saveModelSettings(storage, settings);
    const shouldDeleteSecret = !settings.apiKey.trim() && modelSettings.apiKey.trim();
    setModelSettings(savedSettings);
    if (options.persistApiKeySecret === false) {
      return;
    }
    try {
      if (settings.apiKey.trim()) {
        await invoke("save_model_api_key_secret", {
          request: {
            keyReference: savedSettings.apiKeyReference,
            apiKey: settings.apiKey,
          },
        });
      } else if (shouldDeleteSecret) {
        await invoke("delete_model_api_key_secret", {
          keyReference: savedSettings.apiKeyReference,
        });
      }
    } catch (error) {
      console.error("Failed to update model API key secret", error);
    }
  }, [modelSettings.apiKey, storage]);

  return {
    modelSettings,
    updateModelSettings,
  };
}
