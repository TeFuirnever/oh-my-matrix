# ADR-019: Autopilot evidence judging is conditional and stays rule-level

## Status

Accepted (2026-07-08), following two rounds of adversarial review. The first round found three blocking issues (a factual error in D3 overstating `api.runtime.llm.complete` gating; over-extended ADR-alignment claims; and a straw-man argument in D2); the second round confirmed all three were resolved in this revision and that no new blocking issues were introduced. Four non-blocking polish items from the second round (exit condition for the D2 deferral, test-path prefixes, a one-line line-number drift, and an over-optimistic subagent claim) are addressed here. See "Revision history" for the change record.

No code change, roadmap entry, or release is gated on this ADR — it records a boundary decision only. Implementation of the companion design doc's enhancements (A/B/C) is a separate, post-acceptance effort.

## Context

A long-task execution research report ([`docs/eb2ef245013a4216ad9eb1c2c0fb4c8d.md`](../eb2ef245013a4216ad9eb1c2c0fb4c8d.md)) argued that autopilot's long-task failure modes have a single root cause — "judging is not separated from execution + no verifiable stop condition + single-trajectory local optimum" — and prescribed a P0–P3 upgrade (independent Evaluator models, adversarial prompts, ownership rewriting, Reflection memory, Review–Repair–Validate staging, PRM step scoring, LATS multi-branch search).

Adversarial review of that report's applicability surfaced facts this ADR must reconcile:

1. **The report diagnoses a different artifact.** Its "current state" inventory references `electron/utils/todo-executor.ts`, `src/lib/compact-executor.ts`, `packages/gateway/`, `packages/bastion/`, `packages/agent-team/`, `memory/`, `state/cancel-signal-state.json`, `resources/skills/`, and `docs/core/autopilot/design.md` — none of which exist in this repository (they belong to a host Electron application). The report's assumed architecture is a synchronous main loop in `todo-executor.ts`; autopilot has no main loop — it is an event-driven pure-function reducer (`orchestrator.ts`) driven by OpenClaw hooks.

2. **The flagship overconfidence number is ground-truth-bound.** The report's 38–55pp self-evaluation overconfidence (ICML 2026, Kaddour et al., SWE-Bench-Pro) is measured on tasks with runnable test suites and a verifiable pass/fail. The *direction* (self-evaluation is unreliable) is robust. The *magnitude* is not portable to goals that have no verifiable predicate — and autopilot's `goal` is free text (`goal-manager.ts`, ~17 lines; `AutopilotState.goal: string`).

3. **Not all of the report's judging evidence is ground-truth-bound.** This is the correction the prior draft missed. The report's §5 carries three distinct kinds of findings, with different portability:
   - **Magnitude / ground-truth** (§5.1 finding 1: 38–55pp overconfidence) — requires a verifiable predicate to define "correct". Not portable to unjudgeable goals.
   - **Calibration techniques** (§5.1 finding 3: adversarial "find the bugs" framing reduces overconfidence ~15pp; §5.2: ownership bias up to 26%) — these are *scoring-bias* improvements measured independently of whether the task has a test suite. They are portable in *direction* to unjudgeable goals.
   - **Capability self-assessment** (§5.3: models systematically fail to say "I can't do this") — a *self-knowledge* failure, portable regardless of verifiability.

   The prior draft used finding 1 (non-portable) to exclude the entire judging agenda, silently dropping findings 2/3 and §5.2/§5.3 (portable). This was conclusion-driven analysis and is corrected here.

4. **`api.runtime.llm.complete` is less gated than the prior draft claimed.** Verified against the SDK types and host implementation: `LlmCompleteParams.model` is optional and "defaults to the target agent's configured model" (`types-B4TJD_iZ.d.ts:2657`). The host's `assertAllowedModelOverride` runs **only when `params.model` is truthy** (`runtime-llm.runtime-BIlS4d25.js:229-243`). A completion call that omits `model` (uses the default execution-model agent, no override) bypasses the `allowModelOverride` gate entirely. The only hard gate is `authority.allowComplete === false` (a runtime-scope capability denial, not a per-plugin configSchema entry). So a default-model adversarial judging call is *available in a default host without operator opt-in*.

