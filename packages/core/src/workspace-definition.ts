import type { AgentKind, PermissionLevel } from "./index";
import type { ModelRequirements } from "./agent-capability";

// ── Workspace Definition (on-disk JSON format) ─────────────────────────────

export interface WorkspaceDefinition {
  /** Kebab-case identifier, e.g. "writing-workbench" */
  id: string;
  /** Display name shown in sidebar and headers */
  title: string;
  /** Single emoji or Unicode character for the sidebar icon */
  icon: string;
  /** One-line description */
  description: string;

  /** Which built-in view component to render (e.g. "chat"). Custom views not yet supported. */
  viewType: string;

  // Sidebar placement
  /** Sidebar group: primary (top), knowledge (local data), or custom (below). */
  sidebarGroup: "primary" | "knowledge" | "custom";
  /** Sort order within the group (lower = higher). */
  sidebarOrder: number;

  // Optional registrations — each array merges into the relevant registry
  agents?: WorkspaceAgentDefinition[];
  workflows?: WorkspaceWorkflowDefinition[];
  tools?: WorkspaceToolDefinition[];
  routes?: WorkspaceRouteDefinition[];

  // Lifecycle
  /** Semver of the workspace definition schema */
  version: string;
  /** Whether this workspace is active */
  enabled: boolean;
  /** Author attribution (optional) */
  author?: string;
}

// ── Agent Definition ───────────────────────────────────────────────────────

export interface WorkspaceAgentDefinition {
  /** Unique agent id, e.g. "agent-proofreader" */
  id: string;
  /** Must be one of the known agent kinds */
  kind: AgentKind;
  displayName: string;
  description: string;
  /** Tool names this agent is allowed to use */
  allowedToolNames: string[];
  /** Model requirements for capability-aware dispatch */
  modelRequirements?: ModelRequirements;
  /** Bilingual system prompt */
  systemPrompt: {
    en: string;
    zhCN: string;
  };
}

// ── Workflow Definition ────────────────────────────────────────────────────

export interface WorkspaceWorkflowDefinition {
  id: string;
  title: string;
  triggerExamples: string[];
  goal: string;
  coordinatorAgentKind: Extract<AgentKind, "commander">;
  participatingAgentKinds: string[];
  steps: WorkspaceWorkflowStepDefinition[];
  currentSupport: "implemented" | "partial" | "planned";
  safetyNotes: string[];
}

export interface WorkspaceWorkflowStepDefinition {
  id: string;
  title: string;
  agentKind: AgentKind;
  requiredCapabilities?: string[];
  input: string;
  output: string;
  permissionLevel: PermissionLevel;
  dependsOn: string[];
  canRunInParallel: boolean;
}

// ── Tool Definition ───────────────────────────────────────────────────────

export interface WorkspaceToolDefinition {
  /** Tool name following {category}.{action} pattern */
  name: string;
  permissionLevel: PermissionLevel;
  summary: string;
}

// ── Route Definition ──────────────────────────────────────────────────────

export interface WorkspaceRouteDefinition {
  /** Unique route kind identifier */
  routeKind: string;
  /** Target workflow id to dispatch to when this route matches */
  workflowId: string;
  /** Declarative scoring rules */
  scoring: {
    keywordPatterns: Array<{
      /** Regex pattern (as a string for JSON serialization) */
      pattern: string;
      /** Positive integer score weight */
      weight: number;
      /** Label for debugging */
      signalName: string;
    }>;
    contextFlags?: Array<{
      /** Context flag name (e.g. "hasGitChanges") */
      flag: string;
      weight: number;
      signalName: string;
    }>;
    /** Minimum score to match (default: 2) */
    threshold?: number;
  };
}
