# Autopilot 修复执行清单

> 配套审计报告：[autopilot-e2e-audit-2026-07-01.md](./autopilot-e2e-audit-2026-07-01.md)
> 生成：2026-07-02 | 来源：3 轮 17 个 scientist agents + 对抗性验证
>
> **本文件是跨 session 的持久化载体。** TaskList 待办绑定单个 session（`~/.claude/tasks/session-*/`），
> 新开 session 加载不到。逐步修复时以本清单为准，完成一项勾一项。

## 执行波次建议

先清零风险快速修复（Wave 1），再做独立中型项（Wave 2），最后攻大重构（Wave 3）和跨包/文档（Wave 4）。

---

## Wave 1 — 快速修复 ✅ 完成 2026-07-02

- [x] **#1 [P0] 统一 runId 生成** — `index.ts:982` 改为 `generateRunId()`。✅
- [x] **#4 [P1] dynamic-workflows sessionKey fail-closed** — 缺失 sessionKey 返回 `{ block: true }`。+2 测试。✅
- [x] **#5 [P1] dynamic-workflows hook 加 try/catch** — 确认 subagent 后包裹，异常 fail-closed。✅
- [~] **#7 [P1] destructiveGit.allow 门控** — **评估后不修**。permission-policy 的 containment check 已把 destructive git 限制在 workspace 内（blast radius = 攻击者自己目录）；真正 RCE 向量（validation execFile）已被 trustWorkspace 门控；强制门控会破坏 autopilot 在自己 worktree 做 git 管理的合法功能。SEC-10 实为 containment-缓解的 LOW。
- [x] **#10 [P1] YAML workspace.root 穿越校验** — 加 `..` 拒绝护栏（保留绝对路径）。⚠️ 注：该字段当前是死代码（autopilot 委托 host 管 worktree，ADR-008），此为 trust-boundary 纵深防御。+2 测试。✅

**Wave 1 验证**：autopilot 50 files / 669 tests 绿 + dynamic-workflows 28 tests 绿 + 两包 typecheck 通过。

## Wave 2 — 独立中型项（无跨任务依赖）

- [x] **#8 [P1] vitest coverage 配置** — `vitest.config.ts` 加 coverage block + 阈值（60%），已装 `@vitest/coverage-v8`。基线：91.73% stmts / 84.11% branches / 96.59% funcs。✅
- [x] **#22 [P2] autopilot event-shape 契约** — 加 `src/event-shape.contract.ts`，编译时 pin `PluginHookBeforeToolCallEvent`。✅ typecheck 通过=契约成立。
- [~] **#9 [P1] 完成检测器短格式模式** — 中文否定守卫 + E5 widening 已在 PR #60 合入。剩余"Done!/Finished."短格式**评估后不加**：这两个词在 mid-task 输出中极常见（"Done! Now let's move on…"），假阳性风险远大于漏检收益；当前 7 个英文 + 3 个中文模式已覆盖绝大多数真完成。
- [~] **#16 [P2] tool-error-tracker 交替错误** — **评估后不改逻辑**。「连续相同 tool+args 失败」是有意的精确 stuck 信号；改宽（只比 tool/总数）会误停正常试错（假阳性 > 漏检交替，后者有 maxTotal 兜底）。已加注释文档化盲区为有意取舍。
- [x] **#17 [P2] magic numbers 统一** — orchestrator.ts 3 处 `?? 300000` 改为 `DEFAULT_WORKFLOW_CONFIG.maxRetryBackoffMs`；index.ts 4 处改为 `DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs`（及其 `* 2`）。✅
- [x] **#18 [P2] 子 agent token 归并** — enforce 本已在 `continuation-engine.ts:61`（agent RES-10「不 enforce」前半误报）。真实修复：`llm_output` 复用 `before_model_resolve` 的父 session 解析，子 agent token 计入父 budget。+1 测试。✅
- [x] **#19 [P2] cleanupAll refcount 过度释放** — 只对 `status==='running'` 释放 audit refcount。✅（PR #60 已合入）
- [x] **#20 [P2] 驱逐 FIFO→LRU** — 改按 `lastActivityAt`（真 LRU），更新注释和测试描述。✅
- [x] **#21 [P2] logger object 结构** — JSON mode 下 `log(obj)` 分离对象→ctx（保留结构）+ emitJson 加 circular/BigInt 防护。+2 测试。（DX-8「关键路径改 logWithContext」的批量迁移未做，留 backlog。）✅
- [ ] **#22 [P2] autopilot event-shape 契约** — 镜像 dynamic-workflows 加 `event-shape.contract.ts`，防 OpenClaw 改 event shape 时 silent fail-open。
- [x] **#15 [P2] evidence gate 可观测性** — 保留 fail-open（ARCH-13 防 zombie，catch 几乎永不触发），但消除静默：错误升 `error` 级 + `failureReason` 进结构化日志，监控可区分「正常 skip」vs「评估错误 skip」。**未采纳 agent 的 fail-closed 建议**（有 zombie 风险）。✅

