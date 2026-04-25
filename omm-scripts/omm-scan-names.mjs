import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectFiles, toPosixPath } from "./omm-shared.mjs";

const root = resolve(process.argv[2] ?? ".");
const blockedHashes = new Set([
  "a700b5e5ac5b7a6576545792162ad4d7170250f4f8dbe76ccacf8d2484b92fa4",
  "30ea747a84ae11090f9db880e2becade2209e5c384f001880e1de7067a7b00a6",
  "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
  "29c02aced85cb6d17c9098ac5eeb9072bb20f55b21f98ea94de50819f547e291",
  "b5cf43ae07a7364e0c0ca9e838f01f278fc6a71c207a6f8c3de8d908608b2db1",
]);
const ignoredPathParts = new Set([".git", "node_modules", "omm-dist"]);
const legalFiles = new Set([
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "omm-provenance.json",
]);
const textExtensions = new Set([
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".js",
  ".yaml",
  ".yml",
  ".toml",
]);

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeToken(token) {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldCheck(file) {
  const normalized = toPosixPath(file);
  if (
    [...ignoredPathParts].some(
      (part) =>
        normalized.includes(`/${part}/`) || normalized.endsWith(`/${part}`),
    )
  ) {
    return false;
  }
  const name = normalized.split("/").at(-1) ?? "";
  if (legalFiles.has(name)) {
    return false;
  }
  return [...textExtensions].some((ext) => normalized.endsWith(ext));
}

const failures = [];
for (const file of await collectFiles(root)) {
  if (!shouldCheck(file)) {
    continue;
  }
  const relativePath = toPosixPath(file).replace(`${toPosixPath(root)}/`, "");
  const pathTokens = relativePath
    .split(/[^A-Za-z0-9]+/)
    .map(normalizeToken)
    .filter(Boolean);
  const content = await readFile(file, "utf8");
  const contentTokens = content
    .split(/[^A-Za-z0-9]+/)
    .map(normalizeToken)
    .filter(Boolean);
  for (const token of [...pathTokens, ...contentTokens]) {
    if (blockedHashes.has(hashToken(token))) {
      failures.push(relativePath);
      break;
    }
  }
}

if (failures.length > 0) {
  console.error("omm naming scan failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("omm naming scan passed");
