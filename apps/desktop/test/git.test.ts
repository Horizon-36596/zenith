import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitMissingError,
  GitService,
  PUSH_TIMEOUT_MS,
  assertNotBase,
  execGit,
  commitMessage,
  gitArgv,
  guardArgv,
  parseGitHubRemote,
  parsePorcelain,
  workBranchName,
  type GitOutput,
} from "../src/main/git.js";
import { cleanProject, exampleProject, patchAuto } from "./support.js";

let root = "";
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ root, cleanup } = exampleProject());
});

afterEach(() => {
  cleanup();
});

const ok = (stdout = ""): GitOutput => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): GitOutput => ({ code: 1, stdout: "", stderr });

/**
 * A scripted git: `branch` is what HEAD reports, `switch` moves it, and every argv is recorded so a
 * test can assert exactly what would have run.
 */
function fakeGit(options: {
  branch: string | null;
  base?: string;
  /** When false, `git switch` "succeeds" but leaves HEAD where it was. */
  switchMoves?: boolean;
  staged?: boolean;
  remote?: string | null;
  ahead?: number | null;
  push?: GitOutput;
  status?: string;
  /** What `git rev-parse --show-prefix` prints: the project's folder inside the repository. */
  prefix?: string;
}) {
  const calls: string[][] = [];
  let branch = options.branch;
  const base = options.base ?? "main";
  const run = vi.fn(async (args: readonly string[]): Promise<GitOutput> => {
    calls.push([...args]);
    const key = args.join(" ");
    if (key === gitArgv.isRepo().join(" ")) return ok("true\n");
    if (key === gitArgv.currentBranch().join(" ")) return branch === null ? fail() : ok(`${branch}\n`);
    if (key === gitArgv.originHead().join(" ")) return ok(`origin/${base}\n`);
    if (args[0] === "check-ref-format") return ok(`${args[2] ?? ""}\n`);
    if (args[0] === "rev-parse" && args[1] === "--verify") return fail();
    if (args[0] === "switch") {
      if (options.switchMoves !== false) branch = args[1] === "-c" ? (args[2] ?? null) : (args[1] ?? null);
      return ok();
    }
    if (key === gitArgv.remoteUrl().join(" ")) {
      return options.remote === null ? fail("no remote") : ok(`${options.remote ?? "https://github.com/example-team/robot.git"}\n`);
    }
    if (key === gitArgv.status().join(" ")) return ok(options.status ?? " M autos/first-auto.auto.json\0?? notes.txt\0");
    if (args[0] === "rev-parse" && args[1] === "--show-prefix") return ok(`${options.prefix ?? ""}\n`);
    if (args[0] === "rev-list") return options.ahead === null ? fail() : ok(`${String(options.ahead ?? 0)}\n`);
    if (args[0] === "diff" && args[1] === "--cached") return options.staged === false ? ok() : fail();
    if (args[0] === "push") return options.push ?? ok();
    if (key === gitArgv.head().join(" ")) return ok("0123456789abcdef\n");
    if (args[0] === "cat-file") return ok();
    return ok();
  });
  return { run, calls, branch: () => branch };
}

const commits = (calls: string[][]) => calls.filter((args) => args[0] === "commit");
const pushes = (calls: string[][]) => calls.filter((args) => args[0] === "push");