## Wave 3 — 大重构（有依赖，需完整回归）

- [ ] **#2 [P1] 双状态机统一** ⚠️ 最大一块 — AutopilotStatus 吸收入 orchestrator reducer（新增 complete_requested/pause_requested/deactivate_requested events，替换 ~12 处 imperative 调用，删 autopilot-state.ts 的 mutators）。**约束：AutopilotProjection.status 行为须向后兼容**（host UI 依赖）。
- [x] **#6 [P1] orchestrationState 卡 claimed + evidence bypass** — 两个 bug 修复：(1) `agent_turn_prepare` 未 persist `agent_turn_started` 的 orchState 转换（仅在 goal capture 路径 setState，无 goal 时变更丢失）；(2) `before_agent_finalize` complete case 缺少 `agent_turn_finished` dispatch，running 无法到 released→done。现在 orchState 正确完成 claimed→running→released→done 全链路。更新 lifecycle 测试从 frozen-to-claimed 改为断言 'done'。✅
- [x] **#3 [P1] before_agent_finalize 拆分** — 提取 `buildCrossTurnReviseFallback()` 消除 cross_turn 3 处 revise-fallback 重复代码（含统一英/中混用的 fallback 字符串为一致的英文）。✅

## Wave 4 — 跨包 + 文档

- [ ] **#11 [P2] 三重 tokenizer 统一** ⚠️ **跨包** — permission-policy 导出 `tokenizeShell`，autopilot 两份 import。**触发 monorepo 版本链**：bump permission-policy → 更新 autopilot/dynamic-workflows peerDep。⚠️ npm publish 需真实终端 + 2FA OTP（Claude 跑不了）。对抗验证确认当前不分歧，纯维护性——可延后。
- [ ] **#12 [P2] test helpers 移出 barrel** — 5 个 `_*ForTest` 移到 `testing.ts`；package.json 加 exports map；`generateRunId` 不再委托 `_generateRunIdForTest`（与 #1 呼应）。
- [ ] **#13 [P2] README 扩充** — config 参考表、6 个 gateway method 合约、WORKFLOW.md 格式示例、env vars、AutopilotProjection 字段、troubleshooting。
- [ ] **#14 [P2] hook handler 类型化** — 定义 narrow event interfaces 替代 14 处 `any`；启用已定义但未用的 HookContext/HookHandler。

---

## 每项完成的 DoD（Definition of Done）

1. `corepack pnpm -r test` 全绿（⚠️ 用 `corepack pnpm`，用户级 pnpm 会 hang）
2. `corepack pnpm -r typecheck` 通过
3. 非平凡逻辑改动带回归测试
4. 完成后回本清单勾选 + `TaskUpdate status=completed`

## 未做成待办的 backlog（P3，报告中记录，按需再提）

goal-manager pass-through 删除 · 24h orphan 清理误删 paused · 退避加 jitter · configSchema 补字段描述 · index.ts:54/98 bare catch{} 加日志 · YAML BOM/lone-CR/多 `---` edge case · setGoal/cleanup gateway 文档化 · maxConcurrent:0 语义文档化
