#!/usr/bin/env node
/**
 * Build-time code generator for MCP servers.
 *
 * Reads canonical source files from omm-plugin and injects them as inline
 * blocks into each MCP server's index.ts. This eliminates manual
 * duplication while preserving ADR-003's zero-dependency requirement.
 *
 * Usage: node omm-scripts/generate-mcp-inlines.mjs [--check]
 *
 * --check: Dry-run mode that verifies inline blocks are up-to-date without writing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(ROOT, "omm-packages", "omm-plugin", "src");

// Canonical source files to inline
const CANONICAL_FILES = {
  lock: join(PLUGIN_DIR, "omm-fs-queue.ts"),
  errors: join(PLUGIN_DIR, "omm-error-codes.ts"),
  guard: join(PLUGIN_DIR, "omm-workflow-guard.ts"),
  validation: join(PLUGIN_DIR, "omm-state-validation.ts"),
};

// MCP servers that need inlines
const MCP_SERVERS = [
  {
    name: "omm-state",
    src: join(ROOT, "omm-packages", "omm-mcp", "src", "index.ts"),
    output: join(ROOT, "omm-packages", "omm-mcp", "src", "index.ts"),
    needs: ["lock", "errors", "guard", "validation"],
  },
  {
    name: "omm-trace",
    src: join(ROOT, "omm-packages", "omm-mcp-trace", "src", "index.ts"),
    output: join(ROOT, "omm-packages", "omm-mcp-trace", "src", "index.ts"),
    needs: ["lock", "errors"],
  },
  {
    name: "omm-memory",
    src: join(ROOT, "omm-packages", "omm-mcp-memory", "src", "index.ts"),
    output: join(ROOT, "omm-packages", "omm-mcp-memory", "src", "index.ts"),
    needs: ["lock", "errors"],
  },
];

// Generation markers
const GEN_START = "/* ═════════════════════════════════════════════════════════ */";
const GEN_END = "/* ═════════════════════════════════════════════════════════ */";
const GEN_WARNING = "// ⚠️ GENERATED — do not edit directly. Run 'pnpm omm:generate-inlines' to regenerate.";

/**
 * Extract the inline block from canonical source files.
 */
async function extractInlineBlocks() {
  const lockSource = await readFile(CANONICAL_FILES.lock, "utf8");
  const errorsSource = await readFile(CANONICAL_FILES.errors, "utf8");
  const guardSource = await readFile(CANONICAL_FILES.guard, "utf8");
  const validationSource = await readFile(CANONICAL_FILES.validation, "utf8");

  // Extract from omm-fs-queue.ts
  const lockBlock = extractCanonicalBlock(lockSource, "withCrossProcessLock", "withKeyLock");
  const lockConstants = extractConstants(lockSource, "LOCK_", /(?:DEFAULT_|BASE_|POLL_|JITTER_)/);

  // Extract from omm-error-codes.ts
  const errorBlock = extractErrorBlock(errorsSource);

  // Extract from omm-workflow-guard.ts
  const guardBlock = extractGuardBlock(guardSource);

  // Extract from omm-state-validation.ts (partial for MCP)
  const validationBlock = extractValidationSubset(validationSource);

  return {
    lock: { code: lockBlock, constants: lockConstants },
    errors: errorBlock,
    guard: guardBlock,
    validation: validationBlock,
  };
}

/**
 * Extract a function and its dependencies from source code.
 */
function extractCanonicalBlock(source, targetFn, dependentFn) {
  const lines = source.split("\n");
  const targetIndex = lines.findIndex((l) => l.includes(`function ${targetFn}(`));
  if (targetIndex === -1) {
    return null;
  }

  const depIndex = lines.findIndex((l) => l.includes(`function ${dependentFn}(`));
  if (depIndex !== -1) {
    // Start from the dependency if it comes before the target
    const startIndex = Math.min(depIndex, targetIndex);
  } else {
    const startIndex = targetIndex;
  }

  // Find end of function (next top-level function or export)
  let endIndex = startIndex + 1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    // Stop at next function/export/blank line at same indentation level
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("async function") ||
      line.startsWith("const") ||
      line.startsWith("class") ||
      line === ""
    ) {
      const indentMatch = lines[startIndex].match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1] : "";
      const nextIndentMatch = line.match(/^(\s*)/);
      const nextIndent = nextIndentMatch ? nextIndentMatch[1] : "";

      // Only stop if we're at same or lower indentation
      if (nextIndent.length <= currentIndent.length) {
        endIndex = i;
        break;
      }
    }
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

/**
 * Extract constants matching a pattern from source.
 */
