import { invoke } from "@tauri-apps/api/core";
import { openPath as openNativePath } from "@tauri-apps/plugin-opener";
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
  DEFAULT_COMPUTER_USE_CONFIG,
  getAdapter,
  isValidCapabilityTag,
  normalizePromptLocale,
  parseChineseReviewResult,
} from "@javis/core";
import type {
  AgentReActDecision,
  AgentCapabilityVerificationInput,
  CommanderDagPlan,
  ComputerUseLoopConfig,
  GoalDecision,
  GoalState,
  ReActDecisionRequest,
  RuntimeExecutionConfig,
  TaskSnapshot,
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
  CodeRepositorySearchResult,
  CodeReviewPreview,
  ComputerClickRequest,
  ComputerClickResult,
  ComputerDetectUiObjectsRequest,
  ComputerDetectUiObjectsResult,
  ComputerFileCandidate,
  ComputerFocusWindowRequest,
  ComputerFocusWindowResult,
  ComputerInspectUiRequest,
  ComputerInspectUiResult,
  ComputerInvokeUiRequest,
  ComputerInvokeUiResult,
  ComputerKeyComboRequest,
  ComputerKeyComboResult,
  ComputerListWindowsRequest,
  ComputerListWindowsResult,
  ComputerMoveMouseRequest,
  ComputerMoveMouseResult,
  ComputerScreenshotRequest,
  ComputerScreenshotResult,
  ComputerScrollRequest,
  ComputerScrollResult,
  ComputerSetUiValueRequest,
  ComputerSetUiValueResult,
  ComputerTypeRequest,
  ComputerTypeResult,
  ComputerUseApprovalRequest,
  ComputerUseApprovalResult,
  ComputerWaitRequest,
  ComputerWaitResult,
  AskUserChoice,
  CommanderPlanRequest,
  CommanderPlanResult,
  FileOrganizationExecution,
  FileOrganizationPlan,
  GitCommitExecutionResult,
  GitCommitPlan,
  GitCommentPullRequestExecutionResult,
  GitCommentPullRequestPlan,
  GitCreatePullRequestExecutionResult,
  GitCreatePullRequestPlan,
  GitStageExecutionResult,
  GitStagePlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
  WebSourceRequest,
  WebSearchRequest,
  WebSearchResult,
  TrendHotListResult,
  MemorySearchRequest,
  MemorySearchResult,
  McpCallRequest,
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
  ToolDescriptor,
} from "@javis/tools";
import { initialToolDescriptors, isDisabledBrowserWriteToolName } from "@javis/tools";
import { parseGitStatusFiles } from "./git-status";
import {
  createLocalTextSemanticReranker,
  resolveModuleSpecifierWithFileSearch,
  searchRepositoryWithFileSearch,
  traceCallChainWithFileSearch,
} from "./repo-intelligence-service";
import { fetchTrendHotList } from "./trending-service";
import {
  createConfiguredModelProvider,
  createModelProviderFromProfile,
  type CompletionOptions,
  type CompletionResult,
  type ModelProvider,
} from "./model-provider";
import type { SkillContextSelectionRequest } from "./skill-context";
import {
  DEFAULT_AGENT_SLOT,
  type ModelConfiguration,
  type ModelProfile,
  type ModelSettings,
} from "./model-settings";
import {
  listDirectory,
  scanInstalledApps,
  scanUserDocuments,
  scanUserImages,
  classifyDocuments,
  classifyApps,
} from "./local-knowledge";
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
import { runComputerUseLoop } from "./computer-use-loop";
import { preprocessChineseInput, type PreprocessedInput } from "./input-preprocessor";
import {
  createBrowserWriteExecutionAuditRecord,
  createBrowserWriteFailedAuditRecord,
  createBrowserWritePlanAuditRecord,
  type BrowserWriteAction,
  type BrowserWriteExecutionResult,
  type BrowserWritePlanResult,
} from "./browser-audit";
import type { ToolCallAuditRecord } from "./tool-call-audit";

function normalizeAvailableToolDescriptors(
  toolDescriptors: readonly ToolDescriptor[] | undefined,
): ToolDescriptor[] {
  const source = toolDescriptors ?? initialToolDescriptors;
  const seen = new Set<string>();
  const normalized: ToolDescriptor[] = [];
  for (const descriptor of source) {
    if (seen.has(descriptor.name) || isDisabledBrowserWriteToolName(descriptor.name)) {
      continue;
    }
    seen.add(descriptor.name);
    normalized.push(descriptor);
  }
  return normalized;
}

function commanderPromptToolDescriptors(toolDescriptors: readonly ToolDescriptor[] | undefined) {
  return limitMcpPromptToolDescriptors(normalizeAvailableToolDescriptors(toolDescriptors)).map((descriptor) => ({
    name: descriptor.name,
    permissionLevel: descriptor.permissionLevel,
    summary: descriptor.summary,
    capabilityTags: descriptor.capabilityTags,
    ownerAgentKinds: descriptor.ownerAgentKinds,
  }));
}

const MAX_MCP_PROMPT_SUBTOOLS = 80;
const MAX_MCP_PROMPT_SUBTOOLS_PER_SERVER = 12;

function limitMcpPromptToolDescriptors(toolDescriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  const output: ToolDescriptor[] = [];
  const mcpSubtools: ToolDescriptor[] = [];
  for (const descriptor of toolDescriptors) {
    if (isMcpPromptSubtoolDescriptor(descriptor)) {
      mcpSubtools.push(descriptor);
    } else {
      output.push(descriptor);
    }
  }
  const perServerCount = new Map<string, number>();
  const selectedSubtools = mcpSubtools
    .sort(compareMcpPromptToolDescriptors)
    .filter((descriptor) => {
      const serverKey = mcpPromptServerKey(descriptor);
      const count = perServerCount.get(serverKey) ?? 0;
      if (count >= MAX_MCP_PROMPT_SUBTOOLS_PER_SERVER) return false;
      perServerCount.set(serverKey, count + 1);
      return true;
    })
    .slice(0, MAX_MCP_PROMPT_SUBTOOLS);
  return [...output, ...selectedSubtools];
}

function isMcpPromptSubtoolDescriptor(descriptor: ToolDescriptor): boolean {
  return descriptor.metadata?.mcpAction === "callTool" || /^mcp\.[^.]+\.tool\.[^.]+$/u.test(descriptor.name);
}

function mcpPromptServerKey(descriptor: ToolDescriptor): string {
  const metadataKey = `${descriptor.metadata?.mcpSource ?? ""}:${descriptor.metadata?.mcpServerName ?? ""}`;
  if (metadataKey !== ":") {
    return metadataKey;
  }
  const match = /^mcp\.([^.]+)\.tool\.[^.]+$/u.exec(descriptor.name);
  return match?.[1] ?? descriptor.name;
}

function compareMcpPromptToolDescriptors(a: ToolDescriptor, b: ToolDescriptor): number {
  return mcpPromptToolDescriptorScore(b) - mcpPromptToolDescriptorScore(a)
    || a.name.localeCompare(b.name);
}

function mcpPromptToolDescriptorScore(descriptor: ToolDescriptor): number {
  const tags = new Set(descriptor.capabilityTags);
  let score = 0;
  if (tags.has("local_search")) score += 5;
  if (tags.has("web_fetch")) score += 4;
  if (tags.has("git_inspect")) score += 3;
  const summary = descriptor.summary.toLowerCase();
  if (summary.includes("required") || summary.includes("*:")) score += 2;
  return score;
}

function allowedToolNamesForAgent(agentKind: string, toolDescriptors: readonly ToolDescriptor[]) {
  const agent = demoAgents.find((candidate) => candidate.kind === agentKind);
  const allowed = new Set(agent?.allowedToolNames ?? []);
  for (const descriptor of toolDescriptors) {
    if (descriptor.ownerAgentKinds.includes(agentKind)) {
      allowed.add(descriptor.name);
    }
  }
  return [...allowed];
}

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
  getComputerUseConfig?: () => ComputerUseLoopOptionsConfig | undefined;
  getAvailableToolDescriptors?: () => ToolDescriptor[] | undefined;
  getRuntimePreferences?: () => {
    contextStrategy?: RuntimeExecutionConfig["contextStrategy"];
    agentMaxRoundsPreset?: "4" | "8" | "12" | "custom";
    agentMaxRoundsCustom?: number;
    taskTimeoutPreset?: "standard" | "long" | "custom";
    taskTimeoutCustomMs?: number;
    failureRecoveryPolicy?: "replan" | "stop";
    userWaitTimeoutPreset?: "standard" | "long" | "custom";
    userWaitTimeoutCustomMs?: number;
  };
  getCapabilityVerification?: () => AgentCapabilityVerificationInput | undefined;
  isAgentMemoryEnabled?: () => boolean;
  getEnabledSkillContext?: (request: SkillContextSelectionRequest) => Promise<string> | string;
  searchAgentMemory?: (request: MemorySearchRequest) => Promise<MemorySearchResult[]>;
  callMcpTool?: (request: McpCallRequest) => Promise<unknown>;
  recordToolCallAudit?: (record: ToolCallAuditRecord) => void;
  onWorkspaceToolActivity?: (activity: RuntimeWorkspaceToolActivity) => void;
  requestBrowserWriteApproval?: (request: BrowserWriteApprovalRequest) => Promise<BrowserWriteApprovalDecision>;
  buildAgentMemoryPromptContext?: (request: {
    userGoal: string;
    taskId: string;
    agentKind?: string;
  }) => Promise<string>;
}

export type RuntimeWorkspaceToolAction = "files" | "browser" | "review" | "terminal";

export interface RuntimeWorkspaceToolActivity {
  tool: RuntimeWorkspaceToolAction;
  sourceToolName: string;
  taskId: string;
  workspacePath: string;
  recordedAt: string;
}

export type BrowserWriteApprovalDecision = "approved" | "denied";

export interface BrowserWriteApprovalRequest {
  approvalId: string;
  taskId: string;
  sessionId: string;
  toolName: string;
  action: BrowserWriteAction;
  previewHash: string;
  selector?: string;
  byteCount?: number;
  scriptByteCount?: number;
}

type ComputerUseLoopOptionsConfig = Partial<Omit<ComputerUseLoopConfig, "timeouts" | "localVision">> & {
  enabled?: boolean;
  timeouts?: Partial<ComputerUseLoopConfig["timeouts"]>;
  localVision?: Partial<ComputerUseLoopConfig["localVision"]>;
};

export const COMPUTER_USE_LOCAL_VISION_STORAGE_KEY = "javis.computerUse.localVision.v1";
export const COMPUTER_USE_BUNDLED_LOCAL_VISION_MODEL_PATH = "models/local-vision/yolo26n-ui.onnx";

export type ComputerUseLocalVisionSettings = {
  mode: "off" | "passive" | "prompt_hint";
  modelPath: string;
  runtime: ComputerUseLoopConfig["localVision"]["runtime"];
  runtimeAdapterPath: string;
  imgsz: number;
  timeoutMs: number;
  maxDetections: number;
  minConfidence: number;
  iouThreshold: number;
  promptTopK: number;
  disableAfterConsecutiveTimeouts: number;
  disableAfterConsecutiveErrors: number;
  disableAfterConsecutiveActionFailures: number;
  reuseWorker: boolean;
};

export type ComputerUseSettings = {
  enabled: boolean;
  maxStepsPerTask: number;
  mouseSpeed: ComputerUseLoopConfig["mouseSpeed"];
  mouseDurationMs: number;
  typeDelayMs: number;
  deniedWindowPatterns: string[];
};

