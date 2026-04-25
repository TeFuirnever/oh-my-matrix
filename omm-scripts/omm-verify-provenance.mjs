import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const provenance = JSON.parse(
  await readFile(new URL("../omm-provenance.json", import.meta.url), "utf8"),
);

if (
  provenance.version !== 1 ||
  !Array.isArray(provenance.entries) ||
  provenance.entries.length === 0
) {
  throw new Error("omm provenance is missing required entries");
}

for (const entry of provenance.entries) {
  for (const key of ["target", "source", "transform", "license", "note"]) {
    if (typeof entry[key] !== "string" || entry[key].trim() === "") {
      throw new Error(
        `omm provenance entry missing ${key}: ${JSON.stringify(entry)}`,
      );
    }
  }
}

console.log(`omm provenance verified at ${root}`);
