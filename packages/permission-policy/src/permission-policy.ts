/**
 * M2.4: Permission policy + Command Classifier
 *
 * Determines whether a tool call is allowed, requires approval, or is blocked
 * based on the current permission mode (Guarded YOLO / Full YOLO / Manual Approval).
 */
import { realpathSync } from 'fs';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'path';
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
 * workspace_write tools whose write target lives in the payload (a patch body)
 * rather than a path param, so resolveWriteTargets cannot recover it and the
 * fence has nothing to check. Blocked under defaultDeny; allowed in trusted
 * sessions.
 */
export const unintrospectableWriteTools = ['apply_patch', 'apply_diff'];

/**
 * Like resolveReal, but correct for paths that do not exist yet — which is the
 * normal case for a write target (creating a new file).
 *
 * resolveReal alone is asymmetric there: realpathSync throws ENOENT on the
 * missing leaf and falls back to a *lexical* resolve, leaving symlinks in the
 * path unresolved. Compared against a workspace that DOES exist (and so gets
 * fully resolved), the two disagree: on macOS a workspace at /tmp/project
 * resolves to /private/tmp/project while the target stays /tmp/project/src/new.ts,
 * so `relative` yields `../..` and a legitimate new-file write is blocked.
 *
 * Walking up to the nearest existing ancestor, resolving THAT, then re-appending
 * the missing tail makes both sides symmetric. It also closes the inverse hole:
 * a pre-existing in-workspace symlink pointing out (`/ws/link -> /etc`) is
 * resolved even when the leaf under it is missing, so `write({ path:
 * 'link/new.txt' })` is seen as /etc/new.txt and fenced out.
 */
