/**
 * TDD: project-detector — auto-detect validation commands from workspace.
 * Written BEFORE implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { detectValidationCommands } from '../src/project-detector';
import type { ValidationCommand } from '../src/types';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-detect-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('detectValidationCommands', () => {
  it('returns empty array for empty directory', () => {
    expect(detectValidationCommands(tmpDir)).toEqual([]);
  });

  it('returns empty array for non-existent path', () => {
    expect(detectValidationCommands('/nonexistent/path/xyz')).toEqual([]);
  });

  describe('Node.js / package.json', () => {
    it('detects pnpm test when pnpm-lock.yaml present', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command.includes('pnpm'))).toBe(true);
    });

    it('detects npm test when package-lock.json present', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command.includes('npm'))).toBe(true);
    });

    it('detects yarn test when yarn.lock present', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command.includes('yarn'))).toBe(true);
    });

    it('falls back to npm test with only package.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.length).toBeGreaterThan(0);
    });

    it('skips test command if package.json has no test script', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-pkg' }));
      fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.every((c: ValidationCommand) => !c.command.includes('test'))).toBe(true);
    });
  });

  describe('Go', () => {
    it('detects go test ./... when go.mod present', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command === 'go test ./...')).toBe(true);
    });
  });

  describe('Rust', () => {
    it('detects cargo test when Cargo.toml present', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "my-crate"\n');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command === 'cargo test')).toBe(true);
    });
  });

  describe('Python', () => {
    it('detects pytest when pyproject.toml present', () => {
      fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest]\n');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command.includes('pytest'))).toBe(true);
    });

    it('detects pytest when requirements.txt present', () => {
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'pytest\nrequests\n');
      const cmds = detectValidationCommands(tmpDir);
      expect(cmds.some((c: ValidationCommand) => c.command.includes('pytest'))).toBe(true);
    });
  });

  describe('return shape', () => {
    it('each entry has id, command, timeoutMs, required fields', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module x\ngo 1.21\n');
      const cmds = detectValidationCommands(tmpDir);
      for (const cmd of cmds) {
        expect(typeof cmd.id).toBe('string');
        expect(cmd.id.length).toBeGreaterThan(0);
        expect(typeof cmd.command).toBe('string');
        expect(typeof cmd.timeoutMs).toBe('number');
        expect(cmd.timeoutMs).toBeGreaterThan(0);
        expect(typeof cmd.required).toBe('boolean');
      }
    });
  });
});
