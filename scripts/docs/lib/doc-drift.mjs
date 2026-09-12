/**
 * Documentation drift detection (G3).
 *
 * The repository's own status notes had drifted two to three months behind the code:
 * `CLAUDE.md` still described the pre-rename agent kinds, a file size that had doubled,
 * and a test count from June. Prose cannot be kept in sync by good intentions, but the
 * *checkable* claims inside it can be.
 *
 * This module extracts the mechanical claims from markdown and compares them with the
 * repository, so drift fails a check instead of quietly misleading the next reader.
 *
 * Only claims that can be verified deterministically are checked. A documented test
 * count, for example, is deliberately not asserted: verifying it would mean running
 * the whole suite from inside a documentation check.
 */

/** Claims whose failure means the document is factually wrong. */
export const ERROR = "error";
/** Claims that are merely out of date, or that depend on external state. */
export const WARNING = "warning";

const PNPM_SCRIPT_PATTERN = /`pnpm ([a-z][a-z0-9:_-]*)/gu;
/** Scripts that are pnpm itself, not repository scripts. */
const PNPM_BUILTINS = new Set(["install", "add", "remove", "exec", "dlx", "run", "why", "list"]);

/**
 * Extracts `pnpm <script>` references, ignoring pnpm's own subcommands and the
 * `--filter`/`-r` forms that do not name a script.
 */
export function extractPnpmScripts(text) {
  const scripts = new Set();
  for (const match of text.matchAll(PNPM_SCRIPT_PATTERN)) {
    const name = match[1];
    if (PNPM_BUILTINS.has(name)) continue;
    scripts.add(name);
  }
  return [...scripts].sort();
}

/**
 * Extracts backticked agent-kind lists, e.g.
 * `` `commander | file | shell` `` — the form both AGENTS.md and CLAUDE.md use.
 */
export function extractAgentKindLists(text) {
  const lists = [];
  for (const match of text.matchAll(/`([a-z][a-z0-9-]*(?: \| [a-z][a-z0-9-]*)+)`/gu)) {
    lists.push({ raw: match[1], kinds: match[1].split(" | ").map((kind) => kind.trim()) });
  }
  return lists;
}

/** Reads the `AgentKind` union out of its TypeScript declaration. */
export function parseAgentKindUnion(source) {
  const declaration = /export type AgentKind =([\s\S]*?);/u.exec(source);
  if (!declaration) return [];
  return [...declaration[1].matchAll(/"([a-z][a-z0-9-]*)"/gu)].map((match) => match[1]);
}

/** Reads the legacy alias map out of `agents.ts` (keys may be quoted or bare). */
export function parseAgentKindAliases(source) {
  const block = /const AGENT_KIND_ALIASES[^=]*=\s*\{([\s\S]*?)\};/u.exec(source);
  if (!block) return {};
  const aliases = {};
  for (const match of block[1].matchAll(/"?'?([a-z][a-z0-9-]*)'?"?\s*:\s*"([a-z][a-z0-9-]*)"/gu)) {
    aliases[match[1]] = match[2];
  }
  return aliases;
}

/**
 * Extracts `` `path/to/file.ts` is ~1,234 lines `` style claims.
 * Returns the raw number as written so the report can quote the document.
 */
export function extractLineCountClaims(text) {
  const claims = [];
  for (const match of text.matchAll(/`([\w./@-]+\.(?:ts|tsx|rs))`[^.\n]{0,40}?~?([\d,]{2,})\s*lines/gu)) {
    claims.push({ file: match[1], claimedLines: Number(match[2].replaceAll(",", "")), raw: match[0] });
  }
  return claims;
}

/** Extracts `## Current State (YYYY-MM-DD)` style freshness stamps. */
export function extractDatedSections(text) {
  const sections = [];
  for (const match of text.matchAll(/^##+\s*(.+?)\s*\((\d{4}-\d{2}-\d{2})\)\s*$/gmu)) {
    sections.push({ title: match[1], date: match[2] });
  }
  return sections;
}

/**
 * Only a *status* stamp is expected to be recent. A release heading
 * (`## 0.1.0 (2026-05-28)`) or a section explicitly marked historical is supposed to
 * be old, so flagging it as stale would be noise rather than drift.
 */
export function isStatusStamp(title) {
  if (/historical|历史|released?|发布/i.test(title)) {
    return false;
  }
  return /current state|status|现状|当前状态/i.test(title);
}

/**
 * Compares every extracted claim against the repository.
 *
 * `files` maps a repository-relative path to its text (already read by the caller),
 * and `lineCounts` maps the same paths to their line count, so this stays pure.
 */
export function checkDocDrift(input) {
  const issues = [];
  const {
    documents,
    packageScripts,
    agentKinds,
    agentKindAliases = {},
    lineCounts = {},
    headDate,
    now = new Date().toISOString().slice(0, 10),
    staleAfterDays = 45,
    lineCountTolerance = 0.3,
  } = input;

  const scriptNames = new Set(Object.keys(packageScripts));
  const kindSet = new Set(agentKinds);

  for (const doc of documents) {
    for (const script of extractPnpmScripts(doc.text)) {
      if (!scriptNames.has(script)) {
        issues.push({
          severity: ERROR,
          doc: doc.path,
          message: `references "pnpm ${script}", which is not a script in package.json.`,
        });
      }
    }

    for (const list of extractAgentKindLists(doc.text)) {
      for (const kind of list.kinds) {
        if (kindSet.has(kind)) continue;
        if (Object.prototype.hasOwnProperty.call(agentKindAliases, kind)) {
          issues.push({
            severity: WARNING,
            doc: doc.path,
            message: `lists the legacy agent kind "${kind}"; the canonical name is "${agentKindAliases[kind]}".`,
          });
          continue;
        }
        issues.push({
          severity: ERROR,
          doc: doc.path,
          message: `lists agent kind "${kind}", which is not in the AgentKind union.`,
        });
      }
    }

    for (const claim of extractLineCountClaims(doc.text)) {
      const actual = lineCounts[claim.file];
      if (actual === undefined) continue;
      const drift = Math.abs(actual - claim.claimedLines) / Math.max(1, claim.claimedLines);
      if (drift > lineCountTolerance) {
        issues.push({
          severity: WARNING,
          doc: doc.path,
          message: `claims ${claim.file} is ~${claim.claimedLines} lines; it is ${actual} (${Math.round(drift * 100)}% off).`,
        });
      }
    }

    for (const section of extractDatedSections(doc.text)) {
      if (!headDate || !isStatusStamp(section.title)) continue;
      const ageDays = Math.round((Date.parse(headDate) - Date.parse(section.date)) / 86_400_000);
      if (Number.isFinite(ageDays) && ageDays > staleAfterDays) {
        issues.push({
          severity: WARNING,
          doc: doc.path,
          message: `section "${section.title}" is stamped ${section.date}, ${ageDays} days behind HEAD (${headDate}).`,
        });
      }
    }
  }

  // A section stamped in the future is a typo, not staleness.
  for (const doc of documents) {
    for (const section of extractDatedSections(doc.text)) {
      if (Date.parse(section.date) > Date.parse(now)) {
        issues.push({
          severity: ERROR,
          doc: doc.path,
          message: `section "${section.title}" is stamped in the future (${section.date}).`,
        });
      }
    }
  }

  return {
    issues,
    errors: issues.filter((issue) => issue.severity === ERROR).length,
    warnings: issues.filter((issue) => issue.severity === WARNING).length,
  };
}
