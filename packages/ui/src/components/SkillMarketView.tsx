import { useState } from "react";
import type {
  WorkbenchLocale,
  WorkbenchDetailItem,
  WorkbenchSkillEntry,
  WorkbenchSkillPage,
  WorkbenchSkillSearchKind,
  WorkbenchSkillSearchResult,
  WorkbenchSkillSearchSource,
  WorkbenchSkillSuggestion,
} from "../types";

interface SkillMarketViewProps {
  activePage: WorkbenchSkillPage;
  skills: WorkbenchSkillEntry[];
  locale: WorkbenchLocale;
  translationStatus?: "idle" | "translating" | "error";
  translationError?: string | null;
  searchStatus?: "idle" | "searching" | "error";
  searchResults?: WorkbenchSkillSearchResult[];
  suggestions?: WorkbenchSkillSuggestion[];
  suggestionStatus?: "idle" | "refreshing" | "error";
  mcpError?: string | null;
  onTranslateToChinese?: () => void;
  onSearchSkillMarket?: (
    query: string,
    source: WorkbenchSkillSearchSource,
    kind: WorkbenchSkillSearchKind,
  ) => void;
  onRefreshSuggestions?: (
    source: WorkbenchSkillSearchSource,
    kind: WorkbenchSkillSearchKind,
  ) => void;
  onToggleSkillEnabled?: (id: string, enabled: boolean) => void;
  onDeleteSkill?: (id: string) => void;
  onDisableAllSkills?: () => void;
  onDeleteAllSkills?: () => void;
  onInstallSkillMarketResult?: (result: WorkbenchSkillSearchResult) => void;
  onOpenDetail?: (detail: WorkbenchDetailItem) => void;
}

const PERMISSION_COLORS: Record<string, string> = {
  read: "#2f9b68",
  preview: "#d89a12",
  confirmed_write: "#f07d18",
  dangerous: "#d84f45",
};

const PERMISSION_LABELS: Record<string, string> = {
  read: "READ",
  preview: "PREVIEW",
  confirmed_write: "CONFIRMED_WRITE",
  dangerous: "DANGEROUS",
};

const SKILL_ICON_RULES: Array<[string, string]> = [
  ["plan", "calendar"],
  ["askuser", "user"],
  ["verify", "shield"],
  ["check", "shield"],
  ["markdown", "document"],
  ["scan", "document"],
  ["classify", "folder"],
  ["pdf", "document"],
  ["write", "edit"],
  ["shell", "terminal"],
  ["project", "code"],
  ["inspect", "code"],
  ["code", "code"],
  ["web", "link"],
  ["image", "image"],
  ["installed", "download"],
  ["directory", "folder"],
  ["openpath", "folder"],
  ["screenshot", "camera"],
  ["window", "window"],
  ["mouse", "mouse"],
  ["click", "mouse"],
  ["type", "keyboard"],
  ["keycombo", "keyboard"],
  ["keyboard", "keyboard"],
  ["agent", "user"],
  ["mcp", "server"],
];

const SEARCH_SUGGESTIONS: WorkbenchSkillSuggestion[] = [
  { title: "RAG 知识库", description: "文档索引、问答和引用追踪" },
  { title: "GitHub Issue 助手", description: "同步 issue、总结状态和生成回复" },
  { title: "PDF 整理", description: "批量识别、分类和移动 PDF 文件" },
  { title: "代码审查", description: "读取 diff、发现风险并给出修复建议" },
  { title: "网页研究", description: "搜索公开资料并生成来源表" },
  { title: "会议纪要", description: "整理录音文字稿和行动项" },
  { title: "MCP 文件系统", description: "连接本地文件和目录工具" },
  { title: "自动任务调度", description: "定时运行提醒、搜索和检查任务" },
];

