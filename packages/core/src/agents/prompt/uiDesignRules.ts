import type { AgentPromptLocale } from "./styleLoader";

export function getUiGenerationDesignRules(locale: AgentPromptLocale): string {
  if (locale === "zhCN") {
    return [
      "## UI 生成设计规则",
      "- 仅用于 UI 生成 Agent 或明确的 UI 生成任务；不要注入全局 prompt。",
      "- 首屏交付可用工作界面，不做营销落地页，除非用户明确要求。",
      "- 延续现有设计系统、密度、颜色和组件；没有系统时保持克制、可扫描。",
      "- 工具栏用图标按钮，模式用分段控件，选项用菜单，视图用 tabs，布尔项用开关/复选框。",
      "- 布局需有稳定尺寸和响应式约束；文本、控件、浮层不得重叠或挤出容器。",
      "- 表单、空态、加载、错误、禁用和成功状态要可用。",
      "- 交互控件要有清晰可达的名称、键盘焦点和禁用原因；不要用说明文字代替控件本身。",
      "- 改 UI 后优先跑最小相关类型检查、测试或截图验证；失败时报告具体失败。",
    ].join("\n");
  }

  return [
    "## UI Generation Design Rules",
    "- Use only for UI-generation agents/tasks; do not inject into the global prompt.",
    "- Make the first screen the usable work surface, not a marketing page unless requested.",
    "- Match the existing design system, density, colors, and components; if none exists, stay restrained and scannable.",
    "- Use icon buttons for tools, segmented controls for modes, menus for options, tabs for views, and toggles/checkboxes for booleans.",
    "- Give layouts stable dimensions and responsive constraints; text, controls, and overlays must not overlap or spill.",
    "- Include usable form, empty, loading, error, disabled, and success states.",
    "- Controls need accessible names, keyboard focus, and clear disabled reasons; do not replace real controls with explanatory text.",
    "- After UI edits, prefer the smallest relevant typecheck, test, or screenshot verification; report exact failures.",
  ].join("\n");
}
