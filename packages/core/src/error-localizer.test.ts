import { describe, expect, it } from "vitest";
import { localizeError } from "./error-localizer";

describe("localizeError", () => {
  it("localizes non-Windows OS credential store errors", () => {
    expect(
      localizeError(
        "Could not read model API key from OS credential store: backend unavailable",
        "zh-CN",
      ),
    ).toBe("无法从系统凭据存储读取模型 API 密钥: backend unavailable");
    expect(
      localizeError("Model API key must be read from the OS credential store.", "zh-CN"),
    ).toBe("模型 API 密钥必须从系统凭据存储读取。");
  });
});
