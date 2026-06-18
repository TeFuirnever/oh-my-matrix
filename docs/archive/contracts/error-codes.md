# omm Error Code Contract

**Status:** Stable from v0.3.0
**Audience:** Host integrators (MatrixAssistant Electron, OpenClaw runtime, third-party plugin consumers)

## Why

Prior to v0.3.0, `omm` plugin tools and MCP servers returned errors as
free-form strings. Hosts had to substring-match to classify failures. As
the surface grew and error wording shifted across patch versions, host
integrations broke silently.

This contract defines stable, machine-readable error codes that hosts can
branch on programmatically. Codes are added in minor versions and never
removed in patch versions.

## Format

Every failure path returns a `details.structured` object alongside the
existing `details.error` string and `content[0].text` human message.

```ts
interface StructuredError {
  code: OmmErrorCode; // stable identifier, prefixed "OMM_E_"
  message: string; // human-readable message (may vary)
  hint?: string; // optional remediation hint
}
```

The legacy `details.error` and `content[0].text` fields remain unchanged
for backward compatibility. New code should branch on `details.structured.code`.

## Codes

| Code                      | Meaning                                       | Typical cause                            | Suggested host behavior                            |
| ------------------------- | --------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `OMM_E_KEY_MISSING`       | Required `key` argument absent                | Tool called without `key`                | Surface as "user input incomplete"                 |
| `OMM_E_KEY_INVALID`       | `key` failed safe-key whitelist               | Bad chars / length / traversal attempt   | Reject + log; possible attack vector               |
| `OMM_E_VALUE_MISSING`     | Required `value` argument absent              | Tool called without `value`              | Surface as "user input incomplete"                 |
| `OMM_E_VALUE_INVALID`     | `value` not a plain JSON object               | Array / primitive / null passed as value | Surface as "value type wrong"                      |
| `OMM_E_STATE_INVALID`     | State payload failed schema                   | Missing `mode`, `active`, etc.           | Show validation message to caller                  |
| `OMM_E_WORKFLOW_CONFLICT` | Workflow exclusivity guard fired              | Started a second team while one active   | Hint user to cancel current workflow               |
| `OMM_E_IO_FAILED`         | File-system I/O failed                        | Disk full, permission denied, ENOSPC     | Retry with backoff; if persistent, alert ops       |
| `OMM_E_LOCK_TIMEOUT`      | Cross-process lock timeout (5s)               | Deadlock or hung writer process          | Retry once; if persistent, scan for orphaned procs |
| `OMM_E_VERSION_MISMATCH`  | Plugin/MCP API version incompatible with host | Host upgraded ABI without omm refresh    | Refuse to load + tell user to upgrade omm          |
| `OMM_E_DISPATCH_TIMEOUT`  | MA employee-dispatch result did not arrive before the 60s poll timeout | MA watcher absent / slow / request purged | Retry once; if persistent, verify MA watcher is running and processing dispatch files |
| `OMM_E_INTERNAL`          | Catch-all unexpected internal error           | Bug in omm                               | Capture + report upstream                          |

## Stability Policy

- **Patch versions (0.3.x → 0.3.y):** No code added/removed. Wording in
  `message` field may change.
- **Minor versions (0.3 → 0.4):** New codes may be added. Existing codes
  unchanged. `hint` text may improve.
- **Major versions (0.x → 1.x):** Codes may be deprecated (with at least
  one minor-version overlap before removal).

> **Note on `OMM_E_VERSION_MISMATCH`:** This code is reserved for **hosts
> to emit** when refusing to load an omm release whose `apiVersion` does
> not match the host's expected major.minor. omm itself never emits
> this code; it appears in the catalog so that host teams can use the
> shared identifier in their integration code.

## Version Negotiation

`omm` plugin and MCP servers declare their capability version via:

```json
// openclaw.plugin.json
{
  "name": "omm",
  "version": "0.3.0-alpha.1",
  "apiVersion": "0.3"
}
```

Hosts that depend on a specific `apiVersion` should reject loads where the
plugin's `apiVersion` does not match. If the host expects `0.3` and omm
declares `0.4`, the host returns `OMM_E_VERSION_MISMATCH` to the caller
with a hint to upgrade.

## Example: Host Branching

```ts
const result = await ommTool.execute(callId, params, signal, onUpdate);
if (result.details?.structured) {
  const err = result.details.structured;
  switch (err.code) {
    case "OMM_E_KEY_MISSING":
    case "OMM_E_VALUE_MISSING":
      return { ok: false, userMessage: err.message };
    case "OMM_E_LOCK_TIMEOUT":
      // transient: retry once
      return retry(callId, params);
    case "OMM_E_VERSION_MISMATCH":
      return alertUpgrade(err.hint ?? "Please update omm");
    default:
      return { ok: false, internalError: err };
  }
}
```

## Migration Notes

Existing host integrations that match on `details.error` strings continue
to work. Migrating to `details.structured.code` is recommended but not
required for v0.3.x.
