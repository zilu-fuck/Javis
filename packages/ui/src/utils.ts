import type { WorkbenchHistoryEntry, WorkbenchLocale, WorkbenchTask } from "./types";

export function formatSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWorkspaceName(path: string) {
  const normalizedPath = path.trim().replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const parts = normalizedPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalizedPath;
}

export function formatTokenCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function isResearchFallbackTask(task: WorkbenchTask): boolean {
  if (task.status !== "failed") {
    return false;
  }

  const researchText = [
    task.title,
    task.commanderMessage,
    task.verificationSummary ?? "",
  ].join(" ");
  return /\bResearch\b/i.test(researchText);
}

export function filterWorkbenchHistoryEntries(
  entries: WorkbenchHistoryEntry[],
  query: string,
): WorkbenchHistoryEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => {
    const searchableText = [
      entry.title,
      entry.status,
      entry.userGoal,
      entry.updatedAt,
      entry.workspacePath ?? "",
    ].join(" ");
    return searchableText.toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function formatModifiedTime(modifiedAt: string) {
  const date = new Date(modifiedAt);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString();
  }

  const seconds = Number(modifiedAt);
  if (!Number.isFinite(seconds)) {
    return modifiedAt;
  }
  return new Date(seconds * 1000).toLocaleString();
}

export function translateWorkbenchText(value: string, locale: WorkbenchLocale): string {
  const phrases = locale.phrases;
  if (!phrases) {
    return value;
  }
  const trimmed = value.trim();
  const leadingSpace = value.startsWith(" ") ? " " : "";
  if (phrases[trimmed]) {
    return leadingSpace + phrases[trimmed];
  }

  return translateWorkbenchPattern(value);
}

