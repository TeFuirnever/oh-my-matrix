# @oh-my-matrix/permission-policy 端到端审计报告

- **日期**:2026-06-30
- **对象**:`packages/permission-policy/`(`@oh-my-matrix/permission-policy`,审计时 v0.1.0),纯函数权限策略库 —— 命令分类(`classifyCommand`)+ 权限决策(`decidePermission`/`decidePermissionForEvent`)+ 审计落盘(`audit-persister`)。被 `@oh-my-matrix/autopilot`(可信主会话)+ `@oh-my-matrix/dynamic-workflows`(不可信 subagent guard)共用,是整套 runtime 安全栈的单一事实源。
- **范围**:端到端功能检查 + 业界最佳实践对比;**先审计 only,后落地修复**。
- **方法**:静态通读(三份 src ~670 行 + 五份测试)+ 验证套件实测 + **4 个对抗 reviewer 并行审查**(security-reviewer / code-reviewer red-team / critic / verifier),各自带推翻命题、独立读源码、用 payload 实锤。
- **结论一句话**:套件全绿(210/210)、typecheck 干净、两个消费者接线正确无 fail-open;但**绿 ≠ 无 bypass** —— 对抗 review 推翻初版"无 fail-open"结论,实锤 **2 个 CRITICAL 绕过**(B1 `npm run` 击败 subagent guard、B2 `git -C` 工作区包含逃逸)+ 1 个 HIGH(B5 `git restore` 全缺)+ 审计日志真实 bug(F1 轮转排序)+ 静默吞错(F2)+ autopilot 审计丢 cwd(F3)。

> **Status(updated 2026-07-01)**:B1/B2/B5/F1/F2/F3 全部闭环。
> - **B1**(npm run 绕过 defaultDeny)✅ #46(`run` → `unknown`)
> - **B2**(git -C 包含逃逸)✅ #46(`extractCommandSegments` 解析 `-C`;classifier flag-strip 处理 attached `-C<path>`)
> - **B5**(git restore 全缺)✅ #46(`restore` → `destructive_git`)
> - **F1**(轮转排序返回陈旧)✅ #46(整数后缀比较器 `auditFileRecencyKey`)
> - **F2**(静默吞错)✅ #46(`console.error` 嵌套兜底)
> - **F3**(autopilot 审计丢 cwd)✅ #46
> - 发版:`@oh-my-matrix/permission-policy@0.1.1` release-prep #50(merged),npm publish 待 maintainer 2FA。
>
> **未修(tracked in follow-up issue)**:B3(`bash -c`)/ B4(`checkout HEAD <path>`)/ B6(`git -c <subcommand>`)/ B7(`checkout -B`)/ B9(framework-tool 分支丢 defaultDeny)、F4(审计本地时区分桶,by design)、F5(`require_approval` 死分支)。详见 #47(安全 backlog)+ #51(流程加固)。

---

## 1. 执行摘要

**功能判定**:编译、类型、lint、测试、打包**全部通过**(详见 §3)。两个消费者的接线经独立复核(Explore + verifier)正确:subagent guard 真的 `defaultDeny:true` fail-closed,真实事件形状 `{toolName, params:{command, workdir}}` 全程一致,历史 `event.args` fail-open 根因未回归。单看 CI 信号"功能正常"。但测试套件对**静态分类器的盲区**无断言(credential 仅按名匹配、`git restore` 完全未分类、`npm run` 被当 validation),所以 B1/B2/B5 在绿灯下依然成立。

**最佳实践对齐度**:初版报告判"无 fail-open bypass"被 4 个对抗 reviewer **证伪**。根因同 autopilot 审计:**存在性核对**(机制在不在)而非**名副其实性核对**(分类器被什么绕过 / 退化下是否生效)。reviewer 还二次验证了初版提出的修复指引本身是否安全 —— 否决了 F1 的 mtime / 字典序 `-N` 两种修法(mtime 在 `touch`/restore 下破跨日期不变量;字典序在 `-10` vs `-2` 重破),定为整数后缀比较器。

**最该立即处置**(均已闭环):
- 🔴 **B1** `npm/pnpm/yarn run <script>` 被分类为 `validation`,`decidePermission` 无条件 allow(不查 `defaultDeny`)→ **subagent guard 被一条普通命令 `npm run evil` 直接击败**(package.json 脚本可执行任意命令)。
- 🔴 **B2** `git -C <path>` 不被 `extractCommandSegments` 解析 → 工作区包含检查看 host workdir(`/ws`)通过,但 git 实际在 `/etc` 执行 → **包含逃逸**(trusted 路径,当 `workflowAllowsDestructiveGit:true`)。

