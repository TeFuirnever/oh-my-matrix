#!/usr/bin/env node
/**
 * B6 (ticket 10): standalone .prose validator — the 5 checks from SKILL.md
 * Step 3, runnable WITHOUT OpenProse. Use when the host lacks the OpenProse
 * plugin, or in CI to gate a generated .prose before it runs.
 *
 * Usage:
 *   node scripts/validate-prose.mjs path/to/program.prose
 *   node scripts/validate-prose.mjs packages/dynamic-workflows/skill/templates/*.prose
 *
 * Exit 0 = all checks pass; exit 1 = one or more failures (listed on stderr).
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * The 5 manual-validation checks from SKILL.md Step 3, automated.
 * Exported for unit tests; the CLI wrapper below is the direct-run path.
 * Returns an array of error strings (empty = valid).
 */
export function validateProse(src) {
  const errors = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');

  const codeLines = lines
    .map((text, i) => ({ text, i, trimmed: text.trim() }))
    .filter((l) => l.trimmed && !l.trimmed.startsWith('#'));

  if (codeLines.length === 0) {
    errors.push('empty program (no non-comment lines)');
    return errors;
  }

  // ── Check 1: indentation is 2 spaces per level ─────────────────────────
  for (const { text, i } of codeLines) {
    const lead = text.match(/^( *)/)[1].length;
    if (lead % 2 !== 0) {
      errors.push(`L${i + 1}: odd indentation (${lead} spaces, expected multiple of 2)`);
    }
  }

  // ── Collect declarations (Array, not Set — duplicates matter for check 4) ─
  const agents = new Set();
  const blocks = new Set();
  const bindings = []; // {name, kind, i}
  for (const { trimmed, i } of codeLines) {
    let m;
    if ((m = trimmed.match(/^input\s+([\w-]+)\s*:/))) bindings.push({ name: m[1], kind: 'input', i });
    else if ((m = trimmed.match(/^let\s+([\w-]+)\s*=/))) bindings.push({ name: m[1], kind: 'let', i });
    else if ((m = trimmed.match(/^output\s+([\w-]+)\s*=/))) bindings.push({ name: m[1], kind: 'output', i });
    // parallel-branch binding: `name = session: agent` (no `let` prefix; lives
    // under a `parallel:` block). let/output are matched above, so this only
    // catches the branch form.
    else if ((m = trimmed.match(/^([\w-]+)\s*=\s*session\b/))) bindings.push({ name: m[1], kind: 'branch', i });
    else if ((m = trimmed.match(/^agent\s+([\w-]+)\s*:/))) agents.add(m[1]);
    else if ((m = trimmed.match(/^block\s+([\w-]+)\s*\(/))) blocks.add(m[1]);
  }
  const declared = new Set(bindings.map((b) => b.name));
  // block params are in-scope bindings: `block name(param1, param2):`
  for (const { trimmed } of codeLines) {
    const m = trimmed.match(/^block\s+[\w-]+\s*\(([^)]*)\)/);
    if (m) for (const p of m[1].split(',').map((s) => s.trim()).filter(Boolean)) declared.add(p);
  }
  // pipeline operators expose implicit loop vars (not declared anywhere).
  const IMPLICIT = new Set(['item', 'best', 'current', 'idx', 'index', 'acc']);

  // ── Check 4: variable names unique (input/let/output may not collide) ──
  const seen = new Map();
  for (const b of bindings) {
    if (seen.has(b.name)) errors.push(`L${b.i + 1}: duplicate binding '${b.name}' (${b.kind} vs ${seen.get(b.name)})`);
    else seen.set(b.name, b.kind);
  }

  // ── Check 2: every {variable} reference has a declaration ──────────────
  // .prose context refs allow whitespace + multiple names: { a, b }, {missing}
  for (const { trimmed, i } of codeLines) {
    for (const braceMatch of trimmed.matchAll(/\{([^}]*)\}/g)) {
      for (const raw of braceMatch[1].split(',')) {
        const name = raw.trim();
        if (/^[\w-]+$/.test(name) && !declared.has(name) && !IMPLICIT.has(name)) {
          errors.push(`L${i + 1}: reference '{${name}}' has no input/let/output declaration`);
        }
      }
    }
  }

  // ── Check 3: every `session: agentName` matches an `agent name:` block ─
  // session refs appear at line start OR inside `let x = session: agent`.
  for (const { trimmed, i } of codeLines) {
    for (const m of trimmed.matchAll(/session\s*(?:[\w-]+\s*)?:\s*([\w-]+)/g)) {
      const agentName = m[1];
      if (!agents.has(agentName) && !blocks.has(agentName)) {
        errors.push(`L${i + 1}: session references agent '${agentName}' with no \`agent ${agentName}:\` declaration`);
      }
    }
  }

  // ── Check 5: program ends with a synthesis session ─────────────────────
  let lastSession = null;
  for (let k = codeLines.length - 1; k >= 0; k--) {
    if (/^session\b/.test(codeLines[k].trimmed)) {
      lastSession = codeLines[k];
      break;
    }
  }
  const lastLine = codeLines[codeLines.length - 1].trimmed;
  const endsWithOutput = /^output\b/.test(lastLine);
  if (!lastSession && !endsWithOutput) {
    errors.push(`program has no session statement and does not end with output`);
  } else if (lastSession) {
    const sl = lastSession.trimmed;
    const isWorkerCall = /^session\s+[\w-]+\s*:/.test(sl) || /^session\s*:/.test(sl);
    if (isWorkerCall && !endsWithOutput) {
      errors.push(`L${lastSession.i + 1}: program's last session is a worker call (agent ref), not a synthesis`);
    }
  }

  return errors;
}

// ── CLI (direct-run only; tests import validateProse above) ──────────────
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: validate-prose.mjs <file.prose> [<file.prose> ...]');
    process.exit(2);
  }
  let totalErrors = 0;
  for (const file of files) {
    const errors = validateProse(readFileSync(file, 'utf-8'));
    if (errors.length === 0) console.log(`✓ ${file}`);
    else {
      console.error(`✗ ${file}`);
      for (const e of errors) console.error(`  ${e}`);
      totalErrors += errors.length;
    }
  }
  process.exit(totalErrors === 0 ? 0 : 1);
}
