# @oh-my-matrix/autopilot v3.0.0 端到端审计报告

> 审计日期: 2026-07-01 | 方法: 12 维并行 scientist agents (5× opus + 7× sonnet, 两轮) + 主循环源码直读 | Round 1: 87 findings, Round 2: 深挖 6 维

## Context

对 `@oh-my-matrix/autopilot` v3.0.0 进行端到端审视，覆盖代码质量、架构设计、安全态势、测试充分性、API/DX、运行韧性六个维度，参考业界和 OpenClaw 最佳实践。近期 v2.x→v3.0.0 包含安全加固（S1 RCE、S3 stop intent）和 model routing 等大量变更。

## 模块概览

| 维度 | 数据 |
|------|------|
| 包名 | `@oh-my-matrix/autopilot` v3.0.0 |
| 入口 | `index.ts` (1149 行) |
| src/ 模块 | 17 个（12 纯函数 + 4 I/O 边界 + 1 编排胶水） |
| 测试文件 | 43+ (37 unit + 7 e2e) |
| OpenClaw hooks | 12 个 |
| Gateway methods | 6 个（activate / stop / resume / status / setGoal / cleanup） |
| 依赖 | `@oh-my-matrix/permission-policy ^0.1.1` (peer) |

---

## 综合评分

| 维度 | 评分 | 关键发现数 | 一句话 |
|------|------|-----------|--------|
| 代码质量 | **B+** | 18 | 模块拆分优秀，index.ts 需瘦身 |
| 架构设计 | **A-** | 15 | reducer 模式教科书级，双状态机是主要债务 |
| 安全态势 | **A** | 22 | v3.0.0 三层防御纵深到位，无新 CRITICAL |
| 测试充分性 | **B** | 10 | 覆盖面广，缺 coverage 配置和安全负面测试 |
| API/DX | **B-** | 11 | 功能完整，文档严重不足 |
| 运行韧性 | **B** | 11 | 主场景覆盖，错误分类器有 HIGH 级漏洞 |

**总体：架构基础扎实、安全加固到位的高质量插件。主要债务是双状态机遗留和 index.ts 体量。**

---

## 优先级修复清单

> ★ = 多个 scientist agent 交叉确认

### P0 — 必须修

| # | 问题 | 来源 | 影响 |
|---|------|------|------|
| 1 | ★ **统一 runId 生成** — 新 session 路径 (`index.ts:982`) 用 `Math.random().toString(36).slice(2,10)` (~41 bits)，重激活路径用 `crypto.randomUUID()` (122 bits)。边界：`Math.random()=0` → runId `"run-"`。**三轮对抗验证 CONFIRMED** | CQ-2, CQ-15, RES-5, SEC-22, Stage14 | **一致性 + 潜在冲突** |

> **注：** 原 P0-1（三重 tokenizer）、P0-2（classifyRecoverability）、P0-4（YAML Infinity）、P0-5（内联注释）均经 Round 3 对抗性验证 **REFUTED 或降级** — 详见 Stage 15 章节。

### P1 — 应该修

| # | 问题 | 来源 | 影响 |
|---|------|------|------|
| 2 | ★ **双状态机债务** — legacy `AutopilotStatus`（4态, imperative, throws）与 `OrchestrationState`（7态, pure reducer）并行。`H1` guard 是阻抗失配症状 | ARCH-2, Stage7 | **架构** |
| 3 | ★ **`before_agent_finalize` 过载 ~150 行** — 4 个职责混在一个 hook handler | ARCH-5, CQ-10 | **可维护性** |
| 4 | **dynamic-workflows 缺失 sessionKey → fail-open** — `if (!sessionKey) return;` 无条件放行 | Stage16 | **安全 HIGH — 新** |
| 5 | **dynamic-workflows hook body 无 try/catch** — uncaught → OpenClaw 决定 | Stage16 | **安全 MEDIUM — 新** |
| 6 | **orchestrationState done 后卡 'claimed' + evidence gate bypass** — revise 循环不 dispatch events → evidence retry 死代码 | TEST-5, Stage7, Stage10 | **正确性** |
| 7 | **WORKFLOW.md 可在不受信 workspace 启用 destructiveGit.allow** — 不受 trustWorkspace 门控 | SEC-10 | **安全 MEDIUM** |
| 8 | **添加 vitest coverage 配置** | TEST 综合 | **质量** |
| 9 | **完成检测器假阴性** — "Done!"/"Finished." 不触发完成 → 无限循环 | Stage8 | **功能** |
| 10 | **workspace.root 路径穿越** — `../../etc` 存储原值无校验 | Stage11 | **安全 MEDIUM** |

### P2 — 改善

| # | 问题 | 来源 | 影响 |
|---|------|------|------|
| 9 | ★ test helper 污染公共 barrel — 5 个 `_*ForTest` 函数 unconditional 导出；无 `exports` map 阻止 deep import | CQ-14, DX-1, DX-9 | DX |
| 10 | README 过于简短（36行）— 缺 config reference、gateway 合约、WORKFLOW.md schema、env vars、troubleshooting | DX-3, DX-6 | DX |
| 11 | 14 个 hook handler 全用 `event: any, ctx: any` — types.ts 定义了 HookContext/HookHandler 但从未使用 | CQ-6, CQ-16 | 类型安全 |
| 12 | cross-turn fallback 逻辑复制粘贴 3 次（`before_agent_finalize` + `agent_end`），带不同 fallback 字符串（英/中混用） | CQ-10, CQ-12 | 维护风险 |
| 13 | `cleanupAll` 对 paused/done session 过度释放 audit refcount — 假设每个 run 持有恰好 1 个 refcount | RES-9, ARCH-14 | 正确性 |
| 14 | Token budget 存储但未主动 enforce — 子 agent tokens 也未计入父 budget | RES-10 | 功能缺陷 |
| 15 | 驱逐策略是 FIFO（按 `startedAt`）而非 LRU（按 `lastActivityAt`）— 注释和测试文件名说 "LRU" | RES-7, SEC-17 | 语义不一致 |

