---
'@oh-my-matrix/autopilot': minor
---

task-size classifier: goal is classified into a tier (trivial/small/standard/
large) when captured; trivial tasks get low thinking effort for the first 3
continuations (then auto-escalate to avoid a low-effort death loop on a
misjudged complex task). Conservative — only downgrades trivial, never
upgrades based on heuristics.
