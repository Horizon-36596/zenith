#!/usr/bin/env node
// Windows and macOS read file names without regard to case, and the desktop release is built on
// Windows. There, `import "./TimeRequests"` next to both `TimeRequests.tsx` and `timeRequests.ts`
// finds `timeRequests.ts` first (TypeScript and Vite try `.ts` before `.tsx`), so the build breaks or,
// worse, loads the wrong module. Linux, where CI and the agents run, never shows it. This check fails
// when two source modules in one folder differ only in case once their extension is dropped, or when
// any two files differ only in case.
//
//   node scripts/check-case.mjs [--root <dir>]
//
// It walks the folders on disk rather than asking git, so it also runs inside the public snapshot.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex === -1 ? resolve(dirname(fileURLToPath(import.meta.url)), "..") : resolve(args[rootIndex + 1]);

/** Folders that hold build output, dependencies or tool state, never sources. */
const SKIP = new Set([".git", "node_modules", "dist", "build", "release", "test-results", "playwright-report", ".gradle", ".venv", ".claude", ".vercel", "coverage"]);

/** The extensions a TypeScript or JavaScript import may leave off. */
const MODULE = /\.(d\.ts|tsx?|mts|cts|jsx?|mjs|cjs)$/i;

const problems = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const byName = new Map();
  const byModule = new Map();
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP.has(entry.name)) continue;
    const name = entry.name;
    const nameKey = name.toLowerCase();
    const sameName = byName.get(nameKey);
    if (sameName !== undefined && sameName !== name) problems.push(`${rel(dir)}: ${sameName} and ${name} differ only in case`);
    byName.set(nameKey, name);
    if (entry.isFile() && MODULE.test(name)) {
      const stem = name.replace(MODULE, "");
      const moduleKey = stem.toLowerCase();
      const sameModule = byModule.get(moduleKey);
      if (sameModule !== undefined && sameModule.stem !== stem) {
        problems.push(`${rel(dir)}: ${sameModule.name} and ${name} are the same module where case does not count ("./${stem}")`);
      }
      byModule.set(moduleKey, { stem, name });
    }
    if (entry.isDirectory()) walk(join(dir, name));
  }
}

function rel(dir) {
  const path = dir.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
  return path === "" ? "." : path;
}

walk(root);

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`);
  console.log(`check-case: ${String(problems.length)} name(s) that clash on Windows and macOS; rename one of each pair`);
  process.exit(1);
}
console.log("check-case: no two files or modules differ only in case");
