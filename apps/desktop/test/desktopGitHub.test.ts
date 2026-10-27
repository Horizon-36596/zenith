/**
 * Issue #213: signing GitHub mode in with the GitHub CLI, the clone's GitHub origin, and the folder
 * `zenith open` asks the app for. A fake `gh` and a fake git stand in for the real ones; the open
 * requests run against a throwaway copy of examples/starter.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GH_TOKEN_ARGV, ghCliStatus, ghCliToken, ghRunner, ghRunnerFromEnv, execGh, readGhCli, type GhOutput } from "../src/main/ghCli.js";
import { GitHubAuth } from "../src/main/github.js";
import { GitService, gitArgv, samePath, type GitOutput } from "../src/main/git.js";
import { AUTO_SWITCH, OPEN_SWITCH, openArgsFromData, openData, parseOpenArgs, resolveOpenRequest } from "../src/main/openRequest.js";
import { exampleProject } from "./support.js";

const TOKEN = "gho_0123456789abcdefghijABCDEFGHIJ";

/** A fake `gh` that answers `auth token` the way the real one does in each state. */
function fakeGh(state: "ready" | "signed-out" | "missing" | "noisy") {
  const calls: string[][] = [];
  const run = vi.fn(async (args: readonly string[]): Promise<GhOutput> => {
    calls.push([...args]);
    if (state === "missing") return { code: "missing", stdout: "" };
    if (state === "signed-out") return { code: 1, stdout: "" };
    if (state === "noisy") return { code: 0, stdout: "warning: something went wrong\n" };
    return { code: 0, stdout: `${TOKEN}\n` };
  });
  return { run, calls };
}

describe("the GitHub CLI's sign-in", () => {
  it("runs exactly gh auth token for github.com, and nothing else", async () => {
    const gh = fakeGh("ready");
    await ghCliStatus(gh.run);
    await ghCliToken(gh.run);
    expect(GH_TOKEN_ARGV).toEqual(["auth", "token", "--hostname", "github.com"]);
    expect(gh.calls).toEqual([[...GH_TOKEN_ARGV], [...GH_TOKEN_ARGV]]);
  });

  it("reports the CLI ready without handing over the token, and hands it over on the token call", async () => {
    const gh = fakeGh("ready");
    const status = await ghCliStatus(gh.run);
    expect(status).toEqual({ state: "ready" });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(await ghCliToken(gh.run)).toBe(TOKEN);
  });

  it("tells signed out from missing, and says what to do in each", async () => {
    expect(await ghCliStatus(fakeGh("signed-out").run)).toEqual({ state: "signed-out" });
    expect(await ghCliStatus(fakeGh("missing").run)).toEqual({ state: "missing" });
    await expect(ghCliToken(fakeGh("signed-out").run)).rejects.toThrow(/gh auth login/);
    await expect(ghCliToken(fakeGh("missing").run)).rejects.toThrow(/not installed/);
  });

  it("never treats something gh printed that is not a token as one", async () => {
    expect(await readGhCli(fakeGh("noisy").run)).toEqual({ status: { state: "signed-out" }, token: null });
    const throwing = async (): Promise<GhOutput> => {
      throw new Error("spawn failed");
    };
    expect(await readGhCli(throwing)).toEqual({ status: { state: "missing" }, token: null });
  });

  it("reaches a fake gh only in a windowless test run", () => {
    const env = { ZENITH_TEST_GH: "C:/fake-gh.cjs" };
    expect(ghRunnerFromEnv(env, false, "electron.exe")).toBe(execGh);
    expect(ghRunnerFromEnv({}, true, "electron.exe")).toBe(execGh);
    expect(ghRunnerFromEnv(env, true, "electron.exe")).not.toBe(execGh);
  });

  it("runs a real fake gh script end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-fake-gh-"));
    try {
      const script = join(dir, "gh.cjs");
      writeFileSync(
        script,
        [
          "const args = process.argv.slice(2).join(' ');",
          `if (args === 'auth token --hostname github.com') { process.stdout.write('${TOKEN}\\n'); process.exit(0); }`,
          "process.exit(4);",
        ].join("\n"),
        "utf8",
      );
      expect(await ghCliToken(ghRunner(process.execPath, [script]))).toBe(TOKEN);
      expect(await ghCliStatus(ghRunner(join(dir, "no-such-gh.exe")))).toEqual({ state: "missing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what the Commit panel falls back on when no token was pasted", async () => {
    const auth = new GitHubAuth({
      box: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" },
      slot: { get: () => null, set: () => undefined },
      ghToken: async () => (await readGhCli(fakeGh("ready").run)).token,
      whoAmI: async () => "octocat",
    });
    expect(await auth.current()).toEqual({ token: TOKEN, source: "gh" });
  });
});

describe("a clone's GitHub origin", () => {
  const ok = (stdout = ""): GitOutput => ({ code: 0, stdout, stderr: "" });
  const fail = (): GitOutput => ({ code: 1, stdout: "", stderr: "" });

  function fakeGit(root: string, options: { repo?: boolean; top?: string; remote?: string | null; originHead?: string | null }) {
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]): Promise<GitOutput> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key === gitArgv.isRepo().join(" ")) return options.repo === false ? fail() : ok("true\n");
      if (key === gitArgv.topLevel().join(" ")) return ok(`${(options.top ?? root).split("\\").join("/")}\n`);
      if (key === gitArgv.remoteUrl().join(" ")) return options.remote === null ? fail() : ok(`${options.remote ?? "git@github.com:example-team/robot.git"}\n`);
      if (key === gitArgv.originHead().join(" ")) return options.originHead === null ? fail() : ok(`origin/${options.originHead ?? "main"}\n`);
      if (args[0] === "rev-parse" && args[1] === "--verify") return args[3] === "refs/heads/master" ? ok() : fail();
      return ok();
    });
    return { run, calls };
  }

  let root = "";
  let cleanup: () => void = () => undefined;
  beforeEach(() => {
    ({ root, cleanup } = exampleProject());
  });
  afterEach(() => {
    cleanup();
  });

  it("reads owner, repo and the remote's default branch, running nothing that writes", async () => {
    const git = fakeGit(root, { originHead: "develop" });
    expect(await new GitService({ run: git.run }).githubOrigin(root)).toEqual({ owner: "example-team", repo: "robot", base: "develop" });
    const verbs = new Set(git.calls.map((args) => args[0]));
    expect([...verbs].sort()).toEqual(["remote", "rev-parse", "symbolic-ref"]);
  });

  it("falls back to master when the remote names no default and master exists", async () => {
    const git = fakeGit(root, { remote: "https://github.com/example-team/robot", originHead: null });
    expect(await new GitService({ run: git.run }).githubOrigin(root)).toEqual({ owner: "example-team", repo: "robot", base: "master" });
  });

  it("offers nothing for a folder that is not a clone, has no origin, or whose origin is not GitHub", async () => {
    expect(await new GitService({ run: fakeGit(root, { repo: false }).run }).githubOrigin(root)).toBeNull();
    expect(await new GitService({ run: fakeGit(root, { remote: null }).run }).githubOrigin(root)).toBeNull();
    expect(await new GitService({ run: fakeGit(root, { remote: "https://gitlab.com/team/robot.git" }).run }).githubOrigin(root)).toBeNull();
  });

  it("offers nothing for a project in a subfolder of the repository, which GitHub mode cannot open", async () => {
    const git = fakeGit(root, { top: join(root, "..") });
    expect(await new GitService({ run: git.run }).githubOrigin(root)).toBeNull();
  });

  it("compares folders the way the operating system does", () => {
    expect(samePath(root.split("\\").join("/"), root)).toBe(true);
    expect(samePath(`${root}/`, root)).toBe(true);
    expect(samePath("", root)).toBe(false);
    expect(samePath(join(root, ".."), root)).toBe(false);
  });
});

