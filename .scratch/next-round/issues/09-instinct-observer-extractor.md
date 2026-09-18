# 09 — instinct：turn-boundary extractor（tool 路线）

**What to build:** `packages/instinct` v0.1.0 已发货 observer（`after_tool_call` → `.instinct/observations.jsonl`，rotation + secret scrub + `projectId` sha256[:12]）和 `session_start` recall。本票只做缺失的 extractor：注册 `instinct_record` tool 让主 agent 主动记录 instinct 到 `.instinct/instincts.jsonl`，并把 recall 改成两段输出。

**Blocked by:** None（原票记的 blocker「插件进程内无 headless cheap-agent 原语」对 tool 路线不成立，spike 已验证，见下）

**Status:** ready-for-agent

**票面修正（2026-09-18）:** 原票写「新包，四项待做」。实况是包已存在，四项里三项已落地——observer、secret scrub + 自循环守卫、项目检测 sha256[:12] 都在 `src/store.ts` 和 `index.ts` 里，16 个测试通过。唯一真缺的是 extractor。另有两处复用偏离和两个 observer 缺口，见「遗留」和 ticket-11。

## 已验证的 host 契约

spike 时间 2026-09-18，openclaw 2026.7.1-2。

- `api.registerTool(tool | OpenClawPluginToolFactory, opts?)` 存在于 `OpenClawPluginApi`（`dist/types-DaHgOqFX.d.ts:27`），相邻还有 `registerToolMetadata`（按 `(pluginId, toolName)` 作用域）。**单个 `register(api)` 入口可以同时注册 hook 和 tool**，不需要拆成两个插件。
- **不要用 `defineToolPlugin`**（`openclaw/plugin-sdk/tool-plugin`）。它的 options 是 `{id, name, description, activation?, configSchema?, tools}`，**没有 `register`**；用它就丢掉 observer 和 recall 两个 hook 的注册能力。
- `PluginManifestActivationCapability = "provider" | "channel" | "tool" | "hook"`。`"tool"` 是一等公民，但 `openclaw.plugin.json` 现在只声明了 `hooks`，需要补 tool capability 声明。
- 备用路线（本票不采用，记录以免重新调研）：`before_agent_finalize` 的 event 带 `lastAssistantMessage?: string` 和 `messages?: unknown[]`，所以「`agent_turn_prepare` 注入 → `before_agent_finalize` 收割」这条回路是闭合的。它的返回只认 `action: "continue" | "revise" | "finalize"` / `reason` / `retry.instruction`，**没有 appendContext**，所以注入必须发生在 `agent_turn_prepare`（返回 `{prependContext?, appendContext?}`，event 带 `prompt: string` + `messages`）。
- `model-routing-thinking-intensity-design.md:45` 记的「appendContext 只注入文本，Gateway 不读」那条 CRITICAL 只针对**模型路由**（Gateway 不读 appendContext 去选模型），不意味着 agent 的输出捞不回来。

## 设计决策

grill 定稿 2026-09-18。

1. **提取主体 = tool，不是 appendContext 注入。** agent 主动调用即高置信；prompt 侧只付一行 tool description 的 token，不对每个 turn 收注入税。注入路线的失败模式（agent 不按格式输出 → 只能静默降级 → 失败率不可观测）也一并避开。
2. **instinct 字段 = `text` + `project` + `ts` + `scope`。** 不要 `confidence`：tool 路线下它恒定，存常量没信息量。不要 `domain`：它是 promote/evolve 的聚类键，而那两个功能 YAGNI 到 ≥3 projects，且将来能从 `text` 反推。留 `scope`：它是唯一**事后无法重建**的字段——「这条是本项目特有还是通用知识」是记录当时的判断，`text` 里没有这个信息；不留它，第 2、第 3 个项目接进来时所有历史 instinct 都得重标。
3. **落盘 `.instinct/instincts.jsonl`。** 把 `store.ts` 现有的 append / rotation / 倒序读按文件名参数化即可复用，零新代码路径。不用 YAML：instinct 要 merge，YAML 全量重写在崩溃点上不原子，JSONL 的 append 是。不混进 `observations.jsonl`：会让两段 recall 从同一文件反复过滤，且 raw 观察涨到 10 MB 时 rotation 会把 instinct 一起挪走。
4. **写入时按 `text` 精确去重**，命中则更新 `ts` 并累加命中次数。纯 append 会让重复条目挤占 recall 里最贵的 token 位置；语义去重要 embedding（新依赖 + 新失败模式），在单项目 <100 条规模上收益为零。命中次数是可观测的置信度来源，比 agent 自报分数可信——这是决策 2 砍掉 `confidence` 之后它真正该长出来的地方。
5. **recall 两段并存。** raw 尾部回答「上次停在哪」，instinct 回答「这项目一贯怎么运作」。两者时间尺度不同，混成一段就无法按 token 预算各自裁剪，而 `session_start` 是所有插件抢同一预算的地方。
6. **tool 只写。** 读路径已由 `session_start` 自动注入，不加 `instinct_recall`——agent 要主动查的前提是先知道有东西可查，而 session_start 已经把东西摆在它面前了；加第二个读入口还得回答「两条读路径不一致时信哪个」。
7. **只自用。** 不喂 autopilot 的 `resolveThinkingIntensity()`（`effort-injection.ts:46-54`）。让已发货的路由链消费一个 schema 未稳定的 0.1.0 源，等于拿刚落地的 ticket-04 做抵押。schema 在 ≥3 projects 上稳定后另开票。

## 任务

- [ ] `src/store.ts`：文件名参数化；新增 `appendInstinct`（按 `text` 精确去重，命中则更新 `ts` 并累加 `hits`）和 `loadInstincts`
- [ ] `index.ts`：用 `api.registerTool` 注册 `instinct_record`，TypeBox parameters 为 `{text: string, scope: "project" | "global"}`；写失败不抛，沿用现有 `_writeFailures` 计数模式；`api.registerTool` 不存在时降级为禁用并 `console.error`（与现有 hook 注册缺失的处理一致）
- [ ] `index.ts`：`session_start` recall 改两段输出（raw 尾部 + instinct），两段各自独立可裁剪
- [ ] `openclaw.plugin.json`：补 `"tool"` capability 与 tool 声明
- [ ] tests：tool execute 契约、去重与 `hits` 累加、两段 recall 渲染、`registerTool` 缺失时的降级路径
- [ ] **若 ticket-11 先落地**：把它实现的 30 天 purge 扩展到 `instincts.jsonl`。ticket-11 的 purge 只覆盖 `observations.jsonl`（当时只有这一个文件族），本票新增第二个文件族，purge 不扩展就是静默缺口

## 遗留（不属于本票）

- 两处复用偏离：`src/store.ts` 的 JSONL + rotation 是重写而非复用 `permission-policy/src/audit-persister.ts`；`index.ts:99` 的自循环守卫是内联 `sessionKey.includes(':subagent:')` 而非复用 `dynamic-workflows/index.ts:57` 的 `isSubagentSessionKey`。
- observer 的两个缺口（`.gitignore` 缺失、30 天 purge 未实现）见 ticket-11。

## 参考

`docs/design/ecc-intake-recommendation.md` §3.1 #1（完整设计含 graft 点，注意其 blocker 判断对 tool 路线已失效）；ponytail：promote/evolve YAGNI until ≥3 projects。

