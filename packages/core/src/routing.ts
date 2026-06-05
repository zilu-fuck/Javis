import type { ShellCommandRequest } from "@javis/tools";
import type { WorkbenchWorkflowId } from "./workflows";

export type RouteKind =
  | "pdf"
  | "code"
  | "research"
  | "project"
  | "file-scan"
  | "spring-boot"
  | "local-document"
  | "schedule"
  | "browser"
  | "computer-use";

export interface RouteScore {
  route: RouteKind;
  score: number;
  signals: string[];
}

export interface RouteScoringContext {
  hasGitChanges?: boolean;
  hasPackageJson?: boolean;
  hasMarkdownDocuments?: boolean;
}

const ROUTE_THRESHOLD = 2;

export function isProjectInspectionGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "project";
}

export function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s)]+/g), (match) => match[0]);
}

export function isResearchGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "research";
}

export function isCodeReviewGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "code";
}

export function isPdfOrganizationGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "pdf";
}

export function isDocumentScanGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "file-scan";
}

export function isBrowserGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "browser";
}

export function isComputerUseGoal(userGoal: string): boolean {
  return getTopRoute(userGoal)?.route === "computer-use";
}

export function scoreRoutes(
  userGoal: string,
  context: RouteScoringContext = {},
): RouteScore[] {
  const urls = extractUrls(userGoal);
  const routeScores: RouteScore[] = [
    createScheduleRouteScore(userGoal),
    createLocalDocumentRouteScore(userGoal),
    createSpringBootRouteScore(userGoal),
    createPdfRouteScore(userGoal),
    createCodeRouteScore(userGoal, context),
    createResearchRouteScore(userGoal, urls),
    createProjectRouteScore(userGoal, context),
    createFileScanRouteScore(userGoal, context),
    createBrowserRouteScore(userGoal, urls),
    createComputerUseRouteScore(userGoal),
  ];

  return routeScores.sort((left, right) => right.score - left.score);
}

export function getTopRoute(
  userGoal: string,
  context?: RouteScoringContext,
): RouteScore | undefined {
  const [topRoute] = scoreRoutes(userGoal, context);
  return topRoute && topRoute.score >= ROUTE_THRESHOLD ? topRoute : undefined;
}

export function getTopRoutes(
  userGoal: string,
  context?: RouteScoringContext,
  maxRoutes = 3,
): RouteScore[] {
  return scoreRoutes(userGoal, context)
    .filter((route) => route.score >= ROUTE_THRESHOLD)
    .slice(0, Math.max(0, maxRoutes));
}

export function getRecommendedWorkflowIds(
  userGoal: string,
  context?: RouteScoringContext,
  maxRoutes = 3,
): WorkbenchWorkflowId[] {
  const workflowIds: WorkbenchWorkflowId[] = [];
  for (const route of getTopRoutes(userGoal, context, maxRoutes)) {
    const workflowId = routeToWorkflowId(route.route, userGoal);
    if (workflowId && !workflowIds.includes(workflowId)) {
      workflowIds.push(workflowId);
    }
  }
  return workflowIds;
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

function routeToWorkflowId(
  route: RouteKind,
  userGoal: string,
): WorkbenchWorkflowId | undefined {
  switch (route) {
    case "research":
      return "research-trending-topics";
    case "spring-boot":
      return "plan-spring-boot-project";
    case "local-document":
      return "find-local-document";
    case "schedule":
      return "daily-reminder";
    case "project":
      return /read current project|inspect this project|understand this project|\u7406\u89e3.*\u9879\u76ee|\u9605\u8bfb.*\u9879\u76ee|\u5f53\u524d\u9879\u76ee/i.test(userGoal)
        ? "read-current-project"
        : undefined;
    case "browser":
      return /test|e2e|playwright/i.test(userGoal) ? "browser-test" : "browser-research";
    case "pdf":
      return "pdf-organization";
    case "code":
      return "code-review";
    case "file-scan":
      return "scan-workspace-documents";
    case "computer-use":
      return "computer-use";
    default:
      return undefined;
  }
}

function createSpringBootRouteScore(userGoal: string): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/spring\s*boot/i.test(userGoal)) {
    signals.push("spring-boot-keyword");
    score += 3;
  }
  if (/start|create|build|plan|project|\u5199|\u521b\u5efa|\u9879\u76ee|\u8ba1\u5212/i.test(userGoal)) {
    signals.push("project-planning-context");
    score += 1;
  }

  return { route: "spring-boot", score, signals };
}

