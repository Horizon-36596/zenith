import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult, CommandRunner } from "@horizon36596/zenith-github";
import { nodeRunner, type GitHubDeps } from "../src/github.js";
import { makeProject, simpleAuto, writeAuto } from "../src/testSupport.js";

/**
 * A robot repository for the GitHub verbs' tests: a real git clone whose `origin` reads
 * `https://github.com/o/r.git`, rewritten by git's `insteadOf` to a local bare repository, and a
 * fake `api.github.com` behind an injected `fetch`. Nothing reaches the real GitHub or the real
 * GitHub CLI: `gh` is answered by a stub, and git runs with an empty global config.
 */

/** A fake token. It must never appear in anything the verbs print, write or send elsewhere. */
export const TOKEN = "zenith-test-token-not-real";

export interface FakePull {
  number: number;
  url: string;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface FakeCall {
  url: URL;
  method: string;
  authorization: string | null;
  body: unknown;
}

export interface FakeGitHubOptions {
  canPush?: boolean;
  /** Whether `zenith.json` is on `main` for the Contents API (zenith setup's check). */
  zenithOnMain?: boolean;
}

export function fakeGitHub(options: FakeGitHubOptions = {}) {
  const calls: FakeCall[] = [];
  const pulls: FakePull[] = [];
  const json = (status: number, body?: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const body = init?.body === undefined || init.body === null ? undefined : (JSON.parse(String(init.body)) as unknown);
    calls.push({ url, method, authorization: headers.get("authorization"), body });
    const path = url.pathname;

    if (path === "/user" && method === "GET") return json(200, { login: "octocat", id: 583231, name: null });
    if (path === "/repos/o/r" && method === "GET") {
      return json(200, {
        name: "r",
        full_name: "o/r",
        owner: { login: "o" },
        default_branch: "main",
        private: true,
        html_url: "https://github.com/o/r",
        permissions: { push: options.canPush ?? true },
      });
    }
    if (path === "/repos/o/r/pulls" && method === "GET") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      return json(200, pulls.filter((pull) => `o:${pull.head.ref}` === head && (state === "all" || pull.state === state)));
    }
    if (path === "/repos/o/r/pulls" && method === "POST") {
      const input = body as { title: string; head: string; base: string; body: string };
      const number = pulls.length + 1;
      const pull: FakePull = {
        number,
        url: `https://api.github.com/repos/o/r/pulls/${String(number)}`,
        html_url: `https://github.com/o/r/pull/${String(number)}`,
        state: "open",
        title: input.title,
        body: input.body,
        head: { ref: input.head, sha: "head" },
        base: { ref: input.base, sha: "base" },
      };
      pulls.push(pull);
      return json(201, pull);
    }
    const one = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (one !== null && method === "PATCH") {
      const pull = pulls.find((candidate) => candidate.number === Number(one[1]));
      if (pull === undefined) return json(404, { message: "Not Found" });
      Object.assign(pull, body as Partial<FakePull>);
      return json(200, pull);
    }
    if (path.startsWith("/repos/o/r/contents/") && method === "GET") {
      if (options.zenithOnMain === true) {
        return json(200, { type: "file", path: "zenith.json", sha: "s", content: btoa("{}"), encoding: "base64" });
      }
      return json(404, { message: "Not Found" });
    }
    return json(404, { message: `fake GitHub has no route for ${method} ${path}` });
  }) as typeof fetch;

  return { fetchImpl, calls, pulls };
}

export interface GhStub {
  /** `gh auth token`'s answer: a result, or "missing" for a GitHub CLI that is not installed. */
  answer: CommandResult | "missing";
  calls: (readonly string[])[];
}

export interface TestRepo {
  sandbox: string;
  repo: string;
  remote: string;
  env: Record<string, string | undefined>;
  gh: GhStub;
  github: ReturnType<typeof fakeGitHub>;
  deps: GitHubDeps;
  git: (args: readonly string[], cwd?: string) => string;
  remoteRev: (ref: string) => string | null;
  remoteFile: (ref: string, path: string) => string;
  commitAll: (message: string, cwd?: string) => void;
  cleanup: () => void;
}

const slash = (path: string): string => path.split("\\").join("/");

