// `pnpm --filter @horizon36596/zenith-desktop dist`: builds the desktop app and packages it with electron-builder
// into apps/desktop/release: a Windows NSIS installer and a portable exe. Not code-signed.
//
// An installer is a release, so it is built with the release cloud (cloud/web-config.json, read by
// scripts/release-cloud.mjs): this script puts its variables in the environment, rebuilds apps/web
// with them so the page and the main process agree, and refuses to package a build that has the cloud
// off or no desktop sign-in client (no App Check key only warns). The sign-in clients come from the environment or
// apps/web/.env.production.local (cloud/README.md step 4a). Needs the workspace packages built
// (`pnpm build` at the root).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as electronBuilder } from "electron-builder";
import { checkReleaseBuild, readReleaseConfig, releaseEnv } from "../../../scripts/release-cloud.mjs";
import { bundle, copyRenderer } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..");

const cloud = readReleaseConfig(repo);
if (cloud.config === null || cloud.problems.length > 0) {
  console.error(`desktop: the release cloud config is not usable: ${cloud.problems.join("; ")}`);
  process.exit(1);
}
Object.assign(process.env, releaseEnv(cloud.config));

const web = spawnSync("pnpm", ["--filter", "@horizon36596/zenith-web", "run", "build"], { cwd: repo, stdio: "inherit", shell: process.platform === "win32", env: process.env });
if (web.status !== 0) process.exit(web.status ?? 1);

await bundle();
copyRenderer();

const checked = checkReleaseBuild(repo, cloud.config);
if (cloud.appCheckProblem !== null) console.warn(`desktop: warning: App Check is off in this release. ${cloud.appCheckProblem}`);
const problems = checked?.problems ?? ["no built output"];
for (const note of checked?.notes ?? []) console.log(`desktop: note: ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`desktop: ${problem}`);
  console.error("desktop: not packaging a release without the cloud.");
  process.exit(1);
}

await electronBuilder({
  projectDir: pkg,
  win: ["nsis", "portable"],
  publish: "never",
});
console.log("desktop: installers are in apps/desktop/release");
