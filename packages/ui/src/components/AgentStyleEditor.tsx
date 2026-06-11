import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchAgentCatalogEntry, WorkbenchAgentStyleState, WorkbenchLocale } from "../types";
import "./AgentStyleEditor.css";

export interface AgentStylePreset {
  id: string;
  zhLabel: string;
  enLabel: string;
  content: string;
}

export interface AgentStyleConflict {
  id: string;
  zhMessage: string;
  enMessage: string;
}

export interface AgentStyleEditorProps {
  labels: WorkbenchLocale["labels"];
  locale?: WorkbenchLocale;
  agentCatalog?: WorkbenchAgentCatalogEntry[];
  currentWorkspacePath?: string;
  onReadAgentStyle?: (kind: string) => Promise<WorkbenchAgentStyleState>;
  onSaveAgentStyle?: (kind: string, content: string) => Promise<WorkbenchAgentStyleState | void>;
  onResetAgentStyle?: (kind: string) => Promise<WorkbenchAgentStyleState | void>;
}

const MAX_STYLE_LENGTH = 2000;
const REFRESH_INTERVAL_MS = 5000;

const FALLBACK_AGENTS: WorkbenchAgentCatalogEntry[] = [
  { kind: "commander", displayName: "Commander" },
  { kind: "file", displayName: "File Agent" },
  { kind: "shell", displayName: "Shell Agent" },
  { kind: "browser", displayName: "Browser Agent" },
  { kind: "computer", displayName: "Computer Agent" },
  { kind: "scheduler", displayName: "Scheduler Agent" },
  { kind: "research", displayName: "Research Agent" },
  { kind: "code", displayName: "Code Agent" },
  { kind: "verifier", displayName: "Verifier" },
  { kind: "workspace", displayName: "Workspace Agent" },
  { kind: "vision", displayName: "Vision Agent" },
];

const PRESETS: AgentStylePreset[] = [
  {
    id: "professional",
    zhLabel: "专业严谨",
    enLabel: "Professional",
    content: [
      "你是一个专业、严谨、克制的工程助手。",
      "",
      "风格要求：",
      "- 先确认事实和边界，再给结论",
      "- 重要判断说明依据和风险",
      "- 不夸大、不编造、不用营销式表达",
      "- 对不确定内容明确标注不确定",
    ].join("\n"),
  },
  {
    id: "direct",
    zhLabel: "简洁直接",
    enLabel: "Concise",
    content: [
      "你是一个直接、耐心的工程化助手。",
      "",
      "风格要求：",
      "- 先给结论，再解释原因",
      "- 遇到 bug 时优先指出最可能的问题",
      "- 代码示例要完整可运行",
      "- 不要写太多空泛解释",
    ].join("\n"),
  },
  {
    id: "teaching",
    zhLabel: "详细教学",
    enLabel: "Teaching",
    content: [
      "你是一个循序渐进的教学型助手。",
      "",
      "风格要求：",
      "- 解释关键概念和上下文",
      "- 给出判断依据和替代方案",
      "- 复杂任务拆成清晰步骤",
      "- 对初学者容易误解的点主动提醒",
    ].join("\n"),
  },
  {
    id: "encouraging",
    zhLabel: "鼓励支持",
    enLabel: "Encouraging",
    content: [
      "你是一个温和、支持型的助手。",
      "",
      "风格要求：",
      "- 保持自然鼓励，但不过度热情",
      "- 先降低用户的理解负担，再推进问题",
      "- 遇到困难时给出下一步可执行动作",
      "- 语气稳定、清楚、有耐心",
    ].join("\n"),
  },
  {
    id: "default",
    zhLabel: "默认（无预设）",
    enLabel: "Default",
    content: "",
  },
];

