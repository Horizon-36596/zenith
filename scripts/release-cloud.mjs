#!/usr/bin/env node
// The cloud in a release. Every public build of Zenith (the web app on the Pages site and the desktop
// installers) talks to the production Firebase project, and a release built without it would ship with accounts, teams and sharing silently off. This script is the one place that
// knows both halves:
//
//   node scripts/release-cloud.mjs env [--github-env]
//     Prints the build variables a release is built with, one `NAME=value` line each, read from
//     cloud/web-config.json. With --github-env it appends them to the file in $GITHUB_ENV instead, so
//     every later step of a GitHub Actions job builds with them.
//
//   node scripts/release-cloud.mjs check [--root <dir>] [--pages <dir> [--pages-only]]
//     Reads the built output under <root> (apps/web/dist and apps/desktop/dist, after `pnpm build`)
//     and, with --pages, the Pages artifact's app/ folder (only that, with --pages-only), and fails
//     unless every one carries the Firebase config of cloud/web-config.json (and its App Check site
//     key, when it has one), and the desktop main process at least one desktop sign-in client. It
//     fails, too, when there is no built output. A config without an App Check key only warns:
//     App Check is optional for now (cloud/README.md step 7).
//
// The config lives in a committed file rather than in a repository variable because it is public by
// design (every page carries it), a reviewer sees a change to it in the diff, and a person building
// on their own machine gets the same values as the workflows. The desktop sign-in clients are not in
// it: the Google desktop client's secret is not treated as a secret by Google, but a public repository
// holding one gets it flagged and revoked, so the workflows pass all four in from the repository's
// variables and secrets, and a local build from apps/web/.env.production.local or the environment.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the release cloud's config lives, relative to the repository. */
export const CONFIG_PATH = "cloud/web-config.json";

/** The built output a release is made from, relative to the repository. */
export const BUILD_DIRS = ["apps/web/dist", "apps/desktop/dist"];

/** The variables the desktop build reads for its sign-in clients (apps/desktop/scripts/build.mjs). */
export const SIGN_IN_CLIENT_KEYS = ["githubClientId", "googleClientId", "microsoftClientId"];

/**
 * Reads and checks a release cloud config. Returns `{ config, problems, appCheckProblem }`: `config`
 * is `{ firebase, appCheckSiteKey }`, `problems` lists, in plain sentences, everything that would
 * leave a release without a working cloud, and `appCheckProblem` says why App Check would be off, or
 * is null. A build or a release may go ahead without App Check; `env` and `check` warn. Rules follow the app's own (apps/web/src/account/config.ts):
 * the Firebase config needs `apiKey` and `projectId` strings, and the site key must be set and hold no
 * white space. This also asks for `authDomain` and `appId`, which sign-in needs.
 */
export function parseReleaseConfig(text) {
  const problems = [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { config: null, problems: [`${CONFIG_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`], appCheckProblem: null };
  }
  const firebase = json?.firebase;
  if (firebase === null || typeof firebase !== "object" || Array.isArray(firebase)) {
    return { config: null, problems: [`${CONFIG_PATH} has no "firebase" object`], appCheckProblem: null };
  }
  if (typeof firebase.apiKey !== "string" || !/^AIza[0-9A-Za-z_-]{35}$/.test(firebase.apiKey)) {
    problems.push(`${CONFIG_PATH}: firebase.apiKey is not a Firebase web API key`);
  }
  for (const key of ["projectId", "authDomain", "appId"]) {
    if (typeof firebase[key] !== "string" || firebase[key].trim() === "") problems.push(`${CONFIG_PATH}: firebase.${key} is missing`);
  }
  const appCheckSiteKey = typeof json.appCheckSiteKey === "string" ? json.appCheckSiteKey.trim() : "";
  const appCheckProblem =
    appCheckSiteKey === "" || /\s/.test(appCheckSiteKey)
      ? `${CONFIG_PATH}: appCheckSiteKey is empty or not a key. Paste the reCAPTCHA Enterprise site key from the Firebase console (App Check, Apps) there; cloud/README.md step 7`
      : null;
  return { config: { firebase, appCheckSiteKey: appCheckProblem === null ? appCheckSiteKey : "" }, problems, appCheckProblem };
}

/** The release config of the repository at `root`, read and checked. */
export function readReleaseConfig(root = repo) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { config: null, problems: [`${CONFIG_PATH} is missing`], appCheckProblem: null };
  return parseReleaseConfig(readFileSync(path, "utf8"));
}

/**
 * The build variables of a release, as Vite and the desktop build read them. Only the cloud: the
 * desktop sign-in clients come from the environment (see the top of this file).
 */
export function releaseEnv(config) {
  const env = { VITE_ZENITH_FIREBASE_CONFIG: JSON.stringify(config.firebase) };
  if (config.appCheckSiteKey !== "") env.VITE_ZENITH_APPCHECK_SITE_KEY = config.appCheckSiteKey;
  return env;
}

const TEXT = /\.(js|cjs|mjs|html|json|txt)$/i;

function textFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(path));
    else if (entry.isFile() && TEXT.test(entry.name)) out.push(path);
  }
  return out;
}

/** Whether any built text file under `dir` contains `needle`. */
function carries(dir, needle) {
  return textFiles(dir).some((file) => readFileSync(file, "utf8").includes(needle));
}