### P3 — 可选改进

| # | 问题 | 来源 |
|---|------|------|
| 16 | `goal-manager.ts` 是纯 pass-through（3 个一行转发函数）— 可删除或内联 | CQ-4 |
| 17 | configSchema 5/9 字段缺描述；`tokenBudget` 无单位/默认值/范围说明 | DX-5 |
| 18 | WORKFLOW.md config 错误 activate 时不报告（存入 `workflowConfigError`），activate 仍返回 `ok: true` | DX-7 |
| 19 | 24h 孤儿清理会静默驱逐用户有意 paused 的 session | RES-8 |
| 20 | DANGEROUS_EVAL_FLAGS 缺少 Node `--import` flag（需 workspace 文件 + trustWorkspace，实际风险低） | SEC-5 |
| 21 | 退避公式缺 jitter（对比 AWS best practices） | RES-1 |
| 22 | `session_end` 不清理同一 sessionKey 的旧 sessionId 映射（reconnect 场景泄漏） | RES-11 |
| 23 | 安全负面测试偏薄 — `trustWorkspace:true` + 非白名单 binary 无测试 | TEST-8 |
| 24 | `AutopilotState` 15 个 optional 字段编码隐式子状态，类型无法表达 | CQ-7 |

---

## 六维详细分析

### 维度 1: 代码质量（B+ — 18 findings）

#### 优势

- **纯函数 reducer** — `orchestratorReducer` (278行) 是教科书级纯函数 reducer。无 `Date.now()`、无 I/O，所有时间戳经 event 传入。每个 case arm 守卫 source state，不合法转换返回原 state（不 throw）。[ARCH-1 HIGH confidence]
- **12/17 src/ 文件零 I/O** — 纯函数模块无 Node builtin import，trivially testable。仅 command-runner（child_process）、workflow-config（fs）、project-detector（fs）、logger（console）有 I/O。[ARCH-7 HIGH confidence]
- **`MODEL_TIERS as const`** — 同时派生 `ModelTier` union type 和运行时 `asTier()` 验证函数。添加 tier 是编译检查的一处修改。
- **discriminated union 精确** — `OrchestrationState`(7态)、`OrchestratorEvent`(13种)、`BlockedReason`(10种) + `VALID_BLOCKED_REASONS` runtime Set + `isValidBlockedReason` type guard。

#### 关键问题

| ID | 问题 | 严重度 | 位置 |
|----|------|--------|------|
| CQ-1 | index.ts 1149行：hook注册 + gateway逻辑 + 状态管理 + LRU + stall timer + test helpers。activate handler 独占 ~140 行（比多数 src/ 模块大）。`applyPayload`/`applyWorkflowConfig` 是 35 行闭包嵌套在 handler 中不可独立测试 | HIGH | index.ts |
| CQ-2 | 两种 runId 生成共存：`generateRunId()` (crypto.randomUUID) vs inline `Math.random().toString(36)` | HIGH | index.ts:259,982 |
| CQ-6 | 14 个 hook callback 全用 `any` — HookContext/HookHandler 定义了但没人用 | HIGH | index.ts:293+ |
| CQ-10 | cross-turn fallback (enqueue+revise) 复制粘贴 3 次，idempotencyKey 格式各异 | HIGH | index.ts:339-391,762-797 |
| CQ-11 | tokenizeCommand 与 parseCommandArgs 是同一状态机的两个实现 | HIGH | workflow-config:70, command-runner:75 |
| CQ-4 | goal-manager.ts 3 个函数全是一行转发到 autopilot-state.ts | HIGH | src/goal-manager.ts |
| CQ-16,17 | HookContext、HookHandler、RegisterHookFn、InjectionResult 导出但零 importer | HIGH | src/types.ts |

---

### 维度 2: 架构设计（A- — 15 findings）

#### 优势

- **状态机设计** — `unclaimed → claimed → running → released → done`（with `retry_queued`/`blocked` 分支），每个转换有 source state guard。[ARCH-1]
- **全部 12 hooks 各有明确职责，无冗余** — `before_compaction`/`after_compaction` 成对保护 goal，`before_model_resolve` 独立控制 tier，`llm_output` 独立追踪 tokens。[ARCH-4 HIGH]
- **continuation engine 正确分离 "should" vs "how"** — `decideContinuation` 返回 decision，`before_agent_finalize` 解释 decision 并调用 OpenClaw API。[ARCH-8]
- **CQRS gateway pattern** — command（activate/stop/resume/setGoal）与 query（status）分离。[ARCH-11]
- **configSchema fail-closed** — trustWorkspace default false，modelRouting graceful degrade。[ARCH-12]

#### 主要债务

**ARCH-2: 双状态机（PRIMARY DEBT）**

两个并行状态模型在同一 `AutopilotState` 对象上：

| 方面 | AutopilotStatus (legacy) | OrchestrationState (reducer) |
|------|-------------------------|-------------------------------|
| 值域 | idle/running/paused/done (4) | unclaimed/claimed/running/released/blocked/retry_queued/done (7) |
| 位置 | autopilot-state.ts | orchestrator.ts |
| 风格 | imperative mutators (activate/pause/complete), **throws** on illegal | pure reducer, **returns unchanged** on illegal |
| 覆盖 | 粗粒度 | 精细粒度 |

