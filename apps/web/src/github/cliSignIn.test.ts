/**
 * Issue #213 in the web build: what the sign-in dialog says about the GitHub CLI, signing in with
 * the token the desktop app hands over (memory only, never in storage), the clone's GitHub origin,
 * and the folder `zenith open` asked for. The desktop bridge is a fake on `window`, and GitHub's API
 * is a fetch stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_API_VERSION, type DesktopOpenRequest, type ZenithDesktopBridge } from "../project/desktopBridge";
import { getState, setAuth } from "../state/store";
import { signInWithGitHubCli } from "./actions";
import { cliNote, readCliState, startsOnCli } from "./cliSignIn";
import { readCloneOrigin } from "./cloneOffer";
import { createFetchStub } from "./fetchStub";
import { currentClient, signOut } from "./session";

const TOKEN = "gho_0123456789abcdefghijABCDEFGHIJ";

/** Storage that remembers what was written to it, so a test can show the token never was. */
function recordingStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

function withBridge(github: Partial<ZenithDesktopBridge["github"]>, project: Partial<ZenithDesktopBridge["project"]> = {}) {
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    github: { status: vi.fn(), setToken: vi.fn(), forgetToken: vi.fn(), ...github },
    project,
  } as unknown as ZenithDesktopBridge;
  const session = recordingStorage();
  const local = recordingStorage();
  vi.stubGlobal("window", { zenithDesktop: bridge });
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  return { bridge, session, local };
}

