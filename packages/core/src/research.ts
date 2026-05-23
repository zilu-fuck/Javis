import type { ResearchReport, WebSource } from "@javis/tools";

export function createSourceBackedReport(sources: WebSource[]): ResearchReport {
  const rows = sources.map((source) => ({
    claim: `${source.title ?? source.url} is available as a public source for this task.`,
    sourceUrl: source.url,
    evidence: source.excerpt.slice(0, 220),
  }));

  const missingEvidenceCount = rows.filter((row) => !row.evidence).length;

  return {
    title: "Source-backed research report",
    summary:
      rows.length > 0
        ? `Collected ${rows.length} public source(s). Claims below are limited to fetched source excerpts.`
        : "No public source was collected, so no claims are verified.",
    rows,
    unknowns:
      [
        ...(missingEvidenceCount > 0
          ? [`${missingEvidenceCount} source(s) did not return enough text evidence.`]
          : []),
        ...(rows.length < 3
          ? [`Only ${rows.length} source(s) were provided; the MVP scenario expects at least 3 for a full comparison report.`]
          : []),
        "Automated public web search is not integrated yet; add URLs manually for broader coverage.",
      ],
  };
}
