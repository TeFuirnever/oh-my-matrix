# Resource limits

Read this when sizing a `.prose` program — branch counts, session totals,
recursion depth, and model-tier routing. Exceeding a cap means split or
escalate, not silently overrun.

## Branch and session caps

- **Default parallel branches**: 5 unless OpenProse/runtime config exposes a
  higher limit. Direct-session fallback is hard-capped at 5.
- **OpenProse branch target**: up to 10 per barrier by default. For larger
  sets, batch with `| pmap:`
- **Maximum total sessions** per `.prose`: 50. Beyond this, split into sequential
  `.prose` programs.
- **Maximum recursion depth** in `block`: 3. Always set `max:` on `loop until`
  constructs.

## Model routing

Model choice controls cost (see SKILL.md "When to use" for the coordination-cost
rationale).

- **Default tier**: screening/lookup = haiku, drafting/implementation = sonnet,
  judgment/architecture/security-review = opus.
- **A tournament with 4 opus contestants + 3 opus judges = 7 opus calls** — use
  sonnet contestants + opus judge instead (1 opus call).
- **Raise to opus ONLY for**: judgment, multi-system architecture, security
  review, root-cause after 2+ failed fixes, adversarial _refutation_.
- **Lower to haiku for**: relevance screening, file enumeration, simple yes/no
  classification in a routing pattern.
- **When in doubt**, start one tier lower and escalate only if output quality is
  insufficient.
