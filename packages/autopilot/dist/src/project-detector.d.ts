import type { ValidationCommand } from './types';
/**
 * Detect validation commands for the given workspace directory.
 * Checks for package.json (Node), go.mod (Go), Cargo.toml (Rust),
 * pyproject.toml / requirements.txt (Python).
 */
export declare function detectValidationCommands(workspaceDir: string): ValidationCommand[];
//# sourceMappingURL=project-detector.d.ts.map