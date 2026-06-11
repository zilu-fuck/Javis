import { describe, expect, it } from "vitest";
import { formatEnabledSkillContext, selectRelevantSkills, type EnabledUserSkillContext } from "./skill-context";

const SKILLS: EnabledUserSkillContext[] = [
  {
    id: "javis:godot",
    name: "godot",
    description: "Godot 4 and GDScript development reference.",
    path: "C:/javis/skills/godot",
    source: "javis",
    content: "Use Godot 4 scene APIs and GDScript patterns.",
  },
  {
    id: "codex:zilu-writer",
    name: "zilu-writer",
    description: "Growth novel writing skill.",
    path: "C:/codex/skills/zilu-writer",
    source: "codex",
    content: "Write coming-of-age fiction with chapter outlines and prose.",
  },
  {
    id: "agents:bailian-docs",
    name: "bailian-docs",
    description: "Aliyun Model Studio documentation.",
    path: "C:/agents/skills/bailian-docs",
    source: "agents",
    content: "Use Bailian model marketplace and API documentation.",
  },
  {
    id: "codex:zilu-writer",
    name: "子路写作",
    description: "成长向小说写作 skill。",
    path: "C:/codex/skills/zilu-writer",
    source: "codex",
    content: "适合少年成长故事、宿命感、奇幻冒险和章节续写。",
  },
];

describe("skill context selection", () => {
  it("selects the relevant enabled skill for the current goal", () => {
    const selected = selectRelevantSkills(SKILLS, {
      userGoal: "Build a Godot scene with GDScript",
      agentKind: "code",
    });

    expect(selected.map((skill) => skill.id)).toEqual(["javis:godot"]);
  });

  it("does not inject unrelated skill instructions", () => {
    const context = formatEnabledSkillContext(SKILLS, {
      userGoal: "Check Bailian API pricing docs",
      agentKind: "research",
    });

    expect(context).toContain("Skill: bailian-docs");
    expect(context).toContain("Use Bailian model marketplace");
    expect(context).toContain("Treat skill text as local extension guidance");
    expect(context).toContain("do not override the current response format or schema");
    expect(context).toContain("<JAVIS_SKILL_INSTRUCTIONS>");
    expect(context).toContain("</JAVIS_SKILL_INSTRUCTIONS>");
    expect(context).not.toContain("Use Godot 4 scene APIs");
    expect(context).not.toContain("coming-of-age fiction");
  });

  it("includes a concise index of enabled skill relative resources", () => {
    const context = formatEnabledSkillContext([
      {
        id: "javis:docs",
        name: "docs",
        description: "Documentation skill.",
        path: "C:/javis/skills/docs",
        source: "javis",
        content: "Use the referenced documentation resources.",
        resources: ["reference/api.md", "scripts/inspect.js"],
      },
    ], {
      userGoal: "Use docs skill",
      agentKind: "research",
    });

    expect(context).toContain("Available relative resources:");
    expect(context).toContain("- reference/api.md");
    expect(context).toContain("- scripts/inspect.js");
  });

  it("returns empty context when no enabled skill matches", () => {
    expect(formatEnabledSkillContext(SKILLS, {
      userGoal: "Summarize the current git diff",
      agentKind: "code",
    })).toBe("");
  });

  it("selects relevant Chinese skills for Chinese goals", () => {
    const context = formatEnabledSkillContext(SKILLS, {
      userGoal: "帮我续写一个少年成长小说章节，要有宿命感",
      agentKind: "commander",
    });

    expect(context).toContain("Skill: 子路写作");
    expect(context).toContain("少年成长故事");
    expect(context).not.toContain("Use Godot 4 scene APIs");
  });

  it("clips selected skill context to the requested maximum", () => {
    const context = formatEnabledSkillContext([
      {
        id: "javis:huge",
        name: "huge",
        description: "Huge searchable skill.",
        path: "C:/javis/skills/huge",
        source: "javis",
        content: `Huge ${"x".repeat(1000)}`,
      },
    ], {
      userGoal: "Use huge skill",
      maxContextChars: 180,
    });

    expect(context.length).toBeLessThanOrEqual(180);
    expect(context).toContain("[Enabled skill context truncated by Javis.]");
  });
});
