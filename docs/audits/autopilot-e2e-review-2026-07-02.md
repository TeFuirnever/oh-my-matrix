# Autopilot 第二轮 E2E 对抗审查（2026-07-02）

> 方法：6 个并行 scientist agent（4 opus + 2 sonnet）产出发现 → 3 个 opus code-reviewer **对抗验证**（每项尝试推翻）。
> 62 项原始发现 → 去重 27 项 → 对抗后 **6 项推翻、4 项降级、1 项升级**。
> 配套上一轮审计：[autopilot-e2e-audit-2026-07-01.md](./autopilot-e2e-audit-2026-07-01.md)（编号 #1–#22，与本轮 PROD/LOGIC/ARCH/API/TEST/SEC 独立）。
> 执行追踪见 [autopilot-fix-checklist.md](./autopilot-fix-checklist.md) 的 Wave 5–7。

## 执行摘要

**整体质量 GOOD。** 对抗验证证实：无 CRITICAL/HIGH 安全漏洞，无数据丢失 BUG。两个初判 P0（`before_model_resolve` 声明缺失、stall interval 无 try/catch）经对抗**均被推翻为假阳性**。纯函数核心（orchestrator、stall-detector、evidence-gate、retry-queue、continuation-engine）100% 覆盖、设计优秀。

**唯一真 P0**：stall 恢复不重启执行——且首次修复（#65）不完整，二次修复（#66）才真正闭环。

## 已修复（Wave 5–7）

| ID | 严重度 | 问题 | 修复 | PR |
|----|--------|------|------|-----|
| PROD-7 | P0 | stall 恢复死路：retry_due→claimed 后无 actuator，run 卡 claimed 直到 24h 清理 | reducer 设 `needsCrossTurnResume` + **actuator `kickResumedTurn` 在 stall interval / resume gateway 实际 enqueue 新 turn** | #65→#66 |
| LOGIC-3 | P1 | `hasNoActionableTask` 正则误匹配 "I don't have the task finished yet"，且 `decideContinuation` 无 turn 守卫直接 complete | 加负向前瞻阻断 past-participle（finished/done/completed…） | #65 |
| PROD-1 | P1 | `loadWorkflowConfig` 内部 catch 吞掉 I/O 错误，外层 `workflowConfigError` 是死代码 | catch 写入 `ioWarnings` 并随返回值携带 | #65 |
| LOGIC-4 | P1 | 程序化 resume 后卡 claimed（stall 检测也不检查 claimed，救不了） | resume gateway 调 `kickResumedTurn` enqueue 新 turn | #65→#66 |
| PROD-2 | P2 | `sessionExtension.cleanup` 只删 stateByRun，漏 sessionKeyToRunId/canaryFired | 补两个 `.delete()` + 测试 | #67 |
| PROD-6 | P2 | `stallInterval` 未 `.unref()`，阻止进程退出 | 加 `stallInterval?.unref?.()` | #67 |
| PROD-3/4 | P2 | tool error / blocked tool call 日志在 INFO，默认过滤下不可见 | 改 WARN | #67 |
| API-4 | P2 | openclaw peer dep 无上界 | 加 `<2027` | #67 |
| API-6 | P2 | `resolveSessionKey` 用 `Record<string, any>` | 改具名类型 | #67 |
| API-7 | P2 | 死代码 export `HookHandler`/`RegisterHookFn` | 删除 | #67 |
| PROD-5 | P2 | goal 明文进 activate/setGoal 日志（PII） | 改记 `goalLen` 不记内容 | #68 |
| PROD-9 | P2 | `parseSimpleYaml` 空行/注释逐行递归，理论 stack overflow | 改迭代循环跳过 + robustness 测试 | #68 |

**验证基线**：autopilot 51 files / 690 tests 绿 + typecheck 通过。

### PROD-7 的教训（供后续参考）

