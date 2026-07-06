---
'@oh-my-matrix/dynamic-workflows': patch
---

Fix guard logger throwing into the fail-closed before_tool_call handler (DEC-2).

`emitJson()` called `JSON.stringify` without a try/catch. When ctx contained a
circular reference or BigInt, the throw propagated up to the guard handler's
fail-closed catch and was converted into a mis-block of a legitimate subagent
tool call (with the real reason masked). The double-write ordering also meant
the skipped logger call could skip the subsequent `appendAuditEntry`, losing
the audit record.

Mirrors the accepted fix already shipped in `@oh-my-matrix/autopilot`:

- `emitJson`: wrap `JSON.stringify` in try/catch with an unserializable
  fallback record (`{ts, level, msg, ctxError:'unserializable'}`) — all four
  fallback fields are primitives, so the fallback cannot itself throw.
- add `splitArgs` helper so `log`/`warn`/`error` preserve object-arg structure
  into ctx instead of flattening to `[object Object]` (JSON-mode only; text
  mode unchanged).

Adds a regression test (`tests/logger.test.ts`) covering the circular-ref and
BigInt throw paths, the fallback-record shape, object-structure preservation,
and the `splitArgs → emitJson` variadic route. Bidirectional DRIFT REFERENCE
header comments now anchor this logger to the autopilot sibling as
byte-equivalent in its safety-relevant parts.

No behavior change for existing internal callers (the guard only calls
`logWithContext`, never object-arg `log`/`warn`/`error`); text-mode output is
byte-identical to before.

Spec: `docs/design/autopilot-dynamic-workflows-boundary.md` §5.2 (DEC-2).
