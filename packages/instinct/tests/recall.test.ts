/**
 * instinct recall: rendering + register hook/tool wiring (mock API).
 *
 * Recall fires at agent_turn_prepare — the host discards session_start return
 * values (declared `=> void`) and honors {appendContext} only from the four
 * prompt-injection hooks. session_start keeps the purge only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { register, summarizeForRecall } from '../index';
import { _resetForTest, type Observation } from '../src/store';

let dir: string;
let keySeq = 0;
const nextKey = (): string => `sess-test-${Date.now()}-${++keySeq}`;
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

type Tool = { name: string; label: string; description: string; parameters: Record<string, unknown>; execute: (id: string, params: unknown) => Promise<unknown> };

function mockToolApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const tools: Tool[] = [];
  const api = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
    // registerTool accepts a tool OR a factory (ctx => tool); resolve either.
    registerTool: (t: unknown) => tools.push((typeof t === 'function' ? (t as (ctx: unknown) => Tool)({ workspaceDir: dir }) : t) as Tool),
  };
  return { api, hooks, tools };
}

describe('summarizeForRecall', () => {
  it('groups by tool with counts + last input, flattened to one line', () => {
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
  it('flattens multi-line snippets so blank lines cannot forge section breaks', () => {
    const out = summarizeForRecall([{ ts: 1, tool: 'Bash', input: 'cd pkg\n\npnpm test' }]);
    expect(out).not.toContain('\n\n');
    expect(out).toContain('cd pkg pnpm test');
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

  it('registers observer, recall, purge and cleanup hooks', () => {
    const { api, hooks } = mockApi();
    register(api);
    for (const h of ['after_tool_call', 'agent_turn_prepare', 'session_start', 'session_end']) {
      expect(hooks.has(h)).toBe(true);
    }
  });

  it('observer captures a tool call (scrubbed) to disk, honoring ctx.workspaceDir', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'instinct-ws-'));
    try {
      const { api, hooks } = mockApi();
      register(api);
      hooks.get('after_tool_call')!(
        { toolName: 'Bash', params: { command: 'api_token=ghp_aaaaaaaaaaaaaaaa1234' } },
        { sessionKey: 'agent:main', workspaceDir: otherDir },
      );
      // Wrote to the ctx workspace, not the mocked cwd.
      const stored = readFileSync(join(otherDir, '.instinct', 'observations.jsonl'), 'utf-8');
      expect(stored).toContain('REDACTED');
      expect(stored).not.toContain('ghp_');
      // Recall from that workspace surfaces it (scrubbed).
      const recall = hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey(), workspaceDir: otherDir }) as {
        appendContext?: string;
      };
      expect(recall?.appendContext).toBeTruthy();
      expect(recall.appendContext).not.toContain('ghp_');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('observer skips :subagent: sessions', () => {
    const { api, hooks } = mockApi();
    register(api);
    hooks.get('after_tool_call')!(
      { toolName: 'Bash', params: { command: 'echo hi' } },
      { sessionKey: 'agent:main:subagent:abc' },
    );
    expect(hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey() })).toBeUndefined();
  });

  it('agent_turn_prepare returns undefined when both stores are empty', () => {
    const { api, hooks } = mockApi();
    register(api);
    expect(hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey() })).toBeUndefined();
  });

  it('recall injects once per session, then again after session_end', () => {
    const { api, hooks } = mockToolApi();
    register(api);
    hooks.get('after_tool_call')!({ toolName: 'Bash', params: { command: 'pnpm test' } }, { sessionKey: 'agent:main' });
    const k = nextKey();
    const other = nextKey();
    void (hooks.get('agent_turn_prepare') as (e: unknown, c: unknown) => unknown)({}, { sessionKey: k });
    // Second turn of the same session: no duplicate injection.
    expect(hooks.get('agent_turn_prepare')!({}, { sessionKey: k })).toBeUndefined();
    // A different session still gets it.
    expect((hooks.get('agent_turn_prepare')!({}, { sessionKey: other }) as { appendContext?: string }).appendContext).toBeTruthy();
    // session_end frees the slot — a new run of the same key injects again.
    hooks.get('session_end')!({}, { sessionKey: k });
    expect((hooks.get('agent_turn_prepare')!({}, { sessionKey: k }) as { appendContext?: string }).appendContext).toBeTruthy();
  });

  it('session_start only purges — its return value is discarded by the host', () => {
    const { api, hooks } = mockToolApi();
    register(api);
    hooks.get('after_tool_call')!({ toolName: 'Bash', params: { command: 'x' } }, { sessionKey: 'a:main' });
    // Void hook: whatever it returns, the host drops it; it must be side-effect only.
    expect(hooks.get('session_start')!({}, {})).toBeUndefined();
  });

  it('session_start purges observations older than 30 days before recall reads them', () => {
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
    hooks.get('session_start')!({}, {}); // purge fires here
    const recall = hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey() }) as { appendContext?: string } | void;

    expect(recall?.appendContext).toContain('Fresh');
    expect(recall!.appendContext).not.toContain('Expired');
    // Dropped from disk, not merely filtered out of the recall block.
    expect(readFileSync(file, 'utf-8')).not.toContain('Expired');
  });

  it('recall emits two independent sections when both stores have content', async () => {
    const { api, hooks, tools } = mockToolApi();
    register(api);
    hooks.get('after_tool_call')!({ toolName: 'Bash', params: { command: 'pnpm test' } }, { sessionKey: 'agent:main' });
    await tools[0].execute('call-1', { text: 'run pnpm verify before claiming done', scope: 'project' });

    const recall = hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey() }) as { appendContext?: string };
    const ctx = recall.appendContext!;
    // Two separately-trimmable sections, in fixed order.
    const [rawSection, instinctSection] = ctx.split('\n\n');
    expect(rawSection).toContain('Recent activity');
    expect(rawSection).toContain('Bash ×1');
    expect(instinctSection).toContain('Working patterns');
    expect(instinctSection).toContain('run pnpm verify');
  });

  it('recall emits only the instinct section when there is no raw activity', async () => {
    const { api, hooks, tools } = mockToolApi();
    register(api);
    await tools[0].execute('call-1', { text: 'global pattern', scope: 'global' });

    const recall = hooks.get('agent_turn_prepare')!({}, { sessionKey: nextKey() }) as { appendContext?: string };
    expect(recall.appendContext).toContain('Working patterns');
    expect(recall.appendContext).not.toContain('Recent activity');
  });
});

describe('register (instinct_record tool wiring)', () => {
  it('registers instinct_record via the factory with the SDK tool contract shape', () => {
    const { api, tools } = mockToolApi();
    register(api);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    // AgentTool contract (openclaw 2026.7.1-2): name + label + description +
    // parameters schema + async execute returning {content:[{type:'text'}], details}.
    expect(tool.name).toBe('instinct_record');
    expect(typeof tool.label).toBe('string');
    expect(tool.description.length).toBeGreaterThan(20);
    const props = (tool.parameters as { properties: Record<string, { enum?: string[]; maxLength?: number }> }).properties;
    expect(props.scope.enum).toEqual(['project', 'global']);
    expect(props.text.maxLength).toBeGreaterThan(0);
  });

  it('execute persists the instinct (factory ctx workspaceDir) and returns text content', async () => {
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await tools[0].execute('call-1', { text: 'never skip typecheck', scope: 'project' })) as {
      content: { type: string; text: string }[];
      details: { ok: boolean };
    };
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('recorded');
    // Written to the FACTORY's workspaceDir (dir), not bare process.cwd().
    const stored = JSON.parse(readFileSync(join(dir, '.instinct', 'instincts.jsonl'), 'utf-8'));
    expect(stored.text).toBe('never skip typecheck');
  });

  it('execute reports reinforcement honestly on a dedup hit', async () => {
    const { api, tools } = mockToolApi();
    register(api);
    await tools[0].execute('call-1', { text: 'same pattern', scope: 'project' });
    const result = (await tools[0].execute('call-2', { text: 'same pattern', scope: 'project' })) as {
      content: { text: string }[];
      details: { ok: boolean; status: string; hits: number };
    };
    expect(result.details.ok).toBe(true);
    expect(result.details.status).toBe('hit');
    expect(result.details.hits).toBe(2);
    expect(result.content[0].text).toContain('×2');
  });

  it('execute refuses empty text honestly instead of reporting success', async () => {
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await tools[0].execute('call-1', { text: '   ', scope: 'project' })) as {
      content: { text: string }[];
      details: { ok: boolean };
    };
    expect(result.details.ok).toBe(false);
    expect(result.content[0].text).toContain('nothing recorded');
    expect(existsSync(join(dir, '.instinct'))).toBe(false); // no store materialized
  });

  it('execute reports write failure honestly', async () => {
    writeFileSync(join(dir, '.instinct'), 'not a directory'); // append path unwritable
    const { api, tools } = mockToolApi();
    register(api);
    const result = (await tools[0].execute('call-1', { text: 'real pattern', scope: 'project' })) as {
      content: { text: string }[];
      details: { ok: boolean; status: string };
    };
    expect(result.details.ok).toBe(false);
    expect(result.details.status).toBe('failed');
    expect(result.content[0].text).toContain('write failed');
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
    expect(hooks.has('agent_turn_prepare')).toBe(true); // recall unaffected
  });
});
