import {
  inferPrimarySpecialistAgentHint,
  isCodebaseUnderstandingRequest,
} from "../agent-intent";
import { detectCommanderPlanIntents } from "./plan-legality";

export interface CommanderRouteRequirement {
  agentKind: string;
  displayName: string;
  capabilities: string[];
  reason: string;
  /** Every named tool must appear on a step assigned to this agent. */
  requiredToolNames: string[];
  /** At least one named tool must appear on a step assigned to this agent. */
  requiredAnyToolNames?: string[];
  /** At least one of these tools must be usable for this route to be enforceable. */
  availabilityToolNames: string[];
}

export interface CommanderRouteAvailability {
  requirement: CommanderRouteRequirement;
  available: boolean;
  missingAgent: boolean;
  missingToolNames: string[];
  missingRequiredAnyToolNames: string[];
  missingAvailabilityToolNames: string[];
}

interface AvailableAgentRoute {
  kind: string;
  allowedToolNames: readonly string[];
}

interface AvailableToolRoute {
  name: string;
  ownerAgentKinds: readonly string[];
}

const CODE_EVIDENCE_TOOLS = [
  "code.inspectRepository",
  "code.searchRepository",
  "code.traceCallChain",
  "file.readWorkspaceText",
];

const PRIOR_WORK_REFERENCE_PATTERN =
  /(?:上次|之前|先前|此前|以前|前一次|刚才).{0,28}(?:问题|任务|决定|结论|方案|修复|bug|性能|工作(?!区))|\b(?:last time|previously|before|earlier)\b/i;
const PRIOR_WORK_RESULT_QUESTION_PATTERN =
  /(?:后来|最后|当时|结果|结论|决定|状态|进展).{0,12}(?:怎么样|如何|怎么|是什么|了吗|呢)|(?:怎么样|如何|怎么处理|怎么决定|结果|结论|状态|进展)|\b(?:what|how|where) did we\b|\b(?:status|outcome|decision|result|progress)\b/i;
const CONTINUATION_WORK_PATTERN =
  /(?:继续|接着|重新|再)(?:分析|检查|排查|修复|优化|测试|实现|处理)|\b(?:continue|resume|keep)\b.{0,30}\b(?:analy[sz]e|investigat|fix|optimi[sz]e|test|implement|work)/i;

export function isPriorWorkRecallRequest(text: string): boolean {
  return PRIOR_WORK_REFERENCE_PATTERN.test(text) &&
    PRIOR_WORK_RESULT_QUESTION_PATTERN.test(text) &&
    !CONTINUATION_WORK_PATTERN.test(text);
}

export function inferCommanderRouteRequirements(text: string): CommanderRouteRequirement[] {
  const goal = text.trim();
  if (!goal) return [];

  if (isPriorWorkRecallRequest(goal)) {
    return [{
      agentKind: "workspace",
      displayName: "Workspace Agent",
      capabilities: ["memory_search", "memory.search"],
      reason: "prior_work_recall_intent",
      requiredToolNames: ["memory.search"],
      availabilityToolNames: [],
    }];
  }

  const requirements: CommanderRouteRequirement[] = [];
  const planIntents = detectCommanderPlanIntents(goal);
  const primarySpecialist = inferPrimarySpecialistAgentHint(goal);

  addGitRequirements(requirements, goal);
  addWorkspaceRequirements(requirements, goal);
  addSchedulerRequirement(requirements, goal);
  addLocalMachineRequirements(requirements, goal);
  addBrowserAndResearchRequirements(requirements, goal);
  addFileRequirements(requirements, goal);
  addShellAndVerificationRequirements(requirements, goal, primarySpecialist?.agentKind);

  if (primarySpecialist) {
    const requiredToolNames = primarySpecialist.agentKind === "vision"
      ? primarySpecialist.capabilities.filter((capability) => capability.startsWith("vision."))
      : primarySpecialist.agentKind === "test-runner"
        ? ["shell.runWorkspaceCommand"]
        : primarySpecialist.agentKind === "doc-updater" && planIntents.write
          ? ["file.writeText"]
          : [];
    addRequirement(requirements, {
      ...primarySpecialist,
      requiredToolNames,
      availabilityToolNames: specialistAvailabilityTools(primarySpecialist.agentKind),
    });
  }

  const docUpdaterOwnsWrite = requirements.some((item) =>
    item.agentKind === "doc-updater" && item.requiredToolNames.includes("file.writeText")
  );
  if (
    planIntents.write &&
    hasConcreteFileOutputTarget(goal) &&
    !docUpdaterOwnsWrite
  ) {
    addRequirement(requirements, {
      agentKind: "file",
      displayName: "File Agent",
      capabilities: ["file_execute", "file.writeText"],
      reason: "file_persistence_intent",
      requiredToolNames: ["file.writeText"],
      availabilityToolNames: [],
    });
  }

  return requirements;
}

