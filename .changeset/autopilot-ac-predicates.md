---
'@oh-my-matrix/autopilot': minor
---

AC-NNN predicates: goal can carry an embedded acceptance-criteria block
(Scenario/Action/Expected/Must-not/Verification/Priority). Both injection
sites (agent_turn_prepare + retry instruction) render the intent + compact
AC list; MAX_GOAL_LENGTH raised 500→2000 to fit an AC block. Backward
compatible — a free-text goal parses to [] and behaves as before.