完整发现项见 §6。审计后落地修复见 #46。

---

## 2. 两消费者集成(文字图)

```
OpenClaw before_tool_call event {toolName, params:{command?, workdir?}, runId, toolCallId}
  │
  ├─ dynamic-workflows guard(index.ts:91)  ── 不可信 :subagent: 会话
  │     decidePermissionForEvent(event, {defaultDeny:true, workflowAllowsDestructiveGit:false})
  │       → extractCommandSegments: 切 shell 算符 + hasShellFeature 检测
  │       → 逐段 classifyCommand → decidePermission(worst-class-wins)
  │       → outcome==='block' → 硬 veto({block:true})+ appendAuditEntry
  │     (主会话 / autopilot run 早退放行,不走此门)
  │
  └─ autopilot run-scoped(index.ts:642)    ── 可信主会话
        decidePermissionForEvent(event, {workspacePath, workflowAllowsDestructiveGit, /* no defaultDeny */})
          → outcome==='block' → 硬 veto;否则放行
          → appendAuditEntry(每条工具调用)

permission-policy.ts(纯库,无 hook)
  classifyCommand(tool, args, toolKind?)        ← 名字/参数启发式分类,11 个 CommandClass
  decidePermission(input)                       ← class → allow/block;destructive_git 看工作区包含
  decidePermissionForEvent(event, opts)         ← 上述两者的 event 入口,切分 + worst-class-wins
audit-persister.ts
  appendAuditEntry / loadRecentAuditEntries     ← <workspace>/.autopilot/audit-YYYY-MM-DD.jsonl,10MB 轮转
```

---

## 3. 验证套件实测取证(审计时点)

| 命令 | 结果 | 备注 |
|------|------|------|
| `pnpm typecheck`(`tsc --noEmit`) | ✅ **0 error** | |
| `pnpm test` | ✅ **5 文件 / 210 passed** | permission-policy 104 + classify-matrix(e2e)59 + shell-evasion(e2e)20 + audit-persister 14 + audit-roundtrip(e2e)13 |
| `pnpm build`(`tsc`) | ✅ 成功 | dist 再生 |
| 消费者 `pnpm test`(复核) | ✅ autopilot 667 / dynamic-workflows 26 | 接线无回归 |
| 接线行号核对(verifier) | ✅ dynamic-workflows:91 `defaultDeny:true`;autopilot:642 省略;无 `event.args` 读取 | 历史 fail-open 根因未回归 |

### 实测副产物(新增发现项)
- **F1(实锤)轮转排序 bug**:独立 `/tmp` 复现脚本(base 300 有效条目 + `-1` 50 条目,limit=10)返回 `[BASE-290..BASE-299]`(最旧),最新 rotated 条目被砍。两个 reviewer 各自独立复现确认。根因:`audit-persister.ts` 的 `.sort().reverse()` 不能表达"最新文件优先"—— 同日 `-N` 后缀因 `'-'(0x2D) < '.'(0x2E)` 排到 base 前,reverse 反把较旧 base 排第一;叠加 `loadRecentAuditEntries` 的 `break` 早退,轮转文件根本没被打开。
- **为何现有测试没抓到**:`audit-roundtrip.e2e.test.ts` 的轮转用例把 base 填的是非 JSON(`'x'.repeat(...)`,解析出 0 条),且断言用 `.some()`(存在性)而非顺序/排他性 —— bug 被双重遮蔽。

---

## 4. 业界最佳实践对比

