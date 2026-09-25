// `pnpm --filter @horizon36596/zenith-desktop dist`: builds the desktop app and packages it with electron-builder
// into apps/desktop/release: a Windows NSIS installer and a portable exe. Not code-signed.
//
// Needs apps/web built (`pnpm build` at the root does it, and this script runs it when the web
// build is missing).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as electronBuilder } from "electron-builder";
import { bundle, copyRenderer } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..");

if (!existsSync(join(pkg, "..", "web", "dist", "index.html"))) {
  const result = spawnSync("pnpm", ["build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await bundle();
copyRenderer();

await electronBuilder({
  projectDir: pkg,
  win: ["nsis", "portable"],
  publish: "never",
});
console.log("desktop: installers are in apps/desktop/release");
