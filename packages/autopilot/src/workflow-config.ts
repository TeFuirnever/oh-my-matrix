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

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  version: 1,
  source: 'default',
  maxConcurrent: 5,
  maxRetries: 3,
  stallTimeoutMs: 300_000,
  maxRetryBackoffMs: 300_000,
  workspace: {
    root: '.matrix/autopilot-worktrees',
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
    'stall_timeout_ms', 'max_retry_backoff_ms', 'workspace', 'validation',
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

  if ('workspace' in raw && typeof raw.workspace === 'object' && raw.workspace !== null) {
    const ws = raw.workspace as Record<string, unknown>;
    result.workspace = {
      root: typeof ws.root === 'string' ? ws.root : DEFAULT_WORKFLOW_CONFIG.workspace.root,
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
      commands,
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
    if (i >= lines.length) return null;
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      return parseValue(indent);
    }

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
          return {
            config: { ...DEFAULT_WORKFLOW_CONFIG, source: 'workflow_md', warnings: [] },
            warnings: [],
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
        warnings,
      };

      return { config: merged, warnings };
    } catch {
      // Parsing error — fallback to default
      continue;
    }
  }

  return { config: DEFAULT_WORKFLOW_CONFIG, warnings: [] };
}
