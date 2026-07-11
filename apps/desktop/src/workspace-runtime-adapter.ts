import type {
  WorkspaceDiff,
  WorkspaceExecutionRequest,
  WorkspaceExecutionResult,
  WorkspaceFileEntry,
  WorkspaceRuntime,
  WorkspaceSnapshot,
} from "@javis/core";
import {
  assertWorkspaceRuntimeCanWrite,
  createWorkspaceSnapshot,
} from "@javis/core";
import {
  createTempWorkspace,
  diffTempWorkspace,
  finalizeTempWorkspace,
  type TempWorkspaceSandbox,
} from "./temp-workspace-sandbox";
import { listDirectory, readFileChunk } from "./local-knowledge";

export interface LocalReadOnlyWorkspaceOptions {
  root: string | (() => string);
  readTextFile?: (path: string, root: string) => Promise<string>;
  listDirectory?: (path: string) => Promise<WorkspaceFileEntry[]>;
  executeReadOnly?: (request: WorkspaceExecutionRequest & { workspacePath: string }) => Promise<WorkspaceExecutionResult>;
}

export class LocalReadOnlyWorkspace implements WorkspaceRuntime {
  readonly kind = "local" as const;
  private readonly rootProvider: () => string;
  private readonly readTextFileImpl: NonNullable<LocalReadOnlyWorkspaceOptions["readTextFile"]>;
  private readonly listDirectoryImpl: NonNullable<LocalReadOnlyWorkspaceOptions["listDirectory"]>;
  private readonly executeReadOnlyImpl: LocalReadOnlyWorkspaceOptions["executeReadOnly"];

  constructor(options: LocalReadOnlyWorkspaceOptions) {
    const root = options.root;
    this.rootProvider = typeof root === "function"
      ? root
      : () => root;
    this.readTextFileImpl = options.readTextFile ?? ((path, root) =>
      readFileChunk(path, undefined, { workspaceRoot: root }));
    this.listDirectoryImpl = options.listDirectory ?? listDirectory;
    this.executeReadOnlyImpl = options.executeReadOnly;
  }

  get root(): string {
    return this.rootProvider();
  }

  async readFile(path: string): Promise<Uint8Array> {
    const text = await this.readTextFileImpl(path, this.root);
    return new TextEncoder().encode(text);
  }

  async listFiles(path = this.root): Promise<WorkspaceFileEntry[]> {
    return this.listDirectoryImpl(path);
  }

  async execute(request: WorkspaceExecutionRequest): Promise<WorkspaceExecutionResult> {
    if (request.permissionLevel && request.permissionLevel !== "read") {
      assertWorkspaceRuntimeCanWrite(this);
    }
    if (!this.executeReadOnlyImpl) {
      throw new Error("LocalReadOnlyWorkspace execute requires a read-only shell adapter.");
    }
    return this.executeReadOnlyImpl({
      ...request,
      permissionLevel: "read",
      workspacePath: request.cwd ?? this.root,
    });
  }

  async createSnapshot(): Promise<WorkspaceSnapshot> {
    return createWorkspaceSnapshot({
      runtimeKind: this.kind,
      root: this.root,
    });
  }

  async diff(_snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff> {
    return {
      root: this.root,
      changedFiles: [],
      unifiedDiff: "",
    };
  }

  async dispose(): Promise<void> {
    // Local read-only runtime owns no disposable resources.
  }
}

export interface DisposableCopyWorkspaceOptions {
  realWorkspaceRoot: string;
  taskId: string;
  sandbox?: TempWorkspaceSandbox;
  readTextFile?: LocalReadOnlyWorkspaceOptions["readTextFile"];
  listDirectory?: LocalReadOnlyWorkspaceOptions["listDirectory"];
  execute?: LocalReadOnlyWorkspaceOptions["executeReadOnly"];
}

export class WindowsSandboxWorkspace implements WorkspaceRuntime {
  readonly kind = "sandbox" as const;
  readonly root: string;
  private readonly realWorkspaceRoot: string;
  private readonly sandboxRoot: string;
  private readonly readTextFileImpl: NonNullable<LocalReadOnlyWorkspaceOptions["readTextFile"]>;
  private readonly listDirectoryImpl: NonNullable<LocalReadOnlyWorkspaceOptions["listDirectory"]>;
  private readonly executeImpl: LocalReadOnlyWorkspaceOptions["executeReadOnly"];
  private disposed = false;

