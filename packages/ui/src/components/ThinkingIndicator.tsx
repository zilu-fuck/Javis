import { memo, useEffect, useState } from "react";

interface ThinkingIndicatorProps {
  label?: string;
  messages?: string[];
}

const DEFAULT_MESSAGES = [
  "Understanding your message",
  "Choosing the right path",
  "Preparing a response",
];

export const ThinkingIndicator = memo(function ThinkingIndicator({
  label = "Thinking",
  messages = DEFAULT_MESSAGES,
}: ThinkingIndicatorProps) {
  const [index, setIndex] = useState(0);
  const visibleMessages = messages.length > 0 ? messages : DEFAULT_MESSAGES;

  useEffect(() => {
    if (visibleMessages.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % visibleMessages.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [visibleMessages.length]);

  return (
    <span className="javis-thinking-indicator" aria-label={label}>
      <span />
      <span />
      <span />
      <small>{visibleMessages[index]}</small>
    </span>
  );
});
