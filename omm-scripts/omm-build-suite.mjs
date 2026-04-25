import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestEntries, sha256File } from "./omm-shared.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const version = "0.2.0";
const dist = join(root, "omm-dist");
const staging = join(dist, "omm-suite");
const outputName = `omm-suite-${version}.tgz`;
const output = join(dist, outputName);

async function copyRequiredFiles() {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
  await cp(join(root, "NOTICE"), join(staging, "NOTICE"));
  await cp(
    join(root, "THIRD_PARTY_NOTICES.md"),
    join(staging, "THIRD_PARTY_NOTICES.md"),
  );
  await cp(
    join(root, "omm-provenance.json"),
    join(staging, "omm-provenance.json"),
  );
  await cp(
    join(root, "omm-packages", "omm-plugin", "package.json"),
    join(staging, "omm-plugin", "package.json"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-plugin", "openclaw.plugin.json"),
    join(staging, "omm-plugin", "openclaw.plugin.json"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-plugin", "dist"),
    join(staging, "omm-plugin", "dist"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-skills", "omm-ping"),
    join(staging, "omm-skills", "omm-ping"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-skills", "omm-cancel"),
    join(staging, "omm-skills", "omm-cancel"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-skills", "omm-ralph"),
    join(staging, "omm-skills", "omm-ralph"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-skills", "omm-team"),
    join(staging, "omm-skills", "omm-team"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-skills", "omm-autopilot"),
    join(staging, "omm-skills", "omm-autopilot"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-mcp", "package.json"),
    join(staging, "omm-mcp", "package.json"),
    { recursive: true },
  );
  await cp(
    join(root, "omm-packages", "omm-mcp", "dist"),
    join(staging, "omm-mcp", "dist"),
    { recursive: true },
  );
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
