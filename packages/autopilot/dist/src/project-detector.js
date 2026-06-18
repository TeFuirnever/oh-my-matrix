"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectValidationCommands = detectValidationCommands;
/**
 * R-3: Project type auto-detection for Evidence Gate validation commands.
 *
 * Inspects the workspace root for known project files and returns
 * a default set of ValidationCommand entries appropriate for the project.
 * Returns empty array if no recognizable project type is found.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function exists(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return {};
    }
}
/**
 * Detect validation commands for the given workspace directory.
 * Checks for package.json (Node), go.mod (Go), Cargo.toml (Rust),
 * pyproject.toml / requirements.txt (Python).
 */
function detectValidationCommands(workspaceDir) {
    try {
        if (!fs.existsSync(workspaceDir))
            return [];
    }
    catch {
        return [];
    }
    const commands = [];
    // ── Node.js ──────────────────────────────────────────────────────────────
    const pkgPath = path.join(workspaceDir, 'package.json');
    if (exists(pkgPath)) {
        const pkg = readJsonSafe(pkgPath);
        const scripts = (pkg.scripts ?? {});
        const hasTestScript = typeof scripts.test === 'string';
        // Detect package manager.
        // The bare name (npm/pnpm/yarn) is emitted uniformly; command-runner's
        // conditional shell (X-15) resolves .cmd wrappers on Windows automatically.
        let pm = 'npm';
        if (exists(path.join(workspaceDir, 'pnpm-lock.yaml')))
            pm = 'pnpm';
        else if (exists(path.join(workspaceDir, 'yarn.lock')))
            pm = 'yarn';
        if (hasTestScript) {
            commands.push({
                id: 'node-test',
                command: `${pm} test`,
                timeoutMs: 120_000,
                required: true,
            });
        }
    }
    // ── Go ────────────────────────────────────────────────────────────────────
    if (exists(path.join(workspaceDir, 'go.mod'))) {
        commands.push({
            id: 'go-test',
            command: 'go test ./...',
            timeoutMs: 120_000,
            required: true,
        });
    }
    // ── Rust ─────────────────────────────────────────────────────────────────
    if (exists(path.join(workspaceDir, 'Cargo.toml'))) {
        commands.push({
            id: 'cargo-test',
            command: 'cargo test',
            timeoutMs: 180_000,
            required: true,
        });
    }
    // ── Python ───────────────────────────────────────────────────────────────
    const hasPyproject = exists(path.join(workspaceDir, 'pyproject.toml'));
    const hasRequirements = exists(path.join(workspaceDir, 'requirements.txt'));
    if (hasPyproject || hasRequirements) {
        commands.push({
            id: 'pytest',
            command: 'python -m pytest',
            timeoutMs: 120_000,
            required: false,
        });
    }
    return commands;
}
//# sourceMappingURL=project-detector.js.map