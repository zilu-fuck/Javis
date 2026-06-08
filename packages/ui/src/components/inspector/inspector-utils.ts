import type { WorkbenchAgent, WorkbenchLocale, WorkbenchSystemResources } from "../../types";
import { isChineseLocale } from "../../utils";

export function normalizeMetricPercent(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function formatMetricPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${normalizeMetricPercent(value)}%`;
}

export function formatMemoryMetric(resources: WorkbenchSystemResources | undefined): string {
  if (!resources || typeof resources.memoryPercent !== "number" || !Number.isFinite(resources.memoryPercent)) return "--";
  if (resources.memoryTotalBytes && resources.memoryUsedBytes) {
    return `${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)}`;
  }
  return `${normalizeMetricPercent(resources.memoryPercent)}%`;
}

export function agentKind(agent: WorkbenchAgent): string {
  const text = `${agent.name} ${agent.role}`.toLowerCase();
  if (text.includes("research") || text.includes("search")) return "research";
  if (text.includes("file") || text.includes("document") || text.includes("write")) return "file";
  if (text.includes("command") || text.includes("shell")) return "command";
  if (text.includes("code") || text.includes("program")) return "code";
  if (text.includes("computer") || text.includes("desktop")) return "computer";
  if (text.includes("commander") || text.includes("plan")) return "commander";
  return "agent";
}

export function agentIcon(agent: WorkbenchAgent): string {
  switch (agentKind(agent)) {
    case "research":
      return "R";
    case "file":
      return "F";
    case "command":
      return ">";
    case "code":
      return "</>";
    case "computer":
      return "PC";
    case "commander":
      return "C";
    default:
      return "A";
  }
}

export function normalizeStatus(status: string): "completed" | "running" | "failed" | "waiting" | "idle" {
  const text = status.toLowerCase();
  if (text.includes("complete") || text.includes("done") || text.includes("success")) return "completed";
  if (text.includes("run") || text.includes("stream")) return "running";
  if (text.includes("fail") || text.includes("error")) return "failed";
  if (text.includes("wait") || text.includes("pending") || text.includes("queued")) return "waiting";
  return "idle";
}

export function agentStatusLabel(status: string, locale: WorkbenchLocale): string {
  const isChinese = isChineseLocale(locale);
  switch (normalizeStatus(status)) {
    case "completed":
      return isChinese ? "已完成" : "Completed";
    case "running":
      return isChinese ? "运行中" : "Running";
    case "failed":
      return isChinese ? "失败" : "Failed";
    case "waiting":
      return isChinese ? "等待中" : "Waiting";
    default:
      return isChinese ? "空闲中" : "Idle";
  }
}

export function agentProgress(status: string): number {
  switch (normalizeStatus(status)) {
    case "completed":
      return 100;
    case "running":
      return 68;
    case "failed":
      return 100;
    case "waiting":
      return 18;
    default:
      return 8;
  }
}

function formatBytes(value: number): string {
  const gib = value / 1024 / 1024 / 1024;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)}GB`;
}
