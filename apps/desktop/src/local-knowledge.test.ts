import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import {
  scanAllUserFiles,
  cancelScanAllFiles,
  listMountRoots,
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
  });
});
