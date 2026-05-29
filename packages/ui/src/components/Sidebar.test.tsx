import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { zhCNWorkbenchLocale } from "../locale";

const labels = zhCNWorkbenchLocale.labels;

describe("Sidebar", () => {
  it("renders nav items for each built-in view", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("新建对话");
    expect(html).toContain("自动任务");
    expect(html).toContain("技能广场");
  });

  it("adds active class to the current view", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        activeView="skills"
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("javis-nav-item active");
    expect(html).toContain("技能广场");
  });

  it("renders the search input with placeholder", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery="project"
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain('placeholder="搜索"');
    expect(html).toContain('value="project"');
  });

  it("renders the Javis brand", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("javis-brand");
    expect(html).toContain(">Javis<");
  });

  it("renders local knowledge base section header", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("本地知识库");
  });

  it("renders settings trigger", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("javis-settings-trigger");
    expect(html).toContain("设置");
  });

  it("renders badge for scheduled task count", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        scheduledTaskCount={3}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("javis-nav-badge");
    expect(html).toContain(">3<");
  });

  it("renders plugins section header when custom nav items exist", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        sidebarNavItems={[
          { viewId: "writing-workbench", icon: "X", label: "Writing", group: "custom", order: 0 },
        ]}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("插件");
    expect(html).toContain("Writing");
  });

  it("renders sidebar resize handle with ARIA attributes", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("javis-sidebar-resize-handle");
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
  });

  it("renders empty history placeholder when entries are empty", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    expect(html).toContain("暂无历史");
  });

  it("switches the compose mode from the new chat submenu", () => {
    const onChangeActiveView = vi.fn();
    const onSelectComposeMode = vi.fn();
    const { container } = render(
      <Sidebar
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onChangeActiveView={onChangeActiveView}
        onSelectComposeMode={onSelectComposeMode}
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    const projectBtn = Array.from(container.querySelectorAll(".javis-nav-subitem"))
      .find((el) => el.textContent === labels.project);
    fireEvent.click(projectBtn!);

    expect(onChangeActiveView).toHaveBeenCalledWith("chat");
    expect(onSelectComposeMode).toHaveBeenCalledWith("project");
  });

  it("resets the compose mode to chat when opening new chat from another view", () => {
    const onChangeActiveView = vi.fn();
    const onSelectComposeMode = vi.fn();
    const { container } = render(
      <Sidebar
        activeView="skills"
        activeComposeMode="project"
        labels={labels}
        locale={zhCNWorkbenchLocale}
        modelSettings={{ provider: "", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        historyEntries={[]}
        sidebarSearchQuery=""
        onChangeActiveView={onChangeActiveView}
        onSelectComposeMode={onSelectComposeMode}
        onSidebarSearchQueryChange={vi.fn()}
      />,
    );

    fireEvent.click(container.querySelector(".javis-nav-item.collapsible")!);

    expect(onSelectComposeMode).toHaveBeenCalledWith("chat");
    expect(onChangeActiveView).toHaveBeenCalledWith("chat");
  });
});
