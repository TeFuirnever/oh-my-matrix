# 设计文档：Model Routing & Thinking Intensity for Autopilot

> 版本：v1（初始设计 + 3 人对抗 review 修正）· 日期：2026-06-26
> 审查链：3 路 Opus 对抗 review（架构可行性 / YAGNI / 代码可行性）+ OpenClaw 源码验证。
> OpenClaw 源码锚点：`embedded-agent-runner/run.ts`、`plugins/hook-types.ts`、`hook-before-agent-start.types.ts`。

---

## 1. 目标

为 `@oh-my-matrix/autopilot` 引入**分级思考强度**（graduated thinking intensity）和**模型 tier 路由**（model tier routing），使 autopilot 能根据执行阶段（初始 turn / 实现 / 验证）自动调整 LLM 的思考深度和模型选择。subagent（workflow 中的每个 agent）也自动获得同等能力。

### 1.1 动机

| 现状 | 问题 |
|------|------|
| `effort-injection.ts` 只有二元注入（running → "use high effort"，否则 null） | 每个 turn 都注入最高 effort，验证阶段（跑测试 + 收集证据）不需要 extended thinking，浪费推理时间 |
| 无模型路由 | 所有 turn 用相同模型，不能在初始 turn 用 opus 深度分析、实现阶段用 sonnet 快速出码、验证阶段用 haiku 跑检查 |
| subagent 不受控 | dynamic workflow 扇出的 subagent 继承父模型，无法差异化（screening agent 不需要 opus） |

### 1.2 与 OMC 的关系

oh-my-claudecode (OMC) 已有成熟的 3-tier 模型路由系统（LOW/MEDIUM/HIGH → haiku/sonnet/opus）、环境变量解析链、alias 覆盖、escalation 关键词、forceInherit 开关。但 OMC 的架构（dotfile 驱动 CLI + agent definition files）和 omm 的架构（OpenClaw lifecycle-hook 插件）根本不同：

| 维度 | OMC | omm / autopilot |
|------|-----|------------------|
| 模型选择者 | Claude Code CLI 直接传 model param 到 API | OpenClaw Gateway 通过 hook 系统获取模型建议 |
| 路由入口 | 每个 agent 的 `.md` frontmatter + 环境变量链 | `before_model_resolve` hook 返回 `{ modelOverride }` |
| 配置面 | `~/.claude/omc.jsonc` + 环境变量 | `openclaw.plugin.json` configSchema + WORKFLOW.md front matter |
| subagent 路由 | Agent tool 的 `model` 参数 | Gateway 统一执行路径，subagent 也触发 `before_model_resolve` |

**结论：不搬 OMC 的实现，只借鉴概念（tier 分级、按阶段路由），用 OpenClaw 原生 hook 机制实现。**

## 2. 对抗 Review 发现与修正

3 路 Opus 对抗 review 发现了原始计划中的关键缺陷：

| # | 发现 | 严重性 | 原始计划问题 | 修正 |
|---|------|--------|-------------|------|
| 1 | `appendContext` 只注入文本，Gateway 不读 | **CRITICAL** | 计划用 `agent_turn_prepare` 的 `appendContext` 做模型路由 | 改用 `before_model_resolve` hook，返回 `{ modelOverride }` |
| 2 | `totalContinuations <= 1` 不是"规划阶段" | **CRITICAL** | 计划将初始 turn 标注为"规划阶段" | `totalContinuations === 0` 是第一个执行 turn（agent 开始干活），不存在独立规划阶段。改称"初始 turn" |
| 3 | `createInitialState()` 不自动复制新字段 | **MAJOR** | 计划在 Config 和 State 都加 `thinkingIntensity` | 只放 Config，作为参数传递 |
| 4 | `register()` 手动解构 config | **MINOR** | 计划未提及嵌套对象解析 | 显式解析 `modelRouting` 子对象 |
| 5 | 测试量低估 | **MINOR** | ~20 LOC | 调至 ~60-100 LOC |

## 3. OpenClaw SDK 源码分析

### 3.1 `before_model_resolve` hook（模型路由的唯一接口）

**定义**（`openclaw/src/plugins/hook-before-agent-start.types.ts:6-18`）：

```typescript
export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
};
```

**调用点**（`openclaw/src/agents/embedded-agent-runner/run/setup.ts:42-70`）：

```typescript
export async function resolveHookModelSelection(params: {
  prompt: string;
  attachments?: PluginHookBeforeModelResolveAttachment[];
  provider: string;
  modelId: string;
  hookRunner?: HookRunnerLike | null;
  hookContext: HookContext;
}) {
  // Run before_model_resolve hooks early so plugins can override the
  // provider/model before resolveModel().
  if (hookRunner?.hasHooks("before_model_resolve")) {
    const event = { prompt: params.prompt, attachments: params.attachments };
    modelResolveOverride = await hookRunner.runBeforeModelResolve(event, params.hookContext);
  }
  // ...applies override to provider/modelId
}
```

**关键：`embedded-agent-runner` 是统一执行路径**（`run.ts:650`），主 agent 和 subagent 都调用 `resolveHookModelSelection()`。subagent 通过 `spawnedBy` 参数进入同一路径。

### 3.2 `agent_turn_prepare` hook（effort injection 的现有通道）

**定义**（`openclaw/src/plugins/host-hook-turn-types.ts`）：

