import { describe, expect, it } from "vitest";
import { compileCommanderPlan } from "../commander-plan-compiler";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import type { ToolDescriptor } from "@javis/tools";
import type { CompileCommanderPlanInput } from "../commander-plan-compiler";

// --- Test Helpers -------------------------------------------------------------

function makeToolDescriptor(
  name: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    name,
    permissionLevel: "read",
    summary: `Tool: ${name}`,
    capabilityTags: [],
    ownerAgentKinds: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CompileCommanderPlanInput> & { plan: CommanderDagPlan }): CompileCommanderPlanInput {
  return {
    availableAgents: [
      { kind: "commander", allowedToolNames: ["commander.plan", "commander.synthesize", "commander.askUser"] },
      { kind: "code", allowedToolNames: ["code.inspectRepository", "code.searchRepository", "shell.runReadOnlyCommand"] },
      { kind: "file", allowedToolNames: ["file.scanMarkdownDocuments", "file.writeText"] },
      { kind: "computer", allowedToolNames: ["computer.listDirectory", "computer.openPath", "computer.screenshot"] },
      { kind: "verifier", allowedToolNames: ["verifier.check"] },
      { kind: "research", allowedToolNames: ["web.search", "web.fetchSource"] },
    ],
    availableTools: [
      makeToolDescriptor("commander.plan", { capabilityTags: ["planning"], ownerAgentKinds: ["commander"] }),
      makeToolDescriptor("commander.synthesize", { capabilityTags: ["synthesis"], ownerAgentKinds: ["commander"] }),
      makeToolDescriptor("commander.askUser", { capabilityTags: ["clarification"], ownerAgentKinds: ["commander"] }),
      makeToolDescriptor("code.inspectRepository", { capabilityTags: ["git_inspect"], ownerAgentKinds: ["code", "explorer"] }),
      makeToolDescriptor("code.searchRepository", { capabilityTags: ["code_search"], ownerAgentKinds: ["code"] }),
      makeToolDescriptor("shell.runReadOnlyCommand", { capabilityTags: ["shell_readonly"], ownerAgentKinds: ["shell", "code"] }),
      makeToolDescriptor("file.scanMarkdownDocuments", { capabilityTags: ["file_scan"], ownerAgentKinds: ["file", "verifier"] }),
      makeToolDescriptor("file.writeText", { permissionLevel: "confirmed_write", capabilityTags: ["file_execute"], ownerAgentKinds: ["file"] }),
      makeToolDescriptor("computer.listDirectory", {
        capabilityTags: ["directory_list"],
        ownerAgentKinds: ["computer"],
        requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
      }),
      makeToolDescriptor("computer.openPath", {
        capabilityTags: ["local_search"],
        ownerAgentKinds: ["computer"],
        requiredInputs: [{ name: "path", type: "string", nonEmpty: true }],
      }),
      makeToolDescriptor("computer.screenshot", { capabilityTags: ["desktop_screenshot"], ownerAgentKinds: ["computer"] }),
      makeToolDescriptor("verifier.check", { capabilityTags: ["evidence_check"], ownerAgentKinds: ["verifier"] }),
      makeToolDescriptor("web.search", { capabilityTags: ["web_search"], ownerAgentKinds: ["research"] }),
      makeToolDescriptor("web.fetchSource", { capabilityTags: ["web_fetch"], ownerAgentKinds: ["research"] }),
      makeToolDescriptor("git.stageFiles", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["git_stage"],
        ownerAgentKinds: ["code"],
        requiredInputs: [{ name: "paths", type: "string[]", nonEmpty: true }],
      }),
      makeToolDescriptor("git.createCommit", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["git_commit"],
        ownerAgentKinds: ["code"],
        requiredInputs: [{ name: "message", type: "string", nonEmpty: true }],
      }),
      makeToolDescriptor("git.createPullRequest", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["git_pr_create"],
        ownerAgentKinds: ["code"],
        requiredInputs: [
          { name: "title", type: "string", nonEmpty: true },
          { name: "baseBranch", type: "string", nonEmpty: true },
        ],
      }),
      makeToolDescriptor("git.commentPullRequest", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["git_pr_comment"],
        ownerAgentKinds: ["code"],
        requiredInputs: [
          { name: "pullRequest", type: "string", nonEmpty: true },
          { name: "body", type: "string", nonEmpty: true },
        ],
      }),
    ],
    supportedApprovalGatedTools: ["git.stageFiles", "git.createCommit", "git.createPullRequest", "git.commentPullRequest"],
    preloadedContextKeys: ["userGoal", "taskId"],
    ...overrides,
  };
}

