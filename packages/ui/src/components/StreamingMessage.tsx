import { memo, useEffect, useRef } from "react";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface StreamingMessageProps {
  text: string;
  isStreaming: boolean;
  agentLabel: string;
  thinkingLabel?: string;
  thinkingMessages?: string[];
}

export const StreamingMessage = memo(function StreamingMessage({
  text,
  isStreaming,
  agentLabel,
  thinkingLabel,
  thinkingMessages,
}: StreamingMessageProps) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const lastScrollRef = useRef(0);
  const showThinking = isStreaming && text.trim().length === 0;

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
        {showThinking ? (
          <ThinkingIndicator label={thinkingLabel} messages={thinkingMessages} />
        ) : (
          <>
            {text}
            {isStreaming && <span className="javis-cursor-blink">|</span>}
          </>
        )}
      </p>
    </article>
  );
});
