/**
 * UI preferences: theme, locale and keybindings (C8).
 *
 * Two things here are easy to get wrong and unpleasant to debug by hand.
 *
 * **Normalization.** `Ctrl+Shift+P`, `shift+ctrl+p` and `Control+Shift+p` are the same
 * shortcut, and a system that treats them as three will report conflicts that do not
 * exist and miss ones that do. Combos are therefore canonicalized (modifier order fixed,
 * case folded, aliases resolved) before anything is compared.
 *
 * **Conflict class matters.** A user rebinding a builtin key is *legitimate customization*
 * and only worth a warning; two of the user's own commands on one combo is an error
 * because neither can win predictably; and a collision with a reserved platform shortcut
 * is an error because the OS or the app will simply take the key. Collapsing these into
 * one "conflict" severity either blocks valid customization or ships a broken keymap.
 *
 * Preference layering mirrors the configuration model: builtin < user < project, and a
 * `null` binding is an explicit *unbind*, not a missing value.
 */

import type { PermissionLevel } from "@javis/tools";

export type UiLocale = "en" | "zhCN";
export type UiTheme = "system" | "light" | "dark";
export type UiDensity = "comfortable" | "compact";
export type UiPlatform = "win32" | "darwin" | "linux";

export interface UiPreferences {
  theme?: UiTheme;
  locale?: UiLocale;
  density?: UiDensity;
  /** Command id → combo, or `null` to unbind a builtin shortcut. */
  keybindings?: Record<string, string | null>;
}

export interface ResolvedUiPreferences {
  theme: UiTheme;
  locale: UiLocale;
  density: UiDensity;
  keybindings: Record<string, string>;
  /** Which layer each value came from, for a settings UI that explains itself. */
  sources: Record<string, "builtin" | "user" | "project">;
  /** Bindings removed by an explicit `null`. */
  unboundCommands: string[];
}

export const BUILTIN_UI_PREFERENCES: Required<Omit<UiPreferences, "keybindings">> & {
  keybindings: Record<string, string>;
} = {
  theme: "system",
  locale: "en",
  density: "comfortable",
  keybindings: {
    "palette.open": "Ctrl+K",
    "task.cancel": "Ctrl+.",
    "settings.open": "Ctrl+,",
    "workspace.choose": "Ctrl+O",
  },
};

/**
 * Shortcuts the platform or the app itself owns.
 *
 * Bindable keys are scarce; these are the ones where a binding is not a preference but a
 * bug, so they are reported as errors rather than silently ignored.
 */
export const RESERVED_SHORTCUTS: Record<UiPlatform, readonly string[]> = {
  win32: ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Y", "Ctrl+W", "Alt+F4", "F5", "F11", "F12"],
  darwin: ["Meta+C", "Meta+V", "Meta+X", "Meta+A", "Meta+Z", "Meta+W", "Meta+Q", "Meta+Space"],
  linux: ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+W", "Alt+F4", "F5", "F11"],
};

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const MODIFIER_ORDER = ["Ctrl", "Meta", "Alt", "Shift"];

/**
 * Canonicalizes a shortcut: `shift+ctrl+p` and `Ctrl+Shift+P` both become `Ctrl+Shift+P`.
 * Returns `undefined` for a combo with no non-modifier key.
 */