function createLocalDocumentRouteScore(userGoal: string): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/find|locate|search|\u67e5\u627e|\u627e\u5230|\u641c\u7d22/i.test(userGoal)) {
    signals.push("find-action");
    score += 1;
  }
  if (/local|computer|desktop|downloads|\u7535\u8111|\u672c\u5730|\u684c\u9762|\u4e0b\u8f7d/i.test(userGoal)) {
    signals.push("local-document-context");
    score += 2;
  }
  if (/document|file|\u6587\u6863|\u6587\u4ef6/i.test(userGoal)) {
    signals.push("document-target");
    score += 1;
  }

  return {
    route: "local-document",
    score: signals.includes("find-action") && signals.includes("local-document-context") ? score : 0,
    signals,
  };
}

function createScheduleRouteScore(userGoal: string): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/remind|reminder|schedule|every day|daily|weekly|\u63d0\u9192|\u5b9a\u65f6|\u6bcf\u5929|\u6bcf\u5468/i.test(userGoal)) {
    signals.push("schedule-keyword");
    score += 2;
  }
  if (/\d{1,2}(:\d{2})?|morning|afternoon|evening|\u70b9|\u4e0a\u5348|\u4e0b\u5348|\u665a\u4e0a/i.test(userGoal)) {
    signals.push("time-context");
    score += 1;
  }

  return { route: "schedule", score, signals };
}

function createPdfRouteScore(userGoal: string): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/pdf/i.test(userGoal)) {
    signals.push("pdf-keyword");
    score += 2;
  }
  if (/downloads|download|\u4e0b\u8f7d/i.test(userGoal)) {
    signals.push("downloads-context");
    score += 1;
  }
  if (/file|files|folder|directory|\u6587\u4ef6|\u6587\u6863|\u76ee\u5f55|\u6587\u4ef6\u5939/i.test(userGoal)) {
    signals.push("file-context");
    score += 1;
  }
  if (/organize|move|sort|\u6574\u7406|\u79fb\u52a8|\u5206\u7c7b/i.test(userGoal)) {
    signals.push("organization-action");
    score += 1;
  }

  const hasAction = signals.includes("organization-action");
  const hasContext =
    signals.includes("pdf-keyword") ||
    signals.includes("downloads-context") ||
    signals.includes("file-context");

  return {
    route: "pdf",
    score: hasAction && hasContext ? score : 0,
    signals,
  };
}

function createCodeRouteScore(
  userGoal: string,
  context: RouteScoringContext,
): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/code review|review code|review changes|changed files|change set|diff|patch|source changes|\u4ee3\u7801\u5ba1\u67e5|\u5ba1\u67e5\u4ee3\u7801|\u53d8\u66f4|\u5dee\u5f02|\u8865\u4e01/i.test(userGoal)) {
    signals.push("code-review-keyword");
    score += 2;
  }
  if (context.hasGitChanges) {
    signals.push("git-changes-context");
    score += 1;
  }

  return { route: "code", score, signals };
}

function createResearchRouteScore(userGoal: string, urls: string[]): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (urls.length > 0) {
    signals.push("url-present");
    score += 2;
  }
  if (/research|source|sources|compare|collect|search|web|trending|trend|latest|hot topics|\u7814\u7a76|\u641c\u7d22|\u8d44\u6599|\u6765\u6e90|\u5bf9\u6bd4|\u6536\u96c6|\u70ed\u70b9|\u70ed\u641c|\u6700\u8fd1/i.test(userGoal)) {
    signals.push("research-keyword");
    score += 2;
  }

  return { route: "research", score, signals };
}

function createProjectRouteScore(
  userGoal: string,
  context: RouteScoringContext,
): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/\u9879\u76ee|\u542f\u52a8|\u6d4b\u8bd5|\u73af\u5883|\u547d\u4ee4|project|test|start|environment/i.test(userGoal)) {
    signals.push("project-keyword");
    score += 2;
  }
  if (context.hasPackageJson) {
    signals.push("package-json-context");
    score += 1;
  }

  return { route: "project", score, signals };
}

function createFileScanRouteScore(
  userGoal: string,
  context: RouteScoringContext,
): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/markdown|document|documents|scan|notes|\u6587\u6863|\u7b14\u8bb0|\u626b\u63cf/i.test(userGoal)) {
    signals.push("document-scan-keyword");
    score += 2;
  }
  if (context.hasMarkdownDocuments) {
    signals.push("markdown-context");
    score += 1;
  }

  return { route: "file-scan", score, signals };
}

