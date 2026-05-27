import type { CommanderTool, WebSource, WebTool } from "@javis/tools";
import type { FlowController } from "./flow-controller";
import type { ID, TaskSnapshot } from "./index";
import { createResearchSearchPlan, createResearchSourcePlan, markStep } from "./plans";
import { createSourceBackedReport } from "./research";
import { extractUrls } from "./routing";
import { appendLog } from "./snapshot-utils";
import { createEmptyTokenUsageSummary } from "./token-usage";
import { createScopedAgentTracker, setTrackedAgentStates } from "./flow-agent-utils";
import { safeSynthesizeConclusion } from "./workflow-executor";

interface ResearchFlowOptions {
  controller: FlowController;
  taskId: ID;
  userGoal: string;
  webTool: WebTool;
  commanderTool?: CommanderTool;
}

export async function runResearchSearchTask({
  controller,
  taskId,
  userGoal,
  webTool,
  commanderTool,
}: ResearchFlowOptions) {
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }
  const wait = controller.wait;
  const plan = createResearchSearchPlan();
  const agentTracker = createScopedAgentTracker(["commander", "research", "verifier"]);

  emit({
    id: taskId,
    title: "Searching research sources",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander identified a research goal and prepared read-only public source search.",
    plan,
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "planning", task: "Create research source plan" },
      { agentId: "agent-research", status: "queued", task: "Waiting for public source search" },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for source evidence" },
    ]),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the search-backed research goal to Core.",
      },
    ],
  });

  await wait();

  emit({
    ...snapshot,
    status: "running",
    commanderMessage:
      "Research Agent is asking the configured search provider for public source candidates.",
    plan: markStep(snapshot.plan, "step-search-sources", "running"),
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
      { agentId: "agent-research", status: "running", task: "Searching public sources" },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
    ]),
    logs: appendLog(snapshot, {
      id: `${taskId}-search-started`,
      kind: "tool",
      title: "tool_call.planned",
      detail: "web.search uses read permission and returns public source candidates.",
    }),
  });

  try {
    const searchResults = await webTool.searchWeb?.({
      query: userGoal,
      maxResults: 3,
    });
    if (!searchResults || searchResults.length === 0) {
      emit({
        ...snapshot,
        title: "Research search returned no sources",
        status: "failed",
        commanderMessage:
          "The configured search provider did not return source candidates. Add source URLs manually or try a narrower query.",
        plan: markStep(snapshot.plan, "step-search-sources", "failed"),
        agents: setTrackedAgentStates(agentTracker, [
          { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
          { agentId: "agent-research", status: "failed", task: "No search results" },
          { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
        ]),
        logs: appendLog(snapshot, {
          id: `${taskId}-search-empty`,
          kind: "tool",
          title: "task.failed",
          detail: "web.search returned 0 source candidate(s).",
        }),
      });
      return;
    }

    const selectedResults = Array.from(
      new Map(searchResults.map((result) => [result.url, result])).values(),
    ).slice(0, 3);
    const urls = selectedResults.map((result) => result.url);
    const providerByUrl = new Map(
      selectedResults.map((result) => [result.url, result.provider]),
    );

    emit({
      ...snapshot,
      title: "Fetching search result sources",
      commanderMessage:
        "Research Agent found source candidates and is fetching the selected URLs for evidence.",
      plan: markStep(snapshot.plan, "step-search-sources", "completed", "step-fetch-sources", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-research", status: "running", task: `Fetching ${urls.length} selected source(s)` },
        { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
      ]),
      sources: searchResults,
      logs: appendLog(snapshot, {
        id: `${taskId}-search-done`,
        kind: "tool",
        title: "tool_call.updated",
        detail: `web.search returned ${searchResults.length} source candidate(s) from ${summarizeSearchProviders(searchResults)}.`,
      }),
    });

    const fetchResults = await Promise.allSettled<WebSource>(
      urls.map(async (url) => {
        const source = await webTool.fetchWebSource({ url });
        return {
          ...source,
          provider: providerByUrl.get(url) ?? source.provider,
        };
      }),
    );
    const sources = fetchResults
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failedFetches = fetchResults
      .map((result, index) => ({ result, url: urls[index] }))
      .filter((entry): entry is { result: PromiseRejectedResult; url: string } => entry.result.status === "rejected");
    if (sources.length === 0) {
      throw new Error(
        `Search found ${urls.length} candidate source(s), but none could be fetched.`,
      );
    }
    const providerSummary = summarizeSearchProviders(selectedResults);
    const researchReport = createSourceBackedReport(sources, {
      failedFetchCount: failedFetches.length,
      providerSummary,
      sourceMode: "search",
    });

    emit({
      ...snapshot,
      title: "Drafting source-backed report",
      status: "verifying",
      commanderMessage:
        "Research Agent collected searched sources. Verifier is checking that every source has a URL and excerpt.",
      plan: markStep(snapshot.plan, "step-fetch-sources", "completed", "step-verify-sources", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Waiting for verification" },
        { agentId: "agent-research", status: "completed", task: `Fetched ${sources.length} source(s)` },
        { agentId: "agent-verifier", status: "verifying", task: "Checking source evidence" },
      ]),
      sources,
      researchReport,
      logs: [
        ...appendLog(snapshot, {
          id: `${taskId}-sources-done`,
          kind: "tool",
          title: "tool_call.updated",
          detail: `web.fetchSource completed for ${sources.length}/${urls.length} searched source(s).`,
        }),
        ...failedFetches.map((entry, index) => ({
          id: `${taskId}-source-fetch-failed-${index}`,
          kind: "tool" as const,
          title: `web.fetchSource failed: ${entry.url}`,
          detail: entry.result.reason instanceof Error
            ? entry.result.reason.message
            : String(entry.result.reason),
        })),
      ],
    });

    await wait();

    const validCount = sources.filter((source) => source.url && source.excerpt).length;
    const reportEvidenceCount = researchReport.rows.filter(
      (row) => row.sourceUrl && row.evidence,
    ).length;
    const verificationStatus =
      validCount === sources.length && reportEvidenceCount === researchReport.rows.length
        ? "completed"
        : "failed";
    const synthesis = verificationStatus === "completed"
      ? await safeSynthesizeConclusion(commanderTool, userGoal, "Research sources collected", {
          sources,
          researchReport,
          validSources: validCount,
          failedFetches: failedFetches.length,
          providerSummary,
        })
      : undefined;
    emit({
      ...snapshot,
      title:
        verificationStatus === "completed"
          ? "Research sources collected"
          : "Research source verification failed",
      status: verificationStatus,
      commanderMessage: synthesis?.message
        ?? (verificationStatus === "completed"
          ? "Research Agent produced a source-backed report from searched public sources."
          : "Research Agent fetched searched sources, but Verifier found missing source evidence."),
      plan:
        verificationStatus === "completed"
          ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
          : markStep(snapshot.plan, "step-verify-sources", "failed"),
      agents: setTrackedAgentStates(agentTracker, [
        {
          agentId: "agent-commander",
          status: verificationStatus === "completed" ? "completed" : "failed",
          task: verificationStatus === "completed" ? "Task finished" : "Verification failed",
        },
        { agentId: "agent-research", status: "completed", task: "Source collection completed" },
        {
          agentId: "agent-verifier",
          status: verificationStatus === "completed" ? "completed" : "failed",
          task: `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
        },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-done`,
        kind: "verification",
        title:
          verificationStatus === "completed" ? "task.completed" : "verification.failed",
        detail: `Verifier checked ${validCount}/${sources.length} source records and ${reportEvidenceCount}/${researchReport.rows.length} report claims.`,
      }),
      researchReport: snapshot.researchReport,
      verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${sources.length} searched sources include URL and excerpt; ${reportEvidenceCount}/${researchReport.rows.length} report claims include source evidence; ${failedFetches.length} searched source fetch(es) failed.`,
    });
  } catch (error) {
    emit({
      ...snapshot,
      title: "Research search failed",
      status: "failed",
      commanderMessage:
        "Research Agent could not complete search-backed source collection. Add source URLs manually as a fallback.",
      plan: markStep(snapshot.plan, "step-search-sources", "failed"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-research", status: "failed", task: "Source search failed" },
        { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

export async function runResearchSourceTask({
  controller,
  taskId,
  userGoal,
  webTool,
  commanderTool,
}: ResearchFlowOptions) {
  let snapshot = controller.getSnapshot();
  function emit(nextSnapshot: TaskSnapshot) {
    controller.emit(nextSnapshot);
    snapshot = controller.getSnapshot();
  }
  const wait = controller.wait;
  const urls = extractUrls(userGoal);
  const plan = createResearchSourcePlan();
  const agentTracker = createScopedAgentTracker(["commander", "research", "verifier"]);

  emit({
    id: taskId,
    title: "Collecting research sources",
    userGoal,
    status: "planning",
    commanderMessage:
      "Commander found user-provided URLs and prepared read-only source collection.",
    plan,
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "planning", task: "Create research source plan" },
      { agentId: "agent-research", status: "queued", task: `Waiting to fetch ${urls.length} source(s)` },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for source evidence" },
    ]),
    tokenUsage: createEmptyTokenUsageSummary(),
    logs: [
      {
        id: `${taskId}-created`,
        kind: "event",
        title: "task.created",
        detail: "Desktop UI passed the research goal to Core.",
      },
    ],
  });

  await wait();

  emit({
    ...snapshot,
    status: "running",
    commanderMessage: "Research Agent is fetching public sources provided by the user.",
    plan: markStep(snapshot.plan, "step-fetch-sources", "running"),
    agents: setTrackedAgentStates(agentTracker, [
      { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
      { agentId: "agent-research", status: "running", task: "Fetching public URL sources" },
      { agentId: "agent-verifier", status: "queued", task: "Waiting for sources" },
    ]),
    logs: appendLog(snapshot, {
      id: `${taskId}-sources-started`,
      kind: "tool",
      title: "tool_call.planned",
      detail: `Fetching ${urls.length} URL(s) with read permission.`,
    }),
  });

  try {
    const sources = await Promise.all(
      urls.map((url) => webTool.fetchWebSource({ url })),
    );
    const researchReport = createSourceBackedReport(sources, {
      sourceMode: "manual",
    });

    emit({
      ...snapshot,
      title: "Drafting source-backed report",
      status: "verifying",
      commanderMessage:
        "Research Agent collected sources. Verifier is checking that every source has a URL and excerpt.",
      plan: markStep(snapshot.plan, "step-fetch-sources", "completed", "step-verify-sources", "running"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Waiting for verification" },
        { agentId: "agent-research", status: "completed", task: `Fetched ${sources.length} source(s)` },
        { agentId: "agent-verifier", status: "verifying", task: "Checking source evidence" },
      ]),
      sources,
      researchReport,
      logs: appendLog(snapshot, {
        id: `${taskId}-sources-done`,
        kind: "tool",
        title: "tool_call.updated",
        detail: `web.fetchSource completed for ${sources.length} source(s).`,
      }),
    });

    await wait();

    const validCount = sources.filter((source) => source.url && source.excerpt).length;
    const reportEvidenceCount = researchReport.rows.filter(
      (row) => row.sourceUrl && row.evidence,
    ).length;
    const verificationStatus =
      validCount === sources.length && reportEvidenceCount === researchReport.rows.length
        ? "completed"
        : "failed";
    const synthesis = verificationStatus === "completed"
      ? await safeSynthesizeConclusion(commanderTool, userGoal, "Research sources collected", {
          sources,
          researchReport,
          validSources: validCount,
          sourceMode: "manual",
        })
      : undefined;
    emit({
      ...snapshot,
      title:
        verificationStatus === "completed"
          ? "Research sources collected"
          : "Research source verification failed",
      status: verificationStatus,
      commanderMessage: synthesis?.message
        ?? (verificationStatus === "completed"
          ? "Research Agent produced a source-backed report from user-provided URLs. Search-backed source discovery is available for research goals without URLs."
          : "Research Agent fetched the provided URLs, but Verifier found missing source evidence."),
      plan:
        verificationStatus === "completed"
          ? snapshot.plan.map((step) => ({ ...step, status: "completed" }))
          : markStep(snapshot.plan, "step-verify-sources", "failed"),
      agents: setTrackedAgentStates(agentTracker, [
        {
          agentId: "agent-commander",
          status: verificationStatus === "completed" ? "completed" : "failed",
          task: verificationStatus === "completed" ? "Task finished" : "Verification failed",
        },
        { agentId: "agent-research", status: "completed", task: "Source collection completed" },
        {
          agentId: "agent-verifier",
          status: verificationStatus === "completed" ? "completed" : "failed",
          task: `${reportEvidenceCount}/${researchReport.rows.length} claims verified`,
        },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-done`,
        kind: "verification",
        title:
          verificationStatus === "completed" ? "task.completed" : "verification.failed",
        detail: `Verifier checked ${validCount}/${sources.length} source records and ${reportEvidenceCount}/${researchReport.rows.length} report claims.`,
      }),
      researchReport: snapshot.researchReport,
      verificationSummary: `${verificationStatus === "completed" ? "verified" : "failed"}: ${validCount}/${sources.length} sources include URL and excerpt; ${reportEvidenceCount}/${researchReport.rows.length} report claims include source evidence.`,
    });
  } catch (error) {
    emit({
      ...snapshot,
      title: "Research source collection failed",
      status: "failed",
      commanderMessage:
        "Research Agent could not fetch the provided source. Add alternate URLs manually or try a search-backed research goal.",
      plan: markStep(snapshot.plan, "step-fetch-sources", "failed"),
      agents: setTrackedAgentStates(agentTracker, [
        { agentId: "agent-commander", status: "completed", task: "Plan submitted" },
        { agentId: "agent-research", status: "failed", task: "Source fetch failed" },
        { agentId: "agent-verifier", status: "cancelled", task: "No source to verify" },
      ]),
      logs: appendLog(snapshot, {
        id: `${taskId}-failed`,
        kind: "tool",
        title: "task.failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

function summarizeSearchProviders(sources: WebSource[]): string {
  const providers = Array.from(
    new Set(sources.map((source) => source.provider).filter(Boolean)),
  );
  return providers.length > 0 ? providers.join(", ") : "unknown provider";
}
