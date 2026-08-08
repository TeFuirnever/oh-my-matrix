# Autopilot 模块深度审视报告 — 面向长程任务自主运行

| 项 | 值 |
| --- | --- |
| 日期 | 2026-07-31 |
| 被审对象 | `packages/autopilot` v3.1.0（commit `b39deb6`，工作区干净） |
| 审视目标 | 评估模块距"长程任务无人值守自主运行"的差距 |
| 方法 | 源码通读（src 19 文件 + index.ts 定点验证）、历史审计/ADR 交叉核对、对照 oh-my-claudecode 实现、业界一手实践调研（Anthropic / OpenAI / Ralph 社区） |
| 既有基础 | 本报告建立在 2026-06-30 ~ 07-04 四轮审计与 9 个修复 wave 之上；已闭环项（S1/S3/H1/PROD-7/ADR-016 等）不重复立案 |

---

## 1. 执行摘要

**工程质量总评：中高。** 状态机（reducer 单一写者，ADR-016）、持久化（原子写 + per-runId 串行化 + 恢复时重算 status）、注入幂等（三条注入路径均有 idempotencyKey）、安全收敛（WORKFLOW.md 命令白名单、trustWorkspace 默认关闭）都经过多轮对抗审查修复，骨架是扎实的。

**但"长程无人值守"这一产品目标尚未达成。** 当前模块能可靠地完成"数轮~数十轮的受监督续跑"，尚不能放心地"过夜跑"。四个要害缺口，按杀伤力排序：

1. **一次 API 抖动即可致死，且死了救不回来。** 瞬时错误（rate limit / overloaded / ECONNRESET / 529）全部落入"未知→不可恢复"分类，blocked 后不可 resume（见 3.1）。
2. **长工具调用被误判停滞，存在同一 run 双 turn 并发风险。** 超过 300s 无事件的构建/测试会触发 stall→retry→重派 turn，而原 turn 可能仍在执行（见 3.2）。
3. **默认配置下没有成本硬顶。** 唯一普适刹车是 50 次 continuation，每次可烧一整轮 token；无墙钟上限、无默认 token 预算（见 3.3）。
4. **"完成"默认靠正则猜模型措辞。** 默认配置下证据门形同虚设（`skipped` 直通 `done`），完成判定退化为对 agent 自报文本的中英文短语匹配（见 3.4）。

这四点与业界一手实践（Anthropic 长程 harness 指南、OpenAI guardrails、Ralph 社区教训）的共识直接冲突：完成判定必须锚定外部工件/确定性验证、失控防护必须多层并联、瞬时失败必须可恢复。修复建议见 §6。

## 2. 架构评估

**循环本体**：宿主插件，靠 `before_agent_finalize` hook → `decideContinuation()` → `revise`（注入合成指令）/ `cross_turn`（`enqueueNextTurnInjection`）维持无人值守转动；辅以 stall 巡检 interval（60s）派发 `stall_timeout` / `retry_due`，`kickResumedTurn` 作为跨 turn 恢复执行器。无轮询、无外部进程，形态干净。

**做得好的地方**（这些是历经四轮审计沉淀下来的，不要在未来重构中丢掉）：

- **reducer 纯函数 + status 单一写者**（`orchestrator.ts:74-82`，ADR-016）。所有迁移经事件派发，错状态 no-op 幂等；`pauseReasonToBlockedReason` 编译期穷尽。
- **持久化**：tmp+rename 原子写（`state-persister.ts:177-184`）、per-runId Promise 链串行化、加载时永不信任磁盘 `status` 一律 `deriveStatus` 重算（`:313-315`）、workspace 已删拒绝恢复（`:266-273`）。
- **注入幂等**：revise（`index.ts:559`）、cross_turn（`index.ts:572`）、kickResumedTurn（`index.ts:125`）三条路径都带 idempotencyKey；cross_turn 有 enqueue 失败→revise 的降级链（`index.ts:576-587`）。
- **token 双账分离是刻意设计**：index.ts 按 `llm_output` 累加 `totalTokensUsed`（`index.ts:953`），reducer 经 `agent_activity` 记 input/output 两字段（`index.ts:954-962` 注释明示分工），有 NaN 守卫（H4）和 host 不报 usage 时的一次性告警（S10，`index.ts:941-944`），`token-double-count.test.ts` 钉死无双计。**此前怀疑的"预算口径分裂"不成立。**
- **安全面**：WORKFLOW.md 验证命令有二进制白名单 + 解释器 eval-flag 过滤（`workflow-config.ts:55-111`）；`before_tool_call` 事件形状有编译期契约防宿主改字段后 fail-open（`event-shape.contract.ts`）。

