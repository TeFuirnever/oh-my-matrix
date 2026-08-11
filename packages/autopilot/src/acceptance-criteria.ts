/**
 * T05 (AC-NNN predicates): structured acceptance criteria carried INSIDE the
 * goal string.
 *
 * Rationale (ponytail): the goal string is already the only input channel,
 * already persisted through the checkpoint allowlist, and already survives
 * compaction via goalSnapshot. Embedding the AC block in the goal text means
 * zero state-schema change, zero persister change, and backward compatibility —
 * a goal without an AC block parses to an empty list and behaves as before.
 *
 * Goal format (ECC intent-driven, adapted):
 *
 *   Fix login button color
 *
 *   AC-001: Login button renders primary color
 *   - Scenario: logged-out user on /login
 *   - Action: open page
 *   - Expected: button background is the primary token
 *   - Must not: alter other button styles
 *   - Verification: vitest login-button.test.ts
 *   - Priority: required
 *
 * AC-NNN headers start at line start (`AC-001: title`); bullets are `- Field:`
 * lines that belong to the most recent AC header. Everything before the first
 * AC header is the free-text intent.
 */

export type AcPriority = 'required' | 'important' | 'optional';

export interface AcceptanceCriterion {
  id: string;
  title: string;
  scenario?: string;
  action?: string;
  expected?: string;
  mustNot?: string;
  verification?: string;
  priority?: AcPriority;
}

const AC_HEADER_RE = /^AC-(\d{3,})\s*[:：-]\s*(.*)$/i;
const AC_BULLET_RE = /^-\s*([A-Za-z][\w ]*?)\s*[:：]\s*(.*)$/;
const FIELD_ALIASES: Record<string, keyof AcceptanceCriterion> = {
  scenario: 'scenario',
  action: 'action',
  expected: 'expected',
  'must not': 'mustNot',
  'must-not': 'mustNot',
  mustnot: 'mustNot',
  verification: 'verification',
  'verification method': 'verification',
  priority: 'priority',
};
const PRIORITIES = new Set<AcPriority>(['required', 'important', 'optional']);

/**
 * Parse AC-NNN blocks out of a goal string. Pure — no I/O.
 * Returns [] when the goal carries no AC block (legacy free-text goal).
 */
export function parseAcceptanceCriteria(goal: string | undefined): AcceptanceCriterion[] {
  if (!goal) return [];
  const criteria: AcceptanceCriterion[] = [];
  let current: AcceptanceCriterion | null = null;

  for (const rawLine of goal.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = AC_HEADER_RE.exec(line);
    if (header) {
      current = {
        id: `AC-${header[1]}`,
        title: header[2].trim() || '(no title)',
      };
      criteria.push(current);
      continue;
    }

    if (!current) continue; // text before the first AC header is intent

    const bullet = AC_BULLET_RE.exec(line);
    if (!bullet) continue;
    const field = FIELD_ALIASES[bullet[1].trim().toLowerCase()];
    if (!field) continue;
    const value = bullet[2].trim();
    if (!value) continue;

    if (field === 'priority') {
      const p = value.toLowerCase();
      if (PRIORITIES.has(p as AcPriority)) current.priority = p as AcPriority;
    } else {
      current[field] = value;
    }
  }

  return criteria;
}

const MAX_INTENT_CHARS = 500;

/** Compact one-line-per-AC rendering for prompt injection. */
export function renderAcceptanceCriteria(criteria: AcceptanceCriterion[]): string {
  return criteria
    .map((ac) => {
      const prio = ac.priority ? ` (${ac.priority})` : '';
      const body = ac.expected || ac.title;
      const verify = ac.verification ? ` · verify: ${ac.verification}` : '';
      return `- ${ac.id}${prio}: ${body}${verify}`;
    })
    .join('\n');
}

/**
 * Full injection block for both prompt sites (index.ts agent_turn_prepare and
 * continuation-engine buildRetryInstruction). Returns '' when there is no goal.
 *
 *   [Autopilot] Current goal: <intent>
 *   [Autopilot] Acceptance criteria:
 *   - AC-001 (required): <expected> · verify: <verification>
 */
export function goalInjectionText(goal: string | undefined): string {
  if (!goal) return '';
  const criteria = parseAcceptanceCriteria(goal);
  if (criteria.length === 0) {
    return `[Autopilot] Current goal: ${goal.substring(0, MAX_INTENT_CHARS)}`;
  }
  const firstHeader = goal.search(/^AC-\d{3,}/m);
  const intent = (firstHeader > 0 ? goal.substring(0, firstHeader) : goal).trim();
  const parts = [
    `[Autopilot] Current goal: ${intent.substring(0, MAX_INTENT_CHARS) || '(acceptance-criteria-driven goal)'}`,
  ];
  parts.push('[Autopilot] Acceptance criteria:');
  parts.push(renderAcceptanceCriteria(criteria));
  return parts.join('\n');
}
