/**
 * @oh-my-matrix/instinct — cross-session context memory (third-gap closure).
 *
 * Three surfaces form the loop:
 *  - after_tool_call (observer): captures a scrubbed {tool, input, output}
 *    summary to .instinct/observations.jsonl (rotated, secret-scrubbed).
 *  - instinct_record (tool): the main agent records a distilled working
 *    pattern to .instinct/instincts.jsonl (exact-text dedup, hits counted).
 *  - session_start (recall): purges both families past 30 days, then injects
 *    a two-part appendContext — raw activity tail ("where the last session
 *    stopped") + instincts ("how this project works"), each independently
 *    trimmable for the shared token budget.
 */
import {
  appendInstinct,
  appendObservation,
  getWriteFailureCount,
  loadInstincts,
  loadRecentObservations,
  projectId,
  purgeExpired,
  type Instinct,
  type Observation,
} from './src/store';

export {
  appendInstinct,
  appendObservation,
  loadInstincts,
  loadRecentObservations,
  projectId,
  purgeExpired,
  scrubSecrets,
} from './src/store';
export type { Instinct, Observation } from './src/store';

export const id = 'instinct';
export const name = 'Instinct (context memory)';
export const version = '0.3.0';

export function _resetForTest(): void {
  // Re-exported for test symmetry; the store has its own reset.
}

/** Pull a short input summary from a tool event (any shape — scrubbed downstream). */
function extractInputSummary(event: any): string | undefined {
  const params = event?.params ?? event?.args ?? event?.input;
  if (params == null) return undefined;
  if (typeof params === 'string') return params;
  // Prefer the highest-signal field; fall back to a shallow JSON snapshot.
  const cmd = params.command ?? params.cmd ?? params.path ?? params.file;
  if (typeof cmd === 'string') return cmd;
  try {
    const s = JSON.stringify(params);
    return s.length > 200 ? s.substring(0, 200) + '...' : s;
  } catch {
    return undefined;
  }
}

/** Pull a short output summary from a tool event. */
function extractOutputSummary(event: any): string | undefined {
  const result = event?.result ?? event?.output ?? event?.toolResult;
  if (result == null) return undefined;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const content = result.content ?? result.stdout ?? result.text ?? result.message;
    if (typeof content === 'string') return content;
  }
  try {
    const s = JSON.stringify(result);
    return s.length > 200 ? s.substring(0, 200) + '...' : s;
  } catch {
    return undefined;
  }
}

/** Render recent observations as a compact recall block. */
export function summarizeForRecall(obs: Observation[]): string {
  if (obs.length === 0) return '';
  // Group by tool, show counts + the last input snippet per tool.
  const byTool = new Map<string, string[]>();
  for (const o of obs) {
    if (!byTool.has(o.tool)) byTool.set(o.tool, []);
    if (o.input) byTool.get(o.tool)!.push(o.input);
  }
  const lines: string[] = [];
  for (const [tool, inputs] of byTool) {
    const last = inputs[inputs.length - 1];
    lines.push(`- ${tool} ×${inputs.length}${last ? ` (last: ${last.substring(0, 80)})` : ''}`);
  }
  return lines.join('\n');
}

/** Render instincts as a compact recall block, hits-first. */
export function summarizeInstinctsForRecall(instincts: Instinct[]): string {
  if (instincts.length === 0) return '';
  return instincts
    .map((i) => `- ${i.text}${i.hits > 1 ? ` (×${i.hits})` : ''}`)
    .join('\n');
}

type HookRegistration = {
  on?: (name: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  registerHook?: (name: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
};

/**
 * TypeBox-style JSON Schema for instinct_record's parameters. Hand-written
 * literal rather than a @sinclair/typebox import: TypeBox schemas ARE plain
 * JSON Schema objects, the plugin process receives `api` untyped at runtime,
 * and zero dependencies is this package's posture. Shape verified against
 * openclaw 2026.7.1-2 SDK types (Tool<TSchema> / AgentTool).
 */
const INSTINCT_RECORD_PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The working pattern to remember, stated as an imperative (e.g. "run pnpm verify before claiming done")',
    },
    scope: {
      type: 'string',
      enum: ['project', 'global'],
      description: 'project = only this project; global = every project on this machine',
    },
  },
  required: ['text', 'scope'],
  additionalProperties: false,
} as const;

