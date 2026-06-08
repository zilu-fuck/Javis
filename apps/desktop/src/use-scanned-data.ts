import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActiveView, WorkbenchAppEntry, WorkbenchFileEntry } from "@javis/ui";
import {
  type AppEntry,
  type FileEntry,
  type ResourceFileEntry,
  type ScanResourceRootInput,
  getUserHome,
  listDirectory,
  listMountRoots,
  scanAllUserFiles,
  scanInstalledApps,
  scanResourceFiles,
} from "./local-knowledge";
import type { FileClassificationRepository } from "./file-classification-persistence";
import type {
  ResourceScanRoot,
  ResourceScanRootRepository,
} from "./resource-scan-roots";
import {
  buildDefaultRoots,
  DOC_EXTENSIONS,
  IMAGE_EXTENSIONS,
} from "./resource-scan-roots";
import type { ResourceCacheRepository } from "./resource-scan-cache";
import type { createJavisRuntime } from "./app-runtime";

export interface TimedProgress {
  current: number;
  total: number;
  startedAt: number;
}

interface UseScannedDataOptions {
  activeView: ActiveView;
  runtime: ReturnType<typeof createJavisRuntime>;
  fileClassificationRepoRef: MutableRefObject<FileClassificationRepository | null>;
  resourceScanRootRepoRef: MutableRefObject<ResourceScanRootRepository | null>;
  resourceCacheRepoRef: MutableRefObject<ResourceCacheRepository | null>;
}

export interface ScannedDataControls {
  installedApps: WorkbenchAppEntry[];
  userDocuments: WorkbenchFileEntry[];
  userImages: WorkbenchFileEntry[];
  computerEntries: WorkbenchFileEntry[];
  computerPath: string;
  appsLoading: boolean;
  docsLoading: boolean;
  imagesLoading: boolean;
  computerLoading: boolean;
  appsError: string | undefined;
  docsError: string | undefined;
  imagesError: string | undefined;
  computerError: string | undefined;
  scanProgress: TimedProgress | undefined;
  appsProgress: TimedProgress | undefined;
  docsProgress: TimedProgress | undefined;
  imagesProgress: TimedProgress | undefined;
  scanning: boolean;
  classifying: boolean;
  classifyProgress: (TimedProgress & { completed: number }) | undefined;
  appsClassifying: boolean;
  appsClassifyProgress: (TimedProgress & { completed: number }) | undefined;
  mountRoots: { name: string; path: string }[];
  categoryStats: { category: string; count: number }[];
  appCategoryStats: { category: string; count: number }[];
  /** Resource scan roots (default + custom) for docs/images views. */
  resourceScanRoots: ResourceScanRoot[];
  handleRefreshApps(): void;
  handleUpdateAppCategory(path: string, category: string): void;
  handleRefreshDocuments(): void;
  handleRefreshImages(): void;
  handleNavigateDirectory(path: string): void;
  handleListDirectory(path: string): Promise<WorkbenchFileEntry[]>;
  handleRefreshScan(): Promise<void>;
  handleClassifyDocuments(): Promise<void>;
  handleClassifyApps(): Promise<void>;
  handleCancelClassify(): void;
  handleCancelClassifyApps(): void;
  /** Resource scan root management. */
  handleAddScanRoot(path: string, kinds: ResourceScanRoot["kinds"], label?: string): Promise<void>;
  handleRemoveScanRoot(id: string): Promise<void>;
  handleToggleScanRoot(id: string, enabled: boolean): Promise<void>;
  handleSetScanRootKinds(id: string, kinds: ResourceScanRoot["kinds"]): Promise<void>;
  handleRefreshScanRoot(id: string): Promise<void>;
}

