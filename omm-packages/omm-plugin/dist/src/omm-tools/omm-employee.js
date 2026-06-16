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
import { makeError, OMM_ERROR_CODES } from "../omm-error-codes.js";
import { withCrossProcessLock } from "../omm-fs-queue.js";
const DISPATCH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
function employeeStateDir(stateRoot) {
    return join(resolveOmmStateRoot(stateRoot), "state");
}
function dispatchDir(stateRoot) {
    return join(employeeStateDir(stateRoot), "dispatch");
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
async function readJsonIfExists(path) {
    try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function missingArg(field, hint) {
    return {
        content: [
            { type: "text", text: `omm_employee error: ${field} is required` },
        ],
        details: {
            error: `${field} is required`,
            code: OMM_ERROR_CODES.VALUE_MISSING,
            structured: makeError(OMM_ERROR_CODES.VALUE_MISSING, `${field} is required`, hint),
        },
    };
}
/** List active MA digital employees from the cached registry file. */
export async function runOmmEmployeeList(_input, config = {}) {
    const cachePath = join(employeeStateDir(config.stateRoot), "ma-employees.json");
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
export async function runOmmEmployeeDispatch(input, config = {}) {
    if (!isNonEmptyString(input.agentId)) {
        return missingArg("agentId", "Pass the target employee's agentId (from omm_employee_list)");
    }
    if (!isNonEmptyString(input.message)) {
        return missingArg("message", "Pass the subtask message to dispatch");
    }
    const agentId = input.agentId.trim();
    const message = input.message.trim();
    const runId = randomUUID();
    const dir = dispatchDir(config.stateRoot);
    const requestPath = join(dir, `${runId}.json`);
    const request = {
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
export async function runOmmEmployeeResult(input, config = {}) {
    if (!isNonEmptyString(input.runId)) {
        return missingArg("runId", "Pass the runId returned by omm_employee_dispatch");
    }
    const runId = input.runId.trim();
    const dir = dispatchDir(config.stateRoot);
    const resultPath = join(dir, `${runId}.result.json`);
    const requestPath = join(dir, `${runId}.json`);
    const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const result = await readJsonIfExists(resultPath);
        if (result) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            runId,
                            status: "complete",
                            output: result.result ?? null,
                        }),
                    },
                ],
                details: {
                    runId,
                    status: "complete",
                    output: result.result ?? null,
                    completedAt: result.completedAt,
                },
            };
        }
        // If both the request and result are gone, the dispatch was purged.
        const [resStillMissing, reqMissing] = await Promise.all([
            readJsonIfExists(resultPath),
            readJsonIfExists(requestPath),
        ]);
        if (resStillMissing === null && reqMissing === null) {
            return {
                content: [
                    {
                        type: "text",
                        text: `omm_employee_result error: dispatch ${runId} expired`,
                    },
                ],
                details: {
                    error: `dispatch ${runId} expired`,
                    code: OMM_ERROR_CODES.DISPATCH_TIMEOUT,
                    structured: makeError(OMM_ERROR_CODES.DISPATCH_TIMEOUT, `dispatch ${runId} expired`, "The dispatch request was purged before a result arrived"),
                },
            };
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return {
        content: [
            {
                type: "text",
                text: `omm_employee_result error: result for ${runId} timed out after ${DISPATCH_TIMEOUT_MS}ms`,
            },
        ],
        details: {
            error: `result for ${runId} timed out`,
            code: OMM_ERROR_CODES.DISPATCH_TIMEOUT,
            structured: makeError(OMM_ERROR_CODES.DISPATCH_TIMEOUT, `result for ${runId} timed out after ${DISPATCH_TIMEOUT_MS}ms`, "The MA watcher did not fulfill the dispatch in time"),
        },
    };
}
//# sourceMappingURL=omm-employee.js.map