const CONFLICT_PATTERNS: Array<{ id: string; pattern: RegExp; zhMessage: string; enMessage: string }> = [
  {
    id: "output-format",
    pattern: /(不要|无需|禁止|忽略).{0,12}(json|JSON|输出格式|schema)|do\s+not\s+output\s+json|ignore.{0,24}(format|schema)/i,
    zhMessage: "这段风格可能试图覆盖输出格式。系统会忽略这类要求。",
    enMessage: "This style may try to override the output format. System rules will ignore that part.",
  },
  {
    id: "tool-result",
    pattern: /(工具|tool).{0,20}(失败|failed).{0,20}(成功|success)|pretend.{0,24}(success|succeeded)/i,
    zhMessage: "这段风格可能要求伪造工具结果。工具真实结果始终优先。",
    enMessage: "This style may ask the agent to fake tool results. Actual tool results always take priority.",
  },
  {
    id: "write-approval",
    pattern: /(不需要|跳过|无需|ignore|skip).{0,16}(审批|确认|confirmed-write|approval)|write.{0,24}without.{0,24}approval/i,
    zhMessage: "这段风格可能试图绕过写入审批。confirmed-write 规则不会被覆盖。",
    enMessage: "This style may try to bypass write approval. confirmed-write rules cannot be overridden.",
  },
  {
    id: "system-rules",
    pattern: /(忽略|覆盖|无视).{0,16}(系统|规则|协议|提示词)|ignore.{0,24}(system|rules|protocol|prompt)/i,
    zhMessage: "这段风格可能试图覆盖系统规则。系统规则优先级更高。",
    enMessage: "This style may try to override system rules. Higher-priority system rules still win.",
  },
];

export function detectAgentStyleConflicts(content: string): AgentStyleConflict[] {
  const seen = new Set<string>();
  const conflicts: AgentStyleConflict[] = [];
  for (const item of CONFLICT_PATTERNS) {
    if (!seen.has(item.id) && item.pattern.test(content)) {
      seen.add(item.id);
      conflicts.push({
        id: item.id,
        zhMessage: item.zhMessage,
        enMessage: item.enMessage,
      });
    }
  }
  return conflicts;
}

