/**
 * omm↔MA digital-employee bridge tools.
 *
 * Lets `omm-team` dispatch subtasks to MatrixAssistant's digital employees
 * (OpenClaw Agents) via a state-file relay. The relay is required because
 * the MA Gateway runs as an Electron-spawned child process — function
 * references cannot cross the process boundary, so omm writes dispatch
 * requests to `{stateRoot}/state/dispatch/{runId}.json` and polls
 * `{runId}.result.json`. MA watches the dispatch dir and fulfills requests
 * via `gatewayManager.rpc('chat.send', { sessionKey, message, idempotencyKey })`.
 *
 * See docs/plans/omm-ma-employee-bridge.md (APPROVED) and
 * docs/adr/008-delegation-to-host.md (Follow-up #1).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "../omm-config.js";
import {
  makeError,
  OMM_ERROR_CODES,
  type OmmErrorCode,
} from "../omm-error-codes.js";
import { withCrossProcessLock } from "../omm-fs-queue.js";
import type { OmmToolResult } from "./omm-tool-result.js";

export interface OmmEmployeeConfig {
  stateRoot?: string;
}

export interface OmmEmployeeDispatchInput {
  agentId?: unknown;
  message?: unknown;
}

export interface OmmEmployeeResultInput {
  runId?: unknown;
}

const DISPATCH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

function employeeStateDir(stateRoot?: string): string {
  return join(resolveOmmStateRoot(stateRoot), "state");
}

function dispatchDir(stateRoot?: string): string {
  return join(employeeStateDir(stateRoot), "dispatch");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

async function readJsonIfExists(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function missingArg(field: string, hint: string): OmmToolResult {
  return {
    content: [
      { type: "text", text: `omm_employee error: ${field} is required` },
    ],
    details: {
      error: `${field} is required`,
      code: OMM_ERROR_CODES.VALUE_MISSING,
      structured: makeError(
        OMM_ERROR_CODES.VALUE_MISSING,
        `${field} is required`,
        hint,
      ),
    },
  };
}

/** List active MA digital employees from the cached registry file. */
export async function runOmmEmployeeList(
  _input: Record<string, unknown>,
  config: OmmEmployeeConfig = {},
): Promise<OmmToolResult> {
  const cachePath = join(
    employeeStateDir(config.stateRoot),
    "ma-employees.json",
  );
  const cache = await readJsonIfExists(cachePath);
  if (!cache) {
    return {
      content: [{ type: "text", text: JSON.stringify({ employees: [] }) }],
      details: { employees: [], cached: false },
    };
  }
  const employees = Array.isArray(cache.employees) ? cache.employees : [];
  return {
    content: [{ type: "text", text: JSON.stringify({ employees }) }],
    details: { employees, cached: true, generatedAt: cache.generatedAt },
  };
}

/** Dispatch a subtask to an MA digital employee. Returns a runId to poll. */
export async function runOmmEmployeeDispatch(
  input: OmmEmployeeDispatchInput,
  config: OmmEmployeeConfig = {},
): Promise<OmmToolResult> {
  if (!isNonEmptyString(input.agentId)) {
    return missingArg(
      "agentId",
      "Pass the target employee's agentId (from omm_employee_list)",
    );
  }
  if (!isNonEmptyString(input.message)) {
    return missingArg("message", "Pass the subtask message to dispatch");
  }

  const agentId = (input.agentId as string).trim();
  const message = (input.message as string).trim();
  const runId = randomUUID();
  const dir = dispatchDir(config.stateRoot);
  const requestPath = join(dir, `${runId}.json`);
  const request: Record<string, unknown> = {
    runId,
    agentId,
    message,
    sessionKey: `agent:${agentId}:main`,
    status: "pending",
    createdAt: Date.now(),
  };

  await withCrossProcessLock(dir, runId, async () => {
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `.${runId}.json.tmp`);
    await writeFile(tmpPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    await rename(tmpPath, requestPath);
  });

  return {
    content: [
      { type: "text", text: JSON.stringify({ runId, status: "dispatched" }) },
    ],
    details: { runId, status: "dispatched", requestPath },
  };
}

/** Poll for a dispatch result. Returns the employee's output or a timeout. */
export async function runOmmEmployeeResult(
  input: OmmEmployeeResultInput,
  config: OmmEmployeeConfig = {},
): Promise<OmmToolResult> {
  if (!isNonEmptyString(input.runId)) {
    return missingArg(
      "runId",
      "Pass the runId returned by omm_employee_dispatch",
    );
  }
  return outcomeToResult(
    await pollSingleResult((input.runId as string).trim(), config),
  );
}

/**
 * Clean per-runId poll outcome. `pollSingleResult` returns this typed value;
 * the single-result tool and the batch tool both consume it without
 * reverse-engineering each other's envelopes.
 */
type PollOutcome =
  | { kind: "complete"; runId: string; output: unknown; completedAt: unknown }
  | { kind: "expired"; runId: string }
  | { kind: "timeout"; runId: string };

