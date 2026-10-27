/**
 * Signing in through the system browser (src/main/nativeSignIn.ts, ADR 0011): PKCE, the state check,
 * the one-shot loopback server, both code flows against a fake browser and a fake token endpoint,
 * GitHub's device flow with `slow_down` and expiry on a fake clock, and the IPC surface.
 */
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import type { DesktopSignInProgress } from "../../web/src/project/desktopBridge.js";
import { CHANNELS } from "../src/shared/channels.js";
import {
  DEVICE_DEFAULT_INTERVAL_S,
  GITHUB,
  GOOGLE,
  MICROSOFT,
  NativeSignIn,
  SignInError,
  availabilityOf,
  createPkce,
  hashNonce,
  landingPage,
  openLoopback,
  sameState,
  signInClientsFrom,
  signInHandlers,
  type Fetch,
  type NativeSignInDeps,
  type SignInClients,
} from "../src/main/nativeSignIn.js";

const CLIENTS: SignInClients = {
  google: { clientId: "google-desktop-client.apps.googleusercontent.com", clientSecret: "GOCSPX-not-a-secret" },
  microsoft: { clientId: "00000000-0000-0000-0000-000000000001" },
  github: { clientId: "Ov23liExampleClient" },
};

/** Counting bytes, so every token in a run is different and every run is the same. */
function countingBytes(): (size: number) => Buffer {
  let next = 0;
  return (size) => Buffer.from(Array.from({ length: size }, () => (next++ * 29 + 7) & 255));
}

