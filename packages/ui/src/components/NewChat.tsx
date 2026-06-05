import type { FormEventHandler } from "react";
import type {
  WorkbenchFileEntry,
  WorkbenchLocale,
  WorkbenchNewChatRecommendations,
  WorkbenchRecommendationItem,
} from "../types";
import { ChatComposer } from "./ChatComposer";

interface NewChatProps {
  composeMode: "chat" | "project";
  currentWorkspacePath: string;
  draftGoal: string;
  labels: WorkbenchLocale["labels"];
  recommendations?: WorkbenchNewChatRecommendations;
  recentWorkspacePaths: string[];
  showWorkspaceContext?: boolean;
  userDocuments?: WorkbenchFileEntry[];
  onBrowseWorkspacePath?: () => void;
  onDeleteRecentWorkspacePath?: (path: string) => void;
  onDraftGoalChange: (nextGoal: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onSubmitWithAttachments?: (goal: string, attachments: File[]) => void;
  onUseWorkspacePath?: (path: string) => void;
  onWorkspacePathChange?: (path: string) => void;
}

export function NewChat({
  composeMode,
  currentWorkspacePath,
  draftGoal,
  labels,
  recommendations,
  recentWorkspacePaths,
  showWorkspaceContext = false,
  userDocuments,
  onBrowseWorkspacePath,
  onDeleteRecentWorkspacePath,
  onDraftGoalChange,
  onSubmit,
  onSubmitWithAttachments,
  onUseWorkspacePath,
  onWorkspacePathChange,
}: NewChatProps) {
  const isProjectMode = composeMode === "project";
  const isChinese = labels.newChat !== "New chat";
  const primaryPrompts = recommendations?.primary.length
    ? recommendations.primary
    : defaultPrimaryPrompts(isChinese);
  const secondaryPrompts = recommendations?.secondary.length
    ? recommendations.secondary
    : defaultSecondaryPrompts(isChinese);

  return (
    <section className="javis-new-chat" aria-label={labels.newChat}>
      <h1>{isProjectMode ? labels.newChatTitle : labels.chatNewChatTitle}</h1>
      <div className="javis-new-chat-primary-prompts" aria-label={isChinese ? "快捷操作" : "Quick actions"}>
        {primaryPrompts.map((item) => (
          <RecommendationButton
            key={item.id}
            isChinese={isChinese}
            item={item}
            onDraftGoalChange={onDraftGoalChange}
          />
        ))}
      </div>
      <ChatComposer
        actionsClassName="javis-new-chat-actions"
        className="javis-new-chat-composer"
        currentWorkspacePath={currentWorkspacePath}
        draftGoal={draftGoal}
        labels={labels}
        recentWorkspacePaths={recentWorkspacePaths}
        showWorkspaceContext={showWorkspaceContext}
        taskInputPlaceholder={isProjectMode ? labels.taskInputPlaceholder : labels.chatTaskInputPlaceholder}
        userDocuments={userDocuments}
        onBrowseWorkspacePath={onBrowseWorkspacePath}
        onDeleteRecentWorkspacePath={onDeleteRecentWorkspacePath}
        onDraftGoalChange={onDraftGoalChange}
        onSubmit={onSubmit}
        onSubmitWithAttachments={onSubmitWithAttachments}
        onUseWorkspacePath={onUseWorkspacePath}
        onWorkspacePathChange={onWorkspacePathChange}
      />
      <div className="javis-new-chat-secondary-prompts" aria-label={isChinese ? "建议" : "Suggestions"}>
        {secondaryPrompts.map((item) => (
          <RecommendationButton
            key={item.id}
            isChinese={isChinese}
            item={item}
            onDraftGoalChange={onDraftGoalChange}
          />
        ))}
      </div>
    </section>
  );
}

function RecommendationButton({
  isChinese,
  item,
  onDraftGoalChange,
}: {
  isChinese: boolean;
  item: WorkbenchRecommendationItem;
  onDraftGoalChange: (nextGoal: string) => void;
}) {
  const evidenceCount = item.evidence?.length ?? 0;
  const accessibleLabel = item.reason ? `${item.label}。${item.reason}` : item.label;
  const title = [
    item.reason,
    ...(item.evidence ?? []).map((evidence) => evidence.title
      ? `${evidence.title}: ${evidence.snippet}`
      : evidence.snippet),
  ].filter(Boolean).join("\n");
  return (
    <button
      aria-label={accessibleLabel}
      data-source={item.source}
      onClick={() => onDraftGoalChange(item.prompt)}
      title={title || undefined}
      type="button"
    >
      <span aria-hidden="true" />
      {item.label}
      {item.reason ? <small>{sourceLabel(item.source, isChinese)}</small> : null}
      {evidenceCount > 0 ? (
        <small className="javis-recommendation-evidence">
          {isChinese ? `${evidenceCount} 条依据` : `${evidenceCount} refs`}
        </small>
      ) : null}
    </button>
  );
}

function sourceLabel(source: WorkbenchRecommendationItem["source"], isChinese: boolean): string {
  switch (source) {
    case "profile":
      return isChinese ? "侧写" : "Profile";
    case "workspace":
      return isChinese ? "项目" : "Project";
    case "history":
      return isChinese ? "历史" : "History";
    default:
      return "";
  }
}

function defaultPrimaryPrompts(isChinese: boolean): WorkbenchRecommendationItem[] {
  return isChinese
    ? [
        { id: "default-create-task", label: "创建任务", prompt: "帮我规划一个任务，并拆解成可执行步骤。", source: "default" },
        { id: "default-generate-doc", label: "生成文档", prompt: "根据当前项目资料生成一份结构清晰的文档。", source: "default" },
        { id: "default-write-code", label: "编写代码", prompt: "帮我实现一个功能，并说明改动点和验证方式。", source: "default" },
        { id: "default-analyze-data", label: "分析数据", prompt: "帮我分析一组数据，提炼结论和下一步建议。", source: "default" },
        { id: "default-more", label: "更多", prompt: "列出你可以在当前工作区帮我完成的事情。", source: "default" },
      ]
    : [
        { id: "default-create-task", label: "Create task", prompt: "Plan a task and break it into executable steps.", source: "default" },
        { id: "default-generate-doc", label: "Generate doc", prompt: "Create a clear document from the current project context.", source: "default" },
        { id: "default-write-code", label: "Write code", prompt: "Implement a feature and summarize the changes and verification.", source: "default" },
        { id: "default-analyze-data", label: "Analyze data", prompt: "Analyze data and extract conclusions and next steps.", source: "default" },
        { id: "default-more", label: "More", prompt: "List what you can help with in this workspace.", source: "default" },
      ];
}

function defaultSecondaryPrompts(isChinese: boolean): WorkbenchRecommendationItem[] {
  return isChinese
    ? [
        { id: "default-progress", label: "帮我梳理项目进度", prompt: "帮我梳理当前项目进度，列出已完成、进行中和下一步。", source: "default" },
        { id: "default-technical-plan", label: "生成一份技术方案", prompt: "基于当前项目生成一份技术方案，包含目标、步骤、风险和验证方式。", source: "default" },
        { id: "default-code-issues", label: "检查代码潜在问题", prompt: "检查当前项目代码的潜在问题，并给出优先级和修复建议。", source: "default" },
        { id: "default-research", label: "总结最新研究动态", prompt: "围绕当前主题总结最新研究动态，并提炼可行动建议。", source: "default" },
      ]
    : [
        { id: "default-progress", label: "Summarize project progress", prompt: "Summarize current project progress, including completed work, active work, and next steps.", source: "default" },
        { id: "default-technical-plan", label: "Draft a technical plan", prompt: "Draft a technical plan with goals, steps, risks, and verification.", source: "default" },
        { id: "default-code-issues", label: "Inspect possible code issues", prompt: "Inspect the current project for likely code issues and prioritize fixes.", source: "default" },
        { id: "default-research", label: "Summarize recent research", prompt: "Summarize recent research around the current topic and extract actionable suggestions.", source: "default" },
      ];
}