describe("the rules as pure functions", () => {
  it("writes the 06 commit message", () => {
    expect(commitMessage("first-auto", "")).toBe("auto(first-auto): edit");
    expect(commitMessage("first-auto", "  score the\npreload sooner  ")).toBe("auto(first-auto): score the preload sooner");
  });

  it("names the work branch auto/<name>/<who>", () => {
    expect(workBranchName("first-auto", "octo-member")).toBe("auto/first-auto/octo-member");
    expect(workBranchName("first-auto", "Example Member")).toBe("auto/first-auto/example-member");
    expect(workBranchName("first-auto", "!!!")).toBe("auto/first-auto/zenith");
  });

  it("never lets a force push or a hook skip through", () => {
    expect(() => guardArgv(["push", "--force", "origin", "x"])).toThrow(/never force/);
    expect(() => guardArgv(["push", "-f", "origin", "x"])).toThrow(/never force/);
    expect(() => guardArgv(["push", "--force-with-lease", "origin", "x"])).toThrow(/never force/);
    expect(() => guardArgv(["push", "origin", "+refs/heads/x:refs/heads/x"])).toThrow(/never force/);
    expect(() => guardArgv(["push", "origin", "refs/heads/x:+refs/heads/x"])).toThrow(/never force/);
    expect(() => guardArgv(["commit", "--no-verify", "-m", "x"])).toThrow(/hooks/);
    expect(guardArgv(gitArgv.push("auto/first-auto/me"))).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "refs/heads/auto/first-auto/me:refs/heads/auto/first-auto/me",
    ]);
  });

  it("refuses the base branch and a detached HEAD", () => {
    expect(() => assertNotBase("main", "main")).toThrow(/never commits to or pushes main/);
    expect(() => assertNotBase(null, "main")).toThrow(/detached/);
    expect(assertNotBase("auto/x/me", "main")).toBe("auto/x/me");
  });

  it("reads GitHub remotes and porcelain status", () => {
    expect(parseGitHubRemote("https://github.com/example-team/robot.git")).toEqual({ owner: "example-team", repo: "robot" });
    expect(parseGitHubRemote("git@github.com:example-team/robot.git")).toEqual({ owner: "example-team", repo: "robot" });
    expect(parseGitHubRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(parsePorcelain(" M autos/a.auto.json\0R  autos/new.auto.json\0autos/old.auto.json\0?? x\0")).toEqual([
      { status: " M", path: "autos/a.auto.json" },
      { status: "R ", path: "autos/new.auto.json" },
      { status: "??", path: "x" },
    ]);
  });
});