/** A GET to the loopback server, as the browser makes it after the redirect. */
function browserGet(url: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface FetchCall {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

/** A token endpoint that answers from a queue, and records what it was sent. */
function fakeFetch(replies: Array<{ status?: number; body: unknown }>): { fetch: Fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)), headers: init.headers });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected request to ${url}`);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(reply.body) };
  };
  return { fetch, calls };
}

function service(overrides: Partial<NativeSignInDeps> & Pick<NativeSignInDeps, "openExternal">) {
  const progress: DesktopSignInProgress[] = [];
  const signIn = new NativeSignIn({
    clients: CLIENTS,
    cloudOn: true,
    onProgress: (p) => progress.push(p),
    randomBytes: countingBytes(),
    ...overrides,
  });
  return { signIn, progress };
}

describe("PKCE, state and nonce", () => {
  it("makes a 43-character verifier and its S256 challenge, per RFC 7636", () => {
    const pkce = createPkce(countingBytes());
    expect(pkce.method).toBe("S256");
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash("sha256").update(pkce.verifier).digest("base64url");
    expect(pkce.challenge).toBe(expected);
    expect(pkce.challenge).not.toContain("=");
  });

  it("matches RFC 7636 appendix B's worked example", () => {
    // The verifier and challenge printed in RFC 7636, appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const pkce = createPkce(() => Buffer.from(verifier, "base64url"));
    expect(pkce.verifier).toBe(verifier);
    expect(pkce.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("draws every verifier from fresh random bytes", () => {
    const random = countingBytes();
    expect(createPkce(random).verifier).not.toBe(createPkce(random).verifier);
  });

  it("checks the state exactly", () => {
    expect(sameState("abc", "abc")).toBe(true);
    for (const other of [null, "", "ab", "abcd", "ABC", "abd"]) expect(sameState("abc", other), String(other)).toBe(false);
  });

  it("hashes the nonce to lower-case hex SHA-256, the form Firebase compares with the raw nonce", () => {
    expect(hashNonce("raw")).toBe(createHash("sha256").update("raw").digest("hex"));
    expect(hashNonce("raw")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the client configuration", () => {
  it("reads the four build variables and turns a provider on only when its client is complete", () => {
    const json = JSON.stringify({
      googleClientId: " g.apps.googleusercontent.com ",
      googleClientSecret: "GOCSPX-x",
      microsoftClientId: "00000000-0000-0000-0000-000000000001",
      githubClientId: "Ov23liX",
    });
    expect(signInClientsFrom(json)).toEqual({
      google: { clientId: "g.apps.googleusercontent.com", clientSecret: "GOCSPX-x" },
      microsoft: { clientId: "00000000-0000-0000-0000-000000000001" },
      github: { clientId: "Ov23liX" },
    });
    // Google needs its desktop client secret as well as the id.
    expect(signInClientsFrom(JSON.stringify({ googleClientId: "g" })).google).toBeNull();
    for (const bad of [undefined, null, "", "not json", "[]", JSON.stringify({ githubClientId: "has space" }), JSON.stringify({ githubClientId: 42 })]) {
      expect(signInClientsFrom(bad), String(bad)).toEqual({ google: null, microsoft: null, github: null });
    }
  });

  it("says in one sentence, in the app's words, why each missing provider is off", () => {
    const none = availabilityOf({ google: null, microsoft: null, github: null }, true);
    for (const provider of ["github", "google", "microsoft"] as const) {
      expect(none[provider].available).toBe(false);
      expect(none[provider].reason).toMatch(/^(GitHub|Google|Microsoft) sign-in is not available in this version of Zenith\.$/);
    }
    expect(none.github.reason).toBe("GitHub sign-in is not available in this version of Zenith.");
    expect(availabilityOf(CLIENTS, true)).toEqual({
      github: { available: true, reason: null },
      google: { available: true, reason: null },
      microsoft: { available: true, reason: null },
    });
    expect(availabilityOf(CLIENTS, false).github).toEqual({ available: false, reason: "Signing in is not available in this version of Zenith." });
  });
});

describe("the loopback server", () => {
  it("listens on 127.0.0.1 at a port the system picks, and accepts exactly one request with the right state", async () => {
    const controller = new AbortController();
    const loopback = await openLoopback({ state: "the-state", timeoutMs: 10_000, signal: controller.signal });
    expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(loopback.redirectUri).not.toBe("http://127.0.0.1:0/");

    const ok = await browserGet(`${loopback.redirectUri}?code=the-code&state=the-state`);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("You can close this tab and go back to Zenith.");
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(ok.headers["content-security-policy"])).toContain("default-src 'none'");
    const params = await loopback.result;
    expect(params.get("code")).toBe("the-code");

    // Closed at once: a second request finds nothing listening.
    await expect(browserGet(`${loopback.redirectUri}?code=again&state=the-state`)).rejects.toThrow();
  });

  it("refuses a wrong or missing state and other paths, and keeps waiting for the right one", async () => {
    const loopback = await openLoopback({ state: "the-state", timeoutMs: 10_000, signal: new AbortController().signal });
    let settled = false;
    void loopback.result.then(() => (settled = true));

    expect((await browserGet(`${loopback.redirectUri}?code=forged&state=wrong`)).status).toBe(400);
    expect((await browserGet(`${loopback.redirectUri}?code=forged`)).status).toBe(400);
    const favicon = await browserGet(`${loopback.redirectUri.replace(/\/$/, "")}/favicon.ico`);
    expect(favicon.status).toBe(404);
    expect(favicon.body).not.toContain("close this tab");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await browserGet(`${loopback.redirectUri}?code=real&state=the-state`);
    expect((await loopback.result).get("code")).toBe("real");
  });

  it("answers 400 to a request target no URL parser accepts, and keeps waiting (issue #406)", async () => {
    const loopback = await openLoopback({ state: "the-state", timeoutMs: 10_000, signal: new AbortController().signal });
    const port = Number(new URL(loopback.redirectUri).port);
    // Node's HTTP parser lets `//[` through as request.url, and `new URL` throws on it.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (text += chunk));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
      socket.setTimeout(3_000, () => {
        socket.destroy();
        reject(new Error("the loopback server never answered"));
      });
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(reply).toContain("Zenith ignored this address");

    await browserGet(`${loopback.redirectUri}?code=real&state=the-state`);
    expect((await loopback.result).get("code")).toBe("real");
  });

  it("says the sign-in did not finish when the provider sends an error", async () => {
    const loopback = await openLoopback({ state: "s", timeoutMs: 10_000, signal: new AbortController().signal });
    const reply = await browserGet(`${loopback.redirectUri}?error=access_denied&state=s`);
    expect(reply.body).toContain("Sign-in did not finish");
    expect((await loopback.result).get("error")).toBe("access_denied");
  });

  it("stops waiting after the timeout, and closes", async () => {
    const loopback = await openLoopback({ state: "s", timeoutMs: 30, signal: new AbortController().signal });
    await expect(loopback.result).rejects.toMatchObject({ code: "timeout" });
    await expect(browserGet(`${loopback.redirectUri}?code=late&state=s`)).rejects.toThrow();
  });

  it("stops waiting when cancelled, and closes", async () => {
    const controller = new AbortController();
    const loopback = await openLoopback({ state: "s", timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(loopback.result).rejects.toMatchObject({ code: "cancelled" });
    await expect(browserGet(`${loopback.redirectUri}?code=late&state=s`)).rejects.toThrow();
  });

  it("serves a landing page that loads and runs nothing", () => {
    for (const ok of [true, false]) {
      const html = landingPage(ok);
      expect(html).not.toMatch(/<script|<link|<img|src=|href=/i);
      // In Zenith's look: the night ground and the Horizon gradient edge.
      expect(html).toContain("#17061d");
      expect(html).toContain("linear-gradient(90deg,#ffcb5c");
    }
  });
});

