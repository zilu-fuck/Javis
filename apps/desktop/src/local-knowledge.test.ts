import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import {
  scanAllUserFiles,
  cancelScanAllFiles,
  listMountRoots,
  classifyApps,
  classifyDocuments,
} from "./local-knowledge";
import type { ModelProvider } from "./model-provider";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("local knowledge bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  describe("scanAllUserFiles", () => {
    function setupListenMock() {
      const handlers: Record<string, ((event: Event<unknown>) => void)[]> = {};
      listenMock.mockImplementation((eventName: string, cb: (event: Event<unknown>) => void) => {
        (handlers[eventName] ??= []).push(cb);
        return Promise.resolve(() => {});
      });
      return handlers;
    }

    it("invokes scan_all_user_files with extensions and maxResults", async () => {
      const handlers = setupListenMock();
      invokeMock.mockResolvedValueOnce("scan-1");

      const promise = scanAllUserFiles([".txt", ".pdf"], 200);
      await new Promise((r) => setTimeout(r, 10));

      expect(invokeMock).toHaveBeenCalledWith("scan_all_user_files", {
        extensions: [".txt", ".pdf"],
        maxResults: 200,
        scanId: expect.any(String),
      });
      const scanId = (invokeMock.mock.calls[0]?.[1] as { scanId: string }).scanId;

      // Simulate scan completion event
      for (const cb of handlers["scan-all-files-done"] ?? []) {
        cb({ event: "scan-all-files-done", id: 1, payload: { scanId, entries: [] } });
      }
      await expect(promise).resolves.toEqual([]);
    });

    it("passes null for omitted optional parameters", async () => {
      const handlers = setupListenMock();
      invokeMock.mockResolvedValueOnce("scan-2");

      const promise = scanAllUserFiles();
      await new Promise((r) => setTimeout(r, 10));

      expect(invokeMock).toHaveBeenCalledWith("scan_all_user_files", {
        extensions: null,
        maxResults: null,
        scanId: expect.any(String),
      });
      const scanId = (invokeMock.mock.calls[0]?.[1] as { scanId: string }).scanId;

      for (const cb of handlers["scan-all-files-done"] ?? []) {
        cb({ event: "scan-all-files-done", id: 1, payload: { scanId, entries: [] } });
      }
      await expect(promise).resolves.toEqual([]);
    });

    it("rejects when scan-all-files-error fires", async () => {
      const handlers = setupListenMock();
      invokeMock.mockResolvedValueOnce("scan-3");

      const promise = scanAllUserFiles();
      await new Promise((r) => setTimeout(r, 10));
      const scanId = (invokeMock.mock.calls[0]?.[1] as { scanId: string }).scanId;

      for (const cb of handlers["scan-all-files-error"] ?? []) {
        cb({ event: "scan-all-files-error", id: 1, payload: { scanId, error: "disk full" } });
      }
      await expect(promise).rejects.toThrow("disk full");
    });
  });

  describe("cancelScanAllFiles", () => {
    it("invokes cancel_scan_all_files with scanId", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await cancelScanAllFiles("scan-5");
      expect(invokeMock).toHaveBeenCalledWith("cancel_scan_all_files", {
        scanId: "scan-5",
      });
    });
  });

  describe("listMountRoots", () => {
    it("invokes list_mount_roots and returns roots", async () => {
      const roots = [{ name: "C:", path: "C:\\" }];
      invokeMock.mockResolvedValueOnce(roots);
      const result = await listMountRoots();
      expect(result).toEqual(roots);
      expect(invokeMock).toHaveBeenCalledWith("list_mount_roots");
    });
  });

  describe("classifyDocuments", () => {
    function mockProvider(responses: string[]): ModelProvider {
      let i = 0;
      return {
        id: "test",
        settings: { provider: "t", model: "m", apiKeyReference: "d", baseUrl: "" },
        defaultSettingsForLocale: () => ({
          provider: "t", model: "m", apiKey: "", apiKeyReference: "d", baseUrl: "",
        }),
        async complete() {
          return { text: responses[i++] ?? "[]", model: "m", provider: "t" };
        },
        async *stream() { yield { text: "" }; },
      };
    }

    it("classifies files with onBatchProgress including failed count", async () => {
      const p = mockProvider([
        JSON.stringify([
          { name: "a.txt", category: "tech", tags: ["x"], confidence: 0.9 },
        ]),
      ]);
      const cb = vi.fn();
      const r = await classifyDocuments(
        [{ name: "a.txt", path: "/a.txt" }], p, { onBatchProgress: cb },
      );
      expect(r).toHaveLength(1);
      expect(cb).toHaveBeenCalledWith(1, 1, 0);
    });

    it("works without options", async () => {
      const p = mockProvider([
        JSON.stringify([{ name: "a.txt", category: "x", tags: [], confidence: 0.5 }]),
      ]);
      const r = await classifyDocuments([{ name: "a.txt", path: "/a.txt" }], p);
      expect(r).toHaveLength(1);
    });

    it("uses document fallback categories when document classification response cannot be parsed", async () => {
      const p = mockProvider(["not json"]);
      const r = await classifyDocuments([
        { name: "附件1：生源地助学贷款学生在线系统和国家助学贷款APP毕业确认操作流程.docx", path: "/docs/loan-flow.docx", extension: "docx" },
        { name: "javis-release-conflict.pdf", path: "/docs/javis-release-conflict.pdf", extension: "pdf" },
        { name: "AdminRegionConfig.txt", path: "/docs/AdminRegionConfig.txt", extension: "txt" },
      ], p);

      expect(r.map((item) => [item.name, item.category])).toEqual([
        ["附件1：生源地助学贷款学生在线系统和国家助学贷款APP毕业确认操作流程.docx", "行政"],
        ["javis-release-conflict.pdf", "技术文档"],
        ["AdminRegionConfig.txt", "技术文档"],
      ]);
    });

    it("upgrades model Other document results with local filename rules", async () => {
      const p = mockProvider([
        JSON.stringify([
          { name: "2026中国大学生计算机设计大赛评审结果公示.pdf", path: "/docs/contest.pdf", category: "其他", tags: [], confidence: 0.2 },
        ]),
      ]);
      const r = await classifyDocuments([
        { name: "2026中国大学生计算机设计大赛评审结果公示.pdf", path: "/docs/contest.pdf", extension: "pdf" },
      ], p);

      expect(r[0]?.category).toBe("研究");
      expect(r[0]?.tags).toEqual(["研究"]);
    });

    it("matches classification results by path when filenames collide", async () => {
      const p = mockProvider([
        JSON.stringify([
          { name: "same.txt", path: "/b/same.txt", category: "b", tags: [], confidence: 0.8 },
          { name: "same.txt", path: "/a/same.txt", category: "a", tags: [], confidence: 0.9 },
        ]),
      ]);
      const r = await classifyDocuments([
        { name: "same.txt", path: "/a/same.txt" },
        { name: "same.txt", path: "/b/same.txt" },
      ], p);
      expect(r.map((item) => [item.path, item.category])).toEqual([
        ["/b/same.txt", "b"],
        ["/a/same.txt", "a"],
      ]);
    });

    it("uses app-specific fallback categories when app classification response cannot be parsed", async () => {
      const p = mockProvider(["not json"]);
      const r = await classifyApps([
        { name: "UC浏览器", path: "C:/Apps/UCBrowser.exe" },
        { name: "Trae CN", path: "C:/Apps/Trae.exe" },
        { name: "Uninstall Redis Desktop Manager", path: "C:/Apps/uninstall-rdm.exe" },
      ], p);

      expect(r.map((item) => [item.name, item.category])).toEqual([
        ["UC浏览器", "浏览器"],
        ["Trae CN", "开发工具"],
        ["Uninstall Redis Desktop Manager", "开发工具"],
      ]);
    });
  });
});