```typescript
export type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};
```

**现有接线**（`oh-my-matrix/packages/autopilot/index.ts:472-531`）：

```typescript
registerHook('agent_turn_prepare', (event: any, ctx: any) => {
  // ...goal reinforcement, progress injection...
  const effortCtx = buildEffortInjection(updated.status);
  if (effortCtx) parts.push(effortCtx);
  return { appendContext: parts.join('\n') };
});
```

此 hook 注入的是**文本上下文**（agent 看到的 system/context 文本），不是 Gateway 的模型选择信号。effort injection 通过此通道是正确的（改变 agent 的行为指令），模型路由通过此通道是错误的（Gateway 不读 appendContext）。

### 3.3 subagent 执行路径验证

**Hook context 类型**（`hook-types.ts:191-210`）：

```typescript
export type PluginHookAgentContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;    // 主 agent: "agent:<id>"
  sessionId?: string;     // subagent: "agent:<main>:subagent:<sub-id>"
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  // ...
};
```

**subagent spawn 类型**（`hook-types.ts:593-615`）：

```typescript
export type PluginHookSubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

type PluginHookSubagentSpawnBase = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  // ...
};
```

**结论：subagent 的 `sessionKey` 包含 `:subagent:` 标记，可通过字符串匹配区分主/子 agent。**

### 3.4 hook 注册 API

**现有注册方式**（`index.ts:272-274`）：

```typescript
const registerHook = api.on?.bind(api) ?? api.registerHook?.bind(api);
```

**hook 列表声明**（`openclaw.plugin.json:10-22`）：

```json
"hooks": [
  "before_agent_finalize", "agent_end", "after_tool_call",
  "before_compaction", "after_compaction", "session_start",
  "session_end", "agent_turn_prepare", "before_agent_run",
  "before_tool_call", "llm_output"
]
```

新增 `before_model_resolve` 需同时更新 `openclaw.plugin.json` 和 `package.json`（如有 hooks 声明）。

## 4. 详细设计

### 4.1 PR 1: Graduated Thinking Intensity

**目标**：将二元 effort injection 扩展为 3 级，并按执行阶段动态选择。

#### 4.1.1 新增类型（`src/types.ts`）

```typescript
// ─── Thinking Intensity ─────────────────────────────────────
/**
 * Graduated thinking intensity levels.
 * Controls the effort injection text in agent_turn_prepare.
 * - 'low': standard effort, prefer direct efficient responses
 * - 'medium': moderate extended thinking
 * - 'high': full extended thinking (current default, backward compat)
 */
export type ThinkingIntensity = 'low' | 'medium' | 'high';
```

插入位置：`EvidenceStatus` 类型之后（约 line 62）。

**`AutopilotConfig` 变更**（`src/types.ts:220-228`）：

```typescript
export interface AutopilotConfig {
  maxAttemptsPerTurn: number;
  maxTotalContinuations: number;
  toolErrorThreshold: number;
  excludedAgents?: string[];
  highRiskTools?: string[];
  tokenBudget?: number;
  maxConcurrentAutopilot?: number;
  thinkingIntensity?: ThinkingIntensity;  // 新增：默认 'high'
}
```

**注意**：`thinkingIntensity` 只放 `AutopilotConfig`，**不放 `AutopilotState`**。原因：
- `createInitialState()` 手动列出每个字段（`types.ts:238-260`），不会自动复制新字段
- Config 是静态配置，State 是运行时可变状态。thinking intensity 的静态部分来自 config，动态部分由 `resolveThinkingIntensity()` 计算——无需持久化到 state
- 避免 config vs state 双源歧义（"哪个是权威的？"）

#### 4.1.2 effort-injection.ts 扩展

**当前代码**（13 LOC）：

```typescript
export function buildEffortInjection(status: string): string | null {
  if (status === 'running') {
    return '[autopilot-effort] Use high effort (extended thinking) for this turn.';
  }
  return null;
}
```

**修改后**：

```typescript
import type { ThinkingIntensity, EvidenceStatus } from './types';

/**
 * Effort injection for autopilot agent_turn_prepare hook.
 *
 * When autopilot status is 'running', injects a context instruction
 * calibrated to the requested thinking intensity level.
 * This prevents cross-turn effort degradation (TD-1).
 *
 * @param status - autopilot status ('running' triggers injection)
 * @param intensity - thinking intensity level (default: 'high' for backward compat)
 */
export function buildEffortInjection(
  status: string,
  intensity: ThinkingIntensity = 'high',
): string | null {
  if (status !== 'running') return null;
  // ponytail: switch covers all 3 cases exhaustively; TS will catch missing cases
  switch (intensity) {
    case 'low':
      return '[autopilot-effort] Use standard effort for this turn. Prefer direct, efficient responses.';
    case 'medium':
      return '[autopilot-effort] Use moderate effort (some extended thinking) for this turn.';
    case 'high':
      return '[autopilot-effort] Use high effort (extended thinking) for this turn.';
  }
}

/**
 * Resolve thinking intensity dynamically based on execution phase.
 *
 * Phase detection heuristic:
 * - evidence.status === 'running': validation phase → low (fast execution)
 * - totalContinuations <= 1: initial turns → high (deep analysis)
 * - otherwise: use configured intensity
 *
 * Note: totalContinuations === 0 is the first execution turn (user prompt arrives,
 * agent starts working). Autopilot has NO dedicated "planning phase" — the agent
 * begins executing immediately. We call these "initial turns", not "planning turns".
 *
 * @param totalContinuations - number of continuations completed so far
 * @param evidenceStatus - current evidence gate status (undefined if not started)
 * @param configIntensity - static intensity from AutopilotConfig (default: 'high')
 */
export function resolveThinkingIntensity(
  totalContinuations: number,
  evidenceStatus: EvidenceStatus | undefined,
  configIntensity: ThinkingIntensity = 'high',
): ThinkingIntensity {
  // Validation phase: evidence gate is running → fast, low-effort execution
  if (evidenceStatus === 'running') return 'low';
  // Initial turns: first real execution → deep thinking for goal decomposition
  if (totalContinuations <= 1) return 'high';
  // Implementation turns: user-configured intensity
  return configIntensity;
}
```

