/**
 * TDD: structured logger — written BEFORE implementation.
 * Tests for AUTOPILOT_LOG_FORMAT=json mode and logWithContext.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('logger — JSON format mode', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AUTOPILOT_LOG_FORMAT;
    process.env.AUTOPILOT_LOG_FORMAT = 'json';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AUTOPILOT_LOG_FORMAT;
    else process.env.AUTOPILOT_LOG_FORMAT = originalEnv;
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  it('outputs valid JSON when AUTOPILOT_LOG_FORMAT=json', async () => {
    const { log } = await import('../src/logger');
    log('[autopilot] test message session=s1');
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
});

describe('logger — logWithContext', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.AUTOPILOT_LOG_FORMAT = 'json';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.AUTOPILOT_LOG_FORMAT;
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

  it('logWithContext works in text mode without throwing', async () => {
    delete process.env.AUTOPILOT_LOG_FORMAT;
    const { logWithContext } = await import('../src/logger');
    expect(() => logWithContext('warn', 'text mode warn', { key: 'val' })).not.toThrow();
  });
});

describe('logger — text mode backward compat', () => {
  beforeEach(() => {
    delete process.env.AUTOPILOT_LOG_FORMAT;
    vi.resetModules();
  });

  it('text mode: log calls console.log with string args', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { log } = await import('../src/logger');
    log('[autopilot] some message');
    expect(spy).toHaveBeenCalledWith('[autopilot] some message');
    spy.mockRestore();
  });

  it('text mode: output is NOT valid JSON', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { log } = await import('../src/logger');
    log('plain text message');
    const arg = spy.mock.calls[0][0] as string;
    // Plain text should not be parseable as JSON (no wrapping in {})
    expect(() => {
      const parsed = JSON.parse(arg);
      if (typeof parsed !== 'object' || !('ts' in parsed)) throw new Error('not structured');
    }).toThrow();
    spy.mockRestore();
  });
});
