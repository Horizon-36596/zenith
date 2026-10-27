import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubStatus, runGitHubStatus } from "../src/commands/githubStatus.js";
import { proposeToGitHub, runPropose } from "../src/commands/propose.js";
import { runSetup, setup } from "../src/commands/setup.js";
import { NextStepError } from "../src/github.js";
import { makeProject, simpleAuto, writeAuto } from "../src/testSupport.js";
import { editDemo, makeRepo, removeTemplates, TOKEN, type TestRepo } from "./gitHubHarness.js";

/**
 * `zenith setup`, `zenith github status` and `zenith propose` against a real git repository whose
 * origin is a local bare repository, and a fake api.github.com. Nothing here reaches GitHub or the
 * real GitHub CLI.
 */

// Each test runs dozens of real git commands, which take a while on Windows.
vi.setConfig({ testTimeout: 60_000 });

let repos: TestRepo[] = [];
afterAll(removeTemplates);
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  repos = [];
  out = [];
  errOut = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errOut.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of repos) repo.cleanup();
});

function repoFor(options: Parameters<typeof makeRepo>[0] = {}): TestRepo {
  const made = makeRepo(options);
  repos.push(made);
  return made;
}

/** Every file under a directory, read as text, for the "never written to disk" check. */
function allText(dir: string): string {
  let text = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) text += allText(full);
    else text += readFileSync(full, "latin1");
  }
  return text;
}

/** The token is only ever sent to api.github.com, and never printed or written. */
function expectTokenContained(t: TestRepo): void {
  for (const call of t.github.calls) {
    expect(call.url.origin).toBe("https://api.github.com");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.url.toString()).not.toContain(TOKEN);
  }
  expect(out.join("") + errOut.join("")).not.toContain(TOKEN);
  expect(allText(t.repo)).not.toContain(TOKEN);
  expect(allText(t.remote)).not.toContain(TOKEN);
}