摩擦症状：
- `index.ts:964` — activate 路径先调 `activate()` 再调 `orchestratorReducer(activate_requested)` — 双重 dispatch
- `index.ts:433` — H1 guard: `updated.status === 'done'` 时跳过 `complete()` 以避免 throw — 因为 reducer 已将 status 设为 done
- `index.ts:808` — `agent_end` 中 `pause(state, 'loop_breaker_triggered')` + `orchestratorReducer(agent_turn_finished)` 混合调用

**建议：** legacy `AutopilotStatus` 的 4 态应合并入 reducer 的 7 态。imperative mutators 替换为 event dispatch。

---

### 维度 3: 安全态势（A — 22 findings）

#### 三层防御纵深

```
Layer 1: trustWorkspace default-off → untrusted workspace = zero commands executed
Layer 2: ALLOWED_VALIDATION_BINARIES allowlist (fail-closed) → unknown binary = dropped
Layer 3: DANGEROUS_EVAL_FLAGS blocklist → node -e / python -c = blocked
```

- **SEC-1:** execFile 正确使用，shell 仅 Win32 `.cmd`/`.bat` + 非 ASCII 条件启用 [HIGH confidence]
- **SEC-6:** trustWorkspace gate 是正确的根因边界 — defaults to false, three-way fallback (payload → config → false) [HIGH]
- **SEC-16:** session 映射两级（sessionId→sessionKey→runId），无跨 session 混淆攻击面 [HIGH]

#### 残留风险

| ID | 风险 | 严重度 | 状态 |
|----|------|--------|------|
| SEC-10 | WORKFLOW.md 可启用 destructiveGit.allow，不受 trustWorkspace 门控 | MEDIUM | **新发现** |
| SEC-14 | allow-by-default — 未知工具自动放行 (= 先前 S2) | MEDIUM | 设计决策，已文档化 |
| SEC-11 | hook 注册失败时 fail-open — 无 hook 则无权限执行 | MEDIUM | 设计取舍 |
| SEC-4 | Windows shell:true 元字符残留 — binary allowlist 减缓 | MEDIUM | = 先前 S5 |
| SEC-5 | DANGEROUS_EVAL_FLAGS 缺 Node `--import` | LOW | 需 workspace 文件 + trustWorkspace |
| SEC-3 | 允许 `pip install -e .`、`make` 执行 workspace 内容 | LOW | trustWorkspace 门控 |

---

### 维度 4: 测试充分性（B — 10 findings）

#### 覆盖矩阵

| src 模块 | 覆盖评估 | 说明 |
|----------|----------|------|
| orchestrator.ts | ✅ 优秀 | 4 个直接测试文件 + wiring tests |
| autopilot-state.ts | ✅ 优秀 | 4 个专用测试文件 |
| command-runner.ts | ✅ 优秀 | 3 个文件含安全回归测试 |
| evidence-gate.ts | ✅ 良好 | unit + e2e execFile |
| workflow-config.ts | ✅ 良好 | unit + 全 roundtrip e2e |
| projection.ts | ✅ 良好 | unit + pause-reasons e2e |
| retry-queue.ts | ✅ 良好 | 2 个文件 |
| continuation-engine.ts | ⚠️ 足够 | 1 个文件 |
| model-routing.ts | ⚠️ 偏薄 | 1 个文件，仅 integration 触及 |
| logger.ts | ⚠️ 偏薄 | 1 个文件，覆盖格式不覆盖 wiring |
| index.ts (1149行) | ✅ 良好 | plugin-entry.test.ts (48K) + 全部 7 e2e |

#### 关键 findings

| ID | 问题 | 严重度 |
|----|------|--------|
| TEST-5 | orchestrationState 在 done 后卡在 `claimed` — lifecycle e2e 冻结为 "accepted behavior" 而非修复 | **HIGH — frozen production bug** |
| TEST-6 | 完整 retry 耗尽路径无法 e2e 通过 hooks 驱动（依赖 `_triggerRetryCheckForTest` seam） | HIGH — 可测性缺陷 |
| TEST-8 | 安全负面测试偏薄：trustWorkspace:true + 非白名单 binary、shell 元字符注入、before_tool_call bash 注入 均无测试 | MEDIUM |
| TEST-7 | workflow-config-roundtrip.e2e 是套件中最强安全测试 — 验证 `trustWorkspace false > true` 优先级 | 正面 |
| TEST-2 | createMockApi harness 在 5 个文件中复制粘贴 — 维护负担（不影响正确性） | LOW |

#### 缺失测试场景

| 优先级 | 场景 | 风险 |
|--------|------|------|
| 1 | trustWorkspace:true + 非白名单 binary → commands dropped | RCE if allowlist removed |
| 2 | 完整 retry chain e2e (stall→retry→stall→…→blocked) | wiring bug 不可检测 |
| 3 | evaluateEvidence results 乱序 | ID lookup 可能 order-dependent |
| 4 | parseCommandArgs 空/纯空格命令 | 可能 uncaught throw |
| 5 | 并发 activate + stop 同一 sessionKey | JS event-loop 级竞态 |

---

### 维度 5: API/DX（B- — 11 findings）

#### 关键 findings

