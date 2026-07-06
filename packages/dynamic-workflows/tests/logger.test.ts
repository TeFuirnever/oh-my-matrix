/**
 * TDD: structured logger safety rail — written BEFORE the DEC-2 fix.
 *
 * Regression guard for docs/design/autopilot-dynamic-workflows-boundary.md §5.2 (DEC-2):
 * the guard plugin's `before_tool_call` handler is fail-closed, so the logger must
 * never throw into it. A throw from `emitJson` (circular ref / BigInt in ctx) would
 * be caught by the handler's catch and converted to a mis-block of a legitimate
 * subagent tool call. Mirrors autopilot's `p0-structured-logger.test.ts` shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('logger — JSON format mode', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT;
    process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT = 'json';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT;
    else process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT = originalEnv;
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  it('outputs valid JSON when DYNAMIC_WORKFLOWS_LOG_FORMAT=json', async () => {
    const { log } = await import('../src/logger');
    log('[dynamic-workflows] test message');
    expect(consoleSpy).toHaveBeenCalled();
    const arg = consoleSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(arg)).not.toThrow();
  });

  it('JSON output contains ts, level, msg fields', async () => {
    const { log } = await import('../src/logger');
    log('hello world');
    const arg = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(typeof parsed.ts).toBe('number');
    expect(parsed.level).toBe('info');
    expect(typeof parsed.msg).toBe('string');
    expect(parsed.msg).toContain('hello world');
  });

  it('warn level produces level="warn" in JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { warn } = await import('../src/logger');
    warn('something wrong');
    const arg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('warn');
    warnSpy.mockRestore();
  });

  it('error level produces level="error" in JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await import('../src/logger');
    error('boom');
    const arg = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('error');
    errorSpy.mockRestore();
  });

  it('preserves object arg structure into ctx fields (not [object Object])', async () => {
    const { log } = await import('../src/logger');
    log('tool blocked', { sessionKey: 'sk-9', runId: 'run-9' });
    const arg = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toContain('tool blocked');
    expect(parsed.sessionKey).toBe('sk-9');
    expect(parsed.runId).toBe('run-9');
    expect(arg).not.toContain('[object Object]');
  });

  // ── DEC-2 regression via the variadic path (log → splitArgs → emitJson) ──────
  // logWithContext bypasses splitArgs; this sibling case proves the throw-safety
  // invariant also holds when an object arg flows through splitArgs into emitJson,
  // so a future change to splitArgs cannot re-open the mis-block path.
  it('log() does not throw on a circular object arg (splitArgs → emitJson path)', async () => {
    const { log } = await import('../src/logger');
    const circular: Record<string, unknown> = { sessionKey: 'sk-via-variadic' };
    circular.self = circular;
    expect(() => log('blocked via variadic', circular)).not.toThrow();
    const arg = consoleSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(arg)).not.toThrow();
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('blocked via variadic');
    expect(parsed.ctxError).toBe('unserializable');
  });
});

describe('logger — logWithContext (the DEC-2 throw path)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT = 'json';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT;
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  it('logWithContext merges ctx fields into JSON output', async () => {
    const { logWithContext } = await import('../src/logger');
    logWithContext('info', 'test event', { sessionKey: 'sk-123', runId: 'run-abc', tokens: 42 });
    const arg = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.sessionKey).toBe('sk-123');
    expect(parsed.runId).toBe('run-abc');
    expect(parsed.tokens).toBe(42);
    expect(parsed.msg).toBe('test event');
    expect(parsed.level).toBe('info');
  });

  // ── DEC-2 regression: this is the failing-first test ──────────────────────────
  // A circular reference in ctx makes JSON.stringify throw. Because the DW guard's
  // before_tool_call handler is fail-closed, that throw would be swallowed by the
  // handler's catch and converted to a mis-block of a legitimate subagent call.
  it('does not throw on a circular context object (logger must never crash a guard hook)', async () => {
    const { logWithContext } = await import('../src/logger');
    const circular: Record<string, unknown> = { sessionKey: 'sk-1', reason: 'test' };
    circular.self = circular;
    expect(() => logWithContext('info', 'before_tool_call BLOCKED', circular)).not.toThrow();
    const arg = consoleSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(arg)).not.toThrow(); // still valid JSON via fallback
  });

  it('does not throw on a BigInt in context (logger must never crash a guard hook)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { logWithContext } = await import('../src/logger');
    const ctx = { sessionKey: 'sk-2', bigValue: BigInt(123) };
    expect(() => logWithContext('warn', 'bigint ctx', ctx)).not.toThrow();
    const arg = warnSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(arg)).not.toThrow();
    warnSpy.mockRestore();
  });

  it('fallback record on unserializable ctx retains level + msg + ctxError marker', async () => {
    const { logWithContext } = await import('../src/logger');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    logWithContext('info', 'will-fallback', circular);
    const arg = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('will-fallback');
    expect(parsed.ctxError).toBe('unserializable');
  });

  it('logWithContext works in text mode without throwing', async () => {
    delete process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT;
    const { logWithContext } = await import('../src/logger');
    expect(() => logWithContext('warn', 'text mode warn', { key: 'val' })).not.toThrow();
  });
});

describe('logger — text mode backward compat', () => {
  beforeEach(() => {
    delete process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT;
    vi.resetModules();
  });

  it('text mode: log calls console.log with string args', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { log } = await import('../src/logger');
    log('[dynamic-workflows] some message');
    expect(spy).toHaveBeenCalledWith('[dynamic-workflows] some message');
    spy.mockRestore();
  });

  it('text mode: output is NOT valid JSON', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { log } = await import('../src/logger');
    log('plain text message');
    const arg = spy.mock.calls[0][0] as string;
    // Plain text should not be parseable as structured JSON with ts
    expect(() => {
      const parsed = JSON.parse(arg);
      if (typeof parsed !== 'object' || !('ts' in parsed)) throw new Error('not structured');
    }).toThrow();
    spy.mockRestore();
  });
});
