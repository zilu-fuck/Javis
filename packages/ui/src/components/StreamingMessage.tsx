import { memo, useEffect, useRef } from "react";

interface StreamingMessageProps {
  text: string;
  isStreaming: boolean;
  agentLabel: string;
}

export const StreamingMessage = memo(function StreamingMessage({
  text,
  isStreaming,
  agentLabel,
}: StreamingMessageProps) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const lastScrollRef = useRef(0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    // Throttle scrolling during active streaming — smooth scroll
    // animation at 60fps is expensive and causes jank when called
    // on every token (20-60×/sec). Use instant scroll during streaming
    // and smooth only on completion.
    const now = performance.now();
    if (isStreaming && now - lastScrollRef.current < 150) return;
    lastScrollRef.current = now;

    el.scrollIntoView({
      behavior: isStreaming ? "instant" : "smooth",
      block: "nearest",
    });
  }, [text, isStreaming]);

  return (
    <article className="javis-message streaming">
      <p className="javis-message-title">{agentLabel}</p>
      <p className="javis-message-body" ref={bodyRef}>
        {text}
        {isStreaming && <span className="javis-cursor-blink">|</span>}
      </p>
    </article>
  );
});
