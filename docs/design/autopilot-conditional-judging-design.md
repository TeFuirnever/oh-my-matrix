# Design: Autopilot Conditional Evidence Judging

| | |
|---|---|
| **Status** | Proposed — companion to [ADR-019](../adr/019-conditional-evidence-judging-boundary.md) |
| **Date** | 2026-07-08 |
| **Scope** | Boundary of autopilot's judging capability; report mapping errata; in-repo-verifiable enhancements; explicit out-of-scope list |
| **References** | [ADR-019](../adr/019-conditional-evidence-judging-boundary.md), [research report](../eb2ef245013a4216ad9eb1c2c0fb4c8d.md), [ADR-016](../adr/016-autopilot-status-sole-writer.md), [ADR-014](../adr/014-dynamic-workflows-product-boundary.md) |

This design records what autopilot *can* judge, what it deliberately *does not* judge, and the small set of in-repo-verifiable enhancements that stay inside the rule-level boundary. It is the concrete companion to [ADR-019](../adr/019-conditional-evidence-judging-boundary.md); the ADR holds the decision, this doc holds the analysis.

## 1. Goal and non-goals

**Goal.** Make autopilot's evidence judging more reliable *for tasks that already have verifiable validation commands*, using only mechanisms that close the loop inside this repository (no host-opt-in, no new SDK capability, no async LLM inside a pure function).

**Non-goals (for this design doc).**

- Not solving *ground-truth* judging for free-text goals (no verifiable predicate exists). Note: calibration techniques (adversarial framing, ownership rewriting) are portable to unjudgeable tasks per ADR-019 D2/D3 — they are *deferred to a future ADR*, not ruled out.
- Not mandating a model-level independent Evaluator as a current deliverable (deferred per ADR-019 D2; the default-model `runtime.llm` path is recorded as available-but-not-mandated in §6).
- Not importing the report's academic survey (ReAct → Reflexion → LATS, PRM/ORM) — the report already archives it; restating it here is duplication.
- Not adding a roadmap P6 entry — the roadmap's exit-criteria discipline (each item verifiable) is preserved.

## 2. Report → repo mapping errata

The research report ([`docs/eb2ef245013a4216ad9eb1c2c0fb4c8d.md`](../eb2ef245013a4216ad9eb1c2c0fb4c8d.md)) is a high-quality **academic literature survey** (§4–§8) but its **status diagnosis** (§1) does not apply to this repository. Every internal path it cites as "already in place" was verified against this repo:

| Report reference | Cited as | Exists in this repo? |
|---|---|---|
| `electron/utils/todo-executor.ts` | the main loop to attach judging to (§1.2, §4.4, §10.5) | No — no `electron/` directory |
| `electron/utils/role-manager.ts` | multi-role subagent basis (§12.1) | No |
| `electron/utils/rate-limiter.ts` | budget-limiter basis (§10.7) | No |
| `src/lib/compact-executor.ts` | per-step evaluation insertion point (§6.4) | No — no top-level `src/` |
| `packages/gateway/` | security layer (§1.2, §9.1, §12.1) | No — only `autopilot`, `dynamic-workflows`, `permission-policy` |
| `packages/bastion/` | security layer (§12.1) | No |
| `packages/agent-team/` | subagent division (§7.4) | No |
| `memory/` (with "dreaming") | long-term memory carrier (§1.2, §10.6, §12.1) | No |
| `state/cancel-signal-state.json` | reusable state pattern (§1.2, §10.6) | No |
| `resources/skills/` | skills layer (§1.2, §12.1) | No |
| `docs/core/autopilot/design.md` | "authoritative design" (23 references) | No — no `docs/core/`; design lives in `docs/adr/` + `docs/design/` |
| `AGENTS.md` | agent working guide | **Yes** — the only path that exists |

The report's authorship line ("MatrixAssistant Agent") and its §1 pain points ("MatrixAssistant running long tasks under the OpenClaw kernel") confirm it diagnoses a **host Electron application**, not this npm package. Its assumed architecture is a synchronous main loop in `todo-executor.ts`; autopilot has no main loop — it is an event-driven pure-function reducer (`packages/autopilot/src/orchestrator.ts`) driven by OpenClaw hooks.

