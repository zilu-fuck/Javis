import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "@javis/tools";
import { createDefaultAgentRegistry } from "./agents";
import {
  assertDelegatedToolIsReadOrPreview,
  filterAgentForDelegation,
  filterDelegableToolDescriptors,
} from "./delegation-policy";
import {
  getAvailableAgentsForPlanning,
  getDelegableSubAgentsForPlanning,
} from "./workflow-executor";

describe("delegation policy", () => {
  it("keeps read and preview tools delegable while parent-coordinating confirmed writes", () => {
    const delegable = filterDelegableToolDescriptors(initialToolDescriptors);
    const delegableNames = new Set(delegable.map((tool) => tool.name));

    expect(delegableNames).toContain("code.inspectRepository");
    expect(delegableNames).toContain("code.proposeEdit");
    expect(delegableNames).not.toContain("code.applyProposedEdit");
    expect(delegableNames).not.toContain("git.stageFiles");
    expect(delegableNames).not.toContain("git.createPullRequest");
  });

  it("filters agent tool surfaces for read/preview sub-agent delegation", () => {
    const codeAgent = createDefaultAgentRegistry().findByKind("code")!.agent;
    const delegatedCodeAgent = filterAgentForDelegation(codeAgent, initialToolDescriptors);

    expect(delegatedCodeAgent.allowedToolNames).toContain("code.inspectRepository");
    expect(delegatedCodeAgent.allowedToolNames).toContain("code.proposeEdit");
    expect(delegatedCodeAgent.allowedToolNames).not.toContain("code.applyProposedEdit");
  });

  it("fails closed when a confirmed-write tool is delegated", () => {
    expect(() => assertDelegatedToolIsReadOrPreview({
      name: "code.applyProposedEdit",
      permissionLevel: "confirmed_write",
    })).toThrow("must remain parent-coordinated");
  });

  it("keeps Commander planning surfaces intact while sub-agent planning filters write tools", () => {
    const agents = getAvailableAgentsForPlanning(
      initialToolDescriptors,
      "inspect this repository",
      undefined,
    );
    const codeAgent = agents.find((agent) => agent.kind === "code");
    expect(codeAgent?.allowedToolNames).toContain("code.applyProposedEdit");

    const delegatedAgents = getDelegableSubAgentsForPlanning(
      initialToolDescriptors,
      "inspect this repository",
    );
    const delegatedCodeAgent = delegatedAgents.find((agent) => agent.kind === "code");

    expect(delegatedCodeAgent?.allowedToolNames).toContain("code.proposeEdit");
    expect(delegatedCodeAgent?.allowedToolNames).not.toContain("code.applyProposedEdit");
    expect(delegatedAgents.find((agent) => agent.kind === "commander")).toBeUndefined();
  });
});