function extractConstants(source, prefix, pattern) {
  const lines = source.split("\n");
  const result = [];
  let inConsts = false;

  for (const line of lines) {
    if (line.includes(prefix) && pattern.test(line)) {
      inConsts = true;
    } else if (inConsts && !line.trim().startsWith(prefix)) {
      break;
    }
    if (inConsts) {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Extract OmmError class and error codes from error-codes.ts
 */
function extractErrorBlock(source) {
  const lines = source.split("\n");

  // Find OmmError class
  const classStart = lines.findIndex((l) => l.includes("class OmmError"));
  if (classStart === -1) {
    return null;
  }

  // Find export const OMM_ERROR_CODES
  const codesStart = lines.findIndex((l) => l.includes("export const OMM_ERROR_CODES"));
  if (codesStart === -1) {
    return null;
  }

  // Find isStructuredError function
  const fnStart = lines.findIndex((l) => l.includes("function isStructuredError("));
  if (fnStart === -1) {
    return null;
  }

  // Extract from class to function end
  let endIndex = classStart + 1;
  for (let i = classStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("const") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      const indentMatch = lines[classStart].match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1] : "";
      const nextIndentMatch = line.match(/^(\s*)/);
      const nextIndent = nextIndentMatch ? nextIndentMatch[1] : "";

      if (nextIndent.length <= currentIndent.length) {
        endIndex = i;
        break;
      }
    }
  }

  const classBlock = lines.slice(classStart, endIndex).join("\n");

  // Extract OMM_ERROR_CODES constant and isStructuredError
  let codesEnd = codesStart + 1;
  for (let i = codesStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      codesEnd = i;
      break;
    }
  }

  const codesBlock = lines.slice(codesStart, codesEnd).join("\n");

  let fnEnd = fnStart + 1;
  for (let i = fnStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      fnEnd = i;
      break;
    }
  }

  const fnBlock = lines.slice(fnStart, fnEnd).join("\n");

  return `${GEN_START}\n${GEN_WARNING}\n// OmmError and error codes (from omm-error-codes.ts)\n${classBlock}\n\n${codesBlock}\n\n${fnBlock}\n${GEN_END}\n`;
}

/**
 * Extract workflow guard functions from omm-workflow-guard.ts
 */
function extractGuardBlock(source) {
  const lines = source.split("\n");

  // Find detectWorkflowMode function
  const detectStart = lines.findIndex((l) => l.includes("function detectWorkflowMode("));
  if (detectStart === -1) {
    return null;
  }

  // Find isLinkedPair function
  const linkedStart = lines.findIndex((l) => l.includes("function isLinkedPair("));
  if (linkedStart === -1) {
    return null;
  }

  // Find assertWorkflowExclusivity function
  const assertStart = lines.findIndex((l) => l.includes("export async function assertWorkflowExclusivity("));
  if (assertStart === -1) {
    return null;
  }

  // Extract detectWorkflowMode
  let detectEnd = detectStart + 1;
  for (let i = detectStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      detectEnd = i;
      break;
    }
  }

  const detectBlock = lines.slice(detectStart, detectEnd).join("\n");

  // Extract isLinkedPair
  let linkedEnd = linkedStart + 1;
  for (let i = linkedStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      linkedEnd = i;
      break;
    }
  }

  const linkedBlock = lines.slice(linkedStart, linkedEnd).join("\n");

  // Extract assertWorkflowExclusivity (full function)
  let assertEnd = assertStart + 1;
  for (let i = assertStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith("export") ||
      line.startsWith("function") ||
      line.startsWith("type") ||
      line.startsWith("interface") ||
      line === ""
    ) {
      assertEnd = i;
      break;
    }
  }

  const assertBlock = lines.slice(assertStart, assertEnd).join("\n");

  return `${GEN_START}\n${GEN_WARNING}\n// Workflow exclusivity guard (from omm-workflow-guard.ts)\n${detectBlock}\n\n${linkedBlock}\n\n${assertBlock}\n${GEN_END}\n`;
}

/**
 * Extract validation subset for MCP servers (phase + terminal check only)
 */
function extractValidationSubset(source) {
  const lines = source.split("\n");

  // Find phase constants
  const ralphStart = lines.findIndex((l) => l.includes("const RALPH_PHASES"));
  const autopilotStart = lines.findIndex((l) => l.includes("const AUTOPILOT_PHASES"));
  const teamStart = lines.findIndex((l) => l.includes("const TEAM_PHASES"));

  // Find terminal phases
  const terminalStart = lines.findIndex((l) => l.includes("const TERMINAL_PHASES"));

  if (ralphStart === -1 || autopilotStart === -1 || teamStart === -1 || terminalStart === -1) {
    return null;
  }

  // Extract through normalizePhase
  const normalizeStart = lines.findIndex((l) => l.includes("function normalizePhase("));
  if (normalizeStart === -1) {
    return null;
  }

  let normalizeEnd = normalizeStart + 1;
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

  const normalizeBlock = lines.slice(normalizeStart, normalizeEnd).join("\n");

  // Extract validateTerminalRules
  const terminalFnStart = lines.findIndex((l) => l.includes("function validateTerminalRules("));
  if (terminalFnStart === -1) {
    return null;
  }

  let terminalFnEnd = terminalFnStart + 1;
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

  const terminalFnBlock = lines.slice(terminalFnStart, terminalFnEnd).join("\n");

  return `${GEN_START}\n${GEN_WARNING}\n// Validation subset for MCP (from omm-state-validation.ts)\n${lines.slice(ralphStart, normalizeStart).join("\n")}\n\n${normalizeBlock}\n\n${terminalFnBlock}\n${GEN_END}\n`;
}