export function useScannedData({
  activeView,
  runtime,
  fileClassificationRepoRef,
  resourceScanRootRepoRef,
  resourceCacheRepoRef,
}: UseScannedDataOptions): ScannedDataControls {
  const [installedApps, setInstalledApps] = useState<WorkbenchAppEntry[]>([]);
  const [userDocuments, setUserDocuments] = useState<WorkbenchFileEntry[]>([]);
  const [userImages, setUserImages] = useState<WorkbenchFileEntry[]>([]);
  const [computerEntries, setComputerEntries] = useState<WorkbenchFileEntry[]>([]);
  const [computerPath, setComputerPath] = useState("");
  const [appsLoading, setAppsLoading] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [computerLoading, setComputerLoading] = useState(false);
  const [appsError, setAppsError] = useState<string>();
  const [docsError, setDocsError] = useState<string>();
  const [imagesError, setImagesError] = useState<string>();
  const [computerError, setComputerError] = useState<string>();
  const [scanProgress, setScanProgress] = useState<TimedProgress | undefined>();
  const [appsProgress, setAppsProgress] = useState<TimedProgress | undefined>();
  const [docsProgress, setDocsProgress] = useState<TimedProgress | undefined>();
  const [imagesProgress, setImagesProgress] = useState<TimedProgress | undefined>();
  const [scanning, setScanning] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState<(TimedProgress & { completed: number }) | undefined>();
  const [appsClassifying, setAppsClassifying] = useState(false);
  const [appsClassifyProgress, setAppsClassifyProgress] = useState<(TimedProgress & { completed: number }) | undefined>();
  const [mountRoots, setMountRoots] = useState<{ name: string; path: string }[]>([]);
  const [categoryStats, setCategoryStats] = useState<{ category: string; count: number }[]>([]);
  const [appCategoryStats, setAppCategoryStats] = useState<{ category: string; count: number }[]>([]);
  const [resourceScanRoots, setResourceScanRoots] = useState<ResourceScanRoot[]>([]);
  const scanGenerationRef = useRef(0);
  const computerRequestIdRef = useRef(0);
  const scanningRef = useRef(false);
  const classifyAbortRef = useRef<AbortController | null>(null);
  const appsClassifyAbortRef = useRef<AbortController | null>(null);
  const [scanVersion, setScanVersion] = useState(0);
  const [homeDir, setHomeDir] = useState("");
  const rootsLoadedRef = useRef(false);

  function withStartedAt(setter: (progress: TimedProgress) => void) {
    const startedAt = Date.now();
    return (progress: { current: number; total: number }) => {
      setter({ ...progress, startedAt });
    };
  }

  // ── Init: load home dir + mount roots ──────────────────────────────────
  useEffect(() => {
    void getUserHome()
      .then((home) => { setHomeDir(home); })
      .catch(() => { setHomeDir("C:\\Users\\Default"); });
    void listMountRoots()
      .then(setMountRoots)
      .catch((error) => console.warn("Failed to load mount roots", error));
  }, []);

  // ── Init: load resource scan roots from DB (once) ──────────────────────
  useEffect(() => {
    if (rootsLoadedRef.current) return;
    const repo = resourceScanRootRepoRef.current;
    if (!repo) return;
    rootsLoadedRef.current = true;
    void repo.getAll().then((saved) => {
      if (saved.length > 0) {
        setResourceScanRoots(saved);
      }
      // If DB is empty, defer to home-dir effect below (avoids stale
      // C:\Users\Default fallback before the real home dir resolves).
    });
  }, [resourceScanRootRepoRef]);

  // ── Generate defaults once home dir is known ───────────────────────────
  useEffect(() => {
    if (!homeDir) return;
    // Only generate defaults when roots haven't been loaded from DB yet.
    if (resourceScanRoots.length > 0) return;
    const defaults = buildDefaultRoots(homeDir);
    setResourceScanRoots(defaults);
  }, [homeDir, resourceScanRoots.length]);

  // ── Helper: resolve enabled roots for a given kind ─────────────────────
  const getEnabledRootsForKind = useCallback(
    (kind: "documents" | "images"): ScanResourceRootInput[] => {
      return resourceScanRoots
        .filter((r) => r.enabled && r.kinds.includes(kind))
        .map((r) => ({ id: r.id, path: r.path, source: r.source }));
    },
    [resourceScanRoots],
  );

  // ── Helper: resource file entry → WorkbenchFileEntry ───────────────────
  function resourceEntryToWorkbench(entry: ResourceFileEntry): WorkbenchFileEntry {
    return {
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      extension: entry.extension,
      sourceRootId: entry.sourceRootId,
      sourceRootPath: entry.sourceRootPath,
    };
  }

  async function applyStoredFileClassifications(
    entries: WorkbenchFileEntry[],
  ): Promise<WorkbenchFileEntry[]> {
    const repo = fileClassificationRepoRef.current;
    if (!repo || entries.length === 0) return entries;

    const cached = await repo.getScanCache();
    const byPath = new Map(cached.map((entry) => [normalizePathKey(entry.path), entry]));
    return entries.map((entry) => {
      const classification = byPath.get(normalizePathKey(entry.path));
      if (!classification?.category) return entry;
      if (classification.category === "其他" || (classification.confidence ?? 0) < 0.5) {
        return entry;
      }
      return {
        ...entry,
        category: classification.category,
        tags: classification.tags,
        confidence: classification.confidence,
      };
    });
  }

  // ── Per-view scanning ──────────────────────────────────────────────────
  useEffect(() => {
    const gen = scanGenerationRef.current;

    if (activeView === "apps" && installedApps.length === 0 && !appsLoading) {
      setAppsLoading(true);
      setAppsError(undefined);
      setAppsProgress(undefined);
      scanInstalledApps(withStartedAt(setAppsProgress))
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setAppsProgress({ current: result.length, total: result.length, startedAt: Date.now() });
          setInstalledApps(result.map(appEntryToWorkbench));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setAppsError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setAppsLoading(false);
          setAppsProgress(undefined);
        });
    }

    if (activeView === "documents" && userDocuments.length === 0 && !docsLoading) {
      const roots = getEnabledRootsForKind("documents");
      if (roots.length === 0) return;
      setDocsLoading(true);
      setDocsError(undefined);
      setDocsProgress(undefined);
      scanResourceFiles("documents", roots, DOC_EXTENSIONS, 100, withStartedAt(setDocsProgress))
        .then(async (result) => {
          if (scanGenerationRef.current !== gen) return;
          const entries = result.map(resourceEntryToWorkbench);
          setUserDocuments(await applyStoredFileClassifications(entries));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setDocsError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setDocsLoading(false);
          setDocsProgress(undefined);
        });
    }

    if (activeView === "gallery" && userImages.length === 0 && !imagesLoading) {
      const roots = getEnabledRootsForKind("images");
      if (roots.length === 0) return;
      setImagesLoading(true);
      setImagesError(undefined);
      setImagesProgress(undefined);
      scanResourceFiles("images", roots, IMAGE_EXTENSIONS, 100, withStartedAt(setImagesProgress))
        .then(async (result) => {
          if (scanGenerationRef.current !== gen) return;
          const entries = result.map(resourceEntryToWorkbench);
          setUserImages(await applyStoredFileClassifications(entries));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setImagesError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setImagesLoading(false);
          setImagesProgress(undefined);
        });
    }

    if (activeView === "computer" && computerPath && computerEntries.length === 0 && !computerLoading) {
      const requestId = computerRequestIdRef.current + 1;
      computerRequestIdRef.current = requestId;
      setComputerLoading(true);
      setComputerError(undefined);
      listDirectory(computerPath)
        .then((result) => {
          if (computerRequestIdRef.current !== requestId) return;
          setComputerEntries(result.map(fileEntryToWorkbench));
        })
        .catch((error) => {
          if (computerRequestIdRef.current !== requestId) return;
          setComputerError(String(error));
        })
        .finally(() => {
          if (computerRequestIdRef.current !== requestId) return;
          setComputerLoading(false);
        });
    }
  }, [activeView, appsLoading, computerEntries.length, computerLoading, computerPath, docsLoading, imagesLoading, installedApps.length, userDocuments.length, userImages.length, scanVersion, getEnabledRootsForKind]);

  // ── Background deep scan (classification) ──────────────────────────────
  useEffect(() => {
    const timer = setTimeout(async () => {
      const repo = fileClassificationRepoRef.current;
      if (!repo || scanningRef.current) return;
      scanningRef.current = true;
      setScanning(true);
      setScanProgress(undefined);
      try {
        const files = await scanAllUserFiles(undefined, undefined, withStartedAt(setScanProgress));
        await repo.replaceScanCache(files);
        const stats = await repo.getCategoryStats();
        setCategoryStats(stats);
      } catch (error) {
        console.warn("Background file scan failed", error);
      } finally {
        scanningRef.current = false;
        setScanning(false);
        setScanProgress(undefined);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [fileClassificationRepoRef]);

  // ── Refresh handlers ───────────────────────────────────────────────────
  const handleRefreshApps = useCallback(() => {
    scanGenerationRef.current += 1;
    setInstalledApps([]);
    setAppCategoryStats([]);
    setAppsError(undefined);
    setAppsLoading(false);
    setAppsProgress(undefined);
    setScanVersion((v) => v + 1);
  }, []);

  const handleUpdateAppCategory = useCallback((path: string, category: string) => {
    const trimmed = category.trim();
    if (!trimmed) return;
    setInstalledApps((prev) => {
      const next = prev.map((app) =>
        normalizePathKey(app.path) === normalizePathKey(path)
          ? {
              ...app,
              category: trimmed,
              tags: Array.from(new Set([...(app.tags ?? []), "手动分类"])),
              confidence: 1,
            }
          : app,
      );
      setAppCategoryStats(buildCategoryStats(next));
      return next;
    });
  }, []);

  const handleRefreshDocuments = useCallback(() => {
    scanGenerationRef.current += 1;
    setUserDocuments([]);
    setDocsError(undefined);
    setDocsLoading(false);
    setDocsProgress(undefined);
    setScanVersion((v) => v + 1);
  }, []);

  const handleRefreshImages = useCallback(() => {
    scanGenerationRef.current += 1;
    setUserImages([]);
    setImagesError(undefined);
    setImagesLoading(false);
    setImagesProgress(undefined);
    setScanVersion((v) => v + 1);
  }, []);

  const handleNavigateDirectory = useCallback((path: string) => {
    const requestId = computerRequestIdRef.current + 1;
    computerRequestIdRef.current = requestId;
    setComputerPath(path);
    setComputerEntries([]);
    setComputerError(undefined);
    if (!path) {
      setComputerLoading(false);
      return;
    }
    setComputerLoading(true);
    void listDirectory(path)
      .then((result) => {
        if (computerRequestIdRef.current !== requestId) return;
        setComputerEntries(result.map(fileEntryToWorkbench));
      })
      .catch((error) => {
        if (computerRequestIdRef.current !== requestId) return;
        setComputerError(String(error));
      })
      .finally(() => {
        if (computerRequestIdRef.current !== requestId) return;
        setComputerLoading(false);
      });
  }, []);

  const handleListDirectory = useCallback(async (path: string): Promise<WorkbenchFileEntry[]> => {
    const result = await listDirectory(path);
    return result.map(fileEntryToWorkbench);
  }, []);

  const handleRefreshScan = useCallback(async () => {
    const repo = fileClassificationRepoRef.current;
    if (!repo || scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    setScanProgress(undefined);
    try {
      const files = await scanAllUserFiles(undefined, undefined, withStartedAt(setScanProgress));
      await repo.replaceScanCache(files);
      const stats = await repo.getCategoryStats();
      setCategoryStats(stats);
    } catch (error) {
      console.warn("Manual file scan failed", error);
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setScanProgress(undefined);
    }
  }, [fileClassificationRepoRef]);

  const handleClassifyDocuments = useCallback(async () => {
    const repo = fileClassificationRepoRef.current;
    if (!repo || classifying) return;

    const unclassified = [
      ...await repo.getUnclassifiedFiles(),
      ...userDocuments
        .filter((entry) => shouldClassifyResourceEntry(entry))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDir: entry.isDir,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
          extension: entry.extension,
          scannedAt: new Date().toISOString(),
        })),
      ...userImages
        .filter((entry) => shouldClassifyResourceEntry(entry))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDir: entry.isDir,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
          extension: entry.extension,
          scannedAt: new Date().toISOString(),
        })),
    ].filter((entry, index, entries) =>
      entries.findIndex((candidate) => normalizePathKey(candidate.path) === normalizePathKey(entry.path)) === index,
    );
    if (unclassified.length === 0) return;

    const totalFiles = unclassified.length;
    const classifyStartedAt = Date.now();
    setClassifying(true);
    setClassifyProgress({ completed: 0, current: 0, total: totalFiles, startedAt: classifyStartedAt });
    const abortController = new AbortController();
    classifyAbortRef.current = abortController;

    try {
      const classified = await runtime.classifyWithFileAgent(unclassified, {
        signal: abortController.signal,
        onBatchProgress: (completed) => {
          const current = Math.min(completed * 50, totalFiles);
          setClassifyProgress({
            completed: current,
            current,
            total: totalFiles,
            startedAt: classifyStartedAt,
          });
        },
      });
      if (classified.length > 0) {
        await repo.upsertClassificationsBatch(classified);
        const stats = await repo.getCategoryStats();
        setCategoryStats(stats);
        setUserDocuments((prev) => applyClassificationsToFileEntries(prev, classified));
        setUserImages((prev) => applyClassificationsToFileEntries(prev, classified));
      }
    } catch (error) {
      console.warn("Document classification failed", error);
    } finally {
      setClassifying(false);
      setClassifyProgress(undefined);
      classifyAbortRef.current = null;
    }
  }, [classifying, fileClassificationRepoRef, runtime, userDocuments, userImages]);

  const handleCancelClassify = useCallback(() => {
    classifyAbortRef.current?.abort();
  }, []);

  const handleClassifyApps = useCallback(async () => {
    if (appsClassifying || installedApps.length === 0) return;

    const unclassified = installedApps.filter((app) => app.category == null);
    if (unclassified.length === 0) return;

    const totalApps = unclassified.length;
    const classifyStartedAt = Date.now();
    setAppsClassifying(true);
    setAppsClassifyProgress({ completed: 0, current: 0, total: totalApps, startedAt: classifyStartedAt });
    const abortController = new AbortController();
    appsClassifyAbortRef.current = abortController;

    try {
      const classified = await runtime.classifyAppsWithAgent(
        unclassified.map((app) => ({
          name: app.name,
          path: app.path,
          publisher: app.publisher,
          installLocation: app.installLocation,
        })),
        {
          signal: abortController.signal,
          onBatchProgress: (completed) => {
            const current = Math.min(completed * 50, totalApps);
            setAppsClassifyProgress({
              completed: current,
              current,
              total: totalApps,
              startedAt: classifyStartedAt,
            });
          },
        },
      );
      if (classified.length > 0) {
        setInstalledApps((prev) => {
          const next = applyClassificationsToApps(prev, classified);
          setAppCategoryStats(buildCategoryStats(next));
          return next;
        });
      }
    } catch (error) {
      console.warn("App classification failed", error);
    } finally {
      setAppsClassifying(false);
      setAppsClassifyProgress(undefined);
      appsClassifyAbortRef.current = null;
    }
  }, [appsClassifying, installedApps, runtime]);

  const handleCancelClassifyApps = useCallback(() => {
    appsClassifyAbortRef.current?.abort();
  }, []);

  // ── Resource scan root management ──────────────────────────────────────
  const persistRoot = useCallback(
    async (root: ResourceScanRoot) => {
      const repo = resourceScanRootRepoRef.current;
      if (repo) await repo.upsert(root);
    },
    [resourceScanRootRepoRef],
  );

  const handleAddScanRoot = useCallback(
    async (path: string, kinds: ResourceScanRoot["kinds"], label?: string) => {
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newRoot: ResourceScanRoot = {
        id,
        path,
        label,
        kinds,
        enabled: true,
        source: "custom",
        createdAt: new Date().toISOString(),
      };
      setResourceScanRoots((prev) => [...prev, newRoot]);
      await persistRoot(newRoot);
    },
    [persistRoot],
  );

  const handleRemoveScanRoot = useCallback(
    async (id: string) => {
      const repo = resourceScanRootRepoRef.current;
      if (repo) await repo.remove(id);
      setResourceScanRoots((prev) => prev.filter((r) => r.id !== id));
    },
    [resourceScanRootRepoRef],
  );

  const handleToggleScanRoot = useCallback(
    async (id: string, enabled: boolean) => {
      const repo = resourceScanRootRepoRef.current;
      if (repo) await repo.setEnabled(id, enabled);
      setResourceScanRoots((prev) =>
        prev.map((r) => (r.id === id ? { ...r, enabled } : r)),
      );
    },
    [resourceScanRootRepoRef],
  );

  const handleSetScanRootKinds = useCallback(
    async (id: string, kinds: ResourceScanRoot["kinds"]) => {
      setResourceScanRoots((prev) => {
        const updated = prev.map((r) => (r.id === id ? { ...r, kinds } : r));
        // Persist in background
        const target = updated.find((r) => r.id === id);
        if (target) {
          const repo = resourceScanRootRepoRef.current;
          if (repo) void repo.upsert(target);
        }
        return updated;
      });
    },
    [resourceScanRootRepoRef],
  );

  const handleRefreshScanRoot = useCallback(
    async (id: string) => {
      // Refresh just one root for applicable kinds
      const root = resourceScanRoots.find((r) => r.id === id);
      if (!root) return;
      const repo = resourceCacheRepoRef.current;

      for (const kind of root.kinds) {
        const rootInput: ScanResourceRootInput = { id: root.id, path: root.path, source: root.source };
        if (kind === "documents") {
          setDocsLoading(true);
          setDocsError(undefined);
        } else {
          setImagesLoading(true);
          setImagesError(undefined);
        }
        try {
          const exts = kind === "documents" ? DOC_EXTENSIONS : IMAGE_EXTENSIONS;
          const entries = await scanResourceFiles(kind, [rootInput], exts, 100);
          const workbenchEntries = await applyStoredFileClassifications(
            entries.map(resourceEntryToWorkbench),
          );
          if (kind === "documents") {
            setUserDocuments((prev) => {
              const withoutRoot = prev.filter(
                (e) => e.sourceRootId == null || e.sourceRootId !== root.id,
              );
              return [...withoutRoot, ...workbenchEntries];
            });
          } else {
            setUserImages((prev) => {
              const withoutRoot = prev.filter(
                (e) => e.sourceRootId == null || e.sourceRootId !== root.id,
              );
              return [...withoutRoot, ...workbenchEntries];
            });
          }
          // Update cache
          if (repo) {
            await repo.replaceForRoot(
              kind,
              root.id,
              entries.map((e) => ({
                kind,
                path: e.path,
                name: e.name,
                source: e.source,
                sourceRootId: e.sourceRootId,
                sourceRootPath: e.sourceRootPath,
                sizeBytes: e.sizeBytes,
                modifiedAt: e.modifiedAt,
                extension: e.extension,
                scannedAt: new Date().toISOString(),
              })),
            );
          }
        } catch (error) {
          console.warn(`Failed to refresh root ${root.id} for ${kind}`, error);
        } finally {
          if (kind === "documents") {
            setDocsLoading(false);
            setDocsProgress(undefined);
          } else {
            setImagesLoading(false);
            setImagesProgress(undefined);
          }
        }
      }
    },
    [resourceScanRoots, resourceCacheRepoRef],
  );

  return {
    installedApps,
    userDocuments,
    userImages,
    computerEntries,
    computerPath,
    appsLoading,
    docsLoading,
    imagesLoading,
    computerLoading,
    appsError,
    docsError,
    imagesError,
    computerError,
    scanProgress,
    appsProgress,
    docsProgress,
    imagesProgress,
    scanning,
    classifying,
    classifyProgress,
    appsClassifying,
    appsClassifyProgress,
    mountRoots,
    categoryStats,
    appCategoryStats,
    resourceScanRoots,
    handleRefreshApps,
    handleUpdateAppCategory,
    handleRefreshDocuments,
    handleRefreshImages,
    handleNavigateDirectory,
    handleListDirectory,
    handleRefreshScan,
    handleClassifyDocuments,
    handleClassifyApps,
    handleCancelClassify,
    handleCancelClassifyApps,
    handleAddScanRoot,
    handleRemoveScanRoot,
    handleToggleScanRoot,
    handleSetScanRootKinds,
    handleRefreshScanRoot,
  };
}

