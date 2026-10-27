#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, without its heading, for the GitHub Release notes.
// Fails when the section is missing or empty, so a release never goes out with no notes, and when it
// is longer than GitHub takes for a release body, so a release never fails at its last step.
//
//   node scripts/changelog-section.mjs <version> [file]      (version with or without the leading v)
import { readFileSync } from "node:fs";

/** The most characters GitHub accepts in a release body. */
const RELEASE_BODY_LIMIT = 125_000;

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
const notes = `${body}\n`;
if (notes.length > RELEASE_BODY_LIMIT) {
  console.error(
    `changelog-section: the ${version} section of CHANGELOG.md is ${notes.length.toLocaleString("en-US")} characters, ` +
      `over GitHub's limit of ${RELEASE_BODY_LIMIT.toLocaleString("en-US")} for a release body. Shorten it before releasing.`,
  );
  process.exit(1);
}
process.stdout.write(notes);