export function resolveRealAllowingMissing(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      // Hit the filesystem root without finding anything that exists.
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `candidate` inside `workspacePath`? Shared by the destructive_git fence
 * (candidate = cwd) and the workspace_write fence (candidate = the resolved
 * write target, see resolveWriteTarget).
 *
 * resolveReal handles symlinks (macOS /tmp → /private/tmp); backslashes are
 * normalised first so Windows paths (C:\foo\bar) compare correctly (X-1); and
 * path.relative is used rather than startsWith so /workspace-evil does not
 * falsely match /workspace.
 *
 * Returns false when either path is missing — callers decide what that means
 * (destructive_git falls through to block, workspace_write blocks under
 * defaultDeny only).
 */
export function isWithinWorkspace(candidate?: string, workspacePath?: string): boolean {
  if (!candidate || !workspacePath) return false;
  // A leading ~ is home-relative, never workspace-relative. resolveReal would
  // splice it in as a literal directory name (`<workspace>/~/.ssh`), whose
  // `relative` has no `..` and so reads as inside the workspace — allowing the
  // very write the fence exists to stop.
  if (candidate.startsWith('~')) return false;
  // The candidate may not exist yet (creating a new file), so it needs the
  // missing-tail-aware resolver; workspacePath always exists.
  const normCandidate = resolveRealAllowingMissing(candidate).replace(/\\/g, '/');
  const normWorkspace = resolveReal(workspacePath).replace(/\\/g, '/');
  const rel = relative(normWorkspace, normCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The path a workspace_write tool will actually mutate, absolutised.
 *
 * Fencing on the session cwd is NOT sufficient for write/edit: OpenClaw's
 * `write` and `edit` both take `{ path }` and land it via
 * `resolveToCwd(path, cwd)` (verified in openclaw@2026.7.1-2
 * dist/sessions-D8qGY7uC.js:7496 and :5765). A subagent whose cwd is inside the
 * workspace can therefore still pass an absolute path outside it
 * (`write({ path: '~/.ssh/authorized_keys' })`) — a cwd-only fence allows that.
 *
 * Relative paths resolve against `cwd`, matching resolveToCwd.
 *
 * EVERY path-shaped param is returned, not just the first match: stopping at
 * `path` would let a benign decoy there vouch for a `file_path` the host
 * actually writes. The caller must require all of them to be in-workspace.
 *
 * An empty result means no path-shaped param was present. That is NOT proof the
 * tool writes nothing — `apply_patch` carries its targets inside the patch body
 * — so the caller must not read "empty" as "safe"; see unintrospectableWriteTools.
 */
export function resolveWriteTargets(
  params?: Record<string, unknown>,
  cwd?: string,
): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath']) {
    const v = params[key];
    if (typeof v !== 'string' || v === '') continue;
    // A leading ~ is not expanded by resolveToCwd, but treat it as an escape
    // attempt rather than a workspace-relative directory named "~".
    if (isAbsolute(v) || v.startsWith('~')) out.push(v);
    else if (cwd) out.push(resolve(cwd, v));
    // No cwd to resolve a relative path against: record it unresolved so the
    // fence cannot silently skip it.
    else out.push(v);
  }
  return out;
}

/**
 * PowerShell read cmdlet family (2026-09-29 issue C). Read-shaped cmdlets are
 * pure reads for classification; the write family is DERIVED from
 * CMDLET_PARAM_TABLE's keys below so classification and the fence cannot drift
 * apart (a cmdlet added to one and not the other would silently degrade the
 * fence to the cwd fallback).
 */
export const POWERSHELL_READ_CMDLETS = new Set(['get-item', 'get-content', 'get-childitem']);

/** How a write-cmdlet parameter relates to the write fence. */
type CmdletParamKind = 'target' | 'value' | 'bool';

/**
 * Common parameters every cmdlet accepts (about_CommonParameters) — never
 * targets. Value-consuming ones eat a bareword so it is not mistaken for a
 * positional path.
 */
const COMMON_CMDLET_PARAMS: Record<string, CmdletParamKind> = {
  '-verbose': 'bool', '-debug': 'bool',
  '-erroraction': 'value', '-warningaction': 'value', '-informationaction': 'value',
  '-outbuffer': 'value', '-pipelinevariable': 'value', '-progressaction': 'value',
};

/**
 * Parameter tables for the write-shaped cmdlets (2026-09-29 issue C + review).
 * `target` params contribute the fenced write target; `value` params consume a
 * bareword (or comma array) without ever becoming a target — Copy-Item's -Path
 * is its SOURCE, a read, hence a `value` here; `bool` params stand alone.
 * PowerShell accepts unambiguous prefixes (`-lit` → -LiteralPath) and attached
 * values (`-Path:x`; `-Path=x`, which PS rejects, is tolerated for symmetry);
 * matchCmdletParam resolves prefixes, and anything unknown or ambiguous fails
 * CLOSED — an unlisted parameter could be the one carrying the real write
 * target, so parsing must not silently degrade to the cwd fallback for it.
 */
const CMDLET_PARAM_TABLE: Record<string, Record<string, CmdletParamKind>> = {
  'set-content': {
    '-path': 'target', '-literalpath': 'target',
    '-value': 'value', '-encoding': 'value',
    '-nonewline': 'bool', '-asbytestream': 'bool', '-force': 'bool',
    '-confirm': 'bool', '-whatif': 'bool', '-passthru': 'bool',
  },
  'new-item': {
    '-path': 'target', '-literalpath': 'target',
    // -Name may itself carry a path ("you can specify the path of the new item
    // in Name" — Microsoft Learn), so it is resolved as a target below.
    '-name': 'value', '-value': 'value', '-type': 'value', '-itemtype': 'value',
    '-directory': 'bool', '-force': 'bool', '-confirm': 'bool', '-whatif': 'bool',
  },
  'copy-item': {
    '-destination': 'target',
    '-path': 'value', '-literalpath': 'value',
    '-filter': 'value', '-exclude': 'value', '-include': 'value',
    '-recurse': 'bool', '-container': 'bool', '-force': 'bool',
    '-confirm': 'bool', '-whatif': 'bool', '-passthru': 'bool',
  },
};

/** The write family, derived from the fence tables (single source of truth). */
export const POWERSHELL_WRITE_CMDLETS = new Set(Object.keys(CMDLET_PARAM_TABLE));

/**
 * Fail-closed sentinel returned by resolveWriteTargetsFromArgv when a write
 * cmdlet's target is UNVERIFIABLE: an unknown or ambiguous parameter, a target
 * arriving by pipeline (unanalyzable after segment splitting), a $variable
 * target PowerShell expands before binding, or a parsed argv with no target at
 * all. The path is absolute and contains a NUL — no real path matches it. The
 * fence in decidePermission ALSO checks identity against this sentinel
 * explicitly: isWithinWorkspace alone would accept it under a root workspace.
 */
export const FENCE_SENTINEL_TARGET = '/\u0000unparseable-write-cmdlet';

/**
 * Resolve a dash-token against a cmdlet's parameter table plus the common
 * parameters, honouring PowerShell's unambiguous-prefix abbreviation. Exact
 * match wins; otherwise a prefix matching exactly one parameter (across both
 * sets) wins; zero or multiple matches return undefined (unknown / ambiguous)
 * so the caller can fail closed.
 */
function matchCmdletParam(
  table: Record<string, CmdletParamKind>,
  flag: string,
): { name: string; kind: CmdletParamKind } | undefined {
  const exact = table[flag] ?? COMMON_CMDLET_PARAMS[flag];
  if (exact) return { name: flag, kind: exact };
  const hits = [
    ...Object.keys(table).filter((k) => k.startsWith(flag)),
    ...Object.keys(COMMON_CMDLET_PARAMS).filter((k) => k.startsWith(flag)),
  ];
  if (hits.length === 1) return { name: hits[0], kind: (table[hits[0]] ?? COMMON_CMDLET_PARAMS[hits[0]])! };
  return undefined;
}

/**
 * Index of the cmdlet token inside argv, after wrapper prefixes — mirrors
 * classifyCommand's own recursion (env / npx / npm|pnpm|yarn exec|dlx) so the
 * FENCE resolves the same effective binary the CLASSIFIER did. Without this,
 * `env Set-Content -Path /etc/hosts …` classifies workspace_write (recursion)
 * while the fence looks up 'env', finds no table, and falls back to cwd.
 */
function cmdletStartIndex(argv: string[]): number {
  const head = argv[0]?.toLowerCase();
  let i = 0;
  if (head === 'env') {
    i = 1;
    while (i < argv.length && argv[i].includes('=') && !argv[i].startsWith('-')) i++;
  } else if (head === 'npx') {
    i = 1;
    while (i < argv.length && argv[i].startsWith('-')) i++;
  } else if ((head === 'npm' || head === 'pnpm' || head === 'yarn')
             && ['exec', 'dlx'].includes(argv[1]?.toLowerCase() ?? '')) {
    i = 2;
    while (i < argv.length && argv[i].startsWith('-')) i++;
  }
  return i;
}

/**
 * Absolutise one target candidate the way resolveWriteTargets treats tool
 * params, plus PowerShell specifics: comma arrays fence EVERY element
 * (`"a,../../.ssh/x"` is two paths, not one comma filename), and a leading `$`
 * is a variable PowerShell expands before binding ($HOME, $env:TEMP) —
 * unanalyzable, so the sentinel. Absolute/~ pass through as-is (the fence
 * rejects them); relatives resolve against the session cwd; no cwd leaves
 * them unresolved (fence fails closed).
 */
function absolutiseTargets(raw: string, cwd?: string): string[] {
  return raw.split(',')
    .map((el) => el.trim())
    .filter((el) => el !== '')
    .flatMap((el) => {
      if (el.startsWith('$')) return [FENCE_SENTINEL_TARGET];
      if (isAbsolute(el) || el.startsWith('~')) return [el];
      return cwd ? [resolve(cwd, el)] : [el];
    });
}

/**
 * The path(s) a write-shaped PowerShell cmdlet segment will mutate,
 * absolutised — the argv-level sibling of resolveWriteTargets. Shell segments
 * carry no params.path, so without this the workspace_write fence falls back
 * to the session cwd and `Set-Content -Path /etc/hosts` issued from an
 * in-workspace cwd would pass.
 *
 * Set-Content / New-Item: the target is -Path (positional 0); New-Item's
 * -Name additionally contributes resolve(cwd, Path, Name). Copy-Item: the
 * target is -Destination, bound to the FIRST UNBOUND positional — with a
 * named -Path the next bareword is the destination, not a second source.
 *
 * Returns [FENCE_SENTINEL_TARGET] for anything unverifiable: unknown or
 * ambiguous dash-parameter, $variable target, or a targetless write cmdlet
 * (its real target arrives by pipeline input, which segment splitting has
 * already made unanalyzable — `Get-Item /etc/hosts | Set-Content -Value x`).
 * Non-write-cmdlet segments return [] — the generic cwd fallback.
 */
export function resolveWriteTargetsFromArgv(argv: string[], cwd?: string): string[] {
  const start = cmdletStartIndex(argv);
  const cmd = argv[start]?.toLowerCase() ?? '';
  const table = CMDLET_PARAM_TABLE[cmd];
  if (!table) return [];
  const named = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = start + 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('-') && tok !== '-') {
      // Attached value forms: PowerShell's `-Path:x` (and `-Path=x`, which PS
      // rejects but tolerating costs nothing). Split at the EARLIEST separator
      // so a ':' inside an '='-attached value does not mis-slice the flag.
      const sepCands = [tok.indexOf(':'), tok.indexOf('=')].filter((p) => p > 1);
      const sep = sepCands.length ? Math.min(...sepCands) : undefined;
      const flag = (sep !== undefined ? tok.slice(0, sep) : tok).toLowerCase();
      const m = matchCmdletParam(table, flag);
      // Unknown or ambiguous parameter: the write target may live in it —
      // fail closed rather than guess (ADR-022).
      if (!m) return [FENCE_SENTINEL_TARGET];
      if (sep !== undefined) { named.set(m.name, tok.slice(sep + 1)); continue; }
      if (m.kind === 'bool') continue;
      // Value-taking parameter: consume the next token unless it is itself a
      // resolvable parameter. A `-` follower that matches a known/common
      // parameter IS that parameter (PS binds it, leaving ours unset); one
      // that matches nothing is a quoted negative-looking value
      // (`-Value "-Verbose"` — quotes were stripped by tokenizeShell, so
      // consuming it here is the only way to keep it off the param path).
      if (i + 1 < argv.length) {
        const nxt = argv[i + 1];
        if (!nxt.startsWith('-')
            || !matchCmdletParam(table, nxt.toLowerCase().split(/[:=]/)[0])) {
          named.set(m.name, nxt);
          i += 1;
        }
      }
      continue;
    }
    positionals.push(tok);
  }

  const targets: string[] = [];
  const add = (raw?: string) => { if (raw) targets.push(...absolutiseTargets(raw, cwd)); };

  if (cmd === 'copy-item') {
    // Destination binds the first UNBOUND positional: slot 0 is Path, so with
    // a named -Path/-LiteralPath the remaining barewords start at the
    // destination slot.
    const sourceNamed = named.has('-path') || named.has('-literalpath');
    add(named.get('-destination') ?? (sourceNamed ? positionals[0] : positionals[1]));
  } else {
    const pathRaw = named.get('-path') ?? named.get('-literalpath');
    add(pathRaw ?? positionals[0]);
    if (cmd === 'new-item') {
      // -Name may carry a path of its own; with -Path both are written through
      // (Path/Name join), without it Name resolves against the cwd.
      const name = named.get('-name');
      if (name) {
        const base = pathRaw
          ? (isAbsolute(pathRaw) || pathRaw.startsWith('~') ? pathRaw : (cwd ? resolve(cwd, pathRaw) : pathRaw))
          : cwd;
        targets.push(...absolutiseTargets(base ? join(base, name) : name, undefined));
      }
    }
  }

  // A write cmdlet that parsed to NO target takes its Path from pipeline
  // input — unanalyzable here, so fail closed rather than fall back to cwd.
  if (targets.length === 0) return [FENCE_SENTINEL_TARGET];
  return targets;
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