**结构性隐忧**（非单点 bug）：

- **完成判定的根基是文本启发式**。三级串联（正则 → min-turns 护栏 → 证据门）中，前两级是 NLP 猜测，第三级在默认配置下不生效（详见 3.4）。整个模块最重的决策——"这个长程任务做完了"——建立在最脆弱的机制上。
- **状态表示仍有双轨残留**。旧 throw-setter 与 reducer 并存（`autopilot-state.ts:24-98`），`workspace_failed`/`permission_denied` 事件定义了但从未派发（`orchestrator.ts:117-121`）——即 fix-checklist 未勾的 W1a。`needsCrossTurnResume` 有 16 个写入点、3 种语义（W2）。
- **错误世界被压扁成子串匹配**。`classifyRecoverability` 用关键词包含判断可恢复性（`retry-queue.ts:22-72`），这是 3.1/3.9 多个发现的共同根因。

## 3. 发现矩阵

严重度定义：**P0** = 不修则"无人值守过夜跑"不可接受；**P1** = 显著削弱长程可靠性或有数据/并发风险；**P2** = 正确性/可维护性长尾。

### 3.1 [P0] 瞬时 LLM/API 错误不可恢复，致死且不可 resume

**证据**：`classifyRecoverability`（`retry-queue.ts:26-49`）的可恢复关键词仅 transient / tool fail / timeout / stall / validation / injection / rejected；**未知一律不可恢复**（`:70-71`）。真实世界的 `rate limit`、`overloaded`、`529`、`ECONNRESET`、`socket hang up` 全部落入 unknown → `turn_finished` 失败时直接 `blocked`（`orchestrator.ts:176-189`），且 `RESUMABLE_BLOCKED_REASONS = {stalled, validation_failed, evidence_missing, injection_rejected}`（`orchestrator.ts:28-33`）不含此类 blockedReason → `autopilot.resume` 拒绝（`:356-361`）。

**杀伤力**：过夜跑的 run 遭遇单次限流/网络抖动即永久死亡，用户只能 stop + 重新 activate（丢失 continuation 计数与部分进度）。这是"长程自治"目标下最致命的一条。

**附带发现**：子串匹配双向误伤——任何含 `token`/`budget` 字样的错误串（如 tokenizer 相关报错）误判不可恢复（`retry-queue.ts:60`）；含 `timeout` 字样的路径/消息误判可恢复（`:29`）。

**对照**：oh-my-claudecode 把 rate-limit(429)/auth(401/403)/user-abort 列为集中式硬豁免并明确放行策略（`persistent-mode/index.ts:2311-2374`，每条带 issue 出处）；OpenAI Agents SDK 将失败超阈值升级为显式受控收尾而非静默死亡。

### 3.2 [P0] 长工具调用误判 stall，存在双 turn 并发风险

**证据**：`checkStall` 只看 `lastActivityAt`（`stall-detector.ts:26-49`），活动事件仅 `llm_output`/`tool_call`/`tool_result` 三类（`types.ts:235`）。一次超过 `stallTimeoutMs`（默认 300s，`workflow-config.ts:18`；无预算 run 加倍到 600s，`index.ts:142-146`）的构建/测试执行期间不产生任何事件 → stall interval 判定停滞（`index.ts:1418-1434`）→ `stall_timeout` → `retry_queued` → `retry_due` → `kickResumedTurn` 重派一轮（`orchestrator.ts:205-242`，`index.ts:1437-1450`）。reducer 与注入链路中**没有"原 turn 仍在执行"的在飞守卫**——kickResumedTurn 的幂等键只防同一恢复事件双注入，防不了原 turn 晚完成后与新 turn 并存。

**杀伤力**：长程任务恰恰充满长构建/长测试。轻则重复执行同一任务（双烧 token），重则两个 turn 并发改同一工作区。

**注**：这不是已修复的 PROD-7（那是"retry_due 后无执行器"的反向问题）；本发现是执行器存在但触发前提错误。

### 3.3 [P0] 默认配置无成本硬顶；预算只在 turn 边界强制