**向后兼容**：
- `buildEffortInjection(status)` 无第二参数时默认 `'high'`，产生与现有代码完全相同的注入字符串
- 所有 633 现有测试不受影响

#### 4.1.3 index.ts 接线变更

**`register()` 函数 config 解析**（`index.ts:258-269`）新增：

```typescript
const config: AutopilotConfig = {
  ...DEFAULT_CONFIG,
  // ...existing field coercion...
  ...(typeof uc.thinkingIntensity === 'string' &&
      ['low', 'medium', 'high'].includes(uc.thinkingIntensity)
    ? { thinkingIntensity: uc.thinkingIntensity as ThinkingIntensity }
    : {}),
};
```

**`agent_turn_prepare` hook 变更**（`index.ts:523-525`）：

```typescript
// Before (现有):
const effortCtx = buildEffortInjection(updated.status);

// After (修改):
const intensity = resolveThinkingIntensity(
  updated.totalContinuations,
  updated.evidence?.status,
  config.thinkingIntensity,
);
const effortCtx = buildEffortInjection(updated.status, intensity);
```

#### 4.1.4 projection.ts 变更

**`AutopilotProjection` 接口新增**（`src/projection.ts:3-38`）：

```typescript
export interface AutopilotProjection {
  // ...existing fields...
  /** Current resolved thinking intensity (for observability/debugging) */
  thinkingIntensity?: ThinkingIntensity;
}
```

**`projectState()` 函数新增**（`src/projection.ts:52-94`）：

```typescript
export function projectState(state: AutopilotState | undefined): AutopilotProjection | undefined {
  if (!state) return undefined;
  // ...existing logic...
  return {
    // ...existing fields...
    thinkingIntensity: state.status === 'running'
      ? resolveThinkingIntensity(
          state.totalContinuations,
          state.evidence?.status,
          // ponytail: config not available here, use default 'high'
          // projection is for observability only, exact config value not critical
        )
      : undefined,
  };
}
```

**注意**：`projectState()` 不接收 `config`（只接收 `state`）。projection 中的 `thinkingIntensity` 基于 state 计算，用默认值。这是故意的简化——projection 是观测性工具，不需要 config 精度。如果未来需要精确值，可以在 state 中加一个 `resolvedThinkingIntensity` 快照字段。

#### 4.1.5 openclaw.plugin.json 变更

```json
{
  "configSchema": {
    "properties": {
      // ...existing properties...
      "thinkingIntensity": {
        "type": "string",
        "enum": ["low", "medium", "high"],
        "default": "high",
        "description": "Thinking intensity for autopilot turns. 'high' = extended thinking (default), 'medium' = moderate, 'low' = standard effort."
      }
    }
  }
}
```

#### 4.1.6 测试（新建 `tests/effort-injection.test.ts`）

```typescript
/**
 * TDD: Written BEFORE implementation.
 * Tests graduated thinking intensity and dynamic resolution.
 */
import { describe, it, expect } from 'vitest';
import { buildEffortInjection, resolveThinkingIntensity } from '../src/effort-injection';

describe('buildEffortInjection', () => {
  describe('status !== running', () => {
    it('returns null for idle', () => {
      expect(buildEffortInjection('idle')).toBeNull();
      expect(buildEffortInjection('idle', 'high')).toBeNull();
    });

    it('returns null for paused', () => {
      expect(buildEffortInjection('paused', 'medium')).toBeNull();
    });
  });

  describe('status === running', () => {
    it('defaults to high when no intensity specified (backward compat)', () => {
      const result = buildEffortInjection('running');
      expect(result).toBe('[autopilot-effort] Use high effort (extended thinking) for this turn.');
    });

    it('returns low effort text', () => {
      const result = buildEffortInjection('running', 'low');
      expect(result).toContain('standard effort');
      expect(result).not.toContain('extended thinking');
    });

    it('returns medium effort text', () => {
      const result = buildEffortInjection('running', 'medium');
      expect(result).toContain('moderate effort');
    });

    it('returns high effort text (same as current)', () => {
      const result = buildEffortInjection('running', 'high');
      expect(result).toContain('high effort');
      expect(result).toContain('extended thinking');
    });
  });
});

describe('resolveThinkingIntensity', () => {
  it('returns low during evidence running (validation phase)', () => {
    expect(resolveThinkingIntensity(5, 'running', 'high')).toBe('low');
  });

  it('returns high for initial turns (totalContinuations <= 1)', () => {
    expect(resolveThinkingIntensity(0, undefined, 'medium')).toBe('high');
    expect(resolveThinkingIntensity(1, undefined, 'medium')).toBe('high');
  });

  it('returns config intensity for implementation turns', () => {
    expect(resolveThinkingIntensity(5, undefined, 'medium')).toBe('medium');
    expect(resolveThinkingIntensity(10, undefined, 'low')).toBe('low');
  });

  it('defaults to high when no config intensity', () => {
    expect(resolveThinkingIntensity(5, undefined)).toBe('high');
  });

  it('evidence running overrides initial turn heuristic', () => {
    // totalContinuations=0 but evidence running → validation wins
    expect(resolveThinkingIntensity(0, 'running', 'high')).toBe('low');
  });

  it('non-running evidence statuses do not affect intensity', () => {
    expect(resolveThinkingIntensity(5, 'passed', 'medium')).toBe('medium');
    expect(resolveThinkingIntensity(5, 'failed', 'medium')).toBe('medium');
    expect(resolveThinkingIntensity(5, 'not_started', 'medium')).toBe('medium');
  });
});
```

