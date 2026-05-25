import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModelSettings, saveModelSettings, type ModelSettings } from "./model-settings";

export function useModelSettingsControls(storage: Storage) {
  const [modelSettings, setModelSettings] = useState(() => loadModelSettings(storage));

  const updateModelSettings = useCallback(async (settings: ModelSettings) => {
    const savedSettings = saveModelSettings(storage, settings);
    const shouldDeleteSecret = !settings.apiKey.trim() && modelSettings.apiKey.trim();
    setModelSettings(savedSettings);
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
