/**
 * Command palette model (E6).
 *
 * The palette is mostly a ranking problem plus one honesty requirement. The ranking
 * must be predictable enough that muscle memory works — typing three letters should
 * always surface the same command first — and the honesty requirement is that a
 * command the user cannot run right now is **shown greyed with the reason**, not
 * hidden. Hiding it makes the palette feel broken ("it exists, why can't I find it?"),
 * while showing "requires confirmed_write" teaches the model of the system.
 *
 * Matching is deliberately simple and explainable (exact id, prefix, keyword,
 * word-boundary, then subsequence): a fuzzy score nobody can predict produces a palette
 * nobody trusts.
 */

import type { PermissionLevel } from "@javis/tools";

export type PaletteLocale = "en" | "zhCN";

export interface PaletteCommand {
  id: string;
  title: string;
  titleZhCN?: string;
  category?: string;
  keywords?: readonly string[];
  /** Display only; the palette does not bind keys. */
  shortcut?: string;
  requires?: {
    /** Minimum permission level the user must have granted. */
    permissionLevel?: PermissionLevel;
    taskActive?: boolean;
    hasSelection?: boolean;
    hasWorkspace?: boolean;
  };
  /** Set by the host when the command exists but cannot run (e.g. mid-approval). */
  disabledReason?: string;
}

export interface PaletteContext {
  taskActive?: boolean;
  hasSelection?: boolean;
  hasWorkspace?: boolean;
  /** Highest permission level currently granted to the user. */
  grantedPermissionLevel?: PermissionLevel;
  locale?: PaletteLocale;
}

export interface PaletteEntry {
  command: PaletteCommand;
  label: string;
  score: number;
  /** Which part of the command matched, so the UI can highlight it. */
  matchedOn: "id" | "title" | "keyword" | "category";
}

export interface PaletteUnavailable {
  command: PaletteCommand;
  label: string;
  reason: string;
}

export interface PaletteListing {
  available: PaletteEntry[];
  /** Everything filtered out, each with the reason — never silently dropped. */
  unavailable: PaletteUnavailable[];
}

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  read: 0,
  preview: 1,
  confirmed_write: 2,
  dangerous: 3,
};

export function commandLabel(command: PaletteCommand, locale: PaletteLocale = "en"): string {
  return locale === "zhCN" && command.titleZhCN ? command.titleZhCN : command.title;
}

/**
 * Why a command cannot run right now, or `undefined` when it can.
 *
 * The checks are ordered from most fundamental to most situational so the reason the
 * user reads is the most actionable one.
 */
export function unavailableReason(
  command: PaletteCommand,
  context: PaletteContext,
): string | undefined {
  if (command.disabledReason) {
    return command.disabledReason;
  }
  const required = command.requires;
  if (!required) {
    return undefined;
  }
  const isChinese = (context.locale ?? "en") === "zhCN";
  if (required.hasWorkspace && context.hasWorkspace === false) {
    return isChinese ? "需要先选择工作区" : "requires a selected workspace";
  }
  if (required.taskActive && context.taskActive === false) {
    return isChinese ? "需要有一个进行中的任务" : "requires an active task";
  }
  if (required.hasSelection && context.hasSelection === false) {
    return isChinese ? "需要先选中内容" : "requires a selection";
  }
  if (required.permissionLevel) {
    const granted = context.grantedPermissionLevel;
    // An unknown granted level must not be read as the minimum: the palette would then
    // grey out write commands in a host that simply has not reported permissions yet,
    // and the real gate (the native approval boundary) is never bypassed either way.
    if (granted !== undefined && PERMISSION_ORDER[granted] < PERMISSION_ORDER[required.permissionLevel]) {
      return isChinese
        ? `需要 ${required.permissionLevel} 权限（当前 ${granted}）`
        : `requires ${required.permissionLevel} permission (currently ${granted})`;
    }
  }
  return undefined;
}

