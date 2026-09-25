#!/usr/bin/env node
// The npm release smoke test (PUBLISHING.md). Run it after `pnpm build`
// and before any publish. It changes nothing in the repository and publishes nothing.
//
// 1. Packs the seven published packages with `pnpm pack`, which rewrites `workspace:*` the way
//    `pnpm publish` does, and checks each tarball: the version is the root version, every internal
//    dependency is pinned to it, no source or test file is inside, and README, LICENSE and
//    package.json are.
// 2. Installs the tarballs into an empty folder with npm, the way a team would install from the
//    registry, and checks that `npx zenith --version` prints the version, that `zenith init`,
//    `zenith new` and `zenith validate` work on a fresh project with 0 errors and that `zenith validate`
//    passes on the repository's starter example, and that `zenith-mcp` starts, answers `initialize` and
//    `tools/list` over stdio, and renders a PNG (which runs the CLI it depends on).
//
// Usage: node scripts/smoke-pack.mjs [--out <dir>] [--keep]
//   --out <dir>  where to pack and install (default: a new folder in the OS temp directory)
//   --keep       leave that folder in place afterwards
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const keep = args.includes("--keep");
const isWindows = process.platform === "win32";

/** Publish order: every package after the ones it depends on. */
const PUBLISH_ORDER = ["schema", "core", "season-biobuzz", "seasons", "github", "cli", "mcp"];
const SCOPE = "@horizon36596/";

const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const work = outArg === undefined ? mkdtempSync(join(tmpdir(), "zenith-smoke-")) : resolve(outArg);
const packs = join(work, "packs");
const install = join(work, "install");
const failures = [];

function step(title) {
  console.log(`\n== ${title}`);
}
function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

/**
 * Runs npm, npx or pnpm and returns what it printed. They are .cmd shims on Windows, which Node
 * starts only through a shell; every argument is a fixed word or a path this script made, and a path
 * with a space is quoted, so the shell sees nothing it could misread.
 */