describe("zenith github status", () => {
  it("reports origin, the default branch, the login, push access, the branch and its open pull request", async () => {
    const t = repoFor();
    t.git(["switch", "--quiet", "-c", "auto/demo/octocat"]);
    t.github.pulls.push({
      number: 4,
      url: "https://api.github.com/repos/o/r/pulls/4",
      html_url: "https://github.com/o/r/pull/4",
      state: "open",
      title: "demo",
      body: "",
      head: { ref: "auto/demo/octocat", sha: "h" },
      base: { ref: "main", sha: "b" },
    });

    const status = await githubStatus({ cwd: t.repo }, t.deps);
    expect(status).toEqual({
      ok: true,
      repo: { owner: "o", repo: "r", fullName: "o/r", url: "https://github.com/o/r" },
      defaultBranch: "main",
      login: "octocat",
      auth: "GH_TOKEN",
      canPush: true,
      branch: "auto/demo/octocat",
      pullRequest: { number: 4, url: "https://github.com/o/r/pull/4", base: "main", head: "auto/demo/octocat" },
      error: null,
      next: expect.stringContaining("zenith propose") as unknown as string,
    });
    expect(t.gh.calls).toEqual([]);
    expectTokenContained(t);
  });

  it("uses `gh auth token` when no token is in the environment", async () => {
    const t = repoFor({ env: { GH_TOKEN: undefined } });
    t.gh.answer = { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
    const status = await githubStatus({ cwd: t.repo }, t.deps);
    expect(status.ok).toBe(true);
    expect(status.auth).toBe("gh");
    expect(t.gh.calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    expectTokenContained(t);
  });

  it("says to run gh auth login when the GitHub CLI is installed but signed out", async () => {
    const t = repoFor({ env: { GH_TOKEN: undefined } });
    const code = await runGitHubStatus({ cwd: t.repo, json: true }, t.deps);
    expect(code).toBe(2);
    const status = JSON.parse(out.join("")) as { ok: boolean; repo: unknown; error: string; next: string };
    expect(status.ok).toBe(false);
    expect(status.repo).toEqual({ owner: "o", repo: "r", fullName: "o/r", url: "https://github.com/o/r" });
    expect(status.error).toContain("not signed in");
    expect(status.next).toContain("gh auth login");
    expect(t.github.calls).toEqual([]);
  });

  it("says to install the GitHub CLI when it is not there", async () => {
    const t = repoFor({ env: { GH_TOKEN: undefined } });
    t.gh.answer = "missing";
    const status = await githubStatus({ cwd: t.repo }, t.deps);
    expect(status.next).toContain("https://cli.github.com");
  });

  it("names the host, never the URL, when origin is not on github.com", async () => {
    const t = repoFor();
    t.git(["remote", "set-url", "origin", "https://someone:hunter2@example.com/o/r.git"]);
    const status = await githubStatus({ cwd: t.repo }, t.deps);
    expect(status.ok).toBe(false);
    expect(status.error).toContain("example.com");
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(status.next).toContain("git remote set-url origin");
  });

  it("says who to ask when the sign-in cannot push", async () => {
    const t = repoFor({ github: { canPush: false } });
    const status = await githubStatus({ cwd: t.repo }, t.deps);
    expect(status.ok).toBe(false);
    expect(status.canPush).toBe(false);
    expect(status.next).toContain("write access");
  });
});

describe("zenith propose", () => {
  it("commits the canonical auto and its render to auto/<name>/<login>, pushes and opens the pull request", async () => {
    const t = repoFor();
    const mainBefore = t.remoteRev("refs/heads/main");
    editDemo(t.repo, 0.6);

    const code = await runPropose("demo", { cwd: t.repo, json: true }, t.deps);
    expect(errOut.join("")).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      auto: "demo",
      repo: "o/r",
      base: "main",
      branch: "auto/demo/octocat",
      login: "octocat",
      mergedBase: false,
      pushed: true,
      pullRequest: { number: 1, url: "https://github.com/o/r/pull/1", created: true },
      errors: 0,
    });
    expect(result.files).toEqual(["autos/.renders/demo.svg", "autos/demo.auto.json"]);

    // The base is untouched; the work branch has one commit on it, with the app's message.
    expect(t.remoteRev("refs/heads/main")).toBe(mainBefore);
    const branchTip = t.remoteRev("refs/heads/auto/demo/octocat");
    expect(branchTip).toBe(result.commit);
    expect(t.git(["log", "--format=%s", "-1", branchTip ?? ""], t.remote)).toBe("auto(demo): edit");
    expect(t.git(["rev-parse", `${branchTip ?? ""}^`], t.remote)).toBe(mainBefore);
    expect(t.remoteFile("auto/demo/octocat", "autos/demo.auto.json")).toContain("0.6");
    expect(t.remoteFile("auto/demo/octocat", "autos/.renders/demo.svg")).toContain("<svg");
    // A fresh machine has no git identity; the commit is the GitHub account's, with its no-reply address.
    expect(t.git(["log", "--format=%an <%ae>", "-1", branchTip ?? ""], t.remote)).toBe(
      "octocat <583231+octocat@users.noreply.github.com>",
    );

    // The pull request body is the generated one, with the render's raw URL on the branch.
    const pull = t.github.pulls[0];
    expect(pull?.base.ref).toBe("main");
    expect(pull?.head.ref).toBe("auto/demo/octocat");
    expect(pull?.body).toContain("## demo");
    expect(pull?.body).toContain(
      "![render](https://raw.githubusercontent.com/o/r/auto/demo/octocat/autos/.renders/demo.svg)",
    );

    // The person's checkout is left as it was: still on main, with their edit still uncommitted.
    expect(t.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(t.git(["status", "--porcelain"])).toContain("autos/demo.auto.json");
    expect(t.git(["rev-parse", "refs/heads/auto/demo/octocat"])).toBe(branchTip);
    expectTokenContained(t);
  });

  it("a second propose adds a commit and updates the same pull request, never opening another", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const first = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!first.ok) throw new Error("first propose was blocked");
    editDemo(t.repo, 0.5);
    const second = await proposeToGitHub("demo", { cwd: t.repo, summary: "slower" }, t.deps);
    if (!second.ok) throw new Error("second propose was blocked");

    expect(second.pullRequest).toEqual({ number: 1, url: "https://github.com/o/r/pull/1", created: false });
    expect(t.github.pulls).toHaveLength(1);
    expect(t.github.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    const tip = t.remoteRev("refs/heads/auto/demo/octocat") ?? "";
    expect(t.git(["log", "--format=%s", "-1", tip], t.remote)).toBe("auto(demo): slower");
    expect(t.git(["rev-parse", `${tip}^`], t.remote)).toBe(first.commit);

    // Nothing changed since: the branch is not moved and the pull request body is refreshed.
    const third = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!third.ok) throw new Error("third propose was blocked");
    expect(third.commit).toBeNull();
    expect(third.pushed).toBe(false);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBe(tip);
  });

  it("merges the base in first when it has moved on", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const first = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!first.ok) throw new Error("blocked");

    // A teammate lands something else on main, from their own clone.
    const teammate = join(t.sandbox, "teammate");
    t.git(["clone", "--quiet", t.remote, teammate], t.sandbox);
    writeFileSync(join(teammate, "README.md"), "robot\n", "utf8");
    t.commitAll("Add a readme", teammate);
    t.git(["push", "--quiet", "origin", "main"], teammate);
    const main = t.remoteRev("refs/heads/main");

    editDemo(t.repo, 0.55);
    const second = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!second.ok) throw new Error("blocked");
    expect(second.mergedBase).toBe(true);
    expect(t.remoteRev("refs/heads/main")).toBe(main);
    const tip = t.remoteRev("refs/heads/auto/demo/octocat") ?? "";
    expect(t.git(["merge-base", "--is-ancestor", main ?? "", tip], t.remote)).toBe("");
    expect(t.remoteFile("auto/demo/octocat", "README.md")).toBe("robot");
  });

  it("stops on a merge conflict and names the files, pushing nothing", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const first = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!first.ok) throw new Error("blocked");
    const branchBefore = t.remoteRev("refs/heads/auto/demo/octocat");

    // Main changes the same lines another way.
    editDemo(t.repo, 0.4);
    t.commitAll("Retune demo on main");
    t.git(["push", "--quiet", "origin", "main"]);

    editDemo(t.repo, 0.7);
    const code = await runPropose("demo", { cwd: t.repo, json: true }, t.deps);
    expect(code).toBe(2);
    const failure = JSON.parse(out.join("")) as { error: string; next: string; files: string[] };
    expect(failure.files).toEqual(["autos/demo.auto.json"]);
    expect(failure.error).toContain("conflicts in autos/demo.auto.json");
    expect(failure.next).toContain("git merge origin/main");
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBe(branchBefore);
  });

  it("never force-pushes: a work branch that has moved on both sides is refused", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    await proposeToGitHub("demo", { cwd: t.repo }, t.deps);

    // Someone else pushes to the work branch from another clone.
    const other = join(t.sandbox, "other");
    t.git(["clone", "--quiet", "--branch", "auto/demo/octocat", t.remote, other], t.sandbox);
    writeFileSync(join(other, "autos", "notes.txt"), "theirs\n", "utf8");
    t.commitAll("Their change", other);
    t.git(["push", "--quiet", "origin", "auto/demo/octocat"], other);
    const theirs = t.remoteRev("refs/heads/auto/demo/octocat");

    // And this clone has a commit of its own on the same branch.
    const mine = t.git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "refs/heads/auto/demo/octocat",
      "-m",
      "mine",
    ]);
    t.git(["update-ref", "refs/heads/auto/demo/octocat", mine]);

    editDemo(t.repo, 0.5);
    await expect(proposeToGitHub("demo", { cwd: t.repo }, t.deps)).rejects.toThrow(NextStepError);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBe(theirs);
  });

  it("refuses to use the base branch as the work branch", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const main = t.remoteRev("refs/heads/main");
    await expect(proposeToGitHub("demo", { cwd: t.repo, branch: "main" }, t.deps)).rejects.toThrow(/never writes there/);
    expect(t.remoteRev("refs/heads/main")).toBe(main);
  });

  it("refuses a changed waypoints file outside the directories zenith.json declares", async () => {
    const t = repoFor({ link: { waypoints: "config/waypoints.json" } });
    const path = join(t.repo, "config", "waypoints.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("-30", "-31"), "utf8");
    editDemo(t.repo, 0.6);
    await expect(proposeToGitHub("demo", { cwd: t.repo }, t.deps)).rejects.toThrow(/config\/waypoints\.json is outside/);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBeNull();
  });

  it("blocks on an error finding before any git or GitHub call", async () => {
    const t = repoFor();
    writeAuto(t.repo, "autos", "demo", simpleAuto("demo", {
      start: { pose: { xIn: -20, yIn: 0, headingRad: 0 } },
      steps: [{ id: "throughWall", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 0 } }], heading: { mode: "tangent" } }],
    }));
    const code = await runPropose("demo", { cwd: t.repo, json: true }, t.deps);
    expect(code).toBe(1);
    expect(t.github.calls).toEqual([]);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBeNull();
  });

  it("says how to get the project onto the base when zenith.json is not there yet", async () => {
    const t = repoFor({ project: false });
    makeProject(t.repo);
    writeAuto(t.repo, "autos", "first", simpleAuto("first"));
    const error = await proposeToGitHub("first", { cwd: t.repo }, t.deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NextStepError);
    expect((error as NextStepError).problem).toContain("zenith.json is not on main");
    expect((error as NextStepError).next).toContain("commit zenith.json");
    expect(t.remoteRev("refs/heads/auto/first/octocat")).toBeNull();
  });

  it("fast-forwards the work branch when it is the one checked out", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    t.git(["checkout", "--quiet", "-f", "auto/demo/octocat"]);
    editDemo(t.repo, 0.45);
    const result = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!result.ok) throw new Error("blocked");
    expect(t.git(["rev-parse", "HEAD"])).toBe(result.commit);
    expect(t.git(["status", "--porcelain"])).toBe("");
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBe(result.commit);
  });

  it("on the checked-out work branch, refuses to overwrite a staged version that differs from the file on disk", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const first = await proposeToGitHub("demo", { cwd: t.repo }, t.deps);
    if (!first.ok) throw new Error("blocked");
    t.git(["checkout", "--quiet", "-f", "auto/demo/octocat"]);
    editDemo(t.repo, 0.45);
    t.git(["add", "autos/demo.auto.json"]);
    editDemo(t.repo, 0.3);

    const error = await proposeToGitHub("demo", { cwd: t.repo }, t.deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NextStepError);
    expect((error as NextStepError).problem).toContain("has staged changes that differ from the file on disk");
    // The staged version is still there, and nothing moved or was pushed.
    expect(t.git(["show", ":autos/demo.auto.json"])).toContain("0.45");
    expect(t.git(["rev-parse", "HEAD"])).toBe(first.commit);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBe(first.commit);
  });

  it("does not overwrite a work branch another run created after this one looked", async () => {
    const t = repoFor();
    editDemo(t.repo, 0.6);
    const mainTip = t.git(["rev-parse", "main"]);
    // Another zenith propose of the same auto creates the local branch between this run's lookup
    // and its update-ref.
    const run = t.deps.run;
    if (run === undefined) throw new Error("the harness always supplies a runner");
    let raced = false;
    const deps = {
      ...t.deps,
      run: async (command: string, args: readonly string[], options?: Parameters<typeof run>[2]) => {
        if (command === "git" && args[0] === "update-ref" && !raced) {
          raced = true;
          t.git(["update-ref", "refs/heads/auto/demo/octocat", mainTip]);
        }
        return run(command, args, options);
      },
    };

    const error = await proposeToGitHub("demo", { cwd: t.repo }, deps).catch((caught: unknown) => caught);
    expect(raced).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(t.git(["rev-parse", "refs/heads/auto/demo/octocat"])).toBe(mainTip);
    expect(t.remoteRev("refs/heads/auto/demo/octocat")).toBeNull();
  });
});