`needsCrossTurnResume` 是**消费型防重复标记**（在 `enqueueNextTurnInjection` 已排队新 turn *之后*设置，由 `before_agent_finalize` 在新 turn 到达时清除以防注入循环），**不是触发器**。纯 reducer 无法 enqueue，所以 #65 只在 reducer 设标记 = run 仍卡 claimed。真正闭环必须在 actuator 层（`index.ts` stall interval / resume gateway，能拿到 `api.session.workflow.enqueueNextTurnInjection`）实际 enqueue —— 见 `kickResumedTurn`（`index.ts:103`）。

## 对抗验证推翻的假阳性（不修）

| ID | 初判 | 推翻理由 |
|----|------|----------|
| ARCH-14 | P0 stall interval 无 try/catch | Node.js 不会因回调异常停止 interval；回调体全是纯函数无 throw 路径 |
| API-1（功能层） | P0 model routing 静默失效 | host 用 SDK 硬编码 `PLUGIN_HOOK_NAMES` 常量校验 `api.on()`，**不读** manifest hooks 数组；`before_model_resolve` 在常量中，正常触发。`package.json` 与 `openclaw.plugin.json` 不同步仅 cosmetic |
| LOGIC-2 | P1 stall 丢弃慢 agent 成功结果 | `agent_turn_finished` 唯一 dispatch 点用 stall 前捕获的**本地副本**，不读 Map，guard 永远通过 |
| LOGIC-6 | P2 input/output token 缺 NaN/负数守卫 | 上游 SDK 保证非负；且仅 informational，安全关键的 `totalTokensUsed` 已守卫 |
| LOGIC-5 | P2 retry counter 跨故障类型共享是 bug | 有意设计——总重试预算安全帽（分离计数会放大到 9 次） |
| LOGIC-1 | P1 async yield stale state 覆写 | race 机械存在但结果恒正确（done 覆盖误判的 retry_queued 是对的）；降级为 info |

## 剩余 Backlog（🔵 需设计/规划，未修）

> 每项带 file:line、修复方向、测试策略、defer 理由，供后续对话直接接手。

### ARCH-4 — 双状态机统一（重构，非 bug）
- **位置**：`src/autopilot-state.ts`（AutopilotStatus: idle/running/paused/done）与 `src/orchestrator.ts`（OrchestrationState: unclaimed/claimed/running/retry_queued/released/blocked/done）并存于同一 `AutopilotState`。
- **气味**：`orchestratorReducer` 的 `evidence_finished`（`orchestrator.ts:199`）直接写 `status:'done'`，绕过 `complete()`；`index.ts:446` 的 H1 guard 正因此存在。类型层面可表达不可能组合（idle + orchState:running）。
- **对抗结论**：PARTIALLY_CONFIRMED —— guard 已防 crash，**无运行时缺陷**，纯设计气味。与上一轮 #2 同结论（评估后不做）。
- **重开时机**：下一个需新增状态（如 `cancelling`）的功能需求到来时才值得统一。届时改判别式联合（discriminated union）使非法态不可表达。

### TEST-1 — coverage 阈值形同虚设
- **位置**：`vitest.config.ts` 阈值 statements/functions/lines 60、branches 55；实际 92/95/92/85。
- **修复**：提到接近实际（如 stmts 88 / branches 72）。**注意**：单纯提阈值当前会通过，但会锁死后续；配合 TEST-3 补测试后再提更稳。
- **测试策略**：改配置即验证（CI 跑 coverage 不破）。

### TEST-2 — 源码扫描测试脆弱
- **位置**：`tests/tier1-type-safety.test.ts:142`、`tier2-quality.test.ts:15`、`command-runner.test.ts:141` 用 `readFileSync` 断言源码字符串模式（如 `clearInterval(stallInterval)` 正则、`console.log` 计数）。
- **问题**：任何重命名/格式化/注释编辑都会破坏；模式出现在注释里会假通过。
- **修复方向**：替换为行为测试或 lint 规则（eslint no-console 等）。中等重构。