**Conclusion:** the report is retained as an academic background reference. Its §1 status inventory and its path-anchored implementation suggestions are **not adopted**. Its §4–§8 literature is sound context; its §5 *direction* (self-evaluation is unreliable) informs ADR-019 D1, but its §5 *magnitude* (38–55pp, "mathematical necessity") does not transfer to unjudgeable goals and is not cited as a design driver here.

## 3. Current state — precise anatomy

All file:line references below were verified against source during the adversarial review.

### 3.1 How completion is judged today (two signals)

1. **Regex on the model's own "done" phrasing** — `isTaskComplete()` (`src/completion-detector.ts:1-40`). Matches boundary-anchored Chinese ("所有任务已完成", "任务全部完成", "全部步骤已完成") and English ("all tasks completed", "the task is complete") patterns, with negation guards. This is model self-report, not independent judgment.
2. **Rule-level evidence gate** — `evaluateEvidence()` (`src/evidence-gate.ts:23`). A synchronous pure function (header invariant at `src/evidence-gate.ts:1-6`: "Pure functions — no command execution, no I/O"). It evaluates `EvidenceCommandResult.status` (`passed`/`failed`/`timeout`/`skipped`), **not** raw exit codes — the exit-code→status conversion happens upstream in `runValidationCommands()` (`src/command-runner.ts:42-43,62-63`).

### 3.2 Where validation commands come from

- **Auto-detection** — `detectValidationCommands()` (`src/project-detector.ts:26`) inspects the workspace root: `package.json` → `npm test`/`pnpm test`/`yarn test`; `go.mod` → `go test ./...`; `Cargo.toml` → `cargo test`; `pyproject.toml`/`requirements.txt` → `python -m pytest`.
- **Explicit** — `WORKFLOW.md` `validation.commands` block (`src/workflow-config.ts`).

### 3.3 The trust gate (why commands often don't run)

`trustWorkspace` defaults to `false` (`openclaw.plugin.json:75-79`; `src/types.ts:305-313`). When false, **workspace-sourced validation commands are not executed** — this is the untrusted-workspace RCE boundary (an untrusted workspace cannot reach RCE via `npm run <tampered script>`). The operator opts in per-activate payload or via plugin config. So for most unconfigured workspaces, `evaluateEvidence` returns `status: 'skipped'` (`src/evidence-gate.ts:27-34`) and completion falls back to the regex signal alone.

### 3.4 What the report calls "gaps" that already exist

The report's §1.3 "key gaps" list is largely wrong for this repo:

| Report "gap" | Actual state |
|---|---|
| ❌ "No independent Evaluator" | Correct as a *gap* — but ADR-019 D2 rules it out of scope (host/model-orchestration responsibility) |
| ❌ "No Goal-Based Loop primitive" | `goal-manager.ts` has `captureGoal` / `preserveGoalBeforeCompaction` / `restoreGoalAfterCompaction`; `autopilot.setGoal` is a public gateway method (`index.ts`); goal survives compaction |
| ❌ "No verifiable stop condition" | Evidence Gate (`evidence-gate.ts`) + completion detector + stall detector (`src/stall-detector.ts`) |
| ❌ "No hard budget cap" | `tokenBudget` + `maxAttemptsPerTurn` + `maxTotalContinuations`, enforced at `src/continuation-engine.ts:57-71` |
| ❌ "Weak cross-turn resume" | `src/state-persister.ts` — crash-recovery checkpoints, the 3.0.3 flagship feature |
| ❌ "No Reflection memory" | Correct as a gap — but see §5 (deliberately out of scope) |

## 4. Conditional judging enhancements (in-repo-verifiable)

These three enhancements close the loop inside this repository — no host opt-in, no SDK capability extension, no async LLM. Each is testable with the existing vitest harness and a `command-runner` mock.

### Enhancement A — Re-run validation on `passed` before trusting it (verifiable tasks only)

**Problem.** On a verifiable task, the model can pass `npm test`, then in a *later* turn edit a file that breaks the tests — but `evaluateEvidence` only ran at the moment of the `complete` decision. The `passed` verdict is stale by the time the run actually finishes.

**Design.** When `trustWorkspace === true` **and** validation commands are non-empty, the `before_agent_finalize` `complete` branch (`index.ts:595-662`) re-runs `runValidationCommands` one final time before dispatching `evidence_finished`. This is a pure reuse of the existing executor — no new module, no LLM. If the re-run fails, the evidence summary becomes `failed` and the reducer routes to `retry_queued` (existing path), not `done`.