**Est. ~120 LOC**（含测试 ~70 LOC）。

---

### 4.2 PR 2: Model Tier Routing via `before_model_resolve`

**目标**：通过 OpenClaw 的 `before_model_resolve` hook 实现真正的模型路由。主 agent 和 subagent 统一生效。

#### 4.2.1 新增类型（`src/types.ts`）

```typescript
// ─── Model Routing ──────────────────────────────────────────
/**
 * Model tier levels for cost-aware routing.
 * Maps to concrete model IDs via ModelRoutingConfig.modelIds.
 *
 * - 'budget': cheapest viable model (e.g., deepseek-v4-pro, haiku)
 * - 'standard': default quality-cost balance (e.g., sonnet)
 * - 'premium': highest capability (e.g., opus)
 */
export type ModelTier = 'budget' | 'standard' | 'premium';

/**
 * Model routing configuration.
 *
 * Determines which model tier to use per execution phase.
 * Concrete model IDs are resolved via modelIds map.
 * If modelIds[tier] is not configured, no modelOverride is returned
 * and the session inherits its default model.
 */
export interface ModelRoutingConfig {
  /** Default tier for implementation turns. Default: 'standard'. */
  defaultTier: ModelTier;
  /** Tier for initial turns (totalContinuations <= 1). Default: 'premium'. */
  initialTurnTier?: ModelTier;
  /** Tier for validation turns (evidence.status === 'running'). Default: 'standard'. */
  validationTier?: ModelTier;
  /** Tier for subagent runs (sessionKey contains ':subagent:'). Default: uses defaultTier. */
  subagentTier?: ModelTier;
  /** Map tier → concrete model ID string (e.g., "deepseek-v4-pro", "claude-opus-4-8"). */
  modelIds?: Partial<Record<ModelTier, string>>;
}
```

**`AutopilotConfig` 新增**：

```typescript
export interface AutopilotConfig {
  // ...existing fields...
  thinkingIntensity?: ThinkingIntensity;  // from PR 1
  modelRouting?: ModelRoutingConfig;       // 新增
}
```

**`WorkflowConfig` 新增**：

```typescript
export interface WorkflowConfig {
  // ...existing fields (version, source, maxConcurrent, workspace, etc.)...
  modelRouting?: ModelRoutingConfig;  // 新增：WORKFLOW.md 可覆盖 plugin config
}
```

#### 4.2.2 model-routing.ts（新建，~80 LOC）

```typescript
/**
 * Model tier routing for autopilot.
 *
 * Pure functions — no side effects, no file I/O, no IPC.
 * Gateway consumes the result via the before_model_resolve hook.
 *
 * Routing heuristic (priority order):
 * 1. Subagent with explicit subagentTier → subagentTier
 * 2. Evidence gate running (validation phase) → validationTier
 * 3. Initial turns (totalContinuations <= 1) → initialTurnTier
 * 4. Everything else → defaultTier
 */
import type { ModelTier, ModelRoutingConfig, EvidenceStatus } from './types';

const DEFAULT_ROUTING: Required<Omit<ModelRoutingConfig, 'modelIds' | 'subagentTier'>> = {
  defaultTier: 'standard',
  initialTurnTier: 'premium',
  validationTier: 'standard',
};

/**
 * Resolve the model tier for the current turn.
 *
 * @param totalContinuations - number of continuations completed
 * @param evidenceStatus - current evidence gate status
 * @param isSubagent - whether this is a subagent session
 * @param config - model routing configuration (optional)
 * @returns the resolved model tier
 */
export function resolveModelTier(
  totalContinuations: number,
  evidenceStatus: EvidenceStatus | undefined,
  isSubagent: boolean,
  config?: ModelRoutingConfig,
): ModelTier {
  // 1. Subagent with explicit tier
  if (isSubagent && config?.subagentTier) {
    return config.subagentTier;
  }
  // 2. Validation phase: evidence gate running
  if (evidenceStatus === 'running') {
    return config?.validationTier ?? DEFAULT_ROUTING.validationTier;
  }
  // 3. Initial turns: deep analysis
  if (totalContinuations <= 1) {
    return config?.initialTurnTier ?? DEFAULT_ROUTING.initialTurnTier;
  }
  // 4. Implementation turns: default
  return config?.defaultTier ?? DEFAULT_ROUTING.defaultTier;
}

/**
 * Resolve a concrete model ID from a tier.
 * Returns undefined if no modelIds mapping exists → no override, inherit session model.
 */
export function resolveModelId(
  tier: ModelTier,
  config?: ModelRoutingConfig,
): string | undefined {
  return config?.modelIds?.[tier];
}

/**
 * Detect whether a sessionKey belongs to a subagent.
 *
 * OpenClaw subagent sessionKeys follow the pattern:
 *   agent:<main-agent-id>:subagent:<sub-agent-id>
 *
 * Source: openclaw/src/infra/state-migrations.ts:367-369
 */
export function isSubagentSession(sessionKey?: string): boolean {
  if (!sessionKey) return false;
  return sessionKey.includes(':subagent:');
}
```

