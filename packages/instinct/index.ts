/**
 * @oh-my-matrix/instinct — cross-session context memory (third-gap closure).
 *
 * Three surfaces form the loop:
 *  - after_tool_call (observer): captures a scrubbed {tool, input, output}
 *    summary to .instinct/observations.jsonl (rotated, secret-scrubbed).
 *  - instinct_record (tool): the main agent records a distilled working
 *    pattern to .instinct/instincts.jsonl (exact-text dedup, hits counted).
 *  - agent_turn_prepare (recall): ONCE per session, purges both families past
 *    30 days, then injects a two-part appendContext — raw activity tail
 *    ("where the last session stopped") + instincts ("how this project
 *    works"), each independently trimmable for the shared token budget.
 *
 * Recall fires at agent_turn_prepare, NOT session_start: the host discards
 * session_start return values (openclaw declares it `=> void` and dispatches
 * fire-and-forget), and honors {appendContext} only from the four
 * PROMPT_INJECTION_HOOKS. session_start keeps the purge (a side effect —
 * exactly what a void hook is for).
 */
import {
  appendInstinct,
  appendObservation,
  INSTINCTS_FAMILY,
  loadInstincts,
  loadRecentObservations,
  projectId,
  purgeExpired,
  type Instinct,
  type InstinctAppendOutcome,
  type Observation,
} from './src/store';

export {
  appendInstinct,
  appendObservation,
  INSTINCTS_FAMILY,
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

/**
 * Render recent observations as a compact recall block. Snippets are flattened
 * to single lines: the two recall sections are joined on '\n\n', and a
 * multi-line command containing a blank line would otherwise forge a section
 * boundary inside a section.
 */
export function summarizeForRecall(obs: Observation[]): string {
  const flat = (s: string): string => s.replace(/\s*\n\s*/g, ' ');
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
    lines.push(`- ${tool} ×${inputs.length}${last ? ` (last: ${flat(last.substring(0, 80))})` : ''}`);
  }
  return lines.join('\n');
}

/** Render instincts as a compact recall block, hits-first, single-line texts. */
export function summarizeInstinctsForRecall(instincts: Instinct[]): string {
  if (instincts.length === 0) return '';
  return instincts
    .map((i) => `- ${i.text.replace(/\s*\n\s*/g, ' ')}${i.hits > 1 ? ` (×${i.hits})` : ''}`)
    .join('\n');
}

/**
 * TypeBox-style JSON Schema for instinct_record's parameters. Hand-written
 * literal rather than a @sinclair/typebox import: TypeBox schemas ARE plain
 * JSON Schema objects, the plugin process receives `api` untyped at runtime,
 * and zero dependencies is this package's posture. Shape verified against
 * openclaw 2026.7.1-2 SDK types (Tool<TSchema> / AgentTool). maxLength is a
 * hard cap: the store pre-caps too, but the schema's rejection gives the
 * agent an actionable error instead of a silent truncation.
 */
const INSTINCT_RECORD_PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      maxLength: 2000,
      description: 'The working pattern to remember, stated as an imperative (e.g. "run pnpm verify before claiming done")',
    },
    scope: {
      type: 'string',
      enum: ['project', 'global'],
      description:
        'project = only this project; global = earmarked for cross-project recall (stores are per-project today; ' +
        'global instincts are recalled by later sessions of THIS project until sharing lands)',
    },
  },
  required: ['text', 'scope'],
  additionalProperties: false,
} as const;

type HookRegistration = {
  on?: (name: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  registerHook?: (name: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
};

/** Sessions already carrying a recall injection (one shot per session). */
const recalledSessions = new Set<string>();

function registerObserver(on: NonNullable<HookRegistration['on']>): void {
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
        project: projectId(_ctx?.workspaceDir ?? process.cwd()),
      },
      _ctx?.workspaceDir ?? process.cwd(),
    );
  });
}

/**
 * Build the two-section appendContext, or undefined when both stores are
 * empty. Sections are independently trimmable: different time scales, and
 * agent_turn_prepare is a shared token-budget surface.
 */
function buildRecallContext(workspaceDir: string, project: string): { appendContext: string } | undefined {
  const sections: string[] = [];
  const recent = loadRecentObservations(workspaceDir, 20, project);
  const raw = summarizeForRecall(recent);
  if (raw) {
    sections.push(`[instinct] Recent activity in this project (last ${recent.length} tool calls; a prior session):\n${raw}`);
  }
  const instincts = loadInstincts(workspaceDir, 10, project);
  const distilled = summarizeInstinctsForRecall(instincts);
  if (distilled) {
    sections.push(`[instinct] Working patterns for this project (${instincts.length}; from prior sessions):\n${distilled}`);
  }
  if (sections.length === 0) return undefined;
  return { appendContext: sections.join('\n\n') };
}

