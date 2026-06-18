# Deep Interview Spec: omm-MA 数字员工桥接

## Metadata
- Interview ID: bridge-001
- Rounds: 5
- Final Ambiguity Score: 16.3%
- Type: brownfield
- Generated: 2026-05-25
- Threshold: 0.20
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.80 | 0.25 | 0.200 |
| Success Criteria | 0.75 | 0.25 | 0.188 |
| Context Clarity | 0.90 | 0.15 | 0.135 |
| **Total Clarity** | | | **0.838** |
| **Ambiguity** | | | **16.3%** |

## Topology

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| MA 侧桥接 API | active | Config injection bridge：MA Gateway 启动时注入 bridge 对象到 omm plugin config，暴露 listEmployees + dispatch | 最小改动（~50行），复用现有 gateway:rpc + agent:listEmployees |
| omm 桥接工具 | active | 三个新工具注册到 omm-plugin：omm_employee_list、omm_employee_dispatch、omm_employee_result | 通过 config bridge 调用 MA 接口 |
| omm-team 技能适配 | active | omm-team SKILL.md 增加 MA 环境检测：有员工时优先用 omm_employee_dispatch，无员工时 fallback 到 TaskCreate | MA 优先 + CC fallback 策略 |
| 响应追踪 | active | omm_employee_result 通过 runId 查询结果，复用 omm-state 记录派发任务状态 | 同步等待模式 |

## Goal

在 omm team 模式中新增 MA 数字员工调度能力：team 技能检测 MA 环境后，优先将任务分派给 MA 的活跃数字员工（OpenClaw Agent），员工不可用时回退到 Claude Code subagent。端到端场景：`omm-team "3 workers do code review"` → 3 个 MA 数字员工被唤醒并各返回 review 结果。

## Constraints

- MA 改动最小化原则：只在 Gateway 启动流程中注入 bridge 对象到 omm plugin config，不修改 MA 核心路由逻辑
- Bridge 方案：Config injection（非 CLI subprocess、非文件轮询、非 HTTP server）
- 工具架构：omm plugin 工具注册在 Gateway 内，通过 bridge 对象直接调用 MA API
- 三个工具粒度：list + dispatch + result，team 技能自行编排
- omm-plugin 现有 ABI 不变：使用 `registerTool` + `config` 接收 bridge，无需新接口
- 调度策略：MA 员工优先，不可用时 fallback Claude Code subagent
- 不引入新的进程或网络端口

## Non-Goals

- 不修改 MA 的数字员工注册/激活逻辑
- 不修改 omm-state 的 schema（在现有 team state 中增加 employee 字段即可）
- 不实现员工自动选择/负载均衡（MVP 由 team 技能决定派给谁）
- 不支持 MA 员工跨机器调度（仅本地）
- 不修改 omm-ralph 或 omm-autopilot 技能

## Acceptance Criteria

- [ ] `omm_employee_list` 工具返回 MA 中所有 status=active 的员工列表
- [ ] `omm_employee_dispatch({ agentId, message })` 通过 Gateway chat.send 向指定员工发消息，返回 runId
- [ ] `omm_employee_result({ runId })` 返回员工任务的执行结果（status + output）
- [ ] omm-team 在 MA 环境下执行 "3 workers do code review on src/" 端到端完成
- [ ] 无 MA 员工可用时，omm-team 正确 fallback 到 Claude Code TaskCreate
- [ ] MA 侧改动不超过 60 行

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| team 调度 MA 员工 vs CC subagent 是对立选择 | 是否可以是互补关系？ | 混合模型：MA 员工优先，CC fallback |
| 需要修改 MA IPC 层来暴露桥接接口 | 能否通过现有 Gateway 机制？ | Config injection bridge：MA 在 omm plugin config 中注入 bridge 对象 |
| omm plugin 工具无法调用 Gateway 内部 API | 能否通过 plugin 的 registerTool execute 访问？ | bridge 通过 config 传入，工具 execute 闭包捕获 bridge 引用 |
| 需要4个以上工具 | 最小集合是什么？ | List + Dispatch + Result 三件套 |

## Technical Context

### oh-my-matrix 侧 (D:\Matrix\Productivity\oh-my-matrix)
- omm-plugin 入口：`omm-packages/omm-plugin/index.ts` → default export `register`
- 工具注册：`omm-packages/omm-plugin/src/omm-register.ts` → `api.registerTool()`
- Plugin config 访问：`api.config` 在注册时可用
- omm-team SKILL.md：`omm-packages/omm-skills/omm-team/SKILL.md`，当前委托给宿主 `Skill("team")`
- 构建产物：`omm-dist/omm-suite/`，通过 `omm-build-suite.mjs` 生成
- MCP 服务器：3 个 stdio JSON-RPC 服务器（state/memory/trace）

### MatrixAssistant 侧 (D:\Matrix\MatrixAssistant-compact-fix)
- 员工注册：`electron/utils/role-employee-registry.ts` → `listEmployees()`, `activateEmployee()`
- Gateway RPC：`electron/main/ipc/gateway-handlers.ts` → `ipcMain.handle('gateway:rpc', ...)`
- chat.send 参数：`{ sessionKey: "agent:{agentId}:main", message: string }`
- omm plugin 路径注册：`electron/utils/init-default-plugins.ts` → `ensureDefaultPluginPaths()`
- Gateway 启动：`packages/gateway/src/manager.ts`

### Bridge 注入点
- MA 在 Gateway 启动后、omm plugin 注册前，构造 bridge 对象
- 通过 omm plugin 的 `config` 传递：`config.bridge = { listEmployees, dispatch, getResult }`
- omm 工具在 `register(api)` 时从 `api.config.bridge` 获取引用

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| BridgeConfig | core domain | listEmployees(), dispatch(agentId, message), getResult(runId) | 注入到 omm plugin config |
| EmployeeSummary | core domain | employeeId, roleId, roleName, agentId, model, status | Bridge 通过 listEmployees 返回 |
| DispatchRequest | supporting | agentId, message, idempotencyKey | Bridge.dispatch 接收 |
| DispatchResult | supporting | runId, status, output | Bridge.getResult 返回 |
| omm_employee_list | tool | — | 调用 Bridge.listEmployees |
| omm_employee_dispatch | tool | agentId, message | 调用 Bridge.dispatch |
| omm_employee_result | tool | runId | 调用 Bridge.getResult |
| omm-team SKILL.md | skill | dispatch strategy | 检测 omm_employee_list 可用 → MA 优先模式 |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 4 (bridge, employee, dispatch, tool) | 4 | - | - | N/A |
| 3 | 5 (+result tracking) | 1 | 0 | 4 | 80% |
| 5 | 8 (final model) | 3 | 0 | 5 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds)</summary>

### Round 0 — Topology Confirmation
**Q:** 4 components: MA bridge API, omm bridge tools, omm-team skill adaptation, response tracking. Right?
**A:** Looks right

### Round 1
**Q:** What verifiable result means "done"?
**A:** End-to-end team dispatch: "3 workers do code review" → 3 MA employees wake up and return results

### Round 2
**Q:** MA bridge API expose as what?
**A:** Gateway-internal plugin tools (not MCP server, not HTTP)

### Round 3
**Q:** Bridge tool execution path?
**A:** Config injection bridge (recommended, minimal MA changes)

### Round 4
**Q:** MA employees vs CC subagent dispatch strategy?
**A:** MA priority + CC fallback

### Round 5
**Q:** Tool granularity?
**A:** List + Dispatch + Result three tools
</details>
