/**
 * instinct recall: summarizeForRecall + register hook wiring (mock API).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
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
});