describe("zenith setup", () => {
  it("in a fresh clone: runs init, adds the MCP server next to the others, checks GitHub and says what is next", async () => {
    const t = repoFor({ project: false });
    writeFileSync(join(t.repo, ".mcp.json"), `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2)}\n`, "utf8");

    const code = await runSetup({ cwd: t.repo, json: true }, t.deps);
    const result = JSON.parse(out.join("")) as {
      ok: boolean;
      init: { ran: boolean; written: { path: string }[] };
      mcp: { status: string };
      github: { ok: boolean; login: string };
      projectOnGitHub: boolean | null;
      next: string;
      notes: string[];
    };
    expect(code).toBe(2);
    expect(result.init.ran).toBe(true);
    expect(result.init.written.map((file) => file.path)).toContain("zenith.json");
    expect(existsSync(join(t.repo, "zenith.json"))).toBe(true);
    expect(result.mcp.status).toBe("added");
    const mcp = JSON.parse(readFileSync(join(t.repo, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["other", "zenith"]);
    expect(mcp.mcpServers.zenith).toEqual({ command: "npx", args: ["-y", "@horizon36596/zenith-mcp"] });
    expect(result.github.ok).toBe(true);
    expect(result.github.login).toBe("octocat");
    expect(result.projectOnGitHub).toBe(false);
    expect(result.next).toContain("onto main");
    expect(result.notes.join(" ")).toContain("Restart the agent");

    // Run again: nothing is rewritten.
    out = [];
    const again = await setup({ cwd: t.repo }, t.deps);
    expect(again.init.ran).toBe(false);
    expect(again.mcp.status).toBe("kept");
    expectTokenContained(t);
  });

  it("in a clone whose project is on GitHub: ready, and the next step is to edit and propose", async () => {
    const t = repoFor({ github: { zenithOnMain: true } });
    const result = await setup({ cwd: t.repo }, t.deps);
    expect(result.ok).toBe(true);
    expect(result.mcp.status).toBe("written");
    expect(result.autos).toEqual([{ name: "demo", path: "autos/demo.auto.json", errors: 0, warnings: expect.any(Number) as unknown as number }]);
    expect(result.next).toContain("zenith propose");
  });

  it("never touches a .mcp.json that is not JSON", async () => {
    const t = repoFor({ github: { zenithOnMain: true } });
    writeFileSync(join(t.repo, ".mcp.json"), "{ not json", "utf8");
    const result = await setup({ cwd: t.repo }, t.deps);
    expect(result.mcp.status).toBe("invalid");
    expect(readFileSync(join(t.repo, ".mcp.json"), "utf8")).toBe("{ not json");
    expect(result.ok).toBe(false);
    expect(result.next).toContain(".mcp.json");
  });

  it("outside git, says to run it in a clone", async () => {
    const t = repoFor({ github: { zenithOnMain: true } });
    const result = await setup({ cwd: t.sandbox, project: t.sandbox }, { ...t.deps, env: { ...t.env, GIT_CEILING_DIRECTORIES: t.sandbox } });
    expect(result.github.ok).toBe(false);
    expect(result.next).toContain("clone");
  });
});
