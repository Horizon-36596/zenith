#!/usr/bin/env node
// Determinism grep. `packages/core` and `packages/schema` are pure: no DOM, no clock, no
// randomness, no Node APIs. This script fails the build on any hit, per CLAUDE.md rule 1.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = ["packages/core/src", "packages/schema/src"];

// Two shapes: bare identifiers, which need a word boundary on both sides, and member accesses,
// which end in a dot and so must not carry a trailing boundary.
const identifiers = ["window", "document"];
const members = ["Math\\.random", "Date\\.now", "performance\\.now", "process\\."];
const pattern = new RegExp(
  "(?<![\\w$.])(?:(?:" + identifiers.join("|") + ")(?![\\w$])|(?:" + members.join("|") + "))",
);

/** A file whose name says it is a test is exempt. */
const isTestFile = (path) => /\.(test|spec)\.[cm]?tsx?$/.test(path);

/** A line that is only a comment is exempt, so prose may name the banned things. */
function isCommentOnly(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const hits = [];
for (const root of roots) {
  for (const file of walk(join(repoRoot, root), [])) {
    if (isTestFile(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isCommentOnly(line)) return;
      const match = pattern.exec(line);
      if (match) {
        const where = relative(repoRoot, file).split(sep).join("/");
        hits.push(`${where}:${i + 1}: ${match[0]} in ${line.trim()}`);
      }
    });
  }
}

if (hits.length > 0) {
  console.error("Purity check failed. packages/core and packages/schema must stay pure:");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("\nNo DOM, no clock, no randomness, no Node APIs there (CLAUDE.md rule 1).");
  process.exit(1);
}

console.log(`Purity check passed (${roots.join(", ")}).`);