**Why conditional.** This only fires when the task is already verifiable (has commands) and trusted. For untrusted workspaces or command-free tasks, nothing changes — the `skipped` path is untouched.

### Enhancement B — Feed `failureReason` + failed-command `summary` into the next retry

**Problem.** When Evidence Gate fails, `buildRetryInstruction()` (`src/continuation-engine.ts:81-92`) currently injects only the goal and a generic "continue from where you left off". The model gets no signal about *why* validation failed.

**Design.** Extend `buildRetryInstruction` to include `state.evidence.failureReason` and the `summary` field of the failed command (already populated by `runValidationCommands` at `src/command-runner.ts:65`, truncated to 300 chars). This is the lightweight, in-repo version of the report's "RL signal simulation" (P1) — it turns each failed validation into an explicit correction signal for the next turn, without any model-level judging.

**Reuse, not new code.** The `summary` field already exists on `EvidenceCommandResult` (`src/types.ts:179`); `failureReason` already exists on `EvidenceSummary` (`src/types.ts:187`). This is wiring, not new infrastructure.

### Enhancement C — Raise `MIN_TURNS_BEFORE_COMPLETE` for verifiable tasks

**Problem.** `MIN_TURNS_BEFORE_COMPLETE = 2` (`src/continuation-engine.ts:20`) guards against the model declaring "all done" on turn 1. For verifiable tasks this is too loose — the model can phrase a completion on turn 2 before any validation has meaningfully run.

**Design.** Make the threshold conditional: when the run has non-empty validation commands and `trustWorkspace === true`, use a higher threshold (e.g. 3); otherwise keep 2. This is a one-line config of an existing constant, conditioned on the same `hasValidationCommands` predicate Enhancement A uses.

## 5. Explicitly out of scope — and why

Each item below was considered and rejected, with the review-grounded reason.

### 5.1 Track A — ownership-elimination via `enqueueNextTurnInjection` specifically

**Rejected for this injection hook; the technique itself is not ruled out.**

`PluginNextTurnInjection` (`hook-types-B_5108I1.d.ts:224-232`) has fields `{ sessionKey, text, idempotencyKey?, placement?, ttlMs?, metadata? }` with `placement ∈ { prepend_context, append_context }` and **no `role` field**. The report's "rewrite the model's output as user input to eliminate ownership bias" cannot be implemented *via this hook* — injection can only prepend/append text. But ownership separation is achievable by other means (notably `runtime.subagent.run`, which spawns a separate session where the evaluator sees the executor's output as provided input). That path is recorded in §6 as a future option, not dismissed.

### 5.2 Model-override independent Evaluator via `runtime.llm` (specifying a non-default `model`)

**Rejected as a host-gated, in-repo-unverifiable track.** See ADR-019 D3. Passing a non-default `model` triggers `assertAllowedModelOverride` (`runtime-llm.runtime-BIlS4d25.js:229-243`), which needs host `plugins.entries.autopilot.llm.allowModelOverride: true` (default off). It also requires extending `openclaw.plugin.json` `configSchema`. It survives as the §6 model-override placeholder.

**Note: the default-model path (omitting `model`) is different and is NOT rejected — see §6.** A prior draft conflated the two; the correction is in ADR-019 D3.

### 5.3 Breaking `evaluateEvidence`'s pure-function invariant

**Rejected — placing the async call inside `evaluateEvidence`.** The pure-function contract (`src/evidence-gate.ts:1-6`) is load-bearing for testability and determinism. Enhancements A–C are deliberately synchronous/rule-level. **However**, this does not forbid model-level judging in general — a model call placed *outside* `evaluateEvidence` (in the `complete` branch, with the verdict entering as an `OrchestratorEvent`) preserves the invariant. This is the shape ADR-019 D2 describes for the deferred model-judging path. What is rejected here is specifically *putting the LLM call inside the pure function*.

### 5.4 LATS / multi-agent judge panels / PRM step-scoring (report P2/P3)

**Rejected for now — §7 is conditional, not blanket-pro; and the scope violates YAGNI.**