function registerRecall(on: NonNullable<HookRegistration['on']>): void {
  on('agent_turn_prepare', (_event: any, ctx: any) => {
    const sessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : 'unknown-session';
    // One injection per session: the recall block answers "what did previous
    // sessions leave here", which does not change between turns of one session.
    if (recalledSessions.has(sessionKey)) return;
    recalledSessions.add(sessionKey);
    const workspaceDir = ctx?.workspaceDir ?? process.cwd();
    return buildRecallContext(workspaceDir, projectId(workspaceDir));
  });
  on('session_end', (_event: any, ctx: any) => {
    // Keep the one-shot set bounded across a long-lived gateway process.
    if (typeof ctx?.sessionKey === 'string') recalledSessions.delete(ctx.sessionKey);
  });
  on('session_start', (_event: any, _ctx: any) => {
    // Purge only — a side effect. This hook's return value is discarded by the
    // host (declared `=> void`); context injection lives in agent_turn_prepare.
    const workspaceDir = _ctx?.workspaceDir ?? process.cwd();
    purgeExpired(workspaceDir);
    purgeExpired(workspaceDir, { family: INSTINCTS_FAMILY });
  });
}

/** Translate the store's outcome into the tool result the agent sees. */
function instinctRecordResult(outcome: InstinctAppendOutcome): {
  content: { type: 'text'; text: string }[];
  details: { ok: boolean } & Partial<InstinctAppendOutcome>;
} {
  switch (outcome.status) {
    case 'written':
      return {
        content: [{ type: 'text', text: `instinct recorded (${outcome.scope})` }],
        details: { ok: true, ...outcome },
      };
    case 'hit':
      return {
        content: [{ type: 'text', text: `instinct reinforced (${outcome.scope}, now ×${outcome.hits})` }],
        details: { ok: true, ...outcome },
      };
    case 'empty':
      return {
        content: [{ type: 'text', text: 'ignored: empty text — nothing recorded' }],
        details: { ok: false, status: 'empty' },
      };
    case 'failed':
      return {
        content: [{ type: 'text', text: 'instinct write failed (counted, not thrown)' }],
        details: { ok: false, status: 'failed' },
      };
  }
}

function registerExtractor(api: unknown): void {
  // Agent-initiated recording beats prompt-side extraction: an agent that
  // calls the tool is confident by construction, and the prompt route's
  // failure mode (agent ignores the format → silent, unmeasurable loss)
  // never exists. Requires "contracts": { "tools": ["instinct_record"] } in
  // openclaw.plugin.json — the registry drops undeclared tool registrations.
  const registerTool = (api as { registerTool?: (tool: unknown, opts?: unknown) => void }).registerTool?.bind(api);
  if (typeof registerTool !== 'function') {
    try { console.error('[instinct] registerTool unavailable — instinct_record disabled'); } catch { /* noop */ }
    return;
  }
  // Factory form: the factory's ctx (OpenClawPluginToolContext) carries the
  // run's real workspaceDir, which execute's own arguments do not.
  registerTool((ctx: { workspaceDir?: string } | undefined) => ({
    name: 'instinct_record',
    label: 'Record instinct',
    description:
      'Record a durable working pattern for this project so future sessions recall it. ' +
      'Use when you learn how this codebase works — build commands, conventions, pitfalls — not for task-specific notes.',
    parameters: INSTINCT_RECORD_PARAMETERS,
    execute: async (_toolCallId: string, params: { text: string; scope: 'project' | 'global' }) => {
      const scope = params?.scope === 'global' ? 'global' : 'project';
      const workspaceDir = ctx?.workspaceDir ?? process.cwd();
      const outcome = appendInstinct(workspaceDir, { text: params?.text ?? '', scope });
      return instinctRecordResult(outcome);
    },
  }));
}

export function register(api: any): void {
  const registerHook = api as HookRegistration;
  const on = registerHook.on?.bind(api) ?? registerHook.registerHook?.bind(api);
  if (!on) {
    try { console.error('[instinct] hook registration API unavailable — disabled'); } catch { /* noop */ }
    return;
  }
  registerObserver(on);
  registerRecall(on);
  registerExtractor(api);
}