export function AgentStyleEditor({
  labels,
  agentCatalog,
  onReadAgentStyle,
  onSaveAgentStyle,
  onResetAgentStyle,
}: AgentStyleEditorProps) {
  const isZh = labels.aiModeSettings === "AI 模式";
  const agents = useMemo(
    () => (agentCatalog?.length ? agentCatalog : FALLBACK_AGENTS).filter((agent) => agent.kind !== "chinese-reviewer"),
    [agentCatalog],
  );
  const [selectedKind, setSelectedKind] = useState(agents[0]?.kind ?? "commander");
  const [state, setState] = useState<WorkbenchAgentStyleState>({
    kind: selectedKind,
    currentStyle: "",
    source: "none",
  });
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const draftRef = useRef(draft);
  const stateRef = useRef(state);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const next = await readStyle(selectedKind);
      if (cancelled || !next) return;
      setState(next);
      setDraft(next.currentStyle);
      setStatus("idle");
      setMessage("");
    }

    setStatus("loading");
    void load().catch((error) => {
      if (cancelled) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, [selectedKind, onReadAgentStyle]);

  useEffect(() => {
    if (!onReadAgentStyle) return;
    let disposed = false;

    async function refreshFromDisk() {
      const next = await readStyle(selectedKind);
      if (disposed || !next) return;
      const currentState = stateRef.current;
      const isDirty = draftRef.current !== currentState.currentStyle;
      if (next.currentStyle === currentState.currentStyle && next.filePath === currentState.filePath && next.source === currentState.source) {
        return;
      }
      setState(next);
      if (!isDirty) {
        setDraft(next.currentStyle);
        setMessage(isZh ? "已重新载入外部修改" : "Reloaded external file changes");
        window.setTimeout(() => setMessage(""), 1800);
      } else {
        setMessage(isZh
          ? "检测到文件已被外部修改。保存会覆盖外部内容，恢复默认后可重新载入。"
          : "The style file changed outside Javis. Saving will overwrite it; restore or switch agents to reload.");
      }
    }

    const interval = window.setInterval(() => {
      void refreshFromDisk().catch(() => undefined);
    }, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshFromDisk);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshFromDisk);
    };
  }, [selectedKind, onReadAgentStyle, isZh]);

  async function readStyle(kind: string): Promise<WorkbenchAgentStyleState | undefined> {
    if (!onReadAgentStyle) {
      return { kind, currentStyle: "", source: "none" };
    }
    return onReadAgentStyle(kind);
  }

  async function handleSave() {
    if (!onSaveAgentStyle) return;
    setStatus("loading");
    try {
      const next = await onSaveAgentStyle(selectedKind, draft.slice(0, MAX_STYLE_LENGTH));
      const savedState = next ?? { ...state, currentStyle: draft.slice(0, MAX_STYLE_LENGTH) };
      setState(savedState);
      setDraft(savedState.currentStyle);
      setStatus("saved");
      setMessage(isZh ? "已保存" : "Saved");
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleReset() {
    if (!onResetAgentStyle) return;
    setStatus("loading");
    try {
      const next = await onResetAgentStyle(selectedKind);
      const resetState = next ?? { kind: selectedKind, currentStyle: "", source: "none" as const };
      setState(resetState);
      setDraft(resetState.currentStyle);
      setStatus("saved");
      setMessage(isZh ? "已恢复默认" : "Default restored");
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const selectedAgent = agents.find((agent) => agent.kind === selectedKind);
  const count = draft.length;
  const conflicts = detectAgentStyleConflicts(draft);
  const sourceLabel = state.source === "workspace"
    ? (isZh ? "工作区" : "Workspace")
    : state.source === "global"
      ? (isZh ? "全局" : "Global")
      : (isZh ? "无" : "None");

  return (
    <section className="javis-agent-style-editor" aria-label={isZh ? "Agent 个性化" : "Agent personalization"}>
      <h2>{isZh ? "Agent 个性化" : "Agent Personalization"}</h2>
      <div className="javis-settings-card javis-agent-style-card">
        <div className="javis-agent-style-grid">
          <label>
            <span>Agent</span>
            <select value={selectedKind} onChange={(event) => setSelectedKind(event.currentTarget.value)}>
              {agents.map((agent) => (
                <option key={agent.kind} value={agent.kind}>
                  {agent.displayName || agent.kind}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{isZh ? "风格模板" : "Style Template"}</span>
            <select
              value=""
              onChange={(event) => {
                const preset = PRESETS.find((item) => item.id === event.currentTarget.value);
                if (preset) setDraft(preset.content);
              }}
            >
              <option value="">{isZh ? "一键套用模板" : "Apply template"}</option>
              {PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {isZh ? preset.zhLabel : preset.enLabel}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="javis-agent-style-help">
          {isZh
            ? "调整 Agent 的表达风格。这不会改变工具权限、输出格式或系统行为。"
            : "Adjust how the agent expresses itself. Tool permissions, output formats, and system behavior stay unchanged."}
        </p>

        <div className="javis-agent-style-path">
          <span>{isZh ? "当前生效" : "Effective source"}: {sourceLabel}</span>
          <code>{state.filePath ?? `agent-styles/${selectedKind}.md`}</code>
        </div>

        <textarea
          aria-label={`${selectedAgent?.displayName ?? selectedKind} style`}
          maxLength={MAX_STYLE_LENGTH}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={isZh ? "用 Markdown 写下这个 Agent 的语气和表达偏好..." : "Write this agent's tone and expression preferences in Markdown..."}
          value={draft}
        />

        {conflicts.length > 0 ? (
          <div className="javis-agent-style-conflicts" role="status">
            <strong>{isZh ? "规则冲突提示" : "Rule Conflict Hints"}</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.id}>{isZh ? conflict.zhMessage : conflict.enMessage}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="javis-agent-style-footer">
          <span className={count >= MAX_STYLE_LENGTH ? "limit" : ""}>
            {count}/{MAX_STYLE_LENGTH}
          </span>
          <div className="javis-agent-style-actions">
            <button disabled={status === "loading"} onClick={handleReset} type="button">
              {isZh ? "恢复默认" : "Restore Default"}
            </button>
            <button disabled={status === "loading"} onClick={handleSave} type="button">
              {isZh ? "保存" : "Save"}
            </button>
          </div>
        </div>
        {message ? <p className={`javis-agent-style-status ${status}`}>{message}</p> : null}
      </div>
    </section>
  );
}
