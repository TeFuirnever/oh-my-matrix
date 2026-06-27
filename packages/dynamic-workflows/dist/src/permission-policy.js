"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveReal = resolveReal;
exports.classifyCommand = classifyCommand;
exports.decidePermission = decidePermission;
/**
 * M2.4: Permission policy + Command Classifier
 *
 * Determines whether a tool call is allowed, requires approval, or is blocked
 * based on the current permission mode (Guarded YOLO / Full YOLO / Manual Approval).
 */
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * Resolve a path to its canonical real path, normalising symlinks.
 * Falls back to path.resolve (which at least normalises `.`, `..`, and
 * redundant separators) when the path does not exist on disk.
 *
 * Exported for unit-testing.
 */
function resolveReal(p) {
    try {
        return (0, fs_1.realpathSync)(p);
    }
    catch {
        return (0, path_1.resolve)(p);
    }
}
/**
 * Classify a command/tool call into a CommandClass category.
 */
function classifyCommand(tool, args = [], toolKind) {
    const toolLower = tool.toLowerCase();
    // If toolKind is explicitly provided, trust it — but cross-check destructive_git
    // against toolName to prevent plugin injection (e.g. toolKind='destructive_git' on 'rm').
    if (toolKind) {
        // Normalize common aliases
        const kindNormalized = toolKind === 'read' ? 'read_only' : toolKind;
        const validKinds = [
            'read_only', 'workspace_write', 'validation', 'safe_git',
            'worktree_create', 'workspace_cleanup', 'destructive_git',
            'network', 'credential_access', 'system_write',
        ];
        if (validKinds.includes(kindNormalized)) {
            // Security: destructive_git may only be claimed by git itself.
            // Widen to git.exe (Windows) and common wrappers (hub, gh).
            // Any other toolName claiming this class falls through to name-based classification.
            const GIT_TOOLS = new Set(['git', 'git.exe', 'hub', 'gh']);
            if (kindNormalized === 'destructive_git' && !GIT_TOOLS.has(toolLower)) {
                // fall through to name-based classification below
            }
            else {
                return kindNormalized;
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
    if (toolLower === 'sudo')
        return 'system_write';
    if (toolLower === 'chmod' || toolLower === 'chown')
        return 'system_write';
    if (toolLower === 'launchctl')
        return 'system_write';
    // Disk-level destructive commands: format, partition, overwrite — same risk as sudo
    if (['dd', 'mkfs', 'mkfs.ext4', 'mkfs.vfat', 'mkfs.ntfs', 'fdisk', 'parted', 'wipefs'].includes(toolLower)) {
        return 'system_write';
    }
    // Windows system-level dangerous commands (X-3, X-6)
    // Privilege escalation (= sudo): runas
    if (toolLower === 'runas')
        return 'system_write';
    // ACL/ownership management (= chmod/chown): icacls, cacls, takeown
    if (['icacls', 'cacls', 'takeown'].includes(toolLower))
        return 'system_write';
    // Service management (= launchctl/systemctl): sc, sc.exe, schtasks, net (X-6: net start/stop)
    if (['sc', 'sc.exe', 'schtasks', 'schtasks.exe', 'net', 'net.exe'].includes(toolLower))
        return 'system_write';
    // Disk-level destructive (= mkfs/fdisk): format, diskpart
    if (['format', 'diskpart'].includes(toolLower))
        return 'system_write';
    // Registry modification — no Unix equivalent, equally dangerous
    if (toolLower === 'reg' || toolLower === 'reg.exe' || toolLower === 'regedit')
        return 'system_write';
    // ─── Credential access ───────────────────────────────────
    if (toolLower.includes('credential') || toolLower.includes('keychain') || toolLower.includes('ssh-key')) {
        return 'credential_access';
    }
    // ─── Git commands ────────────────────────────────────────
    if (toolLower === 'git' && args.length > 0) {
        const sub = args[0];
        // worktree subcommands
        if (sub === 'worktree') {
            if (args[1] === 'add')
                return 'worktree_create';
            if (args[1] === 'remove')
                return 'workspace_cleanup';
        }
        // destructive git
        if (sub === 'reset' && args.includes('--hard'))
            return 'destructive_git';
        if (sub === 'clean')
            return 'destructive_git';
        if (sub === 'checkout' && args.includes('--'))
            return 'destructive_git';
        // network git
        if (sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone')
            return 'network';
        // safe git
        const safeGitSubs = ['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'remote', 'stash', 'tag', 'add', 'commit', 'reset'];
        if (safeGitSubs.includes(sub))
            return 'safe_git';
    }
    // ─── Package managers ────────────────────────────────────
    if (toolLower === 'pnpm' || toolLower === 'npm' || toolLower === 'yarn') {
        const sub = args[0];
        if (sub === 'install' || sub === 'add' || sub === 'update')
            return 'network';
        if (sub === 'test' || sub === 'run')
            return 'validation';
        if (sub === 'exec')
            return 'validation';
        return 'unknown';
    }
    if (toolLower === 'npx')
        return 'validation';
    // ─── Network tools ───────────────────────────────────────
    if (toolLower === 'curl' || toolLower === 'wget')
        return 'network';
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
    ];
    if (readOnlyTools.includes(toolLower))
        return 'read_only';
    return 'unknown';
}
/**
 * Decide permission for a tool call based on classification.
 */
function decidePermission(input) {
    const { toolName, toolKind, command = [], cwd, workspacePath, workflowAllowsDestructiveGit } = input;
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
                const rel = (0, path_1.relative)(normWorkspace, normCwd);
                const isContained = rel === '' || (!rel.startsWith('..') && !(0, path_1.isAbsolute)(rel));
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
    // Blacklist strategy: dangerous operations are explicitly blocked above.
    // Anything not recognized is allowed by default — a whitelist approach would
    // block every new tool or wrapper the gateway introduces, causing "Approval
    // timed out" errors that are indistinguishable from real failures.
    return {
        outcome: 'allow',
        reason: `Unclassified command allowed by default: ${toolName} ${command.join(' ')}`,
        audit: true,
    };
}
//# sourceMappingURL=permission-policy.js.map