/**
 * Update and rollback policy (G5).
 *
 * The build has no `updater` plugin configured, so nothing here performs an update.
 * What it does provide is the part that must be *correct before* an updater exists:
 * deciding whether a candidate release may be installed, and refusing when the
 * answer is not provably yes.
 *
 * The Windows bundle sets `allowDowngrades: false`, which means an attempted
 * downgrade install fails at the OS layer and rollback really does require an
 * uninstall first. Encoding that here turns "the installer mysteriously refused"
 * into an explicit, explainable decision.
 *
 * Verification fails closed: a missing or malformed hash refuses the install rather
 * than trusting the download.
 */

export type UpdateAction =
  /** Already current, or no candidate release. */
  | "none"
  /** Offer the update; the user may decline. */
  | "prompt"
  /** Below the minimum supported version: the update is required to continue. */
  | "force"
  /** Would be a downgrade, which this bundle configuration cannot install. */
  | "blocked_downgrade"
  /** The candidate cannot be verified, so it must not be installed. */
  | "blocked_unverified"
  /** The candidate is malformed or older than the minimum supported version. */
  | "blocked_invalid";

export interface UpdateArtifact {
  /** e.g. "windows-x86_64". */
  platform: string;
  url: string;
  /** Lowercase hex SHA-256 of the installer. */
  sha256: string;
  sizeBytes?: number;
}

export interface UpdateCandidate {
  version: string;
  publishedAt?: string;
  /** Versions below this must update; they are no longer supported. */
  minSupportedVersion?: string;
  releaseNotes?: string;
  artifacts?: UpdateArtifact[];
}

export interface UpdatePolicy {
  /** Mirrors the bundle configuration; `false` blocks downgrade installs. */
  allowDowngrades: boolean;
  /** Platform to select an artifact for; absent means "do not require one". */
  platform?: string;
}

