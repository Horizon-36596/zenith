#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, without its heading, for the GitHub Release notes.
// Fails when the section is missing or empty, so a release never goes out with no notes.
//
//   node scripts/changelog-section.mjs <version> [file]      (version with or without the leading v)
import { readFileSync } from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (version === "") {
  console.error("usage: node scripts/changelog-section.mjs <version> [file]");
  process.exit(2);
}
const file = process.argv[3] ?? new URL("../CHANGELOG.md", import.meta.url);
const lines = readFileSync(file, "utf8").split(/\r?\n/);

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`changelog-section: CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}
let end = lines.findIndex((line, index) => index > start && (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join("\n").trim();
if (body === "") {
  console.error(`changelog-section: the ${version} section of CHANGELOG.md is empty.`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
