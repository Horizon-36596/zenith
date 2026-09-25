#!/usr/bin/env node
// Stamps the one Zenith version, the `version` of the root package.json, into every place that
// repeats it (PUBLISHING.md): every workspace package.json, the CLI's
// and the MCP server's version modules, the desktop installer names in its README, and the JitPack
// coordinate in the READMEs, PUBLISHING.md and the docs site, and the docs site footer in
// site/mkdocs.yml. Change the root version, run this,
// commit.
// `scripts/check-version.mjs`, part of `pnpm test`, fails when any of these places has drifted.
//
// The Java runtime needs no stamp: robot/auto-runtime/build.gradle reads the root package.json
// itself, and the check below makes sure it keeps doing so rather than carrying a literal.
//
// Usage: node scripts/stamp-version.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function rootVersion() {
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`The root package.json version ${JSON.stringify(version)} is not a semver version.`);
  }
  return version;
}

const workspaceManifests = () =>
  ["packages", "apps"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, dir, entry.name, "package.json")))
      .map((entry) => `${dir}/${entry.name}/package.json`),
  );

/**
 * A semver version inside a longer string. The pre-release part is lazy and every use is followed by
 * a lookahead, so a version at the end of a sentence or before `.pom` never swallows what follows.
 */
const SEMVER_PART = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*?)?";

/**
 * The user-facing Markdown that shows install coordinates: the READMEs (the public one included, which
 * the snapshot publishes as README.md), PUBLISHING.md and the docs site.
 */
function installDocs() {
  const found = ["README.md", "README.public.md", "PUBLISHING.md", "robot/README.md"].filter((path) => existsSync(join(repoRoot, path)));
  const walk = (dir) => {
    const full = join(repoRoot, dir);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && entry.name !== "changelog.md") found.push(path);
    }
  };
  walk("site/docs");
  return found;
}

const coordinate = new RegExp(`(Horizon-36596:zenith:v)${SEMVER_PART}(?=['"\`\\s)]|$)`, "gm");
const artifactUrl = new RegExp(`(Horizon-36596/zenith/v)${SEMVER_PART}(/zenith-v)${SEMVER_PART}(?=\\.(?:pom|aar|module)\\b)`, "g");

const versionModule = (what, version) =>
  `// Written by scripts/stamp-version.mjs from the root package.json; do not edit by hand.\n` +
  `/** The Zenith release this ${what} belongs to. */\n` +
  `export const VERSION = "${version}";\n`;

/**
 * Every stamped file, as the text it should hold at `version`, given the text it holds now (or
 * null when it does not exist yet). A target returns the current text unchanged when it is right.
 */
export function targets(version) {
  const list = workspaceManifests().map((path) => ({
    path,
    expected: (text) => {
      if (text === null) throw new Error(`${path} is missing.`);
      // Replace only the top-level "version" value, so key order and formatting stay as they are.
      const next = text.replace(/^(\s{2}"version":\s*")[^"]*(")/m, `$1${version}$2`);
      if (next === text && JSON.parse(text).version !== version) throw new Error(`${path} has no top-level "version".`);
      return next;
    },
  }));
  // The JitPack install coordinate and its artifact URL, wherever the user-facing docs show them.
  // Dated records (the ADRs, the changelogs) keep the version they were written about.
  for (const path of installDocs()) {
    list.push({
      path,
      expected: (text) =>
        (text ?? "").replace(coordinate, `$1${version}`).replace(artifactUrl, `$1${version}$2${version}`),
    });
  }
  list.push(
    { path: "packages/cli/src/version.ts", expected: () => versionModule("CLI", version) },
    { path: "packages/mcp/src/version.ts", expected: () => versionModule("MCP server", version) },
    {
      // The docs site's footer, which PUBLISHING.md step 12 reads back from the live site.
      path: "site/mkdocs.yml",
      expected: (text) => (text ?? "").replace(/^(copyright: "Zenith )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( ·)/m, `$1${version}$2`),
    },
    {
      path: "apps/desktop/README.md",
      expected: (text) => (text ?? "").replace(/Zenith-(Setup|Portable)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe/g, `Zenith-$1-${version}.exe`),
    },
  );
  return list;
}

/** Problems that stamping cannot fix, only a person: a hard-coded version where one is read. */
export function invariants() {
  const problems = [];
  const gradle = join(repoRoot, "robot", "auto-runtime", "build.gradle");
  if (existsSync(gradle)) {
    const text = readFileSync(gradle, "utf8");
    if (/^\s*version\s*=\s*['"]/m.test(text)) {
      problems.push("robot/auto-runtime/build.gradle sets a literal version; it must read the root package.json.");
    }
  }
  const cliIndex = readFileSync(join(repoRoot, "packages", "cli", "src", "index.ts"), "utf8");
  if (/\.version\(\s*["'`]/.test(cliIndex)) problems.push("packages/cli/src/index.ts passes a literal to .version(); use VERSION.");
  const server = readFileSync(join(repoRoot, "packages", "mcp", "src", "server.ts"), "utf8");
  if (/SERVER_VERSION\s*=\s*["'`]/.test(server)) problems.push("packages/mcp/src/server.ts sets a literal SERVER_VERSION; use VERSION.");
  return problems;
}

const read = (path) => {
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

/** The targets whose file differs from what `version` needs, with the text each should hold. */
export function drift(version = rootVersion()) {
  return targets(version)
    .map(({ path, expected }) => {
      const current = read(path);
      return { path, current, next: expected(current) };
    })
    .filter(({ current, next }) => current !== next);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const version = rootVersion();
  const changes = drift(version);
  for (const { path, next } of changes) {
    writeFileSync(join(repoRoot, path), next, "utf8");
    console.log(`stamped ${path}`);
  }
  console.log(`version ${version}: ${String(changes.length)} file(s) stamped.`);
  for (const problem of invariants()) console.error(`not stamped: ${problem}`);
  if (invariants().length > 0) process.exitCode = 1;
}
