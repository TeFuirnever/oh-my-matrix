# Core patterns (1-3) and compositions

Read this when SKILL.md's "When to use" decision table points you at one of the
three core patterns, or when composing them. For patterns 4-11, see
`patterns-advanced.md`.

## 1. Fan-out-reduce

Draft N answers in parallel, then synthesize the best one. Use when multiple
independent perspectives improve the final answer — each draft must survive
_refutation_ by the others to make it into the synthesis.

```prose
# Fan-out-reduce: parallel drafts → synthesis
input task: "The task to accomplish"

agent drafter:
  model: sonnet
  prompt: "Draft a thorough answer from your unique angle."

parallel:
  d1 = session: drafter
    prompt: "Approach from angle 1. Use the task in context."
    context: task
  d2 = session: drafter
    prompt: "Approach from angle 2. Use the task in context."
    context: task
  d3 = session: drafter
    prompt: "Approach from angle 3. Use the task in context."
    context: task

session "Synthesize the best answer from all drafts"
  context: { d1, d2, d3 }
```

## 2. Pipeline (filter → map → reduce)

Process a collection through stages. Use for screening, enrichment, and
selection over a set of items.

```prose
# Pipeline: screen → expand → select best
let ideas = session "Generate 10 startup ideas"

let viable = ideas | filter:
  session "Is this technically feasible? yes/no"
    context: item

let pitches = viable | map:
  session "Write a one-page pitch"
    context: item

let winner = pitches | reduce(best, current):
  session "Which pitch is stronger?"
    context: [best, current]
```

## 3. Adversarial verify

Find candidates, then keep only those that survive independent _refutation_.
Use when false positives are costly — the skeptic's job is to refute, not
confirm; default to refuted if uncertain.

```prose
# Adversarial verify: find → refute → filter
input target: "The target to audit"

agent finder:
  model: sonnet
  prompt: "Find potential issues. Be thorough."

agent skeptic:
  model: opus
  prompt: "Try to REFUTE this finding. Default to refuted if uncertain."

let findings = session: finder
  prompt: "Audit the target in context for security issues."
  context: target

let verdicts = findings | pmap:
  session: skeptic
    prompt: "Can you refute this finding?"
    context: item

session "Report only the findings that survived skeptical review"
  context: { findings, verdicts }
```

## Composing patterns

Most real tasks combine two patterns:

1. **Discover → fan-out**: First session enumerates targets, then `parallel for`
   fans out. Use whenever the target list is not known upfront.
2. **Fan-out → adversarial-verify**: Fan-out finds candidates, each goes through
   a skeptic _refute_ pass.
3. **Pipeline → reduce**: Pipeline stages filter and enrich, reduce picks winner.

Example — discover → fan-out → verify (the most common composition):

```prose
# Discover targets, fan-out audit, verify findings
input project: "The project to audit"

let targets = session "List all API endpoints in the project provided in context"
  context: project

agent auditor:
  model: sonnet
  prompt: "Audit error handling. Report issues with file, line, severity."

let findings = targets | pmap:
  session: auditor
    prompt: "Audit this endpoint"
    context: item

let verified = findings | pmap:
  session "Try to REFUTE this finding. Refuted = discard."
    context: item

session "Report only findings that survived verification"
  context: { targets, verified }
```