#### 4.2.3 index.ts 接线变更

**`register()` config 解析新增**：

```typescript
// Parse nested modelRouting config object
function parseModelRouting(raw: unknown): ModelRoutingConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const validTier = (v: unknown): ModelTier | undefined =>
    typeof v === 'string' && ['budget', 'standard', 'premium'].includes(v)
      ? v as ModelTier
      : undefined;
  const result: ModelRoutingConfig = {
    defaultTier: validTier(r.defaultTier) ?? 'standard',
  };
  const initial = validTier(r.initialTurnTier);
  if (initial) result.initialTurnTier = initial;
  const validation = validTier(r.validationTier);
  if (validation) result.validationTier = validation;
  const subagent = validTier(r.subagentTier);
  if (subagent) result.subagentTier = subagent;
  if (typeof r.modelIds === 'object' && r.modelIds !== null) {
    const ids = r.modelIds as Record<string, unknown>;
    const parsed: Partial<Record<ModelTier, string>> = {};
    for (const tier of ['budget', 'standard', 'premium'] as const) {
      if (typeof ids[tier] === 'string') parsed[tier] = ids[tier] as string;
    }
    if (Object.keys(parsed).length > 0) result.modelIds = parsed;
  }
  return result;
}

const config: AutopilotConfig = {
  ...DEFAULT_CONFIG,
  // ...existing field coercion...
  ...(typeof uc.thinkingIntensity === 'string' ... ),  // from PR 1
  ...(uc.modelRouting ? { modelRouting: parseModelRouting(uc.modelRouting) } : {}),
};
```

**新增 `before_model_resolve` hook**（在 `agent_turn_prepare` 之后注册）：

```typescript
// Model routing: override model selection per execution phase
registerHook('before_model_resolve', (event: any, ctx: any) => {
  const sessionKey = ctx?.sessionKey;
  if (!sessionKey) return;

  // Find the autopilot run for this session (or its parent session for subagents)
  const entry = findRunBySession(sessionKey)
    ?? (isSubagentSession(sessionKey)
      // Subagent: look up the parent autopilot run
      // sessionKey format: agent:<main>:subagent:<sub>
      // Extract requesterSessionKey from context if available
      ? findRunBySession(ctx.requesterSessionKey ?? extractParentSessionKey(sessionKey))
      : undefined);
  if (!entry?.[1].enabled || entry[1].status !== 'running') return;

  const [, state] = entry;

  // Resolve effective routing config: WORKFLOW.md > plugin config
  const routingConfig = state.workflow?.modelRouting ?? config.modelRouting;
  if (!routingConfig?.modelIds) return; // No model IDs configured → no override

  const tier = resolveModelTier(
    state.totalContinuations,
    state.evidence?.status,
    isSubagentSession(sessionKey),
    routingConfig,
  );
  const modelId = resolveModelId(tier, routingConfig);

  if (modelId) {
    log(`[autopilot] before_model_resolve: session=${sessionKey} tier=${tier} model=${modelId}`);
    return { modelOverride: modelId };
  }
});

// Helper: extract parent session key from subagent key
function extractParentSessionKey(subagentKey: string): string | undefined {
  // agent:main-id:subagent:sub-id → agent:main-id
  const idx = subagentKey.indexOf(':subagent:');
  return idx > 0 ? subagentKey.substring(0, idx) : undefined;
}
```

#### 4.2.4 openclaw.plugin.json 变更

