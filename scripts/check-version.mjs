#!/usr/bin/env node
// Fails when any place that repeats the Zenith version disagrees with the root package.json
// (PUBLISHING.md). Part of `pnpm test`. The fix is always the same:
// `node scripts/stamp-version.mjs`, then commit what it changed.
import { drift, invariants, rootVersion } from "./stamp-version.mjs";

const version = rootVersion();
const changes = drift(version);
const problems = invariants();
for (const { path } of changes) console.error(`version drift: ${path} does not carry ${version}`);
for (const problem of problems) console.error(`version drift: ${problem}`);
if (changes.length > 0 || problems.length > 0) {
  console.error("Run node scripts/stamp-version.mjs and commit the result.");
  process.exitCode = 1;
} else {
  console.log(`version ${version}: every stamped file agrees.`);
}
