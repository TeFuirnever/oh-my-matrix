/**
 * R-3: Project type auto-detection for Evidence Gate validation commands.
 *
 * Inspects the workspace root for known project files and returns
 * a default set of ValidationCommand entries appropriate for the project.
 * Returns empty array if no recognizable project type is found.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ValidationCommand } from './types';

function readJsonSafe(filePath: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Detect validation commands for the given workspace directory.
 * Checks for package.json (Node), go.mod (Go), Cargo.toml (Rust),
 * pyproject.toml / requirements.txt (Python).
 */
export function detectValidationCommands(workspaceDir: string): ValidationCommand[] {
  try {
    if (!fs.existsSync(workspaceDir)) return [];
  } catch { return []; }

  const commands: ValidationCommand[] = [];

  // ── Node.js ──────────────────────────────────────────────────────────────
  const pkgPath = path.join(workspaceDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJsonSafe(pkgPath);
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const hasTestScript = typeof scripts.test === 'string';

    // Detect package manager.
    // The bare name (npm/pnpm/yarn) is emitted uniformly; command-runner's
    // conditional shell (X-15) resolves .cmd wrappers on Windows automatically.
    let pm = 'npm';
    if (fs.existsSync(path.join(workspaceDir, 'pnpm-lock.yaml'))) pm = 'pnpm';
    else if (fs.existsSync(path.join(workspaceDir, 'yarn.lock'))) pm = 'yarn';

    if (hasTestScript) {
      commands.push({
        id: 'node-test',
        command: `${pm} test`,
        timeoutMs: 120_000,
        required: true,
      });
    }
  }

  // ── Go ────────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workspaceDir, 'go.mod'))) {
    commands.push({
      id: 'go-test',
      command: 'go test ./...',
      timeoutMs: 120_000,
      required: true,
    });
  }

  // ── Rust ─────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(workspaceDir, 'Cargo.toml'))) {
    commands.push({
      id: 'cargo-test',
      command: 'cargo test',
      timeoutMs: 180_000,
      required: true,
    });
  }

  // ── Python ───────────────────────────────────────────────────────────────
  const hasPyproject = fs.existsSync(path.join(workspaceDir, 'pyproject.toml'));
  const hasRequirements = fs.existsSync(path.join(workspaceDir, 'requirements.txt'));
  if (hasPyproject || hasRequirements) {
    commands.push({
      id: 'pytest',
      command: 'python -m pytest',
      timeoutMs: 120_000,
      required: false,
    });
  }

  return commands;
}
