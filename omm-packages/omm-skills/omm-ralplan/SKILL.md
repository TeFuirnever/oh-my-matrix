---
name: omm-ralplan
description: Consensus planning with Planner/Architect/Critic three-role approval loop
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a consensus planning session with Planner, Architect, and Critic roles.

## Usage

```
/omm-ralplan <task description or spec file path>
```

## Purpose

Ralplan creates a high-quality implementation plan through iterative review by three specialized roles. Each role evaluates the plan from a different perspective until consensus is reached, producing a plan that can be consumed by autopilot for execution.

## Lifecycle

### Phase 1: Initialize

1. Parse input — if the argument is a path to an existing spec file (`.omm/specs/*.md`), read it as the starting context. Otherwise treat as a free-form task description.
2. Initialize state via `omm_state_write` with key `ralplan`:

```json
{
  "mode": "ralplan",
  "active": true,
  "task": "<task description or spec summary>",
  "spec_path": "<path if spec provided, null otherwise>",
  "consensus_round": 0,
  "max_rounds": 5,
  "roles": {
    "planner": { "status": "pending" },
    "architect": { "status": "pending" },
    "critic": { "status": "pending" }
  },
  "plan_draft": null,
  "reviews": [],
  "status": "planning",
  "startedAt": "<ISO8601>"
}
```

### Phase 2: Consensus Loop

Each round follows this strict sequence:

#### Step 1: Planner Creates Plan

Load the planner role prompt:

```
omm_agent_prompt_get({ name: "planner" })
```

Create or revise the implementation plan. Include:
- Principles (3-5)
- Decision drivers (top 3)
- Viable options (≥2) with pros/cons
- Implementation steps with acceptance criteria
- Risk assessment

Update state: `roles.planner.status = "complete"`

#### Step 2: Architect Reviews

Load the architect role prompt:

```
omm_agent_prompt_get({ name: "architect" })
```

Review for architectural soundness:
- Structural integrity
- Scalability concerns
- Integration points
- Must provide the strongest steelman antithesis
- At least one real tradeoff tension

Update state: `roles.architect.status = "complete"`

#### Step 3: Critic Validates

Load the critic role prompt:

```
omm_agent_prompt_get({ name: "critic" })
```

Evaluate against quality criteria:
- Principle-option consistency
- Fair alternatives considered
- Risk mitigation clarity
- Testable acceptance criteria
- Concrete verification steps

Return verdict: `APPROVE`, `ITERATE`, or `REJECT`

#### Step 4: Check Consensus

- If Critic returns `APPROVE`: proceed to Phase 3
- If Critic returns `ITERATE` or `REJECT`: increment `consensus_round`, reset role statuses, return to Step 1
- If `consensus_round >= max_rounds`: present the best version and exit

**Important:** Steps 2 (Architect) and 3 (Critic) MUST run sequentially. Always complete Architect review before starting Critic evaluation.

### Phase 3: Output Plan

On consensus approval:

1. Write the final plan to `.omm/plans/ralplan-{slug}.md`
2. Update state: `active: false`, `status: "complete"`

Plan format:

```markdown
# Plan: {title}

## ADR
- **Decision:** {what was decided}
- **Drivers:** {why it matters}
- **Alternatives Considered:** {what else was evaluated}
- **Why Chosen:** {rationale}
- **Consequences:** {trade-offs accepted}
- **Follow-ups:** {next actions}

## Principles
{numbered list}

## Implementation Steps
{numbered steps with acceptance criteria}

## Risk Mitigation
{risks and countermeasures}

## Verification
{how to confirm success}
```

### Resume

Read state via `omm_state_read` with key `ralplan`. If `active=true`, resume from the last completed step.

> **Important:** When `omm_state_read` returns `null`, initialize via `omm_state_write`.

### Handoff

On plan completion, the output `.omm/plans/ralplan-{slug}.md` feeds into:
- `/omm-autopilot` — skips Phase 0 (Expansion) and Phase 1 (Planning), starts directly at Phase 2 (Execution)
- `/omm-ralph` — uses the plan as the task definition for persistent execution

### Deep-Interview Integration

If a deep-interview spec exists at `.omm/specs/deep-interview-*.md`, ralplan uses it as the starting context instead of the raw arguments. This enables the 3-stage pipeline:

```
/omm-deep-interview "vague idea"
  → spec produced

/omm-ralplan
  → consensus plan produced

/omm-autopilot
  → skips Phase 0+1, executes plan
```
