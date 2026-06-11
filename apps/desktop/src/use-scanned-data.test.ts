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

function createAppClassificationRepo(records: Array<Record<string, unknown>> = []) {
  return {
    getAll: vi.fn().mockResolvedValue(records),
    upsertClassifications: vi.fn().mockResolvedValue(undefined),
    getCategoryStats: vi.fn().mockResolvedValue([]),
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
    createdAt: "2025-01-01T00:00:00Z",
  },
  {
    id: "default-documents",
    path: "C:\\Users\\Test\\Documents",
    label: "文档",
    kinds: ["documents"],
    enabled: true,
    source: "default",
    createdAt: "2025-01-01T00:00:00Z",
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
    appClassificationRepoRef: { current: createAppClassificationRepo() } as any,
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

  it("persists generated default resource roots", async () => {
    const emptyScanRootRepo = createScanRootRepo([]);
    renderHook(() =>
      useScannedData(makeOptions({
        resourceScanRootRepoRef: { current: emptyScanRootRepo },
      })),
    );

    await waitFor(() => {
      expect(emptyScanRootRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "default-documents", source: "default" }),
      );
    }, { timeout: 3000 });
  });

  it("merges default resource roots when the repository already has custom roots", async () => {
    const scanRootRepo = createScanRootRepo([
      {
        id: "custom-projects",
        path: "C:\\Users\\Test\\Projects",
        label: "Projects",
        kinds: ["documents"],
        enabled: true,
        source: "custom",
        createdAt: "2025-01-02T00:00:00Z",
      },
    ]);
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        resourceScanRootRepoRef: { current: scanRootRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.resourceScanRoots.some((root) => root.id === "default-documents")).toBe(true);
      expect(result.current.resourceScanRoots.some((root) => root.id === "custom-projects")).toBe(true);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(scanRootRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "default-documents", source: "default" }),
      );
    }, { timeout: 3000 });
  });

  it("restores app categories from the app classification repository", async () => {
    mockScanInstalledApps.mockResolvedValue([
      { name: "Calendar", path: "C:\\Apps\\calendar.exe" },
    ]);
    const appRepo = createAppClassificationRepo([
      {
        appPath: "C:\\Apps\\calendar.exe",
        category: "办公学习",
        tags: ["日程"],
        confidence: 0.9,
        classifiedAt: "2026-01-01T00:00:00Z",
        source: "ai",
      },
    ]);

    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        activeView: "apps",
        appClassificationRepoRef: { current: appRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.installedApps[0]?.category).toBe("办公学习");
    }, { timeout: 3000 });
    expect(result.current.appCategoryStats).toEqual([{ category: "办公学习", count: 1 }]);
  });

  it("persists manual app category updates", async () => {
    mockScanInstalledApps.mockResolvedValue([
      { name: "Calendar", path: "C:\\Apps\\calendar.exe" },
    ]);
    const appRepo = createAppClassificationRepo();
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        activeView: "apps",
        appClassificationRepoRef: { current: appRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.installedApps).toHaveLength(1);
    }, { timeout: 3000 });
    result.current.handleUpdateAppCategory("C:\\Apps\\calendar.exe", "办公学习");

    await waitFor(() => {
      expect(appRepo.upsertClassifications).toHaveBeenCalledWith(
        [expect.objectContaining({ path: "C:\\Apps\\calendar.exe", category: "办公学习" })],
        "manual",
      );
    });
  });

  it("persists manual file category updates", async () => {
    mockScanResourceFiles.mockResolvedValue([
      createResourceEntry({ name: "invoice.pdf", path: "C:\\Users\\Test\\Desktop\\invoice.pdf" }),
    ]);
    const fileRepo = createFileClassificationRepo();
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        activeView: "documents",
        fileClassificationRepoRef: { current: fileRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.userDocuments).toHaveLength(1);
    }, { timeout: 3000 });
    result.current.handleUpdateFileCategory("C:\\Users\\Test\\Desktop\\invoice.pdf", "财务");

    await waitFor(() => {
      expect(fileRepo.upsertClassificationsBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          path: "C:\\Users\\Test\\Desktop\\invoice.pdf",
          category: "财务",
          tags: ["手动分类"],
          confidence: 1,
        }),
      ]);
    });
  });

  it("exposes classification errors to the UI state", async () => {
    const runtime = {
      classifyWithFileAgent: vi.fn().mockRejectedValue(new Error("AI 分类失败")),
    };
    const fileRepo = createFileClassificationRepo();
    fileRepo.getUnclassifiedFiles.mockResolvedValue([
      createResourceEntry({ name: "invoice.pdf", path: "C:\\Users\\Test\\Desktop\\invoice.pdf" }),
    ]);
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        runtime,
        fileClassificationRepoRef: { current: fileRepo },
      })),
    );

    await result.current.handleClassifyDocuments();

    await waitFor(() => {
      expect(result.current.classifyError).toContain("AI 分类失败");
    });
  });

  it("hydrates document entries from resource cache before scan completes", async () => {
    let resolveScan!: (entries: ReturnType<typeof createResourceEntry>[]) => void;
    mockScanResourceFiles.mockReturnValue(new Promise((resolve) => {
      resolveScan = resolve;
    }));
    const cacheRepo = createResourceCacheRepo();
    cacheRepo.getByKind.mockResolvedValue([
      {
        kind: "documents",
        name: "cached.pdf",
        path: "C:\\Users\\Test\\Desktop\\cached.pdf",
        source: "default",
        sourceRootId: "default-desktop",
        sourceRootPath: "C:\\Users\\Test\\Desktop",
        scannedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        activeView: "documents",
        resourceCacheRepoRef: { current: cacheRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.userDocuments[0]?.name).toBe("cached.pdf");
    }, { timeout: 3000 });

    resolveScan([createResourceEntry({ name: "fresh.pdf" })]);
    await waitFor(() => {
      expect(result.current.userDocuments[0]?.name).toBe("fresh.pdf");
    }, { timeout: 3000 });
  });

  it("refreshes a newly added scan root automatically", async () => {
    const { result } = renderHook(() => useScannedData(makeOptions()));

    await result.current.handleAddScanRoot("C:\\Users\\Test\\Projects", ["documents"]);

    await waitFor(() => {
      expect(mockScanResourceFiles).toHaveBeenCalledWith(
        "documents",
        [expect.objectContaining({ path: "C:\\Users\\Test\\Projects" })],
        expect.any(Array),
        100,
        expect.any(Function),
      );
    }, { timeout: 3000 });
  });

  it("clears cached entries and persists disabled state when a scan root is disabled", async () => {
    mockScanResourceFiles.mockResolvedValue([
      createResourceEntry({ name: "doc.pdf", sourceRootId: "default-desktop" }),
    ]);
    const scanRootRepo = createScanRootRepo();
    const cacheRepo = createResourceCacheRepo();
    const { result } = renderHook(() =>
      useScannedData(makeOptions({
        activeView: "documents",
        resourceScanRootRepoRef: { current: scanRootRepo },
        resourceCacheRepoRef: { current: cacheRepo },
      })),
    );

    await waitFor(() => {
      expect(result.current.userDocuments).toHaveLength(1);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(result.current.resourceScanRoots.some((root) => root.id === "default-desktop")).toBe(true);
    }, { timeout: 3000 });
    await result.current.handleToggleScanRoot("default-desktop", false);

    expect(cacheRepo.deleteForRoot).toHaveBeenCalledWith("documents", "default-desktop");
    expect(cacheRepo.deleteForRoot).toHaveBeenCalledWith("images", "default-desktop");
    expect(scanRootRepo.setEnabled).toHaveBeenCalledWith("default-desktop", false);
  });
});
