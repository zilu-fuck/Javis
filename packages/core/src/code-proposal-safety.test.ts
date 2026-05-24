import { describe, expect, it } from "vitest";
import {
  createCodeApplyDryRun,
  createCodeProposalHash,
  validateCodeApplyResult,
  validateCodeProposal,
} from "./code-proposal-safety";
import type { CodeProposedEdit } from "@javis/tools";

describe("code-proposal-safety", () => {
  it("creates stable proposal hashes that change with proposal content", () => {
    const proposal = createProposal();

    expect(createCodeProposalHash(proposal)).toBe(createCodeProposalHash({ ...proposal }));
    expect(createCodeProposalHash({ ...proposal, patch: `${proposal.patch}\n+new line` }))
      .not.toBe(createCodeProposalHash(proposal));
    expect(createCodeProposalHash({ ...proposal, changedFiles: ["packages/core/src/other.ts"] }))
      .not.toBe(createCodeProposalHash(proposal));
  });

  it("matches the native proposal hash test vector", () => {
    expect(createCodeProposalHash({
      proposalId: "opencode-test",
      workspacePath: "E:/Javis",
      summary: "Tighten message copy.",
      changedFiles: ["src/message.txt"],
      patch: "diff --git a/src/message.txt b/src/message.txt\n",
      patchHash: "",
    })).toBe("fnv1a-00ce5494");
  });

  it("validates proposal hashes", () => {
    const proposal = createProposal();
    const validProposal = {
      ...proposal,
      patchHash: createCodeProposalHash(proposal),
    };

    expect(validateCodeProposal(validProposal)).toBeUndefined();
    expect(validateCodeProposal({ ...validProposal, patchHash: "fnv1a-wrong" }))
      .toContain("hash does not match");
  });

  it("creates confirmed-write dry-runs from changed files", () => {
    const proposal = createProposal();
    const dryRun = createCodeApplyDryRun(proposal);

    expect(dryRun.operation).toContain(proposal.proposalId);
    expect(dryRun.riskSummary).toContain(proposal.patchHash);
    expect(dryRun.affectedPaths).toEqual([
      {
        source: "packages/core/src/index.ts",
        target: "packages/core/src/index.ts",
        action: "modify",
      },
    ]);
  });

  it("validates apply result workspace and approved files", () => {
    const proposal = createProposal();

    expect(validateCodeApplyResult(proposal, {
      applied: true,
      workspacePath: proposal.workspacePath,
      changedFiles: proposal.changedFiles,
      message: "Applied.",
    })).toBeUndefined();
    expect(validateCodeApplyResult(proposal, {
      applied: true,
      workspacePath: "E:/Other",
      changedFiles: proposal.changedFiles,
      message: "Wrong workspace.",
    })).toContain("workspace does not match");
    expect(validateCodeApplyResult(proposal, {
      applied: true,
      workspacePath: proposal.workspacePath,
      changedFiles: [...proposal.changedFiles, "packages/core/src/other.ts"],
      message: "Unexpected file.",
    })).toContain("unapproved file");
  });
});

function createProposal(): CodeProposedEdit {
  return {
    proposalId: "proposal-1",
    workspacePath: "E:/Javis",
    summary: "Tighten the code review completion message.",
    changedFiles: ["packages/core/src/index.ts"],
    patch: "diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts",
    patchHash: "fnv1a-placeholder",
  };
}
