import { invoke } from "@tauri-apps/api/core";
import {
  buildCommanderPlanPrompt,
  buildCommanderReplanPrompt,
  buildReActDecisionPrompt,
  CONTEXT_KEYS,
  createChineseReviewPrompt,
  createChineseRevisionPrompt,
  createFileScanTaskRuntime,
  createSharedTaskContext,
  createTaskEventBus,
  getAdapter,
  parseChineseReviewResult,
} from "@javis/core";
import type {
  AgentReActDecision,
  CommanderDagPlan,
  ReActDecisionRequest,
} from "@javis/core";
import { createDefaultAgentRegistry, demoAgents } from "@javis/core";
import type { AgentKind, ModelRequirements, ProviderCapabilities } from "@javis/core";
import type {
  BrowserClickRequest,
  BrowserClickResult,
  BrowserEvaluateRequest,
  BrowserEvaluateResult,
  BrowserGetContentRequest,
  BrowserGetContentResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserRunTestRequest,
  BrowserRunTestResult,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserTypeRequest,
  BrowserTypeResult,
  BrowserExtractLinksRequest,
  BrowserExtractLinksResult,
  BrowserUploadRequest,
  BrowserUploadResult,
  BrowserFollowCandidateLinksRequest,
  BrowserFollowCandidateLinksResult,
  CodeApplyResult,
  CodeProposedEdit,
  CodeReviewPreview,
  ComputerFileCandidate,
  CommanderPlanRequest,
  CommanderPlanResult,
  FileOrganizationExecution,
  FileOrganizationPlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
  WebSourceRequest,
  WebSearchRequest,
  WebSearchResult,
  VerifierCheckRequest,
  VerifierCheckResult,
  VisionAnalyzeResult,
  ScheduledTaskDraft,
  TextFileWritePlan,
  TextFileWriteResult,
  VisionAnalyzeRequest,
  VisionDescribeRequest,
  VisionOcrRequest,
  WorkspaceTool,
  WriteTextFileRequest,
} from "@javis/tools";
import { initialToolDescriptors } from "@javis/tools";
import { parseGitStatusFiles } from "./git-status";
import {
  createConfiguredModelProvider,
  createModelProviderFromProfile,
  type CompletionOptions,
  type CompletionResult,
  type ModelProvider,
} from "./model-provider";
import {
  DEFAULT_AGENT_SLOT,
  type ModelConfiguration,
  type ModelProfile,
  type ModelSettings,
} from "./model-settings";
import { scanUserDocuments, classifyDocuments } from "./local-knowledge";
import { preprocessChineseInput } from "./input-preprocessor";
import {
  createScheduledTask,
} from "./scheduled-tasks";
import type { ScheduledTasksRepository } from "./scheduled-tasks-persistence";
import {
  loadWorkspaceDefinitions,
  saveWorkspaceDefinition,
  deleteWorkspaceDefinition,
} from "./workspace-loader";
import type { WorkspaceDefinition } from "@javis/core";

const WORKSPACE_SCAFFOLD_SCHEMA_JSON = JSON.stringify({
  id: "kebab-case-id",
  title: "Display Title",
  icon: "single-emoji",
  description: "One-line description",
  viewType: "chat",
  sidebarGroup: "custom",
  sidebarOrder: 99,
  version: "0.1.0",
  enabled: true,
  agents: [
    {
      id: "agent-example",
      kind: "commander",
      displayName: "Example Agent",
      description: "What this agent does",
      allowedToolNames: ["commander.plan"],
      modelRequirements: { prefersVision: false, prefersCode: false, minContextTokens: 8000 },
      systemPrompt: { en: "You are...", zhCN: "你是..." },
    },
  ],
  workflows: [
    {
      id: "custom-workflow",
      title: "Custom Workflow",
      triggerExamples: ["do something"],
      goal: "Achieve the goal",
      coordinatorAgentKind: "commander",
      participatingAgentKinds: ["commander"],
      steps: [
        {
          id: "step-1",
          title: "First step",
          agentKind: "commander",
          input: "User goal",
          output: "Result",
          permissionLevel: "read",
          dependsOn: [],
          canRunInParallel: false,
        },
      ],
      currentSupport: "partial",
      safetyNotes: ["Safety note"],
    },
  ],
  routes: [
    {
      routeKind: "custom-route",
      workflowId: "custom-workflow",
      scoring: {
        keywordPatterns: [{ pattern: "keyword", weight: 2, signalName: "match" }],
        threshold: 2,
      },
    },
  ],
}, null, 2);

interface SkillTranslationInput {
  id: string;
  name: string;
  description: string;
  agentOwners: string[];
}

interface SkillTranslationOutput {
  id: string;
  name: string;
  description: string;
  agentOwners?: string[];
}

interface CreateJavisRuntimeOptions {
  getWorkspacePath: () => string;
  modelSettings: ModelSettings;
  getModelConfiguration?: () => ModelConfiguration | undefined;
  getScheduledTasksRepository?: () => ScheduledTasksRepository | null;
}

/**
 * Resolve the ModelProvider for a given agentKind based on ModelConfiguration.
 *
 * Resolution order:
 * 1. Explicit agent override (unchanged — user intent always wins)
 * 2. Capability-aware scoring: cross-references Agent.modelRequirements,
 *    ModelProfile.capabilities, and ProviderAdapter.capabilities
 * 3. DEFAULT_AGENT_SLOT static mapping (backward compat)
 * 4. Fallback to primary / first profile
 */
