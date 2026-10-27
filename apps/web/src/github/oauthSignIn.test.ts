/**
 * "Sign in with GitHub" for GitHub mode: which route each kind of page takes, and that a token from
 * it is kept exactly where the person chose (this page, this tab, or this browser), and nowhere else.
 * GitHub's API is a fetch stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseOAuthRoute } from "./oauthSignIn";
import { createFetchStub } from "./fetchStub";
import { restoreSession, signIn, signOut } from "./session";

const TOKEN = "gho_0123456789abcdefghijABCDEFGHIJ";
const WEB = "https://zenith.horizon36596.org/";
const DESKTOP_PAGE = "zenith://app/";

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

function withStorage() {
  const session = recordingStorage();
  const local = recordingStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  const stub = createFetchStub([
    {
      method: "GET",
      match: /^\/user$/,
      handler: () => ({ status: 200, body: { login: "octo" }, headers: { "x-oauth-scopes": "repo" } }),
    },
  ]);
  vi.stubGlobal("fetch", stub.fetchImpl);
  return { session, local };
}

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("which way Sign in with GitHub goes", () => {
  it("uses Firebase's popup on a web page with the cloud, and nothing without it", () => {
    expect(chooseOAuthRoute({ cloudMode: "firebase", desktop: null, pageUrl: WEB })).toEqual({ kind: "popup" });
    expect(chooseOAuthRoute({ cloudMode: "fake", desktop: null, pageUrl: WEB })).toEqual({ kind: "popup" });
    expect(chooseOAuthRoute({ cloudMode: "off", desktop: null, pageUrl: WEB }).kind).toBe("unavailable");
  });

  it("uses the device flow in the desktop app, and the popup only on a development page", () => {
    const on = { available: true, reason: null };
    const off = { available: false, reason: "Not in this build." };
    expect(chooseOAuthRoute({ cloudMode: "firebase", desktop: on, pageUrl: DESKTOP_PAGE })).toEqual({ kind: "device" });
    expect(chooseOAuthRoute({ cloudMode: "firebase", desktop: off, pageUrl: DESKTOP_PAGE })).toEqual({ kind: "unavailable", reason: "Not in this build." });
    expect(chooseOAuthRoute({ cloudMode: "firebase", desktop: off, pageUrl: "http://localhost:5173/" })).toEqual({ kind: "popup" });
  });
});

describe("where the token is kept", () => {
  it("keeps it in memory only for 'page'", async () => {
    const { session, local } = withStorage();
    const auth = await signIn(TOKEN, "page", "oauth");
    expect(auth).toMatchObject({ login: "octo", scopes: ["repo"], via: "oauth", keep: "page" });
    expect(session.items.size).toBe(0);
    expect(local.items.size).toBe(0);
    signOut();
    expect(await restoreSession()).toBeNull();
  });

  it("keeps it in sessionStorage for 'tab' and in localStorage for 'browser', never both", async () => {
    const { session, local } = withStorage();
    await signIn(TOKEN, "tab");
    expect([...session.items.values()]).toEqual([TOKEN]);
    expect(local.items.size).toBe(0);

    await signIn(TOKEN, "browser", "oauth");
    expect(session.items.size).toBe(0);
    expect([...local.items.values()]).toEqual([TOKEN]);
  });

  it("signs straight back in from the browser's copy after a restart, and sign-out removes it", async () => {
    const { local } = withStorage();
    await signIn(TOKEN, "browser", "oauth");
    // A restart: nothing in memory, the tab's storage empty, the browser's copy still there.
    expect(await restoreSession()).toMatchObject({ login: "octo", keep: "browser" });
    signOut();
    expect(local.items.size).toBe(0);
    expect(await restoreSession()).toBeNull();
  });

  it("drops a remembered token GitHub no longer accepts", async () => {
    const { local } = withStorage();
    local.setItem("zenith.github.token", "gho_revoked");
    vi.stubGlobal("fetch", createFetchStub([{ method: "GET", match: /^\/user$/, handler: () => ({ status: 401 }) }]).fetchImpl);
    expect(await restoreSession()).toBeNull();
    expect(local.items.size).toBe(0);
  });
});
