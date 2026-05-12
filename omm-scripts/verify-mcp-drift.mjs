#!/usr/bin/env node
/**
 * CI drift detection for MCP inline code blocks.
 *
 * Compares generated inline blocks in MCP servers against canonical
 * source files from omm-plugin. Fails if drift is detected.
 *
 * Usage: node omm-scripts/verify-mcp-drift.mjs
 *
 * Exits with code 0 if no drift, 1 if drift detected.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(ROOT, "omm-packages", "omm-plugin", "src");

// Canonical source files
const CANONICAL_FILES = {
  lock: join(PLUGIN_DIR, "omm-fs-queue.ts"),
  errors: join(PLUGIN_DIR, "omm-error-codes.ts"),
  guard: join(PLUGIN_DIR, "omm-workflow-guard.ts"),
  validation: join(PLUGIN_DIR, "omm-state-validation.ts"),
};

// MCP servers to verify
const MCP_SERVERS = [
  {
    name: "omm-state",
    src: join(ROOT, "omm-packages", "omm-mcp", "src", "index.ts"),
    needs: ["lock", "errors", "guard", "validation"],
  },
  {
    name: "omm-trace",
    src: join(ROOT, "omm-packages", "omm-mcp-trace", "src", "index.ts"),
    needs: ["lock", "errors"],
  },
  {
    name: "omm-memory",
    src: join(ROOT, "omm-packages", "omm-mcp-memory", "src", "index.ts"),
    needs: ["lock", "errors"],
  },
];

const GEN_START = "/* ═════════════════════════════════════════════════════════ */";
const GEN_END = "/* ═════════════════════════════════════════════════════════════ */";

/**
 * Extract canonical inline block from source files.
 */
async function extractCanonicalBlocks() {
  const lockSource = await readFile(CANONICAL_FILES.lock, "utf8");
  const errorsSource = await readFile(CANONICAL_FILES.errors, "utf8");
  const guardSource = await readFile(CANONICAL_FILES.guard, "utf8");
  const validationSource = await readFile(CANONICAL_FILES.validation, "utf8");

  const canonicalBlocks = {
    lock: extractFromLockSource(lockSource),
    errors: extractErrorBlock(errorsSource),
    guard: extractGuardBlock(guardSource),
    validation: extractValidationSubset(validationSource),
  };

  return canonicalBlocks;
}

/**
 * Extract lock functions from omm-fs-queue.ts
 */
function extractFromLockSource(source) {
  const lines = source.split("\n");

  const lockFnStart = lines.findIndex((l) => l.includes("export async function withCrossProcessLock"));
  const keyLockFnStart = lines.findIndex((l) => l.includes("export function withKeyLock"));

  if (lockFnStart === -1 || keyLockFnStart === -1) {
    return null;
  }

  // Extract constants
  const constants = [];
  const constPatterns = [/LOCK_DEFAULT_TIMEOUT_MS/, /LOCK_DEFAULT_STALE_MS/, /LOCK_POLL_BASE_MS/, /LOCK_POLL_JITTER_MS/];

  for (const line of lines) {
    if (constPatterns.some((p) => p.test(line))) {
      constants.push(line);
    }
  }

  // Find withKeyLock end
  let keyLockEnd = keyLockFnStart + 1;
  for (let i = keyLockFnStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("const") ||
      line.startsWith("class") ||
      line === ""
    ) {
      keyLockEnd = i;
      break;
    }
  }

  // Find withCrossProcessLock end
  let lockFnEnd = lockFnStart + 1;
  for (let i = lockFnStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("const") ||
      line.startsWith("class") ||
      line === ""
    ) {
      lockFnEnd = i;
      break;
    }
  }

  const keyLockBlock = lines.slice(keyLockFnStart, keyLockEnd).join("\n");
  const lockBlock = lines.slice(lockFnStart, lockFnEnd).join("\n");

  return {
    constants: constants.join("\n"),
    keyLock: keyLockBlock,
    crossProcessLock: lockBlock,
  };
}

/**
 * Extract OmmError class and error codes
 */
function extractErrorBlock(source) {
  const lines = source.split("\n");

  const classStart = lines.findIndex((l) => l.includes("class OmmError"));
  const codesStart = lines.findIndex((l) => l.includes("export const OMM_ERROR_CODES"));
  const fnStart = lines.findIndex((l) => l.includes("function isStructuredError("));

  if (classStart === -1 || codesStart === -1 || fnStart === -1) {
    return null;
  }

  let endIndex = classStart + 1;
  for (let i = classStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(classStart, endIndex).join("\n");
}

/**
 * Extract workflow guard functions
 */
function extractGuardBlock(source) {
  const lines = source.split("\n");

  const detectStart = lines.findIndex((l) => l.includes("function detectWorkflowMode("));
  const linkedStart = lines.findIndex((l) => l.includes("function isLinkedPair("));
  const assertStart = lines.findIndex((l) => l.includes("export async function assertWorkflowExclusivity("));

  if (detectStart === -1 || linkedStart === -1 || assertStart === -1) {
    return null;
  }

  const functions = [detectStart, linkedStart, assertStart].sort((a, b) => a - b);

  const firstFn = functions[0];
  let firstFnEnd = firstFn + 1;
  for (let i = firstFn + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      firstFnEnd = i;
      break;
    }
  }

  return lines.slice(firstFn, firstFnEnd).join("\n");
}

