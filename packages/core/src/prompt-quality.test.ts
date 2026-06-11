import { describe, expect, it } from "vitest";
import { buildReActDecisionPrompt } from "./agent-react-decider";
import { demoAgents } from "./agents";
import { buildAgentSystemPrompt, getPromptSectionDefinition } from "./agents/prompt";
import { buildCommanderPlanPrompt } from "./commander-plan-schema";
import { COMPUTER_USE_SYSTEM_PROMPT } from "./computer-use-prompt";
import { COMPUTER_USE_ACTION_TOOL_NAMES } from "./computer-use-types";
import { createClassificationPrompt } from "./file-classifier";
import { buildVisionBridgePrompt } from "./vision-bridge";

const availableAgents = [
  { kind: "commander", allowedToolNames: ["commander.askUser"], capabilities: ["planning"] },
  { kind: "code", allowedToolNames: ["code.inspectRepository"], capabilities: ["code_propose"] },
];

const availableTools = [
  {
    name: "commander.askUser",
    permissionLevel: "read",
    summary: "Ask one clarifying question.",
    capabilityTags: ["clarification"],
    ownerAgentKinds: ["commander"],
  },
];

describe("prompt quality gates", () => {
  const zhBilingualLabelPattern = /\b[A-Z][A-Za-z ]+ \/ [\u4e00-\u9fff]/;

  it("keeps Commander plan prompts under budget and out of full-schema mode", () => {
    const prompt = buildCommanderPlanPrompt({
      userGoal: "我想做一个本地视频壁纸播放器",
      locale: "zh-CN",
      workflowId: "commander-dag",
      availableAgents: [...availableAgents],
      availableTools: [...availableTools],
    });

    expect(prompt.length).toBeLessThan(4_500);
    expect(prompt).toContain("{title:string, reasoning:string, steps:Step[1..12]}");
    expect(prompt).not.toContain('"properties"');
    expect(prompt).not.toContain("Available agents / 可用 Agent");
    expect(prompt).not.toContain("Rules / 规则");
  });

  it("keeps ReAct and agent system prompts within small prompt budgets", () => {
    const reactPrompt = buildReActDecisionPrompt({
      agentKind: "code",
      locale: "zh-CN",
      stepId: "verify-change",
      stepTitle: "验证代码改动",
      userGoal: "修复问题并验证",
      observations: [],
      availableTools: [{ name: "shell.runReadOnlyCommand", summary: "Run read-only shell command", capabilityTags: ["shell_readonly"] }],
    });
    const codePrompt = buildAgentSystemPrompt({ kind: "code", locale: "zh-CN" });

    expect(reactPrompt.length).toBeLessThan(2_800);
    expect(codePrompt.length).toBeLessThan(3_500);
  });

  it("goldens the compact Commander contract and one-shot clarification example", () => {
    const prompt = buildCommanderPlanPrompt({
      userGoal: "Review this project",
      workflowId: "commander-dag",
      availableAgents: [...availableAgents],
      availableTools: [],
    });

    expect(prompt).toContain("Output must match this structure:");
    expect(prompt).toContain("Step={id:kebab-case, title:string, assignedAgentKind:string");
    expect(prompt).toContain("Tiny clarification example:");
    expect(prompt).toContain('"capability":"clarification"');
  });

  it("lints prompt boundaries for locale, trust, and agent-only rules", () => {
    const zhCommander = buildCommanderPlanPrompt({
      userGoal: "检查项目",
      locale: "zh-CN",
      workflowId: "commander-dag",
      availableAgents: [...availableAgents],
      availableTools: [],
    });
    const codePrompt = buildAgentSystemPrompt({ kind: "code", locale: "en" });
    const researchPrompt = buildAgentSystemPrompt({ kind: "research", locale: "en" });

    expect(zhCommander).not.toMatch(/Available agents \/|User goal \/|Rules \//);
    expect(zhCommander).toContain("不是指令");
    expect(codePrompt).toContain("Final reports use changed, verified, failed, skipped, risk");
    expect(researchPrompt).toContain("claim, status, sourceUrl, excerpt");
    expect(buildAgentSystemPrompt({ kind: "commander", locale: "en" })).not.toContain("UI Generation Design Rules");
  });

  it("lints Chinese core prompts against bilingual label drift", () => {
    const commanderPrompt = buildCommanderPlanPrompt({
      userGoal: "检查项目",
      locale: "zh-CN",
      workflowId: "commander-dag",
      availableAgents: [...availableAgents],
      availableTools: [],
    });
    const reactPrompt = buildReActDecisionPrompt({
      agentKind: "code",
      locale: "zh-CN",
      stepId: "verify-change",
      stepTitle: "验证代码改动",
      userGoal: "修复问题并验证",
      observations: [
        { iteration: 1, toolName: "shell.runReadOnlyCommand", status: "failed" as const, output: undefined, error: "fixture" },
      ],
      availableTools: [{ name: "shell.runReadOnlyCommand", summary: "Run read-only shell command", capabilityTags: ["shell_readonly"] }],
    });
    const agentPrompt = buildAgentSystemPrompt({
      kind: "code",
      locale: "zh-CN",
      includeUiDesignRules: true,
      runtimeContext: "运行时上下文",
    });

    expect(commanderPrompt).not.toMatch(zhBilingualLabelPattern);
    expect(reactPrompt).not.toMatch(zhBilingualLabelPattern);
    expect(agentPrompt).not.toMatch(zhBilingualLabelPattern);
    expect(agentPrompt).not.toMatch(/## (Core Rules|Output Contract|Tool Rules|Collaboration Rules|UI Generation Design Rules|Runtime Context)/);
  });

  it("keeps agent-only policy text out of unrelated agent prompts", () => {
    const commanderPrompt = buildAgentSystemPrompt({ kind: "commander", locale: "en" });
    const browserPrompt = buildAgentSystemPrompt({ kind: "browser", locale: "en" });
    const researchPrompt = buildAgentSystemPrompt({ kind: "research", locale: "en" });
    const codePrompt = buildAgentSystemPrompt({ kind: "code", locale: "en" });

    expect(commanderPrompt).not.toContain("claim, status, sourceUrl, excerpt");
    expect(commanderPrompt).not.toContain("currentOrigin, targetOrigin");
    expect(commanderPrompt).not.toContain("changed, verified, failed, skipped, risk");
    expect(browserPrompt).toContain("currentOrigin, targetOrigin");
    expect(researchPrompt).toContain("claim, status, sourceUrl, excerpt");
    expect(codePrompt).toContain("changed, verified, failed, skipped, risk");
  });

  it("keeps anti-fabrication evidence rules in core and sidecar prompts", () => {
    const zhAgentPrompt = buildAgentSystemPrompt({ kind: "commander", locale: "zh-CN" });
    const enAgentPrompt = buildAgentSystemPrompt({ kind: "commander", locale: "en" });
    const classificationPrompt = createClassificationPrompt([
      { name: "mystery.bin", path: "E:/Javis/mystery.bin", extension: "bin" },
    ]);
    const visionPrompt = buildVisionBridgePrompt("What is shown?");

    expect(zhAgentPrompt).toContain("不要把推测写成事实");
    expect(enAgentPrompt).toContain("never present guesses as facts");
    expect(classificationPrompt).toContain("if unclear, choose 其他 with low confidence");
    expect(visionPrompt).toContain("write unknown for unclear details");
  });

  it("keeps JSON repair discipline compact in agent prompts", () => {
    const disallowedRepairDrift = /补充事实|推断事实|add facts|infer facts/i;

    for (const prompt of [
      buildAgentSystemPrompt({ kind: "commander", locale: "zh-CN" }),
      buildAgentSystemPrompt({ kind: "commander", locale: "en" }),
    ]) {
      expect(prompt).not.toMatch(disallowedRepairDrift);
    }
  });

  it("keeps Computer Use prompts on fully qualified tool names", () => {
    for (const prompt of [COMPUTER_USE_SYSTEM_PROMPT.en, COMPUTER_USE_SYSTEM_PROMPT.zhCN]) {
      for (const toolName of COMPUTER_USE_ACTION_TOOL_NAMES) {
        expect(prompt).toContain(toolName);
      }
    }

    expect(COMPUTER_USE_SYSTEM_PROMPT.en).not.toContain("Tools: computer.screenshot, listWindows");
    expect(COMPUTER_USE_SYSTEM_PROMPT.zhCN).not.toContain("工具：computer.screenshot、listWindows");
  });

  it("keeps agent-only prompt sections registered outside the global prompt path", () => {
    expect(getPromptSectionDefinition("ui_design_rules")?.scope).toBe("opt_in");
    expect(getPromptSectionDefinition("research_evidence_schema")).toMatchObject({
      scope: "agent_only",
      agentKinds: ["research"],
    });
    expect(getPromptSectionDefinition("browser_origin_policy")).toMatchObject({
      scope: "agent_only",
      agentKinds: ["browser"],
    });
    expect(getPromptSectionDefinition("code_verification_report")).toMatchObject({
      scope: "agent_only",
      agentKinds: ["code"],
    });
  });

  it("keeps every built-in agent prompt focused and non-empty in both locales", () => {
    for (const agent of demoAgents) {
      expect(agent.systemPrompt.en.trim()).not.toBe("");
      expect(agent.systemPrompt.zhCN.trim()).not.toBe("");
      expect(agent.systemPrompt.en.length).toBeLessThan(900);
      expect(agent.systemPrompt.zhCN.length).toBeLessThan(900);
    }
  });
});