  private constructor(options: {
    realWorkspaceRoot: string;
    sandboxRoot: string;
    readTextFile?: LocalReadOnlyWorkspaceOptions["readTextFile"];
    listDirectory?: LocalReadOnlyWorkspaceOptions["listDirectory"];
    execute?: LocalReadOnlyWorkspaceOptions["executeReadOnly"];
  }) {
    this.realWorkspaceRoot = options.realWorkspaceRoot;
    this.sandboxRoot = options.sandboxRoot;
    this.root = options.sandboxRoot;
    this.readTextFileImpl = options.readTextFile ?? ((path, root) =>
      readFileChunk(path, undefined, { workspaceRoot: root }));
    this.listDirectoryImpl = options.listDirectory ?? listDirectory;
    this.executeImpl = options.execute;
  }

  static async create(options: DisposableCopyWorkspaceOptions): Promise<WindowsSandboxWorkspace> {
    const sandbox = options.sandbox ?? await createTempWorkspace(
      options.realWorkspaceRoot,
      options.taskId,
    );
    return new WindowsSandboxWorkspace({
      realWorkspaceRoot: sandbox.realWorkspaceRoot,
      sandboxRoot: sandbox.sandboxRoot,
      readTextFile: options.readTextFile,
      listDirectory: options.listDirectory,
      execute: options.execute,
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertNotDisposed();
    const text = await this.readTextFileImpl(path, this.sandboxRoot);
    return new TextEncoder().encode(text);
  }

  async listFiles(path = this.sandboxRoot): Promise<WorkspaceFileEntry[]> {
    this.assertNotDisposed();
    return this.listDirectoryImpl(path);
  }

  async execute(request: WorkspaceExecutionRequest): Promise<WorkspaceExecutionResult> {
    this.assertNotDisposed();
    if (!this.executeImpl) {
      throw new Error("WindowsSandboxWorkspace execute requires a sandbox command adapter.");
    }
    return this.executeImpl({
      ...request,
      cwd: request.cwd ?? this.sandboxRoot,
      workspacePath: request.cwd ?? this.sandboxRoot,
    });
  }

  async createSnapshot(): Promise<WorkspaceSnapshot> {
    this.assertNotDisposed();
    return createWorkspaceSnapshot({
      runtimeKind: this.kind,
      root: this.root,
    });
  }

  async diff(_snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff> {
    this.assertNotDisposed();
    const diff = await diffTempWorkspace(this.realWorkspaceRoot, this.sandboxRoot);
    return {
      root: diff.realWorkspaceRoot,
      changedFiles: diff.changedFiles.map((file) => ({
        path: file.path,
        change: file.change,
        textDiff: file.textDiff,
      })),
      unifiedDiff: diff.unifiedDiff,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await finalizeTempWorkspace(this.realWorkspaceRoot, this.sandboxRoot, "delete");
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WindowsSandboxWorkspace has been disposed.");
    }
  }
}

export const DisposableCopyWorkspace = WindowsSandboxWorkspace;

export function assertDesktopWorkspaceRuntimeWriteBoundary(
  runtime: Pick<WorkspaceRuntime, "kind">,
): void {
  assertWorkspaceRuntimeCanWrite(runtime);
}

export async function createDesktopWorkspaceRuntime(input: {
  kind: "local" | "sandbox";
  root: string;
  taskId?: string;
  executeReadOnly?: LocalReadOnlyWorkspaceOptions["executeReadOnly"];
  readTextFile?: LocalReadOnlyWorkspaceOptions["readTextFile"];
  listDirectory?: LocalReadOnlyWorkspaceOptions["listDirectory"];
}): Promise<LocalReadOnlyWorkspace | WindowsSandboxWorkspace> {
  if (input.kind === "local") {
    return new LocalReadOnlyWorkspace({
      root: input.root,
      executeReadOnly: input.executeReadOnly,
      readTextFile: input.readTextFile,
      listDirectory: input.listDirectory,
    });
  }
  if (!input.taskId) {
    throw new Error("WindowsSandboxWorkspace requires a taskId.");
  }
  return WindowsSandboxWorkspace.create({
    realWorkspaceRoot: input.root,
    taskId: input.taskId,
    execute: input.executeReadOnly,
    readTextFile: input.readTextFile,
    listDirectory: input.listDirectory,
  });
}
