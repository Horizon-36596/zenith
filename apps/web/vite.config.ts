import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The repository root, so the `?raw` imports of the bundled example resolve and are served. */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The path the built app is served under. `/` for the desktop app (its `zenith://app/` scheme serves
 * the build from the root) and for local development; `/zenith/app/` for the public web build on
 * GitHub Pages, which `scripts/build-pages.mjs` sets. Every asset, the fonts, the favicons, the
 * title-bar images and the `app:` field images are addressed through it, so nothing in the app
 * hard-codes `/assets` or `/fields`.
 */
const base = normalizeBase(process.env["ZENITH_BASE"]);

function normalizeBase(value: string | undefined): string {
  if (value === undefined || value === "") return "/";
  const leading = value.startsWith("/") ? value : `/${value}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173, fs: { allow: [repoRoot] } },
  preview: { port: 5173 },
  build: { outDir: "dist", emptyOutDir: true },
});
