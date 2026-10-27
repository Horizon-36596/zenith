import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { NotFoundError } from "@horizon36596/zenith-github";
import { loadAutoAndPlan } from "../autoLoad.js";
import { defaultGitHubDeps, NextStepError, type GitHubDeps } from "../github.js";
import { findProjectRoot, LINK_FILE, loadProject } from "../project.js";
import { connectGitHub, formatStatus, type GitHubStatus } from "./githubStatus.js";
import { initProject, type Written } from "./init.js";

export interface SetupOptions {
  cwd?: string;
  /** The project directory. Default: the folder holding zenith.json above `cwd`, else the top of the git repository, else `cwd`. */
  project?: string;
  json?: boolean;
}

export interface SetupAuto {
  name: string;
  path: string;
  errors: number;
  warnings: number;
}

/** `zenith setup --json` and `zenith.setup`. */
export interface SetupResult {
  /** True when an auto can be edited and proposed from here with no more setup. */
  ok: boolean;
  root: string;
  /** `zenith init`'s files, when there was no zenith.json; otherwise `ran` is false. */
  init: { ran: boolean; written: Written[] };
  /** `.mcp.json` at the top of the repository: `written` (new file), `added` (zenith added to it), `kept` or `invalid`. */
  mcp: { path: string; status: "written" | "added" | "kept" | "invalid" };
  github: GitHubStatus;
  /** Whether zenith.json is on the default branch on GitHub; `null` when that could not be checked. */
  projectOnGitHub: boolean | null;
  autos: SetupAuto[];
  /** Things that are fine but worth knowing, such as restarting the agent to load the MCP server. */
  notes: string[];
  /** The one thing to do next. */
  next: string;
}

export const MCP_SERVER_ENTRY = { command: "npx", args: ["-y", "@horizon36596/zenith-mcp"] } as const;

/**
 * Adds the Zenith server to `.mcp.json`, keeping every other server and setting in the file. An
 * existing `zenith` entry is left exactly as it is, and a file that is not JSON is never touched.
 */
