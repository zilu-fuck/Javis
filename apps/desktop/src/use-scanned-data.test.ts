// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useScannedData } from "./use-scanned-data";

const {
  mockListMountRoots,
  mockScanInstalledApps,
  mockScanUserDocuments,
  mockScanUserImages,
  mockScanAllUserFiles,
  mockListDirectory,
} = vi.hoisted(() => ({
  mockListMountRoots: vi.fn(),
  mockScanInstalledApps: vi.fn(),
  mockScanUserDocuments: vi.fn(),
  mockScanUserImages: vi.fn(),
  mockScanAllUserFiles: vi.fn(),
  mockListDirectory: vi.fn(),
}));

vi.mock("./local-knowledge", () => ({
  listMountRoots: mockListMountRoots,
  scanInstalledApps: mockScanInstalledApps,
  scanUserDocuments: mockScanUserDocuments,
  scanUserImages: mockScanUserImages,
  scanAllUserFiles: mockScanAllUserFiles,
  listDirectory: mockListDirectory,
}));

function createFileClassificationRepo() {
  return {
    replaceScanCache: vi.fn().mockResolvedValue(undefined),
    getScanCache: vi.fn().mockResolvedValue([]),
    getUnclassifiedFiles: vi.fn().mockResolvedValue([]),
    clearScanCache: vi.fn().mockResolvedValue(undefined),
    upsertClassificationsBatch: vi.fn().mockResolvedValue(undefined),
    getCategoryStats: vi.fn().mockResolvedValue([]),
    cleanupOrphanClassifications: vi.fn().mockResolvedValue(undefined),
  };
}

function createFileEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "file.txt",
    path: "/home/file.txt",
    isDir: false,
    sizeBytes: 1024,
    modifiedAt: "2025-01-01T00:00:00Z",
    extension: "txt",
    ...overrides,
  };
}

describe("useScannedData", () => {
  beforeEach(() => {
    mockListMountRoots.mockReset();
    mockScanInstalledApps.mockReset();
    mockScanUserDocuments.mockReset();
    mockScanUserImages.mockReset();
    mockScanAllUserFiles.mockReset();
    mockListDirectory.mockReset();

    mockListMountRoots.mockResolvedValue([{ name: "C:", path: "C:\\" }]);
    mockScanInstalledApps.mockResolvedValue([]);
    mockScanUserDocuments.mockResolvedValue([]);
    mockScanUserImages.mockResolvedValue([]);
    mockScanAllUserFiles.mockResolvedValue([]);
    mockListDirectory.mockResolvedValue([]);
  });

  // ── Initialization ───────────────────────────────────────────────────────

  it("calls listMountRoots on mount", async () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(mockListMountRoots).toHaveBeenCalledOnce();
    });
  });

  it("populates mountRoots from listMountRoots response", async () => {
    mockListMountRoots.mockResolvedValue([
      { name: "C:", path: "C:\\" },
      { name: "D:", path: "D:\\" },
    ]);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(result.current.mountRoots).toEqual([
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
      ]);
    });
  });

  // ── Scan Dispatching ─────────────────────────────────────────────────────

  it("dispatches document scan when activeView is documents", async () => {
    mockScanUserDocuments.mockResolvedValue([createFileEntry()]);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(mockScanUserDocuments).toHaveBeenCalledOnce();
    });
  });

  it("dispatches image scan when activeView is gallery", async () => {
    mockScanUserImages.mockResolvedValue([createFileEntry({ name: "photo.jpg" })]);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    renderHook(() =>
      useScannedData({ activeView: "gallery", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(mockScanUserImages).toHaveBeenCalledOnce();
    });
  });

  // ── Refresh callbacks ────────────────────────────────────────────────────

  it("handleRefreshApps resets appsLoading and appsError", () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "apps", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    act(() => {
      result.current.handleRefreshApps();
    });

    expect(result.current.appsError).toBeUndefined();
  });

  it("handleRefreshDocuments resets docsLoading and docsError", () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    act(() => {
      result.current.handleRefreshDocuments();
    });

    expect(result.current.docsError).toBeUndefined();
  });

  it("handleRefreshImages resets imagesLoading and imagesError", () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "gallery", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    act(() => {
      result.current.handleRefreshImages();
    });

    expect(result.current.imagesError).toBeUndefined();
  });

  // ── Directory navigation ─────────────────────────────────────────────────

  it("handleNavigateDirectory loads directory contents", async () => {
    mockListDirectory.mockResolvedValue([
      createFileEntry({ name: "readme.md", path: "/projects/readme.md" }),
    ]);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "computer", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    act(() => {
      result.current.handleNavigateDirectory("/projects");
    });

    await waitFor(() => {
      expect(mockListDirectory).toHaveBeenCalledWith("/projects");
    });
  });

  it("handleListDirectory returns workbench entries", async () => {
    mockListDirectory.mockResolvedValue([createFileEntry()]);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "computer", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    const entries = await act(async () => result.current.handleListDirectory("/data"));
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("file.txt");
  });

  // ── Classification ───────────────────────────────────────────────────────

  it("handleClassifyDocuments skips when no unclassified files", async () => {
    const repo = createFileClassificationRepo();
    repo.getUnclassifiedFiles.mockResolvedValue([]);
    const repoRef = { current: repo } as any;
    const runtime = { classifyWithFileAgent: vi.fn().mockResolvedValue([]), subscribe: vi.fn(), dispose: vi.fn() };

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: runtime as any, fileClassificationRepoRef: repoRef }),
    );

    await act(async () => {
      await result.current.handleClassifyDocuments();
    });

    expect(runtime.classifyWithFileAgent).not.toHaveBeenCalled();
  });

  it("handleCancelClassify does not throw when no classification is active", () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    expect(() => {
      act(() => {
        result.current.handleCancelClassify();
      });
    }).not.toThrow();
  });

  // ── Initial state ───────────────────────────────────────────────────────

  it("initial scanning and classifying states are false", () => {
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    expect(result.current.scanning).toBe(false);
    expect(result.current.classifying).toBe(false);
    expect(result.current.scanProgress).toBeUndefined();
    expect(result.current.classifyProgress).toBeUndefined();
  });
});
