import { describe, expect, it } from "vitest";
import {
  inferPrimarySpecialistAgentHint,
  requiresExplicitTargetClarification,
} from "./agent-intent";
import { inferVisionMode, isImageContentAnalysisRequest } from "./vision-utils";

describe("image specialist routing", () => {
  it("routes a short attached-image text question to Vision OCR", () => {
    const prompt = "看看这张图写了什么 data:image/png;base64,AA==";

    expect(isImageContentAnalysisRequest(prompt)).toBe(true);
    expect(inferVisionMode(prompt)).toBe("ocr");
    expect(inferPrimarySpecialistAgentHint(prompt)).toEqual(expect.objectContaining({
      agentKind: "vision",
      reason: "image_ocr_intent",
      capabilities: ["image_ocr", "vision.extractText"],
    }));
  });

  it("does not confuse image-related code work or screen capture with image analysis", () => {
    expect(isImageContentAnalysisRequest("分析图片上传组件的代码")).toBe(false);
    expect(isImageContentAnalysisRequest("截一下当前桌面")).toBe(false);
    expect(inferPrimarySpecialistAgentHint("修复图片上传组件的报错")?.agentKind).not.toBe("vision");
  });
});

describe("short specialist and clarification intents", () => {
  it("recognizes natural language-review wording without confusing typecheck commands", () => {
    expect(inferPrimarySpecialistAgentHint("TypeScript 这块写得规范吗？"))
      .toEqual(expect.objectContaining({ agentKind: "language-reviewer" }));
    expect(inferPrimarySpecialistAgentHint("跑一下 TypeScript 类型检查"))
      .toEqual(expect.objectContaining({ agentKind: "test-runner" }));
  });

  it("asks for an unresolved file action but accepts a concrete path", () => {
    expect(requiresExplicitTargetClarification("帮我处理一下那个文件。"))
      .toBe(true);
    expect(requiresExplicitTargetClarification("帮我修改 packages/core/src/index.ts。"))
      .toBe(false);
    expect(requiresExplicitTargetClarification("帮我处理一下那个文件。", {
      hasResolvedTarget: true,
    })).toBe(false);
  });
});
