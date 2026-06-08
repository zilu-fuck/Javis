import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSmoothStream } from "./use-smooth-stream";

describe("useSmoothStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not spin animation frames while streaming has no new content", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    renderHook(() => useSmoothStream({ content: "", isStreaming: true }));

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("starts rendering only when content advances", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = renderHook(
      ({ content, isStreaming }) => useSmoothStream({ content, isStreaming }),
      { initialProps: { content: "", isStreaming: true } },
    );

    rerender({ content: "hello", isStreaming: true });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
