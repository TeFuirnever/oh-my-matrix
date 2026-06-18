/**
 * M2.2 TDD Tests: Workflow config parser
 *
 * TDD: Written BEFORE implementation — expected to FAIL initially.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } from '../src/workflow-config';
import * as fs from 'fs';
import _path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockFs = vi.mocked(fs);

describe('workflow-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DEFAULT_WORKFLOW_CONFIG', () => {
    it('has version 1', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.version).toBe(1);
    });

    it('defaults maxConcurrent to 5', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.maxConcurrent).toBe(5);
    });

    it('defaults maxRetries to 3', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.maxRetries).toBe(3);
    });

    it('defaults stallTimeoutMs to 300000', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs).toBe(300000);
    });

    it('defaults workspace cleanup to manual', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.workspace.cleanup).toBe('manual');
    });

    it('defaults branchPrefix to autopilot', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.workspace.branchPrefix).toBe('autopilot');
    });

    it('defaults destructiveGit allow to false', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.destructiveGit.allow).toBe(false);
    });

    it('defaults source to default', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.source).toBe('default');
    });

    it('defaults validation commands to empty array', () => {
      expect(DEFAULT_WORKFLOW_CONFIG.validation.commands).toEqual([]);
    });
  });

  describe('loadWorkflowConfig', () => {
    it('returns default config when WORKFLOW.md does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = loadWorkflowConfig('/some/repo');
      expect(result.config.source).toBe('default');
      expect(result.warnings).toHaveLength(0);
    });

    it('parses valid WORKFLOW.md front matter', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  version: 1
  permission_mode: full_yolo
  max_concurrent: 3
  max_retries: 5
  stall_timeout_ms: 60000
  max_retry_backoff_ms: 120000
  workspace:
    root: .custom-worktrees
    cleanup: delete_on_done
    branch_prefix: auto
  validation:
    commands:
      - id: test
        command: pnpm test
        timeout_ms: 30000
        required: true
  destructive_git:
    allow: true
---

Continue the task.`);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.source).toBe('workflow_md');
      expect(result.config.maxConcurrent).toBe(3);
      expect(result.config.maxRetries).toBe(5);
      expect(result.config.stallTimeoutMs).toBe(60000);
      expect(result.config.workspace.root).toBe('.custom-worktrees');
      expect(result.config.workspace.cleanup).toBe('delete_on_done');
      expect(result.config.workspace.branchPrefix).toBe('auto');
      expect(result.config.validation.commands).toHaveLength(1);
      expect(result.config.validation.commands[0].id).toBe('test');
      expect(result.config.destructiveGit.allow).toBe(true);
    });

    it('handles missing version with warning', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  permission_mode: guarded_yolo
---

Continue.`);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.version).toBe(1);
      expect(result.warnings).toContainEqual(expect.stringContaining('version'));
    });

    it('handles invalid YAML gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  max_concurrent: "not a number"
---

Continue.`);

      // Should either fallback to default or last_valid, not crash
      const result = loadWorkflowConfig('/repo');
      expect(result.config).toBeDefined();
      expect(result.config.version).toBe(1);
    });

    it('produces warning for unknown fields', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  version: 1
  future_feature: true
---

Continue.`);

      const result = loadWorkflowConfig('/repo');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('future_feature'))).toBe(true);
    });

    it('defaults permission_mode to guarded_yolo when not specified', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  version: 1
---

Continue.`);

      loadWorkflowConfig('/repo');
    });

    it('parses validation commands with all fields', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  version: 1
  validation:
    commands:
      - id: typecheck
        command: pnpm run typecheck
        timeout_ms: 60000
        required: true
      - id: lint
        command: pnpm run lint
        timeout_ms: 30000
        required: false
    fail_on_optional: true
---

Continue.`);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.validation.commands).toHaveLength(2);
      expect(result.config.validation.commands[0].timeoutMs).toBe(60000);
      expect(result.config.validation.commands[0].required).toBe(true);
      expect(result.config.validation.commands[1].required).toBe(false);
      expect(result.config.validation.failOnOptional).toBe(true);
    });

    it('resolves relative workspace root against base repo path', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot:
  version: 1
  workspace:
    root: .matrix/worktrees
---

Continue.`);

      const result = loadWorkflowConfig('/home/user/myrepo');
      // The workspace root should be stored as-is (relative), resolved at usage time
      expect(result.config.workspace.root).toBe('.matrix/worktrees');
    });

    it('handles empty autopilot section with defaults', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`---
autopilot: {}
---

Just markdown body.`);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.maxConcurrent).toBe(5);
    });

    it('handles file with no front matter as missing config', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('This is just a regular markdown file with no YAML.');

      const result = loadWorkflowConfig('/repo');
      expect(result.config.source).toBe('default');
    });

    // ─── Cross-platform: CRLF line ending support (X-7, X-8) ─────────────
    // Windows editors and git (without autocrlf) produce CRLF (\r\n) line endings.
    // The YAML parser must handle CRLF the same as LF.

    it('parses WORKFLOW.md with CRLF line endings correctly (X-7)', () => {
      mockFs.existsSync.mockReturnValue(true);
      // Simulate Windows CRLF: replace all \n with \r\n
      const lf = `---\r\nautopilot:\r\n  version: 1\r\n  permission_mode: full_yolo\r\n  max_concurrent: 3\r\n  destructive_git:\r\n    allow: true\r\n---\r\n\r\nContinue.`;
      mockFs.readFileSync.mockReturnValue(lf);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.source).toBe('workflow_md');
      expect(result.config.maxConcurrent).toBe(3);
      expect(result.config.destructiveGit.allow).toBe(true);
    });

    it('parses CRLF front matter boundary correctly (X-8)', () => {
      mockFs.existsSync.mockReturnValue(true);
      // The front-matter regex /^---\s*\n/ must match CRLF-terminated --- lines
      const crlf = '---\r\nautopilot:\r\n  version: 1\r\n  permission_mode: guarded_yolo\r\n---\r\n\r\nBody.';
      mockFs.readFileSync.mockReturnValue(crlf);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.source).toBe('workflow_md');
    });

    it('parses CRLF validation commands correctly', () => {
      mockFs.existsSync.mockReturnValue(true);
      const crlf = [
        '---',
        'autopilot:',
        '  version: 1',
        '  validation:',
        '    commands:',
        '      - id: test',
        '        command: pnpm test',
        '        timeout_ms: 30000',
        '        required: true',
        '---',
        '',
        'Body.',
      ].join('\r\n');
      mockFs.readFileSync.mockReturnValue(crlf);

      const result = loadWorkflowConfig('/repo');
      expect(result.config.validation.commands).toHaveLength(1);
      expect(result.config.validation.commands[0].id).toBe('test');
      expect(result.config.validation.commands[0].timeoutMs).toBe(30000);
    });
  });
});