| ID | 问题 | 严重度 |
|----|------|--------|
| DX-3 | README 36 行 — 缺 config reference、gateway 合约、WORKFLOW.md 格式、AUTOPILOT_LOG_LEVEL/FORMAT env vars、AutopilotProjection 字段参考、troubleshooting | **HIGH** |
| DX-1 | 5 个 `_*ForTest` 函数 unconditional 导出到 `.d.ts`；`generateRunId()` 委托到 `_generateRunIdForTest()` — test helper IS production code | **HIGH** |
| DX-9 | 无 `exports` map — `import { orchestratorReducer } from '@oh-my-matrix/autopilot/dist/src/orchestrator'` 合法 | MEDIUM |
| DX-2 | 6 gateway methods 中 `setGoal` 和 `cleanup` 未文档化 | MEDIUM |
| DX-5 | configSchema 5/9 字段缺描述；tokenBudget 无单位/默认值 | MEDIUM |
| DX-6 | WORKFLOW.md schema 完全隐含于 `parseAutopilotSection` (143-237行) — 无示例随包分发 | MEDIUM |
| DX-7 | WORKFLOW.md config 错误 activate 时不报告 — 存入 workflowConfigError，activate 仍返回 ok:true | MEDIUM |
| DX-11 | 3.0.0 无包级 CHANGELOG 和 2.x→3.0.0 migration guide | LOW |

---

### 维度 6: 运行韧性（B — 11 findings）

#### 关键 findings

| ID | 问题 | 严重度 |
|----|------|--------|
| RES-2 | **`classifyRecoverability` 漏掉主要瞬态模式** — 仅匹配 `'transient'` 和 `'tool fail'` 两个字面字符串；429 (rate_limit)、ECONNREFUSED、ETIMEDOUT、503、"fetch failed"、"network error" 全部 fallthrough 到 non-recoverable | **HIGH — bug** |
| RES-7 | 驱逐策略标注 "LRU" 实为 FIFO (按 startedAt) — `lru-cleanup.test.ts` 名称误导；活跃长运行 session 可能被优先驱逐 | MEDIUM |
| RES-5 | 新 session runId 用 Math.random (41 bits) vs 重激活用 crypto.randomUUID (122 bits) | MEDIUM |
| RES-9 | cleanupAll 对 paused/done session 过度释放 audit refcount | MEDIUM |
| RES-10 | token budget 存储不 enforce — 无 before_agent_finalize/llm_output 检查；子 agent tokens 不计入 | MEDIUM |
| RES-8 | 24h 孤儿清理无状态过滤 — paused session 也被静默删除 | MEDIUM |
| RES-3 | stall timeout 隐式耦合 tokenBudget 存在性（有 budget → 5min，无 → 10min） | LOW |

---

## 业界最佳实践对照

| 实践 | 现状 | 评价 |
|------|------|------|
| Redux reducer pattern | orchestratorReducer 纯函数 + immutable | ✅ 优秀 |
| Single source of truth | 双状态机违反此原则 | ⚠️ 需统一 |
| XState statechart | 7 态 + 明确转换，无 formal statechart 定义 | ⚠️ 可改进 |
| Plugin 最小 hook surface (Webpack/Rollup) | 12 hooks，各有明确用途 | ✅ 合理 |
| Fail-closed security (OWASP) | trustWorkspace default-off + binary allowlist | ✅ 优秀 |
| Command injection prevention | execFile + no shell + argv array | ✅ 优秀 |
| Exponential backoff + jitter (AWS) | 退避正确，jitter 缺失 | ⚠️ |
| Error classification (transient vs permanent) | 大量真实瞬态模式未覆盖 | ❌ 关键缺陷 |
| Circuit breaker (Netflix Hystrix) | 无自主熔断，仅 max_retries → blocked | ❌ 缺失 |
| Structured logging (ELK/Datadog) | logWithContext 仅 6/40+ callsite 使用 | ⚠️ 不一致 |
| Coverage enforcement ≥80% | 无配置 | ❌ 缺失 |
| npm `exports` map | 无 — deep import 不受限 | ❌ 缺失 |
| semver + CHANGELOG | 版本号正确，包级 CHANGELOG 缺失 | ⚠️ 需补充 |

## OpenClaw 最佳实践对照

| 实践 | 现状 | 评价 |
|------|------|------|
| Hook priority 声明 | `BEFORE_TOOL_CALL_PRIORITY = 10`（高于审计 9） | ✅ |
| Gateway method 参数验证 | 每个方法检查 sessionKey + 状态前提 | ✅ |
| Plugin config via JSON Schema | openclaw.plugin.json configSchema 完整 | ✅ |
| Session extension registration | 已注册 project() 和 cleanup() | ✅ |
| Cross-turn injection | enqueueNextTurnInjection + 3 层 fallback | ✅ |
| Plugin 降级处理 | audit plugin 缺失时 warn + 继续 | ✅ |
| Hook 注册 API 兼容 | api.on ?? api.registerHook fallback | ✅ |

---

## 如果要实施修复

### P0 修复方案

**1. 统一 tokenizer**
- 从 `command-runner.ts` 导出 `parseCommandArgs`
- `workflow-config.ts` 删除 `tokenizeCommand`，改为 `import { parseCommandArgs } from './command-runner'`
- 添加对比测试：20+ 边界 case 确认一致性
- 关键文件：`src/command-runner.ts`, `src/workflow-config.ts`