5. **The report's own §7 is conditional, not uniformly anti-multi-agent.** Its three multi-agent papers (DOWN, Diversity Collapse, Knight-Knave-Spy) document failure modes, but the report's §7.4 also proposes *positive* design rules (confidence-gated debate, preserve cognitive diversity, minority-report channel). §7 is a warning against *unconditional* multi-agent judge panels, not a blanket rejection.

This ADR records the boundary *given* these corrected facts. It does not adopt the report's upgrade program wholesale; it also does not use non-portable evidence to exclude portable calibration techniques.

## Decision

### D1 — Ground-truth completion judging is conditional, not universal

For tasks that have verifiable validation commands (auto-detected by `detectValidationCommands()` at `src/project-detector.ts:26`, or supplied via `WORKFLOW.md`), autopilot provides ground-truth completion judging through the Evidence Gate. For tasks **without** verifiable commands (free-text goals such as "research X and write a summary"), autopilot does not provide ground-truth completion judging — there is no predicate to judge against, and ground-truth overconfidence calibration (report §5.1 magnitude) does not transfer.

**This is a scoping of ground-truth judging only.** It does *not* follow that calibration techniques (adversarial framing, ownership rewriting, CSA checks) are out of scope for unjudgeable tasks — see D2 and D3.

### D2 — Autopilot keeps a rule-level Evidence Gate; in-loop model-level judging is deferred, not forbidden

`evaluateEvidence()` (`src/evidence-gate.ts:23`) is a synchronous pure function (header invariant at `src/evidence-gate.ts:1-6`). This invariant is load-bearing for testability and determinism, and **is preserved** — no async model call is placed inside `evaluateEvidence`.

The prior draft used the pure-function invariant as a reason to forbid model-level judging entirely. That was a straw man: the existing `before_agent_finalize` `complete` branch (`index.ts:595-662`) already calls `runValidationCommands()` (async I/O) *outside* the pure function and feeds results in as an `OrchestratorEvent`. A model judging call would follow the same shape (call `api.runtime.llm.complete` in the `complete` branch, inject the verdict as a new `OrchestratorEvent` like `evaluator_finished`, let `deriveStatus()` handle it per ADR-016). The pure-function invariant never actually blocked that path.

**The honest reason model-level judging is deferred here is product-scope, not architecture:** this ADR declines to *mandate* in-loop model judging as a current deliverable, because (a) the consuming-host contract for `runtime.llm` default-model judging calls is not yet validated end-to-end in any deployed host, and (b) the structured-JSON parse-and-fallback path needs its own design and tests. This is a "not now, and not by this ADR" deferral — it is explicitly **not** an architectural prohibition. Future ADRs may mandate it.

**Tension acknowledged (ADR-008).** [ADR-008](008-delegation-to-host.md) positions autopilot as the host-delegated single autonomous-loop engine, and "judging when to stop" is a core loop-engine responsibility. Deferring model-level judging narrows that responsibility. This ADR resolves the tension by treating the deferral as temporary and conditional, not as a permanent redefinition of autopilot's role. ADR-008 itself only credits autopilot with rule-level verification (per-step verification, evidence gates, retry) and is silent on model-level judging — so this deferral does not contradict ADR-008, but it does not claim ADR-008 *requires* the deferral either.

**Exit condition for the deferral.** The deferral ends — and a follow-up ADR is warranted — when *either* of these verifiable triggers fires: (a) the default-model adversarial-judging path (D3) is validated end-to-end in at least one deployed host (deployed-dist smoke check passes, per [architecture.md §Distribution Reality](../architecture.md)), proving the `runtime.llm` contract holds outside this repo; *or* (b) a consuming host reports measurable completion-detection unreliability on verifiable tasks that the rule-level Evidence Gate cannot catch (i.e. real evidence, not the misattributed report). Until one of these fires, the deferral stands.