/**
 * Scores a command against a query, or returns `undefined` when it does not match.
 *
 * Higher is better. Tiers are far apart on purpose so a weaker match in a stronger tier
 * can never outrank a stronger match in a weaker tier.
 */
export function scoreCommandMatch(command: PaletteCommand, query: string): PaletteEntry | undefined {
  const raw = query.trim();
  if (raw.length === 0) {
    return undefined;
  }
  const needle = raw.toLowerCase();
  const id = command.id.toLowerCase();
  const labels = [command.title.toLowerCase(), command.titleZhCN?.toLowerCase()]
    .filter((value): value is string => Boolean(value));
  const keywords = (command.keywords ?? []).map((keyword) => keyword.toLowerCase());
  const category = command.category?.toLowerCase();

  if (id === needle) {
    return { command, label: command.title, score: 100, matchedOn: "id" };
  }
  if (labels.some((label) => label === needle)) {
    return { command, label: command.title, score: 95, matchedOn: "title" };
  }
  if (labels.some((label) => label.startsWith(needle))) {
    return { command, label: command.title, score: 80, matchedOn: "title" };
  }
  if (id.startsWith(needle)) {
    // Typing a command id prefix (`task`, `file.w`) is a common way to reach a family.
    return { command, label: command.title, score: 75, matchedOn: "id" };
  }
  if (keywords.some((keyword) => keyword === needle)) {
    return { command, label: command.title, score: 70, matchedOn: "keyword" };
  }
  if (keywords.some((keyword) => keyword.startsWith(needle))) {
    return { command, label: command.title, score: 60, matchedOn: "keyword" };
  }
  if (labels.some((label) => hasWordBoundaryPrefix(label, needle))) {
    return { command, label: command.title, score: 50, matchedOn: "title" };
  }
  if (category?.startsWith(needle)) {
    return { command, label: command.title, score: 40, matchedOn: "category" };
  }
  if (labels.some((label) => isSubsequence(needle, label))) {
    return { command, label: command.title, score: 30, matchedOn: "title" };
  }
  if (id.includes(needle)) {
    return { command, label: command.title, score: 25, matchedOn: "id" };
  }
  return undefined;
}

/**
 * Ranks commands for the palette.
 *
 * With no query, every available command is listed in declaration order (a stable,
 * predictable palette). Unavailable commands are always returned separately with a
 * reason rather than filtered away.
 */
export function listPaletteCommands(
  commands: readonly PaletteCommand[],
  context: PaletteContext = {},
  options: { query?: string; limit?: number } = {},
): PaletteListing {
  const locale = context.locale ?? "en";
  const available: PaletteEntry[] = [];
  const unavailable: PaletteUnavailable[] = [];

  for (const command of commands) {
    const reason = unavailableReason(command, context);
    if (reason) {
      unavailable.push({ command, label: commandLabel(command, locale), reason });
      continue;
    }
    const query = options.query ?? "";
    if (query.trim().length === 0) {
      available.push({ command, label: commandLabel(command, locale), score: 0, matchedOn: "title" });
      continue;
    }
    const match = scoreCommandMatch(command, query);
    if (match) {
      available.push({ ...match, label: commandLabel(command, locale) });
    }
  }

  if ((options.query ?? "").trim().length > 0) {
    // Ranked by score, then by label so equal scores always list the same way.
    available.sort((left, right) => (right.score - left.score) || left.label.localeCompare(right.label));
  }

  const limit = options.limit;
  return {
    available: limit === undefined ? available : available.slice(0, Math.max(0, limit)),
    unavailable,
  };
}

/** True when every character of `needle` appears in `haystack`, in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return index === needle.length;
}

/** True when the query matches the start of any word in the label. */
function hasWordBoundaryPrefix(label: string, needle: string): boolean {
  return label
    .split(/[\s.:\-_/]+/u)
    .filter(Boolean)
    .some((word) => word.startsWith(needle));
}
