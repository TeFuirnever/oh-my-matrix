/**
 * M2.5 Retry Queue
 *
 * Exponential backoff calculator and recoverable error classifier.
 * Pure functions — no side effects.
 */
import type { RetryEntry } from './types';

/**
 * E3: long-backoff multiplier for rate-limit / service-overload categories.
 * These deserve a longer wait than a generic transient (the server explicitly
 * asked us to slow down), so their base delay is scaled before the 2^(attempt-1)
 * curve and cap apply.
 */
const LONG_BACKOFF_MULTIPLIER = 4;

/** Default jitter fraction (±20%) applied to retry delays to de-synchronize
 * concurrent runs retrying the same upstream outage (P2-18). */
export const DEFAULT_RETRY_JITTER = 0.2;

/**
 * delay = min(base * 2^(attempt-1) [* tierMultiplier], maxRetryBackoffMs),
 * then honored against a server Retry-After, then jittered.
 *
 * `opts` defaults make this the historical deterministic function
 * (tier 'default', no jitter) so all pre-existing exact-value tests hold.
 * Production callers thread `{ jitter }` from WorkflowConfig.retryJitter.
 */
export function computeRetryDelay(
  attempt: number,
  maxRetryBackoffMs: number,
  opts?: {
    tier?: 'default' | 'long';
    jitter?: number;
    rng?: () => number;
    retryAfterMs?: number;
  },
): number {
  const base = 10000;
  const tierMultiplier = opts?.tier === 'long' ? LONG_BACKOFF_MULTIPLIER : 1;
  let delay = base * Math.pow(2, attempt - 1) * tierMultiplier;
  delay = Math.min(delay, maxRetryBackoffMs);

  // Respect a server-advertised Retry-After (rate-limit): never wait LESS than
  // the server asked, but still honour our own cap on the upper side.
  if (opts?.retryAfterMs != null && opts.retryAfterMs > delay) {
    delay = Math.min(opts.retryAfterMs, maxRetryBackoffMs);
  }

  // Jitter: spread ±jitter fraction around the delay so N runs hitting the same
  // 429 don't all retry on the same tick. Floor at the honored Retry-After (review
  // follow-up: jitter must never push the wait BELOW what the server asked) and
  // re-cap so we never exceed maxRetryBackoffMs.
  const jitter = opts?.jitter;
  if (jitter && jitter > 0) {
    const rng = opts.rng ?? Math.random;
    const delta = delay * jitter;
    const floor = opts?.retryAfterMs ?? 0;
    delay = delay - delta + 2 * delta * rng();
    delay = Math.min(Math.max(delay, floor), maxRetryBackoffMs);
  }
  return delay;
}

export interface RetryClassification {
  recoverable: boolean;
  category: string;
  /** 'long' for rate-limit / overload categories (scaled backoff). */
  backoffTier?: 'default' | 'long';
  /** Parsed Retry-After in seconds, when the server advertised one. */
  retryAfterSec?: number;
}

/**
 * E3: explicit classification table — structured fields first, anchored string
 * match as fallback.
 *
 * Pre-E3 this used unanchored `includes()` on the lowercased message, which
 * mis-classified in both directions: a path/message containing "timeout" was
 * auto-recoverable (network errno ETIMEDOUT is, a generic "process timeout" is
 * not), and anything containing "token" (e.g. a tokenizer error) hit the
 * budget branch. Now string matches are anchored to errno codes / status codes
 * wherever possible, and bare "timeout"/"token" substrings no longer trigger a
 * classification.
 *
 * Precedence is load-bearing: auth → rate → overload → network precede the
 * domain buckets so a 429 carrying the word "validation" still classifies as
 * rate-limit. permission precedes validation/injection (R-1/S1: a mixed
 * "permission validation_failed" string must stay non-recoverable).
 *
 * Unknown strings remain conservative: non-recoverable. The raw category
 * ('unknown') signals to diagnostics that no rule fired.
 */