export function resolveCommanderRouteAvailability(
  requirements: readonly CommanderRouteRequirement[],
  availableAgents: readonly AvailableAgentRoute[],
  availableTools: readonly AvailableToolRoute[],
): CommanderRouteAvailability[] {
  const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
  return requirements.map((requirement) => {
    const agent = availableAgents.find((candidate) => candidate.kind === requirement.agentKind);
    const canAgentUseTool = (toolName: string) => {
      const descriptor = toolsByName.get(toolName);
      return Boolean(
        agent &&
        descriptor &&
        agent.allowedToolNames.includes(toolName) &&
        descriptor.ownerAgentKinds.includes(requirement.agentKind),
      );
    };
    const missingToolNames = requirement.requiredToolNames.filter((toolName) =>
      !canAgentUseTool(toolName)
    );
    const requiredAnyToolNames = requirement.requiredAnyToolNames ?? [];
    const hasRequiredAnyTool = requiredAnyToolNames.length === 0 ||
      requiredAnyToolNames.some(canAgentUseTool);
    const hasAvailabilityTool = requirement.availabilityToolNames.length === 0 ||
      requirement.availabilityToolNames.some(canAgentUseTool);
    return {
      requirement,
      available: Boolean(agent) && missingToolNames.length === 0 &&
        hasRequiredAnyTool && hasAvailabilityTool,
      missingAgent: !agent,
      missingToolNames,
      missingRequiredAnyToolNames: hasRequiredAnyTool ? [] : [...requiredAnyToolNames],
      missingAvailabilityToolNames: hasAvailabilityTool
        ? []
        : [...requirement.availabilityToolNames],
    };
  });
}

function addGitRequirements(requirements: CommanderRouteRequirement[], goal: string) {
  const tools: string[] = [];
  if (/(?:暂存|加入暂存区|\bgit\s+add\b|\bstage\b.{0,20}\bchanges?\b)/i.test(goal)) {
    tools.push("git.stageFiles");
  }
  if (/(?:提交(?:一下|这些|当前|代码|改动|变更)?|创建提交|\bcommit\b)/i.test(goal)) {
    tools.push("git.createCommit");
  }
  if (/(?:开|创建|新建).{0,8}(?:草稿\s*)?(?:PR|pull request)|\bdraft\s+(?:PR|pull request)\b|\bcreate\b.{0,12}\bpull request\b/i.test(goal)) {
    tools.push("git.createPullRequest");
  }
  if (/(?:PR|pull request).{0,12}(?:留言|评论|回复)|(?:留言|评论|回复).{0,12}(?:PR|pull request)|\bcomment\b.{0,20}\b(?:PR|pull request)\b/i.test(goal)) {
    tools.push("git.commentPullRequest");
  }
  if (tools.length === 0) return;
  addRequirement(requirements, {
    agentKind: "code",
    displayName: "Code Agent",
    capabilities: tools.map((toolName) => toolName.replace("git.", "git_")),
    reason: "git_operation_intent",
    requiredToolNames: tools,
    availabilityToolNames: [],
  });
}

function addWorkspaceRequirements(requirements: CommanderRouteRequirement[], goal: string) {
  if (!/(?:工作区|workspace)/i.test(goal) || isCodebaseUnderstandingRequest(goal)) return;
  const tools: string[] = [];
  if (/(?:有哪些|列出|查看|显示|\blist\b)/i.test(goal)) tools.push("workspace.list");
  if (/(?:草拟|搭个骨架|生成定义|\bscaffold\b|\bdraft\b)/i.test(goal)) tools.push("workspace.scaffold");
  if (/(?:创建|新建|保存|\bcreate\b)/i.test(goal)) tools.push("workspace.create");
  if (/(?:删除|删掉|移除|\bdelete\b|\bremove\b)/i.test(goal)) tools.push("workspace.delete");
  if (tools.length === 0) return;
  addRequirement(requirements, {
    agentKind: "workspace",
    displayName: "Workspace Agent",
    capabilities: tools.map((toolName) => toolName.replace("workspace.", "workspace_")),
    reason: "workspace_lifecycle_intent",
    requiredToolNames: tools,
    availabilityToolNames: [],
  });
}

function addSchedulerRequirement(requirements: CommanderRouteRequirement[], goal: string) {
  if (!/(?:提醒|定时|日程|remind|reminder|schedule)/i.test(goal)) return;
  addRequirement(requirements, {
    agentKind: "scheduler",
    displayName: "Scheduler Agent",
    capabilities: ["scheduler_create", "scheduler.createTask"],
    reason: "schedule_creation_intent",
    requiredToolNames: ["scheduler.createTask"],
    availabilityToolNames: [],
  });
}

