#!/usr/bin/env node
// Fails when any Zenith icon or wordmark no longer matches the master mark, brand/zenith-mark.svg.
// Part of `pnpm test`.
//
//   node scripts/check-brand.mjs [--root <dir>]
//
// It checks that:
//   1. the master and the wordmark letters are the ones brand/icons.json was generated from;
//   2. every generated file is still exactly what scripts/brand-icons.mjs wrote (SVG icons are
//      byte-for-byte copies of the master, wordmarks are rebuilt here and compared, PNG and ICO icons
//      have the recorded sizes and hashes);
//   3. the web page, the title bar, the docs site, the desktop build and the public README point only
//      at generated files;
//   4. no other favicon, app icon or Zenith wordmark exists under apps/, site/ or .github/.
//
// The fix for every failure is the same: change the master if the logo should change, then run
// `node scripts/brand-icons.mjs` and commit what it writes. Never edit an icon by hand.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wordmarkSvg } from "./brand-svg.mjs";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? resolve(args[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FIX = "Change brand/zenith-mark.svg if the logo should change, then run `node scripts/brand-icons.mjs`.";
const problems = [];
const problem = (text) => problems.push(text);
const read = (path) => readFileSync(join(root, path));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const manifest = JSON.parse(read("brand/icons.json").toString("utf8"));
const wordmarks = manifest.wordmark.outputs;
const generated = new Set([
  ...manifest.svg,
  ...Object.keys(manifest.png),
  ...Object.keys(manifest.ico),
  ...Object.keys(wordmarks),
]);

// 1. The sources.
const master = read(manifest.source);
if (sha256(master) !== manifest.sourceSha256) {
  problem(`${manifest.source} changed since the icons were generated. Run \`node scripts/brand-icons.mjs\`.`);
}
const letters = read(manifest.wordmark.letters);
if (sha256(letters) !== manifest.wordmark.lettersSha256) {
  problem(`${manifest.wordmark.letters} changed since the wordmarks were generated. Run \`node scripts/brand-icons.mjs\`.`);
}

// 2. The icons.
for (const path of generated) {
  if (!existsSync(join(root, path))) {
    problem(`${path} is missing. ${FIX}`);
    continue;
  }
  const bytes = read(path);
  if (sha256(bytes) !== manifest.files[path]) problem(`${path} is not the file brand-icons.mjs wrote. ${FIX}`);
  if (manifest.svg.includes(path) && !bytes.equals(master)) problem(`${path} is not a copy of ${manifest.source}. ${FIX}`);
  if (path in wordmarks) {
    const expected = wordmarkSvg(master.toString("utf8"), letters.toString("utf8"), wordmarks[path]);
    if (bytes.toString("utf8") !== expected) problem(`${path} is not the wordmark built from ${manifest.source}. ${FIX}`);
  }
  if (path in manifest.png) {
    const size = manifest.png[path];
    if (bytes.length < 24 || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
      problem(`${path} is not ${size}x${size}. ${FIX}`);
    }
  }
  if (path in manifest.ico) {
    const count = bytes.length >= 6 ? bytes.readUInt16LE(4) : 0;
    const sizes = [];
    for (let i = 0; i < count && 6 + i * 16 < bytes.length; i++) sizes.push(bytes[6 + i * 16] || 256);
    if (sizes.join(",") !== manifest.ico[path].join(",")) {
      problem(`${path} holds sizes ${sizes.join(", ") || "none"}, not ${manifest.ico[path].join(", ")}. ${FIX}`);
    }
  }
}

// 3. What points at the icons.
const mustBeGenerated = (from, target, what) => {
  if (!generated.has(target)) problem(`${from}: ${what} points at ${target}, which is not a generated icon. ${FIX}`);
};

if (existsSync(join(root, "apps/web/index.html"))) {
  const html = read("apps/web/index.html").toString("utf8");
  const links = [...html.matchAll(/<link\b[^>]*\brel="([^"]*icon[^"]*)"[^>]*>/gi)];
  if (links.length === 0) problem("apps/web/index.html links no icon.");
  for (const [tag, rel] of links) {
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1] ?? "";
    mustBeGenerated("apps/web/index.html", `apps/web/public/${href.replace(/^\.?\//, "")}`, `<link rel="${rel}">`);
  }
}

if (existsSync(join(root, "site/mkdocs.yml"))) {
  const yml = read("site/mkdocs.yml").toString("utf8");
  for (const key of ["logo", "favicon"]) {
    const value = new RegExp(`^\\s+${key}:\\s*(\\S+)`, "m").exec(yml)?.[1];
    if (value === undefined) problem(`site/mkdocs.yml sets no theme ${key}; it must be the Zenith mark.`);
    else mustBeGenerated("site/mkdocs.yml", `site/docs/${value}`, `theme ${key}`);
  }
}

if (existsSync(join(root, "apps/desktop/electron-builder.yml"))) {
  const yml = read("apps/desktop/electron-builder.yml").toString("utf8");
  for (const [, value] of yml.matchAll(/^\s*icon:\s*(\S+)/gm)) {
    mustBeGenerated("apps/desktop/electron-builder.yml", `apps/desktop/${value}`, "icon");
  }
}

// The title bar's image, and the public README's.
const SKIP = new Set(["node_modules", "dist", "build", "release", "test-results", "playwright-report", ".vite"]);
function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(relative(root, full).split("\\").join("/"));
  }
}
// Horizon's own wordmark is the team's file, used as supplied, so it is the one brand image that is not
// generated.
const TEAM = "apps/web/public/brand/horizon-wordmark-white.svg";
walk(join(root, "apps/web/src"), (path) => {
  if (!/\.(tsx?|css)$/.test(path)) return;
  for (const [, name] of read(path).toString("utf8").matchAll(/\bbrand\/([\w.-]+\.svg)/g)) {
    const target = `apps/web/public/brand/${name}`;
    if (target !== TEAM) mustBeGenerated(path, target, "an image");
  }
});
// The public README: `README.public.md` here, which the public snapshot publishes as `README.md`.
const publicReadme = existsSync(join(root, "README.public.md")) ? "README.public.md" : "README.md";
if (existsSync(join(root, publicReadme))) {
  const readme = read(publicReadme).toString("utf8");
  for (const [, target] of readme.matchAll(/(?<![\w/])(\.github\/assets\/[\w.-]+\.svg)/g)) {
    mustBeGenerated(publicReadme, target, "an image");
  }
}

// 4. Stray icons and wordmarks.
const ICON = /^(favicon[^/]*|apple-touch-icon[^/]*|icon\.(ico|png|svg|icns)|[^/]*-mark\.svg|(zenith-)?wordmark[^/]*)$/i;
const stray = (path) => {
  if (ICON.test(path.slice(path.lastIndexOf("/") + 1)) && !generated.has(path)) {
    problem(`${path} is an icon that brand-icons.mjs did not write. Delete it, or add it to scripts/brand-icons.mjs.`);
  }
};
walk(join(root, "apps"), stray);
walk(join(root, "site"), stray);
walk(join(root, ".github"), stray);

if (problems.length > 0) {
  for (const text of problems) console.error(`FAIL ${text}`);
  console.error(`brand: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`brand: every icon matches ${manifest.source} (${generated.size} files)`);
