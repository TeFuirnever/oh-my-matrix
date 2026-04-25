/** Shared utilities for omm build scripts (hashing, file collection, manifest generation). */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export function toPosixPath(path) {
  return path.split(sep).join("/");
}

export async function collectFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function buildManifestEntries(root) {
  const files = await collectFiles(root);
  return Promise.all(
    files.map(async (file) => {
      const [fileStat, sha256] = await Promise.all([
        stat(file),
        sha256File(file),
      ]);
      return {
        path: toPosixPath(relative(root, file)),
        size: fileStat.size,
        sha256,
      };
    }),
  );
}