| 维度 | 业界做法 | permission-policy 现状 | 评 |
|------|---------|----------------------|-----|
| 不可信会话姿态 | allowlist / deny-by-default(sudoers、CASL) | subagent `defaultDeny:true`(未知即拦) | ✅ |
| 可信会话姿态 | 多数生产系统 deny-by-default | trusted `unknown` → allow(黑名单) | ⚠️ 有意取舍(避免新工具触发 Approval timeout),值得周期性复盘 |
| 链式命令防护 | shell-escape hardening | worst-class-wins 切 `&&\|\|;\|&\n` + hasShellFeature 拦 `$(…)`/反引号/`<(...)` | ✅(subagent);trusted 放行 shell feature ⚠️ B8 |
| **包管理器脚本** | 不透明任意执行应按不可信处理 | `npm run <script>` 曾当 `validation`(无条件 allow) | ❌ **B1**(已修) |
| **工作区包含** | 操作真实路径,非 shell cwd | 曾不解析 `git -C`,包含检查被绕过 | ❌ **B2**(已修) |
| 包含检查实现 | path-relative + symlink resolve + 反 `/workspace-evil` 误判 | `path.relative` + `resolveReal` | ✅(机制本身扎实,B2 是 cwd 来源漏了 -C) |
| 凭证检测 | 名字 + 路径感知 | 仅按 toolName 名字匹配(含 credential/keychain/ssh-key) | ⚠️ `cat /etc/shadow` 仍 read_only(`[KNOWN GAP]` 冻结) |
| 静态分类器盲区 | 路径感知 / 沙箱(OPA、Cedar、Bubblewrap) | `npm exec --`、`cat /etc/shadow` 等(`[KNOWN GAP]`) | ⚠️ 静态子串分类固有局限,已诚实记录 |
| 审计日志 | append-only + 正确排序 + 失败有声(auditd、journald) | append-only JSONL + 10MB 轮转;**排序曾错**(F1)+ **失败曾静默**(F2) | 🟠 F1/F2 已修;F4 本地时区分桶(by design) |
| 测试纪律 | regression pinning | "honest test" —— 冻结现实 + `[KNOWN GAP]` 注释,不粉饰 | ✅ 优秀,业内少见;但 F1 暴露断言强度不足(已补强) |

**参照库**:CASL(attribute-based,更表达力但更重)、Cedar / OPA(policy-as-code,金标准但此处过重)。本库定位是窄域命令分类器,静态列表方案对其范围合适;长期演进方向是路径感知凭证检测 + 真正的 allowlist 语义。

---

## 5. 对抗 Review 说明(方法论)

4 个 reviewer 各带一个**推翻命题**,默认怀疑、用 payload 实锤反驳:

- **security-reviewer(opus)**:深推 F1 的 sort/unshift/break,证明 bug 真实且比初判更严重(轮转文件根本没被打开),并否决了不安全的修复指引。
- **code-reviewer red-team(opus)**:专找初版漏掉的 fail-open —— 实锤 B1/B2 CRITICAL + B3-B9。**确认不可利用**:tokenizeShell 引号只会 over-block、`toolKind` 降级(两个 live call site 都不传 toolKind)。
- **critic(opus)**:挑战修复正确性 + 严重度。校出 F2 应升 P1、F1 修复指引不安全、"测试盲区"诊断错误(真因是 `.some()` 断言,不是非法 JSON)。
- **verifier(sonnet)**:独立复现 F1(`/tmp` 脚本)+ 重跑全套测试 + 核对接线行号。

结果:初版"无 bypass"被推翻,且挖出一整类"静态分类器在 trusted 路径放行破坏性操作"问题。reviewer 还**二次验证修复指引本身**,避免"修法本身带新 bug"(F1 的 mtime/字典序陷阱)。这条经验写进了 #51。

根因(与 autopilot 审计同构):**"机制存在" ≠ "机制名副其实"**。绿测试 + ✅ 表格的 confirmation bias,只有带着"它信任谁 / 退化下会怎样 / 谁能绕过它"的问题去读代码才能破。

---

## 6. 发现项总表(按严重度;均附 file:line,审计时点 v0.1.0)

### P0 / 严重(均已修 #46)
| # | 发现 | 实锤 | 触发 / 后果 |
|---|------|------|------------|
| **B1** | **`npm run` 绕过 subagent guard** | `permission-policy.ts` pnpm/npm/yarn 块(`run` → `validation`)+ `decidePermission` `validation` 无条件 allow(不查 `defaultDeny`) | subagent `defaultDeny:true` 下 `npm run evil` → validation → **ALLOW**;package.json 脚本可跑任意命令,失败闭合 guard 被一条普通命令击败 |
| **B2** | **`git -C` 工作区包含逃逸** | `extractCommandSegments`(只读 `params.workdir`/`cd`,不解析 `-C`)+ 包含检查(`decidePermission` destructive_git 分支) | `git -C /etc reset --hard`(workdir=/ws)→ 包含检查 `/ws`⊂`/ws` 通过 → ALLOW,git 实际在 `/etc` 执行(trusted 路径,destructiveGit:true 时) |

