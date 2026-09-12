/**
 * `SKILL.md` frontmatter (C3).
 *
 * Javis already discovers skills and ranks them against the goal, but it treats a
 * skill body as always injectable. The Agent Skills convention puts invocation
 * policy in YAML frontmatter at the top of `SKILL.md`:
 *
 *   ---
 *   name: summarize-changes
 *   description: Summarizes uncommitted changes and flags anything risky.
 *   allowed-tools: [shell.runReadOnlyCommand]
 *   disable-model-invocation: true
 *   argument-hint: [issue-number]
 *   ---
 *
 * `description` is what drives automatic selection, and `disable-model-invocation`
 * means the model must not pick it up on its own — only an explicit user choice.
 *
 * The parser is deliberately a small YAML subset (scalars, quoted scalars, inline
 * lists, block lists). A skill file is authored by hand, and a full YAML dependency
 * is not worth it for six known keys; anything unsupported is reported instead of
 * guessed.
 */

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Tools the skill is allowed to use, as declared. */
  allowedTools: string[];
  /** True when only the user may invoke the skill. */
  disableModelInvocation: boolean;
  argumentHint?: string;
  /** Keys the parser recognised but this build does not act on. */
  unhandledKeys: string[];
}

export interface ParsedSkillDocument {
  frontmatter: SkillFrontmatter;
  /** Everything after the closing fence, untouched. */
  body: string;
  diagnostics: string[];
}

/** Listing text is capped by the convention at 1,536 characters per skill entry. */
export const SKILL_LISTING_DESCRIPTION_MAX_CHARS = 1_536;

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "allowed-tools",
  "disable-model-invocation",
  "argument-hint",
]);

export function parseSkillFrontmatter(text: string): ParsedSkillDocument {
  const diagnostics: string[] = [];
  const empty: SkillFrontmatter = {
    allowedTools: [],
    disableModelInvocation: false,
    unhandledKeys: [],
  };

  const normalized = text.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: empty, body: text, diagnostics: ["no frontmatter block found."] };
  }
  const fenceEnd = normalized.indexOf("\n---", 3);
  if (fenceEnd < 0) {
    return { frontmatter: empty, body: text, diagnostics: ["frontmatter block is not closed."] };
  }

  const block = normalized.slice(normalized.indexOf("\n", 3) + 1, fenceEnd);
  const body = normalized.slice(fenceEnd + 4).replace(/^\n+/u, "");

  const frontmatter: SkillFrontmatter = {
    allowedTools: [],
    disableModelInvocation: false,
    unhandledKeys: [],
  };

  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(trimmed);
    if (!match) {
      diagnostics.push(`line ${index + 1} is not a "key: value" pair.`);
      continue;
    }
    const key = match[1].toLowerCase();
    const rawValue = match[2].trim();

    // Block list: `key:` followed by indented `- item` lines.
    if (rawValue.length === 0) {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && /^\s*-\s+/u.test(lines[cursor])) {
        items.push(unquote(lines[cursor].trim().replace(/^-\s+/u, "").trim()));
        cursor += 1;
      }
      index = cursor - 1;
      if (key === "allowed-tools") {
        frontmatter.allowedTools = items.filter(Boolean);
      } else if (items.length > 0) {
        diagnostics.push(`key "${key}" does not accept a list.`);
      }
      if (!KNOWN_KEYS.has(key)) {
        frontmatter.unhandledKeys.push(key);
      }
      continue;
    }

    const value = unquote(rawValue);
    switch (key) {
      case "name":
        frontmatter.name = value;
        break;
      case "description":
        frontmatter.description = value;
        break;
      case "argument-hint":
        frontmatter.argumentHint = value;
        break;
      case "disable-model-invocation":
        frontmatter.disableModelInvocation = /^(?:true|yes|1)$/iu.test(value);
        break;
      case "allowed-tools":
        frontmatter.allowedTools = parseInlineList(rawValue);
        break;
      default:
        frontmatter.unhandledKeys.push(key);
        break;
    }
  }

  return { frontmatter, body, diagnostics };
}

/** Whether the model may select this skill without the user asking for it. */
export function isSkillAutoInvocable(frontmatter: Pick<SkillFrontmatter, "disableModelInvocation">): boolean {
  return !frontmatter.disableModelInvocation;
}

export interface SkillListingEntry {
  name: string;
  description?: string;
  argumentHint?: string;
}

/**
 * Builds the compact listing a model sees before any body is loaded.
 *
 * Entries are dropped whole rather than truncated mid-entry: a half-description is
 * worse for selection than an absent one, and the caller learns what was omitted.
 */
export function createSkillListing(
  entries: readonly SkillListingEntry[],
  options: { maxChars?: number } = {},
): { listing: string; included: string[]; omitted: string[] } {
  const maxChars = Math.max(0, options.maxChars ?? SKILL_LISTING_DESCRIPTION_MAX_CHARS);
  const included: string[] = [];
  const omitted: string[] = [];
  const lines: string[] = [];
  let used = 0;

  for (const entry of entries) {
    const hints = entry.argumentHint ? ` (args: ${entry.argumentHint})` : "";
    const description = (entry.description ?? "").replace(/\s+/gu, " ").trim();
    const line = `- ${entry.name}${hints}: ${description}`.trimEnd();
    if (used + line.length + 1 > maxChars) {
      omitted.push(entry.name);
      continue;
    }
    lines.push(line);
    included.push(entry.name);
    used += line.length + 1;
  }

  return { listing: lines.join("\n"), included, omitted };
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  if (inner.trim().length === 0) {
    return [];
  }
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
