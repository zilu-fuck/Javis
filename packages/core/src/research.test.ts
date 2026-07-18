import { describe, expect, it } from "vitest";
import {
  createSourceBackedReport,
  isClaimSupportedByExcerpt,
  validateSourceEvidence,
  verifySourceCollection,
  verifySourceBackedReport,
  verifyTrendHotListResearchReport,
} from "./research";

describe("createSourceBackedReport", () => {
  it("marks claims without URL-backed excerpts as unknown", () => {
    const report = createSourceBackedReport([
      {
        url: "https://example.com/verified",
        title: "Verified source",
        excerpt: "Evidence from the fetched page.",
        fetchedAt: "2026-06-09T00:00:00.000Z",
        provider: "fixture",
      },
      {
        url: "https://example.com/empty",
        title: "Empty source",
        excerpt: "",
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
    ]);

    expect(report.summary).toContain("1 claim(s) tied to URL-backed excerpts");
    expect(report.rows[0]).toMatchObject({
      status: "verified",
      excerpt: "Evidence from the fetched page.",
      verificationStatus: "verified",
      sourceProvider: "fixture",
    });
    expect(report.rows[1]).toMatchObject({
      status: "unknown",
      excerpt: "",
      verificationStatus: "unknown",
      evidence: "",
    });
    expect(report.rows[1]?.claim).toContain("could not be verified");
  });

  it("fails closed for whitespace, short, and placeholder excerpts", () => {
    const report = createSourceBackedReport([
      {
        url: "https://example.com/whitespace",
        title: "Whitespace source",
        excerpt: " \t\n ",
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
      {
        url: "https://example.com/short",
        title: "Short source",
        excerpt: "too short",
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
      {
        url: "https://example.com/placeholder",
        title: "Placeholder source",
        excerpt: "unknown",
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
    ]);

    expect(report.rows.every((row) => row.verificationStatus === "unknown")).toBe(true);
    expect(report.rows.map((row) => row.evidence)).toEqual(["", "too short", "unknown"]);
    expect(report.unknowns).toContain("3 source(s) did not return enough text evidence.");
  });

  it("normalizes evidence and keeps generated claims directly grounded", () => {
    const source = {
      url: " https://example.com/grounded ",
      title: "Unrelated title that claims zero security risk",
      excerpt: "  Javis exposes a read-only source-backed research flow.  ",
      fetchedAt: "2026-06-09T00:00:00.000Z",
    };
    const report = createSourceBackedReport([source]);
    const row = report.rows[0];

    expect(row).toMatchObject({
      status: "verified",
      verificationStatus: "verified",
      sourceUrl: "https://example.com/grounded",
      evidence: "Javis exposes a read-only source-backed research flow.",
    });
    expect(row?.claim).toBe(row?.evidence);
    expect(row?.claim).not.toContain("zero security risk");
    expect(validateSourceEvidence(source, row?.claim).valid).toBe(true);
  });

  it("rejects claims whose substantive keywords are not present in the excerpt", () => {
    const excerpt = "Javis exposes a read-only source-backed research flow.";
    expect(isClaimSupportedByExcerpt("Javis exposes a source-backed research flow", excerpt)).toBe(true);
    expect(isClaimSupportedByExcerpt("Javis guarantees zero security risk", excerpt)).toBe(false);

    const report = createSourceBackedReport([{
      url: "https://example.com/grounded",
      title: "Grounded source",
      excerpt,
      fetchedAt: "2026-06-09T00:00:00.000Z",
    }]);
    report.rows[0]!.claim = "Javis guarantees zero security risk.";
    const verification = verifySourceBackedReport([
      {
        url: "https://example.com/grounded",
        title: "Grounded source",
        excerpt,
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
    ], report);
    expect(verification.valid).toBe(false);
    expect(verification.failures).toContain("report-row-1:claim_not_supported");
  });

  it("matches claim keywords only at token boundaries", () => {
    expect(isClaimSupportedByExcerpt(
      "AI",
      "The article covers training neural networks in production systems.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "net",
      "The article covers internet security controls and network policy.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "AI systems",
      "The article compares AI safety controls for production systems.",
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Fetched evidence for https://example.test/alpha.",
      "Fetched evidence for https://example.test/alpha.",
    )).toBe(true);
  });

  it("rejects claims that reverse the excerpt's token order", () => {
    const excerpt = "Alice approved the deployment after Bob completed the review.";
    expect(isClaimSupportedByExcerpt(
      "Alice approved the deployment after Bob completed the review",
      excerpt,
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Bob completed the review after Alice approved the deployment",
      excerpt,
    )).toBe(false);
    expect(isClaimSupportedByExcerpt("Y depends on X", "X depends on Y")).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Version 2 precedes version 1",
      "Version 1 precedes version 2",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved production",
      "Alice approved staging. Bob approved production.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved production",
      "Alice approved staging, Bob approved production.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved production",
      "Alice approved staging - Bob approved production.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice did not approve deployment",
      "Alice did not approve Bob. Carol approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice won the prize",
      "Alice said Bob won the prize in 2026.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "Alice discussed risks before Bob approved the deployment.",
    )).toBe(false);
  });

  it("keeps coordinated relationships within their source clauses", () => {
    const excerpt = "Alice founded Acme and Bob founded Beta.";
    expect(isClaimSupportedByExcerpt("Alice founded Acme", excerpt)).toBe(true);
    expect(isClaimSupportedByExcerpt("Bob founded Beta", excerpt)).toBe(true);
    expect(isClaimSupportedByExcerpt("Alice founded Beta", excerpt)).toBe(false);
    expect(isClaimSupportedByExcerpt("Alice founded Acme and Beta", excerpt)).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice founded Acme and Bob founded Beta",
      excerpt,
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Alice supports Windows",
      "Alice supports Linux and Windows.",
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Alice founded Acme; Bob founded Beta",
      excerpt,
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Alice founded Beta",
      "Alice founded Acme but Bob founded Beta.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice founded Beta",
      "Alice founded Acme while Bob founded Beta.",
    )).toBe(false);

    expect(isClaimSupportedByExcerpt(
      "爱丽丝创办了 Beta",
      "爱丽丝创办了 Acme 而鲍勃创办了 Beta。",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "爱丽丝创办了 Acme 而 Beta",
      "爱丽丝创办了 Acme 而鲍勃创办了 Beta。",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "甲公司收购了 Beta",
      "甲公司收购了 Alpha 并且乙公司收购了 Beta。",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "鲍勃创办了 Beta",
      "爱丽丝创办了 Acme 而鲍勃创办了 Beta。",
    )).toBe(true);
  });

  it("does not turn attributed or uncertain source text into a definite claim", () => {
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "A false rumor claims Alice approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "The report disputes that Alice approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "Alice reportedly approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "Alice may have approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "Hypothetically, Alice approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice approved deployment",
      "Analysts believe Alice approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice said she approved deployment",
      "Analysts believe Alice approved deployment.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Alice claims she approved deployment",
      "Alice claims she approved deployment.",
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "Hypothetically, Alice approved deployment",
      "Hypothetically, Alice approved deployment.",
    )).toBe(true);
    expect(isClaimSupportedByExcerpt(
      "爱丽丝批准了部署",
      "据称爱丽丝批准了部署。",
    )).toBe(false);
  });

  it("fails report verification when a row drops the source attribution", () => {
    const source = {
      url: "https://example.com/disputed-deployment",
      excerpt: "A false rumor claims Alice approved deployment.",
      fetchedAt: "2026-07-13T00:00:00.000Z",
      provider: "fixture",
    };
    const report = createSourceBackedReport([source]);
    report.rows[0]!.claim = "Alice approved deployment";

    const verification = verifySourceBackedReport([source], report);

    expect(verification.valid).toBe(false);
    expect(verification.failures).toContain("report-row-1:claim_not_supported");
  });

  it("rejects claims whose negation polarity conflicts with the excerpt", () => {
    expect(isClaimSupportedByExcerpt(
      "Javis does not require approval for writes",
      "Javis requires approval for writes and records the approval decision.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Javis requires approval for writes",
      "Javis does not require approval for writes in this mode.",
    )).toBe(false);
    expect(isClaimSupportedByExcerpt(
      "Javis does not bypass approval for writes",
      "The policy states Javis does not bypass approval for writes.",
    )).toBe(true);
    expect(isClaimSupportedByExcerpt("系统安全", "报告说明系统安全且已完成审计")).toBe(true);
    expect(isClaimSupportedByExcerpt("系统不安全", "报告说明系统安全且已完成审计")).toBe(false);
  });

  it("requires each report row to match one original source URL and excerpt", () => {
    const originalSource = {
      url: "https://example.com/original",
      title: "Original source",
      excerpt: "Original evidence describes the read-only research workflow.",
      fetchedAt: "2026-06-09T00:00:00.000Z",
    };
    const substitutedReport = createSourceBackedReport([{
      url: "https://example.com/substitute",
      title: "Substitute source",
      excerpt: "Substitute evidence is independently valid but not fetched for this task.",
      fetchedAt: "2026-06-09T00:00:00.000Z",
    }]);

    const verification = verifySourceBackedReport([originalSource], substitutedReport);

    expect(verification.valid).toBe(false);
    expect(verification.validSourceCount).toBe(1);
    expect(verification.validReportEvidenceCount).toBe(0);
    expect(verification.failures).toContain("report-row-1:source_mismatch");
  });

  it("rejects a report evidence field that differs from its excerpt", () => {
    const source = {
      url: "https://example.com/original",
      title: "Original source",
      excerpt: "Original evidence describes the read-only research workflow.",
      fetchedAt: "2026-06-09T00:00:00.000Z",
    };
    const report = createSourceBackedReport([source]);
    report.rows[0]!.evidence = "Different evidence that was not present in the fetched source excerpt.";

    const verification = verifySourceBackedReport([source], report);

    expect(verification.valid).toBe(false);
    expect(verification.validReportEvidenceCount).toBe(0);
    expect(verification.failures).toContain("report-row-1:evidence_mismatch");
  });

  it("binds report provider metadata to the matching source", () => {
    const source = {
      url: "https://example.com/provider-bound",
      excerpt: "Trusted provider evidence contains enough text for validation.",
      fetchedAt: "2026-06-09T00:00:00.000Z",
      provider: "trusted",
    };
    const report = createSourceBackedReport([source]);
    report.rows[0]!.sourceProvider = "untrusted";
    const tamperedProvider = verifySourceBackedReport([source], report);
    expect(tamperedProvider.valid).toBe(false);
    expect(tamperedProvider.failures).toContain("report-row-1:provider_mismatch");

    report.rows[0]!.sourceProvider = undefined;
    const omittedProvider = verifySourceBackedReport([source], report);
    expect(omittedProvider.valid).toBe(false);
    expect(omittedProvider.failures).toContain("report-row-1:provider_mismatch");
  });

  it("validates structured trend rows against rank, title, source, and fetch metadata", () => {
    const hotList = {
      provider: "fixture",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://example.com/trends",
      expectedCount: 1,
      complete: true,
      warnings: [],
      diagnostics: [],
      items: [{
        rank: 1,
        title: "A grounded topic",
        hotScore: 123,
        url: "https://example.com/topic",
        label: "technology",
      }],
    };
    const report = {
      title: "Fixture trend top 1",
      summary: "Structured trend report.",
      rows: [{
        claim: "1. A grounded topic",
        status: "verified" as const,
        sourceUrl: "https://example.com/topic",
        excerpt: "hotScore=123",
        evidence: "provider=fixture; fetchedAt=2026-06-10T00:00:00.000Z; label=technology",
        verificationStatus: "verified" as const,
        sourceProvider: "fixture",
      }],
      unknowns: [],
    };

    expect(verifyTrendHotListResearchReport(hotList, report)).toMatchObject({
      valid: true,
      validSourceCount: 1,
      validReportEvidenceCount: 1,
    });

    const completeCountMismatch = verifyTrendHotListResearchReport(
      { ...hotList, expectedCount: 2 },
      report,
    );
    expect(completeCountMismatch.valid).toBe(false);
    expect(completeCountMismatch.failures).toContain("trend:complete_count_mismatch");

    const incompleteWithoutWarning = verifyTrendHotListResearchReport(
      { ...hotList, expectedCount: 2, complete: false },
      report,
    );
    expect(incompleteWithoutWarning.valid).toBe(false);
    expect(incompleteWithoutWarning.failures).toContain("trend:incomplete_without_warning");

    const incompleteWithWarning = verifyTrendHotListResearchReport(
      { ...hotList, expectedCount: 2, complete: false, warnings: ["Provider returned a partial list."] },
      report,
    );
    expect(incompleteWithWarning.valid).toBe(false);
    expect(incompleteWithWarning.failures).toContain("trend:incomplete_payload");

    report.rows[0]!.claim = "1. Unsupported topic";
    const tampered = verifyTrendHotListResearchReport(hotList, report);
    expect(tampered.valid).toBe(false);
    expect(tampered.failures).toContain("trend-row-1:claim_mismatch");
  });

  it("rejects structured trend metadata that claims fewer items than it carries", () => {
    const hotList = {
      provider: "fixture",
      fetchedAt: "2026-06-10T00:00:00.000Z",
      sourceUrl: "https://example.com/trends",
      expectedCount: 1,
      complete: true,
      warnings: [],
      diagnostics: [],
      items: [
        { rank: 1, title: "First topic" },
        { rank: 2, title: "Second topic" },
      ],
    };
    const report = {
      title: "Fixture trend top 1",
      summary: "Structured trend report.",
      rows: [],
      unknowns: [],
    };

    const verification = verifyTrendHotListResearchReport(hotList, report);
    expect(verification.valid).toBe(false);
    expect(verification.failures).toContain("trend:item_count_exceeds_expected");
  });

  it("fails source-only handoffs when any source lacks URL-backed evidence", () => {
    const verification = verifySourceCollection([
      {
        url: "https://example.com/valid",
        excerpt: "This source contains enough text for source-only validation.",
        fetchedAt: "2026-06-10T00:00:00.000Z",
      },
      {
        url: "https://example.com/weak",
        excerpt: "bad",
        fetchedAt: "2026-06-10T00:00:00.000Z",
      },
    ]);

    expect(verification.valid).toBe(false);
    expect(verification.validSourceCount).toBe(1);
    expect(verification.failures).toContain("source-2:excerpt_too_short");
  });
});