export function register(api: any): void {
  const registerHook = api as HookRegistration;
  const on = registerHook.on?.bind(api) ?? registerHook.registerHook?.bind(api);
  if (!on) {
    try { console.error('[instinct] hook registration API unavailable — disabled'); } catch { /* noop */ }
    return;
  }

  const cwd = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '.';
  const project = projectId(cwd);

  // ── Observer: capture tool calls ───────────────────────────────────────
  on('after_tool_call', (event: any, _ctx: any) => {
    const sessionKey = _ctx?.sessionKey;
    // Skip subagent branches (workflow workers) — their calls are the workflow's
    // internal steps, not user-context memory worth recalling.
    if (typeof sessionKey === 'string' && sessionKey.includes(':subagent:')) return;
    const toolName = typeof event?.toolName === 'string' ? event.toolName : 'unknown';
    appendObservation(
      {
        ts: Date.now(),
        tool: toolName,
        input: extractInputSummary(event),
        output: extractOutputSummary(event),
        project,
      },
      cwd,
    );
  });

  // ── Extractor: instinct_record tool ────────────────────────────────────
  // Agent-initiated recording beats prompt-side extraction: an agent that
  // calls the tool is confident by construction, and the prompt route's
  // failure mode (agent ignores the format → silent, unmeasurable loss)
  // never exists. Requires "contracts": { "tools": ["instinct_record"] } in
  // openclaw.plugin.json — the registry drops undeclared tool registrations.
  const registerTool = (api as { registerTool?: (tool: unknown, opts?: unknown) => void }).registerTool?.bind(api);
  if (typeof registerTool === 'function') {
    registerTool({
      name: 'instinct_record',
      label: 'Record instinct',
      description:
        'Record a durable working pattern for this project (or globally) so future sessions recall it. ' +
        'Use when you learn how this codebase works — build commands, conventions, pitfalls — not for task-specific notes.',
      parameters: INSTINCT_RECORD_PARAMETERS,
      execute: async (_toolCallId: string, params: { text: string; scope: 'project' | 'global' }) => {
        const text = typeof params?.text === 'string' ? params.text.trim() : '';
        const scope = params?.scope === 'global' ? 'global' : 'project';
        // An empty/whitespace text records nothing; reporting success would be
        // the silent-loss mode the tool route exists to prevent. Schema
        // `required` + `type: string` does not forbid ''.
        if (text.length === 0) {
          return {
            content: [{ type: 'text', text: 'ignored: empty text — nothing recorded' }],
            details: { ok: false, scope },
          };
        }
        const before = getWriteFailureCount();
        appendInstinct(cwd, { text, scope });
        const ok = getWriteFailureCount() === before;
        return {
          content: [{ type: 'text', text: ok ? `instinct recorded (${scope})` : 'instinct write failed (counted, not thrown)' }],
          details: { ok, scope },
        };
      },
    });
  } else {
    try { console.error('[instinct] registerTool unavailable — instinct_record disabled'); } catch { /* noop */ }
  }

  // ── Recall: two-part context at session start ──────────────────────────
  on('session_start', (_event: any, _ctx: any) => {
    // Purge here, not in the hot paths: the rewrite is O(file) and
    // session_start fires once per session. Both file families age out.
    purgeExpired(cwd);
    purgeExpired(cwd, { family: 'instincts' });
    const sections: string[] = [];
    // Part 1 — raw tail: "where the last session stopped".
    const recent = loadRecentObservations(cwd, 20, project);
    const raw = summarizeForRecall(recent);
    if (raw) {
      sections.push(`[instinct] Recent activity in this project (last ${recent.length} tool calls; a prior session):\n${raw}`);
    }
    // Part 2 — instincts: "how this project works". Separate section so each
    // trims to its own token budget; session_start is a shared-budget surface.
    const instincts = loadInstincts(cwd, 10, project);
    const distilled = summarizeInstinctsForRecall(instincts);
    if (distilled) {
      sections.push(`[instinct] Working patterns for this project (${instincts.length}; from prior sessions):\n${distilled}`);
    }
    if (sections.length === 0) return;
    return { appendContext: sections.join('\n\n') };
  });
}
