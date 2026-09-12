import { describe, expect, it } from "vitest";
import {
  BUILTIN_UI_PREFERENCES,
  RESERVED_SHORTCUTS,
  detectShortcutConflicts,
  normalizeKeybinding,
  resolveEffectiveTheme,
  resolveUiPreferences,
  validateUiPreferences,
} from "./ui-preferences";

describe("normalizeKeybinding", () => {
  it("treats different spellings of one shortcut as equal", () => {
    // If these were three values, the conflict detector would both miss real clashes and
    // invent fake ones.
    const canonical = normalizeKeybinding("Ctrl+Shift+P");
    expect(canonical).toBe("Ctrl+Shift+P");
    expect(normalizeKeybinding("shift+ctrl+p")).toBe(canonical);
    expect(normalizeKeybinding("Control+SHIFT+p")).toBe(canonical);
    expect(normalizeKeybinding("  ctrl + shift + P ")).toBe(canonical);
  });

  it("resolves platform modifier aliases", () => {
    expect(normalizeKeybinding("cmd+k")).toBe("Meta+K");
    expect(normalizeKeybinding("Command+K")).toBe("Meta+K");
    expect(normalizeKeybinding("win+k")).toBe("Meta+K");
    expect(normalizeKeybinding("option+f")).toBe("Alt+F");
  });

  it("orders modifiers canonically regardless of input order", () => {
    expect(normalizeKeybinding("Alt+Shift+Ctrl+X")).toBe("Ctrl+Alt+Shift+X");
  });

  it("keeps a named key's casing predictable", () => {
    expect(normalizeKeybinding("ctrl+escape")).toBe("Ctrl+Escape");
    expect(normalizeKeybinding("ctrl+/")).toBe("Ctrl+/");
  });

  it("rejects a combo with no key or with two keys", () => {
    expect(normalizeKeybinding("Ctrl+Shift")).toBeUndefined();
    expect(normalizeKeybinding("Ctrl+A+B")).toBeUndefined();
    expect(normalizeKeybinding("")).toBeUndefined();
    expect(normalizeKeybinding("   ")).toBeUndefined();
  });
});

describe("detectShortcutConflicts", () => {
  it("finds nothing in the builtin map", () => {
    expect(detectShortcutConflicts(BUILTIN_UI_PREFERENCES.keybindings)).toEqual([]);
  });

  it("reports two commands on one combo as an error", () => {
    const conflicts = detectShortcutConflicts({ "a.one": "Ctrl+J", "a.two": "ctrl+j" });
    const duplicate = conflicts.find((conflict) => conflict.kind === "duplicate_command");
    expect(duplicate?.severity).toBe("error");
    expect(duplicate?.combo).toBe("Ctrl+J");
    expect(duplicate?.message).toContain("only one can run");
  });

  it("reports a user overriding a builtin as a warning naming the loser", () => {
    const conflicts = detectShortcutConflicts(
      { ...BUILTIN_UI_PREFERENCES.keybindings, "my.command": "Ctrl+K" },
      { userCommands: ["my.command"] },
    );
    const override = conflicts.find((conflict) => conflict.kind === "overrides_builtin");
    expect(override?.severity).toBe("warning");
    expect(override?.otherCommand).toBe("palette.open");
    expect(override?.message).toContain("your binding wins");
  });

  it("does not warn when the same command keeps its own key", () => {
    expect(detectShortcutConflicts(BUILTIN_UI_PREFERENCES.keybindings, {
      userCommands: Object.keys(BUILTIN_UI_PREFERENCES.keybindings),
    })).toEqual([]);
  });

  it("reports a reserved platform shortcut as an error", () => {
    const conflicts = detectShortcutConflicts({ "my.copy": "Ctrl+C" }, { platform: "win32" });
    const reserved = conflicts.find((conflict) => conflict.kind === "reserved_shortcut");
    expect(reserved?.severity).toBe("error");
    expect(reserved?.message).toContain("belongs to the platform");
  });

  it("uses platform-appropriate reserved shortcuts", () => {
    // Cmd+Q is reserved on macOS but not on Windows.
    expect(detectShortcutConflicts({ "x.y": "Meta+Q" }, { platform: "darwin" })
      .some((conflict) => conflict.kind === "reserved_shortcut")).toBe(true);
    expect(detectShortcutConflicts({ "x.y": "Meta+Q" }, { platform: "win32" })
      .some((conflict) => conflict.kind === "reserved_shortcut")).toBe(false);
    expect(RESERVED_SHORTCUTS.darwin.length).toBeGreaterThan(0);
  });

  it("reports an unusable combo as an error", () => {
    const conflicts = detectShortcutConflicts({ "x.y": "Ctrl+Shift" });
    expect(conflicts[0]).toMatchObject({ kind: "invalid_combo", severity: "error" });
  });

  it("keeps the three severities distinct rather than collapsing them", () => {
    const conflicts = detectShortcutConflicts(
      { "reserved.one": "Ctrl+C", "a.one": "Ctrl+J", "a.two": "Ctrl+J" },
      { platform: "win32" },
    );
    expect(new Set(conflicts.map((conflict) => conflict.kind))).toEqual(
      new Set(["reserved_shortcut", "duplicate_command"]),
    );
    expect(conflicts.every((conflict) => conflict.severity === "error")).toBe(true);
  });
});

