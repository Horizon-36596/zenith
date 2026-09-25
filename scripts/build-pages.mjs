#!/usr/bin/env node
// Builds the GitHub Pages artifact for libraries.horizon36596.org/zenith/: one folder holding
//
//   /zenith/                        the documentation site, `mkdocs build --strict` of site/
//   /zenith/app/                    the web editor, built with base /zenith/app/
//   /zenith/schema/v1/<kind>.json   the JSON Schemas from packages/schema/json/
//   /zenith/404.html                the page GitHub Pages serves for any missing path
//
// and then checks it: every `$id` (and every absolute `$ref`) in a served schema must resolve to a
// file in the artifact, and the app must address its assets from under /zenith/app/.
//
//   node scripts/build-pages.mjs [outDir]      (default: build/pages)
//
// Needs the workspace built first (`pnpm build`), Python with site/requirements.txt installed, and
// nothing else. docs-publish.yml runs exactly this.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(repo, "build", "pages"));

/** The site's public address, read from site/mkdocs.yml so the two can never disagree. */
const SITE_URL = readSiteUrl();
/** The path the site is served under, `/zenith/`. */
const SITE_PATH = new URL(SITE_URL).pathname;
const APP_BASE = `${SITE_PATH}app/`;

function readSiteUrl() {
  const text = readFileSync(join(repo, "site", "mkdocs.yml"), "utf8");
  const match = /^site_url:\s*(\S+)\s*$/m.exec(text);
  if (match === null) fail("site/mkdocs.yml has no site_url line.");
  return match[1].endsWith("/") ? match[1] : `${match[1]}/`;
}

function fail(message) {
  console.error(`build-pages: ${message}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  console.log(`build-pages: ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed (exit ${String(result.status)}).`);
}

function python() {
  for (const candidate of [process.env["PYTHON"], "python3", "python"]) {
    if (candidate === undefined || candidate === "") continue;
    const probe = spawnSync(candidate, ["-m", "mkdocs", "--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  fail("no Python with MkDocs found. Install it with: pip install -r site/requirements.txt");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The documentation site at the root. MkDocs empties its site dir, so it goes first.
run("docs site (mkdocs build --strict)", python(), [
  "-m",
  "mkdocs",
  "build",
  "--strict",
  "--config-file",
  join(repo, "site", "mkdocs.yml"),
  "--site-dir",
  out,
]);

// 2. The web editor under app/. Its own out dir, so apps/web/dist stays the desktop's `/` build.
const web = join(repo, "apps", "web");
const vite = join(web, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(vite)) fail("apps/web has no vite. Run `pnpm install` first.");
const appOut = join(out, "app");
run(`web app (vite build, base ${APP_BASE})`, process.execPath, [vite, "build", "--outDir", appOut, "--emptyOutDir", "--logLevel", "warn"], {
  cwd: web,
  env: { ...process.env, ZENITH_BASE: APP_BASE },
});

// 3. The JSON Schemas at schema/v1/<kind>.json.
const schemaSrc = join(repo, "packages", "schema", "json");
const schemaOut = join(out, "schema", "v1");
mkdirSync(schemaOut, { recursive: true });
const kinds = readdirSync(schemaSrc).filter((name) => name.endsWith(".json"));
if (kinds.length === 0) fail("packages/schema/json has no schemas. Run `pnpm build` first.");
for (const name of kinds) cpSync(join(schemaSrc, name), join(schemaOut, name));
console.log(`build-pages: schemas (${kinds.join(", ")})`);

// 4. A 404 page. Material writes one; this is the fallback if a theme change ever stops it.
const notFound = join(out, "404.html");
if (!existsSync(notFound)) {
  writeFileSync(
    notFound,
    [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8"><title>Not found - Zenith</title>',
      '<meta name="viewport" content="width=device-width, initial-scale=1"></head>',
      '<body style="font-family: system-ui, sans-serif; background: #17061d; color: #f7f2f8; padding: 3rem">',
      "<h1>Page not found</h1>",
      `<p><a style="color: #f5b94a" href="${SITE_PATH}">Zenith documentation</a> &middot; <a style="color: #f5b94a" href="${APP_BASE}">Open the editor</a></p>`,
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
}

// 5. Checks on what was built.
const problems = [];

for (const path of ["index.html", "404.html", "app/index.html"]) {
  if (!existsSync(join(out, path))) problems.push(`missing ${path}`);
}

/** The artifact file a URL on the site maps to, or null when the URL is not on the site. */
function fileFor(url) {
  if (!url.startsWith(SITE_URL)) return null;
  const rest = url.slice(SITE_URL.length).split("#")[0];
  return join(out, rest === "" ? "index.html" : rest);
}

function walk(node, visit, at = "") {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, visit, `${at}/${String(index)}`));
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value, `${at}/${key}`);
      walk(value, visit, `${at}/${key}`);
    }
  }
}

for (const name of kinds) {
  const served = join(schemaOut, name);
  const expected = `${SITE_URL}schema/v1/${name}`;
  let schema;
  try {
    schema = JSON.parse(readFileSync(served, "utf8"));
  } catch (error) {
    problems.push(`schema/v1/${name} is not JSON: ${String(error)}`);
    continue;
  }
  if (schema.$id !== expected) {
    problems.push(`schema/v1/${name}: $id is ${JSON.stringify(schema.$id)}, but the file is served at ${expected}`);
  }
  walk(schema, (key, value, at) => {
    if ((key !== "$id" && key !== "$ref") || typeof value !== "string" || !/^https?:/.test(value)) return;
    if (at === "/$id") return; // the top-level $id is checked above, against the file's own URL
    const file = fileFor(value);
    if (file === null) problems.push(`schema/v1/${name}${at}: ${value} is not on ${SITE_URL}`);
    else if (!existsSync(file)) problems.push(`schema/v1/${name}${at}: ${value} does not resolve to a file in the artifact`);
  });
}

// The app must reach every asset through its base. A root-relative /assets/, /fields/, /fonts/ or
// /brand/ reference would 404 on Pages.
const ROOTED = /["'(]\/(assets|fields|fonts|brand|favicon[^"')]*|apple-touch-icon[^"')]*)(?=[/"')])/g;
function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) scan(path);
    else if (/\.(html|css|js)$/.test(entry)) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(ROOTED)) {
        problems.push(`app/${relative(appOut, path).replaceAll("\\", "/")}: root-relative reference ${match[0].slice(1)}`);
      }
    }
  }
}
scan(appOut);
const appIndex = existsSync(join(appOut, "index.html")) ? readFileSync(join(appOut, "index.html"), "utf8") : "";
if (!appIndex.includes(`${APP_BASE}assets/`)) problems.push(`app/index.html does not load its scripts from ${APP_BASE}assets/`);

if (problems.length > 0) {
  console.error(`build-pages: the artifact at ${out} has ${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`build-pages: ready at ${out} (docs ${SITE_PATH}, app ${APP_BASE}, schemas ${SITE_PATH}schema/v1/)`);
