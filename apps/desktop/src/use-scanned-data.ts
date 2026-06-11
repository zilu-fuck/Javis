import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActiveView, WorkbenchAppEntry, WorkbenchFileEntry } from "@javis/ui";
import type { ClassifiedFile } from "@javis/core";
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
import type { AppClassificationRepository } from "./app-classification-persistence";
import type {
  ResourceScanRoot,
  ResourceScanRootRepository,
} from "./resource-scan-roots";
import {
  buildDefaultRoots,
  DOC_EXTENSIONS,
  IMAGE_EXTENSIONS,
} from "./resource-scan-roots";
import type { ResourceCacheEntry, ResourceCacheRepository } from "./resource-scan-cache";
import type { createJavisRuntime } from "./app-runtime";

export interface TimedProgress {
  current: number;
  total: number;
  startedAt: number;
}

interface UseScannedDataOptions {
  activeView: ActiveView;
  runtime: ReturnType<typeof createJavisRuntime>;
  repositoriesReadyKey?: number;
  appClassificationRepoRef: MutableRefObject<AppClassificationRepository | null>;
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
  classifyError: string | undefined;
  appsClassifying: boolean;
  appsClassifyProgress: (TimedProgress & { completed: number }) | undefined;
  appsClassifyError: string | undefined;
  mountRoots: { name: string; path: string }[];
  categoryStats: { category: string; count: number }[];
  appCategoryStats: { category: string; count: number }[];
  /** Resource scan roots (default + custom) for docs/images views. */
  resourceScanRoots: ResourceScanRoot[];
  handleRefreshApps(): void;
  handleUpdateAppCategory(path: string, category: string): void;
  handleUpdateFileCategory(path: string, category: string): void;
  handleRefreshDocuments(): void;
  handleRefreshImages(): void;
  handleNavigateDirectory(path: string): void;
  handleListDirectory(path: string): Promise<WorkbenchFileEntry[]>;
  handleRefreshScan(): Promise<void>;
  handleRefreshResourceRoots(kind: "documents" | "images"): Promise<void>;
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
  repositoriesReadyKey = 0,
  appClassificationRepoRef,
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
  const [classifyError, setClassifyError] = useState<string>();
  const [appsClassifying, setAppsClassifying] = useState(false);
  const [appsClassifyProgress, setAppsClassifyProgress] = useState<(TimedProgress & { completed: number }) | undefined>();
  const [appsClassifyError, setAppsClassifyError] = useState<string>();
  const [mountRoots, setMountRoots] = useState<{ name: string; path: string }[]>([]);
  const [categoryStats, setCategoryStats] = useState<{ category: string; count: number }[]>([]);
  const [appCategoryStats, setAppCategoryStats] = useState<{ category: string; count: number }[]>([]);
  const [resourceScanRoots, setResourceScanRoots] = useState<ResourceScanRoot[]>([]);
  const scanGenerationRef = useRef(0);
  const computerRequestIdRef = useRef(0);
  const scanningRef = useRef(false);
  const classifyAbortRef = useRef<AbortController | null>(null);
  const appsClassifyAbortRef = useRef<AbortController | null>(null);
  const disabledScanRootIdsRef = useRef(new Set<string>());
  const [scanVersion, setScanVersion] = useState(0);
  const [homeDir, setHomeDir] = useState("");
  const [scanRootsLoaded, setScanRootsLoaded] = useState(false);

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
    const repo = resourceScanRootRepoRef.current;
    if (!repo) return;
    let cancelled = false;
    setScanRootsLoaded(false);
    void repo.getAll()
      .then((saved) => {
        if (cancelled) return;
        for (const root of saved) {
          if (root.enabled) {
            disabledScanRootIdsRef.current.delete(root.id);
          } else {
            disabledScanRootIdsRef.current.add(root.id);
          }
        }
        const savedWithRuntimeState = saved.map((root) =>
          disabledScanRootIdsRef.current.has(root.id) ? { ...root, enabled: false } : root,
        );
        setResourceScanRoots((current) => sortScanRoots(mergeScanRoots(current, savedWithRuntimeState)));
        setScanRootsLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("Failed to load resource scan roots", error);
        setScanRootsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [repositoriesReadyKey, resourceScanRootRepoRef]);

  // ── Generate defaults once home dir is known ───────────────────────────
  useEffect(() => {
    if (!homeDir) return;
    const defaults = buildDefaultRoots(homeDir).map((root) =>
      disabledScanRootIdsRef.current.has(root.id) ? { ...root, enabled: false } : root,
    );
    setResourceScanRoots((current) => sortScanRoots(mergeScanRoots(defaults, current)));
  }, [homeDir]);

  useEffect(() => {
    const repo = resourceScanRootRepoRef.current;
    if (!repo || !homeDir || !scanRootsLoaded) return;
    const defaults = buildDefaultRoots(homeDir);
    const currentById = new Map(resourceScanRoots.map((root) => [root.id, root]));
    void Promise.all(defaults.map((root) => {
      const current = currentById.get(root.id) ?? root;
      return repo.upsert(disabledScanRootIdsRef.current.has(current.id) ? { ...current, enabled: false } : current);
    }))
      .catch((error) => console.warn("Failed to persist default resource scan roots", error));
  }, [homeDir, repositoriesReadyKey, resourceScanRootRepoRef, resourceScanRoots, scanRootsLoaded]);

  // ── Helper: resolve enabled roots for a given kind ─────────────────────
  const getEnabledRootsForKind = useCallback(
    (kind: "documents" | "images"): ScanResourceRootInput[] => {
      return resourceScanRoots
        .filter((r) => r.enabled && r.kinds.includes(kind) && !disabledScanRootIdsRef.current.has(r.id))
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

  async function applyStoredAppClassifications(
    apps: WorkbenchAppEntry[],
  ): Promise<WorkbenchAppEntry[]> {
    const repo = appClassificationRepoRef.current;
    if (!repo || apps.length === 0) return apps;

    const records = await repo.getAll();
    const byPath = new Map(records.map((record) => [normalizePathKey(record.appPath), record]));
    return apps.map((app) => {
      const classification = byPath.get(normalizePathKey(app.path));
      if (!classification?.category) return app;
      return {
        ...app,
        category: classification.category,
        tags: classification.tags,
        confidence: classification.confidence,
      };
    });
  }

  async function applyCachedResourceEntries(kind: "documents" | "images"): Promise<boolean> {
    const repo = resourceCacheRepoRef.current;
    if (!repo) return false;
    const enabledRootIds = new Set(getEnabledRootsForKind(kind).map((root) => root.id));
    const cached = (await repo.getByKind(kind)).filter(
      (entry) => entry.sourceRootId != null && enabledRootIds.has(entry.sourceRootId),
    );
    if (cached.length === 0) return false;
    const entries = await applyStoredFileClassifications(
      cached.map(resourceCacheEntryToWorkbench),
    );
    if (kind === "documents") {
      setUserDocuments(entries);
    } else {
      setUserImages(entries);
    }
    return true;
  }

  async function writeResourceCache(
    kind: "documents" | "images",
    roots: ScanResourceRootInput[],
    entries: ResourceFileEntry[],
  ): Promise<void> {
    const repo = resourceCacheRepoRef.current;
    if (!repo) return;
    for (const root of roots) {
      const rootEntries = entries.filter((entry) => entry.sourceRootId === root.id);
      await repo.replaceForRoot(
        kind,
        root.id,
        rootEntries.map((entry) => resourceEntryToCache(kind, entry)),
      );
    }
  }

  // ── Per-view scanning ──────────────────────────────────────────────────
  useEffect(() => {
    const gen = scanGenerationRef.current;

    if (activeView === "apps" && installedApps.length === 0 && !appsLoading) {
      setAppsLoading(true);
      setAppsError(undefined);
      setAppsProgress(undefined);
      scanInstalledApps(withStartedAt(setAppsProgress))
        .then(async (result) => {
          if (scanGenerationRef.current !== gen) return;
          setAppsProgress({ current: result.length, total: result.length, startedAt: Date.now() });
          const apps = await applyStoredAppClassifications(result.map(appEntryToWorkbench));
          setInstalledApps(apps);
          setAppCategoryStats(buildCategoryStats(apps));
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
      applyCachedResourceEntries("documents")
        .then((hadCache) => {
          if (scanGenerationRef.current !== gen) return [];
          if (hadCache) setDocsLoading(false);
          return scanResourceFiles("documents", roots, DOC_EXTENSIONS, 100, withStartedAt(setDocsProgress));
        })
        .then(async (result) => {
          if (scanGenerationRef.current !== gen) return;
          if (!result) return;
          const scopedResult = filterResourceEntriesForRoots(result, roots);
          const entries = scopedResult.map(resourceEntryToWorkbench);
          setUserDocuments(await applyStoredFileClassifications(entries));
          await writeResourceCache("documents", roots, scopedResult);
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
      applyCachedResourceEntries("images")
        .then((hadCache) => {
          if (scanGenerationRef.current !== gen) return [];
          if (hadCache) setImagesLoading(false);
          return scanResourceFiles("images", roots, IMAGE_EXTENSIONS, 100, withStartedAt(setImagesProgress));
        })
        .then(async (result) => {
          if (scanGenerationRef.current !== gen) return;
          if (!result) return;
          const scopedResult = filterResourceEntriesForRoots(result, roots);
          const entries = scopedResult.map(resourceEntryToWorkbench);
          setUserImages(await applyStoredFileClassifications(entries));
          await writeResourceCache("images", roots, scopedResult);
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
        const message = String(error);
        setDocsError(message);
        setImagesError(message);
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
      const updated = next.find((app) => normalizePathKey(app.path) === normalizePathKey(path));
      if (updated) {
        void appClassificationRepoRef.current?.upsertClassifications(
          [appToClassification(updated)],
          "manual",
        );
      }
      return next;
    });
  }, [appClassificationRepoRef]);

  const handleUpdateFileCategory = useCallback((path: string, category: string) => {
    const trimmed = category.trim();
    if (!trimmed) return;

    const normalizedPath = normalizePathKey(path);
    const matchedEntry = [...userDocuments, ...userImages].find(
      (entry) => normalizePathKey(entry.path) === normalizedPath,
    );
    if (!matchedEntry) return;

    const updatedEntry: WorkbenchFileEntry = {
      ...matchedEntry,
      category: trimmed,
      tags: Array.from(new Set([...(matchedEntry.tags ?? []), "手动分类"])),
      confidence: 1,
    };

    const updateEntry = (entry: WorkbenchFileEntry): WorkbenchFileEntry => {
      return normalizePathKey(entry.path) === normalizedPath ? updatedEntry : entry;
    };

    setUserDocuments((prev) => prev.map(updateEntry));
    setUserImages((prev) => prev.map(updateEntry));

    void fileClassificationRepoRef.current
      ?.upsertClassificationsBatch([fileToClassification(updatedEntry)])
      .then(async () => {
        const stats = await fileClassificationRepoRef.current?.getCategoryStats();
        if (stats) setCategoryStats(stats);
      })
      .catch((error) => console.warn("Failed to persist manual file category", error));
  }, [fileClassificationRepoRef, userDocuments, userImages]);

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
      const message = String(error);
      setDocsError(message);
      setImagesError(message);
      console.warn("Manual file scan failed", error);
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setScanProgress(undefined);
    }
  }, [fileClassificationRepoRef]);

  const refreshResourceRoots = useCallback(
    async (kind: "documents" | "images", roots = getEnabledRootsForKind(kind)) => {
      if (roots.length === 0) return;
      const setLoading = kind === "documents" ? setDocsLoading : setImagesLoading;
      const setError = kind === "documents" ? setDocsError : setImagesError;
      const setProgress = kind === "documents" ? setDocsProgress : setImagesProgress;
      const setEntries = kind === "documents" ? setUserDocuments : setUserImages;
      const extensions = kind === "documents" ? DOC_EXTENSIONS : IMAGE_EXTENSIONS;

      setLoading(true);
      setError(undefined);
      setProgress(undefined);
      try {
        const result = await scanResourceFiles(kind, roots, extensions, 100, withStartedAt(setProgress));
        const entries = filterResourceEntriesForRoots(result, roots);
        const workbenchEntries = await applyStoredFileClassifications(
          entries.map(resourceEntryToWorkbench),
        );
        const refreshedRootIds = new Set(roots.map((root) => root.id));
        setEntries((prev) => {
          const withoutRoots = prev.filter(
            (entry) => entry.sourceRootId == null || !refreshedRootIds.has(entry.sourceRootId),
          );
          return [...withoutRoots, ...workbenchEntries];
        });

        await writeResourceCache(kind, roots, entries);
      } catch (error) {
        setError(String(error));
        console.warn(`Resource ${kind} scan failed`, error);
      } finally {
        setLoading(false);
        setProgress(undefined);
      }
    },
    [getEnabledRootsForKind, resourceCacheRepoRef],
  );

  const handleRefreshResourceRoots = useCallback(
    async (kind: "documents" | "images") => {
      await refreshResourceRoots(kind);
    },
    [refreshResourceRoots],
  );

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
    setClassifyError(undefined);
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
      setClassifyError(String(error));
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
    setAppsClassifyError(undefined);
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
        await appClassificationRepoRef.current?.upsertClassifications(classified, "ai");
        setInstalledApps((prev) => {
          const next = applyClassificationsToApps(prev, classified);
          setAppCategoryStats(buildCategoryStats(next));
          return next;
        });
      }
    } catch (error) {
      setAppsClassifyError(String(error));
      console.warn("App classification failed", error);
    } finally {
      setAppsClassifying(false);
      setAppsClassifyProgress(undefined);
      appsClassifyAbortRef.current = null;
    }
  }, [appClassificationRepoRef, appsClassifying, installedApps, runtime]);

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
      await refreshResourceRoots(kinds[0] ?? "documents", [
        { id: newRoot.id, path: newRoot.path, source: newRoot.source },
      ]);
    },
    [persistRoot, refreshResourceRoots],
  );

  const handleRemoveScanRoot = useCallback(
    async (id: string) => {
      scanGenerationRef.current += 1;
      disabledScanRootIdsRef.current.add(id);
      const root = resourceScanRoots.find((r) => r.id === id);
      const repo = resourceScanRootRepoRef.current;
      if (repo) await repo.remove(id);
      for (const kind of root?.kinds ?? ["documents", "images"] as const) {
        await resourceCacheRepoRef.current?.deleteForRoot(kind, id);
      }
      setResourceScanRoots((prev) => prev.filter((r) => r.id !== id));
      setUserDocuments((prev) => prev.filter((entry) => entry.sourceRootId !== id));
      setUserImages((prev) => prev.filter((entry) => entry.sourceRootId !== id));
      setDocsLoading(false);
      setImagesLoading(false);
      setDocsProgress(undefined);
      setImagesProgress(undefined);
    },
    [resourceCacheRepoRef, resourceScanRootRepoRef, resourceScanRoots],
  );

  const handleToggleScanRoot = useCallback(
    async (id: string, enabled: boolean) => {
      scanGenerationRef.current += 1;
      if (enabled) {
        disabledScanRootIdsRef.current.delete(id);
      } else {
        disabledScanRootIdsRef.current.add(id);
      }
      const root = resourceScanRoots.find((r) => r.id === id);
      const repo = resourceScanRootRepoRef.current;
      if (repo) await repo.setEnabled(id, enabled);
      setResourceScanRoots((prev) =>
        prev.map((r) => (r.id === id ? { ...r, enabled } : r)),
      );
      if (!enabled) {
        for (const kind of root?.kinds ?? ["documents", "images"] as const) {
          await resourceCacheRepoRef.current?.deleteForRoot(kind, id);
        }
        setUserDocuments((prev) => prev.filter((entry) => entry.sourceRootId !== id));
        setUserImages((prev) => prev.filter((entry) => entry.sourceRootId !== id));
        setDocsLoading(false);
        setImagesLoading(false);
        setDocsProgress(undefined);
        setImagesProgress(undefined);
        return;
      }
      if (!root) return;
      const rootInput: ScanResourceRootInput = { id: root.id, path: root.path, source: root.source };
      for (const kind of root.kinds) {
        await refreshResourceRoots(kind, [rootInput]);
      }
    },
    [refreshResourceRoots, resourceCacheRepoRef, resourceScanRootRepoRef, resourceScanRoots],
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
              entries.map((entry) => resourceEntryToCache(kind, entry)),
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
    classifyError,
    appsClassifying,
    appsClassifyProgress,
    appsClassifyError,
    mountRoots,
    categoryStats,
    appCategoryStats,
    resourceScanRoots,
    handleRefreshApps,
    handleUpdateAppCategory,
    handleUpdateFileCategory,
    handleRefreshDocuments,
    handleRefreshImages,
    handleNavigateDirectory,
    handleListDirectory,
    handleRefreshScan,
    handleRefreshResourceRoots,
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

function resourceCacheEntryToWorkbench(entry: ResourceCacheEntry): WorkbenchFileEntry {
  return {
    name: entry.name,
    path: entry.path,
    isDir: false,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension,
    sourceRootId: entry.sourceRootId,
    sourceRootPath: entry.sourceRootPath,
  };
}

function resourceEntryToCache(kind: "documents" | "images", entry: ResourceFileEntry) {
  return {
    kind,
    path: entry.path,
    name: entry.name,
    source: entry.source,
    sourceRootId: entry.sourceRootId,
    sourceRootPath: entry.sourceRootPath,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    extension: entry.extension,
    scannedAt: new Date().toISOString(),
  };
}

function filterResourceEntriesForRoots(
  entries: ResourceFileEntry[],
  roots: ScanResourceRootInput[],
): ResourceFileEntry[] {
  const rootIds = new Set(roots.map((root) => root.id));
  return entries.filter((entry) => entry.sourceRootId != null && rootIds.has(entry.sourceRootId));
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

function appToClassification(app: WorkbenchAppEntry): ClassifiedFile {
  return {
    name: app.name,
    path: app.path,
    extension: "app",
    sizeBytes: undefined,
    category: app.category ?? "其他",
    tags: app.tags ?? [],
    confidence: app.confidence ?? 1,
  };
}

function fileToClassification(file: WorkbenchFileEntry): ClassifiedFile {
  return {
    name: file.name,
    path: file.path,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    category: file.category ?? "其他",
    tags: file.tags ?? [],
    confidence: file.confidence ?? 1,
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

function mergeScanRoots(
  base: ResourceScanRoot[],
  override: ResourceScanRoot[],
): ResourceScanRoot[] {
  const byId = new Map<string, ResourceScanRoot>();
  for (const root of base) byId.set(root.id, root);
  for (const root of override) byId.set(root.id, root);
  return [...byId.values()];
}

function sortScanRoots(roots: ResourceScanRoot[]): ResourceScanRoot[] {
  return [...roots].sort((a, b) => {
    if (a.source !== b.source) return a.source === "default" ? -1 : 1;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
}
