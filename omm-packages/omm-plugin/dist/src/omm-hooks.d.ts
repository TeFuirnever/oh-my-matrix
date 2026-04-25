export interface OmmSessionRecord {
  event: "session_start" | "session_end";
  timestamp: string;
  sessionId?: string;
}
export declare function handleSessionStart(
  _args: Record<string, unknown>,
  config?: {
    stateRoot?: string;
  },
): void;
export declare function handleSessionEnd(
  _args: Record<string, unknown>,
  config?: {
    stateRoot?: string;
  },
): void;
