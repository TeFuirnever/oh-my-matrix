export interface OmmSessionRecord {
  event: "session_start" | "session_end";
  timestamp: string;
  sessionId?: string;
}
/** Write a session_start record to omm state. */
export declare function handleSessionStart(
  _args: Record<string, unknown>,
  config?: {
    stateRoot?: string;
  },
): void;
/** Write a session_end record to omm state. Silently ignores errors. */
export declare function handleSessionEnd(
  _args: Record<string, unknown>,
  config?: {
    stateRoot?: string;
  },
): void;
