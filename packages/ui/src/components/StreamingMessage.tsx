import { useEffect, useRef } from "react";

interface StreamingMessageProps {
  text: string;
  isStreaming: boolean;
  agentLabel: string;
}

export function StreamingMessage({
  text,
  isStreaming,
  agentLabel,
}: StreamingMessageProps) {
  const bodyRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [text]);

  return (
    <article className="javis-message streaming">
      <p className="javis-message-title">{agentLabel}</p>
      <p className="javis-message-body" ref={bodyRef}>
        {text}
        {isStreaming && <span className="javis-cursor-blink">|</span>}
      </p>
    </article>
  );
}
