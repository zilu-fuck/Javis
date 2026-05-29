import { useCallback, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WorkbenchModelConfiguration } from "@javis/ui";
import type { createModelProfileRepository } from "./model-profile-persistence";

export type ModelProfileRepositoryLike = ReturnType<typeof createModelProfileRepository> | null;

interface UseModelProfilesOptions {
  modelProfileRepoRef: MutableRefObject<ModelProfileRepositoryLike>;
  onSaved?: () => void;
}

export interface ModelProfilesControls {
  modelConfiguration: WorkbenchModelConfiguration | undefined;
  setModelConfiguration: React.Dispatch<React.SetStateAction<WorkbenchModelConfiguration | undefined>>;
  handleModelConfigurationChange(config: WorkbenchModelConfiguration): Promise<void>;
}

export function useModelProfiles({
  modelProfileRepoRef,
  onSaved,
}: UseModelProfilesOptions): ModelProfilesControls {
  const [modelConfiguration, setModelConfiguration] = useState<WorkbenchModelConfiguration | undefined>();

  const handleModelConfigurationChange = useCallback(async (config: WorkbenchModelConfiguration) => {
    setModelConfiguration(config);
    const repo = modelProfileRepoRef.current;
    if (repo) {
      const { profiles, agentOverrides } = config;
      repo.save(
        profiles.map(({ apiKey: _apiKey, ...rest }) => rest),
        agentOverrides,
      ).catch((error) => console.error("Failed to save model profiles", error));
    }

    for (const profile of config.profiles) {
      try {
        if (profile.apiKey?.trim()) {
          await invoke("save_model_api_key_secret", {
            request: {
              keyReference: profile.apiKeyReference,
              apiKey: profile.apiKey,
            },
          });
        } else {
          await invoke("delete_model_api_key_secret", {
            keyReference: profile.apiKeyReference,
          });
        }
      } catch (error) {
        console.error(`Failed to manage API key for ${profile.id}`, error);
      }
    }

    onSaved?.();
  }, [modelProfileRepoRef, onSaved]);

  return {
    modelConfiguration,
    setModelConfiguration,
    handleModelConfigurationChange,
  };
}
