/**
 * The Zenith mark has one master, brand/zenith-mark.svg, and every favicon, app icon, docs icon and
 * wordmark is generated from it by scripts/brand-icons.mjs. scripts/check-brand.mjs (run by
 * `pnpm test`) is what stops them drifting apart again: the web favicon was once a different drawing
 * from the logo, the title-bar wordmark had a redrawn Z, and the docs site used another team mark. These tests run that check against a copy of the
 * files and break it in each of those ways.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const check = join(repo, "scripts", "check-brand.mjs");

interface Manifest {
  source: string;
  wordmark: { letters: string };
  files: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(repo, "brand", "icons.json"), "utf8")) as Manifest;

/**
 * The public README: `README.public.md` in this repository, published as `README.md` by the public
 * snapshot, where this test also runs.
 */
const PUBLIC_README = existsSync(join(repo, "README.public.md")) ? "README.public.md" : "README.md";

/** The files the check reads besides the icons themselves. */
const REFERENCES = [
  "apps/web/index.html",
  "site/mkdocs.yml",
  "apps/desktop/electron-builder.yml",
  "apps/web/src/panels/Toolbar.tsx",
  "apps/web/public/brand/horizon-wordmark-white.svg",
  PUBLIC_README,
];
const WORDMARK = "apps/web/public/brand/zenith-wordmark-dark.svg";

function runCheck(root: string): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [check, "--root", root], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("check-brand", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zenith-brand-"));
    const paths = ["brand/icons.json", manifest.source, manifest.wordmark.letters, ...Object.keys(manifest.files), ...REFERENCES];
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repo, path), join(root, path));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes on the repository itself", () => {
    const result = runCheck(repo);
    expect(result.output).toContain("brand: every icon matches");
    expect(result.code).toBe(0);
  });

  it("passes on an untouched copy", () => {
    expect(runCheck(root).code).toBe(0);
  });

  it("fails when the web favicon is a different drawing from the master", () => {
    writeFileSync(join(root, "apps/web/public/favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("apps/web/public/favicon.svg");
  });

  it("fails when the master changes and the icons are not regenerated", () => {
    writeFileSync(join(root, manifest.source), `${readFileSync(join(root, manifest.source), "utf8")}\n`);
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("node scripts/brand-icons.mjs");
  });

  it("fails when the docs site points its favicon or logo at another file", () => {
    const mkdocs = join(root, "site/mkdocs.yml");
    writeFileSync(mkdocs, readFileSync(mkdocs, "utf8").replace(/favicon: .*/, "favicon: assets/horizon-mark.svg"));
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("site/mkdocs.yml");
  });

  it("fails when the web page links an icon that is not generated", () => {
    const html = join(root, "apps/web/index.html");
    writeFileSync(html, readFileSync(html, "utf8").replace("/favicon.svg", "/other-mark.svg"));
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("apps/web/index.html");
  });

  it("fails when the title-bar wordmark's Z is redrawn by hand", () => {
    const path = join(root, WORDMARK);
    writeFileSync(path, readFileSync(path, "utf8").replace('stroke-width="8"', 'stroke-width="5.9"'));
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain(WORDMARK);
  });

  it("fails when the wordmark letters change and the wordmarks are not regenerated", () => {
    writeFileSync(join(root, manifest.wordmark.letters), `${readFileSync(join(root, manifest.wordmark.letters), "utf8")}\n`);
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("node scripts/brand-icons.mjs");
  });

  it("fails when the title bar or the README shows a wordmark that is not generated", () => {
    const toolbar = join(root, "apps/web/src/panels/Toolbar.tsx");
    writeFileSync(toolbar, readFileSync(toolbar, "utf8").replace("brand/zenith-wordmark-dark.svg", "brand/zenith-wordmark-old.svg"));
    const readme = join(root, PUBLIC_README);
    writeFileSync(readme, readFileSync(readme, "utf8").replace(".github/assets/wordmark-light.svg", ".github/assets/logo.svg"));
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("apps/web/src/panels/Toolbar.tsx");
    expect(result.output).toContain(PUBLIC_README);
  });

  it("fails on a stray icon file nobody generated", () => {
    writeFileSync(join(root, "apps/web/public/favicon-64.png"), "");
    const result = runCheck(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("apps/web/public/favicon-64.png");
  });
});
