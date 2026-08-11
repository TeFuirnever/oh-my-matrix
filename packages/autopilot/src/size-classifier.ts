/**
 * T06 (ticket 04): task-size classifier — routes effort/model by task shape.
 *
 * The deterministic 3-signal design (files-touched × new-dep × design-ambiguity)
 * cannot be collected on the initial turn (files-touched unknown, the other two
 * need LLM judgment). This is the ponytail deterministic subset: signal words
 * + goal size + AC count (AC already parsed by acceptance-criteria.ts) → 4 tier.
 * It is intentionally conservative — only DOWNGRADES trivial tasks (saves
 * premium token on typo-class work); large detection is advisory and never
 * downgrades a task that might be complex.
 */
import { parseAcceptanceCriteria } from './acceptance-criteria';

export type TaskTier = 'trivial' | 'small' | 'standard' | 'large';

/** Large-scope signal words (EN + ZH) — presence suggests tier 'large'. */
const LARGE_SIGNALS: readonly string[] = [
  'refactor', 'migrate', 'migration', 'architecture', 'redesign', 'rewrite',
  'overhaul', 'cross-module', 'whole codebase', '重构', '迁移', '架构', '重写',
];
/** Trivial-task signal words — short goal + one of these ⇒ tier 'trivial'. */
const TRIVIAL_SIGNALS: readonly string[] = [
  'typo', 'rename', 'spelling', 'formatting', 'lint error', 'log statement',
  'comment', '改名', '拼写', '格式', '注释',
];

const TRIVIAL_MAX_CHARS = 80;
const SMALL_MAX_CHARS = 60; // short pure tasks only; medium goals default to standard

/**
 * Classify a goal into a task tier. Pure — no I/O.
 * - undefined/empty → 'standard' (safe default — no downgrade on missing data)
 * - short + trivial signal + no AC → 'trivial'
 * - ≥3 AC OR large signal → 'large'
 * - short + no AC + no large signal → 'small'
 * - else → 'standard'
 */
export function classifyTaskSize(goal: string | undefined): TaskTier {
  if (!goal) return 'standard';
  const text = goal.trim();
  if (!text) return 'standard';
  const lower = text.toLowerCase();
  const acCount = parseAcceptanceCriteria(goal).length;

  // Large: AC block with substance, OR explicit large-scope signal word.
  if (acCount >= 3) return 'large';
  if (LARGE_SIGNALS.some((s) => lower.includes(s))) return 'large';

  // Trivial: short + trivial signal + no AC. The conjunction is deliberate —
  // a short goal without a trivial signal may still be complex ("fix the race
  // condition"), so we don't downgrade on length alone.
  if (text.length <= TRIVIAL_MAX_CHARS && acCount === 0 && TRIVIAL_SIGNALS.some((s) => lower.includes(s))) {
    return 'trivial';
  }

  // Small: short, no AC, no large signal — but WITHOUT a trivial signal we
  // keep it 'small' not 'trivial' (medium effort, standard model).
  if (text.length <= SMALL_MAX_CHARS && acCount === 0) return 'small';

  return 'standard';
}
