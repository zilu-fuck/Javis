import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreamingMessage } from "./StreamingMessage";

describe("StreamingMessage", () => {
  it("renders the agent label", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="Hello" isStreaming={false} agentLabel="Commander" />,
    );
    expect(html).toContain("Commander");
    expect(html).toContain("javis-message-title");
  });

  it("renders the streamed text body", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="Analyzing project..." isStreaming={false} agentLabel="Research" />,
    );
    expect(html).toContain("Analyzing project...");
    expect(html).toContain("javis-message-body");
  });

  it("shows blinking cursor when streaming is active", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="partial" isStreaming={true} agentLabel="Code" />,
    );
    expect(html).toContain("javis-cursor-blink");
    expect(html).toContain("|</span>");
  });

  it("shows a thinking indicator before the first streamed token", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="" isStreaming={true} agentLabel="Commander" />,
    );
    expect(html).toContain("javis-thinking-indicator");
    expect(html).toContain("Understanding your message");
    expect(html).not.toContain("javis-cursor-blink");
  });

  it("renders localized thinking messages", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage
        text=""
        isStreaming={true}
        agentLabel="Javis · 指挥官"
        thinkingLabel="思考中"
        thinkingMessages={["正在选择合适路径"]}
      />,
    );
    expect(html).toContain("正在选择合适路径");
    expect(html).toContain("思考中");
  });

  it("hides blinking cursor when streaming is complete", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="complete output" isStreaming={false} agentLabel="Verifier" />,
    );
    expect(html).not.toContain("javis-cursor-blink");
    expect(html).toContain("complete output");
  });

  it("applies streaming CSS class", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="x" isStreaming={true} agentLabel="File" />,
    );
    expect(html).toContain("javis-message streaming");
  });

  it("renders as an article element", () => {
    const html = renderToStaticMarkup(
      <StreamingMessage text="" isStreaming={false} agentLabel="Shell" />,
    );
    expect(html).toContain("<article");
    expect(html).toContain("</article>");
  });
});
