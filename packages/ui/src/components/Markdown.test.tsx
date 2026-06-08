import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("sanitizes raw HTML and unsafe URLs", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={[
          "# Safe",
          "<script>alert('xss')</script>",
          "<img src=\"x\" onerror=\"alert('xss')\">",
          "<a href=\"javascript:alert('xss')\">bad</a>",
          "<a href=\"https://example.com\">good</a>",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h1>Safe</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not allow remote image sources from markdown content", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={[
          "![remote](https://example.com/tracker.png)",
          "![protocol-relative](//example.com/tracker.png)",
          "![local](/assets/logo.png)",
          "![inline](data:image/png;base64,AA==)",
        ].join("\n")}
      />,
    );

    expect(html).not.toContain("https://example.com/tracker.png");
    expect(html).not.toContain("//example.com/tracker.png");
    expect(html).toContain('src="/assets/logo.png"');
    expect(html).toContain('src="data:image/png;base64,AA=="');
  });
});
