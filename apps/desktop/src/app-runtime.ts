import { invoke } from "@tauri-apps/api/core";
import {
  CONTEXT_KEYS,
  createChineseReviewPrompt,
  createChineseRevisionPrompt,
  createFileScanTaskRuntime,
  createSharedTaskContext,
  createTaskEventBus,
  getAdapter,
  parseChineseReviewResult,
} from "@javis/core";
import { createDefaultAgentRegistry } from "@javis/core";
import type { AgentKind, ModelRequirements, ProviderCapabilities } from "@javis/core";
import type {
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
  ScheduledTaskDraft,
} from "@javis/tools";
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
          const result = await completeWithChineseReview(
            prompt,
            { maxTokens: 800, temperature: 0.3, locale: "zh-CN" },
            providerFor("commander"),
            "none",
          );
          const message = result.text.trim();
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
    webTool: {
      fetchWebSource: (request: WebSourceRequest) =>
        invoke<WebSource>("fetch_web_source", { request }),
      searchWeb: (request: WebSearchRequest) =>
        invoke<WebSearchResult[]>("search_web_sources", { request }),
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
  });

  return {
    ...runtime,
    clearProviderCache() {
      providerCache.clear();
      providerCache.set("fallback", fallbackProvider);
    },
    start(userGoal: string) {
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
        runtime.start(userGoal);
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

  return streamOrCompleteWithReview(
    [
      "You are Javis Commander Agent. Return JSON only.",
      "Plan the selected workflow using the available agents and tools.",
      "Prefer matching steps to agents by their capability tags rather than agent kind.",
      "When setting requiredCapabilities, use tags from the agent's capabilities list.",
      "Schema: {\"title\":\"string\",\"reasoning\":\"string\",\"steps\":[{\"id\":\"string\",\"title\":\"string\",\"assignedAgentKind\":\"string\",\"requiredCapabilities\":[\"string\"],\"successCriteria\":\"string\"}]}",
      `User goal: ${request.userGoal}`,
      `Workflow id: ${request.workflowId ?? "unknown"}`,
      `Available agents: ${JSON.stringify(agentsWithCapabilities)}`,
    ].join("\n"),
    { maxTokens: 1200, temperature: 0 },
    modelProvider,
    onChunk,
    (value) => normalizeCommanderPlan(value),
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

function normalizeCommanderPlan(value: unknown): CommanderPlanResult {
  if (!isRecord(value)) {
    throw new Error("Commander plan response must be an object.");
  }
  const steps = Array.isArray(value.steps)
    ? value.steps.filter(isRecord).map((step, index) => ({
        id: stringValue(step.id, `step-${index + 1}`),
        title: stringValue(step.title, `Step ${index + 1}`),
        assignedAgentKind: stringValue(step.assignedAgentKind, "commander"),
        requiredCapabilities: Array.isArray(step.requiredCapabilities)
          ? step.requiredCapabilities.filter((c): c is string => typeof c === "string")
          : undefined,
        successCriteria: stringValue(step.successCriteria, "Step completed with evidence."),
      }))
    : [];
  return {
    title: stringValue(value.title, "Project workflow plan"),
    reasoning: stringValue(value.reasoning, "Commander prepared a workflow plan."),
    steps,
  };
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
