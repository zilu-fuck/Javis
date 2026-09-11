import type { AgentKind } from "../index";
import { isSensitiveFieldName, redactSensitiveText } from "../sensitive-data";

/**
 * Helpers shared between the migration-era legacy ReAct loop and the
 * modern Agent runtime adapters (dual-kernel plan §4). The loop itself is
 * deleted in Phase 4; these pure helpers stay because the LangChain runtime
 * still uses `validateAgentRequestInput` for its `javis__request_input`
 * control tool and `sanitizeAgentReActOutput` for bounded observation
 * evidence.
 */

export const MAX_REACT_REQUESTED_CONTEXT_KEYS = 16;
export const MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS = 128;
const REQUESTED_CONTEXT_KEY_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u;

type RequestInputValidation =
  | {
      valid: true;
      requestedContextKeys: string[];
      requestedAgentKind?: AgentKind;
    }
  | { valid: false; reason: string };

export function validateAgentRequestInput(
  requestedContextKeys: unknown,
  requestedAgentKind: unknown,
  liveAgentKinds: ReadonlyArray<AgentKind> | undefined,
): RequestInputValidation {
  if (!Array.isArray(requestedContextKeys) || requestedContextKeys.length === 0) {
    return invalidRequestInput("requestedContextKeys must be a non-empty array.");
  }
  if (requestedContextKeys.length > MAX_REACT_REQUESTED_CONTEXT_KEYS) {
    return invalidRequestInput(
      `requestedContextKeys cannot contain more than ${MAX_REACT_REQUESTED_CONTEXT_KEYS} keys.`,
    );
  }

  const validatedKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < requestedContextKeys.length; index += 1) {
    const key: unknown = requestedContextKeys[index];
    if (typeof key !== "string") {
      return invalidRequestInput(`requestedContextKeys[${index}] must be a string.`);
    }
    if (
      key.length === 0 ||
      key.length > MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS ||
      key !== key.trim() ||
      !REQUESTED_CONTEXT_KEY_PATTERN.test(key)
    ) {
      return invalidRequestInput(
        `requestedContextKeys[${index}] must be a valid context key of at most ${MAX_REACT_REQUESTED_CONTEXT_KEY_CHARS} characters.`,
      );
    }
    if (seenKeys.has(key)) {
      return invalidRequestInput("requestedContextKeys must not contain duplicates.");
    }
    seenKeys.add(key);
    validatedKeys.push(key);
  }

  if (requestedAgentKind === undefined) {
    return { valid: true, requestedContextKeys: validatedKeys };
  }
  if (
    typeof requestedAgentKind !== "string" ||
    !liveAgentKinds?.includes(requestedAgentKind as AgentKind)
  ) {
    return invalidRequestInput("requestedAgentKind must identify a live registered agent.");
  }

  return {
    valid: true,
    requestedContextKeys: validatedKeys,
    requestedAgentKind: requestedAgentKind as AgentKind,
  };
}

function invalidRequestInput(reason: string): RequestInputValidation {
  return { valid: false, reason };
}

export const MAX_REACT_OBSERVATION_TOTAL_CHARS = 32_000;
const MAX_REACT_OBSERVATION_CHARS = 12_000;
const IMAGE_DATA_URL_PATTERN = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu;

interface BoundedObservationOutput {
  value: unknown;
  truncated: boolean;
}

function boundObservationOutput(output: unknown): BoundedObservationOutput {
  if (typeof output === "string") {
    const sanitized = sanitizeObservationText(output);
    return sanitized.length <= MAX_REACT_OBSERVATION_CHARS
      ? { value: sanitized, truncated: false }
      : {
          value: `${sanitized.slice(0, MAX_REACT_OBSERVATION_CHARS)}\n[observation truncated]`,
          truncated: true,
        };
  }
  try {
    const original = JSON.stringify(output);
    const serialized = JSON.stringify(output, (key, value: unknown) => {
      if (key && isSensitiveFieldName(key)) return "[redacted:secret]";
      return typeof value === "string" ? sanitizeObservationText(value) : value;
    });
    if (serialized === undefined) {
      return { value: undefined, truncated: false };
    }
    if (serialized.length > MAX_REACT_OBSERVATION_CHARS) {
      return {
        value: `${serialized.slice(0, MAX_REACT_OBSERVATION_CHARS)}\n[observation truncated]`,
        truncated: true,
      };
    }
    if (serialized === original) {
      return { value: output, truncated: false };
    }
    try {
      return { value: JSON.parse(serialized), truncated: false };
    } catch {
      return { value: serialized, truncated: false };
    }
  } catch {
    // A value that cannot be serialized is not auditable evidence. Do not
    // coerce it to a string, because that could let a completion decision
    // pass on an opaque placeholder such as "[object Object]".
    return { value: undefined, truncated: false };
  }
}

/** Apply the same bounded/redacted representation used in ReAct observations. */
export function sanitizeAgentReActOutput(output: unknown): unknown {
  return boundObservationOutput(output).value;
}

function sanitizeObservationText(value: string): string {
  return redactSensitiveText(
    value.replace(IMAGE_DATA_URL_PATTERN, "[redacted:image data URL]"),
  );
}
