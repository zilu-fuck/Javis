import { describe, expect, it } from "vitest";
import {
  getTopRoute,
  getTopRoutes,
  getRecommendedWorkflowIds,
  isPdfOrganizationGoal,
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
    expect(getRecommendedWorkflowIds("find my local document")).toEqual(["find-local-document"]);
    expect(getRecommendedWorkflowIds("how do I start a Spring Boot app")).toEqual([
      "plan-spring-boot-project",
    ]);
    expect(getRecommendedWorkflowIds("inspect this project")).toEqual(["read-current-project"]);
  });
});
