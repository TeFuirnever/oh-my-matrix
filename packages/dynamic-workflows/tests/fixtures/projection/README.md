# Dynamic Workflows Projection Fixtures

These fixtures support the read-only projection builder tests.

## Source Notes

The OpenProse fixtures in this directory are representative fixtures derived
from the accepted projection contract in
`docs/design/dynamic-workflows-projection-design.md`.
`openprose-filesystem-run-basic.raw.json` additionally follows the documented
filesystem state surface in the MatrixAssistant bundled OpenClaw docs:
`/Users/guanxueliang/Desktop/Matrix/MatrixAssistant/node_modules/openclaw/docs/prose.md`.
That source defines `.prose/runs/{YYYYMMDD}-{HHMMSS}-{random}/state.md` plus
`bindings/`.

Live OpenProse durable state was not committed because no `.prose/runs/`
artifact exists in the MatrixAssistant checkout and the current shell does not
have an active Gateway-backed `/prose run` surface. The representative shape
keeps the normalized adapter boundary explicit and is intentionally small.

## Capture Metadata

- `representativeSource`: MatrixAssistant bundled OpenClaw docs,
  `node_modules/openclaw/docs/prose.md`
- `captureDate`: `2026-07-02`
- `representativeReason`: stable live OpenProse state file path is not yet
  committed to this repository
- Redactions: no home directory paths, tokens, credentials, cookies, or private
  prompt text are present

## Branch Mapping Rule

`permission-audit-blocked.jsonl` intentionally does not prove a stable mapping
from guard audit `runId` to OpenProse branch id. Projection tests must keep those
blocked calls at workflow level and must not guess `branchId`.
