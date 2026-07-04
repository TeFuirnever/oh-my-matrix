/**
 * M2.5 Stall Detector
 *
 * Detects when an autopilot run has been inactive for too long.
 * Only checks stall while orchestrationState is 'running'.
 */
export interface StallCheckInput {
  orchestrationState: string;
  lastActivityAt?: number;
  now: number;
  stallTimeoutMs: number;
}

export interface StallResult {
  stalled: boolean;
  stallDurationMs?: number;
}

/**
 * Check if the run has stalled based on last activity time.
 * Considers stall when orchestrationState is 'running' (active turn) or 'claimed'
 * (M3: a claimed run that never receives a turn is a dead-end — detect it so the
 * stall_timeout event can transition it to retry_queued, rather than waiting for
 * the 24h orphan sweep).
 */
export function checkStall(input: StallCheckInput): StallResult {
  const { orchestrationState, lastActivityAt, now, stallTimeoutMs } = input;

  // Check stall for active states: 'running' (turn in progress) and 'claimed'
  // (waiting for a turn that may never come).
  if (orchestrationState !== 'running' && orchestrationState !== 'claimed') {
    return { stalled: false };
  }

  if (lastActivityAt == null) {
    return { stalled: false };
  }

  const elapsed = now - lastActivityAt;

  if (elapsed > stallTimeoutMs) {
    return {
      stalled: true,
      stallDurationMs: elapsed - stallTimeoutMs,
    };
  }

  return { stalled: false };
}

