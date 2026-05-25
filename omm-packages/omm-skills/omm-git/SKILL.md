---
name: omm-git
description: Git history workflow - atomic commits, style detection, and safe branch hygiene
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a git history workflow.

> Lifecycle conventions (state init, agent loading, terminal markers) follow `docs/contracts/skill-lifecycle.md` §1. State key: `git`.

## Usage

```
/omm-git <commit|split|rebase-plan|history-audit> <scope>
```

## Purpose

omm-git loads the `git-master` prompt to prepare or execute repository history work while preserving user changes and matching the repository's commit protocol.

## Workflow

1. Initialize state with `mode: "git"`, `active: true`, `current_phase: "inspect"`, and the requested operation.
2. Load `git-master` via `omm_agent_prompt_get({ name: "git-master" })`.
3. Inspect AGENTS.md, commit protocol docs, recent `git log`, `git status`, and `git diff --stat`.
4. Produce an operation plan. Create commits only when the user explicitly requested commits.
5. Verify with `git status --short` and recent `git log` output.
6. Mark state terminal with `status: "complete"` or `status: "blocked"`.

## Safety Rules

- Do not commit, rebase, push, or rewrite history unless the user explicitly requested that operation.
- Never stage unrelated user changes.
- Never use unsafe force operations; use `--force-with-lease` only when explicitly authorized.
- If the repository has a commit protocol, follow it exactly.

## Output

- Operation summary
- Commit style evidence
- Files or commits touched
- Verification commands and results
