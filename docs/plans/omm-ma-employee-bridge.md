# omm-MA 数字员工桥接 — 实现计划

> **Status:** APPROVED (ralplan consensus — Critic approved v3)
> **Date:** 2026-05-25
> **Source:** deep-interview → ralplan consensus (Planner → Architect → Critic → 2 iterations)
> **Input spec:** `.omc/specs/deep-interview-omm-ma-bridge.md`

---

## RALPLAN-DR Summary

### Principles
1. **Plugin self-containment** — omm 使用现有 ABI (registerTool + config)，无需新插件接口
2. **Infrastructure reuse** — 强制复用 `withCrossProcessLock`、`omm_state_write`、`OMM_ERROR_CODES`
3. **Async dispatch + polling result** — 非阻塞 dispatch（写文件，返回 runId）；result 轮询
4. **MA priority + CC fallback** — omm-team 检测 MA employees → 优先派发；不可用时 fallback TaskCreate
5. **Minimal MA footprint** — ≤60 行，只在 init + gateway-handlers

### Decision Drivers
1. **进程边界** — Gateway 由 Electron spawn 为子进程，plugin config 是 JSON，函数无法跨进程
2. **已有基础设施** — `omm-fs-queue.js` 跨进程锁 + `omm-state.js` 原子 tmp+rename
3. **Windows 目标平台** — `readFile` 读未完整写入文件返回部分内容；`O_EXCL` 返回 `EPERM` 而非 `EEXIST`

### Options
| Option | Verdict |
|--------|---------|
| A. State-file relay | **SELECTED** — 唯一跨进程可行方案 |
| B. Config injection bridge | INVALIDATED — Gateway 子进程边界 |
| C. MCP server bridge | OVERENGINEERED |
| D. CLI subprocess | SUBOPTIMAL — 进程启动开销 |

---

## ADR

- **Decision:** State-file relay via `~/.openclaw/omm/state/ma-employees.json` + `~/.openclaw/omm/state/dispatch/{runId}.json`，所有 I/O 使用 `withCrossProcessLock` + tmp+rename
- **Drivers:** 进程边界、现有基础设施复用、Windows 文件安全
- **Alternatives:** Config injection（不可序列化）、MCP server（过度工程）、CLI（太重）
- **Consequences:** ~500ms 轮询延迟；`fs.watch` 主 + `setInterval` 后备；120s TTL 清理
- **Follow-ups:** WebSocket 事件订阅（如果延迟不可接受）、动态员工缓存刷新

---

## Implementation Plan

### Task 1: MA Employee List Cache
**File:** `electron/utils/init-default-plugins.ts` | **Lines:** ~15

```typescript
async function writeEmployeeListCache(): Promise<void> {
  const employees = await listEmployees();
  const active = employees.filter(e => e.status === 'active');
  const stateDir = join(homedir(), '.openclaw', 'omm', 'state');
  mkdirSync(stateDir, { recursive: true });
  const tmpPath = join(stateDir, '.ma-employees.json.tmp');
  const finalPath = join(stateDir, 'ma-employees.json');
  writeFileSync(tmpPath, JSON.stringify({ employees: active, generatedAt: Date.now() }));
  renameSync(tmpPath, finalPath);
}
```

Call in `initializeDefaultPlugins()` after `ensurePluginAllowed('omm')`.

### Task 2: MA Dispatch Watcher
**File:** `electron/main/ipc/gateway-handlers.ts` | **Lines:** ~45

```typescript
const DISPATCH_DIR = join(homedir(), '.openclaw', 'omm', 'state', 'dispatch');
let dispatchWatcherTimer: ReturnType<typeof setInterval> | null = null;
let dispatchWatcher: FSWatcher | null = null;
const inFlight = new Set<string>();

async function processDispatchFile(filePath: string): Promise<void> {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf-8'); } catch { return; }
  let request: DispatchRequest;
  try { request = JSON.parse(raw); } catch { return; }
  if (request.status !== 'pending' || inFlight.has(request.runId)) return;
  inFlight.add(request.runId);
  try {
    const result = await gatewayManager.rpc('chat.send', {
      sessionKey: `agent:${request.agentId}:main`,
      message: request.message,
    });
    const resultPath = join(DISPATCH_DIR, `${request.runId}.result.json`);
    const tmpPath = join(DISPATCH_DIR, `.${request.runId}.result.json.tmp`);
    writeFileSync(tmpPath, JSON.stringify({ runId: request.runId, result, completedAt: Date.now() }));
    renameSync(tmpPath, resultPath);
    try { rmSync(filePath); } catch { /* already deleted */ }
  } catch (err) {
    console.error('Dispatch processing failed:', err);
  } finally {
    inFlight.delete(request.runId);
  }
}
```

**Lifecycle binding:**
```typescript
gatewayManager.on('status', (status) => {
  if (status.state === 'running') startDispatchWatcher();
  else stopDispatchWatcher();
});
```

### Task 3: omm Bridge Tools
**New file:** `omm-packages/omm-plugin/src/omm-tools/omm-employee.ts` | **Lines:** ~105

