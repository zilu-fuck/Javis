import { describe, expect, it } from "vitest";
import {
  addTrustedComputerApp,
  extractTrustedComputerAppTitleFromPermissionRequest,
  loadTrustedComputerAppsFromPrefs,
  removeTrustedComputerApp,
  serializeTrustedComputerApps,
  trustedComputerAppSource,
} from "./computer-trust";
import { PREF_KEYS } from "./user-preferences-persistence";

describe("computer trust", () => {
  it("loads and sanitizes trusted apps from user preferences", () => {
    const longTitle = "A".repeat(140);
    const apps = loadTrustedComputerAppsFromPrefs({
      [PREF_KEYS.COMPUTER_TRUSTED_APPS]: JSON.stringify([
        { title: " Calculator  ", trustedAt: "2026-06-09T00:00:00.000Z" },
        { title: "calculator", trustedAt: "2026-06-10T00:00:00.000Z" },
        { title: "", trustedAt: "2026-06-10T00:00:00.000Z" },
        { title: longTitle, trustedAt: "not-a-date" },
      ]),
    });

    expect(apps).toEqual([
      { title: "Calculator", trustedAt: "2026-06-09T00:00:00.000Z" },
      { title: "A".repeat(120), trustedAt: "1970-01-01T00:00:00.000Z" },
    ]);
  });

  it("adds newest app first and removes by normalized title", () => {
    const apps = addTrustedComputerApp(
      [{ title: "Calculator", trustedAt: "2026-06-09T00:00:00.000Z" }],
      " Notepad ",
      "2026-06-09T01:00:00.000Z",
    );

    expect(apps).toEqual([
      { title: "Notepad", trustedAt: "2026-06-09T01:00:00.000Z" },
      { title: "Calculator", trustedAt: "2026-06-09T00:00:00.000Z" },
    ]);
    expect(removeTrustedComputerApp(apps, "notepad")).toEqual([
      { title: "Calculator", trustedAt: "2026-06-09T00:00:00.000Z" },
    ]);
  });

  it("serializes only sanitized trusted apps", () => {
    expect(serializeTrustedComputerApps([
      { title: "  App\u0000Name ", trustedAt: "invalid" },
    ])).toBe(JSON.stringify([
      { title: "App Name", trustedAt: "1970-01-01T00:00:00.000Z" },
    ]));
  });

  it("extracts trusted app title from Computer Use permission source", () => {
    const source = trustedComputerAppSource("Calculator");

    expect(source).toBe("local desktop window: Calculator");
    expect(extractTrustedComputerAppTitleFromPermissionRequest({
      dryRun: {
        operation: "computer.click",
        affectedPaths: [{
          source,
          target: "Click button",
          action: "modify",
        }],
        riskSummary: "Task-scoped approval.",
        reversible: false,
      },
    })).toBe("Calculator");
  });
});