```json
{
  "hooks": [
    "before_agent_finalize", "agent_end", "after_tool_call",
    "before_compaction", "after_compaction", "session_start",
    "session_end", "agent_turn_prepare", "before_agent_run",
    "before_tool_call", "llm_output",
    "before_model_resolve"
  ],
  "configSchema": {
    "properties": {
      // ...existing + thinkingIntensity from PR 1...
      "modelRouting": {
        "type": "object",
        "description": "Model tier routing configuration. Maps execution phases to model tiers.",
        "properties": {
          "defaultTier": {
            "type": "string",
            "enum": ["budget", "standard", "premium"],
            "default": "standard"
          },
          "initialTurnTier": {
            "type": "string",
            "enum": ["budget", "standard", "premium"],
            "default": "premium"
          },
          "validationTier": {
            "type": "string",
            "enum": ["budget", "standard", "premium"],
            "default": "standard"
          },
          "subagentTier": {
            "type": "string",
            "enum": ["budget", "standard", "premium"],
            "description": "Override tier for subagent sessions. Defaults to defaultTier."
          },
          "modelIds": {
            "type": "object",
            "description": "Map tier names to concrete model ID strings.",
            "properties": {
              "budget":   { "type": "string" },
              "standard": { "type": "string" },
              "premium":  { "type": "string" }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

#### 4.2.5 workflow-config.ts 变更

**`parseAutopilotSection()`**（`src/workflow-config.ts:44-133`）：

`knownKeys` 新增 `'model_routing'`：

```typescript
const knownKeys = new Set([
  'version', 'max_concurrent', 'max_retries',
  'stall_timeout_ms', 'max_retry_backoff_ms', 'workspace', 'validation',
  'destructive_git',
  'model_routing',  // 新增
]);
```

新增解析逻辑（在 `destructive_git` 解析块之后）：

```typescript
if ('model_routing' in raw && typeof raw.model_routing === 'object' && raw.model_routing !== null) {
  const mr = raw.model_routing as Record<string, unknown>;
  const validTier = (v: unknown): ModelTier | undefined =>
    typeof v === 'string' && ['budget', 'standard', 'premium'].includes(v)
      ? v as ModelTier
      : undefined;

  const routing: ModelRoutingConfig = {
    defaultTier: validTier(mr.default_tier) ?? 'standard',
  };
  const initial = validTier(mr.initial_turn_tier);
  if (initial) routing.initialTurnTier = initial;
  const validation = validTier(mr.validation_tier);
  if (validation) routing.validationTier = validation;
  const subagent = validTier(mr.subagent_tier);
  if (subagent) routing.subagentTier = subagent;

  if (typeof mr.model_ids === 'object' && mr.model_ids !== null) {
    const ids = mr.model_ids as Record<string, unknown>;
    const parsed: Partial<Record<ModelTier, string>> = {};
    for (const tier of ['budget', 'standard', 'premium'] as const) {
      if (typeof ids[tier] === 'string') parsed[tier] = ids[tier] as string;
    }
    if (Object.keys(parsed).length > 0) routing.modelIds = parsed;
  }

  result.modelRouting = routing;
}
```

**注意 snake_case → camelCase 映射**：YAML 用 `default_tier`、`initial_turn_tier`、`model_ids`（snake_case），TypeScript 类型用 `defaultTier`、`initialTurnTier`、`modelIds`（camelCase）。与现有 `max_concurrent` → `maxConcurrent` 模式一致。

**YAML parser 能力验证**：`parseSimpleYaml()` 通过递归 `parseValue()` 处理任意深度嵌套。`model_routing` → `model_ids` → `budget: deepseek-v4-pro` 的 3 层嵌套在 regex `^(\w[\w_-]*):\s*(.*)` 的匹配范围内（`budget`、`deepseek-v4-pro` 都是 `\w[\w_-]*`），`parseScalar('deepseek-v4-pro')` 返回字符串。✅ 无需改 parser。

#### 4.2.6 projection.ts 变更

```typescript
export interface AutopilotProjection {
  // ...existing fields...
  thinkingIntensity?: ThinkingIntensity;     // from PR 1
  /** Current resolved model tier (for observability) */
  modelTier?: ModelTier;
  /** Recommended model ID based on current tier (for observability) */
  recommendedModelId?: string;
}
```

`projectState()` 新增：

```typescript
// Model routing projection (observability only)
const routingConfig = state.workflow?.modelRouting;
const modelTier = state.status === 'running'
  ? resolveModelTier(state.totalContinuations, state.evidence?.status, false, routingConfig)
  : undefined;

return {
  // ...existing...
  modelTier,
  recommendedModelId: modelTier ? resolveModelId(modelTier, routingConfig) : undefined,
};
```

#### 4.2.7 测试（新建 `tests/model-routing.test.ts`）

```typescript
/**
 * TDD: Written BEFORE implementation.
 * Tests model tier routing pure functions.
 */
import { describe, it, expect } from 'vitest';
import { resolveModelTier, resolveModelId, isSubagentSession } from '../src/model-routing';
import type { ModelRoutingConfig } from '../src/types';

const defaultConfig: ModelRoutingConfig = {
  defaultTier: 'standard',
  initialTurnTier: 'premium',
  validationTier: 'budget',
  subagentTier: 'budget',
  modelIds: {
    budget: 'deepseek-v4-pro',
    standard: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-8',
  },
};

describe('resolveModelTier', () => {
  it('returns initialTurnTier for first turns', () => {
    expect(resolveModelTier(0, undefined, false, defaultConfig)).toBe('premium');
    expect(resolveModelTier(1, undefined, false, defaultConfig)).toBe('premium');
  });

  it('returns defaultTier for implementation turns', () => {
    expect(resolveModelTier(5, undefined, false, defaultConfig)).toBe('standard');
  });

  it('returns validationTier when evidence is running', () => {
    expect(resolveModelTier(5, 'running', false, defaultConfig)).toBe('budget');
  });

  it('evidence running overrides initial turn', () => {
    expect(resolveModelTier(0, 'running', false, defaultConfig)).toBe('budget');
  });

  it('returns subagentTier for subagent sessions', () => {
    expect(resolveModelTier(5, undefined, true, defaultConfig)).toBe('budget');
  });

  it('subagent without explicit tier falls through to phase logic', () => {
    const noSubTier = { ...defaultConfig, subagentTier: undefined };
    expect(resolveModelTier(0, undefined, true, noSubTier)).toBe('premium');
    expect(resolveModelTier(5, undefined, true, noSubTier)).toBe('standard');
  });

  it('uses built-in defaults when no config provided', () => {
    expect(resolveModelTier(0, undefined, false)).toBe('premium');
    expect(resolveModelTier(5, undefined, false)).toBe('standard');
    expect(resolveModelTier(5, 'running', false)).toBe('standard');
  });
});

