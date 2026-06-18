/**
 * TDD: R-11 command-runner — handle quoted arguments (paths with spaces).
 * Written BEFORE implementation.
 */
import { describe, it, expect } from 'vitest';

// Import the internal parser we'll expose
import { parseCommandArgs } from '../src/command-runner';

describe('R-11: parseCommandArgs — handles quoted paths with spaces', () => {
  it('splits simple command without quotes', () => {
    expect(parseCommandArgs('pnpm test')).toEqual(['pnpm', 'test']);
  });

  it('splits multi-word command', () => {
    expect(parseCommandArgs('go test ./...')).toEqual(['go', 'test', './...']);
  });

  it('handles double-quoted argument with spaces', () => {
    expect(parseCommandArgs('node "/path/with spaces/script.js"')).toEqual([
      'node',
      '/path/with spaces/script.js',
    ]);
  });

  it('handles single-quoted argument with spaces', () => {
    expect(parseCommandArgs("node '/path/with spaces/script.js'")).toEqual([
      'node',
      '/path/with spaces/script.js',
    ]);
  });

  it('handles multiple quoted arguments', () => {
    expect(parseCommandArgs('"my tool" "arg with spaces" plain')).toEqual([
      'my tool',
      'arg with spaces',
      'plain',
    ]);
  });

  it('handles Windows-style path in quotes', () => {
    expect(parseCommandArgs('"C:\\Program Files\\node\\node.exe" --version')).toEqual([
      'C:\\Program Files\\node\\node.exe',
      '--version',
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCommandArgs('')).toEqual([]);
    expect(parseCommandArgs('   ')).toEqual([]);
  });

  it('strips outer quotes but preserves inner content', () => {
    expect(parseCommandArgs('"hello world"')).toEqual(['hello world']);
  });
});