function resolveModelForAgent(
  agentKind: string,
  config: ModelConfiguration,
  providerCache: Map<string, ModelProvider>,
): ModelProvider {
  // Check explicit override first
  const overrideProfileId = config.agentOverrides[agentKind];
  if (overrideProfileId) {
    const profile = config.profiles.find((p) => p.id === overrideProfileId);
    if (profile) {
      return getOrCreateProvider(profile, providerCache);
    }
  }

  // Capability-aware scoring: only when multiple profiles exist
  const requirements = getDefaultAgentModelRequirements(agentKind);
  if (requirements && config.profiles.length > 1) {
    const scored = config.profiles
      .filter((p) => p.slot !== null)
      .map((profile) => ({
        profile,
        score: scoreProfileForAgent(profile, requirements, agentKind),
      }))
      .filter(({ score }) => score.penalties === 0)
      .sort((a, b) => b.score.total - a.score.total);

    if (scored.length > 0) {
      const best = scored[0];
      if (best.score.warnings.length > 0) {
        console.warn(
          `[resolveModelForAgent] ${agentKind}: using ${best.profile.slot} slot ` +
          `(${best.profile.provider}/${best.profile.model}) — ` +
          best.score.warnings.join("; "),
        );
      }
      return getOrCreateProvider(best.profile, providerCache);
    }

    // No profile satisfies requirements — warn and fall through to defaults
    if (requirements) {
      console.warn(
        `[resolveModelForAgent] ${agentKind}: no profile satisfies ` +
        `prefersVision=${requirements.prefersVision} prefersCode=${requirements.prefersCode}`,
      );
    }
  }

  // DEFAULT_AGENT_SLOT mapping (backward compat)
  const defaultSlot = DEFAULT_AGENT_SLOT[agentKind] ?? "primary";
  const slotProfile = config.profiles.find((p) => p.slot === defaultSlot);
  if (slotProfile) {
    return getOrCreateProvider(slotProfile, providerCache);
  }

  // Fallback to primary or first profile
  const primary = config.profiles.find((p) => p.slot === "primary") ?? config.profiles[0];
  return getOrCreateProvider(primary, providerCache);
}

function getOrCreateProvider(
  profile: ModelProfile,
  cache: Map<string, ModelProvider>,
): ModelProvider {
  let provider = cache.get(profile.id);
  if (!provider) {
    provider = createModelProviderFromProfile(profile);
    cache.set(profile.id, provider);
  }
  return provider;
}

/**
 * Return the capabilities for a given provider adapter.
 * Callers can use this to check `vision`, `code`, `longContext` before
 * selecting a provider for a specific agent kind.
 */
export function getProviderCapabilities(providerId: string): ProviderCapabilities {
  return getAdapter(providerId).capabilities;
}

// ── Capability-aware profile scoring ────────────────────────────────────────

interface ProfileScore {
  total: number;
  penalties: number;
  warnings: string[];
}

function scoreProfileForAgent(
  profile: ModelProfile,
  requirements: ModelRequirements,
  agentKind: string,
): ProfileScore {
  const warnings: string[] = [];
  let total = 0;
  let penalties = 0;

  // Check vision capability
  if (requirements.prefersVision) {
    if (profile.capabilities.vision) {
      total += 2;
    } else {
      warnings.push(
        `profile ${profile.slot} lacks vision but agent ${agentKind} prefers it`,
      );
    }
  }

  // Check code capability
  if (requirements.prefersCode) {
    if (profile.capabilities.code) {
      total += 2;
    } else {
      penalties += 1;
      warnings.push(
        `profile ${profile.slot} lacks code capability but agent ${agentKind} requires it`,
      );
    }
  }

  // Check long context
  if (requirements.minContextTokens > 0) {
    if (profile.capabilities.longContext) {
      total += 1;
    } else if (requirements.minContextTokens > 32000) {
      warnings.push(
        `profile ${profile.slot} may have limited context for agent ${agentKind}`,
      );
    }
  }

  // Cross-reference with ProviderAdapter capabilities
  if (profile.provider) {
    const providerCaps = getProviderCapabilities(profile.provider);
    if (requirements.prefersVision && !providerCaps.vision) {
      penalties += 1;
      warnings.push(
        `provider ${profile.provider} does not support vision for agent ${agentKind}`,
      );
    }
    if (requirements.prefersCode && !providerCaps.code) {
      penalties += 1;
      warnings.push(
        `provider ${profile.provider} does not support code for agent ${agentKind}`,
      );
    }
  }

  // Inertia bonus: prefer the DEFAULT_AGENT_SLOT mapping
  const defaultSlot = DEFAULT_AGENT_SLOT[agentKind];
  if (profile.slot === defaultSlot) {
    total += 0.5;
  }

  return { total, penalties, warnings };
}

let _agentRegistryCache: ReturnType<typeof createDefaultAgentRegistry> | undefined;

function getDefaultAgentModelRequirements(kind: string): ModelRequirements | undefined {
  if (!_agentRegistryCache) {
    _agentRegistryCache = createDefaultAgentRegistry();
  }
  return _agentRegistryCache.getModelRequirements(kind);
}