afterEach(() => {
  signOut();
  setAuth(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what the dialog says about the GitHub CLI", () => {
  it("offers nothing in a browser", async () => {
    vi.stubGlobal("window", {});
    expect(await readCliState()).toBe("unavailable");
  });

  it("offers nothing with a desktop build that cannot ask", async () => {
    withBridge({});
    expect(await readCliState()).toBe("unavailable");
  });

  it("starts on the CLI when it is ready, and on the token form otherwise", async () => {
    withBridge({ cliStatus: async () => ({ state: "ready" }), cliToken: async () => TOKEN });
    const state = await readCliState();
    expect(state).toBe("ready");
    expect(startsOnCli(state)).toBe(true);
    expect(startsOnCli("signed-out")).toBe(false);
    expect(startsOnCli("missing")).toBe(false);
  });

  it("tells someone signed out of the CLI how to sign in, and says nothing to someone without it", async () => {
    withBridge({ cliStatus: async () => ({ state: "signed-out" }), cliToken: async () => TOKEN });
    expect(cliNote(await readCliState())).toMatch(/gh auth login/);
    expect(cliNote("missing")).toBeNull();
    expect(cliNote("unavailable")).toBeNull();
    expect(cliNote("ready")).toBeNull();
  });

  it("treats a failed check as no CLI", async () => {
    withBridge({
      cliStatus: async () => {
        throw new Error("Refused a request from a page that is not Zenith.");
      },
      cliToken: async () => TOKEN,
    });
    expect(await readCliState()).toBe("missing");
  });
});

describe("signing in with the GitHub CLI", () => {
  it("validates the CLI's token with api.github.com only and keeps it in memory, never in storage", async () => {
    const { session, local } = withBridge({ cliStatus: async () => ({ state: "ready" }), cliToken: async () => TOKEN });
    // A token pasted and remembered earlier is dropped, so a reload cannot bring it back instead.
    session.setItem("zenith.github.token", "github_pat_older_fake");
    const stub = createFetchStub([
      {
        method: "GET",
        match: /^\/user$/,
        handler: () => ({ status: 200, body: { login: "octocat" }, headers: { "x-oauth-scopes": "repo, read:org" } }),
      },
    ]);
    vi.stubGlobal("fetch", stub.fetchImpl);

    const auth = await signInWithGitHubCli();
    expect(auth).toEqual({ login: "octocat", scopes: ["repo", "read:org"], via: "cli" });
    expect(getState().auth).toEqual(auth);
    expect(currentClient()).not.toBeNull();
    expect(stub.calls.map((call) => call.url.host)).toEqual(["api.github.com"]);
    expect(stub.calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect([...session.items.values()]).not.toContain(TOKEN);
    expect(session.items.size).toBe(0);
    expect(local.items.size).toBe(0);
    expect(JSON.stringify(getState())).not.toContain(TOKEN);
  });

  it("passes on the desktop app's sentence when the CLI has no token", async () => {
    withBridge({
      cliStatus: async () => ({ state: "signed-out" }),
      cliToken: async () => {
        throw new Error("The GitHub CLI is not signed in to github.com. Run gh auth login in a terminal, then try again.");
      },
    });
    await expect(signInWithGitHubCli()).rejects.toThrow(/gh auth login/);
    expect(getState().auth).toBeNull();
  });

  it("needs the desktop app", async () => {
    vi.stubGlobal("window", {});
    await expect(signInWithGitHubCli()).rejects.toThrow(/desktop app/);
  });
});

describe("a clone's GitHub origin", () => {
  it("is what the desktop app read from the folder's origin", async () => {
    const githubOrigin = vi.fn(async () => ({ owner: "example-team", repo: "robot", base: "main" }));
    withBridge({}, { githubOrigin });
    expect(await readCloneOrigin("C:/robot")).toEqual({ owner: "example-team", repo: "robot", base: "main" });
    expect(githubOrigin).toHaveBeenCalledWith("C:/robot");
  });

  it("is nothing in a browser, with an older desktop build, or when the read fails", async () => {
    vi.stubGlobal("window", {});
    expect(await readCloneOrigin("C:/robot")).toBeNull();
    withBridge({});
    expect(await readCloneOrigin("C:/robot")).toBeNull();
    withBridge(
      {},
      {
        githubOrigin: async () => {
          throw new Error("That folder was not opened through Zenith's folder picker, so it was refused.");
        },
      },
    );
    expect(await readCloneOrigin("C:/robot")).toBeNull();
  });
});

describe("the folder zenith open asked for", () => {
  it("opens the requested project at the requested auto, once", async () => {
    const { openRequested } = await import("../project/desktopActions");
    let waiting: DesktopOpenRequest | null = { project: { root: "C:/robot", name: "robot" }, auto: "close-cycle.auto.json" };
    const bridge = {
      apiVersion: DESKTOP_API_VERSION,
      project: {},
      openRequests: {
        take: async () => {
          const request = waiting;
          waiting = null;
          return request;
        },
        onRequest: () => () => undefined,
      },
    } as unknown as ZenithDesktopBridge;
    vi.stubGlobal("window", { zenithDesktop: bridge });
    const adopt = vi.fn(async (_backend: unknown, _auto?: string) => true);
    expect(await openRequested(bridge, adopt)).toBe(true);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0]?.[1]).toBe("close-cycle.auto.json");
    expect(getState().status?.message).toBe("Opened close-cycle.auto.json in robot.");
    expect(await openRequested(bridge, adopt)).toBe(false);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("shows why a request could not be opened, and opens nothing", async () => {
    const { openRequested } = await import("../project/desktopActions");
    const bridge = {
      apiVersion: DESKTOP_API_VERSION,
      openRequests: { take: async () => ({ error: "Zenith could not open C:/nowhere: Could not read zenith.json in this folder." }), onRequest: () => () => undefined },
    } as unknown as ZenithDesktopBridge;
    vi.stubGlobal("window", { zenithDesktop: bridge });
    const adopt = vi.fn(async (_backend: unknown, _auto?: string) => true);
    expect(await openRequested(bridge, adopt)).toBe(true);
    expect(adopt).not.toHaveBeenCalled();
    expect(getState().status).toMatchObject({ kind: "error", message: "Zenith could not open C:/nowhere: Could not read zenith.json in this folder." });
  });

  it("does nothing with an older desktop build", async () => {
    const { openRequested } = await import("../project/desktopActions");
    const bridge = { apiVersion: DESKTOP_API_VERSION } as unknown as ZenithDesktopBridge;
    expect(await openRequested(bridge, vi.fn())).toBe(false);
  });
});
