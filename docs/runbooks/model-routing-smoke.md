# Model Routing & Thinking Intensity — Host-Deploy Smoke

> **状态:专项 smoke checklist。** 验证 `@oh-my-matrix/autopilot` 的分级思考强度 + 模型 tier 路由在 MA gateway 线上真实生效。
>
> 这是 [host-deploy.md step 5](host-deploy.md) 的专项补充 —— 通用 smoke 聚焦 runtime guard;本文聚焦 model routing。两者都在 host-deploy 完成后、在 MA 仓库内执行。
>
> **核心教训**(同 [fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md)):仓库单测全绿 ≠ 线上生效。尤其 **subagent 覆盖**目前只有源码推断(`runEmbeddedAgent` 同函数复用),无 e2e 测试钉死 —— 本 smoke 的 C 段是唯一的运行时证据。

## 何时用

autopilot 源码含以下变更之一,且 host-deploy(见 host-deploy.md step 1–4)完成后:

- `effort-injection.ts`(分级思考强度)
- `model-routing.ts` / `before_model_resolve` hook(模型路由)
- `WorkflowConfig.model_routing`(配置面)

## 前置

- host-deploy.md step 1–4 全部完成(尤其 **gateway 已重启**,否则加载旧 module)
- 能看到 autopilot 日志输出(gateway log / MA 控制台)
- 能修改 OpenClaw plugin config(MA 的 autopilot 配置)

---

## A. 分级思考强度(thinking intensity)

**验证**:`resolveThinkingIntensity` 在不同执行阶段注入不同的 effort 文本。

1. 配置 `thinkingIntensity: 'medium'`(plugin config)
2. 启一个 autopilot session,跑一个多 turn 任务(让它跨阶段)
3. 观察每个 turn 的 `[autopilot-effort]` 注入串(appendContext / 日志):

| 阶段 | 预期注入串 |
|------|-----------|
| 初始 turn(`totalContinuations` 0–1) | `Use high effort (extended thinking)` — resolver 覆盖 config |
| 实现 turn(后续 continuation) | `Use moderate effort (some extended thinking)` — 用 config `'medium'` |
| 验证阶段(`evidence.status === 'running'`) | `Use standard effort. Prefer direct, efficient` — phase 强制 low |

**判据**:注入串随阶段变化,不是恒定 "high effort"。

## B. 模型 tier 路由(before_model_resolve override)

**验证**:autopilot 返回 `modelOverride`,Gateway 实际切换模型。

1. 配置:
   ```json
   "modelRouting": {
     "defaultTier": "standard",
     "initialTurnTier": "premium",
     "modelIds": {
       "premium": "claude-opus-4-8",
       "standard": "claude-sonnet-4-6"
     }
   }
   ```
2. 启 autopilot session,观察 gateway 日志:
   - 初始 turn:`[autopilot] before_model_resolve: session=... tier=premium model=claude-opus-4-8`
   - 实现 turn:`tier=standard model=claude-sonnet-4-6`
3. **判据**:Gateway 实际发起的 LLM 调用用的是 `modelOverride` 指定的模型(不是 session 默认模型)。查 gateway 的 model-call 日志确认。

## C. subagent 覆盖(关键 e2e — 补源码推断缺口)

**本次最关键的验证。** 源码层面 subagent 经 `runEmbeddedAgent` 同函数 → `before_model_resolve`,但**无 e2e 测试钉死**。本段是唯一运行时证据。

1. autopilot **running 期间**,触发一个 dynamic workflow(让 agent 生成 `.prose` 扇出 subagent,或 `sessions_spawn`)
2. 观察子 session 的日志(其 sessionKey 含 `:subagent:`):
   - `[autopilot] before_model_resolve: session=agent:<main>:subagent:<id> tier=... model=...`
3. **判据**:
   - 日志出现(subagent 也触发了 hook)✅
   - subagent 实际模型 = 配置的 `subagentTier`(若配)或父 run 的 phase tier
   - 配了 `subagentTier: budget` + `modelIds.budget` → subagent 用 budget 模型(**不是继承父模型**)
4. **失败信号**:subagent 日志无 `before_model_resolve` 行,或模型没变 → 源码推断的"同函数复用"在运行时不成立。回查 `ctx.sessionKey` 在 child run 的实际值 + `extractParentSessionKey` 父 run 解析。

## D. 不干预(向后兼容 / 零干扰)

**验证**:不配 `modelIds` 时,autopilot 不返回 override,`.prose` `model:` 声明照常生效。

1. 只配 `thinkingIntensity`(或都不配),**不配** `modelRouting.modelIds`
2. 启 autopilot + 一个带 `model: sonnet` 的 `.prose` workflow
3. **判据**:
   - 日志**无** `[autopilot] before_model_resolve` 行(不干预)
   - `.prose` agent 实际用 `sonnet`(声明生效)

## 失败回滚

| 症状 | 可能原因 | 回退 |
|------|---------|------|
| 验证阶段 low effort → continuation 误判完成 | low effort 让 agent 草率说 "all tasks completed" | `thinkingIntensity: 'high'`(或去掉验证→low 逻辑) |
| subagent 模型没切换 | `ctx.sessionKey` 不含 `:subagent:` / 父 run 解析失败 | 查 child sessionKey 实际格式;暂退 `subagentTier` |
| Gateway 报 modelOverride 无效 | `modelIds` 的模型 ID 在 provider 不存在 | 核对 modelId 字符串(provider/model 格式) |

## 诚实红线

1. **仓库单测绿 ≠ 线上 subagent 真切换。** C 段是唯一 e2e 证据;不跑就 ship = 重蹈 runtime-guard placebo([fixes 文档](../fixes/runtime-guard-event-shape.md)教训)。
2. **不重启 = 旧 module。** host-deploy.md step 4 不可省。
3. **modelOverride 是硬覆盖。** 配了 `modelIds` 就覆盖 `.prose` 声明 —— 想保留 `.prose model:` 就别配 `modelIds`(见 D 段)。

## 相关

- [设计文档](../design/model-routing-thinking-intensity-design.md) — 完整设计 + OpenClaw 源码锚点
- [host-deploy.md](host-deploy.md) — 通用部署 runbook(本文是其 step 5 专项补充)
- [fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md) — placebo 教训(单测绿 ≠ 线上)