function addLocalMachineRequirements(requirements: CommanderRouteRequirement[], goal: string) {
  if (isCodebaseUnderstandingRequest(goal)) return;
  const tools: string[] = [];
  if (/(?:最近|新近|latest|recent).{0,8}(?:截图|截屏|screenshots?)/i.test(goal)) {
    tools.push("file.scanUserImages");
  }
  if (/(?:电脑上|本机|系统里).{0,12}(?:装了|安装了|有哪些).{0,10}(?:应用|软件|开发工具)|(?:installed apps?|installed tools?)/i.test(goal)) {
    tools.push("file.scanInstalledApps");
  }
  if (/(?:找|查找|搜索|find|locate|search).{0,20}(?:电脑里|电脑上|本地|下载目录|local|computer).{0,30}(?:文档|文件|模板|document|file)|(?:电脑里|电脑上|本地|下载目录).{0,20}(?:找|查找|搜索).{0,20}(?:文档|文件|模板)/i.test(goal)) {
    tools.push("computer.searchLocalDocuments");
  }
  if (/(?:列出|查看|看看|显示).{0,12}(?:打开的)?窗口|(?:list|show).{0,12}(?:open )?windows/i.test(goal)) {
    tools.push("computer.listWindows");
  }
  if (/(?:桌面上有什么|看看桌面|查看桌面|截取桌面|desktop screenshot|show (?:my )?desktop)/i.test(goal)) {
    tools.push("computer.screenshot");
  }
  if (/(?:找到|找出|find|locate).{0,30}(?:后|then).{0,8}(?:打开|open)/i.test(goal)) {
    tools.push("computer.openPath");
  }

  const browserContext = /(?:网页|页面|网站|browser|website|web page)/i.test(goal);
  const uiAction = /(?:点击|输入|切到|切换到|聚焦|操作|打开).{0,30}(?:按钮|窗口|记事本|桌面|应用|程序)|(?:click|type|focus|switch to|operate).{0,30}(?:button|window|notepad|desktop|app)/i.test(goal);
  if (tools.length === 0 && uiAction && !browserContext) {
    addRequirement(requirements, {
      agentKind: "computer",
      displayName: "Computer Agent",
      capabilities: ["desktop_input"],
      reason: "desktop_interaction_intent",
      requiredToolNames: [],
      availabilityToolNames: ["computer.screenshot", "computer.inspectUi", "computer.click", "computer.type"],
    });
    return;
  }
  if (tools.length === 0) return;
  addRequirement(requirements, {
    agentKind: "computer",
    displayName: "Computer Agent",
    capabilities: tools.map((toolName) => toolName.replace(/^(?:computer|file)\./, "computer_")),
    reason: "local_machine_evidence_intent",
    requiredToolNames: tools,
    availabilityToolNames: [],
  });
}