/**
 * Extract validation subset
 */
function extractValidationSubset(source) {
  const lines = source.split("\n");

  const ralphStart = lines.findIndex((l) => l.includes("const RALPH_PHASES"));
  const terminalStart = lines.findIndex((l) => l.includes("const TERMINAL_PHASES"));
  const normalizeStart = lines.findIndex((l) => l.includes("function normalizePhase("));
  const terminalFnStart = lines.findIndex((l) => l.includes("function validateTerminalRules("));

  if (ralphStart === -1 || terminalStart === -1 || normalizeStart === -1 || terminalFnStart === -1) {
    return null;
  }

  const normalizeEnd = normalizeStart + 1;
  for (let i = normalizeStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      normalizeEnd = i;
      break;
    }
  }

  const terminalFnEnd = terminalFnStart + 1;
  for (let i = terminalFnStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      terminalFnEnd = i;
      break;
    }
  }

  return lines.slice(normalizeStart, normalizeEnd).join("\n") + "\n" + lines.slice(terminalFnStart, terminalFnEnd).join("\n");
}

/**
 * Extract generated inline block from MCP server
 */
function extractGeneratedInlineBlock(source) {
  const lines = source.split("\n");
  const result = [];
  let inInlineBlock = false;
  let collecting = false;

  for (const line of lines) {
    if (line.includes("/* ═════════════════════════════════════════════════════════════ */")) {
      inInlineBlock = true;
      collecting = true;
      result.push(line);
      continue;
    }
    if (inInlineBlock && line.includes("/* ═══════════════════════════════════════════════════════════════ */")) {
      inInlineBlock = false;
      collecting = false;
      result.push(line);
      continue;
    }
    if (collecting) {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Normalize code for comparison (ignore whitespace differences)
 */
function normalizeForComparison(code) {
  return code
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .replace(/\n\n+/g, "\n");
}

/**
 * Check for drift between canonical and generated code
 */
function checkDrift(canonical, generated, serverName, blockType) {
  const canonicalNormalized = normalizeForComparison(canonical);
  const generatedNormalized = normalizeForComparison(generated);

  if (canonicalNormalized === generatedNormalized) {
    return { ok: true };
  }

  // Find first differing line for error reporting
  const canonLines = canonicalNormalized.split("\n");
  const genLines = generatedNormalized.split("\n");

  let diffLine = 0;
  for (let i = 0; i < Math.max(canonLines.length, genLines.length); i++) {
    if (canonLines[i] !== genLines[i]) {
      diffLine = i + 1;
      break;
    }
  }

  return {
    ok: false,
    error: `Drift detected in ${serverName} for ${blockType} block at line ${diffLine}`,
  };
}

async function main() {
  console.log("Verifying MCP inline code blocks against canonical sources...\n");

  const canonical = await extractCanonicalBlocks();
  let hasDrift = false;

  for (const server of MCP_SERVERS) {
    const source = await readFile(server.src, "utf8");
    const generated = extractGeneratedInlineBlock(source);

    if (!generated) {
      console.log(`[${server.name}] ⚠️  No generated inline block found. Run 'pnpm omm:generate-inlines' first.`);
      hasDrift = true;
      continue;
    }

    for (const need of server.needs) {
      let canonicalBlock;
      let generatedBlock;
      let blockType;

      if (need === "lock") {
        canonicalBlock =
          canonical.lock.constants +
          "\n" +
          canonical.lock.keyLock +
          "\n" +
          canonical.lock.crossProcessLock;
        generatedBlock = generated;
        blockType = "cross-process lock";
      } else if (need === "errors") {
        canonicalBlock = canonical.errors;
        generatedBlock = generated;
        blockType = "error codes";
      } else if (need === "guard") {
        canonicalBlock = canonical.guard;
        generatedBlock = generated;
        blockType = "workflow exclusivity guard";
      } else if (need === "validation") {
        canonicalBlock = canonical.validation;
        generatedBlock = generated;
        blockType = "validation subset";
      }

      const result = checkDrift(canonicalBlock, generatedBlock, server.name, blockType);
      if (!result.ok) {
        console.log(`[${server.name}] ✗ ${result.error}`);
        hasDrift = true;
      } else {
        console.log(`[${server.name}] ✓ ${blockType} block is up-to-date`);
      }
    }
  }

  if (hasDrift) {
    console.log("\n❌ Drift detected. Run 'pnpm omm:generate-inlines' to regenerate.");
    process.exit(1);
  }

  console.log("\n✓ All MCP inline blocks are up-to-date");
  process.exit(0);
}

await main();