function fileEntryToWorkbench(entry: FileEntry): WorkbenchFileEntry {
  return {
    name: entry.name,
    path: entry.path,
    isDir: entry.isDir,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension,
  };
}

function appEntryToWorkbench(entry: AppEntry): WorkbenchAppEntry {
  return {
    name: entry.name,
    path: entry.path,
    iconPath: entry.iconPath,
    publisher: entry.publisher,
    installLocation: entry.installLocation,
  };
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

function shouldClassifyResourceEntry(entry: WorkbenchFileEntry): boolean {
  return !entry.isDir && (
    entry.category == null
    || entry.category === "其他"
    || entry.confidence == null
    || entry.confidence < 0.5
  );
}

function applyClassificationsToFileEntries(
  entries: WorkbenchFileEntry[],
  classifications: Array<{ path: string; category: string; tags?: string[]; confidence?: number }>,
): WorkbenchFileEntry[] {
  const byPath = new Map(classifications.map((item) => [normalizePathKey(item.path), item]));
  return entries.map((entry) => {
    const classification = byPath.get(normalizePathKey(entry.path));
    if (!classification) return entry;
    return {
      ...entry,
      category: classification.category,
      tags: classification.tags ?? [],
      confidence: classification.confidence,
    };
  });
}

function applyClassificationsToApps(
  apps: WorkbenchAppEntry[],
  classifications: Array<{ path: string; category: string; tags?: string[]; confidence?: number }>,
): WorkbenchAppEntry[] {
  const byPath = new Map(classifications.map((item) => [normalizePathKey(item.path), item]));
  return apps.map((app) => {
    const classification = byPath.get(normalizePathKey(app.path));
    if (!classification) return app;
    return {
      ...app,
      category: classification.category,
      tags: classification.tags ?? [],
      confidence: classification.confidence,
    };
  });
}

function buildCategoryStats(entries: Array<{ category?: string }>): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.category) continue;
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}
