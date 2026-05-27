import { useMemo } from "react";
import { marked } from "marked";

interface MarkdownProps {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: MarkdownProps) {
  const html = useMemo(() => {
    if (!text) return "";
    return marked.parse(text, {
      async: false,
      breaks: true,
      gfm: true,
    }) as string;
  }, [text]);

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
