import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getProviderCapabilities, resolveImageDataUrl, validateImageDataUrl } from "./app-runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("getProviderCapabilities", () => {
  it("returns capabilities for openai", () => {
    const caps = getProviderCapabilities("openai");
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.longContext).toBe(true);
  });

  it("returns capabilities for deepseek (no vision)", () => {
    const caps = getProviderCapabilities("deepseek");
    expect(caps.vision).toBe(false);
    expect(caps.code).toBe(true);
  });

  it("returns capabilities for deepseek-anthropic", () => {
    const caps = getProviderCapabilities("deepseek-anthropic");
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.longContext).toBe(true);
  });

  it("returns capabilities for anthropic", () => {
    const caps = getProviderCapabilities("anthropic");
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
  });

  it("falls back to OpenAIAdapter for unknown provider", () => {
    const caps = getProviderCapabilities("unknown-provider");
    // Should not throw — falls back to OpenAI adapter capabilities
    expect(caps.vision).toBe(true);
    expect(caps.code).toBe(true);
  });

  it("is case-insensitive", () => {
    const caps = getProviderCapabilities("DeepSeek");
    expect(caps.vision).toBe(false); // DeepSeek's actual capability
  });
});

describe("validateImageDataUrl", () => {
  it("accepts and normalizes supported image data URLs", () => {
    expect(validateImageDataUrl("DATA:image/jpg;base64,YWJjZA==")).toBe(
      "data:image/jpeg;base64,YWJjZA==",
    );
  });

  it("rejects malformed image data URLs", () => {
    expect(() => validateImageDataUrl("data:image/png;base64,")).toThrow("non-empty base64");
    expect(() => validateImageDataUrl("data:image/png;base64,abcde")).toThrow("valid padded base64");
    expect(() => validateImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow("PNG, JPEG");
  });
});

describe("resolveImageDataUrl", () => {
  it("passes workspace roots to the native image reader", async () => {
    invokeMock.mockResolvedValueOnce("data:image/png;base64,YWJjZA==");

    await expect(resolveImageDataUrl("images/pic.png", "E:/Javis")).resolves.toBe(
      "data:image/png;base64,YWJjZA==",
    );

    expect(invokeMock).toHaveBeenCalledWith("read_image_data_url", {
      path: "E:/Javis/images/pic.png",
      workspaceRoot: "E:/Javis",
      allowedRootIds: null,
    });
  });

  it("rejects local image paths without a selected workspace", async () => {
    await expect(resolveImageDataUrl("images/pic.png")).rejects.toThrow("selected workspace");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
