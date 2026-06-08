import { useCallback, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PROVIDER_DEFINITIONS } from "@javis/core";
import type { WorkbenchModelConfiguration } from "@javis/ui";
import type { createModelProfileRepository } from "./model-profile-persistence";
import { normalizeModelConfigurationConnections } from "./model-settings";

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
    const normalizedConfig = normalizeModelConfigurationConnections(
      config as any,
      PROVIDER_DEFINITIONS,
    ) as WorkbenchModelConfiguration;
    // Update hasStoredApiKey based on OS credential store operations.
    // An empty apiKey means "keep the stored key" unless the incoming profile
    // explicitly clears hasStoredApiKey.
    const updatedProfiles = await Promise.all(
      normalizedConfig.profiles.map(async (profile) => {
        if (profile.apiKey?.trim()) {
          await invoke("save_model_api_key_secret", {
            request: {
              keyReference: profile.apiKeyReference,
              apiKey: profile.apiKey,
            },
          });
          return { ...profile, apiKey: "", hasStoredApiKey: true };
        } else if (profile.hasStoredApiKey === false) {
          await invoke("delete_model_api_key_secret", {
            keyReference: profile.apiKeyReference,
          });
          return { ...profile, apiKey: "", hasStoredApiKey: false };
        }
        return { ...profile, apiKey: "" };
      }),
    );

    const savedConfig = { profiles: updatedProfiles, agentOverrides: normalizedConfig.agentOverrides };
    const repo = modelProfileRepoRef.current;
    if (repo) {
      await repo.save(
        updatedProfiles.map(({ apiKey: _apiKey, ...rest }) => rest),
        normalizedConfig.agentOverrides,
      );
    }
    setModelConfiguration(savedConfig);
    onSaved?.();
  }, [modelProfileRepoRef, onSaved]);

  return {
    modelConfiguration,
    setModelConfiguration,
    handleModelConfigurationChange,
  };
}
