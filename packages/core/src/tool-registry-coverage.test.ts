import { initialToolDescriptors } from "@javis/tools";
import { describe, expect, it } from "vitest";
import { demoAgents } from "./agents";
import { SUPPORTED_APPROVAL_GATED_TOOLS } from "./workflow-executor";

type WriteExecutionSurface =
  | "commander_dag"
  | "computer_loop"
  | "page_agent_loop"
  | "specialized_workflow";

type NonWriteExecutionSurface =
  | "direct_dispatch"
  | "commander_planning"
  | "commander_direct_response"
  | "commander_request_input";

const NON_WRITE_EXECUTION_SURFACES = {
  "commander.plan": "commander_planning",
  "commander.synthesize": "commander_direct_response",
  "commander.askUser": "commander_request_input",
  "verifier.check": "direct_dispatch",
  "file.scanMarkdownDocuments": "direct_dispatch",
  "file.scanUserDocuments": "direct_dispatch",
  "file.classifyDocuments": "direct_dispatch",
  "file.planPdfOrganization": "direct_dispatch",
  "file.planWriteText": "direct_dispatch",
  "file.readWorkspaceText": "direct_dispatch",
  "shell.runReadOnlyCommand": "direct_dispatch",
  "code.inspectRepository": "direct_dispatch",
  "code.inspectWorkspace": "direct_dispatch",
  "code.searchRepository": "direct_dispatch",
  "code.traceCallChain": "direct_dispatch",
  "code.proposeEdit": "direct_dispatch",
  "web.search": "direct_dispatch",
  "web.fetchSource": "direct_dispatch",
  "trend.fetchHotList": "direct_dispatch",
  "memory.search": "direct_dispatch",
  "file.scanUserImages": "direct_dispatch",
  "file.scanInstalledApps": "direct_dispatch",
  "computer.searchLocalDocuments": "direct_dispatch",
  "computer.listDirectory": "direct_dispatch",
  "computer.screenshot": "direct_dispatch",
  "computer.listWindows": "direct_dispatch",
  "computer.inspectUi": "direct_dispatch",
  "computer.wait": "direct_dispatch",
  "workspace.list": "direct_dispatch",
  "workspace.scaffold": "direct_dispatch",
  "browser.navigate": "direct_dispatch",
  "browser.screenshot": "direct_dispatch",
  "browser.getContent": "direct_dispatch",
  "browser.extractLinks": "direct_dispatch",
  "browser.followCandidateLinks": "direct_dispatch",
  "vision.analyze": "direct_dispatch",
  "vision.describe": "direct_dispatch",
  "vision.extractText": "direct_dispatch",
} satisfies Record<string, NonWriteExecutionSurface>;

const WRITE_EXECUTION_SURFACES = {
  "file.executePdfOrganization": "specialized_workflow",
  "file.writeText": "commander_dag",
  "code.applyProposedEdit": "specialized_workflow",
  "git.stageFiles": "commander_dag",
  "git.createCommit": "commander_dag",
  "git.createPullRequest": "commander_dag",
  "git.commentPullRequest": "commander_dag",
  "computer.openPath": "specialized_workflow",
  "computer.focusWindow": "computer_loop",
  "computer.moveMouse": "computer_loop",
  "computer.click": "computer_loop",
  "computer.type": "computer_loop",
  "computer.keyCombo": "computer_loop",
  "computer.scroll": "computer_loop",
  "computer.invokeUi": "computer_loop",
  "computer.setUiValue": "computer_loop",
  "scheduler.createTask": "commander_dag",
  "shell.runWorkspaceCommand": "commander_dag",
  "workspace.create": "commander_dag",
  "workspace.delete": "commander_dag",
  "browser.click": "page_agent_loop",
  "browser.type": "page_agent_loop",
  "browser.evaluate": "page_agent_loop",
  "browser.runTest": "page_agent_loop",
} satisfies Record<string, WriteExecutionSurface>;

describe("built-in agent and tool registry coverage", () => {
  it("keeps ToolDescriptor ownership identical to Agent allowlists", () => {
    const agentsByKind = new Map<string, (typeof demoAgents)[number]>(
      demoAgents.map((agent) => [agent.kind, agent]),
    );
    const toolsByName = new Map(initialToolDescriptors.map((tool) => [tool.name, tool]));

    for (const agent of demoAgents) {
      expect(agent.allowedToolNames.length, agent.kind).toBeGreaterThan(0);
      for (const toolName of agent.allowedToolNames) {
        const descriptor = toolsByName.get(toolName);
        expect(descriptor, `${agent.kind}:${toolName}`).toBeDefined();
        expect(descriptor?.ownerAgentKinds, `${agent.kind}:${toolName}`).toContain(agent.kind);
      }
    }

    for (const descriptor of initialToolDescriptors) {
      expect(descriptor.capabilityTags.length, descriptor.name).toBeGreaterThan(0);
      expect(descriptor.ownerAgentKinds.length, descriptor.name).toBeGreaterThan(0);
      for (const ownerKind of descriptor.ownerAgentKinds) {
        const owner = agentsByKind.get(ownerKind);
        expect(owner, `${descriptor.name}:${ownerKind}`).toBeDefined();
        expect(owner?.allowedToolNames, `${descriptor.name}:${ownerKind}`).toContain(descriptor.name);
      }
    }
  });

  it("classifies every confirmed-write tool by its real approval runner", () => {
    const confirmedWriteNames = initialToolDescriptors
      .filter((tool) => tool.permissionLevel === "confirmed_write")
      .map((tool) => tool.name)
      .sort();

    expect(Object.keys(WRITE_EXECUTION_SURFACES).sort()).toEqual(confirmedWriteNames);

    const compilerSupported = Object.entries(WRITE_EXECUTION_SURFACES)
      .filter(([, surface]) => surface === "commander_dag" || surface === "computer_loop")
      .map(([toolName]) => toolName)
      .sort();
    expect([...SUPPORTED_APPROVAL_GATED_TOOLS].sort()).toEqual(compilerSupported);
  });

  it("classifies every read and preview tool by its real execution surface", () => {
    const nonWriteNames = initialToolDescriptors
      .filter((tool) => tool.permissionLevel !== "confirmed_write")
      .map((tool) => tool.name)
      .sort();

    expect(Object.keys(NON_WRITE_EXECUTION_SURFACES).sort()).toEqual(nonWriteNames);
    expect([
      ...Object.keys(NON_WRITE_EXECUTION_SURFACES),
      ...Object.keys(WRITE_EXECUTION_SURFACES),
    ].sort()).toEqual(initialToolDescriptors.map((tool) => tool.name).sort());
  });

  it("binds loop-only writes to the correct interactive agent", () => {
    const descriptorsByName = new Map(initialToolDescriptors.map((tool) => [tool.name, tool]));

    for (const [toolName, surface] of Object.entries(WRITE_EXECUTION_SURFACES)) {
      const descriptor = descriptorsByName.get(toolName);
      expect(descriptor, toolName).toBeDefined();
      if (surface === "computer_loop") {
        expect(descriptor?.ownerAgentKinds, toolName).toEqual(["computer"]);
      }
      if (surface === "page_agent_loop") {
        expect(descriptor?.ownerAgentKinds, toolName).toEqual(["page-agent"]);
      }
    }
  });

  it("covers every built-in agent with at least one registered tool", () => {
    const ownerKinds = new Set(initialToolDescriptors.flatMap((tool) => tool.ownerAgentKinds));
    for (const agent of demoAgents) {
      expect(ownerKinds.has(agent.kind), agent.kind).toBe(true);
    }
  });
});