export const DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS: ComputerUseLocalVisionSettings = {
  mode: "off",
  modelPath: COMPUTER_USE_BUNDLED_LOCAL_VISION_MODEL_PATH,
  runtime: "auto",
  runtimeAdapterPath: "",
  imgsz: DEFAULT_COMPUTER_USE_CONFIG.localVision.imgsz,
  timeoutMs: DEFAULT_COMPUTER_USE_CONFIG.localVision.timeoutMs,
  maxDetections: DEFAULT_COMPUTER_USE_CONFIG.localVision.maxDetections,
  minConfidence: DEFAULT_COMPUTER_USE_CONFIG.localVision.minConfidence,
  iouThreshold: DEFAULT_COMPUTER_USE_CONFIG.localVision.iouThreshold,
  promptTopK: DEFAULT_COMPUTER_USE_CONFIG.localVision.promptTopK,
  disableAfterConsecutiveTimeouts: DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveTimeouts,
  disableAfterConsecutiveErrors: DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveErrors,
  disableAfterConsecutiveActionFailures: DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveActionFailures,
  reuseWorker: true,
};
export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  enabled: false,
  maxStepsPerTask: DEFAULT_COMPUTER_USE_CONFIG.maxSteps,
  mouseSpeed: DEFAULT_COMPUTER_USE_CONFIG.mouseSpeed,
  mouseDurationMs: DEFAULT_COMPUTER_USE_CONFIG.mouseDurationMs,
  typeDelayMs: DEFAULT_COMPUTER_USE_CONFIG.typeDelayMs,
  deniedWindowPatterns: DEFAULT_COMPUTER_USE_CONFIG.deniedWindowPatterns,
};
const LOCAL_VISION_PATH_INPUT_MAX_LENGTH = 1_024;
const LOCAL_VISION_IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,/i;

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

function requireComputerApprovalId(value: string | undefined, toolName: string): string {
  if (!value) {
    throw new Error(`${toolName} requires a confirmed Computer Use approval id.`);
  }
  return value;
}

function requireComputerTaskId(value: string | undefined, toolName: string): string {
  if (!value) {
    throw new Error(`${toolName} requires a task id for Computer Use approval.`);
  }
  return value;
}

const AGENT_PROMPT_CONTEXT_KINDS = new Set<AgentKind>([
  "commander",
  "file",
  "shell",
  "browser",
  "computer",
  "scheduler",
  "research",
  "code",
  "verifier",
  "workspace",
  "vision",
]);

function withAgentPromptContext(
  provider: ModelProvider,
  agentKind: string,
  getWorkspacePath: () => string,
  getMemoryContext?: (agentKind: string, options?: CompletionOptions) => Promise<string>,
  getSkillContext?: (agentKind: string, options?: CompletionOptions) => Promise<string> | string,
): ModelProvider {
  if (!AGENT_PROMPT_CONTEXT_KINDS.has(agentKind as AgentKind)) {
    return provider;
  }
  const kind = agentKind as AgentKind;
  const withContext = async (prompt: string, options?: CompletionOptions): Promise<CompletionOptions> => {
    const baseOptions: CompletionOptions = {
      ...options,
      agentKind: options?.agentKind ?? kind,
      workspacePath: options?.workspacePath ?? getWorkspacePath(),
    };
    let nextOptions = baseOptions;
    if (!baseOptions.skillContext && getSkillContext) {
      if (!baseOptions.skipSkillContext) {
        const trimmedSkillContext = (await getSkillContext(kind, baseOptions)).trim();
        if (trimmedSkillContext) {
          nextOptions = { ...nextOptions, skillContext: trimmedSkillContext };
        }
      }
    }
    if (
      baseOptions.skipAgentMemory ||
      baseOptions.memoryContext ||
      prompt.includes("Local Agent memory context:") ||
      prompt.includes("Commander task lessons and memory:") ||
      prompt.includes("Commander 任务经验和记忆:") ||
      !getMemoryContext
    ) {
      return nextOptions;
    }
    const trimmedMemoryContext = (await getMemoryContext(kind, nextOptions)).trim();
    return trimmedMemoryContext ? { ...nextOptions, memoryContext: trimmedMemoryContext } : nextOptions;
  };

  return {
    ...provider,
    complete(prompt, options) {
      return withContext(prompt, options)
        .then((resolvedOptions) => provider.complete(prompt, resolvedOptions));
    },
    stream(prompt, options) {
      return (async function* streamWithResolvedContext() {
        yield* provider.stream(prompt, await withContext(prompt, options));
      })();
    },
  };
}

export function loadComputerUseConfigFromStorage(
  storage: Pick<Storage, "getItem">,
): ComputerUseLoopOptionsConfig | undefined {
  const raw = storage.getItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return sanitizeStoredComputerUseConfig(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function loadComputerUseSettingsFromStorage(
  storage: Pick<Storage, "getItem">,
): ComputerUseSettings {
  const raw = storage.getItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_COMPUTER_USE_SETTINGS;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return DEFAULT_COMPUTER_USE_SETTINGS;
    }
    const candidate = value as Record<string, unknown>;
    return {
      enabled: candidate.enabled === true,
      maxStepsPerTask: clampInteger(
        candidate.maxSteps,
        1,
        60,
        DEFAULT_COMPUTER_USE_SETTINGS.maxStepsPerTask,
      ),
      mouseSpeed: sanitizeComputerUseMouseSpeed(candidate.mouseSpeed),
      mouseDurationMs: clampInteger(
        candidate.mouseDurationMs,
        0,
        1_000,
        DEFAULT_COMPUTER_USE_SETTINGS.mouseDurationMs,
      ),
      typeDelayMs: clampInteger(
        candidate.typeDelayMs,
        0,
        500,
        DEFAULT_COMPUTER_USE_SETTINGS.typeDelayMs,
      ),
      deniedWindowPatterns: sanitizeDeniedWindowPatterns(candidate.deniedWindowPatterns),
    };
  } catch {
    return DEFAULT_COMPUTER_USE_SETTINGS;
  }
}

export function saveComputerUseSettingsToStorage(
  storage: Pick<Storage, "getItem" | "setItem">,
  settings: ComputerUseSettings,
): ComputerUseSettings {
  const savedSettings: ComputerUseSettings = {
    enabled: settings.enabled === true,
    maxStepsPerTask: clampInteger(
      settings.maxStepsPerTask,
      1,
      60,
      DEFAULT_COMPUTER_USE_SETTINGS.maxStepsPerTask,
    ),
    mouseSpeed: sanitizeComputerUseMouseSpeed(settings.mouseSpeed),
    mouseDurationMs: clampInteger(
      settings.mouseDurationMs,
      0,
      1_000,
      DEFAULT_COMPUTER_USE_SETTINGS.mouseDurationMs,
    ),
    typeDelayMs: clampInteger(
      settings.typeDelayMs,
      0,
      500,
      DEFAULT_COMPUTER_USE_SETTINGS.typeDelayMs,
    ),
    deniedWindowPatterns: sanitizeDeniedWindowPatterns(settings.deniedWindowPatterns),
  };
  const existingConfig = loadComputerUseConfigFromStorage(storage) ?? {};
  const storedConfig: ComputerUseLoopOptionsConfig = {
    ...existingConfig,
    enabled: savedSettings.enabled,
    maxSteps: savedSettings.maxStepsPerTask,
    mouseSpeed: savedSettings.mouseSpeed,
    mouseDurationMs: savedSettings.mouseDurationMs,
    typeDelayMs: savedSettings.typeDelayMs,
    deniedWindowPatterns: savedSettings.deniedWindowPatterns,
  };
  storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify(storedConfig));
  return savedSettings;
}

export function loadComputerUseLocalVisionSettingsFromStorage(
  storage: Pick<Storage, "getItem">,
): ComputerUseLocalVisionSettings {
  const config = loadStoredLocalVisionSettingsConfig(storage);
  return {
    mode: sanitizeLocalVisionSettingsMode(config?.mode),
    modelPath: config?.modelPath ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.modelPath,
    runtime: config?.runtime ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.runtime,
    runtimeAdapterPath: config?.runtimeAdapterPath ?? "",
    imgsz: config?.imgsz ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.imgsz,
    timeoutMs: config?.timeoutMs ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.timeoutMs,
    maxDetections: config?.maxDetections ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.maxDetections,
    minConfidence: config?.minConfidence ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.minConfidence,
    iouThreshold: config?.iouThreshold ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.iouThreshold,
    promptTopK: config?.promptTopK ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.promptTopK,
    disableAfterConsecutiveTimeouts:
      config?.disableAfterConsecutiveTimeouts ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveTimeouts,
    disableAfterConsecutiveErrors:
      config?.disableAfterConsecutiveErrors ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveErrors,
    disableAfterConsecutiveActionFailures:
      config?.disableAfterConsecutiveActionFailures ??
      DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveActionFailures,
    reuseWorker: typeof config?.reuseWorker === "boolean"
      ? config.reuseWorker
      : DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.reuseWorker,
  };
}

export function saveComputerUseLocalVisionSettingsToStorage(
  storage: Pick<Storage, "getItem" | "setItem">,
  settings: ComputerUseLocalVisionSettings,
): ComputerUseLocalVisionSettings {
  const mode: ComputerUseLocalVisionSettings["mode"] =
    settings.mode === "passive" || settings.mode === "prompt_hint" ? settings.mode : "off";
  const modelPath = sanitizeLocalVisionPathInput(settings.modelPath);
  const runtime = sanitizeLocalVisionRuntime(settings.runtime);
  const runtimeAdapterPath = sanitizeLocalVisionPathInput(settings.runtimeAdapterPath);
  const imgsz = clampInteger(settings.imgsz, 320, 1280, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.imgsz);
  const timeoutMs = clampInteger(settings.timeoutMs, 20, 2_000, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.timeoutMs);
  const maxDetections = clampInteger(settings.maxDetections, 1, 100, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.maxDetections);
  const minConfidence = clampNumber(settings.minConfidence, 0, 1, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.minConfidence);
  const iouThreshold = clampNumber(settings.iouThreshold, 0, 1, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.iouThreshold);
  const promptTopK = clampInteger(settings.promptTopK, 0, 20, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.promptTopK);
  const disableAfterConsecutiveTimeouts = clampInteger(
    settings.disableAfterConsecutiveTimeouts,
    0,
    10,
    DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveTimeouts,
  );
  const disableAfterConsecutiveErrors = clampInteger(
    settings.disableAfterConsecutiveErrors,
    0,
    10,
    DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveErrors,
  );
  const disableAfterConsecutiveActionFailures = clampInteger(
    settings.disableAfterConsecutiveActionFailures,
    0,
    10,
    DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveActionFailures,
  );
  const reuseWorker = settings.reuseWorker === true;
  const existingConfig = loadComputerUseConfigFromStorage(storage) ?? {};
  const existingLocalVision = existingConfig.localVision ?? {};
  const runtimeConfig = sanitizeStoredComputerUseConfig({
    ...existingConfig,
    localVision: {
      ...existingLocalVision,
      enabled: mode !== "off" && Boolean(modelPath),
      mode,
      modelPath,
      runtime,
      runtimeAdapterPath,
      imgsz,
      timeoutMs,
      maxDetections,
      minConfidence,
      iouThreshold,
      promptTopK,
      disableAfterConsecutiveTimeouts,
      disableAfterConsecutiveErrors,
      disableAfterConsecutiveActionFailures,
      reuseWorker,
    },
  }) ?? { localVision: { enabled: false, mode: "off" as const } };
  const storedLocalVision: NonNullable<ComputerUseLoopOptionsConfig["localVision"]> = {
    ...runtimeConfig.localVision,
    enabled: mode !== "off" && Boolean(modelPath),
    mode,
  };
  const storedConfig: ComputerUseLoopOptionsConfig = {
    ...existingConfig,
    localVision: storedLocalVision,
  };

  storage.setItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY, JSON.stringify(storedConfig));
  return {
    mode,
    modelPath: storedConfig.localVision?.modelPath ?? "",
    runtime: storedConfig.localVision?.runtime ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.runtime,
    runtimeAdapterPath: storedConfig.localVision?.runtimeAdapterPath ?? "",
    imgsz: storedConfig.localVision?.imgsz ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.imgsz,
    timeoutMs: storedConfig.localVision?.timeoutMs ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.timeoutMs,
    maxDetections: storedConfig.localVision?.maxDetections ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.maxDetections,
    minConfidence: storedConfig.localVision?.minConfidence ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.minConfidence,
    iouThreshold: storedConfig.localVision?.iouThreshold ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.iouThreshold,
    promptTopK: storedConfig.localVision?.promptTopK ?? DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.promptTopK,
    disableAfterConsecutiveTimeouts:
      storedConfig.localVision?.disableAfterConsecutiveTimeouts ??
      DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveTimeouts,
    disableAfterConsecutiveErrors:
      storedConfig.localVision?.disableAfterConsecutiveErrors ??
      DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveErrors,
    disableAfterConsecutiveActionFailures:
      storedConfig.localVision?.disableAfterConsecutiveActionFailures ??
      DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveActionFailures,
    reuseWorker: storedConfig.localVision?.reuseWorker === true,
  };
}