**证据**：`DEFAULT_CONFIG` 无 `tokenBudget`（`types.ts:331-337`），唯一普适刹车是 `maxTotalContinuations = 50`（`types.ts:333`）与 `maxAttemptsPerTurn = 5`；无墙钟上限、无成本上限。token 预算检查在 `before_agent_finalize` turn 边界（`index.ts:928-931` 注释明示）——**单轮内部可超支任意多**（一轮深度调试 turn 烧掉的 token 可能超过整个预算）。`estimatedCostUsd` 仅观测用（`projection.ts:53-71`）。崩溃恢复时 `toolErrorThreshold`/`maxConcurrentAutopilot` 被硬编码为 5 而非保留配置值（`state-persister.ts:291,300-302`）。

**对照**：业界共识是三类预算**并联**任一触发即熔断（迭代上限 + 墙钟 time-box + token/成本预算），并在 80% 处先告警；单看轮数在"每轮都很贵"场景失效（RelayPlane 测算：卡循环 500 轮单会话 $9+，100 会话/小时并发即 $2,100/天）。oh-my-claudecode 的 autoresearch 用 `deadline_at` 墙钟硬顶（`persistent-mode/index.ts:1803-1894`）——比迭代数更适合长任务。

### 3.4 [P0] 完成判定默认退化为文本正则；证据门 `skipped` 直通 `done`

**证据**：完成判定三级串联——`isTaskComplete` 中英文短语正则（`completion-detector.ts:1-40`）→ `MIN_TURNS_BEFORE_COMPLETE` 护栏（`continuation-engine.ts:20-43`）→ `evaluateEvidence` 证据门（`evidence-gate.ts:23-95`）。但 `evidence_finished` 中 `passed` 与 **`skipped`** 都直通 `done`（`orchestrator.ts:261-270`）；而默认配置 `validation.commands` 为空（`workflow-config.ts:26-29`）、`trustWorkspace` 默认 false 时 workspace 来源命令不执行（`types.ts:321-328`）——**默认路径上证据门必为 skipped，完成判定完全落在正则上**。措辞漂移（模型换个说法或永不说"完成"）分别导致过早完成或空转到 50 轮上限。

**反向风险**：`hasNoActionableTask` 高精度模式命中即 `complete` 且**故意绕过 min-turns**（`continuation-engine.ts:70-78`）——模型中途以求澄清句式说话可能在第 0 轮杀掉真实任务。

**对照**：Anthropic 实测记录的两大失败模式之一就是"agent 看到已有进展就宣布整个项目完工"，其对策是完成判定锚定**外部工件状态**（结构化 feature list 全 `passes:true` + 端到端验证），绝不信 agent 自我声明；oh-my-claudecode 的 ralph 用 PRD `passes` 自评 + 独立审查者 `architectVerified` 双闸，且批准必须带相关化 request-id、只能出现在审查者 subagent 的 tool_result 里（防 agent 复制批准格式骗过 hook）。ADR-019 条件判断设计（Proposed 未落地）方向与此一致，应加速。

### 3.5 [P1] `isRunStuck` 把正常退避中的 run 误判为卡死

**证据**：`isRunStuck` 对任何 `retry_queued` 状态一律判卡死（`autopilot-state.ts:156-166`）——包括 `nextRetryAt` 在未来、正在正常等指数退避的 run。此时重新 activate 会丢弃旧 run 开新 run，同一 goal 新旧两 run 并存。且其 stall 阈值默认 600s 与 workflow 默认 300s 不一致（`:159` vs `workflow-config.ts:18`）。

### 3.6 [P1] `released` 状态是停滞检测盲区

**证据**：`checkStall` 只看 `running`/`claimed`（`stall-detector.ts:31`；index.ts 巡检条件一致，`index.ts:1418`）。若 evidence 启动失败（`evidence_started` 永远不来），run 停在 `released`：无 stall、无重试，只有 24h orphan sweep 兜底；崩溃恢复后是否有人重启 evidence 流程在源码内无迹可循，大概率再次 wedge。

### 3.7 [P1] stall 致死的 run 永不可 resume；`'stalled'` 在 RESUMABLE 集合中是死条目

