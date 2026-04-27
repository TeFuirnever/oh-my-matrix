/**
 * Stress test for the cross-process lock + omm-state.
 *
 * Spawns 4 child processes that all hammer the same state key:
 *   - 2 plugin-style writers using `omm-plugin` runOmmStateWrite directly.
 *   - 2 MCP-server writers driving omm-mcp over stdio JSON-RPC.
 *
 * Each writer issues 100 writes (`stress-key`) with a unique counter
 * payload. The driver collects per-write latency (hrtime) and reports
 * P50 + P99. Exit code 0 only if no lock errors occurred AND P99 < 200 ms.
 *
 * Why 200 ms (raised from 100 ms in 0.3.0-alpha.2): On Windows, racing
 * O_EXCL opens emit EPERM (not EEXIST) because the previous holder
 * still has the FD briefly open after writeFile/close — the retry loop
 * accepts both codes (see omm-fs-queue.ts) and waits ~50 ms ± 20 ms
 * jitter per attempt. With 4 concurrent writers the P99 includes 1-2
 * retry cycles (~70-160 ms on Windows). 200 ms gives ~1 retry of
 * headroom; still detects pathological contention but tolerates the
 * Windows kernel jitter exposed by the EPERM/EEXIST gap.
 *
 * Usage: node omm-scripts/omm-stress-cross-process.mjs
 *
 * Optional env:
 *   OMM_STRESS_ROOT       override stateRoot (default: mkdtemp)
 *   OMM_STRESS_WRITES     writes per child (default: 100)
 *   OMM_STRESS_VERBOSE=1  dump child stderr
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.env.OMM_STRESS_VERBOSE === "1";
const WRITES_PER_CHILD = Number(process.env.OMM_STRESS_WRITES ?? 100);
const KEY = "stress-key";
const P99_BUDGET_MS = 200;

const PLUGIN_WORKER = join(
  ROOT,
  "omm-scripts/omm-stress-cross-process-plugin-worker.mjs",
);
const MCP_BIN = join(ROOT, "omm-packages/omm-mcp/dist/src/index.js");

async function ensureWorkerScript() {
  const src = `\
import { runOmmStateWrite } from "${pathToImport(
    join(ROOT, "omm-packages/omm-plugin/dist/src/omm-tools/omm-state.js"),
  )}";

const writer = process.argv[2];
const count = Number(process.argv[3]);

async function main() {
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    const result = await runOmmStateWrite({
      key: "${KEY}",
      value: { mode: "ralph", active: false, current_phase: "complete", counter: i, writer },
    });
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    const text = result?.content?.[0]?.text ?? "";
    const ok = !text.startsWith("omm_state_write error");
    process.stdout.write(JSON.stringify({ writer, i, ms, ok, text: ok ? null : text }) + "\\n");
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ writer, fatal: String(err && err.message || err) }) + "\\n");
  process.exit(1);
});
`;
  await writeFile(PLUGIN_WORKER, src, "utf8");
}

function pathToImport(p) {
  // ESM imports require file:// URLs on Windows (E:/... is rejected as
  // "unsupported URL scheme"). Build a Node-compatible file URL.
  const normalized = p.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(normalized)
    ? `file:///${normalized}`
    : `file://${normalized}`;
}

class McpClient {
  constructor(stateRoot, label) {
    this.label = label;
    this.proc = spawn(process.execPath, [MCP_BIN], {
      env: { ...process.env, OMM_STATE_ROOT: stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    if (VERBOSE)
      this.proc.stderr.on("data", (d) =>
        process.stderr.write(`[${label}] ${d}`),
      );
    this.buffer = "";
    this.waiters = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      while (true) {
        const i = this.buffer.indexOf("\n");
        if (i === -1) break;
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.waiters.has(msg.id)) {
            const fn = this.waiters.get(msg.id);
            this.waiters.delete(msg.id);
            fn(msg);
          }
        } catch {
          /* notifications */
        }
      }
    });
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30000);
      this.waiters.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function runMcpWriter(stateRoot, label, count, samples) {
  const client = new McpClient(stateRoot, label);
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "omm-stress", version: "1.0.0" },
  });
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    const rsp = await client.send("tools/call", {
      name: "omm_state_write",
      arguments: {
        key: KEY,
        value: {
          mode: "ralph",
          active: false,
          current_phase: "complete",
          counter: i,
          writer: label,
        },
      },
    });
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    const ok = !rsp.error;
    samples.push({
      writer: label,
      i,
      ms,
      ok,
      error: rsp.error?.message ?? null,
    });
  }
  client.close();
}