// Shell-feature regexes, platform-gated (2026-09-29 issue A + review):
// - POSIX: ANY backtick is potential command substitution → strict flag.
// - Windows/PowerShell: backtick is an escape prefix (`n, `t, `0 …) that never
//   spawns a subshell; only alphanumerics are PowerShell escape chars, so a
//   backtick followed by anything else — quote, `$`, another backtick, space,
//   EOL — is still flagged. That keeps quoted POSIX substitution
//   (`echo "`cmd`"`) caught on Windows too, at the cost of fail-closing the
//   rare `" / `$ / `` escapes for subagents (ADR-022).
const SHELL_FEATURE_POSIX_RE = /\$\(|`|<\(|>\(/;
const SHELL_FEATURE_WIN_RE = /\$\(|`(?![a-zA-Z0-9])|<\(|>\(/;

/**
 * Detect shell features tokenizeShell cannot parse safely — command
 * substitution `$(...)`, process substitution `<(...)`/`>(...)`, and POSIX
 * backtick substitution. These execute arbitrary code that classifyCommand
 * never sees (e.g. `echo $(rm -rf /)` classifies as read-only echo); callers
 * in untrusted (subagent) mode must block when this is true.
 *
 * Exported with an explicit winLike flag so tests cover both semantics
 * deterministically regardless of host platform. Residual (winLike only): a
 * POSIX closing backtick immediately glued to a letter/digit
 * (`echo "x`rm -rf /`y"`) reads as two PowerShell escapes and is not flagged;
 * accepted as a narrow shape, recorded in ADR-022.
 */
export function detectShellFeature(raw: string, winLike: boolean): boolean {
  return (winLike ? SHELL_FEATURE_WIN_RE : SHELL_FEATURE_POSIX_RE).test(raw);
}

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
  // Shell features tokenizeShell CANNOT parse safely — see detectShellFeature.
  // Platform-gated: the host platform decides POSIX (strict, any backtick) vs
  // Windows (PowerShell escape-aware) backtick semantics.
  const hasShellFeature = detectShellFeature(raw, process.platform === 'win32');
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
  /** Absolutised paths a workspace_write tool will mutate (see
   *  resolveWriteTargets). The workspace_write fence checks these rather than
   *  `cwd`, because write/edit take an explicit `path` that can point outside
   *  the workspace. All of them must be in-workspace, not just the first. */
  targetPaths?: string[];
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

  // ─── PowerShell cmdlets (Windows hosts, 2026-09-29 issue C) ──
  // Get-* cmdlets are pure reads. Write-shaped ones are workspace_write so the
  // fence can check their -Path/-Destination targets (resolveWriteTargetsFromArgv).
  // Remove-Item is deliberately NOT classified: workspace_cleanup is blocked even
  // in trusted sessions, which would regress main-session Remove-Item usage —
  // unknown keeps subagents fail-closed without touching trusted behaviour.
  if (POWERSHELL_READ_CMDLETS.has(toolLower)) return 'read_only';
  if (POWERSHELL_WRITE_CMDLETS.has(toolLower)) return 'workspace_write';

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
      // B8: `checkout -f` / `--force` overwrites uncommitted working-tree changes
      // (discard). Unlike -b/-B this is NOT branch creation — it forces the
      // checkout to proceed despite local modifications, discarding them.
      if (args.includes('-f') || args.includes('--force')) return 'destructive_git';
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
    // `dlx` (pnpm-style one-liners) downloads and runs a package — same class as
    // install: arbitrary fetch+execute, allowed with audit (2026-09-29 issue B).
    if (sub === 'install' || sub === 'add' || sub === 'update' || sub === 'dlx') return 'network';
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
  // web_fetch/web_search (ADR-021): read-egress agent tools inherited from the
  // coding profile — they DO reach subagent tool lists, so leaving them
  // unclassified meant defaultDeny blocked every subagent web read. curl
  // (arbitrary URL, any method) is already here; a GET-only fetch and a search
  // query are strictly narrower. browser/coding stay unclassified by the same
  // ADR — see unintrospectableWriteTools' doc for the guard-blindness reason.
  if (['curl', 'wget', 'web_fetch', 'web_search',
       // Interpreters / script runners (2026-09-29 issue B): `node -e`, `python -c`,
       // `pip install`, `uv …` execute arbitrary code and/or fetch packages. The
       // 2026-09-12 host diagnostic proposed classifying them network ("allow but
       // audit") so subagents can build/verify via shell at all; the alternative
       // lever is the companion issue's operator-side subagentExtraAllowTools.
       // Trusted sessions are unchanged (unknown→allow either way); the class only
       // decides allow-with-audit vs fail-closed under defaultDeny.
       'node', 'python', 'python3', 'pip', 'pip3', 'uv'].includes(toolLower)) return 'network';

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
  // `write` / `edit` are the names OpenClaw actually emits (2026.7.1-2,
  // docs/tools/index.md:86). `write_file` was aspirational — no host sends it —
  // so subagent file writes fell through to `unknown` and were blocked by
  // defaultDeny, leaving `apply_patch` as the only working write channel.
  const workspaceWriteTools = [
    'write', 'edit',
    'write_file', 'apply_patch', 'apply_diff', 'code_editor',
    // NOTE: apply_patch / apply_diff are classified here (so trusted sessions
    // keep them) but are fenced out of untrusted ones by
    // unintrospectableWriteTools — their targets are not in any param.
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
  const { toolName, toolKind, command = [], cwd, workspacePath, workflowAllowsDestructiveGit, defaultDeny, cmdClass: preClass, targetPaths = [] } = input;
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
    // Q4: fence subagent writes to the workspace. Naming `write`/`edit` correctly
    // turns them into an unconditional allow, which would hand a subagent
    // ~/.ssh/authorized_keys and ~/.openclaw/openclaw.json. Fail closed when there
    // is no workspace to check against — an unfenceable write in an untrusted
    // session is exactly the case this guard exists for.
    //
    // Scoped to defaultDeny so trusted autopilot main-session runs are unchanged:
    // they legitimately write outside the workspace (.omc/, ~/.claude/).
    //
    // The fenced paths are the write TARGETS (targetPaths), not the session cwd
    // — see resolveWriteTargets. Falling back to cwd keeps shell-classified
    // writes (`tee`, `>`) fenced, since those carry no path param. That fallback
    // is deliberately NOT a safety guarantee: for an ad-hoc subagent
    // workspacePath === cwd, so it always passes. Any tool whose target cannot
    // be read from params must be listed in unintrospectableWriteTools instead.
    //
    // `apply_patch` / `apply_diff` keep their write targets inside the patch
    // body (diff headers), not in a param, so there is nothing to fence — and a
    // header like `--- a/../../etc/hosts` lands outside the workspace. Parsing
    // diff dialects to recover the targets is too fragile to be a boundary, so
    // an untrusted session loses these tools; `write`/`edit` now work (B9), so
    // they are no longer the only write channel. Trusted sessions keep them.
    if (defaultDeny && unintrospectableWriteTools.includes(toolName.toLowerCase())) {
      return {
        outcome: 'block',
        reason: `Workspace write with unverifiable target blocked: ${toolName}`,
        message: `Tool "${toolName}" is not available in this session; use write/edit so the target path can be checked`,
      };
    }
    // Fence every path-shaped param; an out-of-workspace one anywhere blocks.
    if (defaultDeny) {
      const fenced = targetPaths.length > 0 ? targetPaths : (cwd ? [cwd] : []);
      const escaping = fenced.length === 0
        ? 'unknown'
        : fenced.find((t) => t === FENCE_SENTINEL_TARGET || !isWithinWorkspace(t, workspacePath));
      if (escaping !== undefined) {
        return {
          outcome: 'block',
          reason: `Workspace write outside workspace blocked: ${toolName} (target=${escaping}, workspace=${workspacePath ?? 'unset'})`,
          message: `Tool "${toolName}" may only write inside the session workspace`,
        };
      }
    }
    return { outcome: 'allow', reason: `Workspace write: ${toolName}`, audit: true };
  }

  if (cmdClass === 'worktree_create') {
    return { outcome: 'allow', reason: 'Worktree creation by workspace manager', audit: true };
  }

  // ─── Destructive git ─────────────────────────────────────
  if (cmdClass === 'destructive_git') {
    if (workflowAllowsDestructiveGit && isWithinWorkspace(cwd, workspacePath)) {
      return {
        outcome: 'allow',
        reason: `Destructive git allowed by workflow config in workspace: ${command.join(' ')}`,
        audit: true,
      };
    }
    return {
      outcome: 'block',
      reason: `Destructive git command blocked: ${command.join(' ')}`,
      message: 'Destructive git commands are blocked',
    };
  }

  // ─── Network ─────────────────────────────────────────────
  // Auto-execute network commands (npm install, git push/fetch/pull/clone,
  // curl/wget, web_fetch/web_search per ADR-021).
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
      targetPaths: resolveWriteTargets(event.params, cwd),
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
      // Cmdlet-shaped shell writes carry their target in argv, not params —
      // extract it so the workspace_write fence checks the real -Path (2026-09-29
      // issue C). [] for everything else keeps the cwd fallback.
      targetPaths: resolveWriteTargetsFromArgv(seg, cwd),
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