**证据**（本次 index.ts 验证结案）：生产代码中没有任何路径写出 `blockedReason: 'stalled'`——reducer 的 `stall_timeout` 分支在重试耗尽后给的是 `max_retries_reached`（`orchestrator.ts:215`），它不在 `RESUMABLE_BLOCKED_REASONS`（`:28-33`）里；`'stalled'` 仅出现在测试构造（`orchestrator.test.ts:419,526-528`）与恢复 allowlist（`state-persister.ts:430`）。净效果：stall 是长程最常见死因之一，但 stall 致死的 run 全部不可 resume。`RESUMABLE_BLOCKED_REASONS` 里的 `'stalled'` 是误导性死代码。

### 3.8 [P1] 验证命令 maxBuffer 1MB 冤杀 verbose 测试

**证据**：`command-runner.ts:100` 使用 execFile 默认 maxBuffer（1MB）。输出量大的合法**通过**的测试套件会超 buffer 抛错 → 判 failed → 证据门失败 → 白重试到 maxRetries → blocked。

### 3.9 [P1] session-index 存在跨 runId 丢更新竞态

**证据**：持久化锁是 per-runId 的（`state-persister.ts:170-218`），但 `session-index.json` 是所有 run 共享的文件，`updateSessionIndex` 做 read-modify-write（`:221-240`）。两个不同 runId 并发保存会交错，后写覆盖先写 → sessionKey→runId 映射丢失 → 崩溃后该 session 无法恢复。maxConcurrent 默认 5，多 run 并发是常态，此窗口真实存在。

### 3.10 [P1] 崩溃恢复有损，长程"中途续计划"能力弱

**证据**：恢复时 `toolErrorThreshold` 硬编码 5（配置默认 3）、`toolErrorCount` 归零、`maxConcurrentAutopilot` 硬编码 5（`state-persister.ts:291,300-302`）；goal/progress 各截 500 字符（`autopilot-state.ts:5`）；**没有结构化 plan/todo 工件持久化**——恢复后靠往注入指令里塞截断的 goal+progress 文本让模型自行重建计划（`continuation-engine.ts:106-139`）。`restoreGoalFromSnapshot` 还存在不对称：goal 取"当前优先"、progress 取"快照优先"（`autopilot-state.ts:125-133`），compaction 恢复后可能新 goal 配旧 progress。

**对照**：Anthropic 长程 harness 的核心建议就是计划状态落磁盘结构化文件（JSON 优于 Markdown，模型更不敢乱改）+ append-only 进度日志 + 每轮固定续跑仪式（读 progress/git log → 冒烟验证环境 → 选下一项 → 单任务 → commit）；openclaw#5429 记录了 45 小时上下文因静默 compaction 全丢的真实事故。

### 3.11 [P1] maxConcurrent 只在 activate 单点强制，恢复路径绕过

**证据**（本次 index.ts 验证结案）：并发上限仅在 `autopilot.activate` 检查（`index.ts:1166-1176`，按内存中 `status==='running'` 计数）。`register()` 进程重启恢复全部可恢复 run 时不计数；恢复的 claimed run 还会被自动 `kickResumedTurn` 拉起（`index.ts:502` 区域）。跨进程上限此前已是 accepted limitation（S11），本条是进程内恢复路径的补充缺口。

### 3.12 [P2] 正确性/可维护性长尾

- 非可恢复 blocked 也显示 `paused`（`orchestrator.ts:60`），UI 上像可恢复但 resume 必拒——死胡同状态。
- 路由/effort 相位倒挂：最难的验证失败重修轮拿 default tier 且验证期 effort 强制 low（`model-routing.ts:47-50`，`effort-injection.ts:51`）——最需要能力的相位被降配。
- 模型路由无失败 fallback：模型报错不触发降档/换档重试（`model-routing.ts:35-51`），与 3.1 叠加放大致死率。
- 工具错误熔断只数"同 tool+同 args 连续失败"，A→B→A 交替永不触发（`tool-error-tracker.ts:14-17`，注释自认盲点）。
- 旧 setter 与 reducer 双轨并存（W1a）；`workspace_failed`/`permission_denied` 事件从未派发（`orchestrator.ts:117-121`）。
- checkpoint tmp 文件崩溃残留无清扫（`state-persister.ts:181`）；写失败 fail-silent 意味着磁盘满时恢复能力静默丢失（`:205-207`）。
- 重试退避无 jitter（`retry-queue.ts:10-14`）——多 run 同时被限流时会同步重试放大冲击。
- 无 no-progress 检测：连续 N 轮无新 commit/无新通过测试/同指纹工具调用时，只能烧到 50 轮上限才停。