/** A fake browser: opens the loopback address the provider would redirect to, with the query given. */
function browserThatReturns(query: (authorize: URL) => Record<string, string>) {
  const opened: URL[] = [];
  const openExternal = async (url: string) => {
    const authorize = new URL(url);
    opened.push(authorize);
    const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    for (const [key, value] of Object.entries(query(authorize))) back.searchParams.set(key, value);
    // The browser comes back a moment later, not inside the call that opened it.
    setTimeout(() => void browserGet(back.toString()), 5);
  };
  return { opened, openExternal };
}

describe("Google: authorization code with PKCE through the loopback", () => {
  it("sends PKCE and state, exchanges the code with the desktop client secret, and hands back only the ID token", async () => {
    const browser = browserThatReturns((authorize) => ({ code: "google-code", state: authorize.searchParams.get("state") ?? "", scope: "openid" }));
    const endpoint = fakeFetch([{ body: { id_token: "google-id-token", access_token: "google-access", expires_in: 3599 } }]);
    const { signIn, progress } = service({ openExternal: browser.openExternal, fetch: endpoint.fetch });

    const credential = await signIn.start("google");
    expect(credential).toEqual({ provider: "google", idToken: "google-id-token" });
    expect(progress).toEqual([{ provider: "google", kind: "browser" }]);

    const authorize = browser.opened[0];
    expect(authorize?.origin + (authorize?.pathname ?? "")).toBe(GOOGLE.authorize);
    const q = authorize?.searchParams;
    expect(q?.get("client_id")).toBe(CLIENTS.google?.clientId);
    expect(q?.get("response_type")).toBe("code");
    expect(q?.get("scope")).toBe("openid email profile");
    expect(q?.get("code_challenge_method")).toBe("S256");
    expect(q?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(q?.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q?.has("nonce")).toBe(false);

    const exchange = endpoint.calls[0];
    expect(exchange?.url).toBe(GOOGLE.token);
    expect(exchange?.form).toMatchObject({
      client_id: CLIENTS.google?.clientId,
      client_secret: CLIENTS.google?.clientSecret,
      code: "google-code",
      grant_type: "authorization_code",
      redirect_uri: q?.get("redirect_uri"),
    });
    // The verifier sent to the token endpoint is the one whose hash went to the browser.
    const verifier = exchange?.form["code_verifier"] ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(q?.get("code_challenge"));
    expect(signIn.busy()).toBe(false);
  });

  it("fails with a sentence when Google refuses the exchange", async () => {
    const browser = browserThatReturns((authorize) => ({ code: "c", state: authorize.searchParams.get("state") ?? "" }));
    const endpoint = fakeFetch([{ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }]);
    const { signIn } = service({ openExternal: browser.openExternal, fetch: endpoint.fetch });
    await expect(signIn.start("google")).rejects.toThrow("Google did not accept the sign-in (invalid_grant).");
  });

  it("says the sign-in was cancelled when the user declines on Google's page", async () => {
    const browser = browserThatReturns((authorize) => ({ error: "access_denied", state: authorize.searchParams.get("state") ?? "" }));
    const { signIn } = service({ openExternal: browser.openExternal, fetch: fakeFetch([]).fetch });
    await expect(signIn.start("google")).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("Microsoft: public client, PKCE and a hashed nonce", () => {
  it("sends no client secret, sends SHA-256 of the raw nonce, and hands back the ID token with the raw nonce", async () => {
    const browser = browserThatReturns((authorize) => ({ code: "ms-code", state: authorize.searchParams.get("state") ?? "" }));
    const endpoint = fakeFetch([{ body: { id_token: "ms-id-token", access_token: "graph-token", token_type: "Bearer" } }]);
    const { signIn } = service({ openExternal: browser.openExternal, fetch: endpoint.fetch });

    const credential = await signIn.start("microsoft");
    if (credential.provider !== "microsoft") throw new Error("wrong provider");
    expect(credential.idToken).toBe("ms-id-token");
    expect(Object.keys(credential).sort()).toEqual(["idToken", "provider", "rawNonce"]);

    const q = browser.opened[0]?.searchParams;
    expect(`${browser.opened[0]?.origin ?? ""}${browser.opened[0]?.pathname ?? ""}`).toBe(MICROSOFT.authorize);
    expect(q?.get("response_mode")).toBe("query");
    expect(q?.get("nonce")).toBe(hashNonce(credential.rawNonce));
    expect(q?.get("nonce")).not.toBe(credential.rawNonce);

    const exchange = endpoint.calls[0];
    expect(exchange?.url).toBe(MICROSOFT.token);
    expect(exchange?.form).not.toHaveProperty("client_secret");
    expect(exchange?.form).toMatchObject({ client_id: CLIENTS.microsoft?.clientId, code: "ms-code", scope: "openid email profile" });
  });
});

/** A clock that only moves when the device flow sleeps, and records every wait. */
function fakeClock() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new SignInError("Sign-in was cancelled.", "cancelled");
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

const DEVICE = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

describe("GitHub: the device flow", () => {
  it("shows the code, opens GitHub's page, polls at the interval and slows down when told", async () => {
    const clock = fakeClock();
    const endpoint = fakeFetch([
      { body: DEVICE },
      { body: { error: "authorization_pending" } },
      { body: { error: "slow_down", interval: 10 } },
      { body: { error: "authorization_pending" } },
      { body: { error: "slow_down" } },
      { body: { access_token: "gho_token", token_type: "bearer", scope: "read:user,user:email" } },
    ]);
    const opened: string[] = [];
    const { signIn, progress } = service({
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: endpoint.fetch,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(await signIn.start("github")).toEqual({ provider: "github", accessToken: "gho_token" });
    expect(progress).toEqual([
      { provider: "github", kind: "code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInS: 900 },
    ]);
    expect(opened).toEqual(["https://github.com/login/device"]);
    // 5 s, then 5 s, then GitHub's new 10 s twice, then 10 + 5 s when slow_down names no interval.
    expect(clock.waits).toEqual([5000, 5000, 10_000, 10_000, 15_000]);

    const [start, ...polls] = endpoint.calls;
    expect(start?.url).toBe(GITHUB.deviceCode);
    expect(start?.form).toEqual({ client_id: CLIENTS.github?.clientId, scope: GITHUB.scope });
    expect(start?.headers["accept"]).toBe("application/json");
    for (const poll of polls) {
      expect(poll.url).toBe(GITHUB.token);
      // The device flow needs no client secret.
      expect(poll.form).toEqual({ client_id: CLIENTS.github?.clientId, device_code: DEVICE.device_code, grant_type: GITHUB.grantType });
    }
  });

  it("waits the default interval when GitHub names none", async () => {
    const clock = fakeClock();
    const { interval: _interval, ...noInterval } = DEVICE;
    const endpoint = fakeFetch([{ body: noInterval }, { body: { access_token: "gho_t" } }]);
    const { signIn } = service({ openExternal: async () => undefined, fetch: endpoint.fetch, now: clock.now, sleep: clock.sleep });
    await signIn.start("github");
    expect(clock.waits).toEqual([DEVICE_DEFAULT_INTERVAL_S * 1000]);
  });

  it("stops when the code expires, by its own clock and when GitHub says so", async () => {
    const clock = fakeClock();
    const pending = Array.from({ length: 200 }, () => ({ body: { error: "authorization_pending" } }));
    const endpoint = fakeFetch([{ body: { ...DEVICE, expires_in: 12 } }, ...pending]);
    const { signIn } = service({ openExternal: async () => undefined, fetch: endpoint.fetch, now: clock.now, sleep: clock.sleep });
    await expect(signIn.start("github")).rejects.toThrow("The GitHub code expired before it was entered.");
    // 5 s and 10 s are inside the 12 s; the third wait reaches 15 s, and no poll is sent after it.
    expect(endpoint.calls.length).toBe(3);

    const told = fakeFetch([{ body: DEVICE }, { body: { error: "expired_token" } }]);
    const secondClock = fakeClock();
    const second = service({ openExternal: async () => undefined, fetch: told.fetch, now: secondClock.now, sleep: secondClock.sleep });
    await expect(second.signIn.start("github")).rejects.toMatchObject({ code: "timeout" });
  });

  it("says so when the device flow is not switched on for the GitHub app, or the user declines", async () => {
    const disabled = service({
      openExternal: async () => undefined,
      fetch: fakeFetch([{ status: 400, body: { error: "device_flow_disabled" } }]).fetch,
    });
    await expect(disabled.signIn.start("github")).rejects.toThrow(/device flow is off/);

    const clock = fakeClock();
    const declined = service({
      openExternal: async () => undefined,
      fetch: fakeFetch([{ body: DEVICE }, { body: { error: "access_denied" } }]).fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(declined.signIn.start("github")).rejects.toThrow("Sign-in was cancelled on GitHub.");
  });

  it("never opens a verification address that is not on github.com", async () => {
    const opened: string[] = [];
    const { signIn } = service({
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: fakeFetch([{ body: { ...DEVICE, verification_uri: "https://github.com.evil.example/login/device" } }]).fetch,
    });
    await expect(signIn.start("github")).rejects.toMatchObject({ code: "refused" });
    expect(opened).toEqual([]);
  });

  it("stops polling at once when cancelled", async () => {
    let wake: (() => void) | null = null;
    const endpoint = fakeFetch([{ body: DEVICE }]);
    const { signIn } = service({
      openExternal: async () => undefined,
      fetch: endpoint.fetch,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          wake = resolve;
          signal.addEventListener("abort", () => reject(new SignInError("Sign-in was cancelled.", "cancelled")));
        }),
    });
    const running = signIn.start("github");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signIn.busy()).toBe(true);
    signIn.cancel();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(wake).not.toBeNull();
    expect(endpoint.calls.length).toBe(1);
    expect(signIn.busy()).toBe(false);
  });
});

describe("one sign-in at a time", () => {
  it("refuses a provider the build has no client for, without opening anything", async () => {
    const opened: string[] = [];
    const signIn = new NativeSignIn({
      clients: { ...CLIENTS, microsoft: null },
      cloudOn: true,
      openExternal: async (url) => {
        opened.push(url);
      },
      onProgress: () => undefined,
    });
    await expect(signIn.start("microsoft")).rejects.toMatchObject({ code: "unavailable" });
    expect(opened).toEqual([]);
  });

  it("cancels the sign-in in progress when another starts", async () => {
    const { signIn } = service({ openExternal: async () => undefined, fetch: fakeFetch([]).fetch });
    const first = signIn.start("google");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = signIn.start("microsoft");
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    // Cancelled straight away, while the second one's server may still be starting.
    signIn.cancel();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("the IPC surface", () => {
  const { signIn } = service({ openExternal: async () => undefined, fetch: fakeFetch([]).fetch });
  const handlers = signInHandlers(signIn);

  it("is exactly five named channels", () => {
    expect(Object.keys(handlers).sort()).toEqual(
      [
        CHANNELS.signInCancel,
        CHANNELS.signInProviders,
        CHANNELS.signInStart,
        CHANNELS.signInRepoAvailability,
        CHANNELS.signInRepoStart,
      ].sort(),
    );
    expect(Object.values(CHANNELS).filter((name) => name.startsWith("zenith:sign-in")).sort()).toEqual(Object.keys(handlers).sort());
  });

  it("answers which providers are on with plain data", () => {
    const answer = handlers[CHANNELS.signInProviders]?.();
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    expect(Object.keys(answer as object).sort()).toEqual(["github", "google", "microsoft"]);
  });

  it("refuses anything that is not one of the three providers", async () => {
    for (const bad of ["facebook", "", 42, null, undefined, { provider: "github" }, "GitHub"]) {
      expect(() => handlers[CHANNELS.signInStart]?.(bad), String(bad)).toThrow("That is not a way to sign in to Zenith.");
    }
  });

  it("cancels with no argument and returns nothing", () => {
    expect(handlers[CHANNELS.signInCancel]?.()).toBeUndefined();
  });
});

describe("GitHub mode's own sign-in: the device flow with the repo scope", () => {
  it("asks GitHub for repo, shows the code, and hands back only the token", async () => {
    const clock = fakeClock();
    const endpoint = fakeFetch([{ body: DEVICE }, { body: { access_token: "gho_repo", token_type: "bearer", scope: "repo" } }]);
    const { signIn, progress } = service({ openExternal: async () => undefined, fetch: endpoint.fetch, now: clock.now, sleep: clock.sleep });

    expect(await signIn.startRepo()).toBe("gho_repo");
    expect(endpoint.calls[0]?.form).toEqual({ client_id: CLIENTS.github?.clientId, scope: GITHUB.repoScope });
    expect(progress[0]).toMatchObject({ provider: "github", kind: "code", userCode: "WDJB-MJHT" });
    expect(signIn.busy()).toBe(false);
  });

  it("needs the GitHub client only, not the cloud", async () => {
    const withoutCloud = service({ openExternal: async () => undefined, cloudOn: false });
    expect(withoutCloud.signIn.repoAvailability()).toEqual({ available: true, reason: null });
    expect(withoutCloud.signIn.providers().github.available).toBe(false);

    const noClient = service({ openExternal: async () => undefined, clients: { ...CLIENTS, github: null } });
    expect(noClient.signIn.repoAvailability().available).toBe(false);
    await expect(noClient.signIn.startRepo()).rejects.toMatchObject({ code: "unavailable" });
  });
});
