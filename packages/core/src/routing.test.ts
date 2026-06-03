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

  it("scores computer-use route correctly for strong signals", () => {
    const routes = scoreRoutes("操控桌面打开 Chrome 并截图");
    const cuRoute = routes.find((r) => r.route === "computer-use");
    expect(cuRoute).toBeDefined();
    expect(cuRoute!.score).toBeGreaterThanOrEqual(4);
    expect(cuRoute!.signals).toContain("desktop-automation-verb");
    expect(cuRoute!.signals).toContain("app-name-with-action");
    expect(cuRoute!.signals).toContain("desktop-keyword");
  });
});