/** A runner that runs git for real and answers `gh` from the stub. */
export function stubbedRunner(gh: GhStub): CommandRunner {
  return async (command, args, options) => {
    if (command === "gh") {
      gh.calls.push(args);
      if (gh.answer === "missing") throw new Error("spawn gh ENOENT");
      return gh.answer;
    }
    return nodeRunner(command, args, options);
  };
}

const templates = new Map<string, string>();

/** Removes the template repositories `makeRepo` built; call it from `afterAll`. */
export function removeTemplates(): void {
  for (const dir of templates.values()) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  templates.clear();
}

export function makeRepo(
  options: { github?: FakeGitHubOptions; env?: Record<string, string | undefined>; project?: boolean; link?: Record<string, unknown> } = {},
): TestRepo {
  const sandbox = mkdtempSync(join(tmpdir(), "zenith-gh-"));
  const remote = join(sandbox, "remote.git");
  const repo = join(sandbox, "robot");
  const globalConfig = join(sandbox, "gitconfig");
  // The origin rewrite lives in this sandbox's own global config, so a copied template needs no git call.
  writeFileSync(globalConfig, `[url "${slash(remote)}"]\n\tinsteadOf = https://github.com/o/r.git\n`, "utf8");
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: undefined,
    ...options.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];

  const git = (args: readonly string[], cwd = repo): string =>
    execFileSync("git", [...args], { cwd, env: env as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commitAll = (message: string, cwd = repo): void => {
    git(["add", "-A"], cwd);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", message], cwd);
  };

  // Building the two repositories takes several git calls, so each shape is built once per test
  // file and copied after that.
  const key = JSON.stringify({ project: options.project !== false, link: options.link ?? null });
  const template = templates.get(key);
  if (template !== undefined) {
    cpSync(join(template, "remote.git"), remote, { recursive: true });
    cpSync(join(template, "robot"), repo, { recursive: true });
  } else {
    git(["init", "--quiet", "--bare", "-b", "main", remote], sandbox);
    mkdirSync(repo, { recursive: true });
    git(["init", "--quiet", "-b", "main"]);
    if (options.project !== false) {
      makeProject(repo, options.link);
      const waypoints = options.link?.waypoints;
      if (typeof waypoints === "string" && waypoints !== "autos/waypoints.json") {
        mkdirSync(dirname(join(repo, waypoints)), { recursive: true });
        renameSync(join(repo, "autos", "waypoints.json"), join(repo, waypoints));
      }
      writeAuto(repo, "autos", "demo", simpleAuto("demo"));
    } else {
      writeFileSync(join(repo, "README.md"), "robot\n", "utf8");
    }
    commitAll("Start the robot repository");
    git(["remote", "add", "origin", "https://github.com/o/r.git"]);
    git(["push", "--quiet", "origin", "main"]);
    const saved = mkdtempSync(join(tmpdir(), "zenith-gh-template-"));
    cpSync(remote, join(saved, "remote.git"), { recursive: true });
    cpSync(repo, join(saved, "robot"), { recursive: true });
    templates.set(key, saved);
  }

  const gh: GhStub = { answer: { code: 1, stdout: "", stderr: "no oauth token" }, calls: [] };
  const github = fakeGitHub(options.github);
  const deps: GitHubDeps = { run: stubbedRunner(gh), env, fetchImpl: github.fetchImpl };

  const remoteRev = (ref: string): string | null => {
    try {
      return git(["rev-parse", "--verify", "--quiet", ref], remote);
    } catch {
      return null;
    }
  };
  const remoteFile = (ref: string, path: string): string => git(["show", `${ref}:${path}`], remote);

  return {
    sandbox,
    repo,
    remote,
    env,
    gh,
    github,
    deps,
    git,
    remoteRev,
    remoteFile,
    commitAll,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** Rewrites the demo auto with a different speed, so there is something to propose. */
export function editDemo(repo: string, speedFraction: number, name = "demo"): void {
  writeAuto(repo, "autos", name, simpleAuto(name, {
    steps: [
      {
        id: "drive",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
        heading: { mode: "tangent" },
        speedFraction,
      },
      { id: "shoot1", kind: "command", name: "shootAll", args: { count: 3 } },
    ],
  }));
}