function addBrowserAndResearchRequirements(requirements: CommanderRouteRequirement[], goal: string) {
  const pageReference = /(?:这个|当前|this|current).{0,5}(?:网页|页面|page)|(?:网页|页面).{0,12}(?:讲|内容|链接|搜|搜索|查找|点击|输入)|\b(?:click|type|find|search)\b.{0,24}\b(?:this|current) page\b/i.test(goal);
  if (pageReference) {
    addRequirement(requirements, {
      agentKind: "page-agent",
      displayName: "Page Agent",
      capabilities: ["browser_navigate", "browser_content"],
      reason: "current_page_interaction_intent",
      requiredToolNames: [],
      availabilityToolNames: ["browser.getContent", "browser.extractLinks", "browser.click", "browser.type"],
    });
    return;
  }

  const explicitUrl = /https?:\/\//i.test(goal);
  const goalWithoutOutputFileNames = goal.replace(
    /[^\s"'，。；;!?？]+\.(?:md|txt|json|csv|pdf)\b/gi,
    " ",
  );
  const publicResearch = /(?:新闻|热点|热搜|趋势|公开资料|网上|全网|查资料|搜资料|news|trending|hot topics?|public sources?|search the web|web research)/i.test(goalWithoutOutputFileNames);
  if (!explicitUrl && !publicResearch) return;
  addRequirement(requirements, {
    agentKind: "research",
    displayName: "Research Agent",
    capabilities: [explicitUrl ? "web_fetch" : "web_search"],
    reason: explicitUrl ? "public_url_retrieval_intent" : "public_research_intent",
    requiredToolNames: explicitUrl ? ["web.fetchSource"] : [],
    requiredAnyToolNames: explicitUrl ? [] : ["web.search", "trend.fetchHotList"],
    availabilityToolNames: [],
  });
}

function addFileRequirements(requirements: CommanderRouteRequirement[], goal: string) {
  if (/pdf/i.test(goal) && /(?:整理|分类|移动|归档|organize|sort|move)/i.test(goal)) {
    const execute = /(?:帮我|整理一下|移动|归档|执行|organize|move|do it)/i.test(goal);
    addRequirement(requirements, {
      agentKind: "file",
      displayName: "File Agent",
      capabilities: ["file_scan", "file_execute"],
      reason: "pdf_organization_intent",
      requiredToolNames: execute
        ? ["file.planPdfOrganization", "file.executePdfOrganization"]
        : ["file.planPdfOrganization"],
      availabilityToolNames: [],
    });
    return;
  }
  if (/(?:文档|文件|documents?|files?).{0,16}(?:分类|归类|classify)|(?:分类|归类).{0,16}(?:文档|文件|documents?|files?)/i.test(goal)) {
    addRequirement(requirements, {
      agentKind: "file",
      displayName: "File Agent",
      capabilities: ["file_scan"],
      reason: "document_classification_intent",
      requiredToolNames: ["file.scanUserDocuments", "file.classifyDocuments"],
      availabilityToolNames: [],
    });
  }
}

function addShellAndVerificationRequirements(
  requirements: CommanderRouteRequirement[],
  goal: string,
  primarySpecialistKind?: string,
) {
  const runtimeVersion = /(?:node|pnpm|npm|yarn|rustc|cargo|python|git).{0,18}(?:版本|version)|(?:版本|version).{0,18}(?:node|pnpm|npm|yarn|rustc|cargo|python|git)/i.test(goal) &&
    !/(?:package\.json|配置|声明|要求|支持|constraint|config|manifest)/i.test(goal);
  if (runtimeVersion) {
    addRequirement(requirements, {
      agentKind: "shell",
      displayName: "Shell Agent",
      capabilities: ["shell_readonly", "shell.runReadOnlyCommand"],
      reason: "runtime_version_inspection_intent",
      requiredToolNames: ["shell.runReadOnlyCommand"],
      availabilityToolNames: [],
    });
  }

  const statusCheck = /(?:测试|单测|集成测试|构建|编译|typecheck|类型检查).{0,12}(?:能过|通过吗|怎么样|状态|结果|正常吗)|(?:能过|通过吗).{0,12}(?:测试|构建|编译|typecheck)/i.test(goal);
  if (statusCheck && primarySpecialistKind !== "build-fix") {
    addRequirement(requirements, {
      agentKind: "test-runner",
      displayName: "Test Runner",
      capabilities: ["test_run", "shell.runWorkspaceCommand"],
      reason: "verification_status_intent",
      requiredToolNames: ["shell.runWorkspaceCommand"],
      availabilityToolNames: [],
    });
  }
}

function specialistAvailabilityTools(agentKind: string): string[] {
  if (agentKind === "vision" || agentKind === "test-runner" || agentKind === "doc-updater") {
    return [];
  }
  if ([
    "security-reviewer",
    "language-reviewer",
    "build-fix",
    "perf-analyzer",
    "refactor",
    "explorer",
  ].includes(agentKind)) {
    return CODE_EVIDENCE_TOOLS;
  }
  return [];
}

function hasConcreteFileOutputTarget(goal: string): boolean {
  return /[^\s，。；;!?？]+\.(?:md|txt|json|csv|pdf)\b/i.test(goal) ||
    /(?:文件|文档|报告|报表|白皮书|纪要|readme|markdown)/i.test(goal);
}

function addRequirement(
  requirements: CommanderRouteRequirement[],
  requirement: CommanderRouteRequirement,
) {
  const existing = requirements.find((item) => item.agentKind === requirement.agentKind);
  if (!existing) {
    requirements.push({
      ...requirement,
      capabilities: [...new Set(requirement.capabilities)],
      requiredToolNames: [...new Set(requirement.requiredToolNames)],
      requiredAnyToolNames: [...new Set(requirement.requiredAnyToolNames ?? [])],
      availabilityToolNames: [...new Set(requirement.availabilityToolNames)],
    });
    return;
  }
  existing.capabilities = [...new Set([...existing.capabilities, ...requirement.capabilities])];
  existing.requiredToolNames = [...new Set([...existing.requiredToolNames, ...requirement.requiredToolNames])];
  existing.requiredAnyToolNames = [
    ...new Set([...(existing.requiredAnyToolNames ?? []), ...(requirement.requiredAnyToolNames ?? [])]),
  ];
  existing.availabilityToolNames = [
    ...new Set([...existing.availabilityToolNames, ...requirement.availabilityToolNames]),
  ];
  if (!existing.reason.includes(requirement.reason)) {
    existing.reason = `${existing.reason}+${requirement.reason}`;
  }
}
