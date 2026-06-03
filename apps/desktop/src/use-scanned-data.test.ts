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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it("dispatches document scan with progress when activeView is documents", async () => {
    mockScanAllUserFiles.mockImplementation(async (_extensions, _maxResults, onProgress) => {
      onProgress?.({ scanId: "docs", current: 1, total: 2 });
      return [createFileEntry()];
    });
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(mockScanAllUserFiles).toHaveBeenCalledWith(
        expect.arrayContaining(["pdf", "docx"]),
        200,
        expect.any(Function),
      );
    });
  });

  it("keeps document scan results after the loading rerender", async () => {
    const deferred = createDeferred<ReturnType<typeof createFileEntry>[]>();
    mockScanAllUserFiles.mockReturnValue(deferred.promise);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "documents", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(result.current.docsLoading).toBe(true);
    });

    await act(async () => {
      deferred.resolve([createFileEntry({ name: "notes.pdf", extension: "pdf" })]);
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.docsLoading).toBe(false);
      expect(result.current.userDocuments).toHaveLength(1);
    });
  });

  it("keeps app scan results after the loading rerender", async () => {
    const deferred = createDeferred<{ name: string; path: string }[]>();
    mockScanInstalledApps.mockReturnValue(deferred.promise);
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    const { result } = renderHook(() =>
      useScannedData({ activeView: "apps", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(result.current.appsLoading).toBe(true);
    });

    await act(async () => {
      deferred.resolve([{ name: "Calculator", path: "C:\\Calculator.lnk" }]);
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.appsLoading).toBe(false);
      expect(result.current.installedApps).toHaveLength(1);
    });
  });

  it("dispatches image scan with progress when activeView is gallery", async () => {
    mockScanAllUserFiles.mockImplementation(async (_extensions, _maxResults, onProgress) => {
      onProgress?.({ scanId: "images", current: 1, total: 2 });
      return [createFileEntry({ name: "photo.jpg" })];
    });
    const repo = createFileClassificationRepo();
    const repoRef = { current: repo } as any;

    renderHook(() =>
      useScannedData({ activeView: "gallery", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    await waitFor(() => {
      expect(mockScanAllUserFiles).toHaveBeenCalledWith(
        expect.arrayContaining(["jpg", "png"]),
        200,
        expect.any(Function),
      );
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
      useScannedData({ activeView: "chat", runtime: {} as any, fileClassificationRepoRef: repoRef }),
    );

    const entries = await result.current.handleListDirectory("/data");
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
      useScannedData({ activeView: "chat", runtime: runtime as any, fileClassificationRepoRef: repoRef }),
    );

    await result.current.handleClassifyDocuments();

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