### TEST-3 — index.ts 分支覆盖 74.8%（最大缺口）
- **位置**：`index.ts` 1200+ 行，310 分支点。未覆盖：`before_agent_finalize` 决策树（degraded/effort/并发 turn）、`after_tool_call` 错误分类阈值、`before_compaction` 无 active run、`session_end` 与 in-flight evidence 竞态、`agent_turn_prepare` 各 model-routing 分支。
- **修复方向**：用 `plugin-entry.test.ts` 的完整 register mock 补 hook 决策树测试。中等工作量。

### TEST-7 — e2e 实为集成测试（正名）
- **位置**：`tests/e2e/*.e2e.test.ts` 全部用 `createMockApi()` + 直接 `register()`，无真实 gateway transport/IPC。唯一例外 `evidence-gate-execfile.e2e.test.ts`（真实子进程）。
- **修复方向**：重命名为 integration，或补一个真实 OpenClaw gateway 加载 plugin 的端到端测试。

### SEC-5 — git 全局 flag containment 不完整
- **位置**：`packages/permission-policy/src/permission-policy.ts:218`，`classifyCommand` 只剥离 `-c key=val` 和 `-C path`，不处理 `--work-tree=<path>`/`--git-dir=<path>`/`--namespace`。
- **攻击向量**：`git --work-tree=/sensitive reset --hard`（需 `destructiveGit.allow` opt-in + shell cwd 在 workspace 内）→ containment 用错 cwd。CWE-706。
- **严重度**：MEDIUM（需 opt-in）。**跨包**（permission-policy）。
- **修复**：扩展 global-flag 剥离覆盖 `--work-tree`/`--git-dir`；+测试。

### PROD-8 — audit 磁盘写入 fail-silent
- **位置**：`index.ts` 调 `appendAuditEntry`（`@oh-my-matrix/permission-policy`），comment 标注 fail-silent。磁盘满/EACCES 时审计条目永久丢失无告警。
- **修复方向**：在 `appendAuditEntry` 或 wrapper 加失败计数/warn。跨包。

### API-5 — gateway 参数 untyped
- **位置**：`src/types.ts:313` `GatewayCtx = { params: Record<string, unknown> }`；5 个 gateway method（activate/resume/stop/status/setGoal）手动 cast `ctx.goal as string` 等。
- **风险**：renderer payload 字段改名 silently 变 undefined，无 TS 报错。LOW（内部 RPC）。
- **修复**：定义 per-method param struct（ActivateParams 等）。

### API-2 — test helpers 泄漏 dist barrel（已决定接受现状）
- **位置**：`dist/index.d.ts` 导出 `_resetForTest` 等 5 个 test-only 函数。
- **决定**：**接受现状**。5 个 helper 均有 `NODE_ENV==='production'` runtime guard，仅类型 cosmetic 泄漏。干净修复需把它们访问的模块私有状态（stateByRun 等）一起移出——是重构非 quick fix，收益不抵成本。

## 安全总结（无高危）

| ID | 发现 | 严重度 | 备注 |
|----|------|--------|------|
| SEC-1 | 解释器白名单可经脚本文件绕过 | MEDIUM | 需 trustWorkspace opt-in，已文档化 |
| SEC-5 | git --work-tree 未提取做 containment | MEDIUM | 需 destructiveGit opt-in（见 backlog） |
| SEC-2 | tokenizeShell 不处理反斜杠转义 | LOW | fail-closed，不可利用 |
| SEC-6 | npm exec 递归分类信任链式 payload | LOW | trusted mode only |
| SEC-7 | audit log 路径未验证 | LOW | 内部 API |
| SEC-12 | workspace root 绝对路径委托 host | LOW | ADR-008 |

**正面（对抗确认）**：execFile 防注入、shell 替换正确阻断、git -C containment 正确、evidence gate 无绕过、orchestrator reducer 无状态混淆。

## 架构亮点

1. 纯核心 + 不纯外壳：src/ 全纯函数，可变状态集中 index.ts
2. 零循环依赖（干净 DAG）
3. `event-shape.contract.ts` 编译时 SDK 形状断言
4. 可选 peer dependency 优雅降级（audit plugin 缺失 warn + 继续）
5. LRU 驱逐正确（MAX_RUN_STATES=50）、HMR 双注册保护
