/**
 * @oh-my-matrix/instinct — cross-session context memory (third-gap closure).
 *
 * Two hooks form the minimal closed loop:
 *  - after_tool_call (observer): captures a scrubbed {tool, input, output}
 *    summary to .instinct/observations.jsonl (rotated, secret-scrubbed).
 *  - session_start (recall): injects the most recent observations for this
 *    project as appendContext, so a new session resumes with what the last
 *    one did.
 *
 * Instinct extraction (promote/evolve raw observations into reusable patterns)
 * is a later phase — this ships the memory substrate + recall, not the LLM
 * distillation (which needs a cheap-agent primitive the plugin process lacks).
 */
import { appendObservation, loadRecentObservations, projectId, type Observation } from './src/store';

export { appendObservation, loadRecentObservations, projectId, scrubSecrets } from './src/store';
export type { Observation } from './src/store';

export const id = 'instinct';
export const name = 'Instinct (context memory)';
export const version = '0.1.0';

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

export function register(api: any): void {
  const registerHook = api as { on?: Function; registerHook?: Function };
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

  // ── Recall: inject recent observations at session start ────────────────
  on('session_start', (_event: any, _ctx: any) => {
    const recent = loadRecentObservations(cwd, 20, project);
    if (recent.length === 0) return;
    const summary = summarizeForRecall(recent);
    if (!summary) return;
    return {
      appendContext: `[instinct] Recent activity in this project (last ${recent.length} tool calls; a prior session):\n${summary}`,
    };
  });
}
