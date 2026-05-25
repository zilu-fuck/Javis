import type {
  CodeApplyResult,
  CodeProposalHunk,
  CodeProposedEdit,
  DryRunSummary,
} from "@javis/tools";

export function createCodeProposalHash(edit: CodeProposedEdit): string {
  // Internal consistency fingerprint; native apply boundaries still enforce writes.
  const parts = [
    edit.proposalId,
    edit.workspacePath,
    ...edit.changedFiles,
    edit.patch,
  ];
  if (edit.baseGitHead) {
    parts.push(edit.baseGitHead);
  }
  const payload = parts.join("\n");
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function validateCodeProposal(edit: CodeProposedEdit): string | undefined {
  if (edit.patchHash !== createCodeProposalHash(edit)) {
    return "Code Agent proposal hash does not match the proposed patch content.";
  }

  return undefined;
}

export function createCodeApplyDryRun(edit: CodeProposedEdit): DryRunSummary {
  const hunkCount = edit.hunks?.length ?? 0;
  const hunkInfo = hunkCount > 0 ? ` (${hunkCount} structured hunk(s))` : "";
  const gitHeadInfo = edit.baseGitHead
    ? ` Base commit: ${edit.baseGitHead.slice(0, 7)}.`
    : "";
  return {
    operation: `Apply Code Agent patch proposal ${edit.proposalId}${hunkInfo}${gitHeadInfo}`,
    affectedPaths: edit.changedFiles.map((file) => ({
      source: file,
      target: file,
      action: "modify",
    })),
    riskSummary: `${edit.summary} Patch hash: ${edit.patchHash}.`,
    reversible: true,
  };
}

export function parsePatchHunks(patch: string): CodeProposalHunk[] | undefined {
  const trimmed = patch.trim();
  if (!trimmed) return undefined;

  const hunks: CodeProposalHunk[] = [];
  const lines = trimmed.split("\n");
  let currentHunk: CodeProposalHunk | null = null;
  let hunkLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) {
        hunks.push({ ...currentHunk, diff: hunkLines.join("\n") });
      }
      hunkLines = [];
      const match = line.match(
        /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/,
      );
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLines: parseInt(match[2] || "1", 10),
          newStart: parseInt(match[3], 10),
          newLines: parseInt(match[4] || "1", 10),
          header: line,
          diff: "",
        };
      }
    }
    if (currentHunk) {
      hunkLines.push(line);
    }
  }
  if (currentHunk) {
    hunks.push({ ...currentHunk, diff: hunkLines.join("\n") });
  }

  return hunks.length > 0 ? hunks : undefined;
}

export function validateCodeApplyResult(
  edit: CodeProposedEdit,
  result: CodeApplyResult,
): string | undefined {
  if (result.workspacePath !== edit.workspacePath) {
    return "Code Agent apply result workspace does not match the approved proposal.";
  }

  const approvedFiles = new Set(edit.changedFiles);
  const unexpectedFile = result.changedFiles.find((file) => !approvedFiles.has(file));
  if (unexpectedFile) {
    return `Code Agent apply result included an unapproved file: ${unexpectedFile}`;
  }

  return undefined;
}
