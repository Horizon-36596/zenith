import { resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultGitHubDeps,
  githubStatus,
  NextStepError,
  proposeDryRun,
  proposeToGitHub,
  setup,
  type GitHubDeps,
} from "@horizon36596/zenith-cli/lib";
import { z } from "zod";
import { helpFor } from "../findings.js";
import { resolveAutoPath, resolveProject } from "../project.js";
import { errorResult, guarded, jsonResult } from "../result.js";
import { autoRefField, projectField } from "../schemas.js";

const dirField = z
  .string()
  .optional()
  .describe("A directory inside the robot repository clone. Default: the directory the MCP server was started in.");

/** A `NextStepError` becomes a tool error whose text ends with the one next step. */
function withNextStep(error: unknown) {
  if (error instanceof NextStepError) return jsonResultError({ error: error.problem, next: error.next, files: error.files });
  return errorResult(error);
}

function jsonResultError(data: { error: string; next: string; files: string[] }) {
  const { files, ...rest } = data;
  return { ...jsonResult(files.length > 0 ? data : rest), isError: true };
}

/**
 * `zenith.setup`, `zenith.github.status` and `zenith.propose`: the CLI's `zenith setup`,
 * `zenith github status --json` and `zenith propose --json`, in process. The GitHub sign-in is
 * `GH_TOKEN`, `GITHUB_TOKEN` or the GitHub CLI's; the token is only ever sent to api.github.com and
 * never appears in a result. `deps` lets a test give its own git, `gh` and `fetch`.
 */
export function registerGitHubTools(server: McpServer, deps: GitHubDeps = defaultGitHubDeps()): void {
  server.registerTool(
    "zenith.setup",
    {
      title: "Set up Zenith in this robot repository",
      description:
        "Run first, from a clone of the team's robot repository. Idempotent: runs `zenith init` when there is no " +
        "zenith.json, adds the Zenith server to .mcp.json (keeping every other server), checks that origin is a " +
        "github.com repository and that a GitHub sign-in works (GH_TOKEN, GITHUB_TOKEN, or the GitHub CLI's " +
        "`gh auth login`), checks the project is on the default branch, and validates every auto. Returns " +
        "`{ ok, root, init, mcp, github, projectOnGitHub, autos, notes, next }`; `next` is the one thing to do next. " +
        "Never commits or pushes.",
      inputSchema: { project: dirField },
    },
    guarded(async ({ project }) => {
      const dir = resolvePath(project ?? process.cwd());
      try {
        return jsonResult(await setup({ cwd: dir }, deps));
      } catch (error) {
        return withNextStep(error);
      }
    }),
  );

  server.registerTool(
    "zenith.github.status",
    {
      title: "Where this clone's GitHub repository is and who is signed in",
      description:
        "Reads origin's owner/repo, its default branch, the signed-in GitHub login (and whether it came from " +
        "GH_TOKEN, GITHUB_TOKEN or gh), push access, the current branch and its open pull request. Returns " +
        "`{ ok, repo, defaultBranch, login, auth, canPush, branch, pullRequest, error, next }`; when `ok` is false, " +
        "`error` says what is missing and `next` the one step that fixes it. Changes nothing.",
      inputSchema: { project: dirField },
    },
    guarded(async ({ project }) => jsonResult(await githubStatus({ cwd: resolvePath(project ?? process.cwd()) }, deps))),
  );

  server.registerTool(
    "zenith.propose",
    {
      title: "Open or update the pull request for an auto",
      description:
        "Propose, the same as the editor's button: validates the auto (an error finding blocks it; warnings go in " +
        "the body), commits the canonical auto, the waypoints file if it has local changes, and a rendered SVG to " +
        "the work branch auto/<auto>/<login> (or `branch`), merging the base in first (a conflict stops it and " +
        "names the files), pushes, and opens or updates the pull request with the generated body. Never writes the " +
        "base branch, never force-pushes, and only commits under zenith.json's autos, deploy and codegen folders. " +
        "The person's checkout is left as it is. Returns `{ ok, auto, repo, base, branch, login, commit, " +
        "mergedBase, files, pushed, pullRequest: { number, url, created }, errors, warnings, seasonWarnings, next }`, " +
        "or, when the auto has an error, `{ ok: false, findings, errors, warnings, help, next }`. With `dryRun`, " +
        "only validates, writes the render and returns `{ render, body, seasonWarnings }`.",
      inputSchema: {
        auto: autoRefField,
        base: z.string().min(1).optional().describe("The branch the pull request goes into. Default: the repository's default branch."),
        branch: z.string().min(1).optional().describe("The work branch. Default: auto/<auto>/<login>."),
        summary: z.string().min(1).optional().describe('The commit summary after "auto(<auto>): ". Default "edit".'),
        reviewers: z.array(z.string().min(1)).optional().describe("GitHub logins to ask for a review."),
        dryRun: z.boolean().optional().describe("Only validate, render and return the pull request body. Default false."),
        project: projectField,
      },
    },
    guarded(async ({ auto, base, branch, summary, reviewers, dryRun, project }) => {
      const proj = resolveProject(project);
      // The auto argument is untrusted: confined to the project here, before the CLI reads it.
      resolveAutoPath(proj, auto);
      try {
        if (dryRun === true) {
          const result = proposeDryRun(auto, { cwd: proj.root, project: proj.root });
          return jsonResult("ok" in result ? { ...result, help: helpFor(result.findings) } : result);
        }
        const result = await proposeToGitHub(auto, { cwd: proj.root, project: proj.root, base, branch, summary, reviewers }, deps);
        return jsonResult(result.ok ? result : { ...result, help: helpFor(result.findings) });
      } catch (error) {
        return withNextStep(error);
      }
    }),
  );
}