export function mergeMcpConfig(path: string): SetupResult["mcp"]["status"] {
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify({ mcpServers: { zenith: MCP_SERVER_ENTRY } }, null, 2)}\n`, "utf8");
    return "written";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "invalid";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  const config = parsed as Record<string, unknown>;
  const servers = config.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) return "invalid";
  const existing = (servers ?? {}) as Record<string, unknown>;
  if ("zenith" in existing) return "kept";
  config.mcpServers = { ...existing, zenith: MCP_SERVER_ENTRY };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return "added";
}

/**
 * `zenith setup`: everything an agent needs before its first edit, in one idempotent call, from
 * inside a clone of the robot repository. Runs `zenith init` when there is no zenith.json, adds
 * the Zenith MCP server to `.mcp.json`, checks that origin is on GitHub and that a sign-in works,
 * and validates every auto. Never commits or pushes anything.
 */
export async function setup(options: SetupOptions = {}, deps: GitHubDeps = defaultGitHubDeps()): Promise<SetupResult> {
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const notes: string[] = [];

  // Where the project is: given, found by walking up, or (for a new one) the top of the repository.
  let gitTop: string | null = null;
  const topResult = await deps.run("git", ["rev-parse", "--show-toplevel"], { cwd, env: deps.env }).catch(() => null);
  if (topResult !== null && topResult.code === 0) gitTop = resolvePath(topResult.stdout.trim());
  const root =
    options.project !== undefined ? resolvePath(cwd, options.project) : (findProjectRoot(cwd) ?? gitTop ?? cwd);

  const init: SetupResult["init"] = { ran: false, written: [] };
  if (!existsSync(join(root, LINK_FILE))) {
    const result = initProject({ cwd: root });
    init.ran = true;
    init.written = result.written;
    if (!result.seasonCopied) notes.push("No season field file was copied. Put one at autos/field/biobuzz.field.json.");
    if (result.commandLibrary === null) {
      notes.push('zenith.json names no command library yet. Add "commandLibrary": "solverslib" or "ivy" to its "deploy" section before zenith codegen or zenith deploy.');
    }
  }

  const mcpDir = gitTop ?? root;
  const mcpPath = join(mcpDir, ".mcp.json");
  const mcpStatus = mergeMcpConfig(mcpPath);
  const mcp = { path: relative(root, mcpPath).split("\\").join("/") || ".mcp.json", status: mcpStatus };
  if (mcpStatus === "written" || mcpStatus === "added") {
    notes.push("The Zenith MCP server was added to .mcp.json. Restart the agent (or reload its MCP servers) to load the zenith.* tools.");
  }

  const connection = await connectGitHub(root, deps);
  const github = connection.status;

  // zenith propose writes only under zenith.json's directories, so the project itself must be on GitHub first.
  let projectOnGitHub: boolean | null = null;
  if (github.ok && connection.session !== null && connection.place !== null && github.repo !== null && github.defaultBranch !== null) {
    try {
      await connection.session.client.contents.get(
        github.repo.owner,
        github.repo.repo,
        `${connection.place.prefix}${LINK_FILE}`,
        github.defaultBranch,
      );
      projectOnGitHub = true;
    } catch (error) {
      if (error instanceof NotFoundError) projectOnGitHub = false;
    }
  }

  const autos: SetupAuto[] = [];
  let projectProblem: string | null = null;
  try {
    const project = loadProject(root, root);
    const dir = join(root, project.link.autosDir);
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((entry) => entry.endsWith(".auto.json"))
          .sort()
      : [];
    for (const entry of names) {
      const loaded = loadAutoAndPlan(join(dir, entry), project);
      const findings = loaded.ok ? loaded.loaded.findings : loaded.findings;
      autos.push({
        name: entry.slice(0, -".auto.json".length),
        path: `${project.link.autosDir}/${entry}`.split("\\").join("/"),
        errors: findings.filter((finding) => finding.severity === "error").length,
        warnings: findings.filter((finding) => finding.severity === "warning").length,
      });
    }
  } catch (error) {
    projectProblem = error instanceof Error ? error.message : String(error);
  }

  const withErrors = autos.find((auto) => auto.errors > 0);
  let next: string;
  if (projectProblem !== null) {
    next = `Fix the project files: ${projectProblem}`;
  } else if (mcpStatus === "invalid") {
    next = `.mcp.json is not valid JSON, so setup left it alone. Fix it, then run zenith setup again.`;
  } else if (!github.ok) {
    next = github.next ?? "Run `zenith github status` to see what is missing.";
  } else if (projectOnGitHub === false) {
    const linkPath = `${connection.place?.prefix ?? ""}${LINK_FILE}`;
    next =
      `Get the Zenith project onto ${github.defaultBranch ?? "the default branch"} once: commit ${linkPath} and the autos folder, ` +
      "push them or open a pull request for them and have it merged; zenith propose only commits under the autos, deploy and codegen folders.";
  } else if (withErrors !== undefined) {
    next = `Fix the errors in ${withErrors.name}: \`zenith validate ${withErrors.name} --explain\` (MCP: zenith.validate), then edit with the zenith.edit.* tools.`;
  } else if (autos.length === 0) {
    next = "Create an auto: `zenith new <name> --alliance RED` (MCP: zenith.edit.newAutoFromTemplate), then `zenith propose <name>`.";
  } else {
    next = `Edit an auto with the zenith.edit.* tools, then \`zenith propose <auto>\` (MCP: zenith.propose) opens its pull request.`;
  }

  const ok = projectProblem === null && mcpStatus !== "invalid" && github.ok && projectOnGitHub !== false && withErrors === undefined;
  return { ok, root, init, mcp, github, projectOnGitHub, autos, notes, next };
}

/** `zenith setup`: exit 0 when everything is ready, 2 when a step needs doing (the result's `next`). */
export async function runSetup(options: SetupOptions, deps: GitHubDeps = defaultGitHubDeps()): Promise<number> {
  let result: SetupResult;
  try {
    result = await setup(options, deps);
  } catch (error) {
    if (!(error instanceof NextStepError)) throw error;
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: error.problem, next: error.next }, null, 2)}\n`);
    else process.stderr.write(`zenith: ${error.problem}\nnext: ${error.next}\n`);
    return 2;
  }
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = [`project:    ${result.root}`];
    if (result.init.ran) for (const file of result.init.written) lines.push(`init:       ${file.status} ${file.path}`);
    lines.push(`.mcp.json:  ${result.mcp.status}`);
    lines.push(...formatStatus({ ...result.github, next: null }));
    lines.push(
      `autos:      ${
        result.autos.length === 0
          ? "none yet"
          : result.autos.map((auto) => `${auto.name} (${String(auto.errors)} errors, ${String(auto.warnings)} warnings)`).join(", ")
      }`,
    );
    for (const note of result.notes) lines.push(`note:       ${note}`);
    lines.push(`next:       ${result.next}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return result.ok ? 0 : 2;
}
