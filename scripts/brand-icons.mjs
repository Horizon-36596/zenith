#!/usr/bin/env node
// Writes every Zenith icon from the one master, brand/zenith-mark.svg, and records what it wrote in
// brand/icons.json. scripts/check-brand.mjs (part of `pnpm test`) fails when any icon, or any page or
// build file that points at one, no longer matches that record.
//
//   node scripts/brand-icons.mjs
//
// Run it after changing the master, then commit the master, the icons and brand/icons.json together.
// Never edit an icon by hand: the next check fails, and the icon would drift from the logo again.
//
// SVG icons are byte-for-byte copies of the master, so they scale the way the logo does. The wordmarks
// are the master's Z, scaled to letter height, followed by "enith" (scripts/brand-svg.mjs). PNG and ICO
// icons are the master rendered at each size by Playwright's Chromium (a devDependency of apps/web;
// run `pnpm --filter @horizon36596/zenith-web exec playwright install chromium` once if it is missing).
// An ICO holds one PNG per size, which Windows and every current browser read.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wordmarkSvg } from "./brand-svg.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What gets written, and from what. Change the outputs here, never by hand. */
export const PLAN = {
  source: "brand/zenith-mark.svg",
  svg: ["apps/web/public/favicon.svg", "apps/desktop/resources/icon.svg", "site/docs/assets/zenith-mark.svg"],
  png: {
    "apps/web/public/favicon-16.png": 16,
    "apps/web/public/favicon-32.png": 32,
    "apps/web/public/apple-touch-icon.png": 180,
    "apps/desktop/resources/icon.png": 512,
  },
  ico: {
    "apps/web/public/favicon.ico": [16, 32, 48],
    "apps/desktop/resources/icon.ico": [16, 24, 32, 48, 64, 128, 256],
  },
  // The master's Z followed by these letters (scripts/brand-svg.mjs): in the master's colours with
  // light or dark letters, or all in one colour.
  wordmark: {
    letters: "brand/wordmark-letters.svg",
    outputs: {
      "apps/web/public/brand/zenith-wordmark-dark.svg": { letters: "#FAF6FB" },
      ".github/assets/wordmark-dark.svg": { letters: "#FAF6FB" },
      ".github/assets/wordmark-light.svg": { letters: "#17061D" },
      "brand/wordmark-mono-white.svg": { mono: "#FAF6FB" },
      "brand/wordmark-mono-night.svg": { mono: "#17061D" },
    },
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** An ICO file holding one PNG per size (the PNG-compressed form every Windows since Vista reads). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  const master = readFileSync(join(repo, PLAN.source));
  const files = {};
  const write = (path, bytes) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), bytes);
    files[path] = sha256(bytes);
    console.log(`brand-icons: wrote ${path}`);
  };

  for (const path of PLAN.svg) write(path, master);
  const letters = readFileSync(join(repo, PLAN.wordmark.letters), "utf8");
  for (const [path, fill] of Object.entries(PLAN.wordmark.outputs)) {
    write(path, Buffer.from(wordmarkSvg(master.toString("utf8"), letters, fill), "utf8"));
  }

  const require = createRequire(join(repo, "apps", "web", "package.json"));
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const dataUrl = `data:image/svg+xml;base64,${master.toString("base64")}`;
  const cache = new Map();
  const render = async (size) => {
    if (!cache.has(size)) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<html><body style="margin:0;background:transparent"><img src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`,
      );
      await page.waitForFunction(() => document.images[0]?.complete);
      cache.set(size, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    }
    return cache.get(size);
  };
  for (const [path, size] of Object.entries(PLAN.png)) write(path, await render(size));
  for (const [path, sizes] of Object.entries(PLAN.ico)) {
    const pngs = [];
    for (const size of sizes) pngs.push({ size, data: await render(size) });
    write(path, ico(pngs));
  }
  await browser.close();

  const manifest = {
    comment:
      "Written by scripts/brand-icons.mjs from the master. Checked by scripts/check-brand.mjs in pnpm test. Do not edit by hand.",
    source: PLAN.source,
    sourceSha256: sha256(master),
    svg: PLAN.svg,
    png: PLAN.png,
    ico: PLAN.ico,
    wordmark: { ...PLAN.wordmark, lettersSha256: sha256(Buffer.from(letters, "utf8")) },
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(join(repo, "brand", "icons.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("brand-icons: wrote brand/icons.json");
}

await main();
