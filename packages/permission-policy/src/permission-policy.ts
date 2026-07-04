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

// Split on shell command separators. `&&`/`||` precede single `&`/`|` so they
// match first. `&` (background) and `\n` are separators too — without them
// `echo hi & git reset --hard` or `safe\ndangerous` would classify on the first
// token only and let the destructive command slip through. The lookbehind/
// lookahead on `&` EXCLUDES redirect forms like `2>&1` / `1>&2` (where `&`
// follows `>`), which are NOT command separators — splitting those produced a
// bogus `["1"]` segment that defaultDeny would block (false positive).
const SHELL_SPLIT_RE = /\s*(?:&&|\|\||\||;|(?<!>)&(?!&)|\n)\s*/;

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
): { segments: string[][]; cwd: string | undefined; hasShellFeature: boolean } {
  const params = event.params ?? {};
  const raw = params['command'];
  const workdir = typeof params['workdir'] === 'string' ? (params['workdir'] as string) : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return { segments: [], cwd: workdir, hasShellFeature: false };
  // Shell features tokenizeShell CANNOT parse safely — command substitution `$(...)`,
  // backticks, process substitution `<(...)`/`>(...)`. These execute arbitrary code that
  // classifyCommand never sees (e.g. `echo $(rm -rf /)` classifies as read-only echo).
  // Callers in untrusted (subagent) mode must block when this is true.
  const hasShellFeature = /\$\(|`|<\(|>\(/.test(raw);
  const segments = raw
    .split(SHELL_SPLIT_RE)
    .map((seg) => tokenizeShell(seg))
    .filter((seg) => seg.length > 0);

  // cwd resolution priority:
  //   1. `git -C <path>` — git's working-dir override. The host workdir does NOT
  //      capture this: git operates in <path> regardless of the shell cwd, so a
  //      destructive `git -C /etc reset --hard` issued from /ws would otherwise
  //      pass the workspace-containment check (cwd=/ws ⊂ workspace) while the op
  //      actually lands in /etc. git -C is authoritative for where the op lands,
  //      so it overrides workdir. (B2 containment-escape fix.)
  //   2. params.workdir (host-authoritative shell cwd)
  //   3. `cd <dir>` leading segment
  let cwd = workdir;
  if (!cwd) {
    for (const seg of segments) {
      if (seg[0]?.toLowerCase() === 'cd' && seg[1]) { cwd = seg[1]; break; }
    }
  }
  const GIT_BINARIES = new Set(['git', 'git.exe']);
  for (const seg of segments) {
    if (GIT_BINARIES.has(seg[0]?.toLowerCase() ?? '')) {
      // Last -C wins (matches git). Accept both `-C <path>` and `-C<path>`.
      for (let i = 1; i < seg.length; i++) {
        if (seg[i] === '-C' && seg[i + 1]) { cwd = seg[i + 1]; break; }
        if (seg[i].startsWith('-C') && seg[i].length > 2) { cwd = seg[i].slice(2); break; }
      }
    }
  }
  return { segments, cwd, hasShellFeature };
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
  /** Pre-classified CommandClass, to skip re-running classifyCommand when the
   *  caller already classified the command (e.g. decidePermissionForEvent loops
   *  segments and classifies each once). */
  cmdClass?: CommandClass;
}

export type PermissionDecision =
  | { outcome: 'allow'; reason: string; audit: true; commandClass?: CommandClass }
  | { outcome: 'block'; reason: string; message: string; commandClass?: CommandClass };

/**
 * B6: recognise a token that looks like a `git -c` config value so the strip loop
 * consumes it, vs. a bareword subcommand that should surface for classification.
 * A valid -c value is EITHER `key=value` (has `=`) OR a boolean config key
 * `section.name` (has `.` — git accepts `-c advice.detachedHead` as =true). A git
 * subcommand NEVER contains `.` or `=`, so this is precise: `clean` / `reset`
 * surface as the subcommand, while `x=y`, `core.bare`, `advice.detachedHead` are
 * consumed. Without this, `git -c core.bare reset --hard` would swallow `reset`.
 */
const CONFIG_KEY_VAL_RE = /[.=]/;

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
    // B3 fix: Block bash/sh -c and -- (don't recurse into payload string)
    if (args[0] === '-c' || args[0] === '--') return 'unknown';
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
    // Strip leading global flags (-c key=val, -C path) before the subcommand,
    // so `git -c x=y reset --hard` still classifies as destructive. Without this
    // the global flag pushes the real subcommand past args[0] → 'unknown' → allow.
    // Also handle the attached `-C<path>` single-token form — otherwise
    // `git -C/etc reset --hard` classifies as unknown (sub='-C/etc') and never
    // reaches destructive_git, defeating the B2 containment fix. (B2 robustness.)
    let idx = 0;
    while (idx < args.length) {
      const a = args[idx];
      // Short flags with a required value (two-token form).
      // -C <path>: a path is always valid → consume unconditionally.
      // -c <key=val|section.name>: only consume the next token when it looks like a
      //   config value (has `.` or `=`, see CONFIG_KEY_VAL_RE) so a bareword
      //   subcommand like `clean` surfaces for classification instead of being eaten
      //   as -c's value (B6: `git -c clean -fd` → destructive_git, not unknown).
      if (a === '-C' && idx + 1 < args.length) { idx += 2; continue; }
      if (a === '-c' && idx + 1 < args.length && CONFIG_KEY_VAL_RE.test(args[idx + 1])) { idx += 2; continue; }
      if (a === '-c' && idx + 1 < args.length) { idx += 1; continue; } // malformed -c value: skip -c only
      if (a.startsWith('-C') && a.length > 2) { idx += 1; continue; }
      if (a.startsWith('-c') && a.length > 2) { idx += 1; continue; }
      // SEC-5: long-form flags with a value — two-token and `=`-attached forms.
      // Covers all flags from `man git` that shift the subcommand index.
      if ((a === '--work-tree' || a === '--git-dir' || a === '--namespace'
           || a === '--exec-path' || a === '--config-env' || a === '--super-prefix'
           || a === '--list-cmds') && idx + 1 < args.length) { idx += 2; continue; }
      if (a.startsWith('--work-tree=') || a.startsWith('--git-dir=')
          || a.startsWith('--namespace=') || a.startsWith('--exec-path=')
          || a.startsWith('--config-env=') || a.startsWith('--super-prefix=')
          || a.startsWith('--list-cmds=')) { idx += 1; continue; }
      // Boolean global flags (single token, no value)
      if ([
        '--html-path', '--man-path', '--info-path', '--bare',
        '-p', '--paginate', '-P', '--no-pager',
        '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
        '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
      ].includes(a)) { idx += 1; continue; }
      break;
    }
    const sub = args[idx];

    // worktree subcommands
    if (sub === 'worktree') {
      if (args[idx + 1] === 'add') return 'worktree_create';
      if (args[idx + 1] === 'remove') return 'workspace_cleanup';
    }

    // destructive git
    if (sub === 'reset' && args.includes('--hard')) return 'destructive_git';
    if (sub === 'clean') return 'destructive_git';
    // `git restore` discards working-tree / staged changes — the modern replacement
    // for `git checkout -- <path>` (the latter is already destructive_git above).
    // Previously unclassified → fell through to unknown → allowed in trusted runs. (B5)
    if (sub === 'restore') return 'destructive_git';
    if (sub === 'checkout') {
      if (args.includes('--')) return 'destructive_git'; // explicit discard separator
      const target = args[idx + 1];
      if (target === '.' || target === '*') return 'destructive_git'; // discard workdir changes
      // B7: `checkout -B` force-creates/resets a branch to a new start point —
      // discards the old branch position (destructive, reflog-recoverable). Lowercase
      // -b is safe branch creation and must NOT trigger this. --force-create is a
      // `git switch` flag (git rejects it for checkout), so it is not handled here.
      if (args.includes('-B')) return 'destructive_git';
      // B4: `git checkout <ref> <path>` discards working-tree changes for <path>.
      // Distinguish from `git checkout <branch>` (1 positional = branch switch) and
      // `checkout -b/-B <name> [<start>]` (branch creation — never a discard form,
      // so only apply when -b/-B are absent). ≥2 non-flag positionals ⇒ discard.
      if (!args.includes('-b') && !args.includes('-B')) {
        const positionals = args.slice(idx + 1).filter(a => !a.startsWith('-'));
        if (positionals.length >= 2) return 'destructive_git';
      }
    }
    // force-push rewrites remote history (unrecoverable without remote reflog)
    if (sub === 'push' && args.some(a => a === '--force' || a === '-f' || a === '--force-with-lease')) return 'destructive_git';
    // local history rewrite
    if (sub === 'commit' && args.includes('--amend')) return 'destructive_git';
    if (sub === 'rebase') return 'destructive_git';
    // ref deletion (recoverable via reflog locally, but destructive intent)
    if (sub === 'branch' && args.some(a => a === '-D' || a === '-d' || a === '--delete')) return 'destructive_git';
    if (sub === 'tag' && args.some(a => a === '-d' || a === '--delete')) return 'destructive_git';
    if (sub === 'stash' && args.slice(idx + 1).some(a => a === 'clear' || a === 'drop')) return 'destructive_git';

    // network git (non-force push still allowed)
    if (sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone') return 'network';

    // safe git (checkout listed: branch-switch is safe; the discard cases above already returned)
    const safeGitSubs = ['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'remote', 'stash', 'tag', 'add', 'commit', 'reset', 'checkout'];
    if (safeGitSubs.includes(sub)) return 'safe_git';
  }

  // ─── Package managers ────────────────────────────────────
  if (toolLower === 'pnpm' || toolLower === 'npm' || toolLower === 'yarn') {
    const sub = args[0];
    if (sub === 'install' || sub === 'add' || sub === 'update') return 'network';
    // `test` runs the conventional package.json test script — keep as validation.
    if (sub === 'test') return 'validation';
    // ponytail: `run <script>` is intentionally NOT validation. It executes an
    // arbitrary named package.json script — opaque code execution the classifier
    // cannot inspect. Letting it fall through to `unknown` means trusted runs still
    // allow it (unknown→allow) but subagent defaultDeny sessions BLOCK it. B1:
    // classifying it as validation let `npm run evil` bypass the fail-closed guard
    // (validation is allowed unconditionally in decidePermission, never reaching
    // the defaultDeny check). Residual: `npm test` also runs a package.json script
    // but stays validation by convention — a malicious test script is a narrower,
    // accepted risk.
    // `exec` runs an ARBITRARY wrapped command — classify the payload, not 'validation'
    if (sub === 'exec' && args.length > 1) return classifyCommand(args[1], args.slice(2), toolKind);
    if (sub === 'exec') return 'validation';
    return 'unknown';
  }

  // `npx <cmd>` runs an arbitrary command — classify the payload, not 'validation'
  if (toolLower === 'npx' && args.length > 0) return classifyCommand(args[0], args.slice(1), toolKind);
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

  // find with -delete/-exec/-ok is destructive (deletes files or runs an arbitrary
  // command per match). Plain `find` (search) stays read_only below.
  if (toolLower === 'find' && args.some(a => a === '-delete' || a === '-exec' || a === '-ok')) {
    return 'workspace_cleanup';
  }

  // ─── Workspace write tools (B9 fix) ──────────────────────
  const workspaceWriteTools = [
    'write_file', 'apply_patch', 'apply_diff', 'code_editor',
  ];
  if (workspaceWriteTools.includes(toolLower)) return 'workspace_write';

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
    'sessions_get', 'sessions_list', 'sessions_view', 'todo_write',
  ];
  if (readOnlyTools.includes(toolLower)) return 'read_only';

  return 'unknown';
}

/**
 * Decide permission for a tool call based on classification.
 */
export function decidePermission(input: PermissionDecisionInput): PermissionDecision {
  const { toolName, toolKind, command = [], cwd, workspacePath, workflowAllowsDestructiveGit, defaultDeny, cmdClass: preClass } = input;
  const cmdClass = preClass ?? classifyCommand(toolName, command, toolKind);

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
  const { segments, cwd: workdir, hasShellFeature } = extractCommandSegments(event);
  const cwd = workdir ?? opts.cwd;

  // Untrusted (subagent) mode: block shell features the tokenizer can't parse safely
  // (command substitution / backticks / process substitution). These hide arbitrary
  // commands from classifyCommand — `echo $(rm -rf /)` would otherwise allow as read-only.
  if (hasShellFeature && opts.defaultDeny) {
    return {
      outcome: 'block',
      reason: `Untrusted session blocked unparsable shell feature ($(), backticks, <()): ${event.toolName}`,
      message: 'Shell substitution / process substitution is blocked in subagent sessions',
    };
  }

  if (segments.length === 0) {
    // Non-shell framework tool (read/write_file/sessions_*/process/update_plan):
    // classify by toolName ONLY. Known agent-API tools are explicitly classified
    // as workspace_write or read_only (see classifyCommand above) so they pass
    // through even with defaultDeny. Unknown/novel tools hit the defaultDeny gate
    // and are blocked in subagent sessions. (B9 fix: defaultDeny now forwarded.)
    const cls = classifyCommand(event.toolName, []);
    const d = decidePermission({
      toolName: event.toolName,
      command: [],
      cwd,
      workspacePath: opts.workspacePath,
      workspaceRoot: opts.workspaceRoot,
      workflowAllowsDestructiveGit: opts.workflowAllowsDestructiveGit,
      defaultDeny: opts.defaultDeny,
      cmdClass: cls,
    });
    return { ...d, commandClass: cls };
  }

  // Shell command: classify each segment ONCE, track the worst class for audit,
  // and pass the class into decidePermission (cmdClass) so it skips its own
  // classifyCommand call. Collapses the old separate mostDangerousClass pass.
  let allowReason = '';
  let worstCls: CommandClass = 'unknown';
  let worstRank = CLASS_DANGER_RANK.length - 1;
  for (const seg of segments) {
    const cls = classifyCommand(event.toolName, seg);
    const r = CLASS_DANGER_RANK.indexOf(cls);
    if (r >= 0 && r < worstRank) { worstCls = cls; worstRank = r; }
    const d = decidePermission({
      toolName: event.toolName,
      command: seg,
      cwd,
      workspacePath: opts.workspacePath,
      workspaceRoot: opts.workspaceRoot,
      workflowAllowsDestructiveGit: opts.workflowAllowsDestructiveGit,
      defaultDeny: opts.defaultDeny,
      cmdClass: cls,
    });
    if (d.outcome === 'block') return { ...d, commandClass: cls };
    if (!allowReason) allowReason = d.reason;
  }
  return { outcome: 'allow', reason: allowReason || `Allowed: ${event.toolName}`, audit: true, commandClass: worstCls };
}

// Danger ranking (index 0 = most dangerous). Used by decidePermissionForEvent to
// pick the worst class across shell segments for the audit commandClass field.
const CLASS_DANGER_RANK: CommandClass[] = [
  'credential_access', 'system_write', 'destructive_git', 'workspace_cleanup',
  'network', 'workspace_write', 'worktree_create', 'safe_git', 'validation',
  'read_only', 'unknown',
];
