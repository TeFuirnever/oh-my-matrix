import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const MCP_SOURCES = [
  join(ROOT, "omm-packages", "omm-mcp", "src", "index.ts"),
  join(ROOT, "omm-packages", "omm-mcp-memory", "src", "index.ts"),
  join(ROOT, "omm-packages", "omm-mcp-trace", "src", "index.ts"),
];

function isGeneratedBorder(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("/*") &&
    trimmed.endsWith("*/") &&
    trimmed.includes("\u2550")
  );
}

export function stripFailedGenerationArtifacts(source) {
  const lines = source.split("\n");
  const kept = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isGeneratedBorder(line) && lines[i + 1]?.includes("GENERATED")) {
      changed = true;
      i += 2;
      while (i < lines.length && !isGeneratedBorder(lines[i])) i++;
      continue;
    }

    if (line.trim() === "null") {
      changed = true;
      continue;
    }

    kept.push(line);
  }

  const cleaned = kept.join("\n").replace(/\n{4,}/g, "\n\n\n");
  return { cleaned, changed: changed || cleaned !== source };
}

export async function scanInlineSources({ write = false } = {}) {
  let ok = true;

  for (const path of MCP_SOURCES) {
    const source = await readFile(path, "utf8");
    const { cleaned, changed } = stripFailedGenerationArtifacts(source);

    if (!changed) {
      console.log(`[clean] ${path}`);
      continue;
    }

    if (write) {
      await writeFile(path, cleaned, "utf8");
      console.log(`[updated] ${path}`);
    } else {
      console.error(`[dirty] ${path}`);
      ok = false;
    }
  }

  return ok;
}
