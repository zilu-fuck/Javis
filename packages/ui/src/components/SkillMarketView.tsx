import type { WorkbenchLocale, WorkbenchSkillEntry } from "../types";

interface SkillMarketViewProps {
  skills: WorkbenchSkillEntry[];
  locale: WorkbenchLocale;
  translationStatus?: "idle" | "translating" | "error";
  onTranslateToChinese?: () => void;
}

const PERMISSION_COLORS: Record<string, string> = {
  read: "#4ade80",
  preview: "#facc15",
  confirmed_write: "#fb923c",
  dangerous: "#f87171",
};

export function SkillMarketView({
  skills,
  locale,
  translationStatus = "idle",
  onTranslateToChinese,
}: SkillMarketViewProps) {
  const labels = locale.labels;

  const tools = skills.filter((s) => s.category === "tool");
  const agents = skills.filter((s) => s.category === "agent");
  const mcpServers = skills.filter((s) => s.category === "mcp");

  return (
    <div className="javis-view-panel">
      <div className="javis-skill-header">
        <div>
          <h2 className="javis-view-title">{labels.skillMarketTitle}</h2>
          <div className="javis-skill-count">
            {skills.length} {labels.skillCategoryTool.toLowerCase()}
          </div>
        </div>
        {onTranslateToChinese ? (
          <button
            className="javis-skill-translate-button"
            disabled={translationStatus === "translating"}
            onClick={onTranslateToChinese}
            type="button"
          >
            {translationStatus === "translating"
              ? "翻译中..."
              : translationStatus === "error"
                ? "翻译失败"
                : "中文翻译"}
          </button>
        ) : null}
      </div>

      {tools.length > 0 && (
        <section className="javis-skill-section">
          <h3>{labels.skillCategoryTool}</h3>
          <div className="javis-skill-grid">
            {tools.map((skill) => (
              <SkillCard key={skill.id} labels={labels} skill={skill} />
            ))}
          </div>
        </section>
      )}

      {agents.length > 0 && (
        <section className="javis-skill-section">
          <h3>{labels.skillCategoryAgent}</h3>
          <div className="javis-skill-grid">
            {agents.map((skill) => (
              <SkillCard key={skill.id} labels={labels} skill={skill} />
            ))}
          </div>
        </section>
      )}

      {mcpServers.length > 0 && (
        <section className="javis-skill-section">
          <h3>{labels.skillCategoryMcp}</h3>
          <div className="javis-skill-grid">
            {mcpServers.map((skill) => (
              <SkillCard key={skill.id} labels={labels} skill={skill} />
            ))}
          </div>
        </section>
      )}

      {mcpServers.length === 0 && (
        <section className="javis-skill-section">
          <h3>{labels.skillCategoryMcp}</h3>
          <p className="javis-skill-empty">{labels.noMcpConfig}</p>
        </section>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  labels,
}: {
  skill: WorkbenchSkillEntry;
  labels: WorkbenchLocale["labels"];
}) {
  const permColor = skill.permissionLevel
    ? PERMISSION_COLORS[skill.permissionLevel] ?? "#94a3b8"
    : undefined;

  return (
    <div className="javis-skill-card">
      <div className="javis-skill-card-header">
        <span className="javis-skill-name">{skill.name}</span>
        {skill.permissionLevel && (
          <span
            className="javis-skill-perm-chip"
            style={{ backgroundColor: permColor }}
          >
            {skill.permissionLevel}
          </span>
        )}
      </div>
      <p className="javis-skill-desc">{skill.description}</p>
      {skill.category === "tool" && skill.agentOwners.length > 0 ? (
        <div className="javis-skill-owners">
          {skill.agentOwners.map((owner) => (
            <span className="javis-skill-owner-chip" key={owner}>
              {owner}
            </span>
          ))}
        </div>
      ) : skill.category === "tool" ? (
        <div className="javis-skill-owners">
          <span className="javis-skill-owner-chip muted">
            {labels.skillUiFeatureLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}