export function createJavisRuntime({
  getWorkspacePath,
  modelSettings,
  getModelConfiguration,
  getScheduledTasksRepository,
}: CreateJavisRuntimeOptions) {
  const fallbackProvider = createConfiguredModelProvider(modelSettings);
  const providerCache = new Map<string, ModelProvider>();
  // Pre-populate cache with fallback for backward compatibility
  providerCache.set("fallback", fallbackProvider);

  const providerFor = (agentKind: string): ModelProvider => {
    const config = getModelConfiguration?.();
    if (!config) return fallbackProvider;
    return resolveModelForAgent(agentKind, config, providerCache);
  };

  const sharedContext = createSharedTaskContext();
  const eventBus = createTaskEventBus();
  const taskIdRef: { current: string | null } = { current: null };
  const streamingAgentRef: { current: AgentKind } = { current: "commander" };
  const runReadOnlyCommand = (request: ShellCommandRequest) => {
    const workspacePath = getWorkspacePath();
    return invoke<ShellCommandOutput>("run_read_only_command", {
      request: {
        ...request,
        workspacePath: request.workspacePath ?? (workspacePath.trim() || null),
      },
    });
  };

  const runtime = createFileScanTaskRuntime({
    chatTool: {
      complete: (prompt, options) => providerFor("commander").complete(prompt, options),
      stream: (prompt, options) => providerFor("commander").stream(prompt, options),
    },
    commanderTool: {
      plan: async (request) => {
        const taskId = taskIdRef.current ?? "task-unknown";
        streamingAgentRef.current = "commander";
        eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
        try {
          const result = await planWithModelProviderStreaming(
            request,
            providerFor("commander"),
            (chunk) =>
              eventBus.emit({
                kind: "agent.chunk",
                taskId,
                agentKind: "commander",
                text: chunk.text,
              }),
          );
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "commander",
            fullText: result.reasoning,
          });
          return result;
        } catch (error) {
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "commander",
            fullText: "",
            error: String(error),
          });
          throw error;
        }
      },
      synthesize: async (request) => {
        const taskId = taskIdRef.current ?? "task-unknown";
        streamingAgentRef.current = "commander";
        eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "commander" });
        try {
          const evidenceEntries = Object.entries(request.evidence)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join("\n");
          const prompt = [
            "You are Javis Commander Agent.",
            "Write a concise natural-language answer to the user's original goal.",
            "Base your answer ONLY on the evidence collected by the agent team below.",
            "Write in the same language as the user's goal.",
            "Do NOT describe internal processes — speak directly to the user.",
            `User goal: ${request.userGoal}`,
            `Workflow: ${request.workflowTitle}`,
            `Collected evidence:\n${evidenceEntries}`,
          ].join("\n");
          let message: string;
          try {
            const modelProvider = providerFor("commander");
            let fullText = "";
            for await (const chunk of modelProvider.stream(prompt, {
              maxTokens: 800,
              temperature: 0.3,
              locale: "zh-CN",
            })) {
              fullText += chunk.text;
              eventBus.emit({
                kind: "agent.chunk",
                taskId,
                agentKind: "commander",
                text: chunk.text,
              });
            }
            message = fullText.trim();
          } catch {
            // Fallback to non-streaming on stream failure
            const result = await completeWithChineseReview(
              prompt,
              { maxTokens: 800, temperature: 0.3, locale: "zh-CN" },
              providerFor("commander"),
              "none",
            );
            message = result.text.trim();
          }
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "commander",
            fullText: message,
          });
          return { message };
        } catch (error) {
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "commander",
            fullText: "",
            error: String(error),
          });
          throw error;
        }
      },
    },
    fileTool: {
      scanMarkdownDocuments: () => {
        const workspacePath = getWorkspacePath();
        return invoke<MarkdownDocument[]>("scan_markdown_documents", {
          workspacePath: workspacePath.trim() || null,
        });
      },
      planPdfOrganization: (taskId?: string) =>
        invoke<FileOrganizationPlan>("plan_pdf_organization", { taskId }),
      executePdfOrganization: async (
        operations: PlannedPathOperation[],
        approvalId: string,
        taskId?: string,
      ) => {
        await invoke("approve_pdf_organization", { approvalId, taskId });
        return invoke<FileOrganizationExecution>("execute_pdf_organization", {
          request: { approvalId, operations, taskId },
        });
      },
      planWriteText: (request: WriteTextFileRequest, taskId?: string) => {
        const workspacePath = getWorkspacePath();
        return invoke<TextFileWritePlan>("plan_write_text_file", {
          request: {
            ...request,
            workspacePath: workspacePath.trim() || null,
            taskId,
          },
        });
      },
      writeText: async (
        request: WriteTextFileRequest,
        approvalId: string,
        taskId?: string,
      ) => {
        const workspacePath = getWorkspacePath();
        await invoke("approve_write_text_file", { approvalId, taskId });
        return invoke<TextFileWriteResult>("execute_write_text_file", {
          request: {
            approvalId,
            ...request,
            workspacePath: workspacePath.trim() || null,
            taskId,
          },
        });
      },
      classifyDocuments: (files) =>
        classifyDocuments(files, providerFor("file")),
    },
    computerTool: {
      searchLocalDocuments: async ({ query, maxResults = 20 }) => {
        const entries = await scanUserDocuments(undefined, maxResults);
        return entries
          .filter((entry) => matchesLocalDocumentQuery(entry.name, entry.path, query))
          .slice(0, maxResults)
          .map((entry): ComputerFileCandidate => ({
            name: entry.name,
            path: entry.path,
            isDir: entry.isDir,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt,
            extension: entry.extension,
          }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      screenshot: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listWindows: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      focusWindow: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moveMouse: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      click: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keyCombo: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scroll: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wait: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openPath: async (..._args: any[]) => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      approveAction: async (..._args: any[]) => ({} as { approvalId: string; taskId?: string }),
    },
    visionTool: {
      analyze: async (request: VisionAnalyzeRequest) => {
        const imageDataUrl = await resolveImageDataUrl(request.imagePath, getWorkspacePath());
        const question = request.question?.trim();
        const isZh = /[㐀-鿿]/.test(question ?? "");
        const result = await providerFor("vision").complete(
          [
            isZh
              ? "分析图片。返回紧凑 JSON，键名：description, objects, text, answer。"
              : "Analyze the image. Return compact JSON with keys: description, objects, text, answer.",
            isZh
              ? "objects 必须是可见物体标签的数组。"
              : "objects must be an array of visible object labels.",
            question
              ? (isZh ? `问题：${question}` : `Question: ${question}`)
              : (isZh ? "如无具体问题，可省略 answer。" : "If no question is asked, answer should be omitted."),
          ].join("\n"),
          { imageDataUrl, maxTokens: 900, temperature: 0.1 },
        );
        return parseVisionAnalyzeResult(result.text, question);
      },
      describe: async (request: VisionDescribeRequest) => {
        const imageDataUrl = await resolveImageDataUrl(request.imagePath, getWorkspacePath());
        const detail = request.detail === "brief" ? "brief" : "detailed";
        const result = await providerFor("vision").complete(
          `Describe the image in ${detail} terms. Mention only visible details.`,
          { imageDataUrl, maxTokens: detail === "brief" ? 200 : 700, temperature: 0.1 },
        );
        return { description: result.text.trim() };
      },
      extractText: async (request: VisionOcrRequest) => {
        const imageDataUrl = await resolveImageDataUrl(request.imagePath, getWorkspacePath());
        const result = await providerFor("vision").complete(
          [
            "Extract all visible text from the image.",
            request.language ? `Preferred language hint: ${request.language}.` : "",
            "Return only the extracted text. If no text is visible, return an empty string.",
          ].filter(Boolean).join("\n"),
          { imageDataUrl, maxTokens: 900, temperature: 0 },
        );
        return { text: result.text.trim(), confidence: result.text.trim() ? 0.8 : 0 };
      },
    },
    shellTool: {
      runReadOnlyCommand,
    },
    codeTool: {
      inspectRepository: async (): Promise<CodeReviewPreview> => {
        const [status, diffStat, diff] = await Promise.all([
          runReadOnlyCommand({ program: "git", args: ["status", "--short"], workspacePath: null }),
          runReadOnlyCommand({ program: "git", args: ["diff", "--stat"], workspacePath: null }),
          runReadOnlyCommand({ program: "git", args: ["diff", "--unified=1"], workspacePath: null }),
        ]);

        for (const output of [status, diffStat, diff]) {
          if (output.exitCode !== 0) {
            throw new Error(output.stderr || output.stdout || `${output.command} failed`);
          }
        }

        return {
          workspacePath: status.cwd,
          changedFiles: parseGitStatusFiles(status.stdout),
          diffStat: diffStat.stdout,
          diff: diff.stdout,
        };
      },
      proposeEdit: ({ userGoal, preview }) =>
        proposeCodeEditWithModelProvider(userGoal, preview, providerFor("code")),
      applyProposedEdit: (edit: CodeProposedEdit, approval) =>
        invoke("approve_code_patch", {
          request: {
            approvalId: approval.approvalId,
            proposalId: edit.proposalId,
            workspacePath: edit.workspacePath,
            changedFiles: edit.changedFiles,
            patchHash: edit.patchHash,
          },
        }).then(() =>
          invoke<CodeApplyResult>("apply_code_patch", {
            request: {
              approvalId: approval.approvalId,
              proposalId: edit.proposalId,
              workspacePath: edit.workspacePath,
              changedFiles: edit.changedFiles,
              patch: edit.patch,
              patchHash: edit.patchHash,
              baseGitHead: edit.baseGitHead,
            },
          }),
        ),
    },
    projectTool: {
      inspectProject: () => {
        const workspacePath = getWorkspacePath();
        return invoke<ProjectInspection>("inspect_project", {
          workspacePath: workspacePath.trim() || null,
        });
      },
    },
    schedulerTool: {
      createTask: async (draft: ScheduledTaskDraft) => {
        const workspacePath = getWorkspacePath();
        const task = createScheduledTask(
          {
            name: draft.name,
            goal: draft.goal,
            workspacePath: workspacePath.trim(),
            schedule: draft.schedule,
          },
          "agent",
        );
        const repo = getScheduledTasksRepository?.();
        if (repo) {
          await repo.upsert(task);
        }
        return {
          id: task.id,
          name: task.name,
          goal: task.goal,
          schedule: task.schedule,
          nextRunAt: task.nextRunAt,
          enabled: task.enabled,
        };
      },
    },
    workspaceTool: {
      list: async () => {
        const defs = await loadWorkspaceDefinitions();
        return defs.map((d) => ({
          id: d.id,
          title: d.title,
          icon: d.icon,
          description: d.description,
          enabled: d.enabled,
          version: d.version,
        }));
      },
      scaffold: async (description: string) => {
        const commander = providerFor("commander");
        const prompt = [
          "You are creating a Javis workspace definition. Output valid JSON matching this schema:",
          WORKSPACE_SCAFFOLD_SCHEMA_JSON,
          "",
          "Available agent kinds: commander, file, shell, browser, computer, scheduler, research, code, verifier, chinese-reviewer",
          "Available built-in view types: chat, automated, skills, apps, documents, gallery, computer",
          "Sidebar groups: primary (top), knowledge (local data), custom (below)",
          "",
          "Rules:",
          "- Generate a single complete workspace definition JSON object",
          "- id must be kebab-case",
          "- icon should be a single emoji",
          "- agents, workflows, routes are optional arrays",
          "- All tool names follow {category}.{action} pattern",
          "- Output ONLY the JSON, no markdown fences or explanation",
          "",
          `User request: ${description}`,
        ].join("\n");
        const result = await commander.complete(prompt, { maxTokens: 2000, temperature: 0.3 });
        // Extract outermost JSON object (handles LLM text before/after)
        const startIdx = result.text.indexOf("{");
        const endIdx = result.text.lastIndexOf("}");
        if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
          throw new Error("Scaffolded output does not contain valid JSON");
        }
        const jsonStr = result.text.slice(startIdx, endIdx + 1);
        return JSON.parse(jsonStr) as Record<string, unknown>;
      },
      create: async (definition: Record<string, unknown>) => {
        await saveWorkspaceDefinition(definition as unknown as WorkspaceDefinition);
      },
      delete: async (workspaceId: string) => {
        await deleteWorkspaceDefinition(workspaceId);
      },
    } satisfies WorkspaceTool,
    webTool: {
      fetchWebSource: (request: WebSourceRequest) =>
        invoke<WebSource>("fetch_web_source", { request }),
      searchWeb: (request: WebSearchRequest) =>
        invoke<WebSearchResult[]>("search_web_sources", { request }),
    },
    browserTool: {
      navigate: (request: BrowserNavigateRequest) =>
        invoke<BrowserNavigateResult>("browser_navigate", { request }),
      screenshot: (request: BrowserScreenshotRequest) =>
        invoke<BrowserScreenshotResult>("browser_screenshot", { request }),
      getContent: (request: BrowserGetContentRequest) =>
        invoke<BrowserGetContentResult>("browser_get_content", { request }),
      click: (request: BrowserClickRequest) =>
        invoke<BrowserClickResult>("browser_click", { request }),
      type: (request: BrowserTypeRequest) =>
        invoke<BrowserTypeResult>("browser_type", { request }),
      evaluate: (request: BrowserEvaluateRequest) =>
        invoke<BrowserEvaluateResult>("browser_evaluate", { request }),
      runTest: (request: BrowserRunTestRequest) =>
        invoke<BrowserRunTestResult>("browser_run_test", { request }),
      extractLinks: async (request: BrowserExtractLinksRequest): Promise<BrowserExtractLinksResult> => {
        const { selector = "a[href]", maxResults = 50 } = request;
        const safeSelector = JSON.stringify(selector);
        const js = `Array.from(document.querySelectorAll(${safeSelector})).slice(0, ${maxResults}).map(el => ({href: el.href || '', text: (el.textContent || '').trim().slice(0, 200), tag: el.tagName?.toLowerCase(), rel: el.rel || ''}))`;
        const result = await invoke<BrowserEvaluateResult>("browser_evaluate", {
          request: { expression: js },
        });
        if (!result.result) {
          return { links: [], count: 0 };
        }
        const links = (() => { try { return JSON.parse(result.result); } catch { return []; } })();
        return { links, count: links.length };
      },
      upload: async (request: BrowserUploadRequest): Promise<BrowserUploadResult> => {
        const { selector, filePaths } = request;
        const safeSelector = JSON.stringify(selector);
        const files: Array<{ name: string; dataUrl: string }> = [];
        for (const fp of filePaths) {
          try {
            const resolved = await resolveImageDataUrl(fp, getWorkspacePath());
            const name = fp.split(/[/\\]/).pop() ?? "file";
            files.push({ name, dataUrl: resolved });
          } catch {
            // Skip files that can't be resolved
          }
        }
        if (files.length === 0) {
          return { success: false, uploadedCount: 0, message: "No valid files to upload" };
        }
        const filesJson = JSON.stringify(files);
        const js = `(async () => { const input = document.querySelector(${safeSelector}); if (!input) return JSON.stringify({success:false,error:'input not found'}); const dt = new DataTransfer(); const files = ${filesJson}; for (const f of files) { const resp = await fetch(f.dataUrl); const blob = await resp.blob(); const file = new File([blob], f.name, {type: blob.type}); dt.items.add(file); } input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles: true})); input.dispatchEvent(new Event('input', {bubbles: true})); return JSON.stringify({success:true,count:files.length}); })()`;
        const result = await invoke<BrowserEvaluateResult>("browser_evaluate", {
          request: { expression: js },
        });
        if (!result.result) {
          return { success: false, uploadedCount: 0, message: "Browser evaluate returned no result" };
        }
        const parsed = (() => { try { return JSON.parse(result.result); } catch { return {}; } })();
        return {
          success: parsed.success ?? false,
          uploadedCount: parsed.count ?? 0,
          message: parsed.success
            ? `Uploaded ${parsed.count} file(s) to ${selector}`
            : (parsed.error ?? "Upload failed"),
        };
      },
      followCandidateLinks: async (request: BrowserFollowCandidateLinksRequest): Promise<BrowserFollowCandidateLinksResult> => {
        const { candidateLinks, urlPattern, maxFollow = 3 } = request;
        let pattern: RegExp | null = null;
        if (urlPattern) {
          try {
            pattern = new RegExp(urlPattern, "i");
          } catch {
            // Invalid regex — skip pattern filtering and follow all candidates
          }
        }
        const toFollow = candidateLinks
          .filter((link) => link.href && (!pattern || pattern.test(link.href)))
          .slice(0, maxFollow);
        const followed: BrowserFollowCandidateLinksResult["followed"] = [];
        for (const link of toFollow) {
          try {
            const navResult = await invoke<BrowserNavigateResult>("browser_navigate", {
              request: { url: link.href },
            });
            const content = await invoke<BrowserGetContentResult>("browser_get_content", {
              request: { format: "text", maxLength: 1000 },
            });
            followed.push({
              url: link.href,
              title: content.title,
              excerpt: content.content.slice(0, 300),
              status: navResult.status ?? 0,
            });
          } catch {
            // Skip failed navigations
          }
        }
        return { followed, skipped: candidateLinks.length - followed.length };
      },
    },
    verifierTool: {
      check: async (request) => {
        const taskId = taskIdRef.current ?? "task-unknown";
        streamingAgentRef.current = "verifier";
        eventBus.emit({ kind: "agent.chunk_start", taskId, agentKind: "verifier" });
        try {
          const result = await verifyWithModelProviderStreaming(
            request,
            providerFor("verifier"),
            (chunk) =>
              eventBus.emit({
                kind: "agent.chunk",
                taskId,
                agentKind: "verifier",
                text: chunk.text,
              }),
          );
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "verifier",
            fullText: result.summary,
          });
          return result;
        } catch (error) {
          eventBus.emit({
            kind: "agent.chunk_end",
            taskId,
            agentKind: "verifier",
            fullText: "",
            error: String(error),
          });
          throw error;
        }
      },
    },
    eventBus,
    onTaskStarted: (taskId) => {
      taskIdRef.current = taskId;
    },
    // P0-2: LLM-based ReAct decision maker for agent step execution loops
    reactDecideNext: async (request: ReActDecisionRequest): Promise<AgentReActDecision> => {
      const prompt = buildReActDecisionPrompt(request);
      try {
        const result = await providerFor(request.agentKind).complete(prompt, {
          maxTokens: 600,
          temperature: 0,
          locale: "zh-CN",
        });
        const parsed = parseJsonObject(result.text) as Record<string, unknown>;
        const rawStatus = parsed.status as string;
        const status: AgentReActDecision["status"] =
          rawStatus === "continue" || rawStatus === "completed" || rawStatus === "failed"
            ? rawStatus
            : "failed";
        return {
          status,
          toolName: parsed.toolName as string | undefined,
          reason: (parsed.reason as string) ?? "No reason provided.",
          output: parsed.output,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        eventBus.emit({
          kind: "tool.planned",
          taskId: taskIdRef.current ?? "task-unknown",
          toolName: "reactDecideNext",
          detail: `ReAct decision LLM failed, falling back to single-shot: ${msg}`,
        });
        return {
          status: "failed",
          reason: `ReAct decision LLM call failed: ${msg}`,
        };
      }
    },
    // P0-3/P0-4: Commander replan after step failure or askUser clarification
    replanDag: async (
      userGoal: string,
      contextSnapshot: Record<string, unknown>,
      failedStepId?: string,
      failureReason?: string,
    ): Promise<CommanderDagPlan> => {
      const registry = createDefaultAgentRegistry();
      const availableAgents = demoAgents
        .filter((a) => a.kind !== "chinese-reviewer")
        .map((a) => {
          const reg = registry.findByKind(a.kind);
          return {
            kind: a.kind,
            allowedToolNames: a.allowedToolNames,
            capabilities: reg?.capabilityTags ?? [],
          };
        });
      const availableTools = initialToolDescriptors.map((td) => ({
        name: td.name,
        permissionLevel: td.permissionLevel,
        summary: td.summary,
        capabilityTags: [...td.capabilityTags],
        ownerAgentKinds: [...td.ownerAgentKinds],
      }));

      const prompt = buildCommanderReplanPrompt({
        userGoal,
        contextSnapshot,
        failedStepId,
        failureReason,
        availableAgents,
        availableTools,
      });

      try {
        const result = await providerFor("commander").complete(prompt, {
          maxTokens: 1200,
          temperature: 0,
          locale: "zh-CN",
        });
        const parsed = parseJsonObject(result.text) as Record<string, unknown>;
        return {
          title: (parsed.title as string) ?? "Recovery plan",
          reasoning: (parsed.reasoning as string) ?? "",
          steps: (parsed.steps as CommanderDagPlan["steps"]) ?? [],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        eventBus.emit({
          kind: "tool.planned",
          taskId: taskIdRef.current ?? "task-unknown",
          toolName: "commander.replan",
          detail: `Replanning LLM failed, workflow will fail: ${msg}`,
        });
        return { title: "Recovery failed", reasoning: "", steps: [] };
      }
    },
  });

  return {
    ...runtime,
    async translateSkillsToChinese(skills: SkillTranslationInput[]) {
      const provider = providerFor("chinese-reviewer");
      return translateSkillsWithChineseAgent(skills, provider);
    },
    classifyWithFileAgent(
      files: { name: string; path: string; extension?: string; sizeBytes?: number }[],
      options?: { onBatchProgress?: (completed: number, total: number, failed: number) => void; signal?: AbortSignal },
    ) {
      return classifyDocuments(files, providerFor("file"), options);
    },
    clearProviderCache() {
      providerCache.clear();
      providerCache.set("fallback", fallbackProvider);
    },
    start(userGoal: string, options?: Parameters<typeof runtime.start>[1]) {
      void (async () => {
        sharedContext.clear();
        sharedContext.set(sharedContext.resolveKey(CONTEXT_KEYS.USER_GOAL, "zh-CN"), userGoal);
        const result = await preprocessChineseInput(userGoal, providerFor("commander"));
        if (result) {
          sharedContext.set(
            sharedContext.resolveKey(CONTEXT_KEYS.PREPROCESSED_INPUT, "zh-CN"),
            result,
          );
        }
        runtime.start(userGoal, options);
      })();
    },
    stopTask() {
      void invoke("cancel_all_model_streams");
      const taskId = taskIdRef.current;
      if (taskId) {
        eventBus.emit({
          kind: "agent.chunk_end",
          taskId,
          agentKind: streamingAgentRef.current,
          fullText: "",
          error: "cancelled",
        });
      }
    },
    dispose() {
      void invoke("cancel_all_model_streams");
      sharedContext.clear();
      runtime.dispose();
    },
  };
}