**2. classifyRecoverability 补全**
- 在 `retry-queue.ts:classifyRecoverability` 添加 recoverable 模式：
  - rate-limit: `429`, `rate_limit`, `rate limit`, `too many requests`
  - network: `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `fetch failed`, `network error`
  - server: `500`, `503`, `service unavailable`, `internal server error`
- 添加对应测试 case
- 关键文件：`src/retry-queue.ts`, `tests/retry-queue.test.ts`

**3. runId 统一**
- `index.ts:982` 的 `Math.random()` 改为 `generateRunId()`（已有函数，一行修复）
- 关键文件：`index.ts:982`

### 验证方式

1. `pnpm -r test` — 全量测试通过
2. `pnpm -r typecheck` — 类型检查通过
3. tokenizer 统一后：`grep -r 'tokenizeCommand' packages/autopilot/` 返回 0 结果
4. classifyRecoverability：`vitest run tests/retry-queue.test.ts` 新增 case 通过
5. runId 统一后：`grep 'Math.random' packages/autopilot/index.ts` 返回 0 结果

---

## 附录：架构图

```
index.ts (1149 lines, OpenClaw plugin entry)
├── Module-level state
│   ├── stateByRun: Map<string, AutopilotState>  (MAX 50, FIFO eviction)
│   ├── sessionIdToKey / sessionKeyToRunId        (two-level session mapping)
│   ├── canaryFired: Set<string>                  (degradation detection)
│   └── stallInterval                              (60s periodic check)
│
├── Hook handlers (12 hooks)
│   ├── before_agent_finalize  → continuation decision → evidence gate → complete/pause
│   ├── agent_end              → canary check → degraded recovery → cross-turn inject
│   ├── after_tool_call        → tool error tracking + stall detector activity
│   ├── before_compaction      → goal snapshot
│   ├── after_compaction       → goal restore
│   ├── agent_turn_prepare     → goal/effort injection + model tier context
│   ├── before_model_resolve   → model tier override (via ModelRoutingConfig)
│   ├── before_agent_run       → excluded agent blocking
│   ├── before_tool_call       → permission-policy classify + audit trail
│   ├── llm_output             → token tracking + stall detector activity
│   ├── session_start          → sessionId → sessionKey mapping
│   └── session_end            → state cleanup
│
├── Gateway methods (6 methods)
│   ├── autopilot.activate     → concurrency check → (re)activate → workflow config
│   ├── autopilot.stop         → orchestrator stop_requested → deactivate
│   ├── autopilot.resume       → orchestrator resume_requested → resume
│   ├── autopilot.status       → projectState() read
│   ├── autopilot.setGoal      → setGoal()
│   └── autopilot.cleanup      → cleanupAll()
│
└── src/ (pure functions + I/O boundary)
    ├── Pure (12): orchestrator, autopilot-state, continuation-engine,
    │   completion-detector, evidence-gate, projection, model-routing,
    │   effort-injection, retry-queue, stall-detector, tool-error-tracker,
    │   goal-manager
    └── I/O (4): command-runner, workflow-config, project-detector, logger
```

---

*Round 1: 6 scientist agents × 87 findings 交叉验证 + 主循环 17 模块 + 1149 行 index.ts 直读。*
*★ = 多 agent 一致确认。*

---

## Round 2 — 深挖分析

基于 Round 1 识别的 gap，第二轮发射 6 个深挖 agents（3× opus + 3× sonnet），聚焦根因分析和攻击面审计。

### 新发现：Triple Tokenizer（升级 CQ-11 → CQ-11+）

Round 1 识别了 autopilot 内的双重 tokenizer（CQ-11）。读完 permission-policy 源码后确认实际是**三重复制**：

| # | 函数 | 包 | 文件:行 |
|---|------|---|---------|
| 1 | `parseCommandArgs` | autopilot | `src/command-runner.ts:75-95` |
| 2 | `tokenizeCommand` | autopilot | `src/workflow-config.ts:70-88` |
| 3 | `tokenizeShell` | permission-policy | `src/permission-policy.ts:43-58` |

三份功能相同的 quote-aware tokenizer 分布在两个包中。任何一份修了 bug 其他两份不跟 → 分类/执行 argv 分歧 → 安全隐患。

**建议：** 在 permission-policy 中导出 `tokenizeShell` 作为共享原语，autopilot 的两份删除改为 import。

---

### Stage 7: 双状态机根因分析（ARCH-2 深挖）

**根因确认（HIGH confidence）：**

`before_agent_finalize` 的 revise 循环完全在 Model A（imperative mutators: `incrementTurn`/`incrementTotal`/`complete`/`pause`）中运行，**从不 dispatch orchestrator events**。因此 Model B（OrchestrationState）在整个 revise 循环期间停留在 `claimed`，永不推进到 `running` → `released` → `done`。

**状态分歧图：**

```
             Model A (status)          Model B (orchestrationState)
             ────────────────          ──────────────────────────────
activate:    idle → running            → unclaimed → claimed
revise×N:    running (no change)       claimed (no change — no events)
complete:    running → done ✓          claimed (STUCK ✗)
             via complete()             evidence guard sees ≠'released' → skip
