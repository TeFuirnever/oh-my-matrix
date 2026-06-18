# omm Observability Contract

**Status:** Stable from 0.3.0-alpha.2
**Audience:** Host integrators wanting to surface omm tool performance metrics

## Why

`omm-trace` records structured execution events. When callers include the
optional metric fields (`durationMs`, `toolName`, `ok`) in trace events, the
`omm_trace_metrics` tool can aggregate latency percentiles and error rates
across sessions or for a specific session — enabling hosts to detect
regressions and set latency alerts without building their own log parsers.

## Tool Surface

### `omm_trace_metrics`

Aggregate performance metrics from trace records that carry all three metric
fields (`durationMs`, `toolName`, `ok`). Records missing any of these fields
are silently skipped; existing callers that omit them are unaffected.

#### Inputs

| Field       | Type     | Required | Description                                                                     |
| ----------- | -------- | -------- | ------------------------------------------------------------------------------- |
| `sessionId` | `string` | No       | Restrict aggregation to a single session. If omitted, all sessions are scanned. |
| `sinceMs`   | `number` | No       | Exclude records whose timestamp is older than `now - sinceMs` milliseconds.     |

#### Output

```ts
interface MetricsResult {
  count: number; // total metric records matched
  errorRate: number; // fraction where ok=false (0–1); 0 when count=0
  p50: number; // 50th-percentile durationMs; 0 when count=0
  p99: number; // 99th-percentile durationMs; 0 when count=0
  byTool: {
    [toolName: string]: {
      count: number;
      errorRate: number;
      p50: number;
      p99: number;
    };
  };
}
```

Empty dataset always returns zeros — no `NaN` values are ever emitted.

## Aggregation Algorithm

1. Read all NDJSON lines from session file(s) (current + archives).
2. Skip lines that fail `validateEvent` (missing `timestamp` / `type`).
3. Apply `sinceMs` cutoff: discard records where `Date.parse(timestamp) < Date.now() - sinceMs`.
4. Keep only records where `durationMs` is a `number`, `toolName` is a `string`, and `ok` is a `boolean`.
5. Sort qualifying `durationMs` values ascending.
6. Compute percentile via `sorted[Math.floor(n * pct)]` (simple floor index).
7. `errorRate = errorCount / count`; all values are 0 when `count === 0`.

## Emitting Metric Events

Callers append metric-carrying events through the existing `omm_trace_record`
tool. The three metric fields are optional — backward compatible with any
existing caller.

```ts
await mcpClient.call("omm_trace_record", {
  session_id: "my-session",
  event: {
    timestamp: new Date().toISOString(),
    type: "tool_call",
    toolName: "omm_state_write",
    durationMs: 42,
    ok: true,
  },
});
```

## Example Host Usage

```ts
// Poll every 30 seconds; alert if P99 exceeds 500 ms or error rate > 5%
async function checkOmmHealth(sessionId: string) {
  const result = await mcpClient.call("omm_trace_metrics", {
    sessionId,
    sinceMs: 5 * 60 * 1000, // last 5 minutes
  });
  const metrics = JSON.parse(result.content[0].text);

  if (metrics.p99 > 500) {
    alert(`omm P99 latency critical: ${metrics.p99}ms`);
  }
  if (metrics.errorRate > 0.05) {
    alert(`omm error rate high: ${(metrics.errorRate * 100).toFixed(1)}%`);
  }
}

setInterval(() => checkOmmHealth("active-session"), 30_000);
```

## Stability Policy

Mirrors the [error-codes.md](./error-codes.md) stability policy:

- **Patch versions (0.3.x → 0.3.y):** No field added/removed. Output values may differ as records accumulate.
- **Minor versions (0.3 → 0.4):** New output fields may be added. Existing fields unchanged. New input filters may be added as optional params.
- **Major versions (0.x → 1.x):** Fields may be deprecated with at least one minor-version overlap before removal.
