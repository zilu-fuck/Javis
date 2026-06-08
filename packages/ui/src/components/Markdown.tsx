import { useMemo, useDeferredValue } from "react";
import { marked } from "marked";

interface MarkdownProps {
  text: string;
  className?: string;
}

const ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const DROP_TAGS = new Set([
  "base",
  "canvas",
  "embed",
  "form",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "script",
  "style",
  "svg",
  "textarea",
]);

const GLOBAL_ATTRIBUTES = new Set(["aria-label", "title"]);
const ATTRIBUTES_BY_TAG: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "target", ...GLOBAL_ATTRIBUTES]),
  code: new Set(["class", ...GLOBAL_ATTRIBUTES]),
  img: new Set(["alt", "height", "src", "width", ...GLOBAL_ATTRIBUTES]),
  pre: new Set(["class", ...GLOBAL_ATTRIBUTES]),
  span: new Set(["class", ...GLOBAL_ATTRIBUTES]),
};

function sanitizeMarkdownHtml(html: string): string {
  if (typeof DOMParser === "undefined") {
    return html.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(document.body.children)) {
    sanitizeElement(element);
  }
  return document.body.innerHTML;
}

function sanitizeElement(element: Element): void {
  const tagName = element.tagName.toLowerCase();
  if (DROP_TAGS.has(tagName)) {
    element.remove();
    return;
  }

  for (const child of Array.from(element.children)) {
    sanitizeElement(child);
  }

  if (!ALLOWED_TAGS.has(tagName)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }

  const allowedAttributes = ATTRIBUTES_BY_TAG[tagName] ?? GLOBAL_ATTRIBUTES;
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (
      name.startsWith("on") ||
      name === "style" ||
      name === "srcdoc" ||
      !allowedAttributes.has(name) ||
      !isSafeAttributeValue(tagName, name, attribute.value)
    ) {
      element.removeAttribute(attribute.name);
    }
  }

  if (tagName === "a" && element.hasAttribute("href")) {
    element.setAttribute("rel", "noopener noreferrer");
  }
}

function isSafeAttributeValue(tagName: string, name: string, value: string): boolean {
  if (name !== "href" && name !== "src") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return true;
  if (isSafeRelativeUrl(trimmed)) return true;

  try {
    const url = new URL(trimmed, "https://javis.local");
    if (name === "href") {
      return ["http:", "https:", "mailto:"].includes(url.protocol);
    }
    if (tagName === "img" && name === "src") {
      return /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,/iu.test(trimmed);
    }
  } catch {
    return false;
  }

  return false;
}

function isSafeRelativeUrl(value: string): boolean {
  if (/^\/\/|^\/\\/u.test(value)) return false;
  return /^(\/|\.\.?\/)/u.test(value);
}

/**
 * Renders markdown to HTML. Uses React 19's useDeferredValue to avoid
 * blocking the main thread during large markdown content rendering.
 */
export function Markdown({ text, className }: MarkdownProps) {
  // Defer large content updates so the UI stays responsive
  const deferredText = useDeferredValue(text);

  const html = useMemo(() => {
    if (!deferredText) return "";
    return marked.parse(deferredText, {
      async: false,
      breaks: true,
      gfm: true,
    }) as string;
  }, [deferredText]);

  const sanitizedHtml = useMemo(() => {
    if (!html) return "";
    return sanitizeMarkdownHtml(html);
  }, [html]);

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
