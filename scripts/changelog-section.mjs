#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, without its heading, for the GitHub Release notes.
// A section longer than GitHub takes for a release body is printed as a summary instead: its headings
// and each entry's lead (its bold title, or its first sentence), then a link to the whole section.
// Fails when the section is missing or empty, so a release never goes out with no notes, and when even
// the summary is too long, so a release never fails at its last step.
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
const result = notes.length <= RELEASE_BODY_LIMIT ? notes : summary(body);
if (result.length > RELEASE_BODY_LIMIT) {
  console.error(
    `changelog-section: the ${version} section of CHANGELOG.md is ${notes.length.toLocaleString("en-US")} characters, ` +
      `and its summary ${result.length.toLocaleString("en-US")}, over GitHub's limit of ` +
      `${RELEASE_BODY_LIMIT.toLocaleString("en-US")} for a release body. Shorten it before releasing.`,
  );
  process.exit(1);
}
process.stdout.write(result);

/**
 * The section cut to its headings and one line per top-level entry: the entry's bold title when it
 * opens with one, otherwise its first sentence. Nested entries and paragraphs are left to the link.
 */
function summary(text) {
  const out = [];
  let entry = null;
  const flush = () => {
    if (entry === null) return;
    const bold = /^\*\*.+?\*\*/.exec(entry);
    const sentence = /^.+?[.!?](?=\s|$)/.exec(entry);
    out.push(`- ${bold?.[0] ?? sentence?.[0] ?? entry}`);
    entry = null;
  };
  for (const line of text.split("\n")) {
    if (/^#{3,} /.test(line)) {
      flush();
      out.push("", line, "");
    } else if (line.startsWith("- ")) {
      flush();
      entry = line.slice(2).trim();
    } else if (entry !== null && /^ {2}\S/.test(line)) {
      entry += ` ${line.trim()}`;
    } else {
      flush();
    }
  }
  flush();
  const repository = process.env["GITHUB_REPOSITORY"] ?? "Horizon-36596/zenith";
  const link = `https://github.com/${repository}/blob/v${version}/CHANGELOG.md`;
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\nEvery change in full: [CHANGELOG.md](${link})\n`;
}
