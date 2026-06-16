#!/usr/bin/env node
/**
 * Seed OpenClaw/MatrixAssistant MCP config with omm's three stdio MCP servers.
 *
 * Default mode is dry-run. Pass --write to modify the target file.
 * Targets ~/.openclaw/openclaw.json using the OpenClaw native mcp.servers format.
 */
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VALID_SCOPES = new Set(["user", "project", "local"]);
const VALID_LAYOUTS = new Set(["auto", "source", "suite"]);
const SHELL_METACHAR_REGEX = /[;|&$`><!(){}~*?\r\n\0#'"[\]]/;

const SERVER_DEFS = [
  { name: "omm-state", packageName: "omm-mcp" },
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sameJson(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function assertSafeArg(arg) {
  if (arg.includes("..")) {
    throw new Error(`arg must not contain path traversal: ${arg}`);
  }
  if (SHELL_METACHAR_REGEX.test(arg)) {
    throw new Error(`arg contains shell metacharacters: ${arg}`);
  }
}

function resolveServerBin(ommRoot, packageName, layout) {
  const sourcePath = join(
    ommRoot,
    "omm-packages",
    packageName,
    "dist",
    "src",
    "index.js",
  );
  const suitePath = join(ommRoot, packageName, "dist", "src", "index.js");

  if (layout === "source") return sourcePath;
  if (layout === "suite") return suitePath;

  return sourcePath;
}

async function resolveAutoLayout(ommRoot) {
  const sourceProbe = join(
    ommRoot,
    "omm-packages",
    "omm-mcp",
    "dist",
    "src",
    "index.js",
  );
  try {
    await access(sourceProbe, constants.F_OK);
    return "source";
  } catch {
    return "suite";
  }
}

export async function buildMcpServers({
  ommRoot = ROOT,
  layout = "auto",
  command = "node",
  stateRoot,
} = {}) {
  if (!VALID_LAYOUTS.has(layout)) {
    throw new Error(`unsupported layout: ${layout}`);
  }

  const resolvedRoot = resolve(ommRoot);
  const resolvedLayout =
    layout === "auto" ? await resolveAutoLayout(resolvedRoot) : layout;
  const env = stateRoot ? { OMM_STATE_ROOT: resolve(stateRoot) } : undefined;

  return Object.fromEntries(
    SERVER_DEFS.map((server) => {
      const entrypoint = resolveServerBin(
        resolvedRoot,
        server.packageName,
        resolvedLayout,
      );
      assertSafeArg(entrypoint);

      return [
        server.name,
        {
          command,
          args: [entrypoint],
          ...(env ? { env } : {}),
        },
      ];
    }),
  );
}

export function resolveSeedTargetPath({
  scope = "user",
  target,
  workspace,
} = {}) {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`unsupported scope: ${scope}`);
  }
  if (target) return resolve(target);

  if (scope === "user") {
    return join(homedir(), ".openclaw", "openclaw.json");
  }

  if (!workspace) {
    throw new Error(`--workspace is required for ${scope} scope`);
  }

  const workspaceRoot = resolve(workspace);
  if (scope === "project") {
    return join(workspaceRoot, ".matrixassistant", "mcp.json");
  }
  return join(workspaceRoot, ".mcp.local.json");
}

function selectServersKey(config) {
  const mcpBlock = config.mcp;
  if (isPlainObject(mcpBlock) && isPlainObject(mcpBlock.servers)) {
    return "mcp";
  }
  if (Object.hasOwn(config, "servers")) return "servers";
  return "mcpServers";
}

export function mergeMcpConfig(config, ommServers, { force = false } = {}) {
  if (!isPlainObject(config)) {
    throw new Error("target config must be a JSON object");
  }

  const key = selectServersKey(config);
  const isMcpNested = key === "mcp";
  const currentServers = isMcpNested
    ? (config.mcp?.servers ?? {})
    : (config[key] ?? {});
  if (!isPlainObject(currentServers)) {
    throw new Error(
      `${isMcpNested ? "mcp.servers" : key} must be a JSON object when present`,
    );
  }

  const next = { ...config };
  const updatedServers = { ...currentServers };
  const actions = [];
  const warnings = [];

  for (const [name, desired] of Object.entries(ommServers)) {
    const existing = updatedServers[name];

    if (existing === undefined) {
      updatedServers[name] = desired;
      actions.push({ name, action: "inserted" });
      continue;
    }

    if (sameJson(existing, desired)) {
      actions.push({ name, action: "unchanged" });
      continue;
    }

    if (force) {
      updatedServers[name] = desired;
      actions.push({ name, action: "overwritten" });
      continue;
    }

    warnings.push(
      `${name} already exists with custom values; leaving it unchanged. Use --force to overwrite.`,
    );
    actions.push({ name, action: "skipped-conflict" });
  }

  if (isMcpNested) {
    next.mcp = { ...config.mcp, servers: updatedServers };
  } else {
    next[key] = updatedServers;
  }

  return {
    config: next,
    key,
    actions,
    warnings,
    changed: actions.some(
      (item) => item.action === "inserted" || item.action === "overwritten",
    ),
  };
}

async function readJsonIfExists(path) {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      throw new Error("target config must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`target config contains invalid JSON: ${path}`);
    }
    throw error;
  }
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

async function verifyEntryFiles(ommServers) {
  for (const [name, server] of Object.entries(ommServers)) {
    const entrypoint = server.args?.[0];
    try {
      await access(entrypoint, constants.F_OK);
    } catch {
      throw new Error(
        `${name} entrypoint is missing: ${entrypoint}. Run pnpm build or pass --omm-root/--layout for an unpacked suite.`,
      );
    }
  }
}

export async function seedMatrixAssistantConfig(options = {}) {
  const scope = options.scope ?? "user";
  const targetPath = resolveSeedTargetPath({
    scope,
    target: options.target,
    workspace: options.workspace,
  });
  const ommServers = await buildMcpServers(options);

  if (options.verifyFiles !== false) {
    await verifyEntryFiles(ommServers);
  }

  const existing = await readJsonIfExists(targetPath);
  const merge = mergeMcpConfig(existing, ommServers, {
    force: options.force === true,
  });

  if (options.write === true && merge.changed) {
    await writeJsonAtomically(targetPath, merge.config);
  }

  return {
    scope,
    targetPath,
    mode: options.write === true ? "write" : "dry-run",
    key: merge.key,
    changed: merge.changed,
    actions: merge.actions,
    warnings: merge.warnings,
    config: merge.config,
  };
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    scope: "user",
    layout: "auto",
    command: "node",
    write: false,
    force: false,
    verifyFiles: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--scope") {
      options.scope = readValue(argv, i, arg);
      i++;
    } else if (arg === "--target") {
      options.target = readValue(argv, i, arg);
      i++;
    } else if (arg === "--workspace") {
      options.workspace = readValue(argv, i, arg);
      i++;
    } else if (arg === "--omm-root") {
      options.ommRoot = readValue(argv, i, arg);
      i++;
    } else if (arg === "--layout") {
      options.layout = readValue(argv, i, arg);
      i++;
    } else if (arg === "--state-root") {
      options.stateRoot = readValue(argv, i, arg);
      i++;
    } else if (arg === "--command") {
      options.command = readValue(argv, i, arg);
      i++;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--skip-file-check") {
      options.verifyFiles = false;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!VALID_SCOPES.has(options.scope)) {
    throw new Error(`--scope must be one of: ${[...VALID_SCOPES].join(", ")}`);
  }
  if (!VALID_LAYOUTS.has(options.layout)) {
    throw new Error(
      `--layout must be one of: ${[...VALID_LAYOUTS].join(", ")}`,
    );
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node omm-scripts/omm-ma-seed.mjs [options]

Options:
  --scope user|project|local      Target config scope (default: user)
                                   user scope writes to ~/.openclaw/openclaw.json
  --workspace <path>              Required for project/local unless --target is set
  --target <path>                 Override the exact JSON config path
  --omm-root <path>               OMM source checkout or unpacked omm-suite root
  --layout auto|source|suite      Server path layout (default: auto)
  --state-root <path>             Set OMM_STATE_ROOT in each server entry
  --command <path|node>           Node executable (default: node)
  --write                         Write changes; default is dry-run
  --force                         Overwrite existing omm-* entries
  --skip-file-check               Do not require built MCP entrypoints to exist
  --json                          Print machine-readable result
`);
}

function printResult(result) {
  console.log(`scope: ${result.scope}`);
  console.log(`target: ${result.targetPath}`);
  console.log(`mode: ${result.mode}`);
  console.log(`serversKey: ${result.key}`);
  for (const item of result.actions) {
    console.log(`${item.name}: ${item.action}`);
  }
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (result.mode === "dry-run" && result.changed) {
    console.log("dry-run only; rerun with --write to modify the target file.");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = await seedMatrixAssistantConfig(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
