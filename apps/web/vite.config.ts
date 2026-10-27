import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The repository root, so the `?raw` imports of the bundled example resolve and are served. */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The Zenith version, read from the root package.json at build time (the one place it is set), so
 * the app can say which version it is, as the Report a bug dialog does. Read, never written:
 * nothing here needs stamping.
 */
const appVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * The path the built app is served under. `/` for the desktop app (its `zenith://app/` scheme serves
 * the build from the root) and for local development; `/zenith/app/` for the public web build on
 * GitHub Pages, which `scripts/build-pages.mjs` sets. Every asset, the fonts, the favicons, the
 * title-bar images and any `app:` field image are addressed through it, so nothing in the app
 * hard-codes `/assets` or `/fields`.
 */
const base = normalizeBase(process.env["ZENITH_BASE"]);

function normalizeBase(value: string | undefined): string {
  if (value === undefined || value === "") return "/";
  const leading = value.startsWith("/") ? value : `/${value}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/**
 * The dev server's field reference route: `/__field-ref/<season>/<file>.webp` serves a picture from
 * the repository's internal field references (`docs/field-reference/`), for the `?fieldRef=1`
 * alignment overlay (src/canvas/fieldReference.ts). `apply: "serve"` keeps it out of every build,
 * and where the folder does not exist the route answers 404 and the overlay draws nothing.
 */
function fieldReference(): Plugin {
  const folder = join(repoRoot, "docs", "field-reference");
  return {
    name: "zenith-field-reference",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__field-ref/", (request, response) => {
        const match = /^\/([a-z0-9-]+)\/([a-z0-9-]+\.webp)$/.exec(request.url ?? "");
        const file = match === null ? null : join(folder, match[1] ?? "", match[2] ?? "");
        if (file === null || !existsSync(file)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "image/webp");
        response.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), fieldReference()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { port: 5173, fs: { allow: [repoRoot] } },
  preview: { port: 5173 },
  // The Optimize path worker (src/optimize/worker.ts) is a module worker: ES modules, as the
  // `{ type: "module" }` its host starts it with expects.
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The page, and the Optimize path host as an entry of its own, `assets/optimizer-<hash>.js`,
      // which puts the host and its worker chunk in every build (the Vercel beta, Pages and the
      // desktop renderer) and which the desktop spec loads under the app's CSP
      // (apps/desktop/e2e/optimizer-worker.spec.ts). The Optimize card imports the host from the
      // page as well. Its exports are kept, so the entry is not shaken away.
      input: { index: fileURLToPath(new URL("./index.html", import.meta.url)), optimizer: fileURLToPath(new URL("./src/optimize/host.ts", import.meta.url)) },
      preserveEntrySignatures: "exports-only",
    },
  },
});