export function classifyRecoverability(error: string): RetryClassification {
  const lower = error.toLowerCase();

  const status = extractHttpStatus(lower);
  const retryAfterSec = extractRetryAfter(lower);

  // 1. Auth (401/403) — needs a human, never auto-recoverable.
  if (status === 401 || status === 403 || hasTok(lower, 'unauthorized') || hasTok(lower, 'forbidden')) {
    return { recoverable: false, category: 'auth' };
  }

  // 2. Rate limit (429 / "rate limit") — recoverable, long backoff. Retry-After
  // is attached when present, but a bare Retry-After no longer TRIGGERS rate-limit
  // (review follow-up): otherwise a non-recoverable error that happens to carry a
  // Retry-After header — e.g. "permission denied (retry-after: 30)" — shadows the
  // permission bucket and loops. Retry-After in practice arrives with a 429, which
  // this status check already catches.
  if (status === 429 || hasTok(lower, 'rate[ _-]?limit')) {
    return { recoverable: true, category: 'rate_limit', backoffTier: 'long', retryAfterSec };
  }

  // 3. Service overload (529 / "overloaded") — recoverable, long backoff.
  if (status === 529 || hasTok(lower, 'overloaded')) {
    return { recoverable: true, category: 'overloaded', backoffTier: 'long' };
  }

  // 4. Network transient — anchored to errno codes / the canonical node message.
  if (isNetworkTransient(lower)) {
    return { recoverable: true, category: 'network' };
  }

  // 5. Context overflow (input) — recoverable ONCE (a compaction/retry can clear
  // it). Review follow-up: matched on context_length_exceeded ONLY. max_tokens is
  // the OUTPUT-length stop reason — retrying re-runs the same prompt against the
  // same output cap and burns tokens for nothing, and compaction does nothing for
  // an output cap. So max_tokens now falls through to 'unknown' (non-recoverable),
  // which terminates instead of looping.
  // NOTE (E3 known limitation): the spec's "exactly once" cap is NOT enforced
  // here — the classifier is stateless, so a run that keeps hitting context
  // overflow retries up to maxRetries like any transient. Enforcing "once" needs
  // cross-attempt state (remember the prior error's category + count); deferred.
  if (hasTok(lower, 'context_length_exceeded')) {
    return { recoverable: true, category: 'context_overflow' };
  }

  // 6. Permission — non-recoverable; must precede validation/injection (R-1/S1).
  if (hasTok(lower, 'permission')) {
    return { recoverable: false, category: 'permission' };
  }

  // 7. Generic transient / tool failure.
  if (hasTok(lower, 'transient') || hasPrefixTok(lower, 'tool[ _-]?fail')) {
    return { recoverable: true, category: 'transient_error' };
  }

  // 8. Stall (our own stall_timeout path passes 'stalled').
  if (hasPrefixTok(lower, 'stall')) {
    return { recoverable: true, category: 'stall' };
  }

  // 9. Validation — recoverable (re-run after fixing).
  if (hasTok(lower, 'validation')) {
    return { recoverable: true, category: 'validation' };
  }

  // 10. Injection rejection — recoverable (host may accept on retry).
  if (hasTok(lower, 'injection') || hasTok(lower, 'rejected')) {
    return { recoverable: true, category: 'injection_rejected' };
  }

  // 11. Workspace containment / creation — non-recoverable.
  if (hasTok(lower, 'containment') || hasTok(lower, 'workspace_create')) {
    return { recoverable: false, category: 'workspace' };
  }

  // 12. Config — anchored to start so "reconfiguration..." does not match.
  if (/^config/.test(lower)) {
    return { recoverable: false, category: 'config' };
  }

  // 13. Budget — the compound token_budget|budget. NOT bare 'token'
  // (E3: a tokenizer error must not land here).
  if (hasTok(lower, 'token[ _-]?budget') || hasTok(lower, 'budget')) {
    return { recoverable: false, category: 'budget' };
  }

  // 14. User stop / max retries — terminal.
  if (hasTok(lower, 'user[ _-]?stopped')) {
    return { recoverable: false, category: 'user_action' };
  }
  if (hasTok(lower, 'max[ _-]?retries')) {
    return { recoverable: false, category: 'max_retries' };
  }

  // 15. Unknown — conservative non-recoverable (was the pre-E3 default).
  return { recoverable: false, category: 'unknown' };
}

/**
 * Token match: `word` bounded by non-alphanumeric (or string edge) on BOTH sides.
 * Unlike `\b`, underscore counts as a boundary, so snake_case codes like
 * `validation_failed` / `token_budget_exceeded` split into tokens correctly.
 * `word` may itself contain a separator class (e.g. 'rate[ _-]?limit').
 */
function hasTok(lower: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${word}(?:[^a-z0-9]|$)`).test(lower);
}

/** Prefix token match: leading boundary only (for 'stalled', 'tool fail...'). */
function hasPrefixTok(lower: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${word}`).test(lower);
}

/** Extract the first HTTP status we care about (401/403/429/529) from a string.
 *  Boundaries exclude '/' (review follow-up) so a status embedded in a URL path
 *  or stack frame — 'GET /429/logs', 'at retry (429-frame)' — does not false-
 *  positive into rate-limit. Digits/hyphens still bound correctly: '4290' and
 *  'port 4290' do not match. */
function extractHttpStatus(lower: string): number | undefined {
  const m = lower.match(/(?:^|[^/\w])(401|403|429|529)(?:[^/\w]|$)/);
  return m ? Number(m[1]) : undefined;
}

/** Extract a Retry-After hint in seconds (header value or "retry after Ns" prose). */
function extractRetryAfter(lower: string): number | undefined {
  const m = lower.match(/retry[ _-]?after[:\s]+(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Network-layer errno codes + the canonical "socket hang up" message. Anchored. */
function isNetworkTransient(lower: string): boolean {
  const codes = ['econnreset', 'etimedout', 'epipe', 'eai_again', 'enetunreach', 'econnrefused', 'ehostunreach'];
  if (codes.some((c) => hasTok(lower, c))) return true;
  return hasTok(lower, 'socket[ _]?hang[ _]?up');
}

export interface ShouldRetryInput {
  attempt: number;
  maxRetries: number;
  recoverable: boolean;
}

/** Determine whether a retry should be attempted */
export function shouldRetry(input: ShouldRetryInput): boolean {
  if (!input.recoverable) return false;
  if (input.maxRetries <= 0) return false;
  return input.attempt <= input.maxRetries;
}

/**
 * Build a RetryEntry for the next retry attempt.
 *
 * E3: classification now drives the backoff tier (long for rate-limit/overload)
 * and an optional server Retry-After. `opts.jitter` (from WorkflowConfig) spreads
 * the delay; defaults to 0 so the function stays deterministic when unaided.
 */
export function buildRetryEntry(
  attempt: number,
  error: string,
  now: number,
  maxRetryBackoffMs: number,
  opts?: { jitter?: number; rng?: () => number },
): RetryEntry {
  const classification = classifyRecoverability(error);
  return {
    attempt,
    nextRetryAt: now + computeRetryDelay(attempt, maxRetryBackoffMs, {
      tier: classification.backoffTier,
      jitter: opts?.jitter,
      rng: opts?.rng,
      retryAfterMs: classification.retryAfterSec != null ? classification.retryAfterSec * 1000 : undefined,
    }),
    lastError: error,
    recoverable: classification.recoverable,
  };
}