```

**evidence gate 被跳过的路径：**
1. `before_agent_finalize` complete path 检查 `state.orchestrationState === 'released'`（index.ts:421）
2. `orchestrationState` 仍为 `claimed`（因为 `agent_turn_finished(success)` 从未被 dispatch）
3. evidence reducer 整个跳过 → `complete()` 直接设 status='done' → orchestrationState 永远卡在 'claimed'

**具体统一方案（4 步）：**

| 步骤 | 内容 | 影响范围 |
|------|------|---------|
| 1 | 扩展 reducer 处理所有 status 转换 — 新增 `complete_requested`、`pause_requested`、`deactivate_requested` events | `orchestrator.ts`, `types.ts` |
| 2 | index.ts 中替换 ~12 处 imperative mutator 调用为 reducer dispatch | `index.ts` |
| 3 | `complete_requested` 从任何 active 态（unclaimed/claimed/running/released）→ done，不依赖 'released' 前提 | `orchestrator.ts` |
| 4 | 删除 `autopilot-state.ts` 中的 activate/deactivate/pause/complete/resume（保留 isRunStuck 作为只读谓词） | `autopilot-state.ts`, 所有 test files |

---

### Stage 8: 完成检测器深度分析

**假阳性风险（会错误触发完成）：**

| 风险 | 示例消息 | 命中模式 | 问题 |
|------|---------|---------|------|
| **HIGH** | `"all tasks completed for module X, moving to Y"` | E2 | 子任务完成被当作全局完成 |
| **HIGH** | `"所有任务已完成，但还需要人工验证。"` | C1 | 中文模式无否定守卫（但/需要/待） |
| **MEDIUM** | `"migration all tasks been completed in staging; prod pending"` | E1 | 环境限定被忽略 |

**假阴性风险（不会触发完成）：**

| 风险 | 示例消息 | 问题 |
|------|---------|------|
| **HIGH** | `"Done!"` / `"Finished."` / `"That's everything."` | 无短格式英文完成模式 |
| **HIGH** | `"The implementation is complete."` | E5 要求 `task is complete`，不匹配 `implementation is complete` |
| **MEDIUM** | `"All 5 tasks completed"` | E2 `\ball\s+tasks` 不允许数字在 all 和 tasks 之间 |

**MIN_TURNS_BEFORE_COMPLETE = 2 的代价：**
- 简单单步任务（如 "重命名这个变量"）被迫多跑 2 个 continuation turn
- 每个 revise turn 都重新运行模型 — 对简单任务浪费 tokens
- `hasNoActionableTask` 正确绕过此限制（无任务时立即停止）

**建议优先级：**

| # | 严重度 | 建议 |
|---|--------|------|
| R1 | HIGH | 添加短格式英文完成模式 `\b(done|finished|complete)\b` + 上下文锚定 |
| R2 | HIGH | 为 scoped completion 添加 lookahead 抑制（`moving on`/`next step`/`continuing`） |
| R7 | LOW | 为中文模式添加否定 lookahead（`但`/`不过`/`然而`/`需要`/`待`） |
| R5 | MEDIUM | 简单任务优化：如果当前 turn 使用了 edit/write tool，降低 MIN_TURNS 到 1 |

---

### Stage 9: 跨包 API 契约审计

**结论：契约设计良好，当前紧密。**

- 类型零分歧 — autopilot re-export `CommandClass`/`PermissionAuditEntry` from permission-policy（非自定义类型）
- `ToolEventLike` 是最小结构类型 — 只读 `toolName` + `params.command`/`params.workdir`，不耦合 OpenClaw 内部
- Hook 优先级无干扰 — dynamic-workflows(11, subagent only) 和 autopilot(10, autopilot-run only) 作用域不重叠
- 审计持久化 concurrent-safe — `appendFileSync` 在 POSIX 上对 <4KB 写入原子

**1 个 actionable gap：**
- **autopilot 缺少编译时 event-shape 契约** — dynamic-workflows 有 `event-shape.contract.ts` pin OpenClaw 事件形状，autopilot 没有。如果 OpenClaw 改变 hook event 形状，autopilot 的 `event: any` 不会在编译时捕获。
- `require_approval` 是 vestigial outcome — `PermissionAuditEntry.outcome` 包含但永远不会产生；autopilot 只处理 `allow`/`block`

---

### Stage 10: Evidence Gate 可绕过性分析

**8 条绕过路径，3 条 HIGH：**

| # | 路径 | 评级 | 说明 |
|---|------|------|------|
| 1 | **空 commands（trustWorkspace=false 默认）** | HIGH | 默认路径 — 所有不受信 run 以 evidence='skipped' 完成，无验证 |
| 3 | **orchestrationState ≠ 'released'** | HIGH | evidence_started/evidence_finished 不 dispatch 到 reducer → 失败不会触发 retry，run 直接 complete。orchestrator 的 evidence retry 逻辑是**死代码**当 state 未到 'released' |
| 5 | **Agent 修改测试文件** | HIGH (需 trust) | Agent 可改 test/package.json/删测试 → exit 0 → pass |
| 2 | fail-open catch 块 | MEDIUM | evidence 管道抛异常 → 'skipped' → 静默通过 |
| 4 | hasNoActionableTask 绕过 MIN_TURNS | MEDIUM | Agent 发 "How can I help?" → turn 1 complete + evidence='skipped' |
| 8 | exit 0 伴随实际失败 | MEDIUM | vitest --passWithNoTests 等工具行为 |
| 6 | Agent 修改 WORKFLOW.md | LOW | 需重新 activate 才生效 |
| 7 | stop_requested during evidence | LOW | Node 单线程阻止真正竞态 |

**关键建议：**
- log `failureReason`（当前只 log `evidenceStatus`，无法区分正常 skip 和错误 skip）
- 考虑 fail-closed（evaluation error → 'failed' + retry，而非 'skipped'）
- 修复 orchestrationState invariant — 确保 `agent_turn_finished` 必须在 complete 前 dispatch

---

### Stage 11: YAML 解析器攻击面

**3 个 HIGH 级新发现：**

**1. 数值字段无边界验证**

| YAML 值 | JS 结果 | 效果 |
|---------|---------|------|
| `max_concurrent: Infinity` | `Infinity` | 无限并发 |
| `max_concurrent: -1` | `-1` | 未定义行为 |
| `stall_timeout_ms: 0` | `0` | 立即标记所有任务为 stalled |
| `max_retries: 1e308` | `Infinity` | 无限重试 |
| `max_concurrent: 0x10` | `16` | hex 字面量被接受 |

**建议：** `parseAutopilotSection` 中 clamp 数值：`Math.max(1, Math.min(50, val))`

**2. 内联注释静默破坏合法配置**

```yaml
max_concurrent: 3 # set to 3 per perf testing
```
→ `parseScalar("3 # set to 3 per perf testing")` → `Number()` = NaN → 返回字符串 → 类型检查拒绝 → 静默回退到默认值 5。用户以为设了 3，实际是 5。

**3. workspace.root 路径穿越**

```yaml
workspace:
  root: ../../etc/passwd