function loadStoredLocalVisionSettingsConfig(
  storage: Pick<Storage, "getItem">,
): Partial<ComputerUseLocalVisionSettings> | undefined {
  const raw = storage.getItem(COMPUTER_USE_LOCAL_VISION_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { localVision?: unknown };
    if (!value || typeof value !== "object" || !value.localVision || typeof value.localVision !== "object") {
      return undefined;
    }
    const candidate = value.localVision as Record<string, unknown>;
    return {
      mode: sanitizeLocalVisionSettingsMode(candidate.mode),
      modelPath: typeof candidate.modelPath === "string" ? sanitizeLocalVisionPathInput(candidate.modelPath) : "",
      runtime: sanitizeLocalVisionRuntime(candidate.runtime),
      runtimeAdapterPath: typeof candidate.runtimeAdapterPath === "string"
        ? sanitizeLocalVisionPathInput(candidate.runtimeAdapterPath)
        : "",
      imgsz: clampInteger(candidate.imgsz, 320, 1280, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.imgsz),
      timeoutMs: clampInteger(candidate.timeoutMs, 20, 2_000, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.timeoutMs),
      maxDetections: clampInteger(candidate.maxDetections, 1, 100, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.maxDetections),
      minConfidence: clampNumber(candidate.minConfidence, 0, 1, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.minConfidence),
      iouThreshold: clampNumber(candidate.iouThreshold, 0, 1, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.iouThreshold),
      promptTopK: clampInteger(candidate.promptTopK, 0, 20, DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.promptTopK),
      disableAfterConsecutiveTimeouts: clampInteger(
        candidate.disableAfterConsecutiveTimeouts,
        0,
        10,
        DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveTimeouts,
      ),
      disableAfterConsecutiveErrors: clampInteger(
        candidate.disableAfterConsecutiveErrors,
        0,
        10,
        DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveErrors,
      ),
      disableAfterConsecutiveActionFailures: clampInteger(
        candidate.disableAfterConsecutiveActionFailures,
        0,
        10,
        DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.disableAfterConsecutiveActionFailures,
      ),
      reuseWorker: sanitizeLocalVisionReuseWorker(candidate.reuseWorker),
    };
  } catch {
    return undefined;
  }
}

function sanitizeLocalVisionSettingsMode(value: unknown): ComputerUseLocalVisionSettings["mode"] {
  return value === "passive" || value === "prompt_hint" ? value : "off";
}

function sanitizeStoredComputerUseConfig(value: unknown): ComputerUseLoopOptionsConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    enabled?: unknown;
    maxSteps?: unknown;
    mouseSpeed?: unknown;
    mouseDurationMs?: unknown;
    typeDelayMs?: unknown;
    deniedWindowPatterns?: unknown;
    localVision?: unknown;
  };
  const localVision = sanitizeStoredLocalVisionConfig(candidate.localVision);
  const hasEnabled = hasOwn(candidate as Record<string, unknown>, "enabled");
  const hasMaxSteps = hasOwn(candidate as Record<string, unknown>, "maxSteps");
  const hasMouseSpeed = hasOwn(candidate as Record<string, unknown>, "mouseSpeed");
  const hasMouseDurationMs = hasOwn(candidate as Record<string, unknown>, "mouseDurationMs");
  const hasTypeDelayMs = hasOwn(candidate as Record<string, unknown>, "typeDelayMs");
  const hasDeniedWindowPatterns = hasOwn(candidate as Record<string, unknown>, "deniedWindowPatterns");
  const enabled = hasEnabled ? candidate.enabled === true : undefined;
  const maxSteps = hasMaxSteps
    ? clampInteger(candidate.maxSteps, 1, 60, DEFAULT_COMPUTER_USE_CONFIG.maxSteps)
    : undefined;
  const mouseSpeed = hasMouseSpeed ? sanitizeComputerUseMouseSpeed(candidate.mouseSpeed) : undefined;
  const mouseDurationMs = hasMouseDurationMs
    ? clampInteger(candidate.mouseDurationMs, 0, 1_000, DEFAULT_COMPUTER_USE_CONFIG.mouseDurationMs)
    : undefined;
  const typeDelayMs = hasTypeDelayMs
    ? clampInteger(candidate.typeDelayMs, 0, 500, DEFAULT_COMPUTER_USE_CONFIG.typeDelayMs)
    : undefined;
  const deniedWindowPatterns = hasDeniedWindowPatterns
    ? sanitizeDeniedWindowPatterns(candidate.deniedWindowPatterns)
    : undefined;
  if (
    !localVision &&
    enabled === undefined &&
    maxSteps === undefined &&
    mouseSpeed === undefined &&
    mouseDurationMs === undefined &&
    typeDelayMs === undefined &&
    deniedWindowPatterns === undefined
  ) {
    return undefined;
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(mouseSpeed === undefined ? {} : { mouseSpeed }),
    ...(mouseDurationMs === undefined ? {} : { mouseDurationMs }),
    ...(typeDelayMs === undefined ? {} : { typeDelayMs }),
    ...(deniedWindowPatterns === undefined ? {} : { deniedWindowPatterns }),
    ...(localVision ? { localVision } : {}),
  };
}

function sanitizeComputerUseMouseSpeed(value: unknown): ComputerUseLoopConfig["mouseSpeed"] {
  return value === "linear" ? "linear" : "instant";
}

function sanitizeDeniedWindowPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= 32) break;
  }
  return output;
}

function sanitizeStoredLocalVisionConfig(value: unknown): ComputerUseLoopOptionsConfig["localVision"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const enabled = candidate.enabled === true;
  const mode = typeof candidate.mode === "string" ? candidate.mode : undefined;
  const modelPath = typeof candidate.modelPath === "string" ? sanitizeLocalVisionPathInput(candidate.modelPath) : "";
  const runtimeAdapterPath = typeof candidate.runtimeAdapterPath === "string" ? sanitizeLocalVisionPathInput(candidate.runtimeAdapterPath) : "";
  if (!enabled || !modelPath || (mode !== "passive" && mode !== "prompt_hint")) {
    return {
      enabled: false,
      mode: "off",
      ...(modelPath ? { modelPath } : {}),
      ...(runtimeAdapterPath ? { runtimeAdapterPath } : {}),
      ...sanitizeStoredLocalVisionProvidedTuning(candidate),
    };
  }
  return {
    enabled: true,
    mode,
    modelPath: modelPath || undefined,
    runtimeAdapterPath: runtimeAdapterPath || undefined,
    reuseWorker: sanitizeLocalVisionReuseWorker(candidate.reuseWorker),
    ...sanitizeStoredLocalVisionTuning(candidate),
  };
}

function sanitizeLocalVisionReuseWorker(value: unknown): boolean {
  return value === false ? false : DEFAULT_COMPUTER_USE_LOCAL_VISION_SETTINGS.reuseWorker;
}

function sanitizeStoredLocalVisionTuning(
  candidate: Record<string, unknown>,
): Required<Pick<
  NonNullable<ComputerUseLoopOptionsConfig["localVision"]>,
  | "runtime"
  | "imgsz"
  | "timeoutMs"
  | "maxDetections"
  | "promptTopK"
  | "minConfidence"
  | "iouThreshold"
  | "disableAfterConsecutiveTimeouts"
  | "disableAfterConsecutiveErrors"
  | "disableAfterConsecutiveActionFailures"
>> & Pick<NonNullable<ComputerUseLoopOptionsConfig["localVision"]>, "labelMap"> {
  const labelMap = sanitizeLocalVisionLabelMap(candidate.labelMap);
  return {
    runtime: sanitizeLocalVisionRuntime(candidate.runtime),
    imgsz: clampInteger(candidate.imgsz, 320, 1280, DEFAULT_COMPUTER_USE_CONFIG.localVision.imgsz),
    timeoutMs: clampInteger(candidate.timeoutMs, 20, 2_000, DEFAULT_COMPUTER_USE_CONFIG.localVision.timeoutMs),
    maxDetections: clampInteger(candidate.maxDetections, 1, 100, DEFAULT_COMPUTER_USE_CONFIG.localVision.maxDetections),
    promptTopK: clampInteger(candidate.promptTopK, 0, 20, DEFAULT_COMPUTER_USE_CONFIG.localVision.promptTopK),
    minConfidence: clampNumber(candidate.minConfidence, 0, 1, DEFAULT_COMPUTER_USE_CONFIG.localVision.minConfidence),
    iouThreshold: normalizeIouThreshold(candidate.iouThreshold),
    ...(labelMap ? { labelMap } : {}),
    disableAfterConsecutiveTimeouts: clampInteger(
      candidate.disableAfterConsecutiveTimeouts,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveTimeouts,
    ),
    disableAfterConsecutiveErrors: clampInteger(
      candidate.disableAfterConsecutiveErrors,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveErrors,
    ),
    disableAfterConsecutiveActionFailures: clampInteger(
      candidate.disableAfterConsecutiveActionFailures,
      0,
      10,
      DEFAULT_COMPUTER_USE_CONFIG.localVision.disableAfterConsecutiveActionFailures,
    ),
  };
}

function sanitizeStoredLocalVisionProvidedTuning(
  candidate: Record<string, unknown>,
): Partial<
  ReturnType<typeof sanitizeStoredLocalVisionTuning>
  & Pick<NonNullable<ComputerUseLoopOptionsConfig["localVision"]>, "reuseWorker">
