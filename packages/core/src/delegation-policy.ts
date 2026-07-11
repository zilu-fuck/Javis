import type { PermissionLevel, ToolDescriptor } from "@javis/tools";
import type { Agent } from "./index";

export type DelegationMode = "parent_coordinated" | "read_preview_subagents";

export interface DelegationPolicy {
  mode: DelegationMode;
  maxPermissionLevel: Exclude<PermissionLevel, "confirmed_write" | "dangerous">;
  parentCoordinatedPermissionLevels: Array<Extract<PermissionLevel, "confirmed_write" | "dangerous">>;
}

export const READ_PREVIEW_SUBAGENT_DELEGATION_POLICY: DelegationPolicy = {
  mode: "read_preview_subagents",
  maxPermissionLevel: "preview",
  parentCoordinatedPermissionLevels: ["confirmed_write", "dangerous"],
};

export function canDelegateToolToSubAgent(
  descriptor: Pick<ToolDescriptor, "permissionLevel">,
  policy: DelegationPolicy = READ_PREVIEW_SUBAGENT_DELEGATION_POLICY,
): boolean {
  return permissionLevelRank(descriptor.permissionLevel) <= permissionLevelRank(policy.maxPermissionLevel);
}

export function filterDelegableToolDescriptors(
  descriptors: readonly ToolDescriptor[],
  policy: DelegationPolicy = READ_PREVIEW_SUBAGENT_DELEGATION_POLICY,
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => canDelegateToolToSubAgent(descriptor, policy));
}

export function filterAgentForDelegation(
  agent: Agent,
  descriptors: readonly ToolDescriptor[],
  policy: DelegationPolicy = READ_PREVIEW_SUBAGENT_DELEGATION_POLICY,
): Agent {
  const delegableTools = new Set(
    filterDelegableToolDescriptors(descriptors, policy)
      .map((descriptor) => descriptor.name),
  );
  return {
    ...agent,
    allowedToolNames: agent.allowedToolNames.filter((toolName) => delegableTools.has(toolName)),
  };
}

export function assertDelegatedToolIsReadOrPreview(
  descriptor: Pick<ToolDescriptor, "name" | "permissionLevel">,
  policy: DelegationPolicy = READ_PREVIEW_SUBAGENT_DELEGATION_POLICY,
): void {
  if (canDelegateToolToSubAgent(descriptor, policy)) {
    return;
  }
  throw new Error(
    `Tool ${descriptor.name} requires ${descriptor.permissionLevel} and must remain parent-coordinated.`,
  );
}

function permissionLevelRank(level: PermissionLevel): number {
  switch (level) {
    case "read":
      return 0;
    case "preview":
      return 1;
    case "confirmed_write":
      return 2;
    case "dangerous":
      return 3;
  }
}
