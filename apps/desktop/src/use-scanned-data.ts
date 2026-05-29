import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ActiveView, WorkbenchAppEntry, WorkbenchFileEntry } from "@javis/ui";
import { type AppEntry, type FileEntry, listDirectory, listMountRoots, scanAllUserFiles, scanInstalledApps, scanUserDocuments, scanUserImages } from "./local-knowledge";
import type { FileClassificationRepository } from "./file-classification-persistence";
import type { createJavisRuntime } from "./app-runtime";

const DOC_EXTENSIONS = [
  "docx", "doc", "txt", "pdf", "xlsx", "xls", "csv", "pptx", "ppt", "md", "rtf", "odt",
];

interface UseScannedDataOptions {
  activeView: ActiveView;
  runtime: ReturnType<typeof createJavisRuntime>;
  fileClassificationRepoRef: MutableRefObject<FileClassificationRepository | null>;
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
  scanProgress: { current: number; total: number } | undefined;
  scanning: boolean;
  classifying: boolean;
  classifyProgress: { completed: number; total: number } | undefined;
  mountRoots: { name: string; path: string }[];
  categoryStats: { category: string; count: number }[];
  handleRefreshApps(): void;
  handleRefreshDocuments(): void;
  handleRefreshImages(): void;
  handleNavigateDirectory(path: string): void;
  handleListDirectory(path: string): Promise<WorkbenchFileEntry[]>;
  handleRefreshScan(): Promise<void>;
  handleClassifyDocuments(): Promise<void>;
  handleCancelClassify(): void;
}

export function useScannedData({
  activeView,
  runtime,
  fileClassificationRepoRef,
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
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | undefined>();
  const [scanning, setScanning] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState<{ completed: number; total: number } | undefined>();
  const [mountRoots, setMountRoots] = useState<{ name: string; path: string }[]>([]);
  const [categoryStats, setCategoryStats] = useState<{ category: string; count: number }[]>([]);
  const scanGenerationRef = useRef(0);
  const computerRequestIdRef = useRef(0);
  const scanningRef = useRef(false);
  const classifyAbortRef = useRef<AbortController | null>(null);
  const [scanVersion, setScanVersion] = useState(0);

  useEffect(() => {
    void listMountRoots()
      .then(setMountRoots)
      .catch((error) => console.warn("Failed to load mount roots", error));
  }, []);

  useEffect(() => {
    scanGenerationRef.current += 1;
    const gen = scanGenerationRef.current;

    if (activeView === "apps" && installedApps.length === 0 && !appsLoading) {
      setAppsLoading(true);
      setAppsError(undefined);
      scanInstalledApps()
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setInstalledApps(result.map(appEntryToWorkbench));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setAppsError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setAppsLoading(false);
        });
    }

    if (activeView === "documents" && userDocuments.length === 0 && !docsLoading) {
      setDocsLoading(true);
      setDocsError(undefined);
      scanUserDocuments(DOC_EXTENSIONS, 200)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setUserDocuments(result.map(fileEntryToWorkbench));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setDocsError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setDocsLoading(false);
        });
    }

    if (activeView === "gallery" && userImages.length === 0 && !imagesLoading) {
      setImagesLoading(true);
      setImagesError(undefined);
      scanUserImages(200)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setUserImages(result.map(fileEntryToWorkbench));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setImagesError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setImagesLoading(false);
        });
    }

    if (activeView === "computer" && computerPath && computerEntries.length === 0 && !computerLoading) {
      setComputerLoading(true);
      setComputerError(undefined);
      listDirectory(computerPath)
        .then((result) => {
          if (scanGenerationRef.current !== gen) return;
          setComputerEntries(result.map(fileEntryToWorkbench));
        })
        .catch((error) => {
          if (scanGenerationRef.current !== gen) return;
          setComputerError(String(error));
        })
        .finally(() => {
          if (scanGenerationRef.current !== gen) return;
          setComputerLoading(false);
        });
    }
  }, [activeView, appsLoading, computerEntries.length, computerLoading, computerPath, docsLoading, imagesLoading, installedApps.length, userDocuments.length, userImages.length, scanVersion]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const repo = fileClassificationRepoRef.current;
      if (!repo || scanningRef.current) return;
      scanningRef.current = true;
      setScanning(true);
      setScanProgress(undefined);
      try {
        const files = await scanAllUserFiles(undefined, undefined, (p) => setScanProgress(p));
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

  const handleRefreshApps = useCallback(() => {
    setInstalledApps([]);
    setAppsError(undefined);
    setAppsLoading(false);
    setScanVersion((v) => v + 1);
  }, []);

  const handleRefreshDocuments = useCallback(() => {
    setUserDocuments([]);
    setDocsError(undefined);
    setDocsLoading(false);
    setScanVersion((v) => v + 1);
  }, []);

  const handleRefreshImages = useCallback(() => {
    setUserImages([]);
    setImagesError(undefined);
    setImagesLoading(false);
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
      const files = await scanAllUserFiles(undefined, undefined, (p) => setScanProgress(p));
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

    const unclassified = await repo.getUnclassifiedFiles();
    if (unclassified.length === 0) return;

    const totalFiles = unclassified.length;
    setClassifying(true);
    setClassifyProgress({ completed: 0, total: totalFiles });
    const abortController = new AbortController();
    classifyAbortRef.current = abortController;

    try {
      const classified = await runtime.classifyWithFileAgent(unclassified, {
        signal: abortController.signal,
        onBatchProgress: (completed) =>
          setClassifyProgress({
            completed: Math.min(completed * 50, totalFiles),
            total: totalFiles,
          }),
      });
      if (classified.length > 0) {
        await repo.upsertClassificationsBatch(classified);
        const stats = await repo.getCategoryStats();
        setCategoryStats(stats);
      }
    } catch (error) {
      console.warn("Document classification failed", error);
    } finally {
      setClassifying(false);
      setClassifyProgress(undefined);
      classifyAbortRef.current = null;
    }
  }, [classifying, fileClassificationRepoRef, runtime]);

  const handleCancelClassify = useCallback(() => {
    classifyAbortRef.current?.abort();
  }, []);

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
    scanning,
    classifying,
    classifyProgress,
    mountRoots,
    categoryStats,
    handleRefreshApps,
    handleRefreshDocuments,
    handleRefreshImages,
    handleNavigateDirectory,
    handleListDirectory,
    handleRefreshScan,
    handleClassifyDocuments,
    handleCancelClassify,
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
