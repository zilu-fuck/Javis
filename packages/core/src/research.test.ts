import { describe, expect, it } from "vitest";
import { createSourceBackedReport } from "./research";

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
});
