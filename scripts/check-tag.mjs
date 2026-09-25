#!/usr/bin/env node
// Fails unless a release tag matches the version in the root package.json: `v0.1.0` for "0.1.0".
// The release workflows run it first, so a tag pushed on the wrong commit builds nothing.
//
//   node scripts/check-tag.mjs <tag>        (in a workflow: node scripts/check-tag.mjs "$GITHUB_REF_NAME")
import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (tag === undefined || tag === "") {
  console.error("usage: node scripts/check-tag.mjs <tag>");
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (tag !== `v${String(version)}`) {
  console.error(`check-tag: the tag is ${tag}, but the root package.json says ${String(version)}; the tag must be v${String(version)}.`);
  process.exit(1);
}
console.log(`check-tag: ${tag} matches package.json ${String(version)}`);
