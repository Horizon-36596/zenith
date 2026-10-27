import { describe, expect, it } from "vitest";
import {
  findSignIn,
  NoSignInError,
  parseGitHubRemote,
  rejectedTokenNext,
  remoteHost,
  type CommandRunner,
} from "../src/signIn.js";

const FAKE = "zenith-fake-token-for-tests";
// Built apart so the public scrub does not read these remote URLs as email addresses.
const at = "@";

function ghRunner(answer: { code: number; stdout: string } | "missing") {
  const calls: (readonly string[])[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (answer === "missing") throw new Error("spawn gh ENOENT");
    return { code: answer.code, stdout: answer.stdout, stderr: "" };
  };
  return { run, calls };
}

describe("findSignIn", () => {
  it("takes GH_TOKEN first, then GITHUB_TOKEN, without running gh", async () => {
    const gh = ghRunner({ code: 0, stdout: "from-gh\n" });
    const first = await findSignIn({ env: { GH_TOKEN: FAKE, GITHUB_TOKEN: "other" }, run: gh.run });
    expect(first.source).toBe("GH_TOKEN");
    expect(await first.auth.token()).toBe(FAKE);
    const second = await findSignIn({ env: { GH_TOKEN: "  ", GITHUB_TOKEN: FAKE }, run: gh.run });
    expect(second.source).toBe("GITHUB_TOKEN");
    expect(gh.calls).toEqual([]);
  });

  it("falls back to `gh auth token --hostname github.com`, trimming its newline", async () => {
    const gh = ghRunner({ code: 0, stdout: `${FAKE}\n` });
    const found = await findSignIn({ env: {}, run: gh.run });
    expect(found.source).toBe("gh");
    expect(await found.auth.token()).toBe(FAKE);
    expect(gh.calls).toEqual([["gh", "auth", "token", "--hostname", "github.com"]]);
  });

  it("keeps the token out of JSON and out of its own fields", async () => {
    const found = await findSignIn({ env: { GH_TOKEN: FAKE } });
    expect(JSON.stringify(found)).not.toContain(FAKE);
  });

  it("says to run gh auth login when the GitHub CLI is installed but signed out", async () => {
    const error = await findSignIn({ env: {}, run: ghRunner({ code: 1, stdout: "" }).run }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoSignInError);
    const noSignIn = error as NoSignInError;
    expect(noSignIn.ghInstalled).toBe(true);
    expect(noSignIn.next).toMatch(/^Run `gh auth login`/);
    expect(noSignIn.next).toContain("GH_TOKEN");
    expect(noSignIn.message).toContain(`Next: ${noSignIn.next}`);
  });

  it("says to install the GitHub CLI when it is not there, or when no runner is given", async () => {
    for (const run of [ghRunner("missing").run, undefined]) {
      const error = (await findSignIn({ env: {}, run }).catch((caught: unknown) => caught)) as NoSignInError;
      expect(error.ghInstalled).toBe(false);
      expect(error.next).toContain("https://cli.github.com");
    }
  });

  it("names the right fix when GitHub refuses a token", () => {
    expect(rejectedTokenNext("gh")).toContain("gh auth login");
    expect(rejectedTokenNext("GH_TOKEN")).toContain("Set GH_TOKEN");
  });
});

describe("parseGitHubRemote", () => {
  it.each([
    ["https://github.com/o/r.git", { owner: "o", repo: "r" }],
    ["https://github.com/o/r", { owner: "o", repo: "r" }],
    ["https://github.com/Horizon-36596/my.robot/", { owner: "Horizon-36596", repo: "my.robot" }],
    [`https://someone:secret${at}github.com/o/r.git`, { owner: "o", repo: "r" }],
    ["git@github.com:o/r.git", { owner: "o", repo: "r" }],
    ["ssh://git@github.com/o/r.git", { owner: "o", repo: "r" }],
    [`ssh://git${at}ssh.github.com:443/o/r.git`, { owner: "o", repo: "r" }],
  ])("reads %s", (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it.each([
    "https://gitlab.com/o/r.git",
    `git${at}gitlab.com:o/r.git`,
    "https://github.com/o",
    "https://github.com/o/r/tree/main",
    "C:/repos/robot.git",
    "../robot.git",
    "https://github.com.evil.example/o/r.git",
  ])("refuses %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  it("gives only the host of a URL, never its credentials", () => {
    expect(remoteHost("https://someone:secret@example.com/o/r.git")).toBe("example.com");
    expect(remoteHost(`git${at}gitlab.com:o/r.git`)).toBe("gitlab.com");
  });
});