describe('resolveModelId', () => {
  it('returns model ID for configured tier', () => {
    expect(resolveModelId('premium', defaultConfig)).toBe('claude-opus-4-8');
    expect(resolveModelId('budget', defaultConfig)).toBe('deepseek-v4-pro');
  });

  it('returns undefined for unconfigured tier', () => {
    expect(resolveModelId('standard', { defaultTier: 'standard' })).toBeUndefined();
  });

  it('returns undefined when no config', () => {
    expect(resolveModelId('premium')).toBeUndefined();
  });
});

describe('isSubagentSession', () => {
  it('detects subagent session keys', () => {
    expect(isSubagentSession('agent:main:subagent:task-abc')).toBe(true);
    expect(isSubagentSession('agent:bot-1:subagent:review')).toBe(true);
  });

  it('rejects non-subagent session keys', () => {
    expect(isSubagentSession('agent:main')).toBe(false);
    expect(isSubagentSession('session:abc')).toBe(false);
    expect(isSubagentSession(undefined)).toBe(false);
  });
});
```

**Est. ~280 LOC**（含测试 ~100 LOC）。

---

## 5. Subagent 自动支持原理

**问：workflow 扇出的每个 subagent 是否也能自动获得思考强度和模型路由？**

**答：是，无需额外代码。** 原理如下：

### 5.1 执行路径统一

```
User prompt
  → OpenClaw Gateway
    → embedded-agent-runner.run()         ← 主 agent
      → resolveHookModelSelection()       ← 触发 before_model_resolve
      → agent 决定 spawn subagent
        → embedded-agent-runner.run()     ← subagent（同一函数，spawnedBy 参数）
          → resolveHookModelSelection()   ← 再次触发 before_model_resolve
```

源码证据：
- `openclaw/src/agents/embedded-agent-runner/run.ts:650` — `resolveHookModelSelection()` 在每次 `run()` 调用时执行
- `openclaw/src/agents/embedded-agent-runner/run.ts:1551` — subagent 通过 `spawnedBy` 参数进入同一路径
- `openclaw/src/plugins/hooks.ts:829` — `runBeforeModelResolve()` 遍历所有注册的 hook handler

### 5.2 区分机制

| sessionKey 格式 | 含义 | `isSubagentSession()` |
|-----------------|------|----------------------|
| `agent:main-bot` | 主 agent | `false` |
| `agent:main-bot:subagent:review-agent` | subagent | `true` |
| `agent:main-bot:subagent:screening-agent` | subagent | `true` |

源码证据：`openclaw/src/infra/state-migrations.ts:367-369`

```typescript
if (rawLower.startsWith("subagent:")) {
  const rest = raw.slice("subagent:".length);
  return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
}
```

### 5.3 effort injection 覆盖

`agent_turn_prepare` hook 对每个 agent turn 都会触发（包括 subagent turn）。autopilot 的 `agent_turn_prepare` handler 通过 `findRunBySession(sessionKey)` 查找关联的 autopilot run。对于 subagent，需要查找其父 session 的 run（通过 `extractParentSessionKey()`）。

### 5.4 配置示例

```yaml
# WORKFLOW.md — 差异化路由
autopilot:
  version: 1
  model_routing:
    default_tier: standard        # 实现阶段用 sonnet
    initial_turn_tier: premium    # 初始 turn 用 opus
    subagent_tier: budget         # workflow subagent 用 deepseek（便宜）
    model_ids:
      budget: deepseek-v4-pro
      standard: claude-sonnet-4-6
      premium: claude-opus-4-8
