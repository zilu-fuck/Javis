/**
 * Independent verification for the text-write flow.
 *
 * Before this existed the flow set the verifier to "completed / 已验证写入结果"
 * and emitted `verificationSummary: "已验证…"` unconditionally, right after the
 * write call returned. That is self-certification: the code that wrote the file
 * declared it verified, so even a `.md` file holding an HTML request showed up as
 * verified. Verification now has to be earned:
 *
 *   1. a deterministic boundary check runs first (no model cost), and
 *   2. the verifier agent's tool is actually invoked, and
 *   3. a missing verifier is reported as "not independently verified".
 */
import type { VerifierTool } from "@javis/tools";
import type { TextArtifactFormat } from "./text-write-flow";

export interface ArtifactBoundaryCheck {
  ok: boolean;
  /** What was checked, for the evidence trail. */
  checked: string[];
  /** What failed, in the order it was checked. */
  failures: string[];
}

export interface TextWriteVerification {
  /**
   * `pass` was earned by an independent check, `warn`/`fail` came from the
   * verifier, and `unavailable` means nothing independent ran.
   */
  status: "pass" | "warn" | "fail" | "unavailable";
  summary: string;
  detail: string;
  /** Present when the deterministic boundary check ran, pass or fail. */
  boundaries: ArtifactBoundaryCheck;
}

const MAX_EXCERPT_CHARS = 400;

/**
 * Format-specific structural checks. These are cheap and deterministic, so a
 * payload that cannot possibly satisfy the contract fails without spending a
 * model call on it.
 */
export function checkArtifactBoundaries(content: string, format: TextArtifactFormat): ArtifactBoundaryCheck {
  const checked: string[] = [];
  const failures: string[] = [];
  const trimmed = content.trim();

  checked.push("non-empty payload");
  if (trimmed.length === 0) failures.push("the payload is empty");

  const extension = format.extension;
  const lower = trimmed.toLowerCase();
  if (!format.markdown) {
    // A fence around a non-markdown payload is a wrapper, never part of the
    // artifact (markdown is excluded: a document may legitimately start with one).
    checked.push("no surrounding code fence");
    if (/^```/u.test(trimmed) || /```$/u.test(trimmed)) {
      failures.push("the payload is wrapped in a code fence");
    }
  }
  if (extension === ".html" || extension === ".htm") {
    checked.push("HTML document boundaries");
    if (!lower.startsWith("<!doctype") && !lower.startsWith("<html")) {
      failures.push("the document does not start with <!DOCTYPE or <html");
    }
    if (!lower.endsWith("</html>")) failures.push("the document does not end with </html>");
  } else if (extension === ".svg") {
    checked.push("SVG element boundaries");
    if (!lower.includes("<svg")) failures.push("no <svg> element was found");
    if (!lower.endsWith("</svg>")) failures.push("the document does not end with </svg>");
  } else if (extension === ".json") {
    checked.push("JSON parses");
    try {
      JSON.parse(trimmed);
    } catch {
      failures.push("the payload is not valid JSON");
    }
  }

  return { ok: failures.length === 0, checked, failures };
}

export interface TextWriteVerificationInput {
  /** Bilingual copy helper, matching the rest of the flow. */
  tr: (english: string, chinese: string) => string;
  content: string;
  format: TextArtifactFormat;
  targetPath: string;
  byteCount: number;
  /** Requirements the Commander decided, folded into the success criteria. */
  requirements: readonly string[];
  verifierTool?: VerifierTool;
  taskId: string;
}

/**
 * Verifies a written artifact. Deterministic boundaries decide first; only a
 * payload that passes them is worth an independent model check.
 */
export async function verifyTextWriteArtifact(
  input: TextWriteVerificationInput,
): Promise<TextWriteVerification> {
  const boundaries = checkArtifactBoundaries(input.content, input.format);
  if (!boundaries.ok) {
    return {
      status: "fail",
      summary: input.tr(
        "The written file does not match the decided format.",
        "写入的文件与该产物格式不符。",
      ),
      detail: boundaries.failures.join("; "),
      boundaries,
    };
  }
  if (!input.verifierTool?.check) {
    return {
      status: "unavailable",
      summary: input.tr("Written, but not independently verified.", "已写入，但未经独立验证。"),
      detail: input.tr(
        "No verifier tool is available in this runtime, so nothing checked the artifact beyond its boundaries.",
        "此运行时没有可用的验证器工具，因此除边界检查外没有任何独立核验。",
      ),
      boundaries,
    };
  }

  const successCriteria = [
    `The ${input.format.label} artifact "${input.targetPath}" was written after confirmed-write approval`,
    "and its contents are a complete artifact for the user's request",
    input.requirements.length > 0
      ? `meeting: ${input.requirements.join("; ")}`
      : "with no extra requirements beyond the request",
  ].join(" ") + ".";

  try {
    const result = await input.verifierTool.check({
      stepId: `${input.taskId}:text-write`,
      successCriteria,
      evidence: [
        {
          kind: "log",
          label: "Write result",
          data: {
            targetPath: input.targetPath,
            byteCount: input.byteCount,
            format: input.format.extension,
          },
        },
        {
          kind: "log",
          label: "Deterministic boundary check",
          data: { checked: boundaries.checked, failures: boundaries.failures },
        },
        {
          kind: "log",
          label: "Artifact excerpt",
          data: input.content.slice(0, MAX_EXCERPT_CHARS),
        },
      ],
    });
    if (!isVerifierCheckResult(result)) {
      return {
        status: "fail",
        summary: input.tr("The verifier returned an unusable result.", "验证器返回了不可用的结果。"),
        detail: JSON.stringify(result).slice(0, 200),
        boundaries,
      };
    }
    return {
      status: result.status,
      summary: result.summary,
      detail: result.detail ?? "",
      boundaries,
    };
  } catch (error) {
    return {
      status: "fail",
      summary: input.tr("Verifier execution failed.", "验证器执行失败。"),
      detail: error instanceof Error ? error.message : String(error),
      boundaries,
    };
  }
}

function isVerifierCheckResult(value: unknown): value is { status: "pass" | "warn" | "fail"; summary: string; detail?: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "pass" && record.status !== "warn" && record.status !== "fail") return false;
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) return false;
  return record.detail === undefined || typeof record.detail === "string";
}