### 高
| # | 发现 | 实锤 | 状态 |
|---|------|------|------|
| **B5** | **`git restore` 完全未分类** | git 分类块无 `restore`,safeGitSubs 也无 → `unknown` | ✅ #46(`restore` → `destructive_git`)。`git restore .` 丢工作区改动(现代 `checkout --` 等价物),原状 trusted ALLOW |
| **B3** | `bash -c`/`sh -c` 载荷不递归 | `genericExecTools` 递归不处理 `-c`,`-c` 当工具、载荷丢失 → `unknown` | 未修(#47)。trusted ALLOW;subagent defaultDeny 兜住 |
| **B4** | `git checkout HEAD <path>` 分到 safe_git | checkout 破坏性分支只匹配 `--`/`.`/`*`,不匹配 `HEAD <path>` | 未修(#47)。丢弃工作区却 safe_git ALLOW |
| **B8** | shell feature `$(…)` trusted 放行 | hasShellFeature 门只在 `defaultDeny` 下拦 | 未修(#47)。trusted 跑 LLM 生成命令 = 真洞 |

### 中
| # | 发现 | 实锤 | 状态 |
|---|------|------|------|
| **F1** | **审计轮转返回陈旧条目** | `audit-persister.ts:93-98` `.sort().reverse()` + `:106` `break` 早退 | ✅ #46(整数后缀比较器 `auditFileRecencyKey` + 强断言回归测试)。影响:可观测性陈旧,非安全漏洞 |
| **F2** | **审计落盘静默吞错** | `audit-persister.ts:67-75` `catch {}` 全静默 | ✅ #46(`console.error` 嵌套兜底)。审计是唯一取证链路,失败必须有声(P1) |
| **F3** | **autopilot 审计丢 cwd** | `autopilot/index.ts:652-659` 构造 entry 省略 `cwd`(dynamic-workflows 填了) | ✅ #46(补 `cwd: eventCwd ?? workspace.path`) |
| **B6** | `git -c <子命令>` 把子命令当 value 吃掉 | `-c`/`-C` strip 循环把 `clean` 当 key=val 值 | 未修(#47)。`git -c clean -fd` → sub=`-fd` → trusted ALLOW 实跑 git clean |
| **B7** | `git checkout -B` 重置分支却 safe_git | checkout 破坏性分支不匹配 `-B` | 未修(#47) |
| **B9** | framework-tool 分支丢 defaultDeny | `decidePermissionForEvent` `segments===0` 分支按 toolName 名字放行,不传 defaultDeny | 未修(#47)。toolName 可控时绕过 defaultDeny |

### 低 / 信息
| # | 发现 | 实锤 | 状态 |
|---|------|------|------|
| **F4** | 审计按本地时区分桶 | `audit-persister.ts` `todayString` 用本地日期(有测试断言) | 不修(by design;`at` 字段是 epoch ms 时区无关,仅文件名分桶按本地) |
| **F5** | `outcome` 含死分支 `require_approval` | `types.ts` 联合类型有该值,无代码路径产出 | 不修(删除波及 autopilot cast + e2e 测试,harmless 留着) |

### Reviewer 确认非问题(记录,避免再当问题)
- **tokenizeShell 引号**:只会 over-block(在引号内切 `;`/`&&`),不会 under-block。安全侧。
- **`toolKind` 降级**:`classifyCommand('rm',['-rf'],'read_only')` 理论可降级,但两个 live call site 都不传 toolKind(`EventPermissionInput` 类型无该字段),不可利用。
- **`SHELL_SPLIT_RE` 切引号内操作符**:同上,只 over-block。

---

## 7. 局限

- 未做真实 OpenClaw host 全链路 live 烟测;真实 `before_tool_call` 事件形状靠代码读 + 冻结的 e2e(live 上次验证 2026-06-28)。这是 #51 的 live-guard e2e 加固项。
- 审计审计时点 v0.1.0;file:line 为该快照下的行号,#46 修复后行号有偏移。
- 静态分类器的固有盲区(`[KNOWN GAP]` 冻结项)非本次审计范围,只确认它们被诚实记录、未回退。

---

## 8. 建议后续工单(审计 only;供单独决策)

1. **#47**(安全 backlog):B3/B4/B6/B7/B9 —— 与 B5 同类(trusted 路径放行破坏性操作),下个迭代清掉 HIGH 项 B3/B4。
2. **#51**(流程加固):dist-freshness CI 门(最高价值,防 stale dist 静默抵消 src 修复)、断言强度审查、live-guard e2e、trust-boundary 一等公民化(B9 根因)。
3. **发版**:`@oh-my-matrix/permission-policy@0.1.1` 已 release-prep(#50),npm publish 待 maintainer 2FA;publish 后打 tag `permission-policy-v0.1.1`。

---

*报告生成自 sciomc 研究流程 + 4-agent 对抗 review(security-reviewer / code-reviewer / critic / verifier);Phase 1 实测证据见 §3。修复落地见 #46。*
