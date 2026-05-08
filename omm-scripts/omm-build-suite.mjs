/** Builds omm-suite tarball from compiled packages. Usage: pnpm omm:build-suite */
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestEntries, sha256File } from "./omm-shared.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const version = "0.4.2";
const dist = join(root, "omm-dist");
const staging = join(dist, "omm-suite");
const outputName = `omm-suite-${version}.tgz`;
const output = join(dist, outputName);

async function copyRequiredFiles() {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const pkg = (...p) => join(root, "omm-packages", ...p);
  await Promise.all([
    cp(join(root, "LICENSE"), join(staging, "LICENSE")),
    cp(join(root, "NOTICE"), join(staging, "NOTICE")),
    cp(
      join(root, "THIRD_PARTY_NOTICES.md"),
      join(staging, "THIRD_PARTY_NOTICES.md"),
    ),
    cp(join(root, "omm-provenance.json"), join(staging, "omm-provenance.json")),
    cp(
      pkg("omm-plugin", "package.json"),
      join(staging, "omm-plugin", "package.json"),
      { recursive: true },
    ),
    cp(
      pkg("omm-plugin", "openclaw.plugin.json"),
      join(staging, "omm-plugin", "openclaw.plugin.json"),
      { recursive: true },
    ),
    cp(pkg("omm-plugin", "dist"), join(staging, "omm-plugin", "dist"), {
      recursive: true,
    }),
    cp(pkg("omm-skills", "omm-ping"), join(staging, "omm-skills", "omm-ping"), {
      recursive: true,
    }),
    cp(
      pkg("omm-skills", "omm-cancel"),
      join(staging, "omm-skills", "omm-cancel"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ralph"),
      join(staging, "omm-skills", "omm-ralph"),
      { recursive: true },
    ),
    cp(pkg("omm-skills", "omm-team"), join(staging, "omm-skills", "omm-team"), {
      recursive: true,
    }),
    cp(
      pkg("omm-skills", "omm-autopilot"),
      join(staging, "omm-skills", "omm-autopilot"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "agent-prompts"),
      join(staging, "omm-skills", "agent-prompts"),
      { recursive: true },
    ),
    // Phase 4 skills
    cp(
      pkg("omm-skills", "omm-deep-interview"),
      join(staging, "omm-skills", "omm-deep-interview"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ralplan"),
      join(staging, "omm-skills", "omm-ralplan"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ultrawork"),
      join(staging, "omm-skills", "omm-ultrawork"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ultraqa"),
      join(staging, "omm-skills", "omm-ultraqa"),
      { recursive: true },
    ),
    // Skills accessible under plugin rootDir for OpenClaw discovery
    cp(
      pkg("omm-skills", "omm-ping"),
      join(staging, "omm-plugin", "skills", "omm-ping"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-cancel"),
      join(staging, "omm-plugin", "skills", "omm-cancel"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ralph"),
      join(staging, "omm-plugin", "skills", "omm-ralph"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-team"),
      join(staging, "omm-plugin", "skills", "omm-team"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-autopilot"),
      join(staging, "omm-plugin", "skills", "omm-autopilot"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-deep-interview"),
      join(staging, "omm-plugin", "skills", "omm-deep-interview"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ralplan"),
      join(staging, "omm-plugin", "skills", "omm-ralplan"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ultrawork"),
      join(staging, "omm-plugin", "skills", "omm-ultrawork"),
      { recursive: true },
    ),
    cp(
      pkg("omm-skills", "omm-ultraqa"),
      join(staging, "omm-plugin", "skills", "omm-ultraqa"),
      { recursive: true },
    ),
    cp(
      pkg("omm-mcp", "package.json"),
      join(staging, "omm-mcp", "package.json"),
      { recursive: true },
    ),
    cp(pkg("omm-mcp", "dist"), join(staging, "omm-mcp", "dist"), {
      recursive: true,
    }),
    cp(
      pkg("omm-mcp-memory", "package.json"),
      join(staging, "omm-mcp-memory", "package.json"),
      { recursive: true },
    ),
    cp(pkg("omm-mcp-memory", "dist"), join(staging, "omm-mcp-memory", "dist"), {
      recursive: true,
    }),
    cp(
      pkg("omm-mcp-trace", "package.json"),
      join(staging, "omm-mcp-trace", "package.json"),
      { recursive: true },
    ),
    cp(pkg("omm-mcp-trace", "dist"), join(staging, "omm-mcp-trace", "dist"), {
      recursive: true,
    }),
  ]);
}

async function writeManifest() {
  const entries = await buildManifestEntries(staging);
  const manifest = {
    name: "omm-suite",
    version,
    createdAt: new Date(0).toISOString(),
    entries,
  };
  await writeFile(
    join(staging, "omm-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function createTarball() {
  const result = spawnSync("tar", ["-czf", outputName, "omm-suite"], {
    cwd: dist,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "tar failed");
  }
}

await copyRequiredFiles();
await writeManifest();
createTarball();
console.log(
  JSON.stringify({ output, sha256: await sha256File(output) }, null, 2),
);
