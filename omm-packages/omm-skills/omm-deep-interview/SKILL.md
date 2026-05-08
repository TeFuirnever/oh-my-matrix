---
name: omm-deep-interview
description: Socratic deep interview with mathematical ambiguity gating for requirements crystallization
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a Socratic deep interview to crystallize vague ideas into clear specifications.

> Lifecycle conventions (state init, agent loading, terminal markers) follow `docs/contracts/skill-lifecycle.md` §1. This skill uses a custom interview-loop phase shape (not the standard 3-phase pipeline) — see §3 of the contract for context.

## Usage

```
/omm-deep-interview <idea or vague description>
```

## Purpose

Deep Interview replaces vague ideas with crystal-clear specifications through iterative Socratic questioning. It measures clarity across weighted dimensions and refuses to proceed until ambiguity drops below 20%, producing a spec that feeds directly into ralplan or autopilot.

## Execution Policy

- Ask ONE question at a time — never batch
- Target the WEAKEST clarity dimension with each question
- Make weakest-dimension targeting explicit every round
- Gather codebase facts BEFORE asking the user about them
- Score ambiguity after every answer — display the score
- Do not proceed until ambiguity ≤ 20%
- Allow early exit with a clear warning if ambiguity is still high
- Persist interview state for resume across session interruptions

## Lifecycle

### Phase 1: Initialize

1. Parse the user's idea from arguments
2. Detect brownfield vs greenfield:
   - If current workspace has source code AND the idea references modifying/extending something: brownfield
   - Otherwise: greenfield
3. For brownfield: explore relevant codebase areas, store as context
4. Initialize state via `omm_state_write` with key `deep-interview`:

```json
{
  "mode": "deep-interview",
  "active": true,
  "interview_id": "<uuid>",
  "slug": "<kebab-case from first 5 words>",
  "initial_idea": "<user input>",
  "type": "brownfield|greenfield",
  "rounds": [],
  "current_ambiguity": 1.0,
  "threshold": 0.2,
  "codebase_context": null,
  "challenge_modes_used": [],
  "startedAt": "<ISO8601>"
}
```

### Phase 2: Interview Loop

Each round:

1. **Score ambiguity** across 3 weighted dimensions:
   - Goal clarity: 40% weight
   - Constraints clarity: 30% weight
   - Acceptance criteria clarity: 30% weight
2. **Name the weakest dimension** and explain why the next question targets it
3. **Ask one question** targeting the weakest dimension
4. **Record the answer** in state (append to `rounds` array)
5. **Update ambiguity score** after each answer

Round format:

```json
{
  "round": 1,
  "weakest_dimension": "constraints",
  "question": "What are the performance requirements?",
  "answer": "<user response>",
  "ambiguity_after": 0.75,
  "dimension_scores": {
    "goal": 0.6,
    "constraints": 0.3,
    "criteria": 0.5
  }
}
```

### Challenge Agents

At specific round thresholds, shift perspective by loading a challenge agent prompt via `omm_agent_prompt_get`:

| Round | Challenge Mode | Purpose |
|-------|---------------|---------|
| 4 | Contrarian | Argue against the current direction |
| 6 | Simplifier | Find the minimal viable scope |
| 8 | Ontologist | Check entity definitions are stable |

Load the challenge prompt with:

```
omm_agent_prompt_get({ name: "analyst" })
```

### Phase 3: Crystallize Spec

When ambiguity ≤ threshold (0.2):

1. Generate the spec document
2. Write to `.omm/specs/deep-interview-{slug}.md`
3. Update state: `active: false`, `status: "complete"`

Spec format:

```markdown
# Spec: {title}

## Goal
{clear goal statement}

## Constraints
{numbered list of constraints}

## Non-Goals
{explicitly excluded items}

## Acceptance Criteria
{numbered testable criteria}

## Assumptions Exposed
{assumptions that were validated during interview}

## Technical Context
{relevant codebase paths, patterns, dependencies}

## Ontology
{stable entity definitions}

## Interview Transcript
{condensed Q&A summary}
```

### Resume

Read state via `omm_state_read` with key `deep-interview`. If `active=true` and `status` is non-terminal, resume from the last recorded round.

> **Important:** When `omm_state_read` returns `null`, this means "not started yet" — proceed by initializing state via `omm_state_write`.

### Handoff

On spec completion, the output path `.omm/specs/deep-interview-{slug}.md` feeds into:
- `/omm-ralplan` for consensus planning
- `/omm-autopilot` for direct execution (skip planning)