> {
  const tuning = sanitizeStoredLocalVisionTuning(candidate);
  const output: Partial<
    ReturnType<typeof sanitizeStoredLocalVisionTuning>
    & Pick<NonNullable<ComputerUseLoopOptionsConfig["localVision"]>, "reuseWorker">
  > = {};
  if (hasOwn(candidate, "runtime") && isSupportedLocalVisionRuntime(candidate.runtime)) {
    output.runtime = tuning.runtime;
  }
  if (hasOwn(candidate, "reuseWorker")) output.reuseWorker = candidate.reuseWorker === true;
  if (hasOwn(candidate, "imgsz")) output.imgsz = tuning.imgsz;
  if (hasOwn(candidate, "timeoutMs")) output.timeoutMs = tuning.timeoutMs;
  if (hasOwn(candidate, "maxDetections")) output.maxDetections = tuning.maxDetections;
  if (hasOwn(candidate, "promptTopK")) output.promptTopK = tuning.promptTopK;
  if (hasOwn(candidate, "minConfidence")) output.minConfidence = tuning.minConfidence;
  if (hasOwn(candidate, "iouThreshold")) output.iouThreshold = tuning.iouThreshold;
  if (hasOwn(candidate, "labelMap") && tuning.labelMap) output.labelMap = tuning.labelMap;
  if (hasOwn(candidate, "disableAfterConsecutiveTimeouts")) {
    output.disableAfterConsecutiveTimeouts = tuning.disableAfterConsecutiveTimeouts;
  }
  if (hasOwn(candidate, "disableAfterConsecutiveErrors")) {
    output.disableAfterConsecutiveErrors = tuning.disableAfterConsecutiveErrors;
  }
  if (hasOwn(candidate, "disableAfterConsecutiveActionFailures")) {
    output.disableAfterConsecutiveActionFailures = tuning.disableAfterConsecutiveActionFailures;
  }
  return output;
}

function sanitizeLocalVisionRuntime(value: unknown): ComputerUseLoopConfig["localVision"]["runtime"] {
  return isSupportedLocalVisionRuntime(value) ? value : "auto";
}

function isSupportedLocalVisionRuntime(value: unknown): value is ComputerUseLoopConfig["localVision"]["runtime"] {
  return value === "auto" || value === "onnxruntime" || value === "openvino" || value === "tensorrt";
}

function normalizeIouThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_COMPUTER_USE_CONFIG.localVision.iouThreshold;
}

function sanitizeLocalVisionLabelMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 256)) {
    if (typeof entry !== "string") continue;
    const normalizedKey = sanitizeLocalVisionLabelMapText(key, 32);
    const normalizedValue = sanitizeLocalVisionLabelMapText(entry, 80);
    if (normalizedKey && normalizedValue) {
      output[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeLocalVisionLabelMapText(value: string, maxLength: number): string {
  return value.trim().replace(/data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[redacted:image data URL]").slice(0, maxLength);
}

function sanitizeLocalVisionPathInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || LOCAL_VISION_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed.slice(0, LOCAL_VISION_PATH_INPUT_MAX_LENGTH);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function runtimePreferencesToExecutionConfig(
  preferences: ReturnType<NonNullable<CreateJavisRuntimeOptions["getRuntimePreferences"]>> | undefined,
): RuntimeExecutionConfig {
  const presetIterations = preferences?.agentMaxRoundsPreset === "4"
    ? 4
    : preferences?.agentMaxRoundsPreset === "12"
      ? 12
      : preferences?.agentMaxRoundsPreset === "custom"
        ? clampInteger(preferences.agentMaxRoundsCustom, 1, 24, 8)
        : 8;
  const taskTimeoutMs = preferences?.taskTimeoutPreset === "long"
    ? 180_000
    : preferences?.taskTimeoutPreset === "custom"
      ? clampInteger(preferences.taskTimeoutCustomMs, 30_000, 900_000, 90_000)
      : 90_000;
  const userWaitTimeoutMs = preferences?.userWaitTimeoutPreset === "long"
    ? 30 * 60_000
    : preferences?.userWaitTimeoutPreset === "custom"
      ? clampInteger(preferences.userWaitTimeoutCustomMs, 60_000, 120 * 60_000, 5 * 60_000)
      : 5 * 60_000;
  const contextStrategy = preferences?.contextStrategy === "short" || preferences?.contextStrategy === "long"
    ? preferences.contextStrategy
    : "auto";
  return {
    contextStrategy,
    agentMaxIterations: presetIterations,
    taskTimeoutMs,
    failureRecoveryEnabled: preferences?.failureRecoveryPolicy !== "stop",
    userWaitTimeoutMs,
  };
}

export function createJavisRuntime({
  getWorkspacePath,
  modelSettings,
  getModelConfiguration,
  getScheduledTasksRepository,
  getComputerUseConfig,
  getAvailableToolDescriptors,
  getRuntimePreferences,
  getCapabilityVerification,
  isAgentMemoryEnabled,
  getEnabledSkillContext,
  searchAgentMemory,
  callMcpTool,
  recordToolCallAudit,
  onWorkspaceToolActivity,
  requestBrowserWriteApproval,
  buildAgentMemoryPromptContext,
}: CreateJavisRuntimeOptions) {
  const fallbackProvider = createConfiguredModelProvider(modelSettings);
  const providerCache = new Map<string, ModelProvider>();
  // Pre-populate cache with fallback for backward compatibility
  providerCache.set("fallback", fallbackProvider);

  const taskIdRef: { current: string | null } = { current: null };
  const currentUserGoalRef: { current: string } = { current: "" };
  const providerFor = (agentKind: string): ModelProvider => {
    const config = getModelConfiguration?.();
    const provider = config ? resolveModelForAgent(agentKind, config, providerCache) : fallbackProvider;
    return withAgentPromptContext(
      provider,
      agentKind,
      getWorkspacePath,
      getAgentMemoryContextForProvider,
      getEnabledSkillContext
        ? (contextAgentKind, options) => getEnabledSkillContext({
            agentKind: contextAgentKind,
            userGoal: currentUserGoalRef.current,
            options,
            maxSkills: options?.skillContextMaxSkills,
            maxContextChars: options?.skillContextMaxChars,
          })
        : undefined,
    );
  };

  const sharedContext = createSharedTaskContext();
  const eventBus = createTaskEventBus();
  const streamingAgentRef: { current: AgentKind } = { current: "commander" };
  let activeComputerUseAbortController: AbortController | undefined;
  const preprocessingByTaskId = new Map<string, Promise<PreprocessedInput | undefined>>();
  let preprocessingForNextTask:
    | { promise: Promise<PreprocessedInput | undefined> }
    | undefined;
  const runReadOnlyCommand = (request: ShellCommandRequest) => {
    const workspacePath = getWorkspacePath();
    return invoke<ShellCommandOutput>("run_read_only_command", {
      request: {
        ...request,
        workspacePath: request.workspacePath ?? (workspacePath.trim() || null),
      },
    });
  };

  function notifyWorkspaceToolActivity(
    tool: RuntimeWorkspaceToolAction,
    sourceToolName: string,
    inputSummary: string,
  ) {
    const taskId = taskIdRef.current ?? "task-unknown";
    const recordedAt = new Date().toISOString();
    const workspacePath = getWorkspacePath().trim();
    recordToolCallAudit?.({
      id: `workspace-tool-sync:${taskId}:${tool}:${recordedAt}`,
      taskId,
      toolName: `workspace.${tool}.sync`,
      permissionLevel: "read",
      status: "succeeded",
      inputSummary,
      outputSummary: `Opened ${tool} workspace panel for ${sourceToolName}.`,
      startedAt: recordedAt,
      endedAt: recordedAt,
    });
    onWorkspaceToolActivity?.({
      tool,
      sourceToolName,
      taskId,
      workspacePath,
      recordedAt,
    });
  }

  async function runBrowserWriteAction<
    Request extends BrowserClickRequest | BrowserTypeRequest | BrowserEvaluateRequest | BrowserRunTestRequest,
    Result extends BrowserWriteExecutionResult,
  >(
    action: BrowserWriteAction,
    request: Request,
    execute: (request: Request & BrowserApprovedWriteRequest) => Promise<Result>,
  ): Promise<Result> {
    const taskId = taskIdRef.current ?? "task-browser-write";
    const sessionId = taskId;
    const plan = await invoke<BrowserWritePlanResult>("browser_plan_write", {
      request: {
        taskId,
        sessionId,
        action,
        ...browserWritePlanPreview(action, request),
      },
    });
    recordToolCallAudit?.(createBrowserWritePlanAuditRecord(plan));
    if (!requestBrowserWriteApproval) {
      throw new Error(`Browser write ${plan.toolName} requires visible approval.`);
    }
    const decision = await requestBrowserWriteApproval({
      approvalId: plan.approvalId,
      taskId,
      sessionId: plan.sessionId,
      toolName: plan.toolName,
      action: plan.action,
      previewHash: plan.previewHash,
      ...browserWriteApprovalPreview(action, request),
    });
    if (decision !== "approved") {
      throw new Error(`Browser write ${plan.toolName} was denied.`);
    }
    await invoke("browser_approve_write", {
      request: {
        approvalId: plan.approvalId,
        taskId,
        sessionId,
        action,
        previewHash: plan.previewHash,
      },
    });
    const startedAt = new Date().toISOString();
    try {
      const result = await execute({
        ...request,
        taskId,
        sessionId,
        approvalId: plan.approvalId,
      });
      recordToolCallAudit?.(createBrowserWriteExecutionAuditRecord(plan, result, startedAt));
      return result;
    } catch (error) {
      recordToolCallAudit?.(createBrowserWriteFailedAuditRecord(plan, error, startedAt));
      throw error;
    }
  }

  type BrowserApprovedWriteRequest = {
    taskId: string;
    sessionId: string;
    approvalId: string;
  };

  function browserWritePlanPreview(
    action: BrowserWriteAction,
    request: BrowserClickRequest | BrowserTypeRequest | BrowserEvaluateRequest | BrowserRunTestRequest,
  ): {
    selector?: string;
    expression?: string;
    testFile?: string;
    inputSummary?: string;
    inputHash?: string;
    inputBytes?: number;
    scriptHash?: string;
    scriptBytes?: number;
  } {
    if (action === "click" && "selector" in request) {
      return { selector: request.selector };
    }
    if (action === "type" && "selector" in request && "text" in request) {
      return {
        selector: request.selector,
        inputSummary: "text input",
        inputHash: fnv1aHash(request.text),
        inputBytes: byteLength(request.text),
      };
    }
    if (action === "evaluate" && "expression" in request) {
      return { expression: request.expression };
    }
    if (action === "runTest" && "script" in request) {
      return {
        testFile: request.testFile,
        inputSummary: "browser test",
        scriptHash: fnv1aHash(request.script),
        scriptBytes: byteLength(request.script),
      };
    }
    return { inputSummary: action };
  }

  function browserWriteApprovalPreview(
    action: BrowserWriteAction,
    request: BrowserClickRequest | BrowserTypeRequest | BrowserEvaluateRequest | BrowserRunTestRequest,
  ): Pick<BrowserWriteApprovalRequest, "selector" | "byteCount" | "scriptByteCount"> {
    if (action === "click" && "selector" in request) {
      return { selector: request.selector };
    }
    if (action === "type" && "selector" in request && "text" in request) {
      return { selector: request.selector, byteCount: byteLength(request.text) };
    }
    if (action === "evaluate" && "expression" in request) {
      return { byteCount: byteLength(request.expression) };
    }
    if (action === "runTest" && "script" in request) {
      return { scriptByteCount: byteLength(request.script) };
    }
    return {};
  }

  function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  function fnv1aHash(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  async function getAgentMemoryContextForProvider(agentKind: string, options?: CompletionOptions): Promise<string> {
    if (!isAgentMemoryEnabled?.() || !buildAgentMemoryPromptContext || options?.skipAgentMemory) {
      return "";
    }
    const taskId = taskIdRef.current ?? "task-unknown";
    const userGoal = currentUserGoalRef.current.trim();
    if (!userGoal) {
      return "";
    }
    return buildAgentMemoryPromptContext({
      userGoal,
      taskId,
      agentKind,
    });
  }

  const runtime = createFileScanTaskRuntime({
    getRuntimeConfig: () => runtimePreferencesToExecutionConfig(getRuntimePreferences?.()),
    getAvailableToolDescriptors: () => normalizeAvailableToolDescriptors(getAvailableToolDescriptors?.()),
    getCapabilityVerification,
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
          const preprocessedInput = await preprocessingByTaskId.get(taskId);
          preprocessingByTaskId.delete(taskId);
          if (preprocessedInput) {
            sharedContext.set("preprocessedChineseInput", preprocessedInput);
          }
          const result = await planWithModelProviderStreaming(
            withPreprocessedCommanderGoal(request, preprocessedInput),
            providerFor("commander"),
            (chunk) =>
              eventBus.emit({
                kind: "agent.chunk",
                taskId,
                agentKind: "commander",
                text: chunk.text,
              }),
            isAgentMemoryEnabled?.()
              ? async () => buildAgentMemoryPromptContext?.({
                  userGoal: request.userGoal,
                  taskId,
                  agentKind: "commander",
                }) ?? ""
              : undefined,
            getAvailableToolDescriptors?.(),
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
            "If evidence is missing or inconclusive, say what is unknown; do not fill gaps with guesses.",
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
        notifyWorkspaceToolActivity(
          "files",
          "file.scanMarkdownDocuments",
          `Scan Markdown documents in ${workspacePath.trim() || "(default workspace)"}.`,
        );
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
        notifyWorkspaceToolActivity(
          "files",
          "file.planWriteText",
          `Plan text write for ${request.targetPath}.`,
        );
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
        notifyWorkspaceToolActivity(
          "files",
          "file.writeText",
          `Execute approved text write for ${request.targetPath}.`,
        );
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
      scanUserImages: (request) =>
        scanUserImages(request?.maxResults),
      scanInstalledApps: () =>
        scanInstalledApps(),
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
      listDirectory: async ({ path }) => {
        if (!path) {
          throw new Error("computer.listDirectory requires a path.");
        }
        const entries = await listDirectory(path);
        return entries.map((entry): ComputerFileCandidate => ({
          name: entry.name,
          path: entry.path,
          isDir: entry.isDir,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
          extension: entry.extension,
        }));
      },
      screenshot: (request: ComputerScreenshotRequest) =>
        invoke<ComputerScreenshotResult>("computer_screenshot", { request }),
      listWindows: (request: ComputerListWindowsRequest) =>
        invoke<ComputerListWindowsResult>("computer_list_windows", { request }),
      detectUiObjects: (request: ComputerDetectUiObjectsRequest) =>
        invoke<ComputerDetectUiObjectsResult>("computer_detect_ui_objects", { request }),
      inspectUi: (request: ComputerInspectUiRequest) =>
        invoke<ComputerInspectUiResult>("computer_inspect_ui", { request }),
      focusWindow: (request: ComputerFocusWindowRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerFocusWindowResult>("computer_focus_window", {
          approvalId: requireComputerApprovalId(approvalId, "computer.focusWindow"),
          taskId: requireComputerTaskId(taskId, "computer.focusWindow"),
          request: actionRequest,
        });
      },
      moveMouse: (request: ComputerMoveMouseRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerMoveMouseResult>("computer_move_mouse", {
          approvalId: requireComputerApprovalId(approvalId, "computer.moveMouse"),
          taskId: requireComputerTaskId(taskId, "computer.moveMouse"),
          request: actionRequest,
        });
      },
      click: (request: ComputerClickRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerClickResult>("computer_click", {
          approvalId: requireComputerApprovalId(approvalId, "computer.click"),
          taskId: requireComputerTaskId(taskId, "computer.click"),
          request: actionRequest,
        });
      },
      type: (request: ComputerTypeRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerTypeResult>("computer_type", {
          approvalId: requireComputerApprovalId(approvalId, "computer.type"),
          taskId: requireComputerTaskId(taskId, "computer.type"),
          request: actionRequest,
        });
      },
      keyCombo: (request: ComputerKeyComboRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerKeyComboResult>("computer_key_combo", {
          approvalId: requireComputerApprovalId(approvalId, "computer.keyCombo"),
          taskId: requireComputerTaskId(taskId, "computer.keyCombo"),
          request: actionRequest,
        });
      },
      scroll: (request: ComputerScrollRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerScrollResult>("computer_scroll", {
          approvalId: requireComputerApprovalId(approvalId, "computer.scroll"),
          taskId: requireComputerTaskId(taskId, "computer.scroll"),
          request: actionRequest,
        });
      },
      invokeUi: (request: ComputerInvokeUiRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerInvokeUiResult>("computer_invoke_ui", {
          approvalId: requireComputerApprovalId(approvalId, "computer.invokeUi"),
          taskId: requireComputerTaskId(taskId, "computer.invokeUi"),
          request: actionRequest,
        });
      },
      setUiValue: (request: ComputerSetUiValueRequest) => {
        const { approvalId, taskId, ...actionRequest } = request;
        return invoke<ComputerSetUiValueResult>("computer_set_ui_value", {
          approvalId: requireComputerApprovalId(approvalId, "computer.setUiValue"),
          taskId: requireComputerTaskId(taskId, "computer.setUiValue"),
          request: actionRequest,
        });
      },
      wait: (request: ComputerWaitRequest) =>
        invoke<ComputerWaitResult>("computer_wait", { request }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openPath: async (...args: any[]) => {
        const [first] = args;
        const path = typeof first === "string"
          ? first
          : (first?.path as string | undefined) ?? (first?.targetPath as string | undefined);
        if (!path) {
          throw new Error("computer.openPath requires a path.");
        }
        await openNativePath(path);
        return { opened: true, path };
      },
      approveAction: async (
        action: ComputerUseApprovalRequest,
        approvalId: string,
        taskId: string,
        sessionWide?: boolean,
      ): Promise<ComputerUseApprovalResult> => {
        await invoke("computer_approve_action", {
          approvalId,
          taskId,
          toolName: action.tool,
          paramsJson: JSON.stringify(action.params),
          sessionWide: sessionWide ?? false,
        });
        return { approvalId, taskId, sessionWide: sessionWide ?? false };
      },
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
            isZh
              ? "只描述图片中可见内容；看不清或没有证据时写 unknown，不要推测。"
              : "Describe only visible evidence; use unknown when unclear and do not infer unsupported facts.",
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
          `Describe the image in ${detail} terms. Mention only visible details; if unclear, say unknown rather than guessing.`,
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
      runReadOnlyCommand: (request) => {
        notifyWorkspaceToolActivity(
          "terminal",
          "shell.runReadOnlyCommand",
          `Run read-only command: ${request.program} ${(request.args ?? []).join(" ")}`.trim(),
        );
        return runReadOnlyCommand(request);
      },
    },
    codeTool: {
      inspectRepository: async (): Promise<CodeReviewPreview> => {
        notifyWorkspaceToolActivity(
          "review",
          "code.inspectRepository",
          "Inspect repository git status and diff.",
        );
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
      searchRepository: async (request): Promise<CodeRepositorySearchResult> => {
        notifyWorkspaceToolActivity(
          "review",
          "code.searchRepository",
          `Search repository for ${request.goal}.`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before searching the repository.");
        }
        const sessionId = taskIdRef.current ?? "repo-intelligence";
        const priorityPaths = request.priorityPaths && request.priorityPaths.length > 0
          ? request.priorityPaths
          : await readChangedFilesForRepositoryPriority(runReadOnlyCommand);
        return searchRepositoryWithFileSearch({ ...request, priorityPaths }, {
          searchFiles: ({ query, maxResults }) =>
            invoke<Array<{ path: string; line?: number; preview?: string; provider?: string }>>("files_search", {
              request: {
                sessionId,
                workspaceRoot,
                query,
                maxResults,
              },
            }),
          semanticRerank: createLocalTextSemanticReranker(),
        });
      },
      traceCallChain: async (request) => {
        notifyWorkspaceToolActivity(
          "review",
          "code.traceCallChain",
          `Trace repository call chain for ${request.target}.`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before tracing the repository.");
        }
        const sessionId = taskIdRef.current ?? "repo-intelligence";
        const searchFiles = ({ query, maxResults }: { query: string; maxResults: number }) =>
          invoke<Array<{ path: string; line?: number; preview?: string; provider?: string }>>("files_search", {
            request: {
              sessionId,
              workspaceRoot,
              query,
              maxResults,
            },
        });
        return traceCallChainWithFileSearch(request, {
          searchFiles,
          readTextFile: (path) => invoke<string>("read_file_chunk", {
            path,
            maxLines: 200,
            workspaceRoot,
            allowedRootIds: null,
          }),
          resolveModuleSpecifier: (moduleRequest) =>
            resolveModuleSpecifierWithFileSearch(moduleRequest, {
              searchFiles,
              readTextFile: (path) => invoke<string>("read_file_chunk", {
                path,
                maxLines: 200,
                workspaceRoot,
                allowedRootIds: null,
              }),
              ...(typeof fetch === "function"
                ? { externalPackageRegistry: { fetch } }
                : {}),
            }),
        });
      },
      proposeEdit: ({ userGoal, preview, taskId }) =>
        proposeCodeEditWithModelProvider(userGoal, preview, providerFor("code"), taskId),
      applyProposedEdit: (edit: CodeProposedEdit, approval) => {
        notifyWorkspaceToolActivity(
          "review",
          "code.applyProposedEdit",
          `Apply approved code proposal ${edit.proposalId}.`,
        );
        return invoke("approve_code_patch", {
          request: {
            approvalId: approval.approvalId,
            proposalId: edit.proposalId,
            workspacePath: edit.workspacePath,
            changedFiles: edit.changedFiles,
            patchHash: edit.patchHash,
            taskId: approval.taskId,
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
              taskId: approval.taskId,
            },
          }),
        );
      },
    },
    gitTool: {
      planStageFiles: (request) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.stageFiles",
          `Plan staging for ${request.paths.length} file(s).`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before preparing Git staging.");
        }
        const taskId = request.taskId ?? taskIdRef.current ?? "task-unknown";
        return invoke<GitStagePlan>("git_plan_stage_files", {
          request: {
            sessionId: taskId,
            workspaceRoot,
            taskId,
            paths: request.paths,
          },
        });
      },
      executeStageFiles: async (approval) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.stageFiles",
          `Execute approved staging for ${approval.paths.length} file(s).`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before staging files.");
        }
        const taskId = approval.taskId ?? taskIdRef.current ?? "task-unknown";
        await invoke("git_approve_stage_files", {
          approvalId: approval.approvalId,
          taskId,
        });
        const execution = await invoke<{
          workspaceRoot: string;
          stagedPaths: string[];
          fileCount: number;
          staged: boolean;
          output: string;
        }>("git_execute_stage_files", {
          request: {
            approvalId: approval.approvalId,
            sessionId: taskId,
            workspaceRoot,
            taskId,
            paths: approval.paths,
          },
        });
        return {
          workspacePath: execution.workspaceRoot,
          stagedPaths: execution.stagedPaths,
          fileCount: execution.fileCount,
          staged: execution.staged,
          output: execution.output,
        } satisfies GitStageExecutionResult;
      },
      planCommit: (request) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.createCommit",
          `Plan commit: ${request.message}`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before preparing a Git commit.");
        }
        const taskId = request.taskId ?? taskIdRef.current ?? "task-unknown";
        return invoke<GitCommitPlan>("git_plan_commit", {
          request: {
            sessionId: taskId,
            workspaceRoot,
            taskId,
            message: request.message,
            paths: request.paths ?? [],
          },
        });
      },
      executeCommit: async (approval) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.createCommit",
          `Execute approved commit: ${approval.message}`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before creating a Git commit.");
        }
        const taskId = approval.taskId ?? taskIdRef.current ?? "task-unknown";
        await invoke("git_approve_commit", {
          approvalId: approval.approvalId,
          taskId,
        });
        const execution = await invoke<{
          workspaceRoot: string;
          branch?: string;
          commitHash: string;
          subject: string;
          fileCount: number;
          committed: boolean;
          output: string;
        }>("git_execute_commit", {
          request: {
            approvalId: approval.approvalId,
            sessionId: taskId,
            workspaceRoot,
            taskId,
            message: approval.message,
            paths: approval.paths ?? [],
          },
        });
        return {
          workspacePath: execution.workspaceRoot,
          branch: execution.branch,
          commitHash: execution.commitHash,
          subject: execution.subject,
          fileCount: execution.fileCount,
          committed: execution.committed,
          output: execution.output,
        } satisfies GitCommitExecutionResult;
      },
      planCreatePullRequest: (request) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.createPullRequest",
          `Plan draft pull request: ${request.title}`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before preparing a Git pull request.");
        }
        const taskId = request.taskId ?? taskIdRef.current ?? "task-unknown";
        return invoke<GitCreatePullRequestPlan>("git_plan_create_pull_request", {
          request: {
            sessionId: taskId,
            workspaceRoot,
            taskId,
            title: request.title,
            body: request.body ?? "",
            baseBranch: request.baseBranch,
            draft: request.draft ?? true,
          },
        });
      },
      executeCreatePullRequest: async (approval) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.createPullRequest",
          `Execute approved draft pull request: ${approval.title}`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before creating a Git pull request.");
        }
        const taskId = approval.taskId ?? taskIdRef.current ?? "task-unknown";
        await invoke("git_approve_create_pull_request", {
          approvalId: approval.approvalId,
          taskId,
        });
        const execution = await invoke<{
          workspaceRoot: string;
          provider: string;
          url: string;
          title: string;
          baseBranch: string;
          headBranch: string;
          draft: boolean;
          created: boolean;
          output: string;
        }>("git_execute_create_pull_request", {
          request: {
            approvalId: approval.approvalId,
            sessionId: taskId,
            workspaceRoot,
            taskId,
            title: approval.title,
            body: approval.body ?? "",
            baseBranch: approval.baseBranch,
            draft: approval.draft ?? true,
          },
        });
        return {
          workspacePath: execution.workspaceRoot,
          provider: execution.provider,
          url: execution.url,
          title: execution.title,
          baseBranch: execution.baseBranch,
          headBranch: execution.headBranch,
          draft: execution.draft,
          created: execution.created,
          output: execution.output,
        } satisfies GitCreatePullRequestExecutionResult;
      },
      planCommentPullRequest: (request) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.commentPullRequest",
          `Plan pull request comment for ${request.pullRequest}.`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before preparing a Git pull request comment.");
        }
        const taskId = request.taskId ?? taskIdRef.current ?? "task-unknown";
        return invoke<GitCommentPullRequestPlan>("git_plan_comment_pull_request", {
          request: {
            sessionId: taskId,
            workspaceRoot,
            taskId,
            pullRequest: request.pullRequest,
            body: request.body,
          },
        });
      },
      executeCommentPullRequest: async (approval) => {
        notifyWorkspaceToolActivity(
          "review",
          "git.commentPullRequest",
          `Execute approved pull request comment for ${approval.pullRequest}.`,
        );
        const workspaceRoot = getWorkspacePath().trim();
        if (!workspaceRoot) {
          throw new Error("Select a workspace before commenting on a Git pull request.");
        }
        const taskId = approval.taskId ?? taskIdRef.current ?? "task-unknown";
        await invoke("git_approve_comment_pull_request", {
          approvalId: approval.approvalId,
          taskId,
        });
        const execution = await invoke<{
          workspaceRoot: string;
          provider: string;
          pullRequest: string;
          commented: boolean;
          output: string;
        }>("git_execute_comment_pull_request", {
          request: {
            approvalId: approval.approvalId,
            sessionId: taskId,
            workspaceRoot,
            taskId,
            pullRequest: approval.pullRequest,
            body: approval.body,
          },
        });
        return {
          workspacePath: execution.workspaceRoot,
          provider: execution.provider,
          pullRequest: execution.pullRequest,
          commented: execution.commented,
          output: execution.output,
        } satisfies GitCommentPullRequestExecutionResult;
      },
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
          "Available agent kinds: commander, file, shell, browser, computer, scheduler, research, code, verifier",
          "Available built-in view types: chat, automated, skills, apps, documents, gallery, computer",
          "Sidebar groups: primary (top), knowledge (local data), custom (below)",
          "",
          "Rules:",
          "- Generate a single complete workspace definition JSON object",
          "- id must be kebab-case",
          "- icon should be a single emoji",
          "- agents, workflows, routes are optional arrays",
          "- All tool names follow {category}.{action} pattern",
          "- Use only information from the user request; leave optional arrays empty rather than inventing facts.",
          "- Output ONLY the JSON, no markdown fences or explanation",
          "",
          `User request: ${description}`,
        ].join("\n");
        const result = await commander.complete(prompt, {
          maxTokens: 2000,
          temperature: 0.3,
          skipAgentMemory: true,
          skipSkillContext: true,
        });
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
    trendTool: {
      fetchHotList: (request): Promise<TrendHotListResult> => fetchTrendHotList(request),
    },
    memoryTool: {
      search: async (request: MemorySearchRequest): Promise<MemorySearchResult[]> => {
        if (!isAgentMemoryEnabled?.() || !searchAgentMemory) {
          return [];
        }
        return searchAgentMemory({
          ...request,
          taskId: request.taskId ?? taskIdRef.current ?? "task-unknown",
        });
      },
    },
    mcpTool: callMcpTool
      ? {
          call: callMcpTool,
        }
      : undefined,
    browserTool: {
      navigate: (request: BrowserNavigateRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.navigate", `Navigate to ${request.url}.`);
        return invoke<BrowserNavigateResult>("browser_navigate", { request });
      },
      screenshot: (request: BrowserScreenshotRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.screenshot", "Capture browser screenshot.");
        return invoke<BrowserScreenshotResult>("browser_screenshot", { request });
      },
      getContent: (request: BrowserGetContentRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.getContent", `Read browser content as ${request.format ?? "text"}.`);
        return invoke<BrowserGetContentResult>("browser_get_content", { request });
      },
      click: (request: BrowserClickRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.click", `Click selector ${request.selector}.`);
        return runBrowserWriteAction("click", request, (approvedRequest) =>
          invoke<BrowserClickResult>("browser_click", { request: approvedRequest })
        );
      },
      type: (request: BrowserTypeRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.type", `Type into selector ${request.selector}.`);
        return runBrowserWriteAction("type", request, (approvedRequest) =>
          invoke<BrowserTypeResult>("browser_type", { request: approvedRequest })
        );
      },
      evaluate: (request: BrowserEvaluateRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.evaluate", "Evaluate browser script.");
        return runBrowserWriteAction("evaluate", request, (approvedRequest) =>
          invoke<BrowserEvaluateResult>("browser_evaluate", { request: approvedRequest })
        );
      },
      runTest: (request: BrowserRunTestRequest) => {
        notifyWorkspaceToolActivity("browser", "browser.runTest", `Run browser test ${request.testFile ?? "(inline script)"}.`);
        return runBrowserWriteAction("runTest", request, (approvedRequest) =>
          invoke<BrowserRunTestResult>("browser_run_test", { request: approvedRequest })
        );
      },
      extractLinks: (request: BrowserExtractLinksRequest) =>
        invoke<BrowserExtractLinksResult>("browser_extract_links", { request }),
      upload: (_request: BrowserUploadRequest): Promise<BrowserUploadResult> =>
        Promise.reject(createBrowserApprovalError()),
      followCandidateLinks: async (request: BrowserFollowCandidateLinksRequest): Promise<BrowserFollowCandidateLinksResult> => {
        notifyWorkspaceToolActivity("browser", "browser.followCandidateLinks", `Follow up to ${request.maxFollow ?? 3} candidate links.`);
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
      if (preprocessingForNextTask) {
        preprocessingByTaskId.set(taskId, preprocessingForNextTask.promise);
        preprocessingForNextTask = undefined;
      }
    },
    // P0-2: LLM-based ReAct decision maker for agent step execution loops
    reactDecideNext: async (request: ReActDecisionRequest): Promise<AgentReActDecision> => {
      const prompt = buildReActDecisionPrompt({ ...request, locale: "zh-CN" });
      let resultText = "";
      try {
        const result = await providerFor(request.agentKind).complete(prompt, {
          maxTokens: 600,
          temperature: 0,
          locale: "zh-CN",
          skipAgentMemory: true,
          skillContextMaxSkills: 2,
          skillContextMaxChars: 6_000,
        });
        resultText = result.text;
        const parsed = parseJsonObject(result.text) as Record<string, unknown>;
        const rawStatus = parsed.status as string;
        const status: AgentReActDecision["status"] =
          rawStatus === "continue" || rawStatus === "completed" || rawStatus === "failed"
            ? rawStatus
            : "failed";
        return {
          status,
          toolName: parsed.toolName as string | undefined,
          input: isRecord(parsed.input) ? { ...parsed.input } : undefined,
          reason: (parsed.reason as string) ?? "No reason provided.",
          output: parsed.output,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("did not contain a JSON object") && resultText.trim().length > 0) {
          eventBus.emit({
            kind: "tool.planned",
            taskId: taskIdRef.current ?? "task-unknown",
            toolName: "reactDecideNext",
            detail: "ReAct decision LLM returned plain text; failing decision.",
          });
          return {
            status: "failed",
            reason: "ReAct decision LLM returned plain text instead of JSON.",
            output: resultText.trim(),
          };
        }
        eventBus.emit({
          kind: "tool.planned",
          taskId: taskIdRef.current ?? "task-unknown",
          toolName: "reactDecideNext",
          detail: `ReAct decision LLM failed: ${msg}`,
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
      const availableTools = commanderPromptToolDescriptors(getAvailableToolDescriptors?.());
      const availableToolNames = new Set(availableTools.map((tool) => tool.name));
      const availableAgents = demoAgents
        .map((a) => {
          const reg = registry.findByKind(a.kind);
          return {
            kind: a.kind,
            allowedToolNames: allowedToolNamesForAgent(a.kind, availableTools)
              .filter((toolName) => availableToolNames.has(toolName)),
            capabilities: reg?.capabilityTags ?? [],
          };
        });
      const prompt = buildCommanderReplanPrompt({
        userGoal,
        locale: "zh-CN",
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
          skipSkillContext: true,
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
    computerUseLoopRunner: async ({ userGoal, computerTool, allowedToolNames, approveAction, onStep, onProgress, signal }) => {
      const config = getComputerUseConfig?.();
      if (config?.enabled !== true) {
        throw new Error("Computer Use is disabled in settings.");
      }
      const controller = new AbortController();
      activeComputerUseAbortController = controller;
      const abortFromParent = () => controller.abort(signal?.reason ?? new Error("Computer Use cancelled."));
      if (signal?.aborted) {
        abortFromParent();
      } else {
        signal?.addEventListener("abort", abortFromParent, { once: true });
      }
      try {
        return await runComputerUseLoop({
          modelProvider: providerFor("computer"),
          computerTool,
          userGoal,
          allowedToolNames,
          approveAction,
          onStep,
          onProgress,
          signal: controller.signal,
          includeApprovalScreenshotPreview: true,
          config,
        });
      } finally {
        signal?.removeEventListener("abort", abortFromParent);
        if (activeComputerUseAbortController === controller) {
          activeComputerUseAbortController = undefined;
        }
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
    classifyAppsWithAgent(
      apps: { name: string; path: string; publisher?: string; installLocation?: string }[],
      options?: { onBatchProgress?: (completed: number, total: number, failed: number) => void; signal?: AbortSignal },
    ) {
      return classifyApps(apps, providerFor("file"), options);
    },
    clearProviderCache() {
      providerCache.clear();
      providerCache.set("fallback", fallbackProvider);
    },
    evaluateGoalCompletion(goal: GoalState, task: TaskSnapshot): Promise<GoalDecision> {
      return evaluateGoalCompletionWithModelProvider(goal, task, providerFor("verifier"));
    },
    start(userGoal: string, options?: Parameters<typeof runtime.start>[1]) {
      sharedContext.clear();
      currentUserGoalRef.current = userGoal;
      sharedContext.set(sharedContext.resolveKey(CONTEXT_KEYS.USER_GOAL, "zh-CN"), userGoal);
      preprocessingByTaskId.clear();
      preprocessingForNextTask = options?.mode === "chat"
        ? undefined
        : {
            promise: preprocessChineseInput(userGoal, providerFor("commander")),
          };
      runtime.start(userGoal, options);
    },
    stopTask() {
      activeComputerUseAbortController?.abort(new Error("Computer Use cancelled by user."));
      activeComputerUseAbortController = undefined;
      runtime.stopTask("Task cancelled by user.");
      void invoke("cancel_all_model_streams");
      const taskId = taskIdRef.current;
      void invoke("computer_cancel_approvals", { taskId: taskId ?? null });
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
      activeComputerUseAbortController?.abort(new Error("Computer Use runtime disposed."));
      activeComputerUseAbortController = undefined;
      void invoke("cancel_all_model_streams");
      void invoke("computer_cancel_approvals", { taskId: null });
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
  completionOptions: Pick<CompletionOptions, "skipAgentMemory" | "skipSkillContext" | "locale"> = {},
): Promise<T> {
  let fullText: string;

  try {
    fullText = "";
    for await (const chunk of modelProvider.stream(prompt, {
      ...streamOptions,
      locale: "zh-CN",
      ...completionOptions,
    })) {
      fullText += chunk.text;
      onChunk(chunk);
    }
  } catch {
    // Provider doesn't support SSE — fall back to non-streaming complete()
    const result = await modelProvider.complete(prompt, { ...streamOptions, locale: "zh-CN", ...completionOptions });
    onChunk({ text: result.text });
    return parseNormalizeWithRepair(prompt, result.text, streamOptions, modelProvider, normalize, completionOptions);
  }

  return parseNormalizeWithRepair(prompt, fullText, streamOptions, modelProvider, normalize, completionOptions);
}

async function parseNormalizeWithRepair<T>(
  originalPrompt: string,
  rawText: string,
  streamOptions: { maxTokens: number; temperature: number },
  modelProvider: ModelProvider,
  normalize: (value: unknown) => T,
  completionOptions: Pick<CompletionOptions, "skipAgentMemory" | "skipSkillContext" | "locale"> = {},
): Promise<T> {
  try {
    return normalize(parseJsonObject(rawText));
  } catch (error) {
    if (!isJsonParseFailure(error)) {
      throw error;
    }
    const repairLocale = completionOptions.locale ?? "zh-CN";
    const repaired = await modelProvider.complete(buildJsonRepairPrompt(originalPrompt, rawText, repairLocale), {
      ...streamOptions,
      locale: repairLocale,
      ...completionOptions,
      skipSkillContext: true,
    });
    return normalize(parseJsonObject(repaired.text));
  }
}

function buildJsonRepairPrompt(originalPrompt: string, rawText: string, locale = "en"): string {
  const promptLocale = normalizePromptLocale(locale);
  return (promptLocale === "zhCN"
    ? [
        "你之前的输出不是所需 schema 的有效 JSON。",
        "把它转换为一个满足原始指令的有效 JSON 对象。",
        "只修复语法/结构；保留语义，不补事实，不改变决策。",
        "只返回 JSON 对象。不要使用 Markdown 代码块。不要解释。",
        "",
        "原始指令:",
        originalPrompt,
        "",
        "之前的无效输出:",
        rawText,
      ]
    : [
        "Your previous output was not valid JSON for the required schema.",
        "Convert it into one valid JSON object that satisfies the original instruction.",
        "Only repair syntax/shape; preserve semantics, do not add facts, and do not change decisions.",
        "Return ONLY the JSON object. Do not use markdown fences. Do not explain.",
        "",
        "Original instruction:",
        originalPrompt,
        "",
        "Previous invalid output:",
        rawText,
      ]).join("\n");
}

function isJsonParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("JSON") ||
    error.message.includes("Unexpected token") ||
    error.message.includes("Unexpected end")
  );
}

async function planWithModelProviderStreaming(
  request: CommanderPlanRequest,
  modelProvider: ModelProvider,
  onChunk: (chunk: { text: string }) => void,
  buildMemoryContext?: (request: CommanderPlanRequest) => Promise<string>,
  fallbackToolDescriptors?: ToolDescriptor[],
): Promise<CommanderPlanResult> {
  // Enrich available agents with capability tags so the Commander can
  // plan by capability rather than hardcoded agent kind.
  const registry = createDefaultAgentRegistry();
  const effectiveTools = commanderPromptToolDescriptors(
    request.availableTools ?? fallbackToolDescriptors,
  );
  const effectiveToolNames = new Set(effectiveTools.map((tool) => tool.name));
  const agentsWithCapabilities = request.availableAgents.map((a) => {
    const reg = registry.findByKind(a.kind);
    return {
      kind: a.kind,
      allowedToolNames: allowedToolNamesForAgent(a.kind, effectiveTools)
        .filter((toolName) => effectiveToolNames.has(toolName)),
      capabilities: reg?.capabilityTags ?? [],
    };
  });
  const validationRequest: CommanderPlanRequest = {
    ...request,
    availableAgents: agentsWithCapabilities.map(({ kind, allowedToolNames }) => ({
      kind,
      allowedToolNames,
    })),
    availableTools: effectiveTools,
  };

  const memoryContext = (await buildMemoryContext?.(request))?.trim() ?? "";
  const prompt = appendCommanderMemoryContext(
    buildCommanderPlanPrompt({
      userGoal: request.userGoal,
      locale: "zh-CN",
      priorMessages: request.priorMessages,
      omittedPriorMessageCount: request.omittedPriorMessageCount,
      workflowId: request.workflowId ?? "unknown",
      availableAgents: agentsWithCapabilities,
      availableTools: effectiveTools,
    }),
    memoryContext,
    "zh-CN",
  );

  return streamOrCompleteWithReview(
    prompt,
    { maxTokens: 1600, temperature: 0 },
    modelProvider,
    onChunk,
    (value) => normalizeCommanderPlan(value, validationRequest),
  );
}

function withPreprocessedCommanderGoal(
  request: CommanderPlanRequest,
  preprocessedInput: PreprocessedInput | undefined,
): CommanderPlanRequest {
  if (!preprocessedInput) {
    return request;
  }
  return {
    ...request,
    userGoal: [
      request.userGoal,
      "",
      "Chinese input preprocessing result for planning:",
      JSON.stringify(preprocessedInput),
    ].join("\n"),
  };
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
      "Do not invent missing evidence; use warn/fail when evidence is absent, ambiguous, or only asserted.",
      "Schema: {\"status\":\"pass|warn|fail\",\"summary\":\"string\",\"detail\":\"string\"}",
      `Step id: ${request.stepId}`,
      `Success criteria: ${request.successCriteria}`,
      `Evidence: ${JSON.stringify(request.evidence)}`,
    ].join("\n"),
    { maxTokens: 900, temperature: 0 },
    modelProvider,
    onChunk,
    (value) => normalizeVerifierCheck(value),
    { skipAgentMemory: true, skipSkillContext: true },
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
        skipAgentMemory: true,
        skipSkillContext: true,
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
        skipAgentMemory: true,
        skipSkillContext: true,
      })).text,
    );
    return { ...result, text: revised.text };
  } catch {
    return result;
  }
}

async function evaluateGoalCompletionWithModelProvider(
  goal: GoalState,
  task: TaskSnapshot,
  modelProvider: ModelProvider,
): Promise<GoalDecision> {
  try {
    const result = await modelProvider.complete(buildGoalEvaluationPrompt(goal, task), {
      maxTokens: 700,
      temperature: 0,
      locale: "zh-CN",
      skipAgentMemory: true,
      skipSkillContext: true,
    });
    const parsed = parseJsonObject(result.text) as Record<string, unknown>;
    const rawStatus = typeof parsed.decision === "string"
      ? parsed.decision
      : typeof parsed.status === "string"
        ? parsed.status
        : "";
    let status: GoalDecision["status"] =
      rawStatus === "complete" || rawStatus === "continue" || rawStatus === "blocked"
        ? rawStatus
        : "continue";
    const confidence = normalizeGoalConfidence(parsed.confidence);
    const satisfiedCriteria = normalizeGoalStringArray(parsed.satisfiedCriteria) ?? [];
    const unsatisfiedCriteria = normalizeGoalStringArray(parsed.unsatisfiedCriteria) ?? [];
    const evidence = normalizeGoalStringArray(parsed.evidence) ?? [];
    const completedChecks = normalizeGoalStringArray(parsed.completedChecks) ?? satisfiedCriteria;
    const blockedReason = optionalGoalString(parsed.blockedReason);
    let reason = optionalGoalString(parsed.reason);
    if (status === "complete" && (confidence === "low" || unsatisfiedCriteria.length > 0 || evidence.length === 0)) {
      status = "continue";
      reason = [
        reason,
        confidence === "low" ? "Verifier confidence was low, so Goal cannot be marked complete." : "",
        unsatisfiedCriteria.length > 0 ? `Unsatisfied criteria remain: ${unsatisfiedCriteria.join("; ")}` : "",
        evidence.length === 0 ? "Verifier did not provide concrete evidence, so Goal cannot be marked complete." : "",
      ].filter(Boolean).join(" ");
    }
    if (status === "blocked" && !blockedReason) {
      status = "continue";
      reason = [reason, "Verifier did not provide a blockedReason, so Javis will continue conservatively."]
        .filter(Boolean)
        .join(" ");
    }
    return {
      status,
      confidence,
      satisfiedCriteria,
      unsatisfiedCriteria,
      evidence,
      completedChecks,
      blockedReason,
      nextPrompt: optionalGoalString(parsed.nextPrompt),
      reason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "continue",
      reason: `Goal evaluation failed; continuing conservatively: ${message}`,
      nextPrompt: buildFallbackGoalContinuationPrompt(goal, task),
    };
  }
}

function buildGoalEvaluationPrompt(goal: GoalState, task: TaskSnapshot): string {
  const recentLogs = (task.logs ?? [])
    .slice(-8)
    .map((log) => `- ${log.title}: ${log.detail}`)
    .join("\n");
  const planSummary = (task.plan ?? [])
    .map((step) => `- ${step.id}: ${step.status}${step.successCriteria ? `; criteria=${step.successCriteria}` : ""}`)
    .join("\n");
  return [
    "You are the Javis Goal Verifier. Decide whether the long-running Goal is complete.",
    "Return only one JSON object. Do not use markdown or explanatory prose.",
    "JSON schema: {\"decision\":\"complete|continue|blocked\",\"confidence\":\"low|medium|high\",\"satisfiedCriteria\":string[],\"unsatisfiedCriteria\":string[],\"evidence\":string[],\"completedChecks\":string[],\"blockedReason\"?:string,\"nextPrompt\"?:string,\"reason\":string}",
    "Decision rules:",
    "- complete: the latest task evidence proves the objective and acceptance criteria are satisfied.",
    "- complete requires confidence=medium or high, unsatisfiedCriteria=[], and concrete evidence.",
    "- continue: the goal is not complete, but there is a clear next step. Include nextPrompt.",
    "- blocked: user input, external state, or repeated failures prevent progress. Include blockedReason.",
    "- Do not mark blocked after one ordinary failure when another investigation or fix path remains.",
    "- Put every still-missing acceptance criterion in unsatisfiedCriteria.",
    "- Put file paths, test names, terminal summaries, or other concrete proof in evidence.",
    "",
    `Goal objective: ${goal.objective}`,
    `Acceptance criteria: ${goal.acceptanceCriteria.join(" | ")}`,
    `Completed checks so far: ${goal.completedChecks.join(" | ") || "none"}`,
    `Run count: ${goal.runCount}/${goal.maxRunCount}`,
    "",
    `Latest task status: ${task.status}`,
    `Latest task goal: ${task.userGoal}`,
    `Commander message: ${truncateForPrompt(task.commanderMessage, 1800)}`,
    task.verificationSummary ? `Verification summary: ${truncateForPrompt(task.verificationSummary, 1000)}` : "",
    task.userFacingError ? `User-facing error: ${truncateForPrompt(task.userFacingError, 1000)}` : "",
    planSummary ? `Plan summary:\n${truncateForPrompt(planSummary, 1400)}` : "",
    recentLogs ? `Recent logs:\n${truncateForPrompt(recentLogs, 1400)}` : "",
    "",
    "If continuing, nextPrompt must be a direct task prompt for the next Javis project-mode run. Include the Goal objective, completed checks, and the next verification step.",
  ].filter(Boolean).join("\n");
}

function buildFallbackGoalContinuationPrompt(goal: GoalState, task: TaskSnapshot): string {
  return [
    `Continue the Goal: ${goal.objective}`,
    goal.completedChecks.length > 0 ? `Completed checks: ${goal.completedChecks.join("; ")}` : "",
    `Previous task status: ${task.status}`,
    task.userFacingError ? `Previous task error: ${task.userFacingError}` : "",
    "Choose the smallest useful next investigation or fix, run the relevant verification, and report the result.",
  ].filter(Boolean).join("\n");
}

function truncateForPrompt(value: string | undefined, maxLength: number): string {
  const text = value?.trim() ?? "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

function normalizeGoalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).replace(/\s+/g, " ").trim()).filter(Boolean);
}

