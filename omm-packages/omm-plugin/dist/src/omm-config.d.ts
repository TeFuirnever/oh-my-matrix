export interface OmmConfig {
    stateRoot?: string;
}
/** Resolve the omm state directory, defaulting to ~/.openclaw/omm. */
export declare function resolveOmmStateRoot(configRoot?: unknown): string;
