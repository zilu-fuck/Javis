import { describe, expect, it } from "vitest";
import { compileCommanderPlan } from "../commander-plan-compiler";
import type { CommanderDagPlan } from "../../commander-plan-schema";
import type { ToolDescriptor } from "@javis/tools";
import type { CompileCommanderPlanInput } from "../commander-plan-compiler";
import { DEFAULT_PRELOADED_CONTEXT_KEYS } from "../../shared-context";

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
      {
        kind: "code",
        allowedToolNames: [
          "code.inspectRepository",
          "code.searchRepository",
          "shell.runReadOnlyCommand",
          "git.stageFiles",
          "git.createCommit",
          "git.createPullRequest",
          "git.commentPullRequest",
        ],
      },
      { kind: "file", allowedToolNames: ["file.scanMarkdownDocuments", "file.writeText", "file.executePdfOrganization"] },
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
      makeToolDescriptor("shell.runReadOnlyCommand", {
        capabilityTags: ["shell_readonly"],
        ownerAgentKinds: ["shell", "code"],
        requiredInputs: [
          { name: "program", type: "string", nonEmpty: true },
          { name: "args", type: "string[]", nonEmpty: true },
        ],
      }),
      makeToolDescriptor("file.scanMarkdownDocuments", { capabilityTags: ["file_scan"], ownerAgentKinds: ["file", "verifier"] }),
      makeToolDescriptor("file.writeText", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["file_execute"],
        ownerAgentKinds: ["file"],
        requiredInputs: [
          { name: "targetPath", type: "string", nonEmpty: true },
          { name: "content", type: "string" },
        ],
      }),
      makeToolDescriptor("file.executePdfOrganization", {
        permissionLevel: "confirmed_write",
        capabilityTags: ["file_execute"],
        ownerAgentKinds: ["file"],
      }),
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
    supportedApprovalGatedTools: ["git.stageFiles", "git.createCommit", "git.createPullRequest", "git.commentPullRequest", "file.writeText"],
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
        { id: "step", title: "Step", assignedAgentKind: "file", toolName: "file.executePdfOrganization", requiredCapabilities: [], dependsOn: [], successCriteria: "." },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === "UNSUPPORTED_APPROVAL_GATED_TOOL")).toBe(true);
    }
  });

  it("accepts file.writeText when it has a target path and upstream context input", () => {
    const plan: CommanderDagPlan = {
      title: "Write evidence",
      reasoning: "test",
      steps: [
        {
          id: "collect",
          title: "Collect evidence",
          assignedAgentKind: "research",
          toolName: "web.search",
          requiredCapabilities: ["web_search"],
          dependsOn: [],
          toolInput: { query: "latest topic" },
          outputContextKey: "researchEvidence",
          successCriteria: ".",
        },
        {
          id: "write",
          title: "Write report",
          assignedAgentKind: "file",
          toolName: "file.writeText",
          requiredCapabilities: [],
          dependsOn: ["collect"],
          inputContextKeys: ["researchEvidence"],
          toolInput: { targetPath: "report.md" },
          outputContextKey: "writeResult",
          successCriteria: ".",
        },
        {
          id: "verify",
          title: "Verify report",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["write"],
          inputContextKeys: ["writeResult"],
          successCriteria: "The report write is verified.",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("rejects file.writeText content without an explicit value or producer artifact", () => {
    const plan: CommanderDagPlan = {
      title: "Write unsupported content",
      reasoning: "test",
      steps: [{
        id: "write",
        title: "Write report",
        assignedAgentKind: "file",
        toolName: "file.writeText",
        requiredCapabilities: [],
        dependsOn: [],
        toolInput: { targetPath: "report.md" },
        successCriteria: "The report is written.",
      }],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (diagnostic) => diagnostic.code === "MISSING_TOOL_INPUT" && diagnostic.path?.endsWith(".content"),
      )).toBe(true);
    }
  });

  it("marks capability-only approval-gated steps with a repairable tool-selection diagnostic", () => {
    const plan: CommanderDagPlan = {
      title: "Ambiguous write",
      reasoning: "test",
      steps: [
        {
          id: "write",
          title: "Write output",
          assignedAgentKind: "file",
          capability: "file_execute",
          requiredCapabilities: [],
          dependsOn: [],
          toolInput: { targetPath: "report.md" },
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diag = result.diagnostics.find((d) => d.code === "MISSING_APPROVAL_TOOL_SELECTION");
      expect(diag?.message).toContain("no explicit toolName");
      expect(diag?.suggestedFix).toContain("toolName");
      expect(result.repairable).toBe(true);
    }
  });

  it("rejects toolInput that violates a governed input schema", () => {
    const plan = validPlan();
    plan.steps[0].toolInput = {
      goal: "find tool registry",
      maxAttempts: 0,
      typo: true,
    };
    const input = makeInput({ plan });
    input.availableTools = input.availableTools.map((tool) =>
      tool.name === "code.searchRepository"
        ? {
            ...tool,
            inputSchema: {
              type: "object",
              properties: {
                goal: { type: "string", minLength: 1 },
                maxAttempts: { type: "integer", minimum: 1, maximum: 20 },
              },
              required: ["goal"],
              additionalProperties: false,
            },
          }
        : tool
    );

    const result = compileCommanderPlan(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_TOOL_INPUT",
          message: expect.stringMatching(/undeclared field|greater than or equal/u),
        }),
      ]));
    }
  });

  it("retains non-empty input checks alongside governed schemas", () => {
    const plan = validPlan();
    plan.steps[0].toolInput = { goal: " " };
    const input = makeInput({ plan });
    input.availableTools = input.availableTools.map((tool) =>
      tool.name === "code.searchRepository"
        ? {
            ...tool,
            inputSchema: {
              type: "object",
              properties: { goal: { type: "string", minLength: 1, pattern: "\\S" } },
              required: ["goal"],
              additionalProperties: false,
            },
          }
        : tool
    );

    const result = compileCommanderPlan(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_TOOL_INPUT",
          path: "steps[0].toolInput",
          message: expect.stringContaining(".goal"),
        }),
      ]));
    }
  });

  it("normalizes legacy Browser Agent steps to Page Agent", () => {
    const plan: CommanderDagPlan = {
      title: "Legacy browser plan",
      reasoning: "Loaded from persisted history.",
      steps: [{
        id: "open-page",
        title: "Open page",
        assignedAgentKind: "browser",
        toolName: "browser.navigate",
        capability: "browser_navigate",
        requiredCapabilities: ["browser_navigate"],
        dependsOn: [],
        toolInput: { url: "https://example.com" },
        successCriteria: "Page loaded.",
      }],
    };
    const input = makeInput({ plan });
    const result = compileCommanderPlan({
      ...input,
      availableAgents: [
        ...input.availableAgents,
        { kind: "page-agent", allowedToolNames: ["browser.navigate"], capabilities: ["browser_navigate"] },
      ],
      availableTools: [
        ...input.availableTools,
        makeToolDescriptor("browser.navigate", {
          capabilityTags: ["browser_navigate"],
          ownerAgentKinds: ["page-agent"],
          requiredInputs: [{ name: "url", type: "string", nonEmpty: true }],
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.steps[0]?.assignedAgentKind).toBe("page-agent");
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

  it("compiles boolean[] tool inputs and rejects string coercion", () => {
    const availableAgents = [{ kind: "file", allowedToolNames: ["mcp.search.flags"] }];
    const availableTools = [makeToolDescriptor("mcp.search.flags", {
      capabilityTags: ["local_search"],
      ownerAgentKinds: ["file"],
      requiredInputs: [{ name: "flags", type: "boolean[]", nonEmpty: true }],
    })];
    const createPlan = (flags: unknown): CommanderDagPlan => ({
      title: "Typed MCP input",
      reasoning: "test",
      steps: [{
        id: "search",
        title: "Search with flags",
        assignedAgentKind: "file",
        toolName: "mcp.search.flags",
        requiredCapabilities: ["local_search"],
        dependsOn: [],
        toolInput: { flags },
        successCriteria: "Search completed.",
      }],
    });

    expect(compileCommanderPlan(makeInput({
      plan: createPlan([true, false]),
      availableAgents,
      availableTools,
    })).ok).toBe(true);

    const invalid = compileCommanderPlan(makeInput({
      plan: createPlan(["true"]),
      availableAgents,
      availableTools,
    }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.diagnostics.some(
        (diagnostic) => diagnostic.code === "MISSING_TOOL_INPUT" && diagnostic.path?.includes("flags"),
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
          id: "collect",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "evidence",
          successCriteria: "Evidence is collected.",
        },
        {
          id: "verify",
          title: "Verify evidence",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect"],
          inputContextKeys: ["evidence"],
          successCriteria: "Evidence is sufficient.",
        },
        {
          id: "synth",
          title: "Synthesize",
          assignedAgentKind: "commander",
          requiredCapabilities: ["synthesis"],
          dependsOn: ["verify"],
          inputContextKeys: ["evidence"],
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
          id: "collect",
          title: "Collect evidence",
          assignedAgentKind: "code",
          toolName: "code.searchRepository",
          requiredCapabilities: ["code_search"],
          dependsOn: [],
          outputContextKey: "evidence",
          successCriteria: "Evidence is collected.",
        },
        {
          id: "verify",
          title: "Verify evidence",
          assignedAgentKind: "verifier",
          requiredCapabilities: ["evidence_check"],
          dependsOn: ["collect"],
          inputContextKeys: ["evidence"],
          successCriteria: "Evidence is sufficient.",
        },
        {
          id: "synth",
          title: "Synthesize",
          assignedAgentKind: "commander",
          toolName: "commander.synthesize",
          requiredCapabilities: ["synthesis"],
          dependsOn: ["verify"],
          inputContextKeys: ["evidence"],
          executionMode: "direct_response",
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(true);
  });

  it("rejects commander.synthesize with direct_tool_call", () => {
    const plan: CommanderDagPlan = {
      title: "Unsafe synthesis dispatch",
      reasoning: "test",
      steps: [{
        id: "synth",
        title: "Synthesize",
        assignedAgentKind: "commander",
        toolName: "commander.synthesize",
        requiredCapabilities: ["synthesis"],
        dependsOn: [],
        executionMode: "direct_tool_call",
        successCriteria: ".",
      }],
    };

    const result = compileCommanderPlan(makeInput({ plan }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((item) =>
        item.code === "INVALID_EXECUTION_MODE" && item.stepId === "synth"
      );
      expect(diagnostic?.message).toContain("evidence guard");
      expect(diagnostic?.suggestedFix).toContain("direct_response");
    }
  });

  it("rejects direct_tool_call for an agent role capability", () => {
    const plan: CommanderDagPlan = {
      title: "Review documentation",
      reasoning: "Use the documentation agent role.",
      steps: [{
        id: "review-docs",
        title: "Review documentation",
        assignedAgentKind: "doc-updater",
        capability: "doc_update",
        requiredCapabilities: ["doc_update"],
        dependsOn: [],
        executionMode: "direct_tool_call",
        successCriteria: "Documentation findings are reported.",
      }],
    };
    const result = compileCommanderPlan(makeInput({
      plan,
      availableAgents: [
        ...makeInput({ plan }).availableAgents,
        {
          kind: "doc-updater",
          allowedToolNames: ["file.scanMarkdownDocuments"],
          capabilities: ["doc_update"],
        },
      ],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((item) =>
        item.code === "INVALID_EXECUTION_MODE" && item.stepId === "review-docs"
      );
      expect(diagnostic?.message).toContain("role capability");
      expect(diagnostic?.suggestedFix).toContain("react");
      expect(result.repairable).toBe(true);
    }
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

  it("requires a verifier when evidence is published and consumed by synthesis", () => {
    const plan: CommanderDagPlan = {
      title: "Evidence without verifier",
      reasoning: "The worker output must be checked before completion.",
      steps: [{
        id: "scan",
        title: "Scan",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        outputContextKey: "evidence",
        successCriteria: "Evidence is collected.",
      }, {
        id: "answer",
        title: "Answer",
        assignedAgentKind: "commander",
        requiredCapabilities: ["synthesis"],
        dependsOn: ["scan"],
        inputContextKeys: ["evidence"],
        executionMode: "direct_response",
        successCriteria: "The evidence-backed answer is shown to the user.",
      }],
    };

    const result = compileCommanderPlan(makeInput({ plan }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "MISSING_VERIFIER")).toBe(true);
    }
  });

  it("allows user-visible synthesis that has no evidence input", () => {
    const plan: CommanderDagPlan = {
      title: "Synthesis without verifier",
      reasoning: "A final response must be evidence-gated.",
      steps: [{
        id: "answer",
        title: "Answer",
        assignedAgentKind: "commander",
        requiredCapabilities: ["synthesis"],
        dependsOn: [],
        executionMode: "direct_response",
        successCriteria: "The user receives a grounded answer.",
      }],
    };

    const result = compileCommanderPlan(makeInput({ plan }));

    expect(result.ok).toBe(true);
  });

  it("allows worker-only plans because runtime provenance verification gates implicit synthesis", () => {
    const plan: CommanderDagPlan = {
      title: "Implicit synthesis without verifier",
      reasoning: "The runtime would synthesize the worker result after the DAG.",
      steps: [{
        id: "scan",
        title: "Scan",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        successCriteria: "Repository evidence is collected.",
      }],
    };

    const result = compileCommanderPlan(makeInput({
      plan,
      availableTools: makeInput({ plan }).availableTools.filter((tool) => tool.name !== "verifier.check"),
    }));

    expect(result.ok).toBe(true);
  });

  it("rejects a verifier that only consumes preloaded context", () => {
    const plan: CommanderDagPlan = {
      title: "Verifier without handoff",
      reasoning: "The verifier must inspect a producer artifact.",
      steps: [{
        id: "verify",
        title: "Verify",
        assignedAgentKind: "verifier",
        requiredCapabilities: ["evidence_check"],
        dependsOn: [],
        inputContextKeys: ["userGoal"],
        successCriteria: "Evidence passes verification.",
      }],
    };

    const result = compileCommanderPlan(makeInput({ plan }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "VERIFIER_MISSING_EVIDENCE")).toBe(true);
    }
  });

  it("accepts a verifier that consumes a non-preloaded producer artifact", () => {
    const plan: CommanderDagPlan = {
      title: "Evidence with verifier",
      reasoning: "The verifier consumes the worker handoff.",
      steps: [{
        id: "scan",
        title: "Scan",
        assignedAgentKind: "code",
        toolName: "code.searchRepository",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        outputContextKey: "evidence",
        successCriteria: "Evidence is collected.",
      }, {
        id: "verify",
        title: "Verify",
        assignedAgentKind: "verifier",
        requiredCapabilities: ["evidence_check"],
        dependsOn: ["scan"],
        inputContextKeys: ["evidence"],
        successCriteria: "Evidence passes verification.",
      }],
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

  it("does not treat schema-known output artifacts as preloaded runtime context", () => {
    const plan: CommanderDagPlan = {
      title: "Unproduced artifact",
      reasoning: "test",
      steps: [{
        id: "review",
        title: "Review diff",
        assignedAgentKind: "code",
        requiredCapabilities: ["code_search"],
        dependsOn: [],
        inputContextKeys: ["diffPreview"],
        successCriteria: "Diff reviewed.",
      }],
    };

    expect(DEFAULT_PRELOADED_CONTEXT_KEYS).not.toContain("diffPreview");
    const result = compileCommanderPlan(makeInput({
      plan,
      preloadedContextKeys: [...DEFAULT_PRELOADED_CONTEXT_KEYS],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_CONTEXT_PRODUCER",
          stepId: "review",
        }),
      ]));
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

  it("rejects shell.runReadOnlyCommand without explicit program and args", () => {
    const plan: CommanderDagPlan = {
      title: "Missing shell input",
      reasoning: "test",
      steps: [
        {
          id: "get-date",
          title: "Get current date",
          assignedAgentKind: "code",
          toolName: "shell.runReadOnlyCommand",
          requiredCapabilities: ["shell_readonly"],
          dependsOn: [],
          toolInput: {},
          successCriteria: ".",
        },
      ],
    };
    const result = compileCommanderPlan(makeInput({ plan }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("program"),
      )).toBe(true);
      expect(result.diagnostics.some(
        (d) => d.code === "MISSING_TOOL_INPUT" && d.path?.includes("args"),
      )).toBe(true);
      expect(result.repairable).toBe(true);
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