describe("commit", () => {
  it("moves off the base branch to the work branch before it commits, and stages only the auto and its render", async () => {
    const git = fakeGit({ branch: "main" });
    const service = new GitService({ run: git.run, login: async () => "octo-member" });
    const result = await service.commit(root, "first-auto.auto.json", "score the preload sooner");

    const switchAt = git.calls.findIndex((args) => args[0] === "switch");
    const commitAt = git.calls.findIndex((args) => args[0] === "commit");
    expect(git.calls[switchAt]).toEqual(["switch", "-c", "auto/first-auto/octo-member"]);
    expect(switchAt).toBeLessThan(commitAt);
    expect(commits(git.calls)).toEqual([
      ["commit", "-m", "auto(first-auto): score the preload sooner", "--", "autos/first-auto.auto.json", "autos/.renders/first-auto.svg"],
    ]);
    expect(git.calls.find((args) => args[0] === "add")).toEqual(["add", "--", "autos/first-auto.auto.json", "autos/.renders/first-auto.svg"]);
    expect(result).toMatchObject({ branch: "auto/first-auto/octo-member", createdBranch: true, sha: "0123456789abcdef" });
    expect(existsSync(join(root, "autos", ".renders", "first-auto.svg"))).toBe(true);
  });

  it("never commits when HEAD is still the base after the switch", async () => {
    const git = fakeGit({ branch: "main", switchMoves: false });
    const service = new GitService({ run: git.run, login: async () => "octo-member" });
    await expect(service.commit(root, "first-auto.auto.json", "")).rejects.toThrow(/never commits to or pushes main/);
    expect(commits(git.calls)).toEqual([]);
    expect(git.calls.some((args) => args[0] === "add")).toBe(false);
  });

  it("commits in place on a work branch, with the waypoints when they changed", async () => {
    const git = fakeGit({ branch: "auto/first-auto/octo-member", status: " M autos/first-auto.auto.json\0 M autos/waypoints.json\0" });
    const service = new GitService({ run: git.run });
    const result = await service.commit(root, "first-auto.auto.json", "");
    expect(git.calls.some((args) => args[0] === "switch")).toBe(false);
    expect(commits(git.calls)[0]).toEqual([
      "commit",
      "-m",
      "auto(first-auto): edit",
      "--",
      "autos/first-auto.auto.json",
      "autos/.renders/first-auto.svg",
      "autos/waypoints.json",
    ]);
    expect(result.createdBranch).toBe(false);
  });

  it("says so when there is nothing to commit", async () => {
    const git = fakeGit({ branch: "auto/first-auto/me", staged: false });
    await expect(new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "")).rejects.toThrow(/Nothing to commit/);
    expect(commits(git.calls)).toEqual([]);
  });

  it("commits nothing, not even the render, when the auto is the same as in the last commit", async () => {
    const git = fakeGit({ branch: "main", status: " M autos/other.auto.json\0?? notes.txt\0" });
    await expect(new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "")).rejects.toThrow(
      /Nothing to commit: first-auto.auto.json is the same as in the last commit/,
    );
    // Refused before anything moved: no branch switch, nothing staged, no commit.
    expect(git.calls.filter((args) => args[0] === "switch" || args[0] === "add")).toEqual([]);
    expect(commits(git.calls)).toEqual([]);
    expect(existsSync(join(root, "autos", ".renders", "first-auto.svg"))).toBe(false);
  });

  it("refuses a detached HEAD", async () => {
    const git = fakeGit({ branch: null });
    await expect(new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "")).rejects.toThrow(/detached/);
  });

  it("matches git's repository-relative status paths for a project in a subfolder (issue #406)", async () => {
    const git = fakeGit({
      branch: "auto/first-auto/me",
      prefix: "planner/",
      status: " M planner/autos/first-auto.auto.json\0 M planner/autos/waypoints.json\0 M autos/first-auto.auto.json\0",
    });
    const service = new GitService({ run: git.run });
    await service.commit(root, "first-auto.auto.json", "");
    // Staged from the project folder, which is where git runs, so the paths stay project-relative.
    expect(commits(git.calls)[0]).toEqual([
      "commit",
      "-m",
      "auto(first-auto): edit",
      "--",
      "autos/first-auto.auto.json",
      "autos/.renders/first-auto.svg",
      "autos/waypoints.json",
    ]);
    const status = await service.status(root, "first-auto.auto.json");
    // `autos/first-auto.auto.json` at the top of the repository is another project's, not this one's.
    expect(status.changedAutos).toEqual([{ status: " M", path: "autos/first-auto.auto.json" }]);
    expect(status.otherChanges).toBe(2);
  });

  it("refuses a .renders that is a link, and writes nothing through it (issue #406)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-outside-"));
    try {
      // A junction on Windows needs no privilege; elsewhere a directory symlink does the same job.
      // It points inside the repository, so only the link check, not the confinement, refuses it.
      const inside = join(root, "elsewhere");
      mkdirSync(inside);
      symlinkSync(inside, join(root, "autos", ".renders"), process.platform === "win32" ? "junction" : "dir");
      const git = fakeGit({ branch: "auto/first-auto/me" });
      await expect(new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "")).rejects.toThrow(/\.renders is a link/);
      expect(existsSync(join(inside, "first-auto.svg"))).toBe(false);
      expect(commits(git.calls)).toEqual([]);

      // And one that leads out of the repository is refused by the confinement.
      rmSync(join(root, "autos", ".renders"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "autos", ".renders"), process.platform === "win32" ? "junction" : "dir");
      await expect(new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "")).rejects.toThrow(/through a link/);
      expect(existsSync(join(outside, "first-auto.svg"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces a link at the render's own name instead of writing through it (issue #406)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-outside-"));
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "outside", "utf8");
    try {
      mkdirSync(join(root, "autos", ".renders"));
      const svg = join(root, "autos", ".renders", "first-auto.svg");
      try {
        symlinkSync(victim, svg, "file");
      } catch {
        // A file symlink needs privilege on Windows; without one there is nothing to check here.
        return;
      }
      const git = fakeGit({ branch: "auto/first-auto/me" });
      await new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "");
      expect(readFileSync(victim, "utf8")).toBe("outside");
      expect(readFileSync(svg, "utf8")).toContain("<svg");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces a directory link at the render's own name, and leaves what it led to alone (issue #453)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-outside-"));
    const kept = join(outside, "kept.txt");
    writeFileSync(kept, "outside", "utf8");
    try {
      mkdirSync(join(root, "autos", ".renders"));
      const svg = join(root, "autos", ".renders", "first-auto.svg");
      // A junction on Windows needs no privilege, unlike a file symlink; elsewhere a directory
      // symlink does the same job.
      symlinkSync(outside, svg, process.platform === "win32" ? "junction" : "dir");
      const git = fakeGit({ branch: "auto/first-auto/me" });
      await new GitService({ run: git.run }).commit(root, "first-auto.auto.json", "");
      expect(lstatSync(svg).isSymbolicLink()).toBe(false);
      expect(readFileSync(svg, "utf8")).toContain("<svg");
      expect(readFileSync(kept, "utf8")).toBe("outside");
      expect(readdirSync(outside)).toEqual(["kept.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a project in a subfolder of a real repository (issue #406)", () => {
  let repo = "";
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "zenith-desktop-repo-"));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const out = await execGit(args, cwd);
    if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
    return out.stdout;
  };

  it("sees the saved auto as changed and commits it", { timeout: 30_000 }, async () => {
    const project = join(repo, "planner");
    cpSync(root, project, { recursive: true });
    await git(repo, "init", "-q", "-b", "auto/first-auto/me");
    await git(repo, "config", "user.name", "Zenith Test");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "commit.gpgsign", "false");
    await git(repo, "config", "core.autocrlf", "false");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "chore: the robot repository");
    patchAuto(project, "first-auto.auto.json", (auto) => {
      auto["title"] = "Edited in a subfolder";
    });

    const service = new GitService();
    const status = await service.status(project, "first-auto.auto.json");
    expect(status.changedAutos.map((file) => file.path)).toEqual(["autos/first-auto.auto.json"]);
    const result = await service.commit(project, "first-auto.auto.json", "subfolder");
    expect(result.files).toEqual(["autos/first-auto.auto.json", "autos/.renders/first-auto.svg"]);
    const committed = (await git(repo, "show", "--name-only", "--format=", "HEAD")).split(/\r?\n/).filter(Boolean);
    expect(committed.sort()).toEqual(["planner/autos/.renders/first-auto.svg", "planner/autos/first-auto.auto.json"]);
  });
});

