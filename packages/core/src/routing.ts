import type { ShellCommandRequest } from "@javis/tools";

export function isProjectInspectionGoal(userGoal: string): boolean {
  return /\u9879\u76ee|\u542f\u52a8|\u6d4b\u8bd5|\u73af\u5883|\u547d\u4ee4|project|test|start|environment/i.test(
    userGoal,
  );
}

export function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s)]+/g), (match) => match[0]);
}

export function isResearchGoal(userGoal: string): boolean {
  return /research|source|sources|compare|collect|search|web|\u7814\u7a76|\u641c\u7d22|\u8d44\u6599|\u6765\u6e90|\u5bf9\u6bd4|\u6536\u96c6/i.test(
    userGoal,
  );
}

export function isPdfOrganizationGoal(userGoal: string): boolean {
  return /pdf|downloads|download|organize|move|sort|\u6574\u7406|\u79fb\u52a8|\u5206\u7c7b/i.test(
    userGoal,
  );
}

export function createRecommendedCommandRequest(command?: string): ShellCommandRequest | undefined {
  if (!command) {
    return undefined;
  }

  const [program, ...args] = command.split(/\s+/).filter(Boolean);
  if (!program) {
    return undefined;
  }

  return {
    program,
    args,
    workspacePath: null,
  };
}
