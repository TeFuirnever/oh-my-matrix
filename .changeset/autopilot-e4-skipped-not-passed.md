---
"@oh-my-matrix/autopilot": minor
---

Autopilot: evidence-gate `skipped` distinction — not_configured vs not_executed (E4 step 1-2 / P0-4).

**Behavior change (eval-error path):** the evidence gate used to treat every `skipped` result as `done`. It now distinguishes WHY it skipped via an explicit `skipReason` field (not a failureReason string match):
- `not_configured` (no validation commands) → `done` (legitimate; behavior unchanged) + `completionUnverified: true`.
- `not_executed` (configured but didn't run — the `complete`-path evaluation-error fail-open) → **`blocked` + `evidence_missing`** + `completionUnverified: true`. This is the first production write of `evidence_missing` (previously unreachable). It is resumable.

A run that legitimately configures no validation (analysis tasks) still completes; a run that configured validation but the gate errored no longer silently "completes" — it blocks on `evidence_missing` so the operator can fix + resume.

New `completionUnverified` state/projection marker (persisted) flags any completion that did NOT pass the evidence gate. `skipReason` defaults to `not_configured` for legacy summaries (backward-compat → done).

**Out of scope (step 3, M2-coupled):** the `resume` guard that makes the resume button respect recoverability (`resume_requested` no-op → respond false) requires the MA-side `canResume` field (M2, cross-repo) and is NOT in this change — shipping it alone would make the resume button a dead button.
