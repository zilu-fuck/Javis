import { describe, expect, it } from "vitest";
import {
  commandLabel,
  isSubsequence,
  listPaletteCommands,
  scoreCommandMatch,
  unavailableReason,
  type PaletteCommand,
} from "./command-palette";

const COMMANDS: PaletteCommand[] = [
  { id: "task.new", title: "New task", titleZhCN: "新建任务", category: "task", keywords: ["create", "start"], shortcut: "Ctrl+N" },
  { id: "task.cancel", title: "Cancel task", titleZhCN: "取消任务", category: "task", keywords: ["stop", "abort"], requires: { taskActive: true } },
  { id: "task.rollback", title: "Roll back to step", titleZhCN: "回滚到某一步", category: "task", requires: { taskActive: true } },
  { id: "workspace.choose", title: "Choose workspace", titleZhCN: "选择工作区", category: "workspace" },
  { id: "file.write", title: "Write file", titleZhCN: "写入文件", category: "file", requires: { permissionLevel: "confirmed_write", hasWorkspace: true } },
  { id: "settings.open", title: "Open settings", titleZhCN: "打开设置", category: "settings", keywords: ["preferences", "config"] },
];

describe("isSubsequence", () => {
  it("matches in-order characters and rejects out-of-order ones", () => {
    expect(isSubsequence("ct", "cancel task")).toBe(true);
    expect(isSubsequence("tc", "cancel task")).toBe(false);
    expect(isSubsequence("", "anything")).toBe(true);
    expect(isSubsequence("xyz", "cancel task")).toBe(false);
  });
});

describe("scoreCommandMatch", () => {
  it("ranks an exact id above an exact title above a prefix", () => {
    const byId = scoreCommandMatch(COMMANDS[0], "task.new");
    const byTitle = scoreCommandMatch(COMMANDS[0], "new task");
    const byPrefix = scoreCommandMatch(COMMANDS[0], "new");
    expect(byId?.score).toBe(100);
    expect(byTitle?.score).toBe(95);
    expect(byPrefix?.score).toBe(80);
    expect(byId!.score).toBeGreaterThan(byTitle!.score);
    expect(byTitle!.score).toBeGreaterThan(byPrefix!.score);
  });

  it("ranks a keyword above a word-boundary prefix above a subsequence", () => {
    // Purpose-built commands so the tiers cannot overlap: the id must not start with the
    // query, or the (higher) id-prefix tier would fire instead.
    const keyworded = { id: "x.y", title: "Unrelated label", keywords: ["create"] };
    const wordBoundary = { id: "x.y", title: "Cancel task now" };
    const subsequenceOnly = { id: "x.y", title: "Cancel task now" };

    expect(scoreCommandMatch(keyworded, "create")?.matchedOn).toBe("keyword");
    expect(scoreCommandMatch(keyworded, "create")?.score).toBe(70);
    expect(scoreCommandMatch(wordBoundary, "task")?.score).toBe(50);
    expect(scoreCommandMatch(subsequenceOnly, "cncl")?.score).toBe(30);
  });

  it("matches the Chinese title too", () => {
    expect(scoreCommandMatch(COMMANDS[0], "新建")?.score).toBe(80);
    expect(scoreCommandMatch(COMMANDS[0], "取消")).toBeUndefined();
  });

  it("returns undefined for an empty query rather than matching everything", () => {
    expect(scoreCommandMatch(COMMANDS[0], "")).toBeUndefined();
    expect(scoreCommandMatch(COMMANDS[0], "   ")).toBeUndefined();
  });

  it("does not match unrelated text", () => {
    expect(scoreCommandMatch(COMMANDS[0], "zzzz")).toBeUndefined();
  });
});

describe("unavailableReason", () => {
  it("reports the most actionable blocker first", () => {
    // A command needing a workspace *and* a permission reports the workspace: the user
    // cannot act on a permission grant before choosing a workspace.
    const reason = unavailableReason(COMMANDS[4], { hasWorkspace: false, grantedPermissionLevel: "read" });
    expect(reason).toContain("workspace");
  });

  it("explains a permission shortfall with both levels", () => {
    const reason = unavailableReason(COMMANDS[4], { hasWorkspace: true, grantedPermissionLevel: "read" });
    expect(reason).toBe("requires confirmed_write permission (currently read)");
  });

  it("allows the command once the permission is granted", () => {
    expect(unavailableReason(COMMANDS[4], { hasWorkspace: true, grantedPermissionLevel: "confirmed_write" }))
      .toBeUndefined();
    // A higher level also satisfies it.
    expect(unavailableReason(COMMANDS[4], { hasWorkspace: true, grantedPermissionLevel: "dangerous" }))
      .toBeUndefined();
  });

  it("explains a missing active task and a missing selection", () => {
    expect(unavailableReason(COMMANDS[1], { taskActive: false })).toBe("requires an active task");
    expect(unavailableReason(
      { id: "x", title: "X", requires: { hasSelection: true } },
      { hasSelection: false },
    )).toBe("requires a selection");
  });

  it("uses the host-provided disabled reason verbatim", () => {
    expect(unavailableReason({ id: "x", title: "X", disabledReason: "blocked by an open approval" }, {}))
      .toBe("blocked by an open approval");
  });

  it("treats an unspecified context as available", () => {
    // `undefined` means "not known", which must not be read as "false" — and for the
    // permission level the real gate is the native approval boundary, so an unknown
    // level must not grey out every write command.
    expect(unavailableReason(COMMANDS[1], {})).toBeUndefined();
    expect(unavailableReason(COMMANDS[4], {})).toBeUndefined();
  });

  it("is consistent: every unknown flag behaves like the permission level", () => {
    for (const command of COMMANDS) {
      expect(unavailableReason(command, {}), command.id).toBeUndefined();
    }
  });

  it("localizes the reason", () => {
    expect(unavailableReason(COMMANDS[1], { taskActive: false, locale: "zhCN" }))
      .toContain("进行中的任务");
  });
});