The report's §7 cites three papers (DOWN arXiv:2504.05047; Diversity Collapse TMLR 2026; Knight-Knave-Spy arXiv:2511.07784) documenting failure modes: debate adds 6× agent-call cost and can reduce accuracy; consensus is not correctness; majority pressure suppresses correct minority views. But §7.4 also proposes *positive* design rules (confidence-gated debate, preserve cognitive diversity, minority-report channel). So §7 is a warning against *unconditional* multi-agent panels, not a blanket rejection.

Designing LATS multi-branch search or PRM step-scoring as autopilot features now is rejected on YAGNI grounds (no validated need, no verifiable exit criteria in this library) — not on a claim that multi-agent judging is permanently wrong. If a future need arises with confidence-gating and diversity preservation (per §7.4's rules), it warrants its own ADR.

### 5.5 Roadmap P6 entry

**Rejected — would break the roadmap's exit-criteria discipline and displace real backlog.** The roadmap (`docs/roadmap.md`) has 13 `Planned` items with verifiable exit criteria (host-deploy smoke checklist, permission-policy shell-redirect model, evidence-gate examples, WORKFLOW.md examples). A P6 built on a misattributed report, with its flagship track unverifiable in-repo, would dilute that discipline. Enhancements A–C, if implemented, belong as rows under existing P2 (Autopilot Release Readiness), not a new phase.

## 6. `runtime.llm` judging paths (deferred, not mandated by this design)

ADR-019 D3 splits `runtime.llm` judging into two paths with different verifiability. Both are **deferred to a future implementation ADR** — this section records what is available so the boundary need not be re-litigated, but neither path is delivered or roadmap-committed here.

### 6.1 Default-model adversarial judging (available, in-repo-verifiable)

**Mechanism.** Call `api.runtime.llm.complete()` with `messages` (a serialized, read-only transcript — never touches the filesystem) and an adversarial system prompt ("find what is still broken / what evidence is missing"), **omitting `model`** so it uses the target agent's configured model.

**Why available without host opt-in.** Verified in the host: `assertAllowedModelOverride` runs **only when `params.model` is truthy** (`runtime-llm.runtime-BIlS4d25.js:229-243`). Omitting `model` bypasses the `allowModelOverride` gate; the call proceeds to `prepareSimpleCompletionModelForAgent` (`:244`) with the default model. The only hard gate is `authority.allowComplete === false` (`:209`), a runtime-scope capability denial, not a per-plugin configSchema entry. (Note: line reference `types-B4TJD_iZ.d.ts:2657` is the `model?: string` field; the preceding comment "defaults to the target agent's configured model" describes it.)

**What it buys.** This is the calibration technique from report §5.1 finding 3 (adversarial framing, ~15pp overconfidence reduction), portable in direction to unjudgeable tasks. It does *not* provide ground-truth judging (only a verifiable predicate can), but it improves calibration for all task types.

**In-repo verifiability.** Unit-testable via an SDK mock of `api.runtime.llm.complete` — assert the adversarial system prompt is sent, the transcript is read-only, and the parsed verdict routes the reducer correctly. No host-deploy smoke check needed for the unit level (though end-to-end behavior in a real host is a separate validation).

**Why deferred.** Three open design questions warrant a dedicated ADR rather than this design doc: (1) the structured-JSON parse-and-fallback contract (`LlmCompleteResult.text` at `types-B4TJD_iZ.d.ts:2666` is free-form — parse failure must fail open to the rule-level gate); (2) the new `OrchestratorEvent` (e.g. `evaluator_finished`) and its interaction with `deriveStatus()` per ADR-016; (3) when to trigger it (every `complete`? only when Evidence Gate is `skipped`? only above a token-cost threshold?).

### 6.2 Model-override judging (host-opt-in, in-repo-unverifiable)

**Mechanism.** Call `runtime.llm.complete` with a non-default `model` (e.g. a cheaper Evaluator tier).

**Why host-gated.** A non-empty `params.model` triggers `assertAllowedModelOverride` (`runtime-llm.runtime-BIlS4d25.js:230-242`), which needs host `plugins.entries.autopilot.llm.allowModelOverride: true` (default off, `config-schema.d.ts:4727`), plus an `llm` block in `openclaw.plugin.json` `configSchema`. **Not verifiable in this repository.** Remains a host-opt-in placeholder.

### 6.3 Ownership separation via `runtime.subagent.run` (future option)

Recorded so the ownership-elimination technique (report §5.2, -26% bias) is not lost. Spawning the evaluator as a separate subagent session (via `api.runtime.subagent.run`, `types-B4TJD_iZ.d.ts:5039`) gives it the executor's output as *provided input* in a fresh context — the textbook ownership-separation setup, achievable without a `role` field on the injection hook (which §5.1 establishes is absent). Gated by `subagent.allowModelOverride` for model override; default-model subagent judging is expected to be available (the `llm` path's allowComplete gate applies analogously, but subagent has its own capability store — `resolveSubagentCapabilities` — whose exact boundary is **not yet verified** and should be confirmed before a future ADR relies on this path). This is the most promising path for true judgment-execution separation and warrants its own future ADR.