describe("push", () => {
  it("refuses to push the base branch and never runs git push for it", async () => {
    const git = fakeGit({ branch: "main" });
    await expect(new GitService({ run: git.run }).push(root)).rejects.toThrow(/never commits to or pushes main/);
    expect(pushes(git.calls)).toEqual([]);
  });

  it("pushes the work branch to the same name, without force", async () => {
    const git = fakeGit({ branch: "auto/first-auto/me" });
    await new GitService({ run: git.run }).push(root);
    expect(pushes(git.calls)).toEqual([["push", "--set-upstream", "origin", "refs/heads/auto/first-auto/me:refs/heads/auto/first-auto/me"]]);
  });

  it("turns a rejected push into advice, not a force", async () => {
    const git = fakeGit({ branch: "auto/first-auto/me", push: fail(" ! [rejected] (fetch first)") });
    await expect(new GitService({ run: git.run }).push(root)).rejects.toThrow(/Pull them first/);
    expect(pushes(git.calls)).toHaveLength(1);
  });

  it("gives the push a time limit, and says so when it runs out", async () => {
    const git = fakeGit({ branch: "auto/first-auto/me", push: { code: 1, stdout: "", stderr: "", timedOut: true } });
    await expect(new GitService({ run: git.run }).push(root)).rejects.toThrow(
      "The push took too long, so Zenith stopped it. Check the connection and try again.",
    );
    const call = git.run.mock.calls.find(([args]) => args[0] === "push") as unknown as [string[], string, { timeoutMs?: number }];
    expect(call[2]).toEqual({ timeoutMs: PUSH_TIMEOUT_MS });
  });

  it("says GitHub could not be reached when there is no network", async () => {
    const git = fakeGit({ branch: "auto/first-auto/me", push: fail("fatal: unable to access 'https://github.com/example-team/robot.git/': Could not resolve host: github.com") });
    await expect(new GitService({ run: git.run }).push(root)).rejects.toThrow("Could not reach GitHub. Check the connection and try again.");
  });
});

describe("without git", () => {
  it("says git is missing, not that the folder is not a repository", async () => {
    const run = vi.fn(async (): Promise<GitOutput> => {
      throw new GitMissingError();
    });
    await expect(new GitService({ run }).status(root, "first-auto.auto.json")).rejects.toThrow(
      "Git is not installed on this computer, so Zenith cannot commit. Install Git for Windows from git-scm.com, then reopen this panel.",
    );
  });
});

