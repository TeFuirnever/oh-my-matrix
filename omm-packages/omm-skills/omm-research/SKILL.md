---
name: omm-research
description: Evidence-backed local research pipeline - inspect data, analyze metrics, and produce verified findings
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a local research session.

> Lifecycle conventions (state init, agent loading, terminal markers) follow `docs/contracts/skill-lifecycle.md` §1. This skill uses the standard 3-phase pipeline from §2. State key: `research`.

## Usage

```
/omm-research <question or dataset path>
```

## Purpose

omm-research loads the `scientist` prompt to answer a local data, metrics, benchmark, or experiment question with reproducible evidence and explicit limitations.

## Output Targets

| Target type | Output path |
|-------------|-------------|
| Dataset path | `.omc/research/reports/<timestamp>-<slug>.md` |
| Benchmark/metrics question | `.omc/research/reports/<timestamp>-metrics.md` |
| Custom | Caller-specified path |

## Phase 1: Discover

Agent: `scientist`.

Capture:

- Objective and decision the analysis supports
- Data sources, schemas, units, and quality issues
- Existing scripts or commands that should be reused
- Minimum statistics needed to support or reject the hypothesis

## Phase 2: Generate

Agent: `scientist`.

Run the smallest reproducible analysis that can answer the objective. Persist findings, commands, and report path in state. Do not install dependencies or change project code to make analysis convenient.

## Phase 3: Verify

Programmatic checks:

1. Confirm every report and generated figure path exists.
2. Confirm every finding has evidence: sample size, metric, artifact citation, or stated limitation.
3. Rerun the core command or script when feasible.
4. Reject unsupported claims and return to Phase 2 with missing evidence.

## Out-of-scope

- Feature implementation
- External literature review unless explicitly requested
- Package installation without user authority
