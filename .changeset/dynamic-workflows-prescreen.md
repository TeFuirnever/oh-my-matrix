---
'@oh-my-matrix/dynamic-workflows': minor
---

Deterministic task prescreen: `agent_turn_prepare` hook (main sessions only)
flags fan-out candidates from the user prompt (signal words EN+ZH, size
threshold, small-task suppressors) and injects a non-blocking nudge toward the
dynamic-workflows orchestration skill. SKILL.md description adds
'use proactively' + general-scenario trigger words. appendContext composes
with autopilot's goal injection (host concatenates).
