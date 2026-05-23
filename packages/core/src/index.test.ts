import { describe, expect, it, vi } from "vitest";
import { createFileScanTaskRuntime, createInitialTaskSnapshot } from "./index";
import type {
  FileOrganizationExecution,
  FileOrganizationPlan,
  MarkdownDocument,
  PlannedPathOperation,
  ProjectInspection,
  ShellCommandOutput,
  ShellCommandRequest,
  WebSource,
} from "@javis/tools";
import type { TaskSnapshot } from "./index";

function subscribeToRuntime(runtime: ReturnType<typeof createFileScanTaskRuntime>) {
  const snapshots: TaskSnapshot[] = [];
  const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
  return { snapshots, unsubscribe };
}

async function waitForStatus(
  snapshots: TaskSnapshot[],
  status: TaskSnapshot["status"],
): Promise<TaskSnapshot> {
  await vi.waitFor(() => {
    expect(snapshots[snapshots.length - 1]?.status).toBe(status);
  });
  return snapshots[snapshots.length - 1] as TaskSnapshot;
}

describe("createFileScanTaskRuntime", () => {
  it("creates a consistent idle snapshot for all built-in agents", () => {
    const snapshot = createInitialTaskSnapshot();

    expect(snapshot.status).toBe("created");
    expect(snapshot.agents.map((agent) => agent.id)).toEqual([
      "agent-commander",
      "agent-file",
      "agent-shell",
      "agent-research",
      "agent-verifier",
    ]);
    expect(snapshot.agents.every((agent) => agent.status === "queued")).toBe(true);
  });

  it("routes project inspection goals through the project and shell tools", async () => {
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "typecheck", command: "pnpm -r typecheck" }],
      recommendedStartCommand: undefined,
      recommendedTestCommand: "pnpm typecheck",
    };
    const commands: ShellCommandOutput[] = [];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => {
          const output = {
            command: [request.program, ...request.args].join(" "),
            cwd: "E:/Javis",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          };
          commands.push(output);
          return output;
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test project environment");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.project).toEqual(project);
    expect(commands.map((command) => command.command)).toContain("pnpm typecheck");
    expect(finalSnapshot.verificationSummary).toContain("verified");

    unsubscribe();
    runtime.dispose();
  });

  it("marks project inspection failed when an allowlisted check fails", async () => {
    const project: ProjectInspection = {
      workspacePath: "E:/Javis",
      packageManager: "pnpm",
      scripts: [{ name: "typecheck", command: "pnpm -r typecheck" }],
      recommendedStartCommand: undefined,
      recommendedTestCommand: "pnpm typecheck",
    };
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      projectTool: {
        inspectProject: vi.fn(async () => project),
      },
      shellTool: {
        runReadOnlyCommand: vi.fn(async (request: ShellCommandRequest) => ({
          command: [request.program, ...request.args].join(" "),
          cwd: "E:/Javis",
          exitCode: request.program === "pnpm" && request.args[0] === "typecheck" ? 1 : 0,
          stdout: "",
          stderr: request.program === "pnpm" && request.args[0] === "typecheck" ? "failed" : "",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("test project environment");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Project environment check failed");
    expect(finalSnapshot.verificationSummary).toContain("failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.title).toBe("verification.failed");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps denied PDF organization permissions as a no-op", async () => {
    const executePdfOrganization = vi.fn(async () => createExecution([]));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => createPdfPlan(),
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("denied");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).not.toHaveBeenCalled();
    expect(finalSnapshot.permissionRequest?.status).toBe("denied");
    expect(finalSnapshot.verificationSummary).toContain("no write operation was executed");

    unsubscribe();
    runtime.dispose();
  });

  it("executes exactly the approved PDF dry-run operations", async () => {
    const plan = createPdfPlan();
    const executePdfOrganization = vi.fn(async (operations: PlannedPathOperation[]) =>
      createExecution(operations),
    );
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => plan,
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).toHaveBeenCalledWith(
      plan.dryRun.affectedPaths,
      plan.approvalId,
    );
    expect(finalSnapshot.fileOrganizationExecution?.movedCount).toBe(1);
    expect(finalSnapshot.permissionRequest?.status).toBe("approved");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved PDF organization failed when execution reports failures", async () => {
    const plan = createPdfPlan();
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => plan,
        executePdfOrganization: vi.fn(async (operations: PlannedPathOperation[]) => ({
          attemptedCount: operations.length,
          movedCount: 0,
          skippedCount: 0,
          failedCount: operations.length,
          results: operations.map((operation) => ({
            source: operation.source,
            target: operation.target,
            status: "failed" as const,
            message: "Move failed in test.",
          })),
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization completed with failures");
    expect(finalSnapshot.fileOrganizationExecution?.failedCount).toBe(1);
    expect(finalSnapshot.verificationSummary).toContain("failed");

    unsubscribe();
    runtime.dispose();
  });

  it("falls back to document scan for general local file goals", async () => {
    const documents: MarkdownDocument[] = [
      {
        path: "E:/Javis/README.md",
        modifiedAt: "1000",
        sizeBytes: 42,
        heading: "Javis",
        excerpt: "Project README",
      },
    ];
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => documents),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.documents).toHaveLength(1);
    expect(finalSnapshot.documents?.[0]?.purpose).toBe("Project or module entry document.");
    expect(finalSnapshot.verificationSummary).toContain("verified");

    unsubscribe();
    runtime.dispose();
  });

  it("marks document scan failed when the file tool rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: vi.fn(async () => {
          throw new Error("scan failed");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Find Markdown documents");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Document scan failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("scan failed");

    unsubscribe();
    runtime.dispose();
  });

  it("completes PDF organization as a no-op when no PDFs are found", async () => {
    const executePdfOrganization = vi.fn(async () => createExecution([]));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => ({
          approvalId: "approval-empty",
          directoryPath: "C:/Users/example/Downloads",
          fileCount: 0,
          dryRun: {
            operation: "Organize PDF files by filename topic",
            affectedPaths: [],
            riskSummary: "Preview only.",
            reversible: true,
          },
        }),
        executePdfOrganization,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(executePdfOrganization).not.toHaveBeenCalled();
    expect(finalSnapshot.fileOrganizationPlan?.fileCount).toBe(0);
    expect(finalSnapshot.verificationSummary).toContain("no PDF files were found");

    unsubscribe();
    runtime.dispose();
  });

  it("marks PDF preview failed when the dry-run tool rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: vi.fn(async () => {
          throw new Error("preview failed");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization preview failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("preview failed");

    unsubscribe();
    runtime.dispose();
  });

  it("marks approved PDF organization failed when execution tool is missing", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
        planPdfOrganization: async () => createPdfPlan(),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Organize PDFs in Downloads");
    await waitForStatus(snapshots, "waiting_permission");
    runtime.resolvePermission("approved");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("PDF organization execution unavailable");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe(
      "file.executePdfOrganization is not configured.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("builds source-backed reports for user-provided research URLs", async () => {
    const sources: Record<string, WebSource> = {
      "https://example.test/alpha": {
        url: "https://example.test/alpha",
        title: "Alpha source",
        excerpt: "Alpha evidence excerpt.",
        fetchedAt: "2026-05-23T00:00:00.000Z",
      },
      "https://example.test/beta": {
        url: "https://example.test/beta",
        title: "Beta source",
        excerpt: "Beta evidence excerpt.",
        fetchedAt: "2026-05-23T00:00:00.000Z",
      },
    };
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => sources[url] as WebSource);
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/alpha and https://example.test/beta");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(fetchWebSource).toHaveBeenCalledTimes(2);
    expect(finalSnapshot.researchReport?.rows).toHaveLength(2);
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "Only 2 source(s) were provided; the MVP scenario expects at least 3 for a full comparison report.",
    );
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "No search provider was used because source URLs were provided directly.",
    );
    expect(finalSnapshot.verificationSummary).toContain("report claims include source evidence");

    unsubscribe();
    runtime.dispose();
  });

  it("builds source-backed reports from configured search results", async () => {
    const sourceUrls = [
      "https://example.test/alpha",
      "https://example.test/beta",
      "https://example.test/gamma",
    ];
    const searchWeb = vi.fn(async () =>
      sourceUrls.map((url, index) => ({
        url,
        title: `Search result ${index + 1}`,
        excerpt: `Search excerpt ${index + 1}.`,
        fetchedAt: "2026-05-23T00:00:00.000Z",
        provider: "test-search",
      })),
    );
    const fetchWebSource = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: `Fetched ${url}`,
      excerpt: `Fetched evidence for ${url}.`,
      fetchedAt: "2026-05-23T00:00:00.000Z",
    }));
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
        searchWeb,
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research Javis search integration");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(searchWeb).toHaveBeenCalledWith({
      query: "Research Javis search integration",
      maxResults: 3,
    });
    expect(fetchWebSource).toHaveBeenCalledTimes(3);
    expect(finalSnapshot.researchReport?.rows).toHaveLength(3);
    expect(finalSnapshot.researchReport?.summary).toContain("via test-search");
    expect(finalSnapshot.researchReport?.unknowns).not.toContain(
      "Automated public web search is not integrated yet; add URLs manually for broader coverage.",
    );
    expect(finalSnapshot.sources?.map((source) => source.provider)).toEqual([
      "test-search",
      "test-search",
      "test-search",
    ]);
    expect(finalSnapshot.verificationSummary).toContain("searched sources include URL and excerpt");

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when no sources are found", async () => {
    const fetchWebSource = vi.fn(async () => {
      throw new Error("fetch should not run");
    });
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource,
        searchWeb: vi.fn(async () => []),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research a topic with no public sources");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research search returned no sources");
    expect(fetchWebSource).not.toHaveBeenCalled();
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toContain("0 source");

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when the search provider rejects", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          excerpt: "unused",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
        searchWeb: vi.fn(async () => {
          throw new Error("search unavailable");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Search for public sources about Javis");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research search failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("search unavailable");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps successful searched sources when one fetch fails", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/alpha",
            title: "Alpha",
            excerpt: "Alpha candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "github-cli",
          },
          {
            url: "https://example.test/missing",
            title: "Missing",
            excerpt: "Missing candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "github-cli",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => {
          if (url.includes("missing")) {
            throw new Error("source unavailable");
          }
          return {
            url,
            title: "Alpha source",
            excerpt: "Alpha fetched evidence.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
          };
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research partial source failures");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.sources).toHaveLength(1);
    expect(finalSnapshot.sources?.[0]?.provider).toBe("github-cli");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 searched source candidate(s) could not be fetched.",
    );
    expect(finalSnapshot.logs.some((log) => log.title.includes("web.fetchSource failed"))).toBe(true);
    expect(finalSnapshot.verificationSummary).toContain("1 searched source fetch(es) failed");

    unsubscribe();
    runtime.dispose();
  });

  it("keeps fetched provider metadata when search candidates omit provider", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/alpha",
            title: "Alpha",
            excerpt: "Alpha candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Alpha source",
          excerpt: "Alpha fetched evidence.",
          fetchedAt: "2026-05-23T00:00:00.000Z",
          provider: "agent-chrome",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research provider fallback");

    const finalSnapshot = await waitForStatus(snapshots, "completed");

    expect(finalSnapshot.sources?.[0]?.provider).toBe("agent-chrome");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "Only 1 source(s) were fetched from search results; product research expects at least 3 for a full comparison report.",
    );

    unsubscribe();
    runtime.dispose();
  });

  it("marks search-backed research failed when searched sources lack excerpt evidence", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        searchWeb: vi.fn(async () => [
          {
            url: "https://example.test/weak",
            title: "Weak",
            excerpt: "Weak candidate.",
            fetchedAt: "2026-05-23T00:00:00.000Z",
            provider: "agent-chrome",
          },
        ]),
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Weak source",
          excerpt: "",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Research weak searched sources");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source verification failed");
    expect(finalSnapshot.sources?.[0]?.provider).toBe("agent-chrome");
    expect(finalSnapshot.researchReport?.summary).toContain("via agent-chrome");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 source(s) did not return enough text evidence.",
    );
    expect(finalSnapshot.verificationSummary).toContain("failed: 0/1 searched sources");

    unsubscribe();
    runtime.dispose();
  });

  it("marks research source collection failed when a provided URL cannot be fetched", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async () => {
          throw new Error("source unavailable");
        }),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/missing");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source collection failed");
    expect(finalSnapshot.logs[finalSnapshot.logs.length - 1]?.detail).toBe("source unavailable");

    unsubscribe();
    runtime.dispose();
  });

  it("marks research verification failed when fetched sources lack excerpt evidence", async () => {
    const runtime = createFileScanTaskRuntime({
      delayMs: 0,
      fileTool: {
        scanMarkdownDocuments: async () => [],
      },
      webTool: {
        fetchWebSource: vi.fn(async ({ url }: { url: string }) => ({
          url,
          title: "Weak source",
          excerpt: "",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        })),
      },
    });
    const { snapshots, unsubscribe } = subscribeToRuntime(runtime);

    runtime.start("Compare https://example.test/weak");

    const finalSnapshot = await waitForStatus(snapshots, "failed");

    expect(finalSnapshot.title).toBe("Research source verification failed");
    expect(finalSnapshot.researchReport?.unknowns).toContain(
      "1 source(s) did not return enough text evidence.",
    );
    expect(finalSnapshot.verificationSummary).toContain("failed: 0/1 sources");

    unsubscribe();
    runtime.dispose();
  });
});

function createPdfPlan(): FileOrganizationPlan {
  return {
    approvalId: "approval-1",
    directoryPath: "C:/Users/example/Downloads",
    fileCount: 1,
    dryRun: {
      operation: "Organize PDF files by filename topic",
      affectedPaths: [
        {
          source: "C:/Users/example/Downloads/paper.pdf",
          target: "C:/Users/example/Downloads/Research/paper.pdf",
          action: "move",
        },
      ],
      riskSummary: "Preview only.",
      reversible: true,
    },
  };
}

function createExecution(operations: PlannedPathOperation[]): FileOrganizationExecution {
  return {
    attemptedCount: operations.length,
    movedCount: operations.length,
    skippedCount: 0,
    failedCount: 0,
    results: operations.map((operation) => ({
      source: operation.source,
      target: operation.target,
      status: "moved",
      message: "Moved in test.",
    })),
  };
}
