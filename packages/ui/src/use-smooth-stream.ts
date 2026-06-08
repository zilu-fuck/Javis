import { useCallback, useEffect, useRef, useState } from "react";

interface UseSmoothStreamOptions {
  content: string;
  isStreaming: boolean;
  minDelay?: number;
}

interface UseSmoothStreamResult {
  displayedContent: string;
  isSettled: boolean;
}

type SegmenterLike = {
  segment(text: string): Iterable<{ segment: string }>;
};

const segmenter = createSegmenter();

function createSegmenter(): SegmenterLike | null {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[]) => SegmenterLike;
  }).Segmenter;
  return Segmenter
    ? new Segmenter(["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"])
    : null;
}

function segmentText(text: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(text)).map((part) => part.segment)
    : Array.from(text);
}

export function useSmoothStream({
  content,
  isStreaming,
  minDelay = 10,
}: UseSmoothStreamOptions): UseSmoothStreamResult {
  const [displayedContent, setDisplayedContent] = useState(content);
  const [isSettled, setIsSettled] = useState(true);
  const chunkQueueRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);
  const displayedRef = useRef(content);
  const targetRef = useRef(content);
  const lastRenderTimeRef = useRef(0);
  const streamDoneRef = useRef(!isStreaming);

  streamDoneRef.current = !isStreaming;

  useEffect(() => {
    const previousContent = targetRef.current;
    if (content === previousContent) {
      return;
    }

    targetRef.current = content;

    if (content.startsWith(previousContent)) {
      const delta = content.slice(previousContent.length);
      if (delta) {
        chunkQueueRef.current.push(...segmentText(delta));
        setIsSettled(false);
      }
      return;
    }

    chunkQueueRef.current = [];
    displayedRef.current = content;
    setDisplayedContent(content);
    setIsSettled(true);
  }, [content]);

  const renderLoop = useCallback((currentTime: number) => {
    const queue = chunkQueueRef.current;

    if (queue.length === 0) {
      if (streamDoneRef.current) {
        if (displayedRef.current !== targetRef.current) {
          displayedRef.current = targetRef.current;
          setDisplayedContent(displayedRef.current);
        }
        setIsSettled(true);
      }
      rafRef.current = null;
      return;
    }

    if (currentTime - lastRenderTimeRef.current < minDelay) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }
    lastRenderTimeRef.current = currentTime;

    const divisor = streamDoneRef.current ? 4 : 8;
    const count = Math.max(1, Math.floor(queue.length / divisor));
    displayedRef.current += queue.splice(0, count).join("");
    setDisplayedContent(displayedRef.current);
    setIsSettled(false);

    if (queue.length > 0) {
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (displayedRef.current !== targetRef.current) {
      displayedRef.current = targetRef.current;
      setDisplayedContent(displayedRef.current);
    }
    setIsSettled(true);
    rafRef.current = null;
  }, [minDelay]);

  useEffect(() => {
    if (chunkQueueRef.current.length > 0 && rafRef.current === null) {
      setIsSettled(false);
      rafRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (!isStreaming && displayedRef.current !== targetRef.current && rafRef.current === null) {
      setIsSettled(false);
      rafRef.current = requestAnimationFrame(renderLoop);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [content, isStreaming, renderLoop]);

  return { displayedContent, isSettled };
}