function normalizeGoalConfidence(value: unknown): GoalDecision["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function optionalGoalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
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

export async function resolveImageDataUrl(imagePath: string, workspacePath?: string): Promise<string> {
  const trimmed = imagePath.trim();
  if (!trimmed) {
    throw new Error("Image path cannot be empty.");
  }
  if (/^data:image\//i.test(trimmed)) {
    return validateImageDataUrl(trimmed);
  }
  const workspaceRoot = workspacePath?.trim();
  if (!workspaceRoot) {
    throw new Error("Local image paths require a selected workspace.");
  }
  // Resolve relative paths against workspace
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/");
  const resolved = isAbsolute
    ? trimmed
    : `${workspaceRoot.replace(/[\\/]$/, "")}/${trimmed}`;
  // Verify containment before invoking the native reader; Rust repeats this
  // with canonical paths so this check is only an early UX guard.
  const ws = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const target = resolved.replace(/\\/g, "/").toLowerCase();
  if (!target.startsWith(ws + "/") && target !== ws) {
    throw new Error(`Image path is outside the current workspace: ${trimmed}`);
  }
  return invoke<string>("read_image_data_url", {
    path: resolved,
    workspaceRoot,
    allowedRootIds: null,
  });
}
function appendCommanderMemoryContext(prompt: string, memoryContext: string, locale = "en"): string {
  if (!memoryContext.trim()) {
    return prompt;
  }
  const promptLocale = normalizePromptLocale(locale);
  return [
    prompt,
    "",
    promptLocale === "zhCN" ? "Commander 任务经验和记忆:" : "Commander task lessons and memory:",
    promptLocale === "zhCN"
      ? "仅作低 token 提示；优先压成 lesson/blocker/next/confidence，使用前必须用当前证据验证。"
      : "Compact hints only; prefer lesson/blocker/next/confidence and verify current evidence before using them.",
    memoryContext.trim(),
  ].join("\n");
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
  const rawSteps = Array.isArray(value.steps)
    ? value.steps
    : Array.isArray(value.plan)
      ? value.plan
      : [];
  const steps = rawSteps.length > 0
    ? rawSteps.filter(isRecord).map((step, index) =>
        normalizeCommanderStep(step, index, request, value.needsClarification === true),
      )
    : [];
  return {
    title: stringValue(value.title, "Project workflow plan"),
    reasoning: stringValue(
      value.reasoning,
      stringValue(value.riskSummary, "Commander prepared a workflow plan."),
    ),
    steps,
  };
}

function normalizeCommanderStep(
  step: Record<string, unknown>,
  index: number,
  request: CommanderPlanRequest,
  planNeedsClarification = false,
): CommanderPlanResult["steps"][number] {
  const assignedAgentKind = stringValue(step.assignedAgentKind, stringValue(step.agentKind, "commander"));
  const isClarificationStep =
    index === 0 &&
    planNeedsClarification &&
    assignedAgentKind === "commander" &&
    typeof step.toolName !== "string" &&
    typeof step.capability !== "string";
  const toolName = typeof step.toolName === "string" && step.toolName.trim()
    ? step.toolName.trim()
    : isClarificationStep
      ? "commander.askUser"
    : undefined;
  if (toolName) {
    validateCommanderStepToolName(assignedAgentKind, toolName, request);
  }

  // Validate capability tag if present
  const rawCapability = typeof step.capability === "string" && step.capability.trim()
    ? step.capability.trim()
    : undefined;
  let capability: string | undefined;
  if (rawCapability) {
    if (!isValidCapabilityTag(rawCapability)) {
      console.warn(
        `[CommanderPlan] Step "${String(step.id || `step-${index + 1}`)}": ` +
        `invalid capability tag "${rawCapability}" — ignored.`,
      );
    } else {
      capability = rawCapability;
    }
  }

  // Filter requiredCapabilities to only valid tags
  const rawRequiredCaps = Array.isArray(step.requiredCapabilities)
    ? step.requiredCapabilities.filter((c): c is string => typeof c === "string")
    : [];
  const requiredCapabilities = rawRequiredCaps.length > 0
    ? rawRequiredCaps.filter((c) => {
        if (!isValidCapabilityTag(c)) {
          console.warn(
            `[CommanderPlan] Step "${String(step.id || `step-${index + 1}`)}": ` +
            `invalid requiredCapability "${c}" — removed.`,
          );
          return false;
        }
        return true;
      })
    : undefined;

  return {
    id: stringValue(step.id, `step-${index + 1}`),
    title: isClarificationStep
      ? stringValue(step.successCriteria, stringValue(step.title, "Please clarify your request."))
      : stringValue(step.title, `Step ${index + 1}`),
    assignedAgentKind,
    toolName,
    capability,
    requiredCapabilities,
    dependsOn: Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((d): d is string => typeof d === "string")
      : undefined,
    inputContextKeys: normalizeStringArray(step.inputContextKeys),
    toolInput: isRecord(step.toolInput) ? { ...step.toolInput } : undefined,
    outputContextKey: typeof step.outputContextKey === "string" && step.outputContextKey.trim()
      ? step.outputContextKey.trim()
      : undefined,
    choices: normalizeAskUserChoices(step.choices),
    executionMode: normalizeStepExecutionMode(step.executionMode),
    successCriteria: stringValue(step.successCriteria, "Step completed with evidence."),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeStepExecutionMode(value: unknown): CommanderPlanResult["steps"][number]["executionMode"] | undefined {
  return value === "direct_response" || value === "direct_tool_call" || value === "react"
    ? value
    : undefined;
}

function normalizeAskUserChoices(value: unknown): CommanderPlanResult["steps"][number]["choices"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const choices: Array<string | AskUserChoice> = [];
  for (const choice of value) {
    if (typeof choice === "string") {
      const trimmed = choice.trim();
      if (trimmed) {
        choices.push(trimmed);
      }
      continue;
    }
    if (!isRecord(choice)) {
      continue;
    }
    const label = typeof choice.label === "string" ? choice.label.trim() : "";
    const choiceValue = typeof choice.value === "string" ? choice.value.trim() : "";
    if (!label || !choiceValue) {
      continue;
    }
    choices.push({
      label,
      value: choiceValue,
      isRecommended: choice.isRecommended === true,
    });
  }
  return choices.length > 0 ? choices : undefined;
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
  if (request.availableTools && !descriptor) {
    throw new Error(`Commander plan assigned unknown tool ${toolName}.`);
  }
  if (descriptor && !descriptor.ownerAgentKinds.includes(assignedAgentKind)) {
    throw new Error(`Commander plan assigned tool ${toolName} to non-owner agent ${assignedAgentKind}.`);
  }
}

function normalizeVerifierCheck(value: unknown): VerifierCheckResult {
  if (!isRecord(value)) {
    throw new Error("Verifier check response must be an object.");
  }
  if (value.status !== "pass" && value.status !== "warn" && value.status !== "fail") {
    return {
      status: "fail",
      summary: "Verifier returned invalid status.",
      detail: "Verifier check response must include status pass, warn, or fail.",
    };
  }
  return {
    status: value.status,
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

function createBrowserApprovalError(): Error {
  return new Error("Browser write operation requires native approval and is disabled until browser approvals are implemented.");
}

async function readChangedFilesForRepositoryPriority(
  runCommand: (request: ShellCommandRequest) => Promise<{ exitCode: number | null; stdout: string }>,
): Promise<string[]> {
  try {
    const status = await runCommand({ program: "git", args: ["status", "--short"], workspacePath: null });
    if (status.exitCode !== 0) return [];
    return parseGitStatusFiles(status.stdout);
  } catch {
    return [];
  }
}

function proposeCodeEditWithModelProvider(
  userGoal: string,
  preview: CodeReviewPreview,
  modelProvider: ModelProvider,
  taskId?: string,
): Promise<CodeProposedEdit> {
  return invoke<CodeProposedEdit>("propose_code_edit", {
    request: {
      workspacePath: preview.workspacePath,
      userGoal,
      changedFiles: preview.changedFiles,
      diff: preview.diff,
      taskId,
      providerId: modelProvider.settings.provider,
      model: modelProvider.settings.model,
      apiKeyReference: modelProvider.settings.apiKeyReference,
      baseUrl: modelProvider.settings.baseUrl,
      locale: "zh-CN",
    },
  });
}