describe("openPullRequest", () => {
  const deps = () => ({
    token: vi.fn(async () => "ghp_test"),
    openOrUpdate: vi.fn(async () => ({ url: "https://github.com/example-team/robot/pull/7", number: 7, created: true })),
  });

  it("blocks on validation errors before touching git or GitHub", async () => {
    // The example validates clean, so this copy moves driveOut's end off the field.
    patchAuto(root, "first-auto.auto.json", (auto) => {
      const steps = auto.steps as Array<{ id: string; segments?: Array<{ to: unknown }> }>;
      const step = steps.find((candidate) => candidate.id === "driveOut");
      if (step?.segments?.[0] === undefined) throw new Error("driveOut has no segment");
      step.segments[0].to = { xIn: -80, yIn: -36, headingRad: 1.5708 };
    });
    const git = fakeGit({ branch: "auto/first-auto/me", ahead: 1, status: "?? notes.txt\0" });
    const d = deps();
    await expect(new GitService({ run: git.run }).openPullRequest(root, "first-auto.auto.json", d)).rejects.toThrow(/Validation has \d+ errors?/);
    expect(d.openOrUpdate).not.toHaveBeenCalled();
    expect(pushes(git.calls)).toEqual([]);
  });

  describe("with an auto that validates", () => {
    let clean = "";
    let cleanCleanup: () => void = () => undefined;
    beforeEach(async () => {
      ({ root: clean, cleanup: cleanCleanup } = await cleanProject());
    });
    afterEach(() => {
      cleanCleanup();
    });

    it("refuses to open a pull request from the base branch", async () => {
      const git = fakeGit({ branch: "main" });
      const d = deps();
      await expect(new GitService({ run: git.run }).openPullRequest(clean, "demo.auto.json", d)).rejects.toThrow(/never commits to or pushes main/);
      expect(d.openOrUpdate).not.toHaveBeenCalled();
    });

    it("pushes when the remote is behind, then opens the PR into the base with core's body and the committed render", async () => {
      const git = fakeGit({ branch: "auto/demo/me", ahead: 1 });
      const d = deps();
      const result = await new GitService({ run: git.run }).openPullRequest(clean, "demo.auto.json", d);
      expect(pushes(git.calls)).toHaveLength(1);
      expect(d.openOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "ghp_test",
          owner: "example-team",
          repo: "robot",
          head: "auto/demo/me",
          base: "main",
          title: "demo",
          body: expect.stringContaining("https://raw.githubusercontent.com/example-team/robot/auto/demo/me/autos/.renders/demo.svg"),
        }),
      );
      const body = (d.openOrUpdate.mock.calls[0] as unknown as [{ body: string }])[0].body;
      expect(body).toContain("## demo");
      expect(result.number).toBe(7);
    });

    it("refuses while the auto differs from the last commit, since the pull request holds only commits (issue #406)", async () => {
      for (const status of [" M autos/demo.auto.json\0", "?? autos/demo.auto.json\0", "M  autos/demo.auto.json\0"]) {
        const git = fakeGit({ branch: "auto/demo/me", ahead: 1, status });
        const d = deps();
        await expect(new GitService({ run: git.run }).openPullRequest(clean, "demo.auto.json", d)).rejects.toThrow(/not committed/);
        expect(pushes(git.calls)).toEqual([]);
        expect(d.openOrUpdate).not.toHaveBeenCalled();
      }
    });

    it("names the render from the top of the repository for a project in a subfolder (issue #406)", async () => {
      const git = fakeGit({ branch: "auto/demo/me", prefix: "planner/", status: " M autos/demo.auto.json\0" });
      const d = deps();
      await new GitService({ run: git.run }).openPullRequest(clean, "demo.auto.json", d);
      expect(git.calls).toContainEqual(["cat-file", "-e", "HEAD:planner/autos/.renders/demo.svg"]);
      const body = (d.openOrUpdate.mock.calls[0] as unknown as [{ body: string }])[0].body;
      expect(body).toContain("https://raw.githubusercontent.com/example-team/robot/auto/demo/me/planner/autos/.renders/demo.svg");
    });

    it("compares HEAD with origin's copy of the branch, not the configured upstream (issue #406)", async () => {
      const git = fakeGit({ branch: "auto/demo/me", ahead: 0 });
      await new GitService({ run: git.run }).openPullRequest(clean, "demo.auto.json", deps());
      expect(git.calls).toContainEqual(["rev-list", "--count", "refs/remotes/origin/auto/demo/me..HEAD"]);
      expect(pushes(git.calls)).toEqual([]);

      // Origin has no copy of the branch yet: rev-list fails, and the branch is pushed.
      const unpushed = fakeGit({ branch: "auto/demo/me", ahead: null });
      await new GitService({ run: unpushed.run }).openPullRequest(clean, "demo.auto.json", deps());
      expect(pushes(unpushed.calls)).toHaveLength(1);
    });
  });
});