function validPlan(): CommanderDagPlan {
  return {
    title: "Test plan",
    reasoning: "Testing.",
    steps: [
      {
        id: "scan",
        title: "Scan codebase",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        successCriteria: "Codebase scanned.",
      },
    ],
  };
}

// --- Tests --------------------------------------------------------------------

describe("compileCommanderPlan", () => {
  it("compiles a valid minimal DAG", () => {
    const result = compileCommanderPlan(makeInput({ plan: validPlan() }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    }
  });

  it("rejects duplicate step ids", () => {
    const plan: CommanderDagPlan = {
      title: "Dup test",
      reasoning: "test",
      steps: [
        { id: "scan", title: "A", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: [], successCriteria: "." },
        { id: "scan", title: "B", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "DUPLICATE_STEP_ID")).toBe(true);
    }
  });

  it("rejects missing dependency", () => {
    const plan: CommanderDagPlan = {
      title: "Missing dep",
      reasoning: "test",
      steps: [
        { id: "analyze", title: "Analyze", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: ["nonexistent"], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_DEPENDENCY")).toBe(true);
    }
  });

  it("rejects dependency pointing to later step", () => {
    const plan: CommanderDagPlan = {
      title: "Order test",
      reasoning: "test",
      steps: [
        { id: "step-b", title: "B", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: ["step-a"], successCriteria: "." },
        { id: "step-a", title: "A", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "DEPENDENCY_NOT_PRIOR")).toBe(true);
    }
  });

  it("rejects cyclic dependency", () => {
    const plan: CommanderDagPlan = {
      title: "Cycle test",
      reasoning: "test",
      steps: [
        { id: "a", title: "A", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: ["b"], successCriteria: "." },
        { id: "b", title: "B", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: ["a"], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "CYCLIC_DEPENDENCY")).toBe(true);
    }
  });

  it("rejects unknown agent", () => {
    const plan: CommanderDagPlan = {
      title: "Unknown agent",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "nonexistent-agent", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNKNOWN_AGENT")).toBe(true);
    }
  });

  it("rejects unknown tool", () => {
    const plan: CommanderDagPlan = {
      title: "Unknown tool",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "code", toolName: "nonexistent.tool", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNKNOWN_TOOL")).toBe(true);
    }
  });

  it("rejects tool not allowed for agent", () => {
    const plan: CommanderDagPlan = {
      title: "Tool not allowed",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "file", toolName: "computer.listDirectory", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "TOOL_NOT_ALLOWED")).toBe(true);
    }
  });

  it("rejects unsupported approval-gated tool", () => {
    const plan: CommanderDagPlan = {
      title: "Approval gated",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "file", toolName: "file.writeText", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_APPROVAL_GATED_TOOL")).toBe(true);
    }
  });

  it("treats empty allowlist as denying every approval-gated tool", () => {
    const plan: CommanderDagPlan = {
      title: "Empty allowlist",
      reasoning: "test",
      steps: [
        { id: "stage", title: "Stage", assignedAgentKind: "code", toolName: "git.stageFiles", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      supportedApprovalGatedTools: [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_APPROVAL_GATED_TOOL")).toBe(true);
    }
  });

  it("accepts git tools when their names are explicitly in the allowlist", () => {
    const plan: CommanderDagPlan = {
      title: "Git flow",
      reasoning: "test",
      steps: [
        {
          id: "stage",
          title: "Stage",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { paths: ["a.ts"] },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("rejects an approval-gated tool whose name is not in the allowlist (negative test)", () => {
    // git.createCommit is in the canonical allowlist. If a caller passes a
    // narrower allowlist that omits it, the compiler must flag the step.
    const plan: CommanderDagPlan = {
      title: "Narrow allowlist",
      reasoning: "test",
      steps: [
        {
          id: "commit",
          title: "Commit",
          assignedAgentKind: "code",
          toolName: "git.createCommit",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { message: "x" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      supportedApprovalGatedTools: ["git.stageFiles"],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_APPROVAL_GATED_TOOL")).toBe(true);
    }
  });

  it("rejects missing path for computer.listDirectory", () => {
    const plan: CommanderDagPlan = {
      title: "Missing path",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          toolInput: {},
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("path"))).toBe(true);
    }
  });

  it("rejects missing path for computer.openPath", () => {
    const plan: CommanderDagPlan = {
      title: "Missing path",
      reasoning: "test",
      steps: [
        {
          id: "open",
          title: "Open path",
          assignedAgentKind: "computer",
          toolName: "computer.openPath",
          requiredCapabilities: ["local_search"],
          dependsOn: [],
          toolInput: {},
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_TOOL_INPUT")).toBe(true);
    }
  });

  it("accepts computer.listDirectory with valid path", () => {
    const plan: CommanderDagPlan = {
      title: "Valid path",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          toolInput: { path: "C:\\Users" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("rejects computer.listDirectory when path is wrong type (number)", () => {
    const plan: CommanderDagPlan = {
      title: "Wrong type",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          // intentionally wrong type for compile-time guard
          toolInput: { path: 123 as unknown as string },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("path"),
      );
      expect(diag).toBeDefined();
      expect(diag?.message).toMatch(/string/);
      expect(diag?.severity).toBe("error");
    }
  });

  it("rejects computer.listDirectory when path is null", () => {
    const plan: CommanderDagPlan = {
      title: "Null path",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          toolInput: { path: null as unknown as string },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("path"),
      )).toBe(true);
    }
  });

  it("rejects git.stageFiles when paths is not a string[]", () => {
    const plan: CommanderDagPlan = {
      title: "Wrong array type",
      reasoning: "test",
      steps: [
        {
          id: "stage",
          title: "Stage files",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          requiredCapabilities: ["git_stage"],
          dependsOn: [],
          // intentionally wrong type for compile-time guard
          toolInput: { paths: "src/index.ts" as unknown as string[] },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("paths"),
      );
      expect(diag).toBeDefined();
      // Zod says "expected array, received string" — different wording
      // than the hand-written check, but the diagnostic code / step
      // attribution are what callers care about. Both are still here.
      expect(diag?.message).toMatch(/expected array/i);
    }
  });

  it("rejects git.stageFiles when paths contains a non-string entry", () => {
    const plan: CommanderDagPlan = {
      title: "Mixed array",
      reasoning: "test",
      steps: [
        {
          id: "stage",
          title: "Stage files",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          requiredCapabilities: ["git_stage"],
          dependsOn: [],
          // mixed entries - non-string in the middle of an array
          toolInput: { paths: ["src/index.ts", 42] as unknown as string[] },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("paths"),
      )).toBe(true);
    }
  });

  it("rejects git.createPullRequest without baseBranch", () => {
    const plan: CommanderDagPlan = {
      title: "PR without base",
      reasoning: "test",
      steps: [
        {
          id: "create-pr",
          title: "Create PR",
          assignedAgentKind: "code",
          toolName: "git.createPullRequest",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { title: "My PR" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("baseBranch"),
      )).toBe(true);
    }
  });

  it("accepts git.createPullRequest with valid title and baseBranch", () => {
    const plan: CommanderDagPlan = {
      title: "Valid PR",
      reasoning: "test",
      steps: [
        {
          id: "create-pr",
          title: "Create PR",
          assignedAgentKind: "code",
          toolName: "git.createPullRequest",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { title: "My PR", baseBranch: "main" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("rejects git.stageFiles with empty paths array", () => {
    const plan: CommanderDagPlan = {
      title: "Empty paths",
      reasoning: "test",
      steps: [
        {
          id: "stage",
          title: "Stage files",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { paths: [] },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("paths"),
      )).toBe(true);
    }
  });

  it("rejects direct_response with non-synthesis toolName as error", () => {
    const plan: CommanderDagPlan = {
      title: "Direct response w/ tool",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List directory",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          executionMode: "direct_response",
          toolInput: { path: "C:\\Users" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find((d) => d.code === "INVALID_EXECUTION_MODE");
      expect(diag).toBeDefined();
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("direct_response");
      expect(diag?.message).toContain("computer.listDirectory");
    }
  });

  it("accepts direct_response with no toolName", () => {
    const plan: CommanderDagPlan = {
      title: "Pure synthesis",
      reasoning: "test",
      steps: [
        {
          id: "synth",
          title: "Synthesize",
          assignedAgentKind: "commander",
          requiredCapabilities: ["synthesis"],
          dependsOn: [],
          executionMode: "direct_response",
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("accepts direct_response with commander.synthesize toolName", () => {
    const plan: CommanderDagPlan = {
      title: "Explicit synthesis",
      reasoning: "test",
      steps: [
        {
          id: "synth",
          title: "Synthesize",
          assignedAgentKind: "commander",
          toolName: "commander.synthesize",
          requiredCapabilities: ["synthesis"],
          dependsOn: [],
          executionMode: "direct_response",
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("warns about unknown capability when step has a toolName fallback", () => {
    const plan: CommanderDagPlan = {
      title: "Unknown cap with tool",
      reasoning: "test",
      steps: [
        {
          id: "step",
          title: "Step",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          requiredCapabilities: ["totally_fake_capability"],
          dependsOn: [],
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((d) => d.code === "UNKNOWN_CAPABILITY")).toBe(true);
    }
  });

  it("rejects unknown capability as error when step has no toolName", () => {
    const plan: CommanderDagPlan = {
      title: "Unknown cap without tool",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "code", requiredCapabilities: ["totally_fake_capability"], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const capDiag = result.diagnostics.find((d) => d.code === "UNKNOWN_CAPABILITY");
      expect(capDiag).toBeDefined();
      expect(capDiag?.severity).toBe("error");
      expect(capDiag?.message).toContain("no toolName");
      expect(result.repairable).toBe(true);
    }
  });

  it("rejects capability not available for agent (canonical tag)", () => {
    const plan: CommanderDagPlan = {
      title: "Cap not available",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "file", capability: "web_search", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "CAPABILITY_NOT_AVAILABLE")).toBe(true);
    }
  });

  it("rejects missing context producer (error now that allowlist is explicit)", () => {
    const plan: CommanderDagPlan = {
      title: "Missing producer",
      reasoning: "test",
      steps: [
        {
          id: "consumer",
          title: "Consumer",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: [],
          inputContextKeys: ["uiEvidence"],
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_CONTEXT_PRODUCER")).toBe(true);
      expect(result.repairable).toBe(true);
    }
  });

  it("rejects context producer not depended on (error now that allowlist is explicit)", () => {
    const plan: CommanderDagPlan = {
      title: "Producer not depended",
      reasoning: "test",
      steps: [
        {
          id: "producer",
          title: "Producer",
          assignedAgentKind: "code",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "evidence",
          successCriteria: ".",
        },
        {
          id: "consumer",
          title: "Consumer",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: [],
          inputContextKeys: ["evidence"],
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "CONTEXT_PRODUCER_NOT_DEPENDED_ON")).toBe(true);
      expect(result.repairable).toBe(true);
    }
  });

  it("rejects duplicate outputContextKey", () => {
    const plan: CommanderDagPlan = {
      title: "Dup output",
      reasoning: "test",
      steps: [
        { id: "a", title: "A", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: [], outputContextKey: "result", successCriteria: "." },
        { id: "b", title: "B", assignedAgentKind: "file", requiredCapabilities: ["file_scan"], dependsOn: [], outputContextKey: "result", successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "DUPLICATE_OUTPUT_CONTEXT_KEY")).toBe(true);
    }
  });

  it("rejects invalid execution mode", () => {
    const plan: CommanderDagPlan = {
      title: "Bad mode",
      reasoning: "test",
      steps: [
        { id: "step", title: "Step", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: [], executionMode: "invalid_mode" as any, successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "INVALID_EXECUTION_MODE")).toBe(true);
    }
  });

  it("accepts valid plan with dependencies and context flow", () => {
    const plan: CommanderDagPlan = {
      title: "Full valid plan",
      reasoning: "Test a multi-step plan.",
      steps: [
        {
          id: "scan",
          title: "Scan code",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "scanResult",
          successCriteria: "Code scanned.",
        },
        {
          id: "verify",
          title: "Verify",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["scan"],
          inputContextKeys: ["scanResult"],
          successCriteria: "Verified.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("handles existingSteps for recovery plans", () => {
    const plan: CommanderDagPlan = {
      title: "Recovery plan",
      reasoning: "Recovery.",
      steps: [
        {
          id: "retry",
          title: "Retry step",
          assignedAgentKind: "code",
          requiredCapabilities: ["code_search"],
          dependsOn: ["already-done"],
          inputContextKeys: ["step:already-done"],
          successCriteria: "Done.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      existingSteps: [{ id: "already-done", dependsOn: [] }],
    }));
    expect(result.ok).toBe(true);
  });

  it("recovery step that reads an existing step's outputContextKey but does not depend on it fails CONTEXT_PRODUCER_NOT_DEPENDED_ON", () => {
    const plan: CommanderDagPlan = {
      title: "Recovery without dep",
      reasoning: "Recovery step forgets dependsOn.",
      steps: [
        {
          id: "retry",
          title: "Retry",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: [],
          inputContextKeys: ["evidence"],
          successCriteria: "Done.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      existingSteps: [{ id: "scan", dependsOn: [], outputContextKey: "evidence" }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find((d) => d.code === "CONTEXT_PRODUCER_NOT_DEPENDED_ON");
      expect(diag).toBeDefined();
      expect(diag?.message).toContain("scan");
      expect(diag?.suggestedFix).toContain("existing step");
    }
  });

  it("recovery step that reads an existing step's outputContextKey and depends on it compiles", () => {
    const plan: CommanderDagPlan = {
      title: "Recovery with dep",
      reasoning: "Recovery step explicitly depends on the producer.",
      steps: [
        {
          id: "verify",
          title: "Verify",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["scan"],
          inputContextKeys: ["evidence"],
          successCriteria: "Done.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      existingSteps: [{ id: "scan", dependsOn: [], outputContextKey: "evidence" }],
    }));
    expect(result.ok).toBe(true);
  });

  it("recovery step that transitively depends on an existing producer compiles", () => {
    // plan.steps: retry -> existing-step
    // existingSteps: existing-step -> root-existing
    // Reading `step:root-existing` from `retry` should be ok because
    // ancestor walk now follows existing steps.
    const plan: CommanderDagPlan = {
      title: "Recovery transitive",
      reasoning: "Recovery step transitively depends on existing root.",
      steps: [
        {
          id: "retry",
          title: "Retry",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["existing-step"],
          inputContextKeys: ["step:root-existing"],
          successCriteria: "Done.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      existingSteps: [
        { id: "existing-step", dependsOn: ["root-existing"] },
        { id: "root-existing", dependsOn: [] },
      ],
    }));
    expect(result.ok).toBe(true);
  });

  it("recovery step that reads an existing producer but the chain does not include it fails", () => {
    // retry -> unrelated-existing; reads step:scan (existing producer).
    // No path from retry to scan in the combined DAG.
    const plan: CommanderDagPlan = {
      title: "Unrelated recovery",
      reasoning: "Recovery step depends on something unrelated.",
      steps: [
        {
          id: "retry",
          title: "Retry",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["unrelated-existing"],
          inputContextKeys: ["step:scan"],
          successCriteria: "Done.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      existingSteps: [
        { id: "unrelated-existing", dependsOn: [] },
        { id: "scan", dependsOn: [] },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find((d) => d.code === "CONTEXT_PRODUCER_NOT_DEPENDED_ON");
      expect(diag).toBeDefined();
      expect(diag?.message).toContain("scan");
    }
  });

  it("preloadedContextKeys do not require producers", () => {
    const plan: CommanderDagPlan = {
      title: "Preloaded",
      reasoning: "test",
      steps: [
        {
          id: "step",
          title: "Step",
          assignedAgentKind: "code",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          inputContextKeys: ["userGoal", "taskId"],
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.filter((d) => d.code === "MISSING_CONTEXT_PRODUCER")).toHaveLength(0);
    }
  });

  it("isRepairable returns true for structural errors", () => {
    const plan: CommanderDagPlan = {
      title: "Repairable",
      reasoning: "test",
      steps: [
        { id: "a", title: "A", assignedAgentKind: "code", requiredCapabilities: ["code_search"], dependsOn: ["nonexistent"], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairable).toBe(true);
    }
  });

  it("isRepairable returns false for unknown agent", () => {
    const plan: CommanderDagPlan = {
      title: "Not repairable",
      reasoning: "test",
      steps: [
        { id: "a", title: "A", assignedAgentKind: "totally_unknown", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairable).toBe(false);
    }
  });
  it("rejects git.stageFiles with trim-empty paths entry", () => {
    const plan: CommanderDagPlan = {
      title: "Whitespace path",
      reasoning: "test",
      steps: [
        {
          id: "stage",
          title: "Stage",
          assignedAgentKind: "code",
          toolName: "git.stageFiles",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { paths: ["   "] },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("paths"),
      )).toBe(true);
    }
  });

  it("rejects computer.listDirectory with whitespace-only path", () => {
    const plan: CommanderDagPlan = {
      title: "Whitespace path",
      reasoning: "test",
      steps: [
        {
          id: "list",
          title: "List",
          assignedAgentKind: "computer",
          toolName: "computer.listDirectory",
          requiredCapabilities: ["directory_list"],
          dependsOn: [],
          toolInput: { path: "   " },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("path"),
      )).toBe(true);
    }
  });

  it("rejects git.createPullRequest with whitespace-only baseBranch", () => {
    const plan: CommanderDagPlan = {
      title: "Whitespace base",
      reasoning: "test",
      steps: [
        {
          id: "create-pr",
          title: "Create PR",
          assignedAgentKind: "code",
          toolName: "git.createPullRequest",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { title: "valid", baseBranch: "   " },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("baseBranch"),
      )).toBe(true);
    }
  });
});

describe("compileCommanderPlan - fixture regression", () => {
  it("rejects duplicate-step-id fixture", async () => {
    const fixture = await import("../__fixtures__/duplicate-step-id.json");
    const result = compileCommanderPlan(makeInput({ plan: fixture.default as CommanderDagPlan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "DUPLICATE_STEP_ID")).toBe(true);
    }
  });

  it("rejects missing-dependency fixture", async () => {
    const fixture = await import("../__fixtures__/missing-dependency.json");
    const result = compileCommanderPlan(makeInput({ plan: fixture.default as CommanderDagPlan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_DEPENDENCY")).toBe(true);
    }
  });

  it("rejects cyclic-dependency fixture", async () => {
    const fixture = await import("../__fixtures__/cyclic-dependency.json");
    const result = compileCommanderPlan(makeInput({ plan: fixture.default as CommanderDagPlan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "CYCLIC_DEPENDENCY")).toBe(true);
    }
  });

  it("rejects missing-computer-path fixture at compile time", async () => {
    const fixture = await import("../__fixtures__/missing-computer-path.json");
    const result = compileCommanderPlan(makeInput({ plan: fixture.default as CommanderDagPlan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_TOOL_INPUT")).toBe(true);
    }
  });

  it("rejects missing-context-producer fixture (error now that allowlist is explicit)", async () => {
    const fixture = await import("../__fixtures__/missing-context-producer.json");
    const result = compileCommanderPlan(makeInput({ plan: fixture.default as CommanderDagPlan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "MISSING_CONTEXT_PRODUCER")).toBe(true);
      expect(result.repairable).toBe(true);
    }
  });
});