function createBrowserRouteScore(userGoal: string, urls: string[]): RouteScore {
  const signals: string[] = [];
  let score = 0;

  if (/browse|browser|open\s+(?:page|website|site)|playwright|screenshot|\u7f51\u9875|\u6d4f\u89c8|\u622a\u56fe|\u6253\u5f00.*\u7f51\u9875/i.test(userGoal)) {
    signals.push("browser-keyword");
    score += 3;
  }
  if (/click|type|fill|submit|interact|form|login|sign\s*in|\u70b9\u51fb|\u8f93\u5165|\u586b\u5199|\u767b\u5f55/i.test(userGoal)) {
    signals.push("browser-interaction");
    score += 1;
  }
  if (/e2e|end.to.end|playwright.*test|browser.*test|test.*browser|\u6d4f\u89c8\u5668.*\u6d4b\u8bd5|\u81ea\u52a8\u5316\u6d4b\u8bd5/i.test(userGoal)) {
    signals.push("browser-test-keyword");
    score += 2;
  }
  if (urls.length > 0 && (signals.includes("browser-keyword") || signals.includes("browser-interaction"))) {
    signals.push("url-with-browser-context");
    score += 1;
  }

  return { route: "browser", score, signals };
}

/**
 * Score a user goal for Computer Use routing.
 *
 * This is used ONLY as a Commander-DAG-failure fallback (in workflow-executor)
 * and the legacy offline routing path (when commanderTool is unavailable).
 * It is NOT the primary dispatch mechanism — Commander (LLM) selects the
 * sub-agent in the normal path. This regex-based check exists solely to
 * prevent a Commander JSON parse failure from killing an obvious desktop
 * automation task.
 */
const COMPUTER_USE_ACTION_WORDS = /打开|启动|点击|输入|填写|配置|找到|查找|搜索|切换|关闭|open|launch|click|type|fill|configure|find|search|switch|close/i;

/**
 * Score a user goal for Computer Use routing.
 *
 * This is used ONLY as a Commander-DAG-failure fallback (in workflow-executor)
 * and the legacy offline routing path (when commanderTool is unavailable).
 * It is NOT the primary dispatch mechanism — Commander (LLM) selects the
 * sub-agent in the normal path. This regex-based check exists solely to
 * prevent a Commander JSON parse failure from killing an obvious desktop
 * automation task.
 */
function createComputerUseRouteScore(userGoal: string): RouteScore {
  const signals: string[] = [];
  let score = 0;

  // Layer 1 — Explicit desktop automation verbs (+5, threshold-busting alone)
  if (/操控桌面|操作电脑|控制桌面|桌面自动化|操作\s*GUI|desktop\s*automation|control\s*(?:my\s*)?computer|use\s*(?:my\s*)?computer/i.test(userGoal)) {
    signals.push("desktop-automation-verb");
    score += 5;
  }

  // Layer 2 — Natural-language desktop task patterns (+4)
  // “帮我在电脑上...” / “用桌面打开...” / “在桌面上...”
  if (/帮我(?:在电脑上|操作桌面|用桌面|打开电脑)|在电脑上帮我|用桌面自动化|通过桌面|在桌面|用桌面(?:搜索|找|打开|点击|启动|操作|切换|输入|发送)/i.test(userGoal)) {
    signals.push("natural-desktop-task");
    score += 4;
  }

  // Layer 3 — App name + action combo (+4)
  // Requires BOTH an app name AND an action verb to avoid false positives
  const appNames = /VS\s*Code|Visual\s*Studio|Excel|Word|Chrome|Edge|Firefox|计算器|记事本|画图|文件资源管理器|Notion|PowerPoint|Outlook|浏览器|设置|Settings|Calculator|Notepad|Paint|File\s*Explorer|Explorer|任务管理器|Task\s*Manager|控制面板|Control\s*Panel|命令提示符|cmd|PowerShell|终端|Terminal/i;
  const actionWords = COMPUTER_USE_ACTION_WORDS;
  if (appNames.test(userGoal) && actionWords.test(userGoal)) {
    signals.push("app-name-with-action");
    score += 4;
  }

  // Layer 4 — Messaging/IM app automation (+4)
  // QQ/WeChat/DingTalk with send/find/contact intent — common desktop task
  const messagingApps = /QQ|WeChat|微信|企业微信|钉钉|DingTalk|Telegram|Discord|飞书/i;
  const messagingActions = /打开|启动|发送|发消息|找到|联系|准备发送|给.*发|聊天|消息|open|launch|send\s+message|find.*contact/i;
  if (messagingApps.test(userGoal) && messagingActions.test(userGoal)) {
    signals.push("messaging-app-automation");
    score += 4;
  }

  // Layer 5 — Desktop/window UI keywords with action context (+3)
  // Only fires when paired with an action verb (not just mentioning “window”)
  const desktopUiKeywords = /桌面|窗口|屏幕|任务栏|开始菜单|系统托盘|desktop|window|screen|taskbar|start\s*menu|system\s*tray/i;
  const hasActionContext = COMPUTER_USE_ACTION_WORDS;
  if (desktopUiKeywords.test(userGoal) && hasActionContext.test(userGoal)) {
    signals.push("desktop-ui-with-action");
    score += 5;
  }

  return { route: "computer-use", score, signals };
}
