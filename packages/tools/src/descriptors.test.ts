import { describe, expect, it } from "vitest";
import { initialToolDescriptors } from "./descriptors";
import { validateToolSchema } from "./tool-schema-validation";

describe("tool descriptors", () => {
  it("treats native path launching as approval-gated", () => {
    const descriptor = initialToolDescriptors.find((tool) => tool.name === "computer.openPath");

    expect(descriptor?.permissionLevel).toBe("confirmed_write");
    expect(descriptor?.writeRiskLevel).toBe("risky");
  });

  it("declares a generic Page Agent fallback for structured trend failures", () => {
    const descriptor = initialToolDescriptors.find((tool) => tool.name === "trend.fetchHotList");

    expect(descriptor?.summary).toContain("unsupported site");
    expect(descriptor?.summary).toContain("Page Agent");
    expect(descriptor?.metadata).toMatchObject({
      failureFallbackAgentKind: "page-agent",
      failureFallbackCapability: "browser_navigate",
    });
    expect(descriptor?.summary).not.toMatch(/bilibili|B站|哔哩/iu);
  });

  it("defines complete governed contracts for the first registry tools", () => {
    const governedNames = [
      "computer.listDirectory",
      "file.scanMarkdownDocuments",
      "code.inspectRepository",
      "code.searchRepository",
      "code.traceCallChain",
    ];

    for (const name of governedNames) {
      const descriptor = initialToolDescriptors.find((tool) => tool.name === name);
      expect(descriptor?.inputSchema?.type, name).toBe("object");
      expect(descriptor?.inputSchema?.additionalProperties, name).toBe(false);
      expect(descriptor?.outputSchema, name).toBeDefined();
      expect(descriptor?.limits, name).toEqual({
        timeoutMs: 90_000,
        maxInputBytes: 16_384,
        maxOutputBytes: 262_144,
      });
    }
  });

  it("rejects unknown and out-of-range repository search input", () => {
    const descriptor = initialToolDescriptors.find(
      (tool) => tool.name === "code.searchRepository",
    );
    expect(descriptor?.inputSchema).toBeDefined();
    if (!descriptor?.inputSchema) return;

    expect(validateToolSchema(descriptor.inputSchema, {
      goal: "find tool registry",
      secret: "undeclared",
    })).toContain("undeclared field: secret");
    expect(validateToolSchema(descriptor.inputSchema, {
      goal: "find tool registry",
      maxAttempts: 0,
    })).toContain("greater than or equal to 1");
  });

  it("keeps optional repository search output fields optional", () => {
    const descriptor = initialToolDescriptors.find(
      (tool) => tool.name === "code.searchRepository",
    );
    expect(descriptor?.outputSchema).toBeDefined();
    if (!descriptor?.outputSchema) return;

    expect(validateToolSchema(descriptor.outputSchema, {
      actualFound: [],
      inferred: [],
      needsConfirmation: [],
      keyFiles: [],
      relatedTestFiles: [],
      testFileCandidates: [],
      clusters: [],
      attempts: [],
    })).toBeUndefined();
  });

  it("validates nested call-chain output fields", () => {
    const descriptor = initialToolDescriptors.find(
      (tool) => tool.name === "code.traceCallChain",
    );
    expect(descriptor?.outputSchema).toBeDefined();
    if (!descriptor?.outputSchema) return;
    const output = {
      target: "dispatchToolByName",
      direction: "backward",
      actualFound: [],
      nodes: [],
      edges: [],
      moduleLinks: [{
        specifier: "@javis/tools",
        kind: "workspace",
        evidencePaths: ["packages/core/src/workflow-executor.ts"],
        importCount: 1,
        exportCount: 0,
        dynamicImportCount: 0,
        confidence: 1,
      }],
      symbolGraph: { nodes: [], edges: [] },
      inferred: [],
      needsConfirmation: [],
      keyFiles: [],
      attempts: [],
    };

    expect(validateToolSchema(descriptor.outputSchema, output)).toBeUndefined();
    expect(validateToolSchema(descriptor.outputSchema, {
      ...output,
      moduleLinks: [{ ...output.moduleLinks[0], unknown: true }],
    })).toContain("undeclared field: unknown");
  });
});