function runPluginWriter(stateRoot, label, count, samples) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [PLUGIN_WORKER, label, String(count)],
      {
        env: { ...process.env, OMM_STATE_ROOT: stateRoot },
        stdio: ["ignore", "pipe", VERBOSE ? "inherit" : "pipe"],
      },
    );
    proc.stdout.setEncoding("utf8");
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const i = buffer.indexOf("\n");
        if (i === -1) break;
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.fatal) {
            samples.push({
              writer: label,
              i: -1,
              ms: 0,
              ok: false,
              error: msg.fatal,
            });
          } else {
            samples.push(msg);
          }
        } catch {
          /* skip noise */
        }
      }
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`plugin worker ${label} exited ${code}`));
    });
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

async function main() {
  const stateRoot =
    process.env.OMM_STRESS_ROOT ??
    (await mkdtemp(join(tmpdir(), "omm-stress-")));
  const cleanup = !process.env.OMM_STRESS_ROOT;
  console.log(`stateRoot: ${stateRoot}`);
  console.log(
    `writes per child: ${WRITES_PER_CHILD} (4 children, ${WRITES_PER_CHILD * 4} total)`,
  );

  await ensureWorkerScript();
  const samples = [];
  const t0 = Date.now();
  await Promise.all([
    runPluginWriter(stateRoot, "p1", WRITES_PER_CHILD, samples),
    runPluginWriter(stateRoot, "p2", WRITES_PER_CHILD, samples),
    runMcpWriter(stateRoot, "m1", WRITES_PER_CHILD, samples),
    runMcpWriter(stateRoot, "m2", WRITES_PER_CHILD, samples),
  ]);
  const wall = Date.now() - t0;

  const okSamples = samples.filter((s) => s.ok);
  const failed = samples.filter((s) => !s.ok);
  const latencies = okSamples.map((s) => s.ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p99 = percentile(latencies, 99);

  console.log(`\nresults:`);
  console.log(`  total writes attempted: ${samples.length}`);
  console.log(`  successful:            ${okSamples.length}`);
  console.log(`  failed (lock errors):  ${failed.length}`);
  console.log(`  wall time:             ${wall} ms`);
  console.log(`  P50 latency:           ${p50.toFixed(2)} ms`);
  console.log(`  P99 latency:           ${p99.toFixed(2)} ms`);
  if (failed.length > 0) {
    console.log(`\nfirst 5 failures:`);
    for (const f of failed.slice(0, 5)) {
      console.log(`  - ${f.writer} #${f.i}: ${f.error ?? f.text}`);
    }
  }

  // Sanity-check the listing path too.
  try {
    const stateDir = join(stateRoot, "state");
    const entries = await readdir(stateDir);
    if (!entries.includes(`${KEY}.json`)) {
      console.log(`\nERROR: ${KEY}.json missing from ${stateDir}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`\nERROR reading stateDir: ${err.message}`);
    process.exit(1);
  }

  if (cleanup) await rm(stateRoot, { recursive: true, force: true });
  await rm(PLUGIN_WORKER, { force: true });

  if (failed.length > 0) {
    console.log(`\nFAIL: ${failed.length} lock errors`);
    process.exit(1);
  }
  if (p99 >= P99_BUDGET_MS) {
    console.log(
      `\nFAIL: P99 ${p99.toFixed(2)} ms exceeds ${P99_BUDGET_MS} ms budget`,
    );
    process.exit(1);
  }
  console.log(
    `\nPASS: 0 lock errors, P99 ${p99.toFixed(2)} ms < ${P99_BUDGET_MS} ms`,
  );
}

await main();
