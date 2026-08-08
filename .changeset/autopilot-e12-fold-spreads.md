---
"@oh-my-matrix/autopilot": minor
---

Autopilot: fold the 2 remaining `needsCrossTurnResume` bare spreads into reducer events (E12 — reducer sole-writer, ADR-020).

The last two non-reducer writers of `needsCrossTurnResume` in `index.ts` are now reducer events:
- `cross_turn_enqueued` — the NORMAL cross-turn handshake (per-turn revise cap reached, not degraded). `totalContinuations++`, `needsCrossTurnResume:true`, `turnAttempts:0`, `lastActivityAt` advanced (the cross-turn was armed = activity). Also fixes a latent race: the state write now lands on the fresh post-await state (`stateByRun.get`) instead of a stale pre-await snapshot.
- `cross_turn_degraded_silent` — the degraded FALLBACK (enqueue rejected/threw). Same as `cross_turn_degraded` but WITHOUT `lastActivityAt` — the canary failed (before_agent_finalize never fired = stalled); stamping activity would mask the stall from the detector (the E8 `degradation_marked` rationale). Merges `degradation_marked` + the bare spread into one event.

This gets `needsCrossTurnResume` to **reducer-only in `index.ts`**. The sole remaining non-reducer writer is the `resume()` setter in `autopilot-state.ts`, blocked on E4 step 3 (M2 cross-repo) — the full 6-aux reducer-sole-writer invariant test stays deferred until that lands.