## 4. 对照 oh-my-claudecode

oh-my-claudecode 的自主循环（persistent-mode stop hook 统一调度 ralph/autopilot/ultrawork/ultraqa/autoresearch）与本模块形态不同（每事件新进程 vs 长驻插件），但机制层有大量可直接移植的设计。

### 4.1 值得借鉴（按对本模块的价值排序）

| # | 机制 | 出处 | 落到本模块的位置 |
| --- | --- | --- | --- |
| B1 | **集中式错误分类与硬豁免清单**：所有豁免/放行条件集中在一个 resolve 函数，rate-limit/auth/user-abort/context-limit 逐条列出且每条带 issue 出处 | `persistent-mode/index.ts:2235-2347` | 重写 `classifyRecoverability`（`retry-queue.ts`）为显式分类表；瞬时/限流错误可恢复 + 独立长退避档（治 3.1） |
| B2 | **防自批的相关化批准令牌**：批准必须带每次验证重新生成的 request-id、只能出现在审查者 subagent 的 tool_result 里、注入示例标签先剥离再匹配——三层防线对抗 agent 伪造"已完成" | `verifier.ts:226,317-321`；`persistent-mode/index.ts:914-973` | evidence-gate / completion-detector：完成信号应来自 tool_result 通道（验证命令真实执行结果）而非 agent 文本；ADR-019 落地时引入相关化 token（治 3.4） |
| B3 | **thinking-only 连胜熔断**：连续 3 个无 tool_use 的 assistant 回合即释放 stop；任何 tool_use 重置；读不出 transcript 时 fail-open 不误杀 | `persistent-mode/index.ts:1479-1635` | 新增 no-progress 检测：连续 N 轮无 tool_call/无新 commit/同指纹工具调用 → 提前熔断（治 3.12 末条，比撞 50 轮上限省得多） |
| B4 | **时间盒硬顶**：autoresearch 用 `deadline_at` 墙钟上限，比迭代数更适合评估型长任务 | `persistent-mode/index.ts:1803-1894` | 增加 `maxWallClockMs` run 配置，与 tokenBudget/continuation 上限并联（治 3.3） |
| B5 | **分级重试指导**：同一错误前 5 次"修复后重试"，≥5 次改口"换完全不同的方法/询问用户"，写进注入文本 | `persistent-mode/index.ts:570-606` | `buildRetryInstruction` 按 `retry.attempt` 分级；与 ADR-019 Enhancement B（注入 failureReason）合并实施 |
| B6 | **相同失败检测**：失败描述归一化（去时间戳/行号）后连续 3 次相同即退出循环 | `ultraqa/index.ts:137-147,221-230` | retry_due 前比较 failureReason 指纹，相同失败不再指数退避而是转 blocked/换策略（与 B5 互补） |
| B7 | **PRD 双闸完成制**：story 自评 `passes:true` + 独立审查者 `architectVerified`；状态全靠磁盘 JSON 工件在迭代间传递 | `ralph/loop.ts:89-112`；`verifier.ts` | 结构化 plan 工件持久化（治 3.10）；与 WORKFLOW.md 的 validation 形成"自评+外部验证"双闸（治 3.4） |
| B8 | **session 隔离三件套**：session_id 匹配 + worktree 根归一 + 2h 陈旧豁免 | `persistent-mode/index.ts:100,340-359` | 本模块已有 sessionKey 分区 + 24h sweep，大体相当；陈旧豁免的"豁免"思路可用于 3.5 的 isRunStuck 修正 |

### 4.2 对方教训（不要抄）

- **软上限自动 +10 续期 + `hardMaxIterations` 默认 0（不限）**：ralph 实际无内在终止，runaway 是显式设计取舍（`persistent-mode/index.ts:1358-1368`；`security-config.ts:150-153`）。本模块 50-continuation 硬顶反而更安全——但应保留硬顶且补上受控收尾（见 §6）。
- **内存计数器跨进程失效**：todo-continuation 上限是模块级 Map，而 hook 每事件新进程，5 次上限很可能从未生效（`persistent-mode/index.ts:153`）。佐证：熔断计数器必须持久化。本模块是长驻进程无此问题，但崩溃恢复时 `toolErrorCount` 归零（3.10）是同族病。
- **完成信号可伪造 + 读整个 transcript**：其 autopilot 仅对 transcript 全文正则且无来源校验（`enforcement.ts:97-124`）。本模块不读 transcript 是对的，但 completion-detector 的正则本质上同病（3.4）。
- **文档与代码漂移**：其 AGENTS.md 声称 stop hook 永远软强制，实现是硬阻断。本模块亦有注释与现实脱节处（如 `stall_timeout_ms` 曾被解析但从不消费，M1 已修）——审计文档应与代码同 PR 更新。