```typescript
import { withCrossProcessLock } from '../omm-fs-queue.js';
import { OMM_E_DISPATCH_TIMEOUT } from '../omm-error-codes.js';
import { resolveOmmStateRoot } from '../omm-config.js';
import { randomUUID } from 'node:crypto';

function resolveStatePath(stateRoot: string, filename: string): string {
  return join(resolveOmmStateRoot(stateRoot), 'state', filename);
}

async function employeeList(params: Record<string, unknown>, stateRoot: string) {
  const cachePath = resolveStatePath(stateRoot, 'ma-employees.json');
  if (!existsSync(cachePath)) return { employees: [] };
  const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
  return { employees: cache.employees || [] };
}

async function employeeDispatch(params: Record<string, unknown>, stateRoot: string) {
  const agentId = params.agentId as string;
  const message = params.message as string;
  const runId = randomUUID();
  const dispatchDir = join(resolveOmmStateRoot(stateRoot), 'state', 'dispatch');
  await withCrossProcessLock(dispatchDir, runId, async () => {
    mkdirSync(dirname(join(dispatchDir, `${runId}.json`)), { recursive: true });
    const tmpPath = join(dispatchDir, `.${runId}.json.tmp`);
    writeFileSync(tmpPath, JSON.stringify({
      runId, agentId, message,
      sessionKey: `agent:${agentId}:main`,
      status: 'pending',
      createdAt: Date.now(),
    }));
    renameSync(tmpPath, join(dispatchDir, `${runId}.json`));
  });
  return { runId, status: 'dispatched' };
}

async function employeeResult(params: Record<string, unknown>, stateRoot: string) {
  const runId = params.runId as string;
  const dispatchDir = join(resolveOmmStateRoot(stateRoot), 'state', 'dispatch');
  const resultPath = join(dispatchDir, `${runId}.result.json`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const { result } = JSON.parse(readFileSync(resultPath, 'utf-8'));
      return { runId, status: 'complete', output: result };
    }
    if (!existsSync(join(dispatchDir, `${runId}.json`)) && !existsSync(resultPath)) {
      return { error: OMM_E_DISPATCH_TIMEOUT, message: `Dispatch ${runId} expired` };
    }
    await sleep(500);
  }
  return { error: OMM_E_DISPATCH_TIMEOUT, message: `Result for ${runId} timed out after 60s` };
}
```

### Task 4: Register Tools
**File:** `omm-packages/omm-plugin/src/omm-register.ts` | **Lines:** ~15

Register 3 tools following existing pattern (`omm-register.ts:132-134`): capture `api.config` in closure, pass `stateRoot` to handlers. All tools `optional: true`.

### Task 5: omm-team SKILL.md
**File:** `omm-packages/omm-skills/omm-team/SKILL.md` | **Lines:** ~20

Insert MA detection step before host delegation: call `omm_employee_list` → if employees: dispatch each subtask + poll results → if none: fallback to `Skill("team")`.

### Task 6: Error Codes
**File:** `omm-packages/omm-plugin/src/omm-error-codes.ts` | **Lines:** +2

```typescript
export const OMM_E_DISPATCH_TIMEOUT = 'OMM_E_DISPATCH_TIMEOUT';
export const OMM_E_EMPLOYEE_UNAVAILABLE = 'OMM_E_EMPLOYEE_UNAVAILABLE';
```

---

## File Change Summary

| File | Package | Lines |
|------|---------|-------|
| `electron/utils/init-default-plugins.ts` | MA | +15 |
| `electron/main/ipc/gateway-handlers.ts` | MA | +45 |
| `omm-packages/omm-plugin/src/omm-tools/omm-employee.ts` | omm | +105 |
| `omm-packages/omm-plugin/src/omm-error-codes.ts` | omm | +2 |
| `omm-packages/omm-plugin/src/omm-register.ts` | omm | +15 |
| `omm-packages/omm-skills/omm-team/SKILL.md` | omm | +20 |
| **Total** | | **~202** |

MA: ~60 lines. omm: ~142 lines.

---

## Executor Critical Fixes (apply during implementation)

1. **`readFileSync` in `processDispatchFile` must be wrapped in try/catch** — race with parallel fs.watch + polling can delete file between scan and read
2. **`.catch()` on `processDispatchFile(...)` calls** in both fs.watch callback and setInterval — unhandled promise rejection crashes Node.js process
3. **Missing imports**: `renameSync` in `init-default-plugins.ts`; `rmSync`, `renameSync`, `writeFileSync`, `readdirSync`, `mkdirSync`, `statSync`, `watch` in `gateway-handlers.ts`; `listEmployees` from role-employee-registry; `dirname` + `sleep` in `omm-employee.ts`

---

## Verification

1. `pnpm build` in oh-my-matrix — clean TypeScript compilation
2. Copy omm-suite to MA `resources/omm/`
3. Start MA `pnpm dev`; activate a digital employee
4. `ma-employees.json` written via atomic tmp+rename
5. `omm_employee_list` → returns active employees
6. `omm_employee_dispatch({ agentId, message })` → returns runId
7. Dispatch processed within 1s → `.result.json` written
8. `omm_employee_result({ runId })` → returns result
9. omm-team "1 worker review src/utils/" → end-to-end

---

## Consensus Trail

| Review | Role | Verdict | Key Issues |
|--------|------|---------|------------|
| v1 | Architect | ITERATE | 8 hardening items (locking, lifecycle, TTL, fs.watch) |
| v1 | Critic | ITERATE | 4 CRITICAL + 3 MAJOR |
| v2 | Architect | ITERATE | Architecture APPROVED, 5 pseudocode bugs |
| v3 | Critic | **APPROVE** | 8/10, 2 MAJOR executor fixes |
