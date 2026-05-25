#!/usr/bin/env node
/**
 * Seed OpenClaw config with omm's native plugin registration.
 *
 * Default mode is dry-run. Pass --write to modify ~/.openclaw/openclaw.json.
 */
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = "omm";
const VALID_LAYOUTS = new Set(["auto", "source", "suite"]);

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

function normalizePathForCompare(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePathValue(value, target) {
  return (
    typeof value === "string" &&
    normalizePathForCompare(value) === normalizePathForCompare(target)
  );
}

function resolvePluginDir(ommRoot, layout) {
  if (layout === "suite") return join(ommRoot, "omm-plugin");

  return join(ommRoot, "omm-dist", "omm-suite", "omm-plugin");
}

async function resolveAutoLayout(ommRoot) {
  const suiteProbe = join(ommRoot, "omm-plugin", "openclaw.plugin.json");
  try {
    await access(suiteProbe, constants.F_OK);
    return "suite";
  } catch {
    return "source";
  }
}

export async function buildOpenClawPluginInstall({
  ommRoot = ROOT,
  layout = "auto",
  stateRoot,
  promptsDir,
} = {}) {
  if (!VALID_LAYOUTS.has(layout)) {
    throw new Error(`unsupported layout: ${layout}`);
  }

  const resolvedRoot = resolve(ommRoot);
  const resolvedLayout =
    layout === "auto" ? await resolveAutoLayout(resolvedRoot) : layout;
  const pluginPath = resolvePluginDir(resolvedRoot, resolvedLayout);
  const config = { enabled: true };
  if (stateRoot) config.stateRoot = resolve(stateRoot);
  if (promptsDir) config.promptsDir = resolve(promptsDir);

  return {
    pluginId: PLUGIN_ID,
    layout: resolvedLayout,
    pluginPath,
    entry: {
      enabled: true,
      config,
    },
  };
}

export function resolveOpenClawSeedTargetPath({ target } = {}) {
  if (target) return resolve(target);
  return join(homedir(), ".openclaw", "openclaw.json");
}

function ensureObject(value, path) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a JSON object when present`);
  }
  return value;
}

function ensureArray(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be a JSON array when present`);
  }
  return value;
}

export function mergeOpenClawConfig(config, install, { force = false } = {}) {
  if (!isPlainObject(config)) {
    throw new Error("target config must be a JSON object");
  }

  const plugins = ensureObject(config.plugins, "plugins");
  const load = ensureObject(plugins.load, "plugins.load");
  const allow = ensureArray(plugins.allow, "plugins.allow");
  const paths = ensureArray(load.paths, "plugins.load.paths");
  const entries = ensureObject(plugins.entries, "plugins.entries");

  const nextAllow = [...allow];
  const nextPaths = [...paths];
  const nextEntries = { ...entries };
  const next = {
    ...config,
    plugins: {
      ...plugins,
      allow: nextAllow,
      load: { ...load, paths: nextPaths },
      entries: nextEntries,
    },
  };
  const actions = [];
  const warnings = [];

  if (nextAllow.includes(install.pluginId)) {
    actions.push({ target: "plugins.allow", action: "unchanged" });
  } else {
    nextAllow.push(install.pluginId);
    actions.push({ target: "plugins.allow", action: "inserted" });
  }

  if (nextPaths.some((path) => samePathValue(path, install.pluginPath))) {
    actions.push({ target: "plugins.load.paths", action: "unchanged" });
  } else {
    nextPaths.push(install.pluginPath);
    actions.push({ target: "plugins.load.paths", action: "inserted" });
  }

  const existingEntry = nextEntries[install.pluginId];
  if (existingEntry === undefined) {
    nextEntries[install.pluginId] = install.entry;
    actions.push({
      target: `plugins.entries.${install.pluginId}`,
      action: "inserted",
    });
  } else if (sameJson(existingEntry, install.entry)) {
    actions.push({
      target: `plugins.entries.${install.pluginId}`,
      action: "unchanged",
    });
  } else if (force) {
    nextEntries[install.pluginId] = install.entry;
    actions.push({
      target: `plugins.entries.${install.pluginId}`,
      action: "overwritten",
    });
  } else {
    warnings.push(
      `${install.pluginId} already exists with custom values; leaving it unchanged. Use --force to overwrite.`,
    );
    actions.push({
      target: `plugins.entries.${install.pluginId}`,
      action: "skipped-conflict",
    });
  }

  return {
    config: next,
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

async function verifyPath(path, message) {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

async function verifyOmmPluginFiles(install) {
  await verifyPath(
    join(install.pluginPath, "openclaw.plugin.json"),
    "omm plugin manifest is missing",
  );
  await verifyPath(
    join(install.pluginPath, "dist", "index.js"),
    "omm plugin entrypoint is missing. Run pnpm build or pass --omm-root for an unpacked suite",
  );
  await verifyPath(
    join(install.pluginPath, "skills"),
    "omm plugin skills directory is missing. Run pnpm build or pass --omm-root for an unpacked suite",
  );
}

export async function seedOpenClawConfig(options = {}) {
  const targetPath = resolveOpenClawSeedTargetPath({ target: options.target });
  const install = await buildOpenClawPluginInstall(options);

  if (options.verifyFiles !== false) {
    await verifyOmmPluginFiles(install);
  }

  const existing = await readJsonIfExists(targetPath);
  const merge = mergeOpenClawConfig(existing, install, {
    force: options.force === true,
  });

  if (options.write === true && merge.changed) {
    await writeJsonAtomically(targetPath, merge.config);
  }

  return {
    targetPath,
    mode: options.write === true ? "write" : "dry-run",
    layout: install.layout,
    pluginPath: install.pluginPath,
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
    layout: "auto",
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
    } else if (arg === "--target") {
      options.target = readValue(argv, i, arg);
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
    } else if (arg === "--prompts-dir") {
      options.promptsDir = readValue(argv, i, arg);
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

  if (!VALID_LAYOUTS.has(options.layout)) {
    throw new Error(
      `--layout must be one of: ${[...VALID_LAYOUTS].join(", ")}`,
    );
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node omm-scripts/omm-openclaw-seed.mjs [options]

Options:
  --target <path>                 Override the exact openclaw.json path
  --omm-root <path>               OMM source checkout or unpacked omm-suite root
  --layout auto|source|suite      Plugin path layout (default: auto)
  --state-root <path>             Set plugins.entries.omm.config.stateRoot
  --prompts-dir <path>            Set plugins.entries.omm.config.promptsDir
  --write                         Write changes; default is dry-run
  --force                         Overwrite existing plugins.entries.omm
  --skip-file-check               Do not require built plugin files to exist
  --json                          Print machine-readable result
`);
}

function printResult(result) {
  console.log(`target: ${result.targetPath}`);
  console.log(`mode: ${result.mode}`);
  console.log(`layout: ${result.layout}`);
  console.log(`pluginPath: ${result.pluginPath}`);
  for (const item of result.actions) {
    console.log(`${item.target}: ${item.action}`);
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

  const result = await seedOpenClawConfig(options);
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
