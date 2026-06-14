import { invoke } from "@tauri-apps/api/core";

export type SandboxBackend =
  | "policy_only"
  | "windows_restricted_token"
  | "linux_bubblewrap"
  | "mac_seatbelt"
  | "unavailable";

export type SandboxBoundaryStrategy =
  | "windows_integrity_level"
  | "windows_disabled_network_sid"
  | "linux_bubblewrap"
  | "mac_seatbelt"
  | "not_implemented";

export interface SandboxBoundaryStatus {
  strategy: SandboxBoundaryStrategy;
  available: boolean;
  mutatesHostState: boolean;
  reason: string;
}

export interface SandboxBackendStatus {
  backend: SandboxBackend;
  available: boolean;
  canSpawn: boolean;
  canControlProcessTree: boolean;
  canCreateRestrictedToken: boolean;
  canLaunchRestrictedProcess: boolean;
  canEvaluateFilesystemPolicy: boolean;
  canEvaluateNetworkPolicy: boolean;
  canRestrictFilesystem: boolean;
  canDenyNetwork: boolean;
  filesystemBoundary: SandboxBoundaryStatus;
  networkBoundary: SandboxBoundaryStatus;
  reason: string;
}

export async function getSandboxBackendStatus(): Promise<SandboxBackendStatus> {
  return invoke("sandbox_backend_status");
}
