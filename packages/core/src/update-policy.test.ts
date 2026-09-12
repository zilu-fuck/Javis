import { describe, expect, it } from "vitest";
import {
  compareVersions,
  decideUpdate,
  isWellFormedSha256,
  parseVersion,
  validateReleaseManifest,
  verifyUpdateArtifact,
} from "./update-policy";

const SHA = "a".repeat(64);

describe("version comparison", () => {
  it("parses semver and rejects anything else", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3-beta.1")).toMatchObject({ prerelease: "beta.1" });
    expect(parseVersion("v1.2.3")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });

  it("orders by major, minor then patch", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("sorts a pre-release before its release", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("returns undefined rather than guessing for an unparsable side", () => {
    expect(compareVersions("1.0", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0.0", "nightly")).toBeUndefined();
  });

  it("validates a manifest hash shape", () => {
    expect(isWellFormedSha256(SHA)).toBe(true);
    expect(isWellFormedSha256(SHA.toUpperCase())).toBe(false);
    expect(isWellFormedSha256("abc")).toBe(false);
    expect(isWellFormedSha256(undefined)).toBe(false);
  });
});

describe("decideUpdate", () => {
  const candidate = {
    version: "1.1.0",
    artifacts: [{ platform: "windows-x86_64", url: "https://example.com/setup.exe", sha256: SHA }],
  };
  const policy = { allowDowngrades: false, platform: "windows-x86_64" };

  it("does nothing without a candidate", () => {
    const decision = decideUpdate({ currentVersion: "1.0.0", policy });
    expect(decision.action).toBe("none");
  });

  it("offers a newer version", () => {
    const decision = decideUpdate({ currentVersion: "1.0.0", candidate, policy });
    expect(decision.action).toBe("prompt");
    expect(decision.targetVersion).toBe("1.1.0");
    expect(decision.artifact?.platform).toBe("windows-x86_64");
  });

  it("does nothing when already current", () => {
    expect(decideUpdate({ currentVersion: "1.1.0", candidate, policy }).action).toBe("none");
  });

  it("forces an update below the minimum supported version", () => {
    const decision = decideUpdate({
      currentVersion: "0.9.0",
      candidate: { ...candidate, minSupportedVersion: "1.0.0" },
      policy,
    });
    expect(decision.action).toBe("force");
    expect(decision.reason).toContain("minimum supported version");
  });

  it("blocks a downgrade when the bundle refuses them, and names the workaround", () => {
    const decision = decideUpdate({
      currentVersion: "2.0.0",
      candidate,
      policy,
    });
    expect(decision.action).toBe("blocked_downgrade");
    expect(decision.requiredStep).toBe("uninstall_first");
    expect(decision.reason).toContain("uninstalling first");
  });

  it("offers a downgrade when the policy allows it", () => {
    const decision = decideUpdate({
      currentVersion: "2.0.0",
      candidate,
      policy: { allowDowngrades: true, platform: "windows-x86_64" },
    });
    expect(decision.action).toBe("prompt");
    expect(decision.reason).toContain("older version");
  });

  it("fails closed when the installer cannot be verified", () => {
    const decision = decideUpdate({
      currentVersion: "1.0.0",
      candidate: { version: "1.1.0", artifacts: [{ platform: "windows-x86_64", url: "https://x/y", sha256: "nope" }] },
      policy,
    });
    expect(decision.action).toBe("blocked_unverified");
    expect(decision.artifact).toBeUndefined();
  });

  it("refuses a release with no artifact for this platform", () => {
    const decision = decideUpdate({
      currentVersion: "1.0.0",
      candidate: { version: "1.1.0", artifacts: [{ platform: "darwin-arm64", url: "https://x/y", sha256: SHA }] },
      policy,
    });
    expect(decision.action).toBe("blocked_invalid");
    expect(decision.reason).toContain("windows-x86_64");
  });

  it("refuses an unparsable version on either side", () => {
    expect(decideUpdate({ currentVersion: "abc", candidate, policy }).action).toBe("blocked_invalid");
    expect(decideUpdate({
      currentVersion: "1.0.0",
      candidate: { version: "nightly" },
      policy,
    }).action).toBe("blocked_invalid");
  });

  it("does not require an artifact when the policy names no platform", () => {
    const decision = decideUpdate({
      currentVersion: "1.0.0",
      candidate: { version: "1.1.0" },
      policy: { allowDowngrades: false },
    });
    expect(decision.action).toBe("prompt");
    expect(decision.artifact).toBeUndefined();
  });
});

describe("verifyUpdateArtifact", () => {
  it("accepts an exact match, ignoring hex case", () => {
    expect(verifyUpdateArtifact({ expectedSha256: SHA, actualSha256: SHA.toUpperCase() }))
      .toEqual({ ok: true, reason: "The installer matches the manifest." });
  });

  it("rejects a mismatched hash", () => {
    const result = verifyUpdateArtifact({ expectedSha256: SHA, actualSha256: "b".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the manifest hash");
  });

  it("rejects a size mismatch", () => {
    const result = verifyUpdateArtifact({
      expectedSha256: SHA, actualSha256: SHA, expectedSizeBytes: 100, actualSizeBytes: 101,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("101 bytes");
  });

  it("refuses to skip the check when either hash is unusable", () => {
    expect(verifyUpdateArtifact({ expectedSha256: "", actualSha256: SHA }).ok).toBe(false);
    expect(verifyUpdateArtifact({ expectedSha256: SHA, actualSha256: "" }).ok).toBe(false);
    expect(verifyUpdateArtifact({ expectedSha256: SHA, actualSha256: "not-a-hash" }).ok).toBe(false);
  });
});

describe("validateReleaseManifest", () => {
  const good = {
    version: "1.1.0",
    publishedAt: "2026-09-13T00:00:00.000Z",
    artifacts: [{ platform: "windows-x86_64", url: "https://example.com/setup.exe", sha256: SHA }],
  };

  it("accepts a well-formed manifest", () => {
    const result = validateReleaseManifest(good);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.version).toBe("1.1.0");
  });

  it("rejects a malformed version, timestamp or artifact list", () => {
    expect(validateReleaseManifest({ ...good, version: "v1.1" }).errors[0]).toContain("version must be a semver");
    expect(validateReleaseManifest({ ...good, publishedAt: "yesterday" }).errors[0]).toContain("ISO-8601");
    expect(validateReleaseManifest({ ...good, artifacts: [] }).errors[0]).toContain("non-empty array");
    expect(validateReleaseManifest([]).errors[0]).toContain("JSON object");
  });

  it("refuses a plaintext download URL", () => {
    const result = validateReleaseManifest({
      ...good,
      artifacts: [{ platform: "windows-x86_64", url: "http://example.com/setup.exe", sha256: SHA }],
    });
    expect(result.errors[0]).toContain("must be an https URL");
  });

  it("refuses an artifact without a valid hash", () => {
    const result = validateReleaseManifest({
      ...good,
      artifacts: [{ platform: "windows-x86_64", url: "https://example.com/setup.exe", sha256: "short" }],
    });
    expect(result.errors[0]).toContain("sha256 must be a lowercase hex SHA-256");
  });

  it("reports every problem rather than stopping at the first", () => {
    const result = validateReleaseManifest({ version: "x", publishedAt: "y", artifacts: "nope" });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
