// Builds the desktop app into apps/desktop/dist: the main process and the preload script bundled by
// esbuild (so the packaged app carries no node_modules), the window icons, and a copy of the built
// apps/web as the renderer. `pnpm build` at the root builds apps/web first; run it before this on a fresh clone.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist");
const webDist = join(pkg, "..", "web", "dist");

/** Builds the two Node-side bundles. `watch` is used by scripts/dev.mjs. */
export async function bundle({ dev = false } = {}) {
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: dev ? "inline" : true,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  };
  await build({ ...common, entryPoints: [join(pkg, "src", "main", "index.ts")], outfile: join(out, "main.cjs") });
  await build({ ...common, entryPoints: [join(pkg, "src", "preload", "index.ts")], outfile: join(out, "preload.cjs") });
  copyIcons();
}

/**
 * Copies the window icons next to main.cjs, which reads them from `__dirname`. resources/ is
 * electron-builder's build folder and is not packaged, so this is how a dev run and an installed copy
 * both get the Zenith mark instead of Electron's default.
 */
export function copyIcons() {
  mkdirSync(out, { recursive: true });
  for (const name of ["icon.ico", "icon.png"]) cpSync(join(pkg, "resources", name), join(out, name));
}

/** Copies apps/web/dist to dist/renderer, which the zenith:// scheme serves. */
export function copyRenderer() {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error("apps/web/dist is missing. Run `pnpm build` at the repository root first.");
  }
  const target = join(out, "renderer");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(webDist, target, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle();
  copyRenderer();
  console.log("desktop: built dist/main.cjs, dist/preload.cjs, the icons and dist/renderer");
}