## 5. 对照业界最佳实践

调研来源（一手）：Anthropic《Effective harnesses for long-running agents》《Building effective agents》《Effective context engineering for AI agents》；OpenAI Agents SDK 文档（guardrails / running agents / human-in-the-loop）及《A practical guide to building agents》；Ralph 原帖（ghuntley.com/ralph，经 Wayback）与官方 Playbook（github.com/ghuntley/how-to-ralph-wiggum）；成本控制部分含二手转述（RelayPlane、stevekinney 等，已标注）。

### 5.1 完成判定：必须锚定外部工件，不信 agent 自报

- **Anthropic**：agent 有两大失败模式——一次做太多导致 context 耗尽留半成品；"看到已有进展就宣布完工"。对策：initializer 写结构化 feature list（JSON，全 `passes:false`，选 JSON 因模型更不敢乱改），coding agent 只许改 `passes` 字段；"passing" 必须基于端到端验证（浏览器自动化模拟真人），不是跑个单测就算。
- **本模块差距**：3.4（正则猜措辞）+ 3.10（无结构化计划工件）。这是与业界共识差距最大的一项。
- **Ralph 社区的同构结论**：backpressure 必须是确定性门禁——测试/typecheck/lint/build 不过就不 commit，prompt 只说"run tests"，具体命令写死在工程文件里。

### 5.2 续跑循环：固定仪式 + 磁盘工件，而非自由注入

- **Anthropic**：每个 coding agent 固定开场仪式——读 progress 文件和 git log → **先跑 init.sh + 冒烟测试确认环境没坏** → 选最高优先级未完成项 → 一次只做一个 → 结束时 git commit + 追加进度摘要（保持可合并的 clean state）。
- **Ralph 原教旨**：`while :; do cat PROMPT.md | agent; done`——每轮全新 context + 同一份确定性输入文件，跨轮共享状态只走磁盘工件；plan 是一次性的，走偏时删掉重跑 planning 比硬推便宜。
- **本模块差距**：续跑指令是 `"[Autopilot] Continue from where you left off."` + 截断 goal/progress（`continuation-engine.ts:106-139`），无"先验证环境没坏"仪式、无"一次只做一件事"约束、无"作废重来"路径。

### 5.3 失控防护：多层并联 + tripwire 硬中断 + 持久化计数

- **OpenAI Agents SDK**：`max_turns` 默认存在，超限抛 `MaxTurnsExceeded` 且可配受控 fallback 输出；guardrail tripwire 触发即硬中止整个 run；工具按风险分级，高风险暂停转人工，**参数无法安全解析时 fail-closed**。
- **成本控制实践**：三类预算并联（迭代 + 墙钟 + token/成本），单一维度必然失效；no-progress 检测（同工具同参数连续 ≥3 次熔断）；预算 80% 处先告警；**计数器必须持久化**，进程崩溃重启后不归零；基础设施层（网关日额度）兜底应用层计数器的失效。
- **本模块差距**：3.3（默认无预算、单轮可超支）；50-continuation 到顶仅 pause、无受控收尾输出；无 no-progress 检测；退避无 jitter。本模块做对的：工具风险分级与 fail-closed 已由 permission-policy + dynamic-workflows 承担（这是 monorepo 分工的优势，不在本模块重复建设）。

### 5.4 上下文管理：compaction 前自动 checkpoint

- **Anthropic context engineering**：structured note-taking（定期把笔记写到 context 外文件）+ compaction 保对话流，两者互补；openclaw#5429 记录了 45 小时上下文因静默 compaction 全丢的事故。
- **本模块现状**：有 `before/after_compaction` 的 goal 保护（`goal-manager.ts`）与 snapshot 机制，但恢复材料是 500 字符截断文本（3.10），且存在 goal/progress 不对称恢复。方向已对，保真度不足。

## 6. 优先级建议（面向"长程无人值守"）

### P0 — 不修则不能放心过夜跑