function matchesLocalDocumentQuery(name: string, path: string, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}._-]/gu, ""))
    .filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return true;
  }
  const haystack = `${name} ${path}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

const TRANSLATION_BATCH_SIZE = 6;

async function translateSkillsWithChineseAgent(
  skills: SkillTranslationInput[],
  modelProvider: ModelProvider,
): Promise<SkillTranslationOutput[]> {
  if (skills.length === 0) {
    return [];
  }
  if (!modelProvider.settings.apiKeyReference) {
    throw new Error("API key not configured for the translation model. Please set an API key in model settings.");
  }

  // Batch into smaller groups to reduce JSON truncation / parse errors.
  const results: SkillTranslationOutput[] = [];
  for (let i = 0; i < skills.length; i += TRANSLATION_BATCH_SIZE) {
    const batch = skills.slice(i, i + TRANSLATION_BATCH_SIZE);
    const batchResults = await translateSkillBatch(batch, modelProvider);
    results.push(...batchResults);
  }
  return results;
}

async function translateSkillBatch(
  skills: SkillTranslationInput[],
  modelProvider: ModelProvider,
): Promise<SkillTranslationOutput[]> {
  const prompt = buildTranslationPrompt(skills);
  const maxTokens = Math.max(1200, Math.min(5000, skills.length * 90));

  // First attempt
  const response = await modelProvider.complete(prompt, {
    maxTokens,
    temperature: 0.1,
    locale: "zh-CN",
  });

  try {
    return parseSkillTranslationResponse(response.text, skills);
  } catch (firstError) {
    // Retry: send the malformed output back with the error, ask the model to fix it.
    const retryPrompt = [
      prompt,
      "",
      "Your previous response was invalid:",
      firstError instanceof Error ? firstError.message : String(firstError),
      "Here was your previous response:",
      response.text.slice(0, 2000),
      "",
      "Please return ONLY a valid JSON array matching the schema. No explanation, no markdown fences.",
    ].join("\n");

    const retryResponse = await modelProvider.complete(retryPrompt, {
      maxTokens,
      temperature: 0,
      locale: "zh-CN",
    });

    try {
      return parseSkillTranslationResponse(retryResponse.text, skills);
    } catch (retryError) {
      if (skills.length <= 1) {
        throw retryError;
      }
      const midpoint = Math.ceil(skills.length / 2);
      const left = await translateSkillBatch(skills.slice(0, midpoint), modelProvider);
      const right = await translateSkillBatch(skills.slice(midpoint), modelProvider);
      return [...left, ...right];
    }
  }
}

function buildTranslationPrompt(skills: SkillTranslationInput[]): string {
  return [
    "You are Javis ChineseReviewer acting as a Chinese translation agent.",
    "Translate Javis skill display names, descriptions, and agent owner labels into concise Simplified Chinese.",
    "Return ONLY a valid JSON array. No explanation text, no markdown fences, no code blocks.",
    "Preserve every id exactly. Do not add or remove items.",
    "Every array item must include id, name, description, and agentOwners.",
    "If agentOwners is empty, return an empty array for agentOwners.",
    "Keep product/technical terms such as Javis, Agent, MCP, Markdown, URL, PDF, diff, patch, shell, workspace, provider, and API when clearer.",
    "For dotted tool names, translate the displayed name into Chinese but keep the original command in parentheses when useful.",
    "Output schema:",
    '[{"id":"same id","name":"中文名称","description":"中文描述","agentOwners":["中文 Agent 名称"]}]',
    "Skills:",
    JSON.stringify(skills),
  ].join("\n");
}

function parseSkillTranslationResponse(
  text: string,
  source: SkillTranslationInput[],
): SkillTranslationOutput[] {
  for (const raw of collectJsonCandidates(text)) {
    try {
      const result = normalizeSkillTranslationResponse(parseJsonCandidate(raw), source);
      if (result.length > 0 || source.length === 0) {
        return result;
      }
    } catch {
      // Keep trying; model responses can include examples or prose before the real payload.
    }
  }
  throw new Error("Skill translation response must include translations for the requested skills.");
}

function normalizeSkillTranslationResponse(
  rawValue: unknown,
  source: SkillTranslationInput[],
): SkillTranslationOutput[] {
  const value = normalizeTranslationJsonValue(rawValue);
  if (!Array.isArray(value)) {
    throw new Error("Skill translation response must be a JSON array.");
  }
  const sourceById = new Map(source.map((skill) => [skill.id, skill]));
  const canFallbackByIndex = value.length === source.length;
  return value
    .map((item, index) => normalizeSkillTranslationItem(item, index, source, sourceById, canFallbackByIndex))
    .filter((item): item is SkillTranslationOutput => item !== null)
    .filter((item) => item.name || item.description || item.agentOwners?.length);
}

function normalizeSkillTranslationItem(
  item: unknown,
  index: number,
  source: SkillTranslationInput[],
  sourceById: Map<string, SkillTranslationInput>,
  canFallbackByIndex: boolean,
): SkillTranslationOutput | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" && sourceById.has(record.id)
    ? record.id
    : canFallbackByIndex
      ? source[index]?.id
      : undefined;
  if (!id) {
    return null;
  }
  const agentOwners = Array.isArray(record.agentOwners)
    ? record.agentOwners.filter((owner): owner is string => typeof owner === "string")
    : Array.isArray(record.owners)
      ? record.owners.filter((owner): owner is string => typeof owner === "string")
      : undefined;
  return {
    id,
    name: stringOrEmpty(record.name ?? record.title),
    description: stringOrEmpty(record.description ?? record.desc ?? record.summary),
    agentOwners,
  };
}

function normalizeTranslationJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["translations", "skills", "items", "results", "data"]) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }
  return value;
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  candidates.push(...balancedJsonCandidates(text, "[", "]"));
  candidates.push(...balancedJsonCandidates(text, "{", "}"));
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function balancedJsonCandidates(text: string, opening: "[" | "{", closing: "]" | "}"): string[] {
  const candidates: string[] = [];
  for (let start = text.indexOf(opening); start >= 0; start = text.indexOf(opening, start + 1)) {
    const end = findBalancedJsonEnd(text, start, opening, closing);
    if (end >= 0) {
      candidates.push(text.slice(start, end + 1));
    }
  }
  return candidates;
}

function findBalancedJsonEnd(text: string, start: number, opening: "[" | "{", closing: "]" | "}"): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function parseJsonCandidate(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    return JSON.parse(cleaned);
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function streamOrCompleteWithReview<T>(
  prompt: string,
  streamOptions: { maxTokens: number; temperature: number },
  modelProvider: ModelProvider,
  onChunk: (chunk: { text: string }) => void,
  normalize: (value: unknown) => T,
): Promise<T> {
  let fullText: string;

  try {
    fullText = "";
    for await (const chunk of modelProvider.stream(prompt, {
      ...streamOptions,
      locale: "zh-CN",
    })) {
      fullText += chunk.text;
      onChunk(chunk);
    }
  } catch {
    // Provider doesn't support SSE — fall back to non-streaming complete()
    const result = await completeWithChineseReview(
      prompt,
      { ...streamOptions, locale: "zh-CN" },
      modelProvider,
      "terms-only",
    );
    onChunk({ text: result.text });
    return normalize(parseJsonObject(result.text));
  }

  let resultText = fullText;
  try {
    const reviewed = await reviewChineseStyle(
      { text: fullText },
      modelProvider,
      "terms-only",
    );
    resultText = reviewed.text;
  } catch {
    // Fall back to unreviewed text
  }

  return normalize(parseJsonObject(resultText));
}

async function planWithModelProviderStreaming(
  request: CommanderPlanRequest,
  modelProvider: ModelProvider,
  onChunk: (chunk: { text: string }) => void,
): Promise<CommanderPlanResult> {
  // Enrich available agents with capability tags so the Commander can
  // plan by capability rather than hardcoded agent kind.
  const registry = createDefaultAgentRegistry();
  const agentsWithCapabilities = request.availableAgents.map((a) => {
    const reg = registry.findByKind(a.kind);
    return {
      kind: a.kind,
      allowedToolNames: a.allowedToolNames,
      capabilities: reg?.capabilityTags ?? [],
    };
  });

  const prompt = buildCommanderPlanPrompt({
    userGoal: request.userGoal,
    workflowId: request.workflowId ?? "unknown",
    availableAgents: agentsWithCapabilities,
    availableTools: request.availableTools,
  });

  return streamOrCompleteWithReview(
    prompt,
    { maxTokens: 1600, temperature: 0 },
    modelProvider,
    onChunk,
    (value) => normalizeCommanderPlan(value, request),
  );
}

async function verifyWithModelProviderStreaming(
  request: VerifierCheckRequest,
  modelProvider: ModelProvider,
  onChunk: (chunk: { text: string }) => void,
): Promise<VerifierCheckResult> {
  return streamOrCompleteWithReview(
    [
      "You are Javis Verifier Agent. Return JSON only.",
      "Check whether the evidence satisfies the success criteria.",
      "Schema: {\"status\":\"pass|warn|fail\",\"summary\":\"string\",\"detail\":\"string\"}",
      `Step id: ${request.stepId}`,
      `Success criteria: ${request.successCriteria}`,
      `Evidence: ${JSON.stringify(request.evidence)}`,
    ].join("\n"),
    { maxTokens: 900, temperature: 0 },
    modelProvider,
    onChunk,
    (value) => normalizeVerifierCheck(value),
  );
}

async function completeWithChineseReview(
  prompt: string,
  options: CompletionOptions | undefined,
  modelProvider: ModelProvider,
  reviewMode: "full" | "terms-only" | "none",
): Promise<CompletionResult> {
  const result = await modelProvider.complete(prompt, options);
  if (reviewMode === "none" || !options?.locale?.toLowerCase().startsWith("zh")) {
    return result;
  }
  return reviewChineseStyle(result, modelProvider, reviewMode);
}

async function reviewChineseStyle(
  result: CompletionResult,
  modelProvider: ModelProvider,
  reviewMode: "full" | "terms-only",
): Promise<CompletionResult> {
  try {
    const reviewed = parseChineseReviewResult(
      (await modelProvider.complete(createChineseReviewPrompt(result.text, reviewMode), {
        maxTokens: Math.max(700, Math.min(1600, result.text.length + 400)),
        temperature: 0,
        locale: "zh-CN",
      })).text,
    );
    if (!reviewed.score.needs_revision) {
      return { ...result, text: reviewed.text };
    }
    const revised = parseChineseReviewResult(
      (await modelProvider.complete(createChineseRevisionPrompt(reviewed.text, reviewed.score), {
        maxTokens: Math.max(700, Math.min(1600, reviewed.text.length + 400)),
        temperature: 0,
        locale: "zh-CN",
      })).text,
    );
    return { ...result, text: revised.text };
  } catch {
    return result;
  }
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function resolveImageDataUrl(imagePath: string, workspacePath?: string): Promise<string> {
  const trimmed = imagePath.trim();
  if (!trimmed) {
    throw new Error("Image path cannot be empty.");
  }
  if (/^data:image\//i.test(trimmed)) {
    return validateImageDataUrl(trimmed);
  }
  // Resolve relative paths against workspace
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/");
  const resolved = isAbsolute || !workspacePath
    ? trimmed
    : `${workspacePath.replace(/[\\/]$/, "")}/${trimmed}`;
  // Verify containment for workspace-relative paths
  if (workspacePath) {
    const ws = workspacePath.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const target = resolved.replace(/\\/g, "/").toLowerCase();
    if (!target.startsWith(ws + "/") && target !== ws) {
      throw new Error(`Image path is outside the current workspace: ${trimmed}`);
    }
  }
  return invoke<string>("read_image_data_url", { path: resolved });
}

export function validateImageDataUrl(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:image\/(png|jpe?g|webp|gif|bmp|tiff?);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    throw new Error("Image data URL must be a non-empty base64 PNG, JPEG, WebP, GIF, or BMP image.");
  }

  const base64Payload = match[2];
  if (base64Payload.length % 4 !== 0) {
    throw new Error("Image data URL must contain a valid padded base64 payload.");
  }

  const mediaSubtype = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
  return `data:image/${mediaSubtype};base64,${base64Payload}`;
}

function parseVisionAnalyzeResult(text: string, question?: string): VisionAnalyzeResult {
  try {
    const parsed = parseJsonObject(text);
    if (isRecord(parsed)) {
      return {
        description: stringValue(parsed.description, text.trim()),
        objects: Array.isArray(parsed.objects)
          ? parsed.objects.filter((item): item is string => typeof item === "string")
          : [],
        text: typeof parsed.text === "string" ? parsed.text : undefined,
        answer: typeof parsed.answer === "string" ? parsed.answer : undefined,
      };
    }
  } catch {
    // Fall back to free-form model output.
  }
  return {
    description: text.trim(),
    objects: [],
    answer: question ? text.trim() : undefined,
  };
}

function normalizeCommanderPlan(
  value: unknown,
  request: CommanderPlanRequest,
): CommanderPlanResult {
  if (!isRecord(value)) {
    throw new Error("Commander plan response must be a JSON object with title, reasoning, and steps.");
  }
  const steps = Array.isArray(value.steps)
    ? value.steps.filter(isRecord).map((step, index) => normalizeCommanderStep(step, index, request))
    : [];
  return {
    title: stringValue(value.title, "Project workflow plan"),
    reasoning: stringValue(value.reasoning, "Commander prepared a workflow plan."),
    steps,
  };
}

function normalizeCommanderStep(
  step: Record<string, unknown>,
  index: number,
  request: CommanderPlanRequest,
): CommanderPlanResult["steps"][number] {
  const assignedAgentKind = stringValue(step.assignedAgentKind, "commander");
  const toolName = typeof step.toolName === "string" && step.toolName.trim()
    ? step.toolName.trim()
    : undefined;
  if (toolName) {
    validateCommanderStepToolName(assignedAgentKind, toolName, request);
  }
  return {
    id: stringValue(step.id, `step-${index + 1}`),
    title: stringValue(step.title, `Step ${index + 1}`),
    assignedAgentKind,
    toolName,
    requiredCapabilities: Array.isArray(step.requiredCapabilities)
      ? step.requiredCapabilities.filter((c): c is string => typeof c === "string")
      : undefined,
    dependsOn: Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((d): d is string => typeof d === "string")
      : undefined,
    successCriteria: stringValue(step.successCriteria, "Step completed with evidence."),
  };
}

function validateCommanderStepToolName(
  assignedAgentKind: string,
  toolName: string,
  request: CommanderPlanRequest,
): void {
  const agent = request.availableAgents.find((item) => item.kind === assignedAgentKind);
  if (!agent) {
    throw new Error(`Commander plan assigned unknown agent kind ${assignedAgentKind}.`);
  }
  if (!agent.allowedToolNames.includes(toolName)) {
    throw new Error(`Commander plan assigned tool ${toolName} outside ${assignedAgentKind} allowedToolNames.`);
  }
  const descriptor = request.availableTools?.find((item) => item.name === toolName);
  if (!descriptor) {
    throw new Error(`Commander plan assigned unknown tool ${toolName}.`);
  }
  if (!descriptor.ownerAgentKinds.includes(assignedAgentKind)) {
    throw new Error(`Commander plan assigned tool ${toolName} to non-owner agent ${assignedAgentKind}.`);
  }
}

function normalizeVerifierCheck(value: unknown): VerifierCheckResult {
  if (!isRecord(value)) {
    throw new Error("Verifier check response must be an object.");
  }
  const status = value.status === "warn" || value.status === "fail" ? value.status : "pass";
  return {
    status,
    summary: stringValue(value.summary, "Evidence checked."),
    detail: stringValue(value.detail, stringValue(value.summary, "Evidence checked.")),
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function proposeCodeEditWithModelProvider(
  userGoal: string,
  preview: CodeReviewPreview,
  modelProvider: ModelProvider,
): Promise<CodeProposedEdit> {
  return invoke<CodeProposedEdit>("propose_code_edit", {
    request: {
      workspacePath: preview.workspacePath,
      userGoal,
      changedFiles: preview.changedFiles,
      diff: preview.diff,
      providerId: modelProvider.settings.provider,
      model: modelProvider.settings.model,
      apiKeyReference: modelProvider.settings.apiKeyReference,
      baseUrl: modelProvider.settings.baseUrl,
      locale: "zh-CN",
    },
  });
}

// ── Trusted Computer Apps (stub) ──────────────────────────────────────

import type { TrustedComputerApp } from "@javis/tools";

export function loadTrustedComputerApps(): TrustedComputerApp[] {
  return [];
}

export function removeTrustedComputerApp(_title: string): TrustedComputerApp[] {
  return [];
}
