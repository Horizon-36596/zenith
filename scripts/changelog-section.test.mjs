// Tests for scripts/changelog-section.mjs, which the release workflow runs to write the GitHub
// Release notes. Run by `pnpm test`.
//
//   node --test scripts/changelog-section.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./changelog-section.mjs", import.meta.url));

/** Runs the script on a changelog with the given text and returns its exit code and output. */
function section(version, text) {
  const dir = mkdtempSync(join(tmpdir(), "zenith-changelog-"));
  try {
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, text);
    const run = spawnSync(process.execPath, [script, version, file], { encoding: "utf8" });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const changelog = (body) => `# Changelog\n\n## [1.2.3] - 2026-10-20\n\n${body}\n\n## [1.2.2] - 2026-10-01\n\n- Older.\n`;

test("prints the section's body without its heading", () => {
  const run = section("v1.2.3", changelog("### Added\n\n- **A thing.** It works."));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "### Added\n\n- **A thing.** It works.\n");
});

test("fails when the version has no section", () => {
  const run = section("9.9.9", changelog("- Something."));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no "## \[9\.9\.9\]" section/);
});

test("takes a section of exactly GitHub's release body limit", () => {
  // The printed notes end in one newline, so a body one character short of the limit fills it.
  const body = `- ${"a".repeat(125_000 - 3)}`;
  const run = section("1.2.3", changelog(body));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.length, 125_000);
});

test("prints a summary with a link when the section is over GitHub's release body limit", () => {
  const long = "a".repeat(70_000);
  const body = [
    "### Added",
    "",
    `- **A thing.** ${long}`,
    "  More about it.",
    "  - A nested detail.",
    "",
    "#### Editor",
    "",
    `- Plain entry first. ${long}`,
  ].join("\n");
  const run = section("1.2.3", changelog(body));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stdout,
    "### Added\n\n- **A thing.**\n\n#### Editor\n\n- Plain entry first.\n\n" +
      "Every change in full: [CHANGELOG.md](https://github.com/Horizon-36596/zenith/blob/v1.2.3/CHANGELOG.md)\n",
  );
});

test("fails with the size when even the summary is over GitHub's release body limit", () => {
  const body = `- ${"a".repeat(125_000)}`;
  const run = section("1.2.3", changelog(body));
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /is 125,003 characters, and its summary [\d,]+, over GitHub's limit of 125,000 for a release body/);
});