/**
 * The desktop sign-in clients baked into a built main process, by key, from the JSON string the
 * desktop build defines (`__ZENITH_SIGN_IN_CLIENTS__`). esbuild writes it as a string literal, so the
 * quotes inside may be escaped; an empty value means that provider is hidden in the app.
 */
export function signInClientsIn(text) {
  const found = {};
  for (const key of SIGN_IN_CLIENT_KEYS) {
    const match = new RegExp(`${key}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]*)`).exec(text);
    found[key] = match === null ? "" : match[1];
  }
  return found;
}

/**
 * Checks the built output under `root` (and the Pages artifact at `pages`, when given) against
 * `config`. With `pagesOnly`, only the Pages artifact is read. Returns `{ checked, problems, notes }`,
 * or null when there is no built output at all.
 */
export function checkReleaseBuild(root, config, { pages, pagesOnly = false } = {}) {
  const dirs = pagesOnly ? [] : BUILD_DIRS.map((dir) => ({ label: dir, path: join(root, dir) }));
  if (pages !== undefined) dirs.push({ label: `${relative(root, pages).replace(/\\/g, "/") || "."}/app`, path: join(pages, "app") });
  const present = dirs.filter((dir) => existsSync(dir.path));
  if (present.length === 0) return null;
  const problems = [];
  const notes = [];
  for (const dir of present) {
    if (!carries(dir.path, config.firebase.apiKey) || !carries(dir.path, config.firebase.projectId)) {
      problems.push(`${dir.label}: no Firebase config of ${config.firebase.projectId}, so this build has the cloud off`);
    }
    if (config.appCheckSiteKey !== "" && !carries(dir.path, config.appCheckSiteKey)) {
      problems.push(`${dir.label}: no App Check site key`);
    }
  }
  const main = join(root, "apps", "desktop", "dist", "main.cjs");
  if (!pagesOnly && existsSync(main)) {
    const clients = signInClientsIn(readFileSync(main, "utf8"));
    const missing = SIGN_IN_CLIENT_KEYS.filter((key) => clients[key] === "");
    if (missing.length === SIGN_IN_CLIENT_KEYS.length) {
      problems.push(
        "apps/desktop/dist/main.cjs: no desktop sign-in client, so nobody can sign in from the desktop app. Set VITE_ZENITH_GITHUB_CLIENT_ID, VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_ID (with its secret) or VITE_ZENITH_MICROSOFT_CLIENT_ID for the build",
      );
    } else if (missing.length > 0) {
      notes.push(`apps/desktop/dist/main.cjs: no ${missing.join(", ")}; the desktop app hides those sign-in providers`);
    }
  }
  return { checked: present.map((dir) => dir.label), problems, notes };
}

function argValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
  const root = resolve(argValue(rest, "--root") ?? repo);
  const { config, problems, appCheckProblem } = readReleaseConfig(root);
  if (command === "env") {
    if (config === null || problems.length > 0) {
      for (const problem of problems) console.error(`release-cloud: ${problem}`);
      process.exit(1);
    }
    if (appCheckProblem !== null) console.error(`release-cloud: warning: App Check stays off in this build. ${appCheckProblem}`);
    const lines = Object.entries(releaseEnv(config)).map(([name, value]) => `${name}=${value}`);
    const target = process.env["GITHUB_ENV"];
    if (rest.includes("--github-env")) {
      if (target === undefined || target === "") {
        console.error("release-cloud: --github-env needs $GITHUB_ENV, which only GitHub Actions sets");
        process.exit(2);
      }
      appendFileSync(target, `${lines.join("\n")}\n`, "utf8");
      console.log(`release-cloud: the build steps that follow use the cloud of ${config.firebase.projectId}`);
    } else {
      console.log(lines.join("\n"));
    }
  } else if (command === "check") {
    if (config === null) {
      for (const problem of problems) console.error(`release-cloud: ${problem}`);
      process.exit(1);
    }
    const pages = argValue(rest, "--pages");
    const pagesOnly = rest.includes("--pages-only");
    if (pagesOnly && pages === undefined) {
      console.error("release-cloud: --pages-only needs --pages <dir>");
      process.exit(2);
    }
    const result = checkReleaseBuild(root, config, { pages: pages === undefined ? undefined : resolve(pages), pagesOnly });
    if (result === null) {
      console.error(`release-cloud: no built output under ${root} (${BUILD_DIRS.join(", ")}); build first`);
      process.exit(2);
    }
    for (const note of result.notes) console.log(`release-cloud: note: ${note}`);
    if (appCheckProblem !== null) console.warn(`release-cloud: warning: App Check is off in this release. ${appCheckProblem}`);
    const all = [...problems, ...result.problems];
    if (all.length > 0) {
      for (const problem of all) console.error(`release-cloud: ${problem}`);
      console.error("release-cloud: not a release build. Build with `node scripts/release-cloud.mjs env` in the environment (the workflows and scripts/build-pages.mjs do it).");
      process.exit(1);
    }
    console.log(`release-cloud: the cloud of ${config.firebase.projectId} is on${appCheckProblem === null ? ", with App Check," : ""} in ${result.checked.join(", ")}`);
  } else {
    console.error("usage: node scripts/release-cloud.mjs env [--github-env] | check [--root <dir>] [--pages <dir> [--pages-only]]");
    process.exit(2);
  }
}