1. **错误分类重做**（治 3.1）：`classifyRecoverability` 从子串匹配改为显式分类表——瞬时/限流错误可恢复且 rate-limit 用独立长退避档（尊重 Retry-After）；`RESUMABLE_BLOCKED_REASONS` 扩大覆盖瞬时错误致死；同步修子串双向误伤。关 W2（`needsCrossTurnResume` 语义建模）一并考虑。
2. **stall 检测感知在飞工具**（治 3.2）：`tool_call` 事件后抑制/重置 stall 计时直至 `tool_result` 或单工具上限（如 30min）；或在 `kickResumedTurn` 前校验该 run 无在飞 turn。
3. **成本硬顶默认值 + 受控收尾**（治 3.3）：`DEFAULT_CONFIG` 增加保守 `tokenBudget` 或 `maxWallClockMs`；任一上限触发时注入"收尾并汇报现状"指令而非仅 pause；预算 80% 处告警；恢复路径保留配置值（消除硬编码 5）。
4. **完成判定锚定外部证据**（治 3.4）：`project-detector` 已能推断 test/build 命令——将其产物（非 workspace 任意命令）默认纳入证据门，跳过 trustWorkspace 限制；`skipped` 不再直通 `done`（至少触发更高 min-turns + 注入"需要可验证证据"指令）；加速 ADR-019 落地，并引入 B2 的相关化批准 token。

### P1 — 长程可靠性显著受损

- **5.** `isRunStuck` 区分"退避中"（`nextRetryAt` 在未来 ≠ stuck）与真卡死（3.5）；统一 600s/300s 阈值口径。
- **6.** `released` 纳入 stall 检测，或 evidence 启动失败时兜底转 retry（3.6）。
- **7.** stall 致死（`max_retries_reached`）纳入可 resume 集合或提供受控 re-activate 路径；清理 `RESUMABLE_BLOCKED_REASONS` 死条目 `'stalled'`（3.7）。
- **8.** `command-runner` maxBuffer 提升或改流式聚合（3.8）。
- **9.** 结构化 plan 工件持久化（feature-list 模式，JSON + append-only progress），恢复时读工件而非截断文本；修 goal/progress 不对称（3.10）。
- **10.** no-progress 熔断：连续 N 轮无新 commit/无新通过测试/同指纹工具调用 → 提前停（3.12 末条，B3/B6）。
- **11.** session-index 写入加全局锁或并入 per-run checkpoint（3.9）。

### P2 — 长尾

- **12.** maxConcurrent 覆盖恢复路径（3.11）。
- **13.** 重试指导分级 + "作废重来"路径（B5；Ralph 教训）。
- **14.** 退避加 jitter；非可恢复 blocked 的 UI 态与 `paused` 区分。
- **15.** 相位感知路由/effort 修正（验证重修轮升配）+ 模型失败 fallback。
- **16.** 既有 fix-checklist 未勾项按原计划推进：W1a（setter 路由收尾）、M4（`applyCompleteWithEvidence` 提取）、TEST-2/3/7、tmp 清扫、A→B→A 盲点文档化。

**与既有 fix-checklist 的关系**：W1a/W2/W3/M4/TEST-* 是架构长尾债务，本报告 P0-1/2/3/4 与它们正交但优先级更高——因为它们直接决定"无人值守"场景的生存率。建议 P0 四项插入 fix-checklist 下一 wave 最前。

## 7. 范围声明与局限

- index.ts（71KB 插件入口）本次只做了 4 个定点验证（token 双账、注入幂等、maxConcurrent 强制点、`'stalled'` 可达性），结论：双账分离是刻意设计且有测试钉死（非 bug）；三条注入路径均有幂等键（无双重注入问题）；另两项转化为发现 3.7/3.11。入口文件其余逻辑未逐行审。
- 未做定量性能基准（延迟/吞吐/内存需宿主侧 profiling 环境）。
- oh-my-claudecode 侧 `ralph/prd.ts`、`ralphthon/orchestrator.ts`、`autopilot/pipeline.ts`、`missions/*/sandbox.md` 未读，相关结论已标注推断成分。
- 业界调研中 nexgismo/openlegion/gravity/fountaincity 四篇为搜索摘要级来源；两起事故金额（$6,531、$47,000）未追溯到一手报告，属二手转述，仅用于说明量级。
- 本报告只审视，未修改任何源码；修复应按该仓 TDD 约定（先写回归测试）另立任务。