```

**效果**：
- 主 agent 初始 turn → `claude-opus-4-8`（深度分析任务目标）
- 主 agent 实现 turn → `claude-sonnet-4-6`（写代码）
- 主 agent 验证 turn → `claude-sonnet-4-6`（跑测试）
- subagent（所有）→ `deepseek-v4-pro`（screening/drafting 不需要 opus）

---

## 6. 与 Dynamic Workflows 的协同

### 6.1 .prose `model:` 字段 vs autopilot `before_model_resolve`

| 机制 | 来源 | 优先级 | 作用范围 |
|------|------|--------|---------|
| `.prose model: sonnet` | SKILL.md 中 AI 生成的 .prose 程序 | OpenProse 层面设置 | 单个 .prose agent 定义 |
| `before_model_resolve` modelOverride | autopilot 插件 hook | Gateway 层面覆盖 | 所有 agent run（含 subagent） |

**优先级关系**：`before_model_resolve` 的 `modelOverride` 在 Gateway 层生效，**后于** OpenProse 的 `model:` 设置。如果 autopilot 返回 `modelOverride`，它**覆盖** .prose 中的 `model:` 声明。

**设计选择**：如果 `modelRouting.modelIds` 未配置任何映射，`resolveModelId()` 返回 `undefined`，autopilot 不返回 `modelOverride`，.prose 的 `model:` 声明生效。这是正确的默认行为——不配模型路由 = 不干预。

### 6.2 思考强度对 .prose agent 的影响

.prose agent 是由 OpenProse VM spawn 的 subagent。autopilot 的 `agent_turn_prepare` 对这些 subagent 也注入 effort injection 文本。效果：

- 配置 `thinkingIntensity: 'medium'` → subagent 收到 "Use moderate effort" 指令
- 动态解析：subagent 不在验证阶段（无 evidence gate），不在初始 turn（subagent 的 totalContinuations 与主 session 独立）→ 用 configIntensity

---

## 7. YAGNI 清单

| OMC 功能 | 跳过理由 |
|----------|----------|
| `OMC_MODEL_HIGH/MEDIUM/LOW` 环境变量链 | omm 是打包插件，不是 dotfile CLI。用 plugin configSchema + WORKFLOW.md |
| `OMC_MODEL_ALIAS_*` tier 别名覆盖 | 只有 MatrixAssistant 一个消费者，configSchema 够用 |
| `forceInherit` 全局开关 | .prose `model:` 已可选，不配 modelIds = 继承 |
| per-agent definitions file | omm 没有 `src/agents/*.md` 概念，agent role 在 .prose 中定义 |
| `ultrathink` 魔术关键词检测 | 分级 effort injection 已覆盖 |
| `-high` 模型变体（`claude-sonnet-4-6-high`） | OMC 自己没完全接线；OpenClaw API 未公开此后缀 |
| escalation 关键词自动提升 tier | autopilot 已知 goal，用 totalContinuations/evidenceStatus 判断阶段，不做关键词推断 |
| per-subagent thinking intensity 配置 | subagent 用主 session 的动态解析即可，按需再加 |

---

## 8. 文件清单

| 文件 | 变更类型 | PR | 估算 LOC |
|------|----------|-----|----------|
| `src/types.ts` | 修改：新增 ThinkingIntensity, ModelTier, ModelRoutingConfig, config 字段 | PR 1 + 2 | ~30 |
| `src/effort-injection.ts` | 修改：3 级 buildEffortInjection + resolveThinkingIntensity | PR 1 | ~40 |
| `src/model-routing.ts` | **新建**：resolveModelTier, resolveModelId, isSubagentSession | PR 2 | ~80 |
| `src/projection.ts` | 修改：新增 thinkingIntensity, modelTier, recommendedModelId | PR 1 + 2 | ~15 |
| `src/workflow-config.ts` | 修改：knownKeys + model_routing 解析 | PR 2 | ~30 |
| `index.ts` | 修改：register() config 解析 + before_model_resolve hook + agent_turn_prepare 接线 | PR 1 + 2 | ~50 |
| `openclaw.plugin.json` | 修改：configSchema + hooks 列表 | PR 1 + 2 | ~25 |
| `tests/effort-injection.test.ts` | **新建** | PR 1 | ~70 |
| `tests/model-routing.test.ts` | **新建** | PR 2 | ~100 |
| **总计** | | | **~440** |

---

## 9. 验证计划

### 9.1 自动化验证

```bash
# 所有 633 现有测试必须通过（向后兼容保证）
pnpm --filter @oh-my-matrix/autopilot test

# 新增测试
pnpm --filter @oh-my-matrix/autopilot test -- --grep "effort-injection|model-routing"

# TypeScript 编译检查
pnpm --filter @oh-my-matrix/autopilot build
```

### 9.2 集成验证（手动）

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 配置 `thinkingIntensity: 'medium'` in plugin config | effort injection 文本从 "high effort" 变为 "moderate effort" |
| 2 | 运行 autopilot，观察初始 turn | 即使配置 'medium'，初始 turn 仍注入 "high effort"（resolveThinkingIntensity 覆盖） |
| 3 | 触发 evidence gate | effort injection 变为 "standard effort"（validation phase） |
| 4 | 配置 `modelRouting.modelIds.premium: "claude-opus-4-8"` | 初始 turn 的 before_model_resolve 返回 `{ modelOverride: "claude-opus-4-8" }` |
| 5 | 不配置 `modelIds` | before_model_resolve 不返回 modelOverride → 继承默认模型 |
| 6 | 启动 dynamic workflow（.prose 扇出多 subagent） | subagent session 的 before_model_resolve 使用 `subagentTier` 路由 |
| 7 | WORKFLOW.md 配置 model_routing | WORKFLOW.md 配置覆盖 plugin config |

### 9.3 同步到 MatrixAssistant

(internal host-deploy step, not in this repo)

---

## 10. 风险

| 风险 | 缓解 |
|------|------|
| before_model_resolve hook 对 subagent 的 ctx.sessionKey 格式变更 | `isSubagentSession()` 只检查 `:subagent:` 子串，对前缀/后缀格式不敏感 |
| modelOverride 覆盖 .prose 中的 model: 声明 | 不配 `modelIds` = 不覆盖（`resolveModelId` 返回 undefined）。这是正确的默认行为 |
| subagent 查找父 autopilot run 失败 | `findRunBySession` fallback 到 `extractParentSessionKey()`；失败则不路由（graceful degradation） |
| WORKFLOW.md parser 解析 model_routing 失败 | 未知字段只发 warning，不阻塞启动；model_routing 解析失败 fallback 到 plugin config |
| thinking intensity 动态解析逻辑错误导致验证阶段用 high effort | 测试覆盖 evidence running → low 路径；错误影响仅为性能（不影响正确性） |