```
→ `typeof === 'string'` → 存储原值。如果 caller 做 `path.join(baseRepoPath, config.workspace.root)`，可逃逸 repo 边界。

**其他发现：**
- BOM（`﻿`）前缀的 WORKFLOW.md → front matter regex 不匹配 → 静默回退默认
- 单 `\r`（old Mac CR 换行）未标准化 → 静默回退默认
- Markdown body 中的 `---` 分隔线 → 截断 front matter
- 引号不匹配（`"value'`）→ 外层引号不剥离 → 错误值存储

---

### Stage 12: 测试代码质量深审

| 维度 | 评分 | 最高优先问题 |
|------|------|-------------|
| Mock 保真度 | 6/10 | flat vs grouped facade 不一致 — permission-wiring/evidence-wiring 用 `api.enqueueNextTurnInjection`（flat），plugin-entry 用 `api.session.workflow.enqueueNextTurnInjection`（grouped） |
| 断言精度 | 7/10 | NaN test 是伪测试（`expect([all_actions]).toContain(result.action)` 永远通过）；截断 bound 松 3× |
| 边界覆盖 | 5/10 | 空命令字符串、result ID 乱序、部分有效配置均无测试 |
| 测试隔离 | 8/10 | fake-timer advance 金额未绑定生产常量 |
| Flake 风险 | 7/10 | 相对路径 `'src/command-runner.ts'` + 50ms 超时 |
| E2E 质量 | 9/10 | 最强层：真实 spawn、已记录偏差、完整 round-trip |

**Top 3 修复：**
1. 统一 mock API 形状为 grouped facade（`api.session.workflow.*`）
2. 替换 NaN 伪测试为真实断言
3. 源码检查测试的相对路径改为 `path.join(__dirname, ...)`

---

## Round 3 — 最终深挖

第三轮聚焦盲区扫描、activate 方法逐行审计、P0 对抗性验证、dynamic-workflows 独立审计、跨文件一致性。

### Stage 13: 5 个"简单"模块逐行审计

| ID | 模块 | 问题 | 严重度 |
|----|------|------|--------|
| BUG-TET-1 | tool-error-tracker.ts | **交替错误循环永不触发阈值** — A→B→A→B 每次换错误重置为 1 | MEDIUM |
| BUG-L-1 | logger.ts:57 | **`log(object)` JSON mode 丢失对象结构** — `args.map(String)` → `[object Object]` | MEDIUM |
| BUG-EI-1 | effort-injection.ts:27 | switch 无 `default` — ThinkingIntensity 扩展时静默返回 `undefined` | LOW |
| DEAD-SD-2 | stall-detector.ts:31 | `lastActivityAt == null` guard 是死代码 — caller 已 fallback `now` | LOW |
| BUG-SD-1 | stall-detector.ts:42 | `stallDurationMs` 命名误导（overshoot 非总时长） | LOW |
| EDGE-PD-2 | project-detector.ts | 多语言 monorepo 同时检测所有项目类型 required:true — 可能误报 | LOW |

### Stage 17: 跨文件一致性扫描

| 检查项 | 结果 | 最高优先问题 |
|--------|------|-------------|
| 错误处理 | ⚠️ | index.ts:54,98 — 两个 bare `catch {}` 零可观测性 |
| 日志格式 | ✅ | logWithContext 用于 3 处结构化审计事件 |
| Magic numbers | ❌ | `300000` 在 4 文件 7+ 处散落；goal `500` 未共享 |
| Import 风格 | ✅ | 全部 package barrel，无 deep path |
| Date.now() 纯度 | ✅ | autopilot-state.ts:113 default param 唯一违规 |
| 重复常量 | ❌ | `300_000`(×7+), `500`(×2), `120_000`(×3) |
| TODO/FIXME | ✅ | 零技术债标记 |
| 测试覆盖比 | ✅ | 43:17 = 2.5:1 |

### Stage 14-16: 最终深挖结果

### Stage 14: activate Gateway Method 逐行审计

| # | 位置 | 严重度 | 问题 |
|---|------|--------|------|
| 3a | L982 | **P0 Bug** | 新 session 用 `Math.random().toString(36).slice(2,10)` 而非 `generateRunId()`(crypto.randomUUID)。边界：`Math.random()=0` → runId `"run-"` |
| 2b | L956-959 | Medium | stuck run 丢弃不发 abort 生命周期事件；`sessionIdToKey` 未清理（内存泄漏） |
| 1c | L882 | Low | `maxConcurrentAutopilot: 0` 静默阻止所有 activate（未文档化） |
| 4a | L896 | Low | maxTotalContinuations 500 上限未在 API 合约文档化 |
| 2d | L963 | Trivial | `newState.goal` 永远 undefined — fallback chain 死代码 |

**验证为非问题：** TOCTOU 并发竞态（同步块无真实竞态）、paused 不计数（设计意图）、tokenBudget:Infinity（`Infinity > 0` = true，预算检查永不触发 — 正确语义）