export function normalizeKeybinding(combo: string): string | undefined {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias) {
      modifiers.add(alias);
      continue;
    }
    // A second non-modifier key means the combo is malformed, not a two-key shortcut.
    if (key !== undefined) {
      return undefined;
    }
    key = part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  }
  if (key === undefined) {
    return undefined;
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

export type KeybindingConflictKind =
  | "duplicate_command"
  | "overrides_builtin"
  | "reserved_shortcut"
  | "invalid_combo";

export interface KeybindingConflict {
  kind: KeybindingConflictKind;
  severity: "error" | "warning";
  combo?: string;
  command: string;
  /** The other command involved, for the overlapping cases. */
  otherCommand?: string;
  message: string;
}

/**
 * Finds problems in an effective keymap.
 *
 * `userCommands` distinguishes a user's own binding (which may legitimately override a
 * builtin) from an internal collision (which cannot be resolved).
 */
export function detectShortcutConflicts(
  bindings: Readonly<Record<string, string>>,
  options: {
    platform?: UiPlatform;
    builtin?: Readonly<Record<string, string>>;
    userCommands?: readonly string[];
  } = {},
): KeybindingConflict[] {
  const platform = options.platform ?? "win32";
  const builtin = options.builtin ?? BUILTIN_UI_PREFERENCES.keybindings;
  const userCommands = new Set(options.userCommands ?? []);
  const conflicts: KeybindingConflict[] = [];

  const builtinByCombo = new Map<string, string>();
  for (const [command, combo] of Object.entries(builtin)) {
    const normalized = normalizeKeybinding(combo);
    if (normalized) {
      builtinByCombo.set(normalized, command);
    }
  }
  const reserved = new Set(
    RESERVED_SHORTCUTS[platform].map((combo) => normalizeKeybinding(combo) ?? combo),
  );

  const byCombo = new Map<string, string[]>();
  for (const [command, combo] of Object.entries(bindings)) {
    const normalized = normalizeKeybinding(combo);
    if (!normalized) {
      conflicts.push({
        kind: "invalid_combo",
        severity: "error",
        command,
        message: `"${combo}" is not a usable shortcut: it needs exactly one non-modifier key.`,
      });
      continue;
    }
    if (reserved.has(normalized)) {
      conflicts.push({
        kind: "reserved_shortcut",
        severity: "error",
        combo: normalized,
        command,
        message: `${normalized} belongs to the platform and cannot be bound.`,
      });
    }
    const builtinOwner = builtinByCombo.get(normalized);
    if (builtinOwner && builtinOwner !== command && userCommands.has(command)) {
      conflicts.push({
        kind: "overrides_builtin",
        severity: "warning",
        combo: normalized,
        command,
        otherCommand: builtinOwner,
        // Legitimate customization, so this is a warning: the user should know which
        // command loses the key.
        message: `${normalized} also opens "${builtinOwner}"; your binding wins.`,
      });
    }
    const owners = byCombo.get(normalized) ?? [];
    owners.push(command);
    byCombo.set(normalized, owners);
  }

  for (const [combo, owners] of byCombo) {
    if (owners.length <= 1) {
      continue;
    }
    // Neither can win predictably, so this is an error regardless of who bound what.
    conflicts.push({
      kind: "duplicate_command",
      severity: "error",
      combo,
      command: owners[0],
      otherCommand: owners[1],
      message: `${owners.join(" and ")} are all bound to ${combo}; only one can run.`,
    });
  }

  return conflicts;
}

/**
 * Merges preference layers, builtin first.
 *
 * A `null` keybinding removes the builtin binding for that command and is recorded in
 * `unboundCommands` — "explicitly unbound" and "never bound" are different states, and a
 * settings UI needs to show the difference.
 */
export function resolveUiPreferences(
  layers: { user?: UiPreferences; project?: UiPreferences } = {},
): ResolvedUiPreferences {
  const sources: Record<string, "builtin" | "user" | "project"> = {
    theme: "builtin",
    locale: "builtin",
    density: "builtin",
  };
  let theme = BUILTIN_UI_PREFERENCES.theme;
  let locale = BUILTIN_UI_PREFERENCES.locale;
  let density = BUILTIN_UI_PREFERENCES.density;

  if (layers.user?.theme) {
    theme = layers.user.theme;
    sources.theme = "user";
  }
  if (layers.user?.locale) {
    locale = layers.user.locale;
    sources.locale = "user";
  }
  if (layers.user?.density) {
    density = layers.user.density;
    sources.density = "user";
  }
  if (layers.project?.theme) {
    theme = layers.project.theme;
    sources.theme = "project";
  }
  if (layers.project?.locale) {
    locale = layers.project.locale;
    sources.locale = "project";
  }
  if (layers.project?.density) {
    density = layers.project.density;
    sources.density = "project";
  }

  const keybindings: Record<string, string> = { ...BUILTIN_UI_PREFERENCES.keybindings };
  const unboundCommands: string[] = [];
  const userCommands: string[] = [];

  for (const layer of [layers.user, layers.project]) {
    for (const [command, combo] of Object.entries(layer?.keybindings ?? {})) {
      if (combo === null) {
        if (keybindings[command] !== undefined) {
          delete keybindings[command];
          if (!unboundCommands.includes(command)) {
            unboundCommands.push(command);
          }
        }
        continue;
      }
      keybindings[command] = combo;
      if (layer === layers.user) {
        userCommands.push(command);
      }
    }
  }

  return {
    theme,
    locale,
    density,
    keybindings,
    sources,
    unboundCommands,
  };
}

export interface UiPreferenceDiagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}

/** Validates a preference document before it is stored. */
export function validateUiPreferences(preferences: UiPreferences): UiPreferenceDiagnostic[] {
  const diagnostics: UiPreferenceDiagnostic[] = [];
  const themes: UiTheme[] = ["system", "light", "dark"];
  const locales: UiLocale[] = ["en", "zhCN"];
  const densities: UiDensity[] = ["comfortable", "compact"];

  if (preferences.theme !== undefined && !themes.includes(preferences.theme)) {
    diagnostics.push({ severity: "error", path: "theme", message: `unknown theme "${preferences.theme}".` });
  }
  if (preferences.locale !== undefined && !locales.includes(preferences.locale)) {
    diagnostics.push({ severity: "error", path: "locale", message: `unknown locale "${preferences.locale}".` });
  }
  if (preferences.density !== undefined && !densities.includes(preferences.density)) {
    diagnostics.push({ severity: "error", path: "density", message: `unknown density "${preferences.density}".` });
  }
  for (const [command, combo] of Object.entries(preferences.keybindings ?? {})) {
    if (combo === null) {
      continue;
    }
    if (normalizeKeybinding(combo) === undefined) {
      diagnostics.push({
        severity: "error",
        path: `keybindings.${command}`,
        message: `"${combo}" is not a usable shortcut.`,
      });
    }
  }

  return diagnostics;
}

/** True when the theme should follow the OS setting rather than a fixed choice. */
export function resolveEffectiveTheme(
  theme: UiTheme,
  systemTheme: "light" | "dark",
): "light" | "dark" {
  return theme === "system" ? systemTheme : theme;
}

/** The permission level a UI surface needs, kept here so the model stays inspectable. */
export type UiPermissionNeed = Extract<PermissionLevel, "read" | "confirmed_write">;