/**
 * Generate the complete inline block for a given MCP server.
 */
function generateInlineBlock(server, blocks) {
  const parts = [];

  if (server.needs.includes("lock")) {
    parts.push(`\n${blocks.lock.code}\n`);
    parts.push(`\n${blocks.lock.constants}\n`);
  }

  if (server.needs.includes("errors")) {
    parts.push(`\n${blocks.errors}\n`);
  }

  if (server.needs.includes("guard")) {
    parts.push(`\n${blocks.guard}\n`);
  }

  if (server.needs.includes("validation")) {
    parts.push(`\n${blocks.validation}\n`);
  }

  return parts.join("\n");
}

/**
 * Find the insertion point in an MCP server's index.ts
 * (after the shebang, before the first inline block)
 */
function findInsertionPoint(source) {
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Find the start of existing inline code
    if (line.includes("/* ── Inline error codes")) {
      return i;
    }
    // Or find the import block before inline code
    if (line.startsWith("import {") && i > 5) {
      return i;
    }
  }

  return 0; // Default to beginning if no marker found
}

/**
 * Remove existing inline blocks from MCP server source
 */
function removeExistingInlineBlocks(source) {
  const lines = source.split("\n");
  const result = [];
  let inInlineBlock = false;

  for (const line of lines) {
    // Skip if we're in an existing generated block
    if (line.includes("/* ═══════════════════════════════════════════════════════════ */")) {
      inInlineBlock = true;
      continue;
    }
    if (inInlineBlock && line.includes("/* ═══════════════════════════════════════════════════════ */")) {
      inInlineBlock = false;
      continue;
    }
    if (!inInlineBlock) {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Update MCP server source with generated inline blocks.
 */
async function updateMcpServer(server) {
  const source = await readFile(server.src, "utf8");
  const blocks = await extractInlineBlocks();
  const inlineBlock = generateInlineBlock(server, blocks);

  const cleanedSource = removeExistingInlineBlocks(source);
  const insertionPoint = findInsertionPoint(cleanedSource);
  const lines = cleanedSource.split("\n");

  // Insert the new inline block
  lines.splice(insertionPoint, 0, inlineBlock);

  const newSource = lines.join("\n");

  if (process.argv.includes("--check")) {
    // Check mode: compare without writing
    const existingInline = extractExistingInlineBlock(source);
    if (JSON.stringify(existingInline) === JSON.stringify(inlineBlock)) {
      console.log(`[${server.name}] ✓ Inline blocks are up-to-date`);
      return true;
    } else {
      console.log(`[${server.name}] ✗ Inline blocks need regeneration`);
      console.log(`  Run 'pnpm omm:generate-inlines' to update`);
      return false;
    }
  }

  await writeFile(server.output, newSource, "utf8");
  console.log(`[${server.name}] Generated inline blocks`);
  return true;
}

/**
 * Extract existing inline block for comparison in check mode
 */
function extractExistingInlineBlock(source) {
  const lines = source.split("\n");
  const result = [];
  let inInlineBlock = false;

  for (const line of lines) {
    if (line.includes("/* ═════════════════════════════════════════════════════════ */")) {
      inInlineBlock = true;
      continue;
    }
    if (inInlineBlock && line.includes("/* ═══════════════════════════════════════════════════════ */")) {
      inInlineBlock = false;
      continue;
    }
    if (inInlineBlock) {
      result.push(line);
    }
  }

  return result.join("\n");
}

async function main() {
  const isCheck = process.argv.includes("--check");
  console.log(`Mode: ${isCheck ? "check (dry-run)" : "generate"}`);

  const blocks = await extractInlineBlocks();

  if (isCheck) {
    // Check mode: verify all servers are up-to-date
    let allUpToDate = true;
    for (const server of MCP_SERVERS) {
      const upToDate = await updateMcpServer(server);
      if (!upToDate) {
        allUpToDate = false;
      }
    }
    process.exit(allUpToDate ? 0 : 1);
  }

  // Generate mode: update all servers
  for (const server of MCP_SERVERS) {
    await updateMcpServer(server);
  }

  console.log("\n✓ All MCP servers updated with generated inline blocks");
  console.log("  Run 'pnpm tsc' to type-check generated code");
}

await main();
