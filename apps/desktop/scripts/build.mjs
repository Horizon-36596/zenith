// Builds the desktop app into apps/desktop/dist: the main process and the preload script bundled by
// esbuild (so the packaged app carries no node_modules), the window icons, and a copy of the built
// apps/web as the renderer. `pnpm build` at the root builds apps/web first; run it before this on a fresh clone.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadEnv } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "dist");
const webRoot = join(pkg, "..", "web");
const webDist = join(webRoot, "dist");

/**
 * The Firebase web config the web build gets, read the way Vite reads it for apps/web (its `.env`
 * files for the mode, then the environment), so the main process opens the cloud's hosts exactly
 * when the page it serves has the cloud on (src/main/cloud.ts). Empty when there is none.
 */
export function firebaseConfigFor(mode) {
  return loadEnv(mode, webRoot, "VITE_")["VITE_ZENITH_FIREBASE_CONFIG"] ?? "";
}

/**
 * The App Check site key the web build gets (`VITE_ZENITH_APPCHECK_SITE_KEY`), read the same way, so
 * the policy lets App Check's hosts through exactly when the page turns App Check on. Empty when
 * there is none. It is not a secret; the page carries it too.
 */
export function appCheckSiteKeyFor(mode) {
  return loadEnv(mode, webRoot, "VITE_")["VITE_ZENITH_APPCHECK_SITE_KEY"] ?? "";
}

/**
 * The OAuth clients the built app signs in with through the system browser (src/main/nativeSignIn.ts),
 * read from the same place and in the same way as the Firebase config, as the JSON object the main
 * process reads. Each is optional: a provider whose client is missing is hidden in the desktop app.
 * None is a secret. The Google desktop client secret is here because Google's token endpoint asks for
 * it even with PKCE and says it is not treated as a secret in an installed app (ADR 0011); it is
 * baked into the main process only, never into the page.
 */
export function signInClientsFor(mode) {
  const env = loadEnv(mode, webRoot, "VITE_");
  return JSON.stringify({
    googleClientId: env["VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_ID"] ?? "",
    googleClientSecret: env["VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_SECRET"] ?? "",
    microsoftClientId: env["VITE_ZENITH_MICROSOFT_CLIENT_ID"] ?? "",
    githubClientId: env["VITE_ZENITH_GITHUB_CLIENT_ID"] ?? "",
  });
}

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
    define: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
      __ZENITH_FIREBASE_CONFIG__: JSON.stringify(firebaseConfigFor(dev ? "development" : "production")),
      __ZENITH_APPCHECK_SITE_KEY__: JSON.stringify(appCheckSiteKeyFor(dev ? "development" : "production")),
      __ZENITH_SIGN_IN_CLIENTS__: JSON.stringify(signInClientsFor(dev ? "development" : "production")),
    },
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