export function SkillMarketView({
  activePage,
  skills,
  locale,
  translationStatus = "idle",
  translationError = null,
  searchStatus = "idle",
  searchResults = [],
  suggestions,
  suggestionStatus = "idle",
  mcpError = null,
  onTranslateToChinese,
  onSearchSkillMarket,
  onRefreshSuggestions,
  onToggleSkillEnabled,
  onDeleteSkill,
  onDisableAllSkills,
  onDeleteAllSkills,
  onInstallSkillMarketResult,
  onOpenDetail,
}: SkillMarketViewProps) {
  const labels = locale.labels;
  const [source, setSource] = useState<WorkbenchSkillSearchSource>("github");
  const [kind, setKind] = useState<WorkbenchSkillSearchKind>("skill");
  const [query, setQuery] = useState("");

  const tools = skills.filter((s) => s.category === "tool");
  const agents = skills.filter((s) => s.category === "agent");
  const userSkills = skills.filter((s) => s.category === "skill");
  const mcpServers = skills.filter((s) => s.category === "mcp");
  const activeSuggestions = suggestions?.length ? suggestions : SEARCH_SUGGESTIONS;

  function runSearch(nextQuery = query) {
    const trimmed = nextQuery.trim();
    if (!trimmed) return;
    onSearchSkillMarket?.(trimmed, source, kind);
  }

  function openSkillDetail(detail: WorkbenchDetailItem) {
    onOpenDetail?.(detail);
  }

  return (
    <div className={`javis-view-panel ${activePage === "market" ? "javis-skill-market-home" : ""}`}>
      <div className="javis-skill-header">
        <div>
          <h2 className="javis-view-title">
            {activePage === "mine" ? "我的技能" : labels.skillMarketTitle}
          </h2>
          <div className="javis-skill-count">
            {skills.length} {labels.skillCategoryTool.toLowerCase()}
          </div>
        </div>
        <div className="javis-skill-header-actions">
          {activePage === "mine" ? (
            <div className="javis-skill-bulk-actions">
              <button
                className="javis-skill-bulk-button"
                disabled={!skills.some((skill) => skill.toggleable && skill.enabled)}
                onClick={onDisableAllSkills}
                type="button"
              >
                一键关闭
              </button>
              <button
                className="javis-skill-bulk-button danger"
                disabled={!skills.some((skill) => skill.removable)}
                onClick={onDeleteAllSkills}
                type="button"
              >
                一键删除
              </button>
            </div>
          ) : null}
          {activePage === "mine" && onTranslateToChinese ? (
            <div className="javis-skill-translate-wrapper">
              <button
                className="javis-skill-translate-button"
                disabled={translationStatus === "translating"}
                onClick={onTranslateToChinese}
                type="button"
              >
                <span aria-hidden="true" />
                {translationStatus === "translating"
                  ? "翻译中..."
                  : translationStatus === "error"
                    ? "重试翻译"
                    : "中文翻译"}
              </button>
              {translationStatus === "error" && translationError ? (
                <p className="javis-skill-translate-error" title={translationError}>
                  {formatTranslationError(translationError)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {activePage === "market" ? (
        <section className="javis-skill-market-browser">
          <div className="javis-skill-search-row">
            <label className="javis-skill-search-box">
              <select
                aria-label="技能来源"
                onChange={(event) => setSource(event.currentTarget.value as WorkbenchSkillSearchSource)}
                value={source}
              >
                <option value="github">GitHub</option>
              </select>
              <input
                aria-label="搜索技能"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    runSearch();
                  }
                }}
                placeholder="搜索技能关键词..."
                value={query}
              />
            </label>
            <button
              className="javis-skill-icon-button search"
              disabled={searchStatus === "searching"}
              onClick={() => runSearch()}
              type="button"
              title="搜索"
            >
              <span aria-hidden="true" />
            </button>
            <select
              aria-label="技能类型"
              className="javis-skill-kind-select"
              onChange={(event) => setKind(event.currentTarget.value as WorkbenchSkillSearchKind)}
              value={kind}
            >
              <option value="skill">Skill</option>
              <option value="mcp">MCP</option>
            </select>
          </div>

          {searchStatus === "error" ? (
            <p className="javis-skill-search-status">搜索失败，请检查网页搜索配置后重试。</p>
          ) : searchStatus === "searching" ? (
            <p className="javis-skill-search-status">正在通过网页搜索 Agent 搜索 GitHub...</p>
          ) : null}

          {searchResults.length > 0 ? (
            <section className="javis-skill-section">
              <h3>搜索结果</h3>
              <div className="javis-skill-grid">
                {searchResults.map((result) => (
                  <div
                    className={`javis-skill-card javis-skill-result-card ${result.installed ? "installed" : ""}`}
                    key={result.id}
                  >
                    <button
                      className="javis-skill-result-main"
                      onClick={() => openSkillDetail({
                        title: result.title,
                        description: result.description,
                        kind: result.kind,
                        source: result.source,
                        url: result.url,
                        metadata: [
                          { label: "来源", value: String(result.source) },
                          { label: "类型", value: result.kind },
                        ],
                      })}
                      type="button"
                    >
                      <span className="javis-skill-card-icon icon-skills" aria-hidden="true" />
                      <div className="javis-skill-card-header">
                        <span className="javis-skill-name">{result.title}</span>
                        <span className="javis-skill-owner-chip">{result.source}</span>
                      </div>
                    </button>
                    <p className="javis-skill-desc">{result.description}</p>
                    <p className="javis-skill-result-safety">
                      GitHub 搜索结果，安装前仅做基础结构校验；启用后仍受 Javis 权限和 MCP 只读白名单限制。
                    </p>
                    {result.installError ? (
                      <p className="javis-skill-install-error">{result.installError}</p>
                    ) : null}
                    <button
                      className="javis-skill-action-button"
                      disabled={result.installed || result.installing}
                      onClick={() => onInstallSkillMarketResult?.(result)}
                      type="button"
                    >
                      {result.installed ? "已安装" : result.installing ? "安装中..." : "安装"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="javis-skill-section">
            <div className="javis-skill-section-header">
              <h3>搜索建议</h3>
              <button
                aria-label="基于 GitHub 热榜和记忆侧写刷新推荐"
                className={`javis-skill-icon-button refresh ${suggestionStatus === "refreshing" ? "loading" : ""}`}
                disabled={suggestionStatus === "refreshing" || !onRefreshSuggestions}
                onClick={() => onRefreshSuggestions?.(source, kind)}
                title={suggestionStatus === "refreshing" ? "正在刷新推荐" : "基于 GitHub 热榜和记忆侧写刷新推荐"}
                type="button"
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {suggestionStatus === "error" ? (
              <p className="javis-skill-search-status">推荐刷新失败，已保留当前建议。</p>
            ) : null}
            <div className="javis-hot-skill-grid">
              {activeSuggestions.map((skill) => (
                <button
                  className="javis-skill-card javis-hot-skill-card"
                  key={`${skill.source ?? "local"}-${skill.url ?? skill.title}`}
                  onClick={() => {
                    setQuery(skill.title);
                    openSkillDetail({
                      title: skill.title,
                      description: skill.description,
                      kind,
                      source: skill.source ?? source,
                      url: skill.url,
                      metadata: [
                        { label: "来源", value: skill.source ?? source },
                        { label: "类型", value: kind },
                      ],
                    });
                    runSearch(skill.title);
                  }}
                  type="button"
                >
                  <strong>{skill.title}</strong>
                  <span>{skill.description}</span>
                </button>
              ))}
            </div>
          </section>
        </section>
      ) : (
        <>
          {tools.length > 0 && (
            <section className="javis-skill-section">
              <h3>{labels.skillCategoryTool}</h3>
              <div className="javis-skill-grid">
                {tools.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    labels={labels}
                    onToggleEnabled={onToggleSkillEnabled}
                    skill={skill}
                  />
                ))}
              </div>
            </section>
          )}

          {userSkills.length > 0 && (
            <section className="javis-skill-section">
              <h3>Codex Skills</h3>
              <div className="javis-skill-grid">
                {userSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    labels={labels}
                    onDelete={onDeleteSkill}
                    onToggleEnabled={onToggleSkillEnabled}
                    skill={skill}
                  />
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
                  <SkillCard
                    key={skill.id}
                    labels={labels}
                    onDelete={onDeleteSkill}
                    onToggleEnabled={onToggleSkillEnabled}
                    skill={skill}
                  />
                ))}
              </div>
            </section>
          )}

          {mcpServers.length === 0 && (
            <section className="javis-skill-section">
              <h3>{labels.skillCategoryMcp}</h3>
              <p className="javis-skill-empty">
                {mcpError ? `${labels.mcpLoadError}: ${mcpError}` : labels.noMcpConfig}
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function formatTranslationError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("api key") || lower.includes("api_key") || lower.includes("apikey") || lower.includes("unauthorized") || lower.includes("401")) {
    return "API 密钥未配置或无效，请检查模型设置";
  }
  if (lower.includes("network") || lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("timeout")) {
    return "网络连接失败，请检查网络和 baseUrl 配置";
  }
  if (lower.includes("json") || lower.includes("expected") || lower.includes("syntaxerror") || lower.includes("did not contain")) {
    return "模型返回格式异常，请重试或更换模型";
  }
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) {
    return "请求过于频繁，请稍后重试";
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("404"))) {
    return "模型不存在，请检查模型名称配置";
  }
  return error.length > 60 ? `${error.slice(0, 57)}...` : error;
}

function SkillCard({
  skill,
  labels,
  onToggleEnabled,
  onDelete,
}: {
  skill: WorkbenchSkillEntry;
  labels: WorkbenchLocale["labels"];
  onToggleEnabled?: (id: string, enabled: boolean) => void;
  onDelete?: (id: string) => void;
}) {
  const permColor = skill.permissionLevel
    ? PERMISSION_COLORS[skill.permissionLevel] ?? "#6f7d75"
    : undefined;
  const icon = getSkillIconName(skill);

  return (
    <div className={`javis-skill-card ${skill.enabled ? "" : "disabled"}`}>
      <div className="javis-skill-card-top">
        <span className={`javis-skill-card-icon icon-${icon}`} aria-hidden="true" />
        <div className="javis-skill-card-header">
          <span className="javis-skill-name">{skill.name}</span>
          {skill.permissionLevel && (
            <span className="javis-skill-perm-chip" style={{ color: permColor }}>
              {PERMISSION_LABELS[skill.permissionLevel] ?? skill.permissionLevel}
            </span>
          )}
        </div>
      </div>
      {skill.toggleable ? (
        <label className="javis-skill-toggle">
          <input
            checked={skill.enabled}
            onChange={(event) => onToggleEnabled?.(skill.id, event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{skill.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      ) : null}
      {skill.removable ? (
        <button
          className="javis-skill-delete-button"
          onClick={() => onDelete?.(skill.id)}
          type="button"
        >
          删除
        </button>
      ) : null}
      <p className="javis-skill-desc">{skill.description}</p>
      {skill.installError ? (
        <p className="javis-skill-install-error">{skill.installError}</p>
      ) : null}
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
      ) : skill.agentOwners.length > 0 ? (
        <div className="javis-skill-owners">
          {skill.agentOwners.map((owner) => (
            <span className="javis-skill-owner-chip" key={owner}>
              {owner}
            </span>
          ))}
        </div>
      ) : skill.path ? (
        <div className="javis-skill-owners">
          <span className="javis-skill-owner-chip muted">{skill.path}</span>
        </div>
      ) : null}
    </div>
  );
}

function getSkillIconName(skill: WorkbenchSkillEntry): string {
  const haystack = `${skill.id} ${skill.name} ${skill.description} ${skill.category}`.toLowerCase();
  const match = SKILL_ICON_RULES.find(([keyword]) => haystack.includes(keyword));
  return match?.[1] ?? (skill.category === "agent" ? "user" : skill.category === "mcp" ? "server" : "skills");
}
