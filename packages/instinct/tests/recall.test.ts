/**
 * instinct recall: summarizeForRecall + register hook wiring (mock API).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { register, summarizeForRecall } from '../index';
import { _resetForTest, type Observation } from '../src/store';

let dir: string;
const origCwd = process.cwd;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instinct-recall-'));
  process.cwd = () => dir;
  _resetForTest();
});
afterEach(() => {
  process.cwd = origCwd;
  rmSync(dir, { recursive: true, force: true });
});

function mockToolApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const tools: { name: string; label: string; execute: (id: string, params: unknown) => Promise<unknown> }[] = [];
  const api = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
    registerTool: (tool: { name: string; label: string; execute: unknown }) => tools.push(tool as never),
  };
  return { api, hooks, tools };
}

describe('summarizeForRecall', () => {
  it('groups by tool with counts + last input', () => {
    const obs: Observation[] = [
      { ts: 1, tool: 'Bash', input: 'pnpm test' },
      { ts: 2, tool: 'Read', input: 'src/index.ts' },
      { ts: 3, tool: 'Bash', input: 'pnpm build' },
    ];
    const out = summarizeForRecall(obs);
    expect(out).toContain('Bash ×2');
    expect(out).toContain('pnpm build');
    expect(out).toContain('Read ×1');
  });
  it('returns empty string for no observations', () => {
    expect(summarizeForRecall([])).toBe('');
  });
});

describe('register (hook wiring)', () => {
  function mockApi() {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const api = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
    };
    return { api, hooks };
  }

  it('registers after_tool_call and session_start hooks', () => {
    const { api, hooks } = mockApi();
    register(api);
    expect(hooks.has('after_tool_call')).toBe(true);
    expect(hooks.has('session_start')).toBe(true);
  });

  it('observer captures a tool call (scrubbed) to disk', () => {
    const { api, hooks } = mockApi();
    register(api);
    hooks.get('after_tool_call')!(
      { toolName: 'Bash', params: { command: 'api_token=ghp_aaaaaaaaaaaaaaaa1234' } },
      { sessionKey: 'agent:main' },
    );
    // session_start recall surfaces it (scrubbed)
    const recall = hooks.get('session_start')!({}, { sessionKey: 'agent:main' }) as {
      appendContext?: string;
    } | void;
    expect(recall?.appendContext).toBeTruthy();
    expect(recall!.appendContext).not.toContain('ghp_');
  });

  it('observer skips :subagent: sessions', () => {
    const { api, hooks } = mockApi();
    register(api);
    hooks.get('after_tool_call')!(
      { toolName: 'Bash', params: { command: 'echo hi' } },
      { sessionKey: 'agent:main:subagent:abc' },
    );
    // nothing recalled
    expect(hooks.get('session_start')!({}, {})).toBeUndefined();
  });

  it('session_start returns undefined when no observations exist', () => {
    const { api, hooks } = mockApi();
    register(api);
    expect(hooks.get('session_start')!({}, {})).toBeUndefined();
  });

  it('session_start purges observations older than 30 days before recalling', () => {
    const file = join(dir, '.instinct', 'observations.jsonl');
    mkdirSync(join(dir, '.instinct'), { recursive: true });
    const now = Date.now();
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: now - 31 * 24 * 60 * 60 * 1000, tool: 'Expired', input: 'old', project: 'unknown' }),
        JSON.stringify({ ts: now, tool: 'Fresh', input: 'new', project: 'unknown' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const { api, hooks } = mockApi();
    register(api); // no .git in the temp dir → projectId === 'unknown'
    const recall = hooks.get('session_start')!({}, {}) as { appendContext?: string } | void;

    expect(recall?.appendContext).toContain('Fresh');
    expect(recall!.appendContext).not.toContain('Expired');
    // Dropped from disk, not merely filtered out of the recall block.
    expect(readFileSync(file, 'utf-8')).not.toContain('Expired');
  });

  it('session_start emits two independent sections when both stores have content', () => {
    const { api, hooks, tools } = mockToolApi();
    register(api);
    hooks.get('after_tool_call')!({ toolName: 'Bash', params: { command: 'pnpm test' } }, { sessionKey: 'agent:main' });
    void (tools[0] as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call-1', {
      text: 'run pnpm verify before claiming done',
      scope: 'project',
    });

    const recall = hooks.get('session_start')!({}, {}) as { appendContext?: string };
    const ctx = recall.appendContext!;
    // Two separately-trimmable sections, in fixed order.
    const [rawSection, instinctSection] = ctx.split('\n\n');
    expect(rawSection).toContain('Recent activity');
    expect(rawSection).toContain('Bash ×1');
    expect(instinctSection).toContain('Working patterns');
    expect(instinctSection).toContain('run pnpm verify');
  });

  it('session_start emits only the instinct section when there is no raw activity', () => {
    const { api, hooks, tools } = mockToolApi();
    register(api);
    void (tools[0] as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call-1', {
      text: 'global pattern',
      scope: 'global',
    });

    const recall = hooks.get('session_start')!({}, {}) as { appendContext?: string };
    expect(recall.appendContext).toContain('Working patterns');
    expect(recall.appendContext).not.toContain('Recent activity');
  });
});

describe('register (instinct_record tool wiring)', () => {
  it('registers instinct_record with the SDK tool contract shape', () => {
    const { api, tools } = mockToolApi();
    register(api);
    expect(tools).toHaveLength(1);
    const tool = tools[0] as { name: string; label: string; description: string; parameters: Record<string, unknown> };
    // AgentTool contract (openclaw 2026.7.1-2): name + label + description +
    // parameters schema + async execute returning {content:[{type:'text'}], details}.
    expect(tool.name).toBe('instinct_record');
    expect(typeof tool.label).toBe('string');
    expect(tool.description.length).toBeGreaterThan(20);
    const props = (tool.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.scope.enum).toEqual(['project', 'global']);
  });

  it('execute persists the instinct and returns text content', async () => {
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await (tools[0] as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call-1', {
      text: 'never skip typecheck',
      scope: 'project',
    })) as { content: { type: string; text: string }[]; details: unknown };
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('recorded');
    const file = join(dir, '.instinct', 'instincts.jsonl');
    const stored = JSON.parse(readFileSync(file, 'utf-8'));
    expect(stored.text).toBe('never skip typecheck');
  });

  it('degrades gracefully when registerTool is unavailable (hooks still work)', () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const api = { on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => register(api)).not.toThrow(); // no registerTool on api
      // Degradation is announced, not silent — same posture as missing hooks.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('registerTool unavailable'));
    } finally {
      errSpy.mockRestore();
    }
    expect(hooks.has('after_tool_call')).toBe(true); // observer unaffected
    expect(hooks.has('session_start')).toBe(true); // recall unaffected
  });

  it('execute refuses empty text honestly instead of reporting success', async () => {
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await (tools[0] as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call-1', {
      text: '   ',
      scope: 'project',
    })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(result.details.ok).toBe(false);
    expect(result.content[0].text).toContain('nothing recorded');
    expect(existsSync(join(dir, '.instinct'))).toBe(false); // no store materialized
  });

  it('execute reports write failure honestly (failure counter moved)', async () => {
    writeFileSync(join(dir, '.instinct'), 'not a directory'); // append path unwritable
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await (tools[0] as { execute: (id: string, p: unknown) => Promise<unknown> }).execute('call-1', {
      text: 'real pattern',
      scope: 'project',
    })) as { content: { text: string }[]; details: { ok: boolean } };
    expect(result.details.ok).toBe(false);
    expect(result.content[0].text).toContain('write failed');
  });
});
