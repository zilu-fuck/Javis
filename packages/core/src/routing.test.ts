import { describe, expect, it } from "vitest";
import {
  getTopRoute,
  getTopRoutes,
  getRecommendedWorkflowIds,
  isPdfOrganizationGoal,
  isComputerUseGoal,
  scoreRoutes,
} from "./routing";

describe("routing", () => {
  it("requires file context for PDF organization routing", () => {
    expect(isPdfOrganizationGoal("\u6574\u7406\u601d\u8def")).toBe(false);
    expect(isPdfOrganizationGoal("\u6574\u7406\u6587\u4ef6")).toBe(true);
    expect(isPdfOrganizationGoal("Organize PDFs in Downloads")).toBe(true);
  });

  it("returns scored route signals for explainable routing", () => {
    const [topRoute] = scoreRoutes("Review code changes", { hasGitChanges: true });

    expect(topRoute).toEqual({
      route: "code",
      score: 3,
      signals: ["code-review-keyword", "git-changes-context"],
    });
  });

  it("does not select a route below the confidence threshold", () => {
    expect(getTopRoute("整理思路")).toBeUndefined();
  });

  it("uses URL presence as a strong research signal", () => {
    expect(getTopRoute("summarize https://example.com")?.route).toBe("research");
  });

  it("returns multiple confident routes for combined goals", () => {
    const routes = getTopRoutes(
      "Review code changes and research the library documentation",
      { hasGitChanges: true },
      2,
    );

    expect(routes.map((route) => route.route)).toEqual(["code", "research"]);
    expect(routes[0]?.signals).toContain("git-changes-context");
    expect(routes[1]?.signals).toContain("research-keyword");
  });

  it("respects the requested maximum route count", () => {
    const routes = getTopRoutes(
      "Review code changes, research sources, and test project environment",
      { hasGitChanges: true, hasPackageJson: true },
      2,
    );

    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.route)).toEqual(["code", "project"]);
  });

  it("returns no multi-routes below threshold or when maxRoutes is zero", () => {
    expect(getTopRoutes("整理思路")).toEqual([]);
    expect(getTopRoutes("Review code changes", { hasGitChanges: true }, 0)).toEqual([]);
  });

  it("maps confident routes to workflow blueprints without duplicates", () => {
    expect(getRecommendedWorkflowIds("remind me every day at 8")).toEqual(["daily-reminder"]);
    expect(getRecommendedWorkflowIds("find my local document")).toEqual([
      "find-local-document",
      "scan-workspace-documents",
    ]);
    expect(getRecommendedWorkflowIds("how do I start a Spring Boot app")).toEqual([
      "plan-spring-boot-project",
    ]);
    expect(getRecommendedWorkflowIds("inspect this project")).toEqual(["read-current-project"]);
  });

  // ── Computer Use routing ────────────────────────────────────────────────

  it("routes desktop automation verbs to computer-use", () => {
    expect(isComputerUseGoal("操控桌面打开 Chrome")).toBe(true);
    expect(isComputerUseGoal("desktop automation to open Notepad")).toBe(true);
    expect(isComputerUseGoal("控制桌面操作 VS Code")).toBe(true);
  });

  it("routes app name + action word combos to computer-use", () => {
    expect(isComputerUseGoal("打开计算器")).toBe(true);
    expect(isComputerUseGoal("打开 VS Code")).toBe(true);
    expect(isComputerUseGoal("open Calculator")).toBe(true);
    expect(isComputerUseGoal("launch Excel")).toBe(true);
  });

  it("routes desktop/window keywords to computer-use when combined", () => {
    // "桌面" alone gives +2, not enough (threshold 4)
    // But "打开计算器" gives +4 from app+action combo
    expect(isComputerUseGoal("桌面截图")).toBe(false); // only +2 from desktop keyword
  });

  it("does not route vague goals to computer-use", () => {
    expect(isComputerUseGoal("打开项目文件夹")).toBe(false);
    expect(isComputerUseGoal("点击确认按钮")).toBe(false);
    expect(isComputerUseGoal("输入命令")).toBe(false);
    expect(isComputerUseGoal("帮我看看这个网站")).toBe(false);
  });

  it("routes computer-use to the correct workflow", () => {
    expect(getRecommendedWorkflowIds("操控桌面打开 Chrome")).toEqual(["computer-use"]);
    expect(getRecommendedWorkflowIds("打开计算器")).toEqual(["computer-use"]);
  });

  it("routes desktop messaging app automation to computer-use", () => {
    const goal = "\u7528\u684c\u9762\u81ea\u52a8\u5316\u6253\u5f00 QQ\uff0c\u627e\u5230 \u51e4\u96cf-\u5927\u806a\u660e\uff0c\u5e76\u51c6\u5907\u53d1\u9001\u6d88\u606f\uff1a sb";
    expect(isComputerUseGoal(goal)).toBe(true);
    expect(getRecommendedWorkflowIds(goal)[0]).toBe("computer-use");
  });

  it("scores computer-use route correctly for strong signals", () => {
    const routes = scoreRoutes("操控桌面打开 Chrome 并截图");
    const cuRoute = routes.find((r) => r.route === "computer-use");
    expect(cuRoute).toBeDefined();
    expect(cuRoute!.score).toBeGreaterThanOrEqual(4);
    expect(cuRoute!.signals).toContain("desktop-automation-verb");
    expect(cuRoute!.signals).toContain("app-name-with-action");
  });

  // ── Layer 2: Natural-language desktop task patterns ──────────────────────

  it("routes natural-language desktop task patterns to computer-use", () => {
    expect(isComputerUseGoal("帮我在电脑上打开 Chrome")).toBe(true);
    expect(isComputerUseGoal("帮我操作桌面打开 QQ")).toBe(true);
    expect(isComputerUseGoal("帮我用桌面打开记事本")).toBe(true);
    expect(isComputerUseGoal("在电脑上帮我找文件")).toBe(true);
    expect(isComputerUseGoal("用桌面自动化打开 VS Code")).toBe(true);
    expect(isComputerUseGoal("通过桌面操作微信")).toBe(true);
  });

  it("does not route non-desktop natural language to computer-use", () => {
    expect(isComputerUseGoal("帮我写一篇文章")).toBe(false);
    expect(isComputerUseGoal("帮我查一下天气")).toBe(false);
    expect(isComputerUseGoal("帮我分析代码")).toBe(false);
  });

  // ── Layer 4: Messaging/IM app automation ─────────────────────────────────

  it("routes QQ automation goals to computer-use", () => {
    expect(isComputerUseGoal("打开 QQ 找到凤雏-大聪明并准备发送消息")).toBe(true);
    expect(isComputerUseGoal("用 QQ 给张三发消息")).toBe(true);
    expect(isComputerUseGoal("launch QQ and send message to contact")).toBe(true);
  });

  it("routes WeChat/DingTalk automation to computer-use", () => {
    expect(isComputerUseGoal("打开微信找到联系人")).toBe(true);
    expect(isComputerUseGoal("用钉钉发送消息")).toBe(true);
    expect(isComputerUseGoal("打开企业微信准备发送通知")).toBe(true);
    expect(isComputerUseGoal("用飞书联系张三")).toBe(true);
  });

  it("routes messaging app with action to computer-use", () => {
    expect(isComputerUseGoal("在 QQ 里找到王五的聊天记录")).toBe(true);
    expect(isComputerUseGoal("用微信给群里发消息")).toBe(true);
  });

  // ── Layer 5: Desktop UI keywords with action context ─────────────────────

  it("routes desktop UI keywords with action context to computer-use", () => {
    expect(isComputerUseGoal("在桌面上找到文件并打开")).toBe(true);
    expect(isComputerUseGoal("点击桌面上的计算器图标")).toBe(true);
    expect(isComputerUseGoal("打开窗口中的设置")).toBe(true);
    expect(isComputerUseGoal("切换到任务栏的 Chrome")).toBe(true);
    expect(isComputerUseGoal("用桌面搜索框查找文件")).toBe(true);
  });

  it("does not route desktop keywords without action context", () => {
    // "desktop" or "window" alone without an action verb is not enough
    expect(isComputerUseGoal("看看我的桌面")).toBe(false);
    expect(isComputerUseGoal("窗口太小了")).toBe(false);
    expect(isComputerUseGoal("这个桌面背景很好看")).toBe(false);
  });

  // ── Edge cases: ComputerUse vs local-document disambiguation ───────────

  it("does not route local file search to computer-use", () => {
    // "在电脑上找文件" has no desktop-action context, only file search
    expect(isComputerUseGoal("在电脑上找文件")).toBe(false);
    // "在电脑上查一下文档" also file search intent
    expect(isComputerUseGoal("在电脑上查一下文档")).toBe(false);
  });

  it("routes desktop-app actions on computer to computer-use", () => {
    // "在电脑上打开Chrome" is app launch, which Layer 3 catches
    expect(isComputerUseGoal("在电脑上打开Chrome")).toBe(true);
    expect(isComputerUseGoal("在电脑上打开VS Code")).toBe(true);
  });
});
