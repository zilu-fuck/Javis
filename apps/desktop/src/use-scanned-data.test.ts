// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useScannedData } from "./use-scanned-data";

const {
  mockListMountRoots,
  mockScanInstalledApps,
  mockScanAllUserFiles,
  mockListDirectory,
  mockScanResourceFiles,
  mockGetUserHome,
} = vi.hoisted(() => ({
  mockListMountRoots: vi.fn(),
  mockScanInstalledApps: vi.fn(),
  mockScanAllUserFiles: vi.fn(),
  mockListDirectory: vi.fn(),
  mockScanResourceFiles: vi.fn(),
  mockGetUserHome: vi.fn(),
}));

vi.mock("./local-knowledge", () => ({
  listMountRoots: mockListMountRoots,
  scanInstalledApps: mockScanInstalledApps,
  scanAllUserFiles: mockScanAllUserFiles,
  listDirectory: mockListDirectory,
  scanResourceFiles: mockScanResourceFiles,
  getUserHome: mockGetUserHome,
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

const DEFAULT_TEST_ROOTS = [
  {
    id: "default-desktop",
    path: "C:\\Users\\Test\\Desktop",
    label: "桌面",
    kinds: ["documents", "images"],
    enabled: true,
    source: "default",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "default-documents",
    path: "C:\\Users\\Test\\Documents",
    label: "文档",
    kinds: ["documents"],
    enabled: true,
    source: "default",
    created_at: "2025-01-01T00:00:00Z",
  },
];

function createScanRootRepo(roots: Array<Record<string, unknown>> = DEFAULT_TEST_ROOTS) {
  return {
    getAll: vi.fn().mockResolvedValue(roots),
    getByKind: vi.fn().mockResolvedValue(roots.filter((r) => (r.kinds as string[]).includes("documents"))),
    upsert: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn().mockResolvedValue(undefined),
  };
}

function createResourceCacheRepo() {
  return {
    replaceForRoot: vi.fn().mockResolvedValue(undefined),
    deleteForRoot: vi.fn().mockResolvedValue(undefined),
    deleteForKind: vi.fn().mockResolvedValue(undefined),
    getByKind: vi.fn().mockResolvedValue([]),
    clearAll: vi.fn().mockResolvedValue(undefined),
  };
}

function createResourceEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "doc.pdf",
    path: "C:\\Users\\Test\\Desktop\\doc.pdf",
    isDir: false,
    sizeBytes: 2048,
    modifiedAt: "2025-01-01T00:00:00Z",
    extension: "pdf",
    source: "default",
    sourceRootId: "default-desktop",
    sourceRootPath: "C:\\Users\\Test\\Desktop",
    ...overrides,
  };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  const scanRootRepo = createScanRootRepo();
  const cacheRepo = createResourceCacheRepo();
  return {
    activeView: "documents",
    runtime: {} as any,
    fileClassificationRepoRef: { current: createFileClassificationRepo() } as any,
    resourceScanRootRepoRef: { current: scanRootRepo } as any,
    resourceCacheRepoRef: { current: cacheRepo } as any,
    ...overrides,
  };
}

describe("useScannedData", () => {
  beforeEach(() => {
    mockListMountRoots.mockReset();
    mockScanInstalledApps.mockReset();
    mockScanAllUserFiles.mockReset();
    mockListDirectory.mockReset();
    mockScanResourceFiles.mockReset();
    mockGetUserHome.mockReset();

    mockListMountRoots.mockResolvedValue([{ name: "C:", path: "C:\\" }]);
    mockScanInstalledApps.mockResolvedValue([]);
    mockScanAllUserFiles.mockResolvedValue([]);
    mockListDirectory.mockResolvedValue([]);
    mockScanResourceFiles.mockResolvedValue([]);
    mockGetUserHome.mockResolvedValue("C:\\Users\\Test");
  });

  it("calls listMountRoots on mount", async () => {
    renderHook(() => useScannedData(makeOptions()));
    await waitFor(() => {
      expect(mockListMountRoots).toHaveBeenCalledOnce();
    });
  });

  it("populates mountRoots from listMountRoots response", async () => {
    mockListMountRoots.mockResolvedValue([
      { name: "C:", path: "C:\\" },
      { name: "D:", path: "D:\\" },
    ]);
    const { result } = renderHook(() => useScannedData(makeOptions()));
    await waitFor(() => {
      expect(result.current.mountRoots).toEqual([
        { name: "C:", path: "C:\\" },
        { name: "D:", path: "D:\\" },
      ]);
    });
  });

  it("dispatches document scan via scanResourceFiles when activeView is documents", async () => {
    renderHook(() => useScannedData(makeOptions({ activeView: "documents" })));
    await waitFor(() => {
      expect(mockScanResourceFiles).toHaveBeenCalledWith(
        "documents",
        expect.any(Array),
        expect.any(Array),
        100,
        expect.any(Function),
      );
    }, { timeout: 3000 });
  });

  it("keeps document scanning asynchronous with a visible loading state", async () => {
    let resolveScan!: (entries: ReturnType<typeof createResourceEntry>[]) => void;
    mockScanResourceFiles.mockReturnValue(new Promise((resolve) => {
      resolveScan = resolve;
    }));

    const { result } = renderHook(() =>
      useScannedData(makeOptions({ activeView: "documents" })),
    );

    await waitFor(() => {
      expect(result.current.docsLoading).toBe(true);
    }, { timeout: 3000 });
    expect(result.current.userDocuments).toEqual([]);

    resolveScan([createResourceEntry({ name: "async-report.pdf" })]);

    await waitFor(() => {
      expect(result.current.docsLoading).toBe(false);
      expect(result.current.userDocuments[0]?.name).toBe("async-report.pdf");
    }, { timeout: 3000 });
  });

  it("dispatches image scan via scanResourceFiles when activeView is gallery", async () => {
    renderHook(() => useScannedData(makeOptions({ activeView: "gallery" })));
    await waitFor(() => {
      expect(mockScanResourceFiles).toHaveBeenCalledWith(
        "images",
        expect.any(Array),
        expect.any(Array),
        100,
        expect.any(Function),
      );
    }, { timeout: 3000 });
  });

  it("populates userDocuments from scanResourceFiles result", async () => {
    mockScanResourceFiles.mockResolvedValue([
      createResourceEntry({ name: "report.pdf" }),
    ]);
    const { result } = renderHook(() =>
      useScannedData(makeOptions({ activeView: "documents" })),
    );
    await waitFor(() => {
      expect(result.current.userDocuments).toHaveLength(1);
    }, { timeout: 3000 });
    expect(result.current.userDocuments[0].name).toBe("report.pdf");
    expect(result.current.docsLoading).toBe(false);
  });

  it("populates userImages from scanResourceFiles result", async () => {
    mockScanResourceFiles.mockResolvedValue([
      createResourceEntry({ name: "photo.jpg", extension: "jpg" }),
    ]);
    const { result } = renderHook(() =>
      useScannedData(makeOptions({ activeView: "gallery" })),
    );
    await waitFor(() => {
      expect(result.current.userImages).toHaveLength(1);
    }, { timeout: 3000 });
    expect(result.current.userImages[0].name).toBe("photo.jpg");
    expect(result.current.imagesLoading).toBe(false);
  });

  it("sets docsError on scanResourceFiles failure", async () => {
    mockScanResourceFiles.mockRejectedValue(new Error("scan failed"));
    const { result } = renderHook(() =>
      useScannedData(makeOptions({ activeView: "documents" })),
    );
    await waitFor(() => {
      expect(result.current.docsError).toBeDefined();
    }, { timeout: 3000 });
    expect(result.current.docsLoading).toBe(false);
  });

  it("dispatches apps scan when activeView is apps", async () => {
    mockScanInstalledApps.mockResolvedValue([]);
    renderHook(() => useScannedData(makeOptions({ activeView: "apps" })));
    await waitFor(() => {
      expect(mockScanInstalledApps).toHaveBeenCalledOnce();
    });
  });

  it("provides resourceScanRoots from repo", async () => {
    const { result } = renderHook(() => useScannedData(makeOptions()));
    await waitFor(() => {
      expect(result.current.resourceScanRoots.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it("generates default resource roots after home directory resolves when repo is empty", async () => {
    const emptyScanRootRepo = createScanRootRepo([]);
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        resourceScanRootRepoRef: { current: emptyScanRootRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.resourceScanRoots.some((root) =>
        root.path === "C:\\Users\\Test\\Documents",
      )).toBe(true);
    }, { timeout: 3000 });
  });
});