export interface UpdateDecision {
  action: UpdateAction;
  /** The version the running build should end up on, when there is one. */
  targetVersion?: string;
  /** Human-readable, localized reason for the decision. */
  reason: string;
  /** The artifact selected for this platform, when the decision installs one. */
  artifact?: UpdateArtifact;
  /** Extra step the user must take, e.g. rolling back. */
  requiredStep?: "uninstall_first";
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+]([\w.-]+))?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Parses a semver string, ignoring any pre-release/build suffix for ordering. */
export function parseVersion(version: string): { major: number; minor: number; patch: number; prerelease?: string } | undefined {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

/** -1, 0 or 1; `undefined` when either side is not a version. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A pre-release sorts before its release: 1.0.0-beta < 1.0.0.
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

export function isWellFormedSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

/**
 * Decides what to do about a candidate release.
 *
 * Ordering matters: an unusable candidate is reported as such even if it would also
 * have been a downgrade, because "cannot be verified" is the more actionable fact.
 */
export function decideUpdate(input: {
  currentVersion: string;
  candidate?: UpdateCandidate;
  policy: UpdatePolicy;
}): UpdateDecision {
  const { currentVersion, candidate, policy } = input;

  if (!candidate) {
    return { action: "none", reason: "No update is available." };
  }

  const current = parseVersion(currentVersion);
  const target = parseVersion(candidate.version);
  if (!current || !target) {
    return {
      action: "blocked_invalid",
      reason: `Cannot compare the running version "${currentVersion}" with the offered "${candidate.version}".`,
    };
  }

  const targetPlatform = policy.platform;
  const artifact = targetPlatform
    ? candidate.artifacts?.find((entry) => entry.platform === targetPlatform)
    : candidate.artifacts?.[0];
  if (targetPlatform && !artifact) {
    return {
      action: "blocked_invalid",
      targetVersion: candidate.version,
      reason: `The release offers no artifact for ${targetPlatform}.`,
    };
  }
  if (artifact && !isWellFormedSha256(artifact.sha256)) {
    // Fail closed: an unverifiable installer is not offered at all.
    return {
      action: "blocked_unverified",
      targetVersion: candidate.version,
      reason: "The offered installer has no valid SHA-256, so it cannot be verified.",
    };
  }

  const order = compareVersions(candidate.version, currentVersion) ?? 0;
  if (order < 0) {
    if (!policy.allowDowngrades) {
      return {
        action: "blocked_downgrade",
        targetVersion: candidate.version,
        reason: `Installing ${candidate.version} would downgrade this build, and this bundle configuration `
          + "does not allow downgrades. Rolling back requires uninstalling first.",
        requiredStep: "uninstall_first",
        ...(artifact ? { artifact } : {}),
      };
    }
    return {
      action: "prompt",
      targetVersion: candidate.version,
      reason: `This would install an older version (${candidate.version}).`,
      ...(artifact ? { artifact } : {}),
    };
  }
  if (order === 0) {
    return {
      action: "none",
      targetVersion: candidate.version,
      reason: "This build is already on the offered version.",
    };
  }

  const minSupported = candidate.minSupportedVersion;
  if (minSupported) {
    const comparison = compareVersions(currentVersion, minSupported);
    if (comparison === undefined) {
      return {
        action: "blocked_invalid",
        reason: `The release declares an unparsable minSupportedVersion "${minSupported}".`,
      };
    }
    if (comparison < 0) {
      return {
        action: "force",
        targetVersion: candidate.version,
        reason: `This build (${currentVersion}) is below the minimum supported version `
          + `(${minSupported}); updating is required.`,
        ...(artifact ? { artifact } : {}),
      };
    }
  }

  return {
    action: "prompt",
    targetVersion: candidate.version,
    reason: `Version ${candidate.version} is available.`,
    ...(artifact ? { artifact } : {}),
  };
}

/**
 * Checks a downloaded artifact against the manifest hash.
 *
 * Comparison is case-insensitive on hex only; it does not accept a "close enough"
 * value, and it refuses an empty or malformed hash instead of skipping the check.
 */
export function verifyUpdateArtifact(input: {
  expectedSha256: string;
  actualSha256: string;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
}): { ok: boolean; reason: string } {
  if (!isWellFormedSha256(input.expectedSha256)) {
    return { ok: false, reason: "The manifest does not carry a valid SHA-256." };
  }
  const actual = input.actualSha256.trim().toLowerCase();
  if (!isWellFormedSha256(actual)) {
    return { ok: false, reason: "The downloaded file produced no valid SHA-256." };
  }
  if (actual !== input.expectedSha256.toLowerCase()) {
    return { ok: false, reason: "The downloaded installer does not match the manifest hash." };
  }
  if (
    input.expectedSizeBytes !== undefined
    && input.actualSizeBytes !== undefined
    && input.expectedSizeBytes !== input.actualSizeBytes
  ) {
    return {
      ok: false,
      reason: `The downloaded installer is ${input.actualSizeBytes} bytes; the manifest declares ${input.expectedSizeBytes}.`,
    };
  }
  return { ok: true, reason: "The installer matches the manifest." };
}

export interface ReleaseManifest {
  version: string;
  publishedAt: string;
  minSupportedVersion?: string;
  releaseNotes?: string;
  artifacts: UpdateArtifact[];
}

/** Validates a release manifest before anything is offered from it. */
export function validateReleaseManifest(value: unknown): { manifest?: ReleaseManifest; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["manifest must be a JSON object."] };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || !parseVersion(record.version)) {
    errors.push("manifest.version must be a semver string.");
  }
  if (typeof record.publishedAt !== "string" || Number.isNaN(Date.parse(record.publishedAt))) {
    errors.push("manifest.publishedAt must be an ISO-8601 timestamp.");
  }
  if (
    record.minSupportedVersion !== undefined
    && (typeof record.minSupportedVersion !== "string" || !parseVersion(record.minSupportedVersion))
  ) {
    errors.push("manifest.minSupportedVersion must be a semver string when present.");
  }
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    errors.push("manifest.artifacts must be a non-empty array.");
  } else {
    record.artifacts.forEach((artifact, index) => {
      if (typeof artifact !== "object" || artifact === null) {
        errors.push(`manifest.artifacts[${index}] must be an object.`);
        return;
      }
      const entry = artifact as Record<string, unknown>;
      if (typeof entry.platform !== "string" || entry.platform.length === 0) {
        errors.push(`manifest.artifacts[${index}].platform is required.`);
      }
      if (typeof entry.url !== "string" || !/^https:\/\//u.test(entry.url)) {
        // Refuse plaintext transport for an installer.
        errors.push(`manifest.artifacts[${index}].url must be an https URL.`);
      }
      if (!isWellFormedSha256(entry.sha256)) {
        errors.push(`manifest.artifacts[${index}].sha256 must be a lowercase hex SHA-256.`);
      }
    });
  }

  if (errors.length > 0) {
    return { errors };
  }
  return { manifest: value as ReleaseManifest, errors: [] };
}