function translateWorkbenchPattern(value: string): string {
  return value
    .replace(/\bnot found\b/g, "未找到")
    .replace(/\bverified\b/g, "已验证")
    .replace(/\bfailed\b/g, "失败")
    .replace(/\bskipped\b/g, "已跳过")
    .replace(/\bmoved\b/g, "已移动")
    .replace(/\bplanned operation\(s\)\b/g, "项计划操作")
    .replace(/\bplanned path operation\(s\) require\b/g, "项计划路径操作需要")
    .replace(/\brequire confirmed_write\b/g, "需要确认写入授权")
    .replace(/\bsource\(s\)\b/g, "个来源")
    .replace(/\bdocument records\b/g, "条文档记录")
    .replace(/\bdocuments\b/g, "个文档")
    .replace(/\brecords\b/g, "条记录")
    .replace(/\bcommands\b/g, "条命令")
    .replace(/\bclaims verified\b/g, "条主张已验证")
    .replace(/\bTask finished\b/g, "任务已完成")
    .replace(/\bPlan submitted\b/g, "计划已提交")
    .replace(/\bWaiting for verification\b/g, "等待验证")
    .replace(/\bNo file scan needed\b/g, "无需文件扫描")
    .replace(/\bRead-only scan completed\b/g, "只读扫描已完成")
    .replace(/\bSource collection completed\b/g, "来源收集已完成")
    .replace(/\bChecking exit codes\b/g, "检查退出码")
    .replace(/\bChecking source evidence\b/g, "检查来源证据")
    .replace(/\bChecking document result fields\b/g, "检查文档结果字段")
    .replace(/\bNo result to verify\b/g, "没有可验证结果")
    .replace(/\bNo source to verify\b/g, "没有可验证来源")
    .replace(/\bScan failed\b/g, "扫描失败")
    .replace(/\bVerification failed\b/g, "验证失败")
    .replace(/\bDry-run failed\b/g, "预演失败")
    .replace(/\bExecution tool unavailable\b/g, "执行工具不可用")
    .replace(/\bApproved move failed\b/g, "已批准移动失败")
    .replace(/\bPermission decision recorded\b/g, "授权决定已记录")
    .replace(/\bNo write operation executed\b/g, "未执行写入操作")
    .replace(/\bWaiting for user approval\b/g, "等待用户批准")
    .replace(/\bWaiting for permission decision\b/g, "等待授权决定")
    .replace(/\bWaiting for dry-run evidence\b/g, "等待预演证据")
    .replace(/\bWaiting for move results\b/g, "等待移动结果")
    .replace(/\bWaiting for command results\b/g, "等待命令结果")
    .replace(/\bWaiting for source evidence\b/g, "等待来源证据")
    .replace(/\bWaiting for file scan results\b/g, "等待文件扫描结果")
    .replace(/\bWaiting for project inspection\b/g, "等待项目检查")
    .replace(/\bWaiting for file\.scanMarkdownDocuments\b/g, "等待 file.scanMarkdownDocuments")
    .replace(/\bCreate document scan plan\b/g, "创建文档扫描计划")
    .replace(/\bCreate project inspection plan\b/g, "创建项目检查计划")
    .replace(/\bCreate research source plan\b/g, "创建研究来源计划")
    .replace(/\bCreate dry-run plan\b/g, "创建预演计划")
    .replace(/\bCreating PDF organization dry-run\b/g, "创建 PDF 整理预演")
    .replace(/\bExecuting approved PDF moves\b/g, "执行已批准的 PDF 移动")
    .replace(/\bRunning read-only Markdown scan\b/g, "运行只读 Markdown 扫描")
    .replace(/\bRunning node\/pnpm\/git read-only checks\b/g, "运行 node/pnpm/git 只读检查")
    .replace(/\bInspecting package scripts\b/g, "检查包脚本")
    .replace(/\bFetching public URL sources\b/g, "获取公开 URL 来源")
    .replace(/\bSource fetch failed\b/g, "来源获取失败")
    .replace(/\bDocument scan and summaries completed\b/g, "文档扫描与摘要已完成")
    .replace(/\bRead-only command checks completed\b/g, "只读命令检查已完成")
    .replace(/\bpermission\.requested\b/g, "permission.requested")
    .replace(/\bpermission\.resolved\b/g, "permission.resolved")
    .replace(/\btask\.created\b/g, "task.created")
    .replace(/\btask\.completed\b/g, "task.completed")
    .replace(/\btask\.failed\b/g, "task.failed")
    .replace(/\btask\.plan_updated\b/g, "task.plan_updated")
    .replace(/\btool_call\.planned\b/g, "tool_call.planned")
    .replace(/\btool_call\.updated\b/g, "tool_call.updated")
    .replace(/\bverification\.started\b/g, "verification.started")
    .replace(/\bverification\.completed\b/g, "verification.completed")
    .replace(/\bverification\.failed\b/g, "verification.failed")
    .replace(
      /\bJavis desktop is ready\. Enter a goal to start the Core event stream\./g,
      "Javis 桌面端已就绪。输入目标即可启动核心事件流。",
    )
    .replace(
      /\bCore runtime is ready for startTask\./g,
      "核心运行时已就绪，可以开始任务。",
    )
    .replace(/\bMoving files changes the local filesystem, so Javis needs explicit approval\./g, "移动文件会更改本地文件系统，因此 Javis 需要明确授权。")
    .replace(/\bApprove PDF move plan\b/g, "批准 PDF 移动计划")
    .replace(/\bOrganize PDF files by filename topic\b/g, "按文件名主题整理 PDF 文件")
    .replace(/\bTarget file already exists\./g, "目标文件已存在。")
    .replace(/\bOnly PDF files can be moved\./g, "只能移动 PDF 文件。")
    .replace(/\bParent directory traversal is not allowed\./g, "不允许父目录穿越。")
    .replace(/\bSource and target must both stay inside Downloads\./g, "源路径和目标路径都必须位于下载目录内。")
    .replace(/\bOnly move operations are supported\./g, "仅支持移动操作。")
    .replace(/\bSource cannot be read:/g, "无法读取源文件：");
}
