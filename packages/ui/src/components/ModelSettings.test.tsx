import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSettings } from "./ModelSettings";
import { defaultWorkbenchLocale, zhCNWorkbenchLocale } from "../locale";
import type {
  WorkbenchComputerUseLocalVisionSettings,
  WorkbenchComputerUseSettings,
  WorkbenchRuntimePreferences,
} from "../types";

const labels = zhCNWorkbenchLocale.labels;

describe("ModelSettings", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders settings trigger button", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain("javis-settings-trigger");
    expect(html).toContain(">设置<");
  });

  it("renders the settings trigger as a button", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain('<button class="javis-settings-trigger"');
    expect(html).toContain(">设置</span></button>");
  });

  it("renders with model configuration prop", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "openai-gpt-4-1",
              slot: null,
              displayName: "gpt-4.1",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.openai-gpt-4-1",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
      />,
    );

    expect(html).toContain("javis-settings-trigger");
    expect(html).toContain("设置");
  });

  it("wraps content in javis-settings div", () => {
    const html = renderToStaticMarkup(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    expect(html).toContain('<div class="javis-settings">');
    expect(html).toContain('<button class="javis-settings-trigger"');
  });

  it("shows provider console and default model slots without saved configuration", () => {
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));

    expect(document.body.querySelector(".javis-ai-provider-console")).not.toBeNull();
    expect(document.body.querySelector(".javis-ai-model-grid")).not.toBeNull();
    expect(document.body.querySelectorAll(".javis-ai-model-card")).toHaveLength(3);
  });

  it("renders assignable agent labels from the translated agent catalog", () => {
    const { container, getByText, queryByText } = render(
      <ModelSettings
        agentCatalog={[
          { kind: "custom-agent", displayName: "Custom Agent" },
          { kind: "chinese-reviewer", displayName: "Chinese Reviewer" },
        ]}
        labels={defaultWorkbenchLocale.labels}
        locale={{
          ...defaultWorkbenchLocale,
          phrases: {
            ...defaultWorkbenchLocale.phrases,
            "Custom Agent": "Translated Agent",
          },
        }}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(defaultWorkbenchLocale.labels.aiModeSettings));

    expect(getByText("Translated Agent")).toBeTruthy();
    expect(queryByText("custom-agent")).toBeNull();
    expect(queryByText("Chinese Reviewer")).toBeNull();
  });

  it("shows OpenAI-compatible providers from the built-in catalog", () => {
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));

    expect(getByText("OpenRouter")).toBeTruthy();
    expect(getByText("阿里云百炼 (DashScope)")).toBeTruthy();
    expect(getByText("Ollama (本地)")).toBeTruthy();
    expect(getByText("Google Gemini")).toBeTruthy();
  });

  it("renders profile memory controls in privacy settings", () => {
    const onRebuildUserProfileMemory = vi.fn();
    const onClearUserProfileMemory = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        userProfileMemorySummary={{
          factCount: 3,
          topTags: ["memory", "ui"],
          updatedAt: "2026-06-05T10:00:00.000Z",
          facts: [{
            id: "history:memory",
            text: "UserProfileMemory preference",
            tags: ["memory"],
            source: "history",
            confidence: 0.82,
            hitCount: 2,
            evidence: [{
              title: "Profile task",
              snippet: "The user asked to refine profile memory.",
            }],
          }],
        }}
        onRebuildUserProfileMemory={onRebuildUserProfileMemory}
        onClearUserProfileMemory={onClearUserProfileMemory}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.privacySecuritySettings));

    expect(getByText("侧写记忆")).toBeTruthy();
    expect(getByText("memory / ui")).toBeTruthy();
    expect(getByText("UserProfileMemory preference")).toBeTruthy();
    expect(getByText("Profile task")).toBeTruthy();
    fireEvent.click(getByText("重新提炼"));
    fireEvent.click(getByText("清空侧写"));

    expect(onRebuildUserProfileMemory).toHaveBeenCalledOnce();
    expect(onClearUserProfileMemory).toHaveBeenCalledOnce();
  });

  it("renders agent memory controls in privacy settings", () => {
    const onAgentMemoryEnabledChange = vi.fn();
    const onClearAgentMemory = vi.fn();
    const onClearWorkspaceAgentMemory = vi.fn();
    const onDeleteAgentMemoryFact = vi.fn();
    const { container, getByText, getByLabelText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        agentMemorySummary={{
          enabled: true,
          totalFactCount: 4,
          workspaceFactCount: 2,
          sessionSummaryCount: 1,
          injectionLogCount: 3,
          lastUpdatedAt: 1_700_000_000_000,
          recentFacts: [{
            id: "mem-1",
            fact: "用户希望 Javis 记忆本地优先",
            kind: "design_principle",
            tags: ["Javis", "memory"],
            scopeType: "workspace",
            scopeId: "workspace:abc",
            confidence: 0.95,
            importance: 5,
            updatedAt: 1_700_000_000_000,
          }],
        }}
        onAgentMemoryEnabledChange={onAgentMemoryEnabledChange}
        onClearAgentMemory={onClearAgentMemory}
        onClearWorkspaceAgentMemory={onClearWorkspaceAgentMemory}
        onDeleteAgentMemoryFact={onDeleteAgentMemoryFact}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.privacySecuritySettings));

    expect(getByText("Agent 记忆")).toBeTruthy();
    expect(getByText("用户希望 Javis 记忆本地优先")).toBeTruthy();
    fireEvent.click(getByLabelText("Agent 记忆范围"));
    fireEvent.click(getByText("关闭"));
    fireEvent.click(getByLabelText("Delete memory fact mem-1"));
    fireEvent.click(getByText("清空当前工作区"));
    fireEvent.click(getByText("清空全部 Agent 记忆"));

    expect(onAgentMemoryEnabledChange).toHaveBeenCalledWith(false);
    expect(onDeleteAgentMemoryFact).toHaveBeenCalledWith("mem-1");
    expect(onClearWorkspaceAgentMemory).toHaveBeenCalledOnce();
    expect(onClearAgentMemory).toHaveBeenCalledOnce();
  });

  it("edits Computer Use local vision settings from the general tab", () => {
    const onComputerUseLocalVisionSettingsChange = vi.fn();
    const degradationDefaults = {
      disableAfterConsecutiveTimeouts: 2,
      disableAfterConsecutiveErrors: 2,
      disableAfterConsecutiveActionFailures: 2,
    };
    let localVisionSettings: WorkbenchComputerUseLocalVisionSettings = {
      mode: "off",
      modelPath: "",
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    };
    const renderSettings = () => (
      <ModelSettings
        labels={defaultWorkbenchLocale.labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        computerUseLocalVisionSettings={localVisionSettings}
        onComputerUseLocalVisionSettingsChange={(settings) => {
          localVisionSettings = settings;
          onComputerUseLocalVisionSettingsChange(settings);
          rerender(renderSettings());
        }}
      />
    );
    const { container, getByText, getByLabelText, rerender } = render(renderSettings());

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByLabelText("Local vision acceleration"));
    fireEvent.click(getByText("Prompt hints"));
    fireEvent.change(getByLabelText("YOLO ONNX model path"), {
      target: { value: "E:/models/yolo26n-ui.onnx" },
    });
    fireEvent.click(getByLabelText("Local vision runtime"));
    fireEvent.click(getByText("ONNX Runtime"));
    fireEvent.change(getByLabelText("Runtime adapter path"), {
      target: { value: "E:/models/yolo26-ui-adapter.mjs" },
    });
    fireEvent.change(getByLabelText("Detection timeout"), {
      target: { value: "80" },
    });
    fireEvent.change(getByLabelText("Local vision image size"), {
      target: { value: "960" },
    });
    fireEvent.change(getByLabelText("Minimum confidence"), {
      target: { value: "0.6" },
    });
    fireEvent.change(getByLabelText("Maximum detections"), {
      target: { value: "12" },
    });
    fireEvent.change(getByLabelText("IoU threshold"), {
      target: { value: "0.3" },
    });
    fireEvent.change(getByLabelText("Prompt candidate limit"), {
      target: { value: "0" },
    });
    fireEvent.change(getByLabelText("Disable after timeouts"), {
      target: { value: "1" },
    });
    fireEvent.change(getByLabelText("Disable after errors"), {
      target: { value: "0" },
    });
    fireEvent.change(getByLabelText("Disable after action failures"), {
      target: { value: "3" },
    });
    fireEvent.click(getByLabelText("Reuse local vision worker"));

    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "",
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "auto",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 640,
      timeoutMs: 120,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 640,
      timeoutMs: 80,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 20,
      minConfidence: 0.75,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 20,
      minConfidence: 0.6,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.45,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 8,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      ...degradationDefaults,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 2,
      disableAfterConsecutiveActionFailures: 2,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 2,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: false,
    });
    expect(onComputerUseLocalVisionSettingsChange).toHaveBeenCalledWith({
      mode: "prompt_hint",
      modelPath: "E:/models/yolo26n-ui.onnx",
      runtime: "onnxruntime",
      runtimeAdapterPath: "E:/models/yolo26-ui-adapter.mjs",
      imgsz: 960,
      timeoutMs: 80,
      maxDetections: 12,
      minConfidence: 0.6,
      iouThreshold: 0.3,
      promptTopK: 0,
      disableAfterConsecutiveTimeouts: 1,
      disableAfterConsecutiveErrors: 0,
      disableAfterConsecutiveActionFailures: 3,
      reuseWorker: true,
    });
  });

  it("edits Computer Use base settings from the general tab", () => {
    const onComputerUseSettingsChange = vi.fn();
    const onRemoveTrustedComputerApp = vi.fn();
    let computerUseSettings: WorkbenchComputerUseSettings = {
      enabled: false,
      maxStepsPerTask: 20,
      mouseSpeed: "instant",
      mouseDurationMs: 200,
      typeDelayMs: 50,
      deniedWindowPatterns: [],
    };
    const renderSettings = () => (
      <ModelSettings
        labels={defaultWorkbenchLocale.labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        computerUseSettings={computerUseSettings}
        trustedComputerApps={[{ title: "Calculator", trustedAt: "2026-06-09T00:00:00.000Z" }]}
        onComputerUseSettingsChange={(settings) => {
          computerUseSettings = settings;
          onComputerUseSettingsChange(settings);
          rerender(renderSettings());
        }}
        onRemoveTrustedComputerApp={onRemoveTrustedComputerApp}
      />
    );
    const { container, getByLabelText, getByText, rerender } = render(renderSettings());

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByLabelText("Enable Computer Use"));
    fireEvent.change(getByLabelText("Maximum Computer Use steps"), {
      target: { value: "12" },
    });
    fireEvent.click(getByLabelText("Computer Use mouse speed"));
    fireEvent.click(getByText("Linear"));
    fireEvent.change(getByLabelText("Computer Use mouse duration"), {
      target: { value: "300" },
    });
    fireEvent.change(getByLabelText("Computer Use type delay"), {
      target: { value: "15" },
    });
    fireEvent.change(getByLabelText("Denied Computer Use window patterns"), {
      target: { value: "Task Manager\nAdmin Console" },
    });
    expect(getByText("Calculator")).toBeTruthy();
    fireEvent.click(getByText("Remove"));

    expect(onComputerUseSettingsChange).toHaveBeenCalledWith({
      enabled: true,
      maxStepsPerTask: 20,
      mouseSpeed: "instant",
      mouseDurationMs: 200,
      typeDelayMs: 50,
      deniedWindowPatterns: [],
    });
    expect(onComputerUseSettingsChange).toHaveBeenCalledWith({
      enabled: true,
      maxStepsPerTask: 12,
      mouseSpeed: "instant",
      mouseDurationMs: 200,
      typeDelayMs: 50,
      deniedWindowPatterns: [],
    });
    expect(onComputerUseSettingsChange).toHaveBeenCalledWith({
      enabled: true,
      maxStepsPerTask: 12,
      mouseSpeed: "linear",
      mouseDurationMs: 300,
      typeDelayMs: 15,
      deniedWindowPatterns: ["Task Manager", "Admin Console"],
    });
    expect(onRemoveTrustedComputerApp).toHaveBeenCalledWith("Calculator");
  });

  it("edits runtime preferences from the general, AI, and privacy tabs", () => {
    const onRuntimePreferencesChange = vi.fn();
    let runtimePreferences: WorkbenchRuntimePreferences = {
      appearanceTheme: "light",
      defaultStartupMode: "chat",
      contextStrategy: "auto",
      agentMaxRoundsPreset: "8",
      agentMaxRoundsCustom: 8,
      taskTimeoutPreset: "standard",
      taskTimeoutCustomMs: 90_000,
      agentMemoryScope: "workspace",
      agentMemoryEmbeddingMode: "local",
      agentMemoryEmbeddingProvider: "openai",
      agentMemoryEmbeddingModel: "text-embedding-3-small",
      agentMemoryEmbeddingBaseUrl: "https://api.openai.com/v1",
      agentMemoryEmbeddingApiKeyReference: "model.embedding",
      agentMemoryEmbeddingDimensions: 1536,
      taskQueuePolicy: "queue",
      failureRecoveryPolicy: "replan",
      userWaitTimeoutPreset: "standard",
      userWaitTimeoutCustomMs: 5 * 60_000,
    };
    const renderSettings = () => (
      <ModelSettings
        labels={defaultWorkbenchLocale.labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        runtimePreferences={runtimePreferences}
        agentMemorySummary={{
          enabled: runtimePreferences.agentMemoryScope !== "off",
          totalFactCount: 0,
          workspaceFactCount: 0,
          sessionSummaryCount: 0,
          injectionLogCount: 0,
          recentFacts: [],
        }}
        onRuntimePreferencesChange={(preferences) => {
          runtimePreferences = preferences;
          onRuntimePreferencesChange(preferences);
          rerender(renderSettings());
        }}
      />
    );
    const { container, getByText, getByLabelText, rerender } = render(renderSettings());

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByLabelText("Theme color"));
    fireEvent.click(getByText("Dark"));
    fireEvent.click(getByLabelText("Default startup mode"));
    fireEvent.click(getByText("Agent task"));
    fireEvent.click(getByLabelText("Task queue policy"));
    fireEvent.click(getByText("Interrupt with new task"));

    fireEvent.click(getByText(defaultWorkbenchLocale.labels.aiModeSettings));
    fireEvent.click(getByLabelText("Context strategy"));
    fireEvent.click(getByText("Long"));
    fireEvent.click(getByLabelText("Agent max rounds"));
    fireEvent.click(getByText("Custom"));
    fireEvent.change(getByLabelText("Custom rounds"), { target: { value: "10" } });
    fireEvent.click(getByLabelText("Task timeout strategy"));
    fireEvent.click(getByText("Long task"));
    fireEvent.click(getByLabelText("Failure recovery"));
    fireEvent.click(getByText("Stop on failure"));
    fireEvent.click(getByLabelText("User wait timeout"));
    fireEvent.click(document.body.querySelector('[role="listbox"] button:last-child')!);
    fireEvent.change(getByLabelText("Custom wait minutes"), { target: { value: "20" } });

    fireEvent.click(getByText(defaultWorkbenchLocale.labels.privacySecuritySettings));
    fireEvent.click(getByLabelText("Agent memory scope"));
    fireEvent.click(getByText("Global + workspace"));
    fireEvent.click(getByLabelText("Agent memory semantic recall"));
    fireEvent.click(getByText("OpenAI compatible"));
    fireEvent.change(getByLabelText("Model"), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(getByLabelText("Key reference"), { target: { value: "model.openai" } });

    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      appearanceTheme: "dark",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      defaultStartupMode: "project",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      taskQueuePolicy: "interrupt",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      contextStrategy: "long",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMaxRoundsPreset: "custom",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMaxRoundsCustom: 10,
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      taskTimeoutPreset: "long",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      failureRecoveryPolicy: "stop",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      userWaitTimeoutPreset: "custom",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      userWaitTimeoutCustomMs: 20 * 60_000,
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMemoryScope: "global_workspace",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMemoryEmbeddingMode: "openai_compatible",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMemoryEmbeddingModel: "text-embedding-3-large",
    }));
    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMemoryEmbeddingApiKeyReference: "model.openai",
    }));
  });

  it("can source agent memory embedding settings from configured OpenAI-compatible profiles", () => {
    const onRuntimePreferencesChange = vi.fn();
    const runtimePreferences: WorkbenchRuntimePreferences = {
      appearanceTheme: "light",
      defaultStartupMode: "chat",
      contextStrategy: "auto",
      agentMaxRoundsPreset: "8",
      agentMaxRoundsCustom: 8,
      taskTimeoutPreset: "standard",
      taskTimeoutCustomMs: 90_000,
      agentMemoryScope: "workspace",
      agentMemoryEmbeddingMode: "openai_compatible",
      agentMemoryEmbeddingProvider: "openai",
      agentMemoryEmbeddingModel: "text-embedding-3-small",
      agentMemoryEmbeddingBaseUrl: "https://api.openai.com/v1",
      agentMemoryEmbeddingApiKeyReference: "model.embedding",
      agentMemoryEmbeddingDimensions: 1536,
      taskQueuePolicy: "queue",
      failureRecoveryPolicy: "replan",
      userWaitTimeoutPreset: "standard",
      userWaitTimeoutCustomMs: 5 * 60_000,
    };
    const { container, getByLabelText, getByText } = render(
      <ModelSettings
        labels={defaultWorkbenchLocale.labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "embedding-profile",
              slot: null,
              displayName: "Embedding",
              provider: "openrouter",
              model: "text-embedding-model",
              apiKeyReference: "model.openrouter",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "",
              capabilities: { vision: false, code: false, longContext: false },
            },
          ],
          agentOverrides: {},
        }}
        runtimePreferences={runtimePreferences}
        onRuntimePreferencesChange={onRuntimePreferencesChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(defaultWorkbenchLocale.labels.privacySecuritySettings));
    fireEvent.click(getByLabelText("Agent memory embedding configured source"));
    fireEvent.click(getByText("OpenRouter / text-embedding-model (model.openrouter)"));

    expect(onRuntimePreferencesChange).toHaveBeenCalledWith(expect.objectContaining({
      agentMemoryEmbeddingProvider: "openrouter",
      agentMemoryEmbeddingModel: "text-embedding-model",
      agentMemoryEmbeddingBaseUrl: "https://openrouter.ai/api/v1",
      agentMemoryEmbeddingApiKeyReference: "model.openrouter",
    }));
  });

  it("runs the API connection test from the AI settings page", async () => {
    const onTestModelConnection = vi.fn().mockResolvedValue("API 连通正常");
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onTestModelConnection={onTestModelConnection}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-ai-test-button")!);

    await waitFor(() => expect(onTestModelConnection).toHaveBeenCalledOnce());
    expect(document.body.querySelector(".javis-ai-test-status")?.textContent).toContain("API 连通正常");
  });

  it("tests provider connections with the configured profile key reference", async () => {
    const onTestModelConnection = vi.fn().mockResolvedValue("API 连通正常");
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "deepseek", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "deepseek",
              model: "deepseek-chat",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.deepseek.com",
              apiKey: "",
              hasStoredApiKey: true,
              capabilities: { vision: false, code: true, longContext: false },
            },
          ],
          agentOverrides: {},
        }}
        onTestModelConnection={onTestModelConnection}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-ai-test-button")!);

    await waitFor(() => expect(onTestModelConnection).toHaveBeenCalledOnce());
    expect(onTestModelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-chat",
        apiKeyReference: "model.primary",
        baseUrl: "https://api.deepseek.com",
      }),
    );
  });

  it("assigns configured provider models to model slots with dropdowns", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "gpt-4.1", apiKey: "", apiKeyReference: "default", baseUrl: "https://api.openai.com/v1" }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    const modelSlotTriggers = document.body.querySelectorAll(".javis-ai-model-select-trigger");
    fireEvent.click(modelSlotTriggers[0]); // primary is first slot
    fireEvent.click(document.body.querySelectorAll(".javis-ai-model-select-menu button")[1]);
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    expect(onModelConfigurationChange).toHaveBeenCalledOnce();
    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "openai",
      model: "gpt-4.1",
      apiKeyReference: "default",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("clears a model slot when the dropdown is set to unassigned", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        modelConfiguration={{
          profiles: [
            {
              id: "openai-gpt-4-1",
              slot: null,
              displayName: "gpt-4.1",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.openai-gpt-4-1",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "openai",
              model: "gpt-4.1",
              apiKeyReference: "model.primary",
              baseUrl: "https://api.openai.com/v1",
              apiKey: "",
              capabilities: { vision: false, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    const modelSlotTriggers = document.body.querySelectorAll(".javis-ai-model-select-trigger");
    fireEvent.click(modelSlotTriggers[0]); // primary is first slot
    fireEvent.click(document.body.querySelector(".javis-ai-model-select-menu button")!);
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "",
      model: "",
      apiKeyReference: "model.primary",
      baseUrl: "",
    });
  });

  it("normalizes slot connection settings from the provider model before saving", () => {
    const onModelConfigurationChange = vi.fn();
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{
          provider: "mimo",
          model: "mimo-v2.5-pro",
          apiKey: "",
          apiKeyReference: "default",
          baseUrl: "https://api.deepseek.com",
        }}
        modelConfiguration={{
          profiles: [
            {
              id: "mimo-mimo-v2-5-pro",
              slot: null,
              displayName: "mimo-v2.5-pro",
              provider: "mimo",
              model: "mimo-v2.5-pro",
              apiKeyReference: "model.mimo",
              baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
              apiKey: "",
              capabilities: { vision: true, code: true, longContext: true },
            },
            {
              id: "primary",
              slot: "primary",
              displayName: "Primary",
              provider: "mimo",
              model: "mimo-v2.5-pro",
              apiKeyReference: "default",
              baseUrl: "https://api.deepseek.com",
              apiKey: "",
              capabilities: { vision: true, code: true, longContext: true },
            },
          ],
          agentOverrides: {},
        }}
        onModelConfigurationChange={onModelConfigurationChange}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles.find((profile: { slot: string }) => profile.slot === "primary")).toMatchObject({
      provider: "mimo",
      model: "mimo-v2.5-pro",
      apiKeyReference: "model.mimo",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      contextTokens: 1048576,
    });
  });

  it("adds provider models to the saved configuration", async () => {
    const onModelConfigurationChange = vi.fn();
    const onFetchProviderModels = vi.fn(async () => ["deepseek-v4-pro", "deepseek-v4-turbo"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "", apiKeyReference: "default", baseUrl: "https://api.deepseek.com" }}
        onModelConfigurationChange={onModelConfigurationChange}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("获取模型"));
    await vi.waitFor(() => {
      const menu = document.body.querySelector(".javis-ai-provider-model-menu");
      expect(menu).toBeTruthy();
    });
    const deepseekProOption = [...document.body.querySelectorAll(".javis-ai-provider-model-menu button")]
      .find((button) => button.textContent?.includes("deepseek-v4-pro")) as HTMLButtonElement;
    fireEvent.click(deepseekProOption);
    const markedDeepseekProOption = [...document.body.querySelectorAll(".javis-ai-provider-model-menu button")]
      .find((button) => button.textContent?.includes("deepseek-v4-pro")) as HTMLButtonElement;
    expect(markedDeepseekProOption.className).toContain("active");
    fireEvent.click(document.body.querySelector(".javis-settings-save-btn")!);

    const savedConfig = onModelConfigurationChange.mock.calls[0][0];
    expect(savedConfig.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: null,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
          contextTokens: 1000000,
        }),
      ]),
    );
  });

  it("fetches models with the selected provider default Base URL", async () => {
    const onFetchProviderModels = vi.fn(async () => ["openai/gpt-oss-120b"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("OpenRouter"));
    fireEvent.click(getByText("获取模型"));

    await vi.waitFor(() => expect(onFetchProviderModels).toHaveBeenCalledOnce());
    expect(onFetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiType: "openai-compatible",
        keyReference: "model.openrouter",
        modelListMode: "openai",
      }),
    );
  });

  it("does not call the provider API for providers without a supported model list endpoint", async () => {
    const onFetchProviderModels = vi.fn(async () => ["gemini-2.5-pro"]);
    const { container, getByText } = render(
      <ModelSettings
        labels={labels}
        modelSettings={{ provider: "openai", model: "", apiKey: "", apiKeyReference: "default", baseUrl: "" }}
        onFetchProviderModels={onFetchProviderModels}
      />,
    );

    fireEvent.click(container.querySelector(".javis-settings-trigger")!);
    fireEvent.click(getByText(labels.aiModeSettings));
    fireEvent.click(getByText("Google Gemini"));
    fireEvent.click(getByText("获取模型"));

    expect(onFetchProviderModels).not.toHaveBeenCalled();
    expect(document.body.querySelector(".javis-ai-model-fetch-message")?.textContent).toContain("模型 ID");
  });
});
