/** Verifies an omm-suite tarball against its embedded manifest. Usage: node omm-scripts/omm-verify-bundle.mjs <path-to-tgz> */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestEntries, sha256File } from "./omm-shared.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedVersion = pkg.version;
const bundle = resolve(
  process.argv[2] ?? `omm-dist/omm-suite-${expectedVersion}.tgz`,
);
const bundleDir = dirname(bundle);
const bundleName = basename(bundle);
const temp = await mkdtemp(join(tmpdir(), "omm-bundle-"));

try {
  const extract = spawnSync("tar", ["-xzf", bundleName, "-C", temp], {
    cwd: bundleDir,
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(
      extract.stderr || extract.stdout || "tar extraction failed",
    );
  }

  const suiteRoot = join(temp, "omm-suite");
  const manifestPath = join(suiteRoot, "omm-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.name !== "omm-suite" ||
    manifest.version !== expectedVersion ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error("invalid omm manifest");
  }

  const actualEntries = await buildManifestEntries(suiteRoot);
  const actualByPath = new Map(
    actualEntries.map((entry) => [entry.path, entry]),
  );
  for (const entry of manifest.entries) {
    const actual = actualByPath.get(entry.path);
    if (!actual) {
      throw new Error(`missing manifest entry ${entry.path}`);
    }
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      throw new Error(`manifest mismatch for ${entry.path}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        bundle,
        sha256: await sha256File(bundle),
        entries: manifest.entries.length,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
