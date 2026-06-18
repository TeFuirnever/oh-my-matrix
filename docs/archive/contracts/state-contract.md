# State Contract（状态读写合同）

> Defines the interface for omm state persistence: key format, value schema, atomic write guarantee, and validation rules.

## Key Format

- Keys are plain strings used as filenames: `{stateRoot}/state/{key}.json`
- Default `stateRoot`: `~/.openclaw/omm` (configurable via `api.config.stateRoot` or `OMM_STATE_ROOT` env var)
- Key must be a non-empty string after trimming
- No path separators or special characters enforced (filesystem constraints apply)

## Value Schema

- Value must be a non-null, non-array JSON object (`typeof value === "object" && value !== null && !Array.isArray(value)`)
- All values receive a `lastUpdatedAt` ISO8601 timestamp on every write
- Mode-aware validation applies when `value.mode` or `key` matches a known mode

## Atomic Write Guarantee（原子写入保证）

All writes use a two-step atomic pattern:

```
writeFile("{key}.json.tmp", data, "utf8")
rename("{key}.json.tmp", "{key}.json")
```

- Directory is created with `recursive: true` on first write
- `rename()` is atomic on POSIX; on Windows it is atomic within the same volume
- No file locking — concurrent writers to the same key may race (last-write-wins)

## Validation Rules（验证规则）

### Dispatch Logic

```
mode = value.mode ?? key
validator = VALIDATORS[mode]  // team (single mode, post-ADR-008)
if (validator) → mode-specific validation
else → pass through with lastUpdatedAt only
```

### Known Modes

| Mode        | Validator             | Status Field    |
| ----------- | --------------------- | --------------- |
| `team`      | `validateTeam()`      | `current_phase` |

See [Workflow State Contract](workflow-state-contract.md) for mode-specific rules.

### Shared Validation Rules

1. **Phase normalization**: status/phase strings are trimmed and lowercased
2. **Phase membership**: must belong to the mode's valid phase set
3. **Terminal enforcement**: `{complete, failed, blocked}` require `active=false`
4. **Auto-completion**: terminal phases get `completedAt` auto-set if missing
5. **Timestamp validation**: `startedAt`, `completedAt`, `lastUpdatedAt` must be valid ISO8601 when present
6. **Default injection**: when `active=true`, missing counters and status receive sensible defaults
7. **Counter validation**: counters must be non-negative integers; max values must be positive integers

### Unknown Keys

Keys that don't match any known mode pass through without business validation. Only `lastUpdatedAt` is added.

## Return Type

```typescript
interface StateValidationResult {
  ok: boolean;
  state?: Record<string, unknown>; // validated + normalized state (on success)
  warning?: string; // non-fatal warning
  error?: string; // validation error message (on failure)
}
```

## Dual-Access Model（双通道访问模型）

| Access Path          | Entry Point                    | Validation                   |
| -------------------- | ------------------------------ | ---------------------------- |
| In-process (plugin)  | `omm_state_write` tool         | Full `validateStateWrite()`  |
| Out-of-process (MCP) | `omm_state_write` via JSON-RPC | Inline simplified validation |

Both paths write to the same directory. The MCP server's validation is a simplified subset: it checks phase membership and terminal rules but does not inject defaults or validate counters.

## Error Contract

- Plugin tools return errors in the content array: `{ content: [{ type: "text", text: "omm_state_write error: ..." }] }`
- MCP server returns JSON-RPC error: `{ error: { code: -32000, message: "..." } }`