function run(command, commandArgs, cwd) {
  const quoted = isWindows ? commandArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : commandArgs;
  const result = spawnSync(command, quoted, { cwd, encoding: "utf8", shell: isWindows, windowsHide: true });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** Runs the installed CLI with this Node, without a shell. */
function zenith(zenithArgs, cwd) {
  const entry = join(install, "node_modules", "@horizon36596", "zenith-cli", "dist", "index.js");
  const result = spawnSync(process.execPath, [entry, ...zenithArgs], { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// tar runs in the tarball's folder with a bare file name: GNU tar reads "C:" in a Windows path as a
// remote host name.
function tarList(tarball) {
  const result = spawnSync("tar", ["-tzf", basename(tarball)], { cwd: dirname(tarball), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar could not list ${tarball}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter((line) => line !== "");
}

function tarRead(tarball, member) {
  const result = spawnSync("tar", ["-xzOf", basename(tarball), member], { cwd: dirname(tarball), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar could not read ${member} from ${tarball}: ${result.stderr}`);
  return result.stdout;
}

// ---- 1. Pack and inspect -------------------------------------------------------------------------
rmSync(work, { recursive: true, force: true });
mkdirSync(packs, { recursive: true });
step(`pack ${String(PUBLISH_ORDER.length)} packages at ${version} into ${packs}`);
const tarballs = [];
for (const dir of PUBLISH_ORDER) {
  const packageDir = join(repoRoot, "packages", dir);
  if (!existsSync(join(packageDir, "dist"))) throw new Error(`packages/${dir} has no dist/; run pnpm build first.`);
  const before = new Set(readdirSync(packs));
  const packed = run("pnpm", ["pack", "--pack-destination", packs], packageDir);
  if (packed.code !== 0) throw new Error(`pnpm pack failed in packages/${dir}:\n${packed.stdout}${packed.stderr}`);
  const created = readdirSync(packs).filter((file) => file.endsWith(".tgz") && !before.has(file));
  if (created.length !== 1) throw new Error(`pnpm pack in packages/${dir} made ${String(created.length)} tarballs.`);
  tarballs.push({ dir, file: join(packs, created[0]) });
}

step("inspect each tarball");
for (const { dir, file } of tarballs) {
  const files = tarList(file).map((path) => path.replace(/^package\//, ""));
  const manifest = JSON.parse(tarRead(file, "package/package.json"));
  const name = `${SCOPE}zenith-${dir}`;
  const internal = Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(([dep]) =>
    dep.startsWith(SCOPE),
  );
  const leaked = files.filter(
    (path) => path.startsWith("src/") || path.startsWith("test/") || /\.test\.|testSupport|(^|\/)testing[./]|\.tsbuildinfo$/.test(path),
  );
  console.log(`   ${manifest.name}@${manifest.version}: ${String(files.length)} files; ${files.filter((f) => !f.startsWith("dist/")).join(", ")}`);
  check(manifest.name === name, `${name}: name is ${manifest.name}`);
  check(manifest.version === version, `${name}: version is ${version}`);
  check(manifest.private !== true, `${name}: not private`);
  check(manifest.license === "MIT" && manifest.author === "Horizon (FTC 36596)", `${name}: MIT, by Horizon (FTC 36596)`);
  check(manifest.publishConfig?.access === "public", `${name}: publishConfig.access is public`);
  check(
    internal.every(([, range]) => range === version),
    `${name}: internal dependencies pinned to ${version} (${internal.map(([d, r]) => `${d.slice(SCOPE.length)}@${r}`).join(", ") || "none"})`,
  );
  check(!JSON.stringify(manifest).includes("workspace:"), `${name}: no workspace: ranges left`);
  check(["README.md", "LICENSE", "package.json"].every((f) => files.includes(f)), `${name}: README.md, LICENSE and package.json inside`);
  check(files.some((f) => f === "dist/index.js"), `${name}: dist/index.js inside`);
  check(leaked.length === 0, `${name}: no source, test or build-info files${leaked.length > 0 ? ` (found ${leaked.slice(0, 5).join(", ")})` : ""}`);
}

// ---- 2. Install into an empty folder ---------------------------------------------------------------
step(`install every tarball into ${install}`);
mkdirSync(install, { recursive: true });
writeFileSync(join(install, "package.json"), `${JSON.stringify({ name: "zenith-smoke", private: true }, null, 2)}\n`);
const installed = run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs.map((t) => t.file)], install);
check(installed.code === 0, `npm install of the tarballs${installed.code === 0 ? "" : `:\n${installed.stdout}${installed.stderr}`}`);

const versionOut = run("npx", ["--no-install", "zenith", "--version"], install);
check(versionOut.stdout.trim() === version, `npx zenith --version prints ${version} (got "${versionOut.stdout.trim()}")`);

const fresh = join(work, "fresh-project");
mkdirSync(fresh, { recursive: true });
const init = zenith(["init"], fresh);
check(init.code === 0 && existsSync(join(fresh, "autos", "field", "biobuzz.field.json")), `zenith init writes a project with the season field${init.code === 0 ? "" : `: ${init.stderr}`}`);
const created = zenith(["new", "smoke"], fresh);
check(created.code === 0, `zenith new smoke${created.code === 0 ? "" : `: ${created.stderr}`}`);
// The skeleton must validate on the season field init copied: exit 0, 0 errors, and in particular
// no START_ILLEGAL, which a start pose that breaks the field's start rules would raise.
const validFresh = zenith(["validate", "autos/smoke.auto.json", "--json"], fresh);
let freshReport = null;
try {
  freshReport = JSON.parse(validFresh.stdout);
} catch {
  // reported below
}
const freshCodes = (freshReport?.files ?? []).flatMap((file) => (file.findings ?? []).map((finding) => finding.code));
check(
  validFresh.code === 0 && freshReport?.errors === 0 && !freshCodes.includes("START_ILLEGAL"),
  `zenith validate on the new project exits 0 with 0 errors (exit ${String(validFresh.code)}, ${String(freshReport?.errors)} errors${freshCodes.length > 0 ? `, findings ${freshCodes.join(", ")}` : ""})${freshReport === null ? `: ${validFresh.stderr}` : ""}`,
);

const exampleName = "starter";
if (!existsSync(join(repoRoot, "examples", exampleName, "zenith.json"))) {
  check(false, `examples/${exampleName}/zenith.json, the example project to validate`);
} else {
  const example = join(work, `example-${exampleName}`);
  cpSync(join(repoRoot, "examples", exampleName), example, { recursive: true });
  const autosDir = JSON.parse(readFileSync(join(example, "zenith.json"), "utf8")).autosDir ?? "autos";
  const autos = readdirSync(join(example, autosDir)).filter((file) => file.endsWith(".auto.json"));
  const validExample = zenith(["validate", ...autos.map((file) => `${autosDir}/${file}`), "--json"], example);
  let errors = null;
  try {
    errors = JSON.parse(validExample.stdout).errors;
  } catch {
    // reported below
  }
  check(
    validExample.code === 0 && errors === 0,
    `zenith validate on examples/${exampleName} (${String(autos.length)} autos) exits 0 with 0 errors${validExample.code === 0 ? "" : `: ${validExample.stdout.slice(0, 400)}${validExample.stderr}`}`,
  );
}

// ---- 3. The MCP server over stdio ------------------------------------------------------------------
step("zenith-mcp over stdio");
const mcpEntry = join(install, "node_modules", "@horizon36596", "zenith-mcp", "dist", "index.js");
const binShim = join(install, "node_modules", ".bin", isWindows ? "zenith-mcp.cmd" : "zenith-mcp");
check(existsSync(binShim), "the zenith-mcp bin is linked");

async function mcpSession() {
  const child = spawn(process.execPath, [mcpEntry], { cwd: fresh, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 60000) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr}`)), timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zenith-smoke-pack", version },
    });
    check(init.result?.serverInfo?.name === "zenith", `initialize: server is "${String(init.result?.serverInfo?.name)}"`);
    check(init.result?.serverInfo?.version === version, `initialize: server version is ${version} (got ${String(init.result?.serverInfo?.version)})`);
    notify("notifications/initialized", {});
    const listed = await request("tools/list", {});
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    console.log(`   ${String(names.length)} tools: ${names.join(", ")}`);
    check(["zenith.validate", "zenith.render", "zenith.sim", "zenith.project.open"].every((n) => names.includes(n)), "tools/list includes validate, render, sim and project.open");
    const rendered = await request("tools/call", {
      name: "zenith.render",
      arguments: { auto: "smoke", out: "renders/smoke.png", format: "png", project: fresh },
    });
    const pngOk = rendered.result?.isError !== true && existsSync(join(fresh, "renders", "smoke.png"));
    check(pngOk, `zenith.render png runs the bundled CLI${pngOk ? "" : `: ${JSON.stringify(rendered.result ?? rendered.error).slice(0, 400)}`}`);
  } finally {
    // The server's working directory is the fresh project, and Windows will not remove a directory
    // a live process sits in, so wait for it to exit before the work folder is cleaned up.
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise((done) => child.once("exit", done));
    child.stdin.end();
    child.kill();
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
  }
}

try {
  await mcpSession();
} catch (error) {
  check(false, `zenith-mcp session: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\n${failures.length === 0 ? "smoke-pack passed" : `smoke-pack FAILED (${String(failures.length)})`}: ${work}`);
if (!keep && failures.length === 0) rmSync(work, { recursive: true, force: true });
if (failures.length > 0) process.exitCode = 1;