describe("resolveUiPreferences", () => {
  it("returns the builtin defaults with their source", () => {
    const resolved = resolveUiPreferences();
    expect(resolved.theme).toBe("system");
    expect(resolved.locale).toBe("en");
    expect(resolved.sources.theme).toBe("builtin");
    expect(resolved.keybindings["palette.open"]).toBe("Ctrl+K");
  });

  it("lets project override user override builtin", () => {
    const resolved = resolveUiPreferences({
      user: { theme: "dark", locale: "zhCN" },
      project: { theme: "light" },
    });
    expect(resolved.theme).toBe("light");
    expect(resolved.sources.theme).toBe("project");
    expect(resolved.locale).toBe("zhCN");
    expect(resolved.sources.locale).toBe("user");
    expect(resolved.density).toBe("comfortable");
  });

  it("adds, overrides and unbinds keybindings", () => {
    const resolved = resolveUiPreferences({
      user: {
        keybindings: {
          "palette.open": "Ctrl+Shift+K",
          "my.command": "Ctrl+M",
          "task.cancel": null,
        },
      },
    });
    expect(resolved.keybindings["palette.open"]).toBe("Ctrl+Shift+K");
    expect(resolved.keybindings["my.command"]).toBe("Ctrl+M");
    expect(resolved.keybindings["task.cancel"]).toBeUndefined();
    expect(resolved.unboundCommands).toEqual(["task.cancel"]);
  });

  it("distinguishes an explicit unbind from a command that was never bound", () => {
    // A settings UI has to show "you unbound this", which is not the same as "no default".
    const resolved = resolveUiPreferences({ user: { keybindings: { "never.existed": null } } });
    expect(resolved.unboundCommands).toEqual([]);
    expect(resolved.keybindings["never.existed"]).toBeUndefined();
  });

  it("does not mutate the builtin defaults", () => {
    resolveUiPreferences({ user: { keybindings: { "palette.open": "Ctrl+Shift+K" } } });
    expect(BUILTIN_UI_PREFERENCES.keybindings["palette.open"]).toBe("Ctrl+K");
  });

  it("lets a project re-bind what the user unbound", () => {
    const resolved = resolveUiPreferences({
      user: { keybindings: { "task.cancel": null } },
      project: { keybindings: { "task.cancel": "Ctrl+Shift+." } },
    });
    expect(resolved.keybindings["task.cancel"]).toBe("Ctrl+Shift+.");
  });
});

describe("validateUiPreferences", () => {
  it("accepts a valid document", () => {
    expect(validateUiPreferences({ theme: "dark", locale: "zhCN", density: "compact" })).toEqual([]);
  });

  it("rejects unknown enum values", () => {
    const diagnostics = validateUiPreferences({
      theme: "sepia" as never,
      locale: "fr" as never,
      density: "spacious" as never,
    });
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual(["theme", "locale", "density"]);
  });

  it("rejects an unusable keybinding but allows null", () => {
    expect(validateUiPreferences({ keybindings: { "x.y": "Ctrl+Shift" } })[0].path).toBe("keybindings.x.y");
    expect(validateUiPreferences({ keybindings: { "x.y": null } })).toEqual([]);
  });
});

describe("resolveEffectiveTheme", () => {
  it("follows the system setting only for the system theme", () => {
    expect(resolveEffectiveTheme("system", "dark")).toBe("dark");
    expect(resolveEffectiveTheme("system", "light")).toBe("light");
    expect(resolveEffectiveTheme("dark", "light")).toBe("dark");
    expect(resolveEffectiveTheme("light", "dark")).toBe("light");
  });
});
