/**
 * M2.4: Permission policy + Command Classifier
 *
 * Determines whether a tool call is allowed, requires approval, or is blocked
 * based on the current permission mode (Guarded YOLO / Full YOLO / Manual Approval).
 */
import { realpathSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import type { CommandClass } from './types';

/**
 * Resolve a path to its canonical real path, normalising symlinks.
 * Falls back to path.resolve (which at least normalises `.`, `..`, and
 * redundant separators) when the path does not exist on disk.
 *
 * Exported for unit-testing.
 */
export function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Minimal view of the OpenClaw `before_tool_call` event — only the fields the
 * guard reads. The real event (`PluginHookBeforeToolCallEvent`) has exactly
 * `["toolName","params","runId","toolCallId"]` (verified live 2026-06-28): there
 * is NO `args` and NO `cwd`. Shell commands live in `params.command` (string),
 * cwd in `params.workdir`.
 */
export interface ToolEventLike {
  toolName: string;
  params?: Record<string, unknown> | undefined;
}

/**
 * Split a shell command string into argv, respecting single/double quotes.
 * Mirrors autopilot's parseCommandArgs. Does NOT expand $vars/globs —
 * classification only needs the binary + flags.
 */
export function tokenizeShell(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) { args.push(current); current = ''; }
    } else current += ch;
  }
  if (current) args.push(current);
  return args;
}

const SHELL_SPLIT_RE = /\s*(?:&&|\|\||\||;)\s*/;

/**
 * Extract argv segments + cwd from a REAL `before_tool_call` event.
 *
 * Real subagent shell calls look like `cd /ws && git status 2>&1` — one
 * `params.command` string chained with shell operators. We split on those
 * operators so each sub-command is classified independently (otherwise the
 * leading `cd` masks a trailing `git reset --hard` → fail-open). cwd comes from
 * `params.workdir` (host-authoritative); falls back to the first `cd <dir>`.
 *
 * Non-shell tools (read/process/update_plan/sessions_*) have no `params.command`
 * → empty segments; the caller classifies by toolName alone.
 */
export function extractCommandSegments(
  event: ToolEventLike,
): { segments: string[][]; cwd: string | undefined } {
  const params = event.params ?? {};
  const raw = params['command'];
  const workdir = typeof params['workdir'] === 'string' ? (params['workdir'] as string) : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return { segments: [], cwd: workdir };
  const segments = raw
    .split(SHELL_SPLIT_RE)
    .map((seg) => tokenizeShell(seg))
    .filter((seg) => seg.length > 0);
  if (!workdir) {
    for (const seg of segments) {
      if (seg[0]?.toLowerCase() === 'cd' && seg[1]) return { segments, cwd: seg[1] };
    }
  }
  return { segments, cwd: workdir };
}

export interface PermissionDecisionInput {
  toolName: string;
  toolKind?: string;
  command?: string[];
  cwd?: string;
  workspacePath?: string;
  workspaceRoot?: string;
  workflowAllowsDestructiveGit: boolean;
  /** When true (untrusted/subagent sessions), unclassified commands are BLOCKED
   *  instead of allowed. Default false — trusted autopilot runs keep allow-by-default. */
  defaultDeny?: boolean;
}

export type PermissionDecision =
  | { outcome: 'allow'; reason: string; audit: true }
  | { outcome: 'block'; reason: string; message: string };

/**
 * Classify a command/tool call into a CommandClass category.
 */
