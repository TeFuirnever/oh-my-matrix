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
 * Only considers stall when orchestrationState is 'running'.
 */
export function checkStall(input: StallCheckInput): StallResult {
  const { orchestrationState, lastActivityAt, now, stallTimeoutMs } = input;

  // Only check stall while actively running
  if (orchestrationState !== 'running') {
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