describe("zenith open's request", () => {
  const cwd = join(tmpdir(), "zenith-open-cwd");

  it("reads only its own two switches, resolving the folder against the launching directory", () => {
    expect(parseOpenArgs(["Zenith.exe", "--inspect", `${OPEN_SWITCH}robot`, `${AUTO_SWITCH}close-cycle`], cwd)).toEqual({
      dir: join(cwd, "robot"),
      auto: "close-cycle.auto.json",
    });
    expect(parseOpenArgs(["electron", ".", `${OPEN_SWITCH}${cwd}`, `${AUTO_SWITCH}first-auto.auto.json`], "C:/elsewhere")).toEqual({
      dir: cwd,
      auto: "first-auto.auto.json",
    });
    expect(parseOpenArgs(["Zenith.exe"], cwd)).toBeNull();
  });

  it("refuses a URL, two folders, an empty one, or an auto name that is not one", () => {
    expect(parseOpenArgs([`${OPEN_SWITCH}https://evil.example/robot`], cwd)).toBeNull();
    expect(parseOpenArgs([`${OPEN_SWITCH}file:///C:/Windows`], cwd)).toBeNull();
    expect(parseOpenArgs([`${OPEN_SWITCH}a`, `${OPEN_SWITCH}b`], cwd)).toBeNull();
    expect(parseOpenArgs([OPEN_SWITCH], cwd)).toBeNull();
    expect(parseOpenArgs([`${OPEN_SWITCH}robot`, `${AUTO_SWITCH}../../secret`], cwd)).toBeNull();
  });

  it("crosses to the running app only as its own checked shape", () => {
    const args = { dir: cwd, auto: "first-auto.auto.json" };
    expect(openArgsFromData(openData(args))).toEqual(args);
    expect(openArgsFromData(null)).toBeNull();
    expect(openArgsFromData({ zenithOpen: { dir: "relative/robot", auto: null } })).toBeNull();
    expect(openArgsFromData({ zenithOpen: { dir: "https://evil.example/", auto: null } })).toBeNull();
    expect(openArgsFromData({ zenithOpen: { dir: cwd, auto: 7 } })).toBeNull();
    expect(openArgsFromData({ zenithOpen: { dir: cwd, auto: "..\\x" } })).toBeNull();
  });

  describe("against the disk", () => {
    let root = "";
    let cleanup: () => void = () => undefined;
    beforeEach(() => {
      ({ root, cleanup } = exampleProject());
    });
    afterEach(() => {
      cleanup();
    });

    it("opens a project folder, with the auto named", () => {
      const request = resolveOpenRequest({ dir: root, auto: "first-auto.auto.json" });
      expect(request).toEqual({ project: { root, name: expect.any(String) as string }, auto: "first-auto.auto.json" });
    });

    it("says why when the folder has no zenith.json or the auto is not there", () => {
      const empty = mkdtempSync(join(tmpdir(), "zenith-open-empty-"));
      try {
        const none = resolveOpenRequest({ dir: empty, auto: null });
        expect("error" in none && none.error).toMatch(/^Zenith could not open /);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
      const missing = resolveOpenRequest({ dir: root, auto: "no-such.auto.json" });
      expect("error" in missing && missing.error).toMatch(/has no auto called no-such\.auto\.json/);
    });
  });
});
