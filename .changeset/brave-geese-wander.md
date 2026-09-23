---
"@oh-my-matrix/dynamic-workflows": patch
---

Pass `workspacePath` for ad-hoc subagents so the workspace_write fence has a boundary to enforce

An ad-hoc subagent has no workflow-assigned workspace, so the guard previously
left `workspacePath` unset. That is what `write`/`edit` needed fencing against:
both take `{ path }` and resolve it against cwd, so a subagent legitimately
sitting in the repo could still name `~/.ssh/authorized_keys`. The session root
is now passed as the workspace — writes may land anywhere under it, nowhere
above. Leaving it unset would instead make the fence fail closed and block every
subagent write.

Destructive-git containment is unchanged: it only runs when
`workflowAllowsDestructiveGit` is true, so destructive git still falls straight
to block.
