import type {
  CodeApplyResult,
  CodeProposedEdit,
  DryRunSummary,
} from "@javis/tools";

export function createCodeProposalHash(edit: CodeProposedEdit): string {
  // Internal consistency fingerprint; native apply boundaries still enforce writes.
  const payload = [
    edit.proposalId,
    edit.workspacePath,
    ...edit.changedFiles,
    edit.patch,
  ].join("\n");
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
  return {
    operation: `Apply Code Agent patch proposal ${edit.proposalId}`,
    affectedPaths: edit.changedFiles.map((file) => ({
      source: file,
      target: file,
      action: "modify",
    })),
    riskSummary: `${edit.summary} Patch hash: ${edit.patchHash}.`,
    reversible: true,
  };
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
