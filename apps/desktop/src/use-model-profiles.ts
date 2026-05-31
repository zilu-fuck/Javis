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
    const repo = modelProfileRepoRef.current;
    if (repo) {
      const { profiles, agentOverrides } = config;
      repo.save(
        profiles.map(({ apiKey: _apiKey, hasStoredApiKey: _hs, ...rest }) => rest),
        agentOverrides,
      ).catch((error) => console.error("Failed to save model profiles", error));
    }

    // Update hasStoredApiKey based on OS credential store operations
    const updatedProfiles = await Promise.all(
      config.profiles.map(async (profile) => {
        try {
          if (profile.apiKey?.trim()) {
            await invoke("save_model_api_key_secret", {
              request: {
                keyReference: profile.apiKeyReference,
                apiKey: profile.apiKey,
              },
            });
            return { ...profile, apiKey: "", hasStoredApiKey: true };
          } else if (profile.hasStoredApiKey) {
            // User explicitly cleared a previously-saved key
            await invoke("delete_model_api_key_secret", {
              keyReference: profile.apiKeyReference,
            });
            return { ...profile, apiKey: "", hasStoredApiKey: false };
          }
        } catch (error) {
          console.error(`Failed to manage API key for ${profile.id}`, error);
        }
        return { ...profile, apiKey: "" };
      }),
    );

    const savedConfig = { profiles: updatedProfiles, agentOverrides: config.agentOverrides };
    setModelConfiguration(savedConfig);
    onSaved?.();
  }, [modelProfileRepoRef, onSaved]);

  return {
    modelConfiguration,
    setModelConfiguration,
    handleModelConfigurationChange,
  };
}