### D3 — `runtime.llm` judging is split into two paths with different verifiability

**Prior draft correction.** The prior draft claimed `api.runtime.llm.complete` requires host `allowModelOverride` opt-in in all cases. That was wrong (see Context #4).

The corrected picture splits the `runtime.llm` path into two:

- **Default-model adversarial judging (omitting `model`): available without host opt-in.** Uses the target agent's configured model with an adversarial "find the bugs" system prompt. This is the calibration technique from report §5.1 finding 3 (portable in direction, ~15pp overconfidence reduction). It is available in a default host (no `allowModelOverride` needed, verified at `runtime-llm.runtime-BIlS4d25.js:229-243`). **It is verifiable in this repository** via an SDK mock in unit tests. This path is a candidate for a *future* implementation ADR; this ADR does not mandate it, but records it as available and not blocked.

- **Model-override judging (specifying `model`, e.g. a cheaper Evaluator tier): requires host opt-in.** Passing a non-default `model` triggers `assertAllowedModelOverride`, which needs host `plugins.entries.autopilot.llm.allowModelOverride: true` (default off, `ZodOptional` at `config-schema.d.ts:4727`). It also requires extending `openclaw.plugin.json` `configSchema` with an `llm` block. This path is **not verifiable in this repository** (host-gated) and remains a host-opt-in placeholder.

For both paths: `LlmCompleteResult.text` (`types-B4TJD_iZ.d.ts:2666`) is free-form text, so any structured-verdict parsing (`{ satisfied, reason, ... }`) needs a degenerate fallback to the rule-level gate on parse failure.

## Drivers

- **Factual honesty over conclusion-driven analysis.** The prior draft used non-portable magnitude evidence to exclude portable calibration techniques, and overstated `runtime.llm` constraints. This revision separates what is genuinely constrained (model override) from what is available (default-model judging).
- **Preserve the pure-function invariant for the rule-level gate.** `evaluateEvidence` stays synchronous and I/O-free. Any model judging lives outside it, in the `complete` branch, entering state via an `OrchestratorEvent`.
- **Respect ADR-008's loop-engine positioning without overclaiming.** Model-level judging is a core loop responsibility; deferring it is a scoped, temporary product decision, not an architectural redefinition. This ADR names the tension rather than hiding it.
- **Don't prescribe product posture from a library, but don't dodge calibration either.** The report's calibration findings (adversarial framing, ownership bias, CSA) are portable and relevant; excluding them entirely would be as wrong as mandating the full P0–P3 program.

## Alternatives considered

- **Track A (report P0, approximate): adversarial self-revision via `enqueueNextTurnInjection`.** Partially rejected. `PluginNextTurnInjection` (`hook-types-B_5108I1.d.ts:224-232`) has no `role` field (`placement ∈ { prepend_context, append_context }`), so "rewrite to user role / ownership-bias elimination" is not implementable via this injection hook. **However**, ownership separation is achievable by other means — notably `runtime.subagent.run` (a separate session where the evaluator sees the executor's output as provided input), which this ADR records as a viable future path rather than dismissing ownership elimination wholesale. The injection-hook variant specifically is rejected; the technique is not.

- **Track B (report P0, complete): `runtime.llm` independent Evaluator with model override.** Rejected as a *verified, host-independent* track — model override needs host opt-in and is not verifiable here. Survives as the D3 model-override path placeholder.

- **Default-model adversarial judging (this revision's new path).** Recorded as available and verifiable, but not mandated by this ADR — it warrants its own implementation ADR with a structured-JSON parse-and-fallback design.

- **Adopt the report's P0–P3 program wholesale.** Rejected on four grounds: category error (wrong artifact); ground-truth judging fails on unjudgeable goals; §7 is conditional rather than blanket-pro-multi-agent; and the scope violates this repo's No-Speculation / Kitchen-Sink discipline. (Note: §7's *conditional* multi-agent design rules — confidence-gating, diversity preservation, minority-report channels — are acknowledged as valid future considerations, not silently dropped.)

## Tradeoff

The honest cost: for tasks without validation commands, ground-truth completion judging remains unavailable in autopilot, and they continue to rely on `completion-detector.ts` regex matching plus `MIN_TURNS_BEFORE_COMPLETE` (`continuation-engine.ts:20`). The portable calibration techniques (adversarial framing, ownership rewriting via subagent) are **recorded as available but not delivered by this ADR** — they await a future implementation ADR. This ADR chooses a narrow, verifiable current boundary while explicitly leaving the calibration path open, rather than either (a) excluding it on flawed evidence or (b) mandating an unvalidated full program.

## Tests

No code change accompanies this ADR. The boundary it protects is already machine-checked:

- `packages/autopilot/tests/evidence-gate.test.ts` — asserts `evaluateEvidence` stays a pure synchronous function.
- `packages/autopilot/tests/command-runner.test.ts` — asserts `runValidationCommands` never throws.
- `packages/autopilot/tests/status-invariant.test.ts` ([ADR-016](016-autopilot-status-sole-writer.md)) — asserts `status === deriveStatus(state)`; any future model-judging `OrchestratorEvent` must pass through this.

The companion design doc's enhancement tests (A/B/C) are scoped to post-acceptance PRs and are not part of this ADR.

## Revision history

- **2026-07-08 v3 (Accepted).** Addressed the second review round's four non-blocking items: added an explicit exit condition for the D2 deferral; corrected test-path prefixes to `packages/autopilot/tests/`; fixed the `types-B4TJD_iZ.d.ts` line reference (2656 → 2657); softened the §6.3 subagent ownership-separation claim with a "capability store not yet verified" caveat. Status moved Proposed → Accepted.
- **2026-07-08 v2.** Corrected D3: `runtime.llm.complete` does not require `allowModelOverride` when `model` is omitted (verified at `runtime-llm.runtime-BIlS4d25.js:229-243`). Rewrote D2: removed the pure-function straw man; the invariant is preserved by placing model calls outside `evaluateEvidence`, not by forbidding model judging. Acknowledged the ADR-008 tension explicitly. Removed over-extended ADR-014/012/013/010 alignment claims (ADR-014's "no workflow controller" constraint is specific to the dynamic-workflows guard's limited observability, not directly applicable to autopilot which observes full task state; ADR-012/013 extract misplaced capabilities but do not prohibit new in-loop capabilities; ADR-010 is a source-hosting decision irrelevant to the judging boundary). Corrected the §7 framing from "uniformly anti-multi-agent" to "conditional". Added the default-model adversarial-judging path as available-but-not-mandated.
- **2026-07-08 v1.** Initial draft. Overstated `runtime.llm` constraints; used non-portable magnitude evidence to exclude portable calibration techniques; over-extended ADR alignment claims.

## Related

- [Research report](../eb2ef245013a4216ad9eb1c2c0fb4c8d.md) — academic background reference; its path inventory does not apply to this repo (see the design doc's mapping errata).
- [ADR-008](008-delegation-to-host.md) — autopilot is the host-delegated single loop engine; credits rule-level verification, silent on model-level judging. This ADR's deferral is a scoped product decision, not a redefinition of that role.
- [ADR-016](016-autopilot-status-sole-writer.md) — the sole-writer invariant any future judging `OrchestratorEvent` must respect (implementation constraint, neutral on the boundary itself).
- [ADR-012](012-dynamic-workflows-plugin-extraction.md) / [ADR-013](013-permission-policy-library.md) / [ADR-014](014-dynamic-workflows-product-boundary.md) — the capability-extraction direction and dynamic-workflows boundary. Cited here for context; they do not directly constrain autopilot's in-loop judging (their scope is guard extraction and the dynamic-workflows product boundary).
- [`docs/design/autopilot-conditional-judging-design.md`](../design/autopilot-conditional-judging-design.md) — companion design doc with the mapping errata and the in-repo-verifiable enhancements.