describe("listPaletteCommands", () => {
  it("lists everything available in declaration order with no query", () => {
    const listing = listPaletteCommands(COMMANDS, { taskActive: true, hasWorkspace: true, grantedPermissionLevel: "confirmed_write" });
    expect(listing.unavailable).toEqual([]);
    expect(listing.available.map((entry) => entry.command.id)).toEqual(COMMANDS.map((command) => command.id));
  });

  it("shows an unusable command with its reason instead of hiding it", () => {
    // Hiding it makes the palette feel broken; the reason teaches the permission model.
    const listing = listPaletteCommands(COMMANDS, { taskActive: false, grantedPermissionLevel: "read" });
    const ids = listing.available.map((entry) => entry.command.id);
    expect(ids).not.toContain("task.cancel");
    const cancelled = listing.unavailable.find((entry) => entry.command.id === "task.cancel");
    expect(cancelled?.reason).toBe("requires an active task");
    // Both lists together account for every command.
    expect(listing.available.length + listing.unavailable.length).toBe(COMMANDS.length);
  });

  it("ranks query results by score, with label as the documented tie-break", () => {
    const listing = listPaletteCommands(
      COMMANDS,
      { taskActive: true, hasWorkspace: true, grantedPermissionLevel: "confirmed_write" },
      { query: "task" },
    );
    // All three `task.*` commands match the id prefix and therefore score equally; the
    // order among them is the documented alphabetical tie-break, not declaration order.
    expect(listing.available.map((entry) => entry.command.id)).toEqual([
      "task.cancel",
      "task.new",
      "task.rollback",
    ]);
    expect(new Set(listing.available.map((entry) => entry.score))).toEqual(new Set([75]));
    const scores = listing.available.map((entry) => entry.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it("surfaces a command family by its id prefix", () => {
    const listing = listPaletteCommands(
      COMMANDS,
      { taskActive: true, hasWorkspace: true, grantedPermissionLevel: "confirmed_write" },
      { query: "file.w" },
    );
    expect(listing.available[0].command.id).toBe("file.write");
    expect(listing.available[0].matchedOn).toBe("id");
  });

  it("applies the limit after ranking", () => {
    const listing = listPaletteCommands(
      COMMANDS,
      { taskActive: true, hasWorkspace: true, grantedPermissionLevel: "confirmed_write" },
      { query: "e", limit: 2 },
    );
    expect(listing.available).toHaveLength(2);
  });

  it("keeps unavailable commands out of query results but still listed", () => {
    const listing = listPaletteCommands(
      COMMANDS,
      { taskActive: false },
      { query: "cancel" },
    );
    expect(listing.available).toEqual([]);
    expect(listing.unavailable.map((entry) => entry.command.id)).toContain("task.cancel");
  });

  it("is deterministic for equal scores", () => {
    const commands: PaletteCommand[] = [
      { id: "b.one", title: "One", keywords: ["shared"] },
      { id: "a.two", title: "Two", keywords: ["shared"] },
    ];
    const first = listPaletteCommands(commands, {}, { query: "shared" });
    const second = listPaletteCommands([...commands].reverse(), {}, { query: "shared" });
    expect(first.available.map((entry) => entry.label)).toEqual(second.available.map((entry) => entry.label));
  });

  it("handles an empty command list", () => {
    expect(listPaletteCommands([], {})).toEqual({ available: [], unavailable: [] });
  });
});

describe("commandLabel", () => {
  it("uses the Chinese title only for the Chinese locale, and falls back", () => {
    expect(commandLabel(COMMANDS[0], "zhCN")).toBe("新建任务");
    expect(commandLabel(COMMANDS[0], "en")).toBe("New task");
    expect(commandLabel({ id: "x", title: "Fallback" }, "zhCN")).toBe("Fallback");
  });
});