export function classifyCommand(
  tool: string,
  args: string[] = [],
  toolKind?: string,
): CommandClass {
  const toolLower = tool.toLowerCase();

  // If toolKind is explicitly provided, trust it — but cross-check destructive_git
  // against toolName to prevent plugin injection (e.g. toolKind='destructive_git' on 'rm').
  if (toolKind) {
    // Normalize common aliases
    const kindNormalized = toolKind === 'read' ? 'read_only' : toolKind;
    const validKinds: CommandClass[] = [
      'read_only', 'workspace_write', 'validation', 'safe_git',
      'worktree_create', 'workspace_cleanup', 'destructive_git',
      'network', 'credential_access', 'system_write',
    ];
    if (validKinds.includes(kindNormalized as CommandClass)) {
      // Security: destructive_git may only be claimed by git itself.
      // Widen to git.exe (Windows) and common wrappers (hub, gh).
      // Any other toolName claiming this class falls through to name-based classification.
      const GIT_TOOLS = new Set(['git', 'git.exe', 'hub', 'gh']);
      if (kindNormalized === 'destructive_git' && !GIT_TOOLS.has(toolLower)) {
        // fall through to name-based classification below
      } else {
        return kindNormalized as CommandClass;
      }
    }
  }

  // ─── Generic exec tools: classify by first arg ────────────
  // When toolName is a generic executor (e.g., code_mode_exec),
  // the actual command is in the args array.
  const genericExecTools = ['code_mode_exec', 'shell_exec', 'terminal', 'bash', 'sh', 'exec'];
  if (genericExecTools.includes(toolLower) && args.length > 0) {
    // Reclassify using the first arg as the actual tool
    const [actualTool, ...restArgs] = args;
    return classifyCommand(actualTool, restArgs, toolKind);
  }

  // ─── System commands ─────────────────────────────────────
  if (toolLower === 'sudo') return 'system_write';
  if (toolLower === 'chmod' || toolLower === 'chown') return 'system_write';
  if (toolLower === 'launchctl') return 'system_write';
  // Disk-level destructive commands: format, partition, overwrite — same risk as sudo
  if (['dd', 'mkfs', 'mkfs.ext4', 'mkfs.vfat', 'mkfs.ntfs', 'fdisk', 'parted', 'wipefs'].includes(toolLower)) {
    return 'system_write';
  }
  // Windows system-level dangerous commands (X-3, X-6)
  // Privilege escalation (= sudo): runas
  if (toolLower === 'runas') return 'system_write';
  // ACL/ownership management (= chmod/chown): icacls, cacls, takeown
  if (['icacls', 'cacls', 'takeown'].includes(toolLower)) return 'system_write';
  // Service management (= launchctl/systemctl): sc, sc.exe, schtasks, net (X-6: net start/stop)
  if (['sc', 'sc.exe', 'schtasks', 'schtasks.exe', 'net', 'net.exe'].includes(toolLower)) return 'system_write';
  // Disk-level destructive (= mkfs/fdisk): format, diskpart
  if (['format', 'diskpart'].includes(toolLower)) return 'system_write';
  // Registry modification — no Unix equivalent, equally dangerous
  if (toolLower === 'reg' || toolLower === 'reg.exe' || toolLower === 'regedit') return 'system_write';

  // ─── Credential access ───────────────────────────────────
  if (toolLower.includes('credential') || toolLower.includes('keychain') || toolLower.includes('ssh-key')) {
    return 'credential_access';
  }

  // ─── Git commands ────────────────────────────────────────
  if (toolLower === 'git' && args.length > 0) {
    const sub = args[0];

    // worktree subcommands
    if (sub === 'worktree') {
      if (args[1] === 'add') return 'worktree_create';
      if (args[1] === 'remove') return 'workspace_cleanup';
    }

    // destructive git
    if (sub === 'reset' && args.includes('--hard')) return 'destructive_git';
    if (sub === 'clean') return 'destructive_git';
    if (sub === 'checkout' && args.includes('--')) return 'destructive_git';

    // network git
    if (sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone') return 'network';

    // safe git
    const safeGitSubs = ['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'remote', 'stash', 'tag', 'add', 'commit', 'reset'];
    if (safeGitSubs.includes(sub)) return 'safe_git';
  }

  // ─── Package managers ────────────────────────────────────
  if (toolLower === 'pnpm' || toolLower === 'npm' || toolLower === 'yarn') {
    const sub = args[0];
    if (sub === 'install' || sub === 'add' || sub === 'update') return 'network';
    if (sub === 'test' || sub === 'run') return 'validation';
    if (sub === 'exec') return 'validation';
    return 'unknown';
  }

  if (toolLower === 'npx') return 'validation';

  // ─── Network tools ───────────────────────────────────────
  if (toolLower === 'curl' || toolLower === 'wget') return 'network';

  // ─── Filesystem destructive commands ─────────────────────
  if (['rm', 'rmdir', 'shred'].includes(toolLower)) {
    return 'workspace_cleanup';
  }
  // Windows equivalents (X-4): del/erase (= rm), rd (= rmdir)
  if (['del', 'erase', 'rd'].includes(toolLower)) {
    return 'workspace_cleanup';
  }

  // ─── B-4: env <cmd> passes through to the actual command ────
  if (toolLower === 'env' && args.length > 0) {
    return classifyCommand(args[0], args.slice(1), toolKind);
  }

  // ─── Read-only tools ─────────────────────────────────────
  const readOnlyTools = [
    'rg', 'grep', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq',
    'file', 'stat', 'which', 'echo', 'pwd', 'env',
    // Windows equivalents (X-5): dir=ls, type=cat, where=which, findstr=grep
    'dir', 'type', 'where', 'findstr', 'more',
    // Common agent tool names for reading files/content
    'read_file', 'read', 'view', 'get_file', 'open_file', 'list_files',
    'list_directory', 'glob', 'search_files',
    // `cd` is a no-op shell builtin (changes shell cwd only) — safe even when
    // chained before a destructive command; the destructive segment is classified
    // separately by extractCommandSegments. (verified live 2026-06-28)
    'cd',
    // Agent-framework tools (verified in real subagent events 2026-06-28): these
    // are workflow mechanics, not user commands — fan-out spawn/yield, planning,
    // process poll/kill of the agent's own child sessions. Allow in subagent
    // sessions so defaultDeny doesn't break the workflow machinery itself.
    'process', 'update_plan', 'sessions_spawn', 'sessions_yield',
    'sessions_get', 'sessions_list', 'todo_write',
  ];
  if (readOnlyTools.includes(toolLower)) return 'read_only';

  return 'unknown';
}

/**
 * Decide permission for a tool call based on classification.
 */
export function decidePermission(input: PermissionDecisionInput): PermissionDecision {
  const { toolName, toolKind, command = [], cwd, workspacePath, workflowAllowsDestructiveGit, defaultDeny } = input;
  const cmdClass = classifyCommand(toolName, command, toolKind);

  // ─── Unconditional blocks ─────────────────────────────────
  if (cmdClass === 'credential_access') {
    return {
      outcome: 'block',
      reason: 'Credential/keychain access is always blocked',
      message: 'Credential access commands are not allowed in any mode',
    };
  }

  if (cmdClass === 'system_write') {
    return {
      outcome: 'block',
      reason: 'System-level write operations are always blocked',
      message: 'System write commands (sudo, chmod, chown, etc.) are not allowed',
    };
  }

  // ─── Allowed commands ────────────────────────────────────
  if (cmdClass === 'read_only') {
    return { outcome: 'allow', reason: `Read-only command: ${toolName}`, audit: true };
  }

  if (cmdClass === 'safe_git') {
    return { outcome: 'allow', reason: `Safe git command: ${command.join(' ')}`, audit: true };
  }

  if (cmdClass === 'validation') {
    return { outcome: 'allow', reason: `Validation command: ${command.join(' ')}`, audit: true };
  }

  if (cmdClass === 'workspace_write') {
    return { outcome: 'allow', reason: `Workspace write: ${toolName}`, audit: true };
  }

  if (cmdClass === 'worktree_create') {
    return { outcome: 'allow', reason: 'Worktree creation by workspace manager', audit: true };
  }

  // ─── Destructive git ─────────────────────────────────────
  if (cmdClass === 'destructive_git') {
    if (workflowAllowsDestructiveGit) {
      // Verify cwd is within workspace — use resolveReal to handle symlinks
      // (e.g. macOS /tmp → /private/tmp) and normalise paths before comparing.
      // We also require a path-separator boundary so that /workspace-evil does
      // not falsely match /workspace.
      if (workspacePath && cwd) {
        const realCwd = resolveReal(cwd);
        const realWorkspace = resolveReal(workspacePath);
        // Containment check — must handle both Unix and Windows paths correctly (X-1).
        //
        // Strategy: normalise backslashes to forward slashes first (handles C:\foo\bar),
        // then use path.relative() for the containment check (separator-agnostic, handles
        // symlinks and avoids the /workspace-evil false-positive of naive startsWith).
        const normCwd = realCwd.replace(/\\/g, '/');
        const normWorkspace = realWorkspace.replace(/\\/g, '/');
        const rel = relative(normWorkspace, normCwd);
        const isContained = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        if (isContained) {
          return {
            outcome: 'allow',
            reason: `Destructive git allowed by workflow config in workspace: ${command.join(' ')}`,
            audit: true,
          };
        }
      }
    }
    return {
      outcome: 'block',
      reason: `Destructive git command blocked: ${command.join(' ')}`,
      message: 'Destructive git commands are blocked',
    };
  }

  // ─── Network ─────────────────────────────────────────────
  // Auto-execute network commands (npm install, git push/fetch/pull/clone, curl/wget).
  // credential_access is still blocked above (separate class).
  if (cmdClass === 'network') {
    return {
      outcome: 'allow',
      reason: `Network command allowed: ${command.join(' ')}`,
      audit: true,
    };
  }

  // ─── Workspace cleanup ───────────────────────────────────
  // rm/rmdir/shred are catastrophic + unrecoverable — blocked, user must perform manually.
  if (cmdClass === 'workspace_cleanup') {
    return {
      outcome: 'block',
      reason: `Workspace cleanup blocked: ${command.join(' ')}`,
      message: 'rm/rmdir/shred commands are blocked in autopilot — perform them manually',
    };
  }

  // ─── Unknown / unclassified ──────────────────────────────
  if (defaultDeny) {
    // Untrusted (subagent) sessions: fail CLOSED. Block anything not recognized.
    // This inversion is what makes the subagent guard a real guard, not a placebo.
    return {
      outcome: 'block',
      reason: `Untrusted session blocked unclassified command: ${toolName} ${command.join(' ')}`,
      message: `Tool "${toolName}" is not on the allowlist for subagent sessions`,
    };
  }
  // Trusted (autopilot main-session) runs: blacklist strategy — dangerous ops are
  // explicitly blocked above; anything else is allowed. A whitelist would block
  // every new tool the gateway introduces, causing "Approval timed out" errors
  // indistinguishable from real failures.
  return {
    outcome: 'allow',
    reason: `Unclassified command allowed by default: ${toolName} ${command.join(' ')}`,
    audit: true,
  };
}

/**
 * Decide permission for a REAL OpenClaw `before_tool_call` event.
 *
 * Splits `params.command` on shell operators (&&/||/;/|) and classifies each
 * segment independently — a destructive segment anywhere in the chain blocks the
 * whole call. Non-shell tools (no params.command) classify by toolName alone.
 *
 * This is the entry point guards MUST call; it replaces the old
 * `decidePermission({ command: event.args })` path that read a non-existent
 * `event.args` field (the fail-open root cause, verified live 2026-06-28).
 */
export interface EventPermissionInput {
  cwd?: string;
  workspacePath?: string;
  workspaceRoot?: string;
  workflowAllowsDestructiveGit: boolean;
  defaultDeny?: boolean;
}

export function decidePermissionForEvent(
  event: ToolEventLike,
  opts: EventPermissionInput,
): PermissionDecision {
  const { segments, cwd: workdir } = extractCommandSegments(event);
  const cwd = workdir ?? opts.cwd;

  if (segments.length === 0) {
    // Non-shell framework tool (read/write_file/sessions_*/process/update_plan):
    // classify by toolName ONLY. These are agent-API tools, not shell-injection
    // vectors, so they stay allow-by-default — defaultDeny applies only to the
    // shell segments below (that's where destructive commands ride). Without
    // this, defaultDeny would block write_file/apply_patch and subagents couldn't
    // produce anything.
    return decidePermission({
      toolName: event.toolName,
      command: [],
      cwd,
      workspacePath: opts.workspacePath,
      workspaceRoot: opts.workspaceRoot,
      workflowAllowsDestructiveGit: opts.workflowAllowsDestructiveGit,
    });
  }

  // Shell command: any destructive/blockable segment blocks the whole call.
  let allowReason = '';
  for (const seg of segments) {
    const d = decidePermission({
      toolName: event.toolName,
      command: seg,
      cwd,
      workspacePath: opts.workspacePath,
      workspaceRoot: opts.workspaceRoot,
      workflowAllowsDestructiveGit: opts.workflowAllowsDestructiveGit,
      defaultDeny: opts.defaultDeny,
    });
    if (d.outcome === 'block') return d;
    if (!allowReason) allowReason = d.reason;
  }
  return { outcome: 'allow', reason: allowReason || `Allowed: ${event.toolName}`, audit: true };
}

// Danger ranking (index 0 = most dangerous). Used to pick the worst class across
// shell segments for audit accuracy.
const CLASS_DANGER_RANK: CommandClass[] = [
  'credential_access', 'system_write', 'destructive_git', 'workspace_cleanup',
  'network', 'workspace_write', 'worktree_create', 'safe_git', 'validation',
  'read_only', 'unknown',
];

/**
 * Most dangerous CommandClass across shell segments — for audit accuracy.
 * decidePermissionForEvent already blocks on any dangerous segment; this reports
 * WHICH class for the audit trail. Picking segments[0] would mis-record
 * `cd X && git reset --hard` as read_only (the cd segment) instead of destructive_git.
 */
export function mostDangerousClass(toolName: string, segments: string[][]): CommandClass {
  let worst: CommandClass = 'unknown';
  let worstRank = CLASS_DANGER_RANK.length - 1;
  for (const seg of segments) {
    const c = classifyCommand(toolName, seg);
    const r = CLASS_DANGER_RANK.indexOf(c);
    if (r >= 0 && r < worstRank) { worst = c; worstRank = r; }
  }
  return worst;
}