Each path above is a separate future PR with its own design doc. This section exists to prevent re-litigating the boundary; it does not authorize implementation.

## 7. Relationship with existing ADRs

This table is deliberately honest about which ADRs *constrain* this design versus which are merely *context*. A prior draft over-claimed alignment; this revision narrows each claim to what the cited ADR actually says.

| ADR | Relationship | Honest characterization |
|---|---|---|
| [ADR-008](../adr/008-delegation-to-host.md) | Tension acknowledged | ADR-008 positions autopilot as the single loop engine and credits rule-level verification; it is *silent* on model-level judging. Deferring model judging (D2) narrows the loop-engine role — named as a tension, not hidden. ADR-008 does not *require* the deferral. |
| [ADR-016](../adr/016-autopilot-status-sole-writer.md) | Implementation constraint | Any future judging `OrchestratorEvent` must pass through `deriveStatus()` — never a direct `status` write. ADR-016 is neutral on *whether* to add judging; it constrains *how*. |
| [ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md) / [ADR-013](../adr/013-permission-policy-library.md) | Context only | These extract *misplaced* capabilities (guard, permission primitives). They do not prohibit adding *new* in-loop capabilities. Cited for context, not as a prohibition on judging. |
| [ADR-014](../adr/014-dynamic-workflows-product-boundary.md) | Analogous, not direct | ADR-014's "no workflow controller" constraint is specific to the dynamic-workflows guard's limited observability (it sees tool calls, not full task intent). Autopilot observes full task state, so ADR-014's rationale does not directly transfer. Borrowed as an analogy for "plugins shouldn't exceed their observability", not as a binding rule. |
| [ADR-019](../adr/019-conditional-evidence-judging-boundary.md) | Companion | This design is the concrete companion; ADR-019 holds the decision, this doc holds the analysis. |

ADR-010 (source hosting) is intentionally absent — it concerns where autopilot's source lives, not the judging boundary, and citing it would be filler.

## 8. Test strategy

All three enhancements (A/B/C) are verifiable inside this repository with the existing harness:

- **Enhancement A** — extend `tests/evidence-gate.test.ts` (or a new `tests/revalidation-on-complete.test.ts`): mock `runValidationCommands` to return `passed` on first call and `failed` on the re-run call; assert the reducer routes to `retry_queued`, not `done`. Condition the test on `trustWorkspace === true && commands.length > 0`.
- **Enhancement B** — extend `tests/continuation-engine.test.ts`: construct a state with `evidence.failureReason` and a failed command `summary`; assert `buildRetryInstruction` output contains both strings (truncated to the existing `MAX_INSTRUCTION_LENGTH` at `src/continuation-engine.ts:79`).
- **Enhancement C** — extend `tests/continuation-engine.test.ts`: parametrize `MIN_TURNS_BEFORE_COMPLETE` on the `hasValidationCommands && trustWorkspace` predicate; assert the higher threshold gates the early-completion demotion.

No e2e or host-deploy smoke check is required for A–C (they are pure rule-level logic). The existing `tests/e2e/evidence-gate-execfile.e2e.test.ts` covers the real `execFile` path that Enhancement A reuses.

## 9. Implementation note

This document is a design record only. It prescribes no immediate code change. Enhancements A–C are sketched at a level sufficient to estimate and scope a future PR, but each would land as its own PR with its own tests and its own changeset — and only after ADR-019 moves from Proposed to Accepted.
