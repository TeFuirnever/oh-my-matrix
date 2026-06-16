/**
 * Structured error codes for omm tools and MCP servers.
 *
 * Hosts (MatrixAssistant, OpenClaw) can branch on `code` rather than
 * matching free-form error strings. Codes are stable across patch versions;
 * adding a new code is a minor bump.
 *
 * @since 0.3.0
 */

export const OMM_ERROR_CODES = {
  /** Caller did not provide a required `key` argument. */
  KEY_MISSING: "OMM_E_KEY_MISSING",
  /** Key did not match the safe-key whitelist (length, chars, traversal). */
  KEY_INVALID: "OMM_E_KEY_INVALID",
  /** Caller did not provide a required `value` argument. */
  VALUE_MISSING: "OMM_E_VALUE_MISSING",
  /** Provided `value` was not a plain JSON object. */
  VALUE_INVALID: "OMM_E_VALUE_INVALID",
  /** State payload failed schema validation (e.g. missing mode/active). */
  STATE_INVALID: "OMM_E_STATE_INVALID",
  /** Workflow exclusivity guard rejected the write. */
  WORKFLOW_CONFLICT: "OMM_E_WORKFLOW_CONFLICT",
  /** File-system I/O failure (read, write, rename, mkdir). */
  IO_FAILED: "OMM_E_IO_FAILED",
  /** Cross-process lock acquisition exceeded the timeout. */
  LOCK_TIMEOUT: "OMM_E_LOCK_TIMEOUT",
  /** Plugin/MCP API version is incompatible with the host's expectation. */
  VERSION_MISMATCH: "OMM_E_VERSION_MISMATCH",
  /** Employee-dispatch result did not arrive before the poll timeout. */
  DISPATCH_TIMEOUT: "OMM_E_DISPATCH_TIMEOUT",
  /** Catch-all for unexpected internal errors. */
  INTERNAL: "OMM_E_INTERNAL",
} as const;

export type OmmErrorCode =
  (typeof OMM_ERROR_CODES)[keyof typeof OMM_ERROR_CODES];

export interface StructuredError {
  /** Stable machine-readable code from `OMM_ERROR_CODES`. */
  code: OmmErrorCode;
  /** Human-readable message (may include details that vary across runs). */
  message: string;
  /** Optional remediation hint shown to operators / users. */
  hint?: string;
}

export function makeError(
  code: OmmErrorCode,
  message: string,
  hint?: string,
): StructuredError {
  return hint === undefined ? { code, message } : { code, message, hint };
}

/** True if the given value matches the `StructuredError` shape. */
export function isStructuredError(value: unknown): value is StructuredError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    v.code.startsWith("OMM_E_") &&
    typeof v.message === "string"
  );
}