/**
 * Poll a single dispatch until its result arrives, the request is purged, or
 * the timeout elapses. Read-only — does not take the cross-process write lock.
 *
 * Reads `resultPath` once per tick; reads `requestPath` only when the result
 * is still missing (to detect the purged-dispatch case). Avoids re-reading
 * `resultPath` twice per tick.
 */
async function pollSingleResult(
  runId: string,
  config: OmmEmployeeConfig,
): Promise<PollOutcome> {
  const dir = dispatchDir(config.stateRoot);
  const resultPath = join(dir, `${runId}.result.json`);
  const requestPath = join(dir, `${runId}.json`);

  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await readJsonIfExists(resultPath);
    if (result) {
      return {
        kind: "complete",
        runId,
        output: result.result ?? null,
        completedAt: result.completedAt,
      };
    }
    // Result still missing. If the request file is also gone, the dispatch
    // was purged before completing — fail fast rather than waiting out the
    // full timeout.
    if ((await readJsonIfExists(requestPath)) === null) {
      return { kind: "expired", runId };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { kind: "timeout", runId };
}

/** Shape a PollOutcome into the single-tool OmmToolResult envelope. */
function outcomeToResult(o: PollOutcome): OmmToolResult {
  if (o.kind === "complete") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runId: o.runId,
            status: "complete",
            output: o.output,
          }),
        },
      ],
      details: {
        runId: o.runId,
        status: "complete",
        output: o.output,
        completedAt: o.completedAt,
      },
    };
  }
  // expired + timeout share the DISPATCH_TIMEOUT code; only the message differs.
  const message =
    o.kind === "expired"
      ? `dispatch ${o.runId} expired`
      : `result for ${o.runId} timed out after ${DISPATCH_TIMEOUT_MS}ms`;
  return {
    content: [{ type: "text", text: `omm_employee_result error: ${message}` }],
    details: {
      error: message,
      code: OMM_ERROR_CODES.DISPATCH_TIMEOUT,
      structured: makeError(
        OMM_ERROR_CODES.DISPATCH_TIMEOUT,
        message,
        o.kind === "expired"
          ? "The dispatch request was purged before a result arrived"
          : "The MA watcher did not fulfill the dispatch in time",
      ),
    },
  };
}

/**
 * Poll for multiple dispatch results concurrently (fork-join collection).
 *
 * omm_employee_result is a blocking poll loop (up to 60s per runId), and LLM
 * tool calls execute sequentially within a turn — so the LLM cannot itself
 * poll N runIds in parallel. This batch tool runs Promise.all over the
 * individual polls so all results arrive in one tool call, enabling true
 * fork-join semantics for multi-agent team execution.
 */
export interface OmmEmployeeResultBatchInput {
  runIds?: unknown;
}

const MAX_BATCH_RUN_IDS = 10;

/** Shared error envelope for batch validation failures. */
function batchError(
  message: string,
  code: OmmErrorCode,
  hint: string,
): OmmToolResult {
  return {
    content: [
      { type: "text", text: `omm_employee_result_batch error: ${message}` },
    ],
    details: {
      error: message,
      code,
      structured: makeError(code, message, hint),
    },
  };
}

/** Poll for multiple dispatch results concurrently. Returns all results at once. */
export async function runOmmEmployeeResultBatch(
  input: OmmEmployeeResultBatchInput,
  config: OmmEmployeeConfig = {},
): Promise<OmmToolResult> {
  const raw = input.runIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return batchError(
      "runIds must be a non-empty array",
      OMM_ERROR_CODES.VALUE_INVALID,
      "Pass an array of runId strings returned by omm_employee_dispatch",
    );
  }
  if (raw.length > MAX_BATCH_RUN_IDS) {
    return batchError(
      `runIds exceeds max of ${MAX_BATCH_RUN_IDS}`,
      OMM_ERROR_CODES.VALUE_INVALID,
      `Pass at most ${MAX_BATCH_RUN_IDS} runId strings`,
    );
  }
  const runIds: string[] = [];
  for (const r of raw) {
    if (!isNonEmptyString(r)) {
      return batchError(
        "every runId must be a non-empty string",
        OMM_ERROR_CODES.KEY_INVALID,
        "Pass an array of runId strings returned by omm_employee_dispatch",
      );
    }
    runIds.push((r as string).trim());
  }

  // Concurrent collection — the whole point of the batch tool. Each poll runs
  // its own 60s timeout loop independently; the batch resolves when all do.
  const outcomes = await Promise.all(
    runIds.map((id) => pollSingleResult(id, config)),
  );

  // Map the typed outcome directly — no envelope reverse-engineering.
  const results = outcomes.map((o) =>
    o.kind === "complete"
      ? {
          runId: o.runId,
          status: "complete",
          output: o.output,
          completedAt: o.completedAt,
        }
      : { runId: o.runId, status: "timeout", output: null },
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ results, count: results.length }),
      },
    ],
    details: { results, count: results.length },
  };
}
