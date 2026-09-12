import {
  parseJavisConfigDocument,
  resolveJavisConfig,
  type ConfigDiagnostic,
  type JavisConfigLayer,
  type ResolvedJavisConfig,
} from "@javis/core";

/**
 * Desktop loader for the `.javis` configuration layers (C1b).
 *
 * The native command does the file access — it is the side that can enforce the
 * workspace containment and size guards — and this module only parses and merges,
 * so the layering rules stay in one tested place in core.
 */

export interface JavisConfigFilePayload {
  projectPath?: string | null;
  projectText?: string | null;
  userPath?: string | null;
  userText?: string | null;
}

export interface LoadedJavisConfig {
  config: ResolvedJavisConfig;
  diagnostics: ConfigDiagnostic[];
  /** Which layers were actually present, for the settings UI. */
  loadedLayers: Array<{ scope: "user" | "project"; path: string }>;
}

export type LoadJavisConfigInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Normalizes the native payload so a malformed reply degrades to "no config"
 * instead of reaching the parser as a lie.
 */
export function normalizeJavisConfigFilePayload(value: unknown): JavisConfigFilePayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  return {
    projectPath: text("projectPath"),
    projectText: text("projectText"),
    userPath: text("userPath"),
    userText: text("userText"),
  };
}

/** Builds the config layers from the native payload, lowest precedence first. */
export function buildJavisConfigLayers(
  payload: JavisConfigFilePayload | null | undefined,
): { layers: JavisConfigLayer[]; diagnostics: ConfigDiagnostic[] } {
  const layers: JavisConfigLayer[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  if (!payload) {
    return { layers, diagnostics };
  }

  const entries: Array<{ scope: "user" | "project"; path?: string | null; text?: string | null }> = [
    { scope: "user", path: payload.userPath, text: payload.userText },
    { scope: "project", path: payload.projectPath, text: payload.projectText },
  ];

  for (const entry of entries) {
    const text = typeof entry.text === "string" ? entry.text : undefined;
    if (text === undefined || text.trim().length === 0) {
      continue;
    }
    const origin = entry.path ?? `${entry.scope} config`;
    const parsed = parseJavisConfigDocument(text, origin);
    diagnostics.push(...parsed.diagnostics);
    if (!parsed.document) {
      continue;
    }
    layers.push({
      scope: entry.scope,
      ...(entry.path ? { path: entry.path } : {}),
      document: parsed.document,
      diagnostics: parsed.diagnostics,
    });
  }

  return { layers, diagnostics };
}

/**
 * Loads and resolves the configuration.
 *
 * A native failure is reported as a diagnostic rather than thrown: a broken or
 * unreadable config must not stop the workbench from starting, and the user needs
 * to see which file was rejected.
 */
export async function loadJavisConfig(
  invoke: LoadJavisConfigInvoke,
  workspacePath?: string,
): Promise<LoadedJavisConfig> {
  let payload: JavisConfigFilePayload | undefined;
  const diagnostics: ConfigDiagnostic[] = [];
  try {
    const raw = await invoke("load_javis_config_files", {
      workspacePath: workspacePath?.trim() ? workspacePath : null,
    });
    payload = normalizeJavisConfigFilePayload(raw);
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      path: ".javis",
      message: `could not read the configuration layer: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const built = buildJavisConfigLayers(payload);
  diagnostics.push(...built.diagnostics);
  const config = resolveJavisConfig(built.layers);

  const loadedLayers: LoadedJavisConfig["loadedLayers"] = [];
  for (const layer of built.layers) {
    if (layer.scope === "user" || layer.scope === "project") {
      loadedLayers.push({ scope: layer.scope, path: layer.path ?? layer.scope });
    }
  }

  return {
    config: { ...config, diagnostics: [...config.diagnostics, ...diagnostics] },
    diagnostics: [...diagnostics, ...config.diagnostics],
    loadedLayers,
  };
}