### Stage 15: P0 对抗性验证 ⚡ 关键修正

| P0 | 原始发现 | 裁决 | 关键证据 |
|----|---------|------|---------|
| P0-1 | 三重 tokenizer 可能产生不同 argv | **REFUTED** | 16/16 边界 case 全部产生相同输出（空字符串、未终止引号、tab、Unicode、混合引号等） |
| P0-2 | classifyRecoverability 缺少 rate-limit/network/5xx | **REFUTED** | 函数分类**内部 autopilot 错误词汇**（stalled/validation_failed/permission），非 HTTP 错误。429/ECONNREFUSED 在传输层处理，不到达插件 |
| P0-4 | YAML 解析器接受 Infinity | **CONFIRMED → P2** | `parseScalar("Infinity")` 确实返回 Infinity 通过 typeof guard，但 `WorkflowConfig.maxConcurrent` 是**死代码** — 运行时并发门控用 `config.maxConcurrentAutopilot`（operator-controlled pluginConfig） |
| P0-5 | 内联 YAML 注释破坏配置 | **REFUTED** | `Number("3 # comment")` → NaN → `typeof !== 'number'` → 静默回退默认值(5) — typeof guard 正确拦截 |

**净结果：4 个 P0 中 3 个被推翻，1 个确认但降级为 P2（死代码路径）。** 唯一保留的 P0 是 runId Math.random()（Stage 14 再次确认）。

### Stage 16: dynamic-workflows 完整安全审计

**最高严重度新发现：**

| 向量 | 严重度 | 说明 |
|------|--------|------|
| **缺少 ctx.sessionKey → fail-open** | HIGH | `index.ts:75`: `if (!sessionKey) return;` — 缺失 sessionKey 时无条件放行所有工具调用。应返回 `{ block: true }` |
| **permission-policy 抛异常 → uncaught** | MEDIUM | hook body 无 try/catch — 异常传播到 OpenClaw host，是否 block 取决于 host 行为（未验证） |
| `bash -c 'git reset --hard'` 嵌套 | MEDIUM | B3 fix 已声称修复，但本包无测试覆盖 |
| SKILL.md 文档 `workflowAllowsDestructiveGit` 例外 | Doc-only | 运行时硬编码 `false`，文档描述的例外不可行使（fail-safe 但误导） |

**建议修复：**
1. hook body 包裹 try/catch 返回 `{ block: true }` — 关闭 uncaught-exception fail-open
2. `if (!sessionKey) return { block: true, blockReason: 'missing sessionKey' }` — 关闭缺失 key fail-open

---

## 修正后的优先级清单

基于三轮 17 个 agents 的交叉验证和对抗性审计，P0 清单大幅修正：

### P0 — 必须修（仅 1 项保留）

| # | 问题 | 来源 | 验证状态 |
|---|------|------|---------|
| 1 | ★ **统一 runId 生成** — 新 session 路径用 `Math.random()`，重激活路径用 `crypto.randomUUID()` | CQ-2, RES-5, Stage14 | **CONFIRMED** — 一行修复 |

### P1 — 应该修

| # | 问题 | 来源 |
|---|------|------|
| 2 | ★ 双状态机统一 — legacy AutopilotStatus 吸收入 orchestrator reducer | ARCH-2, Stage7 |
| 3 | dynamic-workflows 缺失 sessionKey fail-open | Stage16 — **HIGH severity** |
| 4 | dynamic-workflows hook body 无 try/catch | Stage16 — MEDIUM |
| 5 | orchestrationState 在 done 后卡 'claimed' + evidence gate bypass | TEST-5, Stage7, Stage10 |
| 6 | WORKFLOW.md 可在不受信 workspace 启用 destructiveGit.allow | SEC-10 |
| 7 | 添加 vitest coverage 配置 | TEST 综合 |
| 8 | 完成检测器假阴性 — "Done!"/"Finished." 不触发完成 | Stage8 |

### P2 — 改善

| # | 问题 | 来源 |
|---|------|------|
| 9 | 三重 tokenizer 代码重复（当前不分歧但维护风险） | CQ-11 **降级** |
| 10 | test helper 污染公共 barrel + 无 exports map | DX-1, DX-9 |
| 11 | README 过于简短 | DX-3 |
| 12 | 14 个 hook handler 全 `any` 类型 | CQ-6 |
| 13 | cross-turn fallback 3 次复制粘贴 | CQ-10 |
| 14 | YAML 数值字段接受 Infinity/-1（死代码路径） | Stage11 **降级** |
| 15 | evidence gate fail-open catch 应改 fail-closed | Stage10 |
| 16 | BUG-TET-1: 交替错误循环永不触发阈值 | Stage13 |
| 17 | Magic number `300000` 散布 4 文件 7+ 处 | Stage17 |

### P3 — 可选

| # | 问题 |
|---|------|
| 18 | goal-manager.ts pass-through 可删除 |
| 19 | 24h 孤儿清理静默驱逐 paused session |
| 20 | cleanupAll audit refcount 过度释放 |
| 21 | 退避公式缺 jitter |
| 22 | 驱逐 FIFO 标为 "LRU" |
| 23 | autopilot 缺编译时 event-shape contract |
| 24 | configSchema 5/9 字段缺描述 |
| 25 | index.ts:54,98 bare catch {} 零可观测性 |

---

*三轮 17 个 scientist agents（7× opus + 10× sonnet）完成。P0 对抗性验证推翻 3/4 原始 P0，降级 1 项至 P2。最终 P0 仅保留 runId 统一（一行修复）。*
