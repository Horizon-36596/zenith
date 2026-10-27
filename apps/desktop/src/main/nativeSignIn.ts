/**
 * Signing in to the optional cloud through the system browser, the pattern RFC 8252 ("OAuth 2.0 for
 * Native Apps") sets out, because Firebase Auth's popup refuses a page that is not on an http or
 * https address and the built app's page is `zenith://app` (ADR 0011).
 *
 * - **Google and Microsoft**: the authorization code flow with PKCE (S256), redirected to a one-shot
 *   server on `http://127.0.0.1:<random port>/`. The server accepts exactly one request that carries
 *   the right `state`, answers it with a plain page saying the tab can be closed, and shuts at once.
 *   The code is exchanged for an ID token here, in the main process.
 * - **GitHub**: the device flow. An OAuth app's token endpoint needs the client secret for a code, which
 *   an installed app cannot keep, but the device flow needs none. The page shows the user code, the
 *   browser opens GitHub's device page, and this module polls at the interval GitHub gives, slowing
 *   down when GitHub says `slow_down`.
 *
 * Only what Firebase's `signInWithCredential` needs crosses to the page (`DesktopSignInCredential`).
 * Nothing is written to disk: Firebase keeps its own session in the page, as it does in a browser.
 *
 * This file imports no Electron, so the tests drive it with a fake browser, a fake `fetch` and a fake
 * clock. index.ts hands it `shell.openExternal`.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  DesktopSignInAvailability,
  DesktopSignInCredential,
  DesktopSignInProgress,
  DesktopSignInProvider,
  DesktopSignInProviders,
} from "../../../web/src/project/desktopBridge.js";
import { CHANNELS } from "../shared/channels.js";

// ------------------------------------------------------------------ constants

/**
 * How long the loopback server waits for the browser to come back, in milliseconds. SET BY HAND:
 * five minutes, enough to type a password and a second factor, short enough that a tab left open
 * does not keep a port open all afternoon.
 */
export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long one request to a provider's token or device endpoint may take, in milliseconds. SET BY
 * HAND: generous for event Wi-Fi, and a hung request still ends with a sentence rather than a spinner.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * The device flow's polling interval when GitHub's answer names none, in seconds. SPEC: RFC 8628
 * section 3.5 says a client "MUST use 5 as the default" when the interval is missing.
 */
export const DEVICE_DEFAULT_INTERVAL_S = 5;

/**
 * Seconds added to the polling interval on `slow_down` when GitHub's answer names no new interval.
 * SPEC: RFC 8628 section 3.5 and GitHub's device flow documentation both say 5.
 */
export const DEVICE_SLOW_DOWN_S = 5;

/** Google's endpoints, from its OpenID discovery document (ADR 0011). SPEC. */
export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  scope: "openid email profile",
} as const;

/**
 * Microsoft's endpoints on the `common` tenant, which takes personal accounts and work or school
 * accounts alike (ADR 0011). SPEC.
 */
export const MICROSOFT = {
  authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scope: "openid email profile",
} as const;

/**
 * GitHub's device flow endpoints (ADR 0011). SPEC. The scope asks for the account's email address,
 * which Firebase keeps with the sign-in record, and nothing else.
 */
export const GITHUB = {
  deviceCode: "https://github.com/login/device/code",
  token: "https://github.com/login/oauth/access_token",
  verificationOrigin: "https://github.com",
  scope: "read:user user:email",
  /**
   * The scope for GitHub mode's own sign-in (site/docs/github.md): read and write the repositories
   * the account can reach, to read the robot files, commit to work branches and open pull requests.
   * An OAuth app cannot be limited to one repository; the dialog says so. SPEC.
   */
  repoScope: "repo",
  grantType: "urn:ietf:params:oauth:grant-type:device_code",
} as const;

const PROVIDERS: readonly DesktopSignInProvider[] = ["github", "google", "microsoft"];

const NAMES: Record<DesktopSignInProvider, string> = { github: "GitHub", google: "Google", microsoft: "Microsoft" };

// ------------------------------------------------------------------ configuration

/**
 * The OAuth clients this build was given, from `VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_ID`,
 * `VITE_ZENITH_GOOGLE_DESKTOP_CLIENT_SECRET`, `VITE_ZENITH_MICROSOFT_CLIENT_ID` and
 * `VITE_ZENITH_GITHUB_CLIENT_ID` (scripts/build.mjs). None is a secret: an installed app cannot keep
 * one, and Google says its desktop client secret is not treated as one (ADR 0011).
 */
export interface SignInClients {
  google: { clientId: string; clientSecret: string } | null;
  microsoft: { clientId: string } | null;
  github: { clientId: string } | null;
}

/** Letters, digits and the few marks client ids use; anything else means the value is not set. */
const CLIENT_VALUE = /^[A-Za-z0-9._~-]{1,256}$/;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CLIENT_VALUE.test(trimmed) ? trimmed : null;
}

/**
 * Reads the JSON the build baked in (`__ZENITH_SIGN_IN_CLIENTS__`): an object of the four variables'
 * values. A value that is missing, empty or not a plain token leaves its provider off.
 */
export function signInClientsFrom(json: string | undefined | null): SignInClients {
  let record: Record<string, unknown> = {};
  if (typeof json === "string" && json.trim() !== "") {
    try {
      const value: unknown = JSON.parse(json);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) record = value as Record<string, unknown>;
    } catch {
      record = {};
    }
  }
  const googleId = clean(record["googleClientId"]);
  const googleSecret = clean(record["googleClientSecret"]);
  const microsoftId = clean(record["microsoftClientId"]);
  const githubId = clean(record["githubClientId"]);
  return {
    google: googleId === null || googleSecret === null ? null : { clientId: googleId, clientSecret: googleSecret },
    microsoft: microsoftId === null ? null : { clientId: microsoftId },
    github: githubId === null ? null : { clientId: githubId },
  };
}

/** Which providers can sign in, each with one sentence when it cannot. */
export function availabilityOf(clients: SignInClients, cloudOn: boolean): DesktopSignInProviders {
  const off = (reason: string) => ({ available: false, reason });
  const on = { available: true, reason: null };
  if (!cloudOn) {
    const reason = "Signing in is not available in this version of Zenith.";
    return { github: off(reason), google: off(reason), microsoft: off(reason) };
  }
  return {
    github: clients.github === null ? off("GitHub sign-in is not available in this version of Zenith.") : on,
    google: clients.google === null ? off("Google sign-in is not available in this version of Zenith.") : on,
    microsoft: clients.microsoft === null ? off("Microsoft sign-in is not available in this version of Zenith.") : on,
  };
}

// ------------------------------------------------------------------ PKCE, state and nonce

export type RandomBytes = (size: number) => Buffer;

export const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** A random token of `size` bytes, base64url without padding. */
export function randomToken(random: RandomBytes, size = 32): string {
  return base64url(random(size));
}

/**
 * A PKCE pair (RFC 7636): a verifier of 32 random bytes, which base64url makes 43 characters, the
 * shortest the RFC allows, and its S256 challenge, base64url of the verifier's SHA-256.
 */
export function createPkce(random: RandomBytes): { verifier: string; challenge: string; method: "S256" } {
  const verifier = randomToken(random, 32);
  return { verifier, challenge: s256Challenge(verifier), method: "S256" };
}

export function s256Challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** The nonce as it goes to the provider: the SHA-256 of the raw nonce, in lower-case hex (ADR 0011). */
export function hashNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

/** Compares two state values in constant time; false for any difference, including length. */
export function sameState(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ errors

/** A failure the page shows as it is: one or two plain sentences. */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly code: "cancelled" | "timeout" | "refused" | "provider" | "network" | "unavailable",
  ) {
    super(message);
    this.name = "SignInError";
  }
}

const cancelled = () => new SignInError("Sign-in was cancelled.", "cancelled");

// ------------------------------------------------------------------ the loopback server

/**
 * A page the browser shows on the way back from a sign-in, in Zenith's own look: the night ground,
 * the Horizon gradient as a top edge and the app's type, as the values of apps/web/src/styles/tokens.css
 * (`--bg-chrome`, `--text-hi`, `--text-mid`, `--brand-gradient`, `--font-ui`), since it loads nothing.
 */
function zenithPage(title: string, body: string): string {
  const style = [
    "html{background:#17061d}",
    "body{font:16px/1.5 \"IBM Plex Sans\",\"Segoe UI Variable Text\",\"Segoe UI\",\"Noto Sans\",sans-serif;margin:0;color:#faf6fb;background:#17061d}",
    "body::before{content:\"\";display:block;height:3px;background:linear-gradient(90deg,#ffcb5c 0%,#f86a43 55%,#b13848 100%)}",
    "main{margin:4rem auto;max-width:32rem;padding:0 1rem}",
    ".brand{margin:0 0 1.5rem;font-size:13px;font-weight:600;letter-spacing:.04em;color:#c2b0c8}",
    "h1{margin:0 0 .5rem;font-size:24px;font-weight:600}",
    "p{margin:0;color:#c2b0c8}",
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${style}</style></head><body><main><p class="brand">Zenith</p><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/** The page the browser shows after the redirect. Nothing loads from anywhere and nothing runs. */
export function landingPage(ok: boolean): string {
  return ok
    ? zenithPage("Signed in to Zenith", "You can close this tab and go back to Zenith.")
    : zenithPage("Sign-in did not finish", "Close this tab, go back to Zenith and sign in again.");
}

const REFUSED_PAGE = zenithPage(
  "Zenith did not start this sign-in",
  "Zenith ignored this address because its own sign-in did not open it. Go back to Zenith and sign in again.",
);

function sendPage(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The page loads nothing and runs nothing; the address with the code in it goes nowhere else.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(html);
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/`, the redirect URI to send to the provider. */
  redirectUri: string;
  /** Resolves with the one accepted request's query parameters; rejects on timeout or cancel. */
  result: Promise<URLSearchParams>;
  /** Shuts the server now, if it is still open. Safe to call more than once. */
  close(): void;
}

/**
 * Opens the one-shot loopback server on 127.0.0.1 and a port the system picks. It answers:
 * - a request for anything but `/`, such as the browser's favicon: 404, and keeps waiting;
 * - `/` without the right `state`: a short refusal, and keeps waiting, so a stray or forged request
 *   can neither finish the sign-in nor end it;
 * - `/` with the right `state`: the landing page, then it closes, and `result` resolves.
 * It also closes on `timeoutMs` and on `signal`, and then `result` rejects.
 */
export async function openLoopback(options: { state: string; timeoutMs: number; signal: AbortSignal }): Promise<Loopback> {
  const { state, timeoutMs, signal } = options;
  if (signal.aborted) throw cancelled();
  let settle: { resolve: (params: URLSearchParams) => void; reject: (error: Error) => void } | null = null;
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A rejection nobody awaited yet (the browser never opened) must not surface as unhandled.
  result.catch(() => undefined);

  let open = true;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!open) {
      sendPage(response, 410, REFUSED_PAGE);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      // A request target no URL parser accepts (`//[`, from a local process or a page scanning
      // ports) is refused here; thrown, it would be an uncaught error in the main process.
      sendPage(response, 400, REFUSED_PAGE);
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/") {
      sendPage(response, 404, REFUSED_PAGE);
      return;
    }
    if (!sameState(state, url.searchParams.get("state"))) {
      sendPage(response, 400, REFUSED_PAGE);
      return;
    }
    const ok = url.searchParams.has("code") && !url.searchParams.has("error");
    sendPage(response, 200, landingPage(ok));
    const params = url.searchParams;
    finish(() => settle?.resolve(params));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    finish(() => settle?.reject(cancelled()));
  };

  function finish(then: () => void): void {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    server.close();
    // Keep-alive connections would otherwise hold the port open until the browser drops them.
    server.closeAllConnections();
    then();
  }

  // Listening first, and only then arming the timeout and the cancel, so a cancel can never close a
  // server that is still starting and leave this waiting for a `listening` that never comes.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (signal.aborted) {
    finish(() => settle?.reject(cancelled()));
    throw cancelled();
  }
  timer = setTimeout(() => {
    finish(() =>
      settle?.reject(new SignInError("Sign-in took too long, so Zenith stopped waiting for the browser. Try again.", "timeout")),
    );
  }, timeoutMs);
  signal.addEventListener("abort", onAbort, { once: true });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${String(port)}/`,
    result,
    close: () => {
      finish(() => settle?.reject(cancelled()));
    },
  };
}

// ------------------------------------------------------------------ talking to providers

export type Fetch = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

async function postForm(
  fetcher: Fetch,
  url: string,
  form: Record<string, string>,
  signal: AbortSignal,
  who: string,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    if (signal.aborted) throw cancelled();
    throw new SignInError(`Zenith could not reach ${who}. Check the connection and try again.`, "network");
  }
  let body: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await response.text());
    if (value !== null && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (signal.aborted) throw cancelled();
  return { status: response.status, ok: response.ok, body };
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** An error code from a provider, kept only when it is a plain OAuth error word. */
const errorWord = (value: unknown): string | null => {
  const word = str(value);
  return word !== null && /^[a-z_]{1,64}$/.test(word) ? word : null;
};

/** The words for a provider's refusal of a code exchange or an authorization. */
function refused(provider: DesktopSignInProvider, error: string | null): SignInError {
  if (error === "access_denied") return new SignInError(`Sign-in was cancelled in ${NAMES[provider]}'s page.`, "cancelled");
  return new SignInError(
    `${NAMES[provider]} did not accept the sign-in${error === null ? "" : ` (${error})`}. Try again, or choose another way to sign in.`,
    "provider",
  );
}

// ------------------------------------------------------------------ the service

export interface NativeSignInDeps {
  clients: SignInClients;
  /** False in a build with no Firebase config: every provider is then off. */
  cloudOn: boolean;
  /** Opens a URL in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
  /** Tells the page what to show while it waits (`zenith:sign-in-progress`). */
  onProgress: (progress: DesktopSignInProgress) => void;
  fetch?: Fetch;
  randomBytes?: RandomBytes;
  /** Milliseconds, for the device flow's deadline. */
  now?: () => number;
  /** Waits `ms`, or rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  loopbackTimeoutMs?: number;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isSignInProvider(value: unknown): value is DesktopSignInProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** One sign-in at a time. Starting another, or `cancel`, stops the one in progress. */
export class NativeSignIn {
  private current: AbortController | null = null;
  private readonly fetcher: Fetch;
  private readonly random: RandomBytes;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: NativeSignInDeps) {
    this.fetcher = deps.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.random = deps.randomBytes ?? nodeRandomBytes;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
  }

  providers(): DesktopSignInProviders {
    return availabilityOf(this.deps.clients, this.deps.cloudOn);
  }

  cancel(): void {
    this.current?.abort();
    this.current = null;
  }

  /** True while a sign-in is waiting on the browser or on GitHub. */
  busy(): boolean {
    return this.current !== null;
  }

  /** Whether GitHub mode can sign in with GitHub here: that needs only the GitHub client, not the cloud. */
  repoAvailability(): DesktopSignInAvailability {
    return this.deps.clients.github === null
      ? { available: false, reason: "Sign in with GitHub is not available in this version of Zenith. Paste a token instead." }
      : { available: true, reason: null };
  }

  /**
   * GitHub mode's sign-in: the device flow with the `repo` scope, resolving with GitHub's access
   * token for the page, which keeps it as it keeps a pasted one. Shares the one-at-a-time slot, the
   * progress event and `cancel` with the cloud sign-in.
   */
  async startRepo(): Promise<string> {
    const availability = this.repoAvailability();
    if (!availability.available) throw new SignInError(availability.reason ?? "That way to sign in is off.", "unavailable");
    this.cancel();
    const controller = new AbortController();
    this.current = controller;
    try {
      const credential = await this.github(controller.signal, GITHUB.repoScope);
      if (credential.provider !== "github") throw new SignInError("GitHub did not send a token. Try again.", "provider");
      return credential.accessToken;
    } finally {
      if (this.current === controller) this.current = null;
    }
  }

  async start(provider: DesktopSignInProvider): Promise<DesktopSignInCredential> {
    const availability = this.providers()[provider];
    if (!availability.available) throw new SignInError(availability.reason ?? "That way to sign in is off.", "unavailable");
    this.cancel();
    const controller = new AbortController();
    this.current = controller;
    try {
      if (provider === "github") return await this.github(controller.signal);
      return await this.codeFlow(provider, controller.signal);
    } finally {
      if (this.current === controller) this.current = null;
    }
  }

  /** Google and Microsoft: authorization code with PKCE through the loopback server. */
  private async codeFlow(provider: "google" | "microsoft", signal: AbortSignal): Promise<DesktopSignInCredential> {
    const clients = this.deps.clients;
    const pkce = createPkce(this.random);
    const state = randomToken(this.random);
    const rawNonce = provider === "microsoft" ? randomToken(this.random) : null;
    const loopback = await openLoopback({ state, timeoutMs: this.deps.loopbackTimeoutMs ?? LOOPBACK_TIMEOUT_MS, signal });
    try {
      const url = new URL(provider === "google" ? GOOGLE.authorize : MICROSOFT.authorize);
      const clientId = provider === "google" ? (clients.google?.clientId ?? "") : (clients.microsoft?.clientId ?? "");
      const query: Record<string, string> = {
        client_id: clientId,
        response_type: "code",
        redirect_uri: loopback.redirectUri,
        scope: provider === "google" ? GOOGLE.scope : MICROSOFT.scope,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        prompt: "select_account",
      };
      if (provider === "microsoft") {
        query["response_mode"] = "query";
        query["nonce"] = hashNonce(rawNonce ?? "");
      }
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

      this.deps.onProgress({ provider, kind: "browser" });
      await this.deps.openExternal(url.toString());
      const params = await loopback.result;

      const error = errorWord(params.get("error"));
      if (error !== null) throw refused(provider, error);
      const code = str(params.get("code"));
      if (code === null) throw refused(provider, null);

      const form: Record<string, string> = {
        client_id: clientId,
        code,
        code_verifier: pkce.verifier,
        grant_type: "authorization_code",
        redirect_uri: loopback.redirectUri,
      };
      // Google's desktop clients need their secret here even with PKCE; Google says it is not
      // treated as a secret in an installed app. Microsoft's public clients must not send one.
      if (provider === "google") form["client_secret"] = clients.google?.clientSecret ?? "";
      else form["scope"] = MICROSOFT.scope;
      const reply = await postForm(this.fetcher, provider === "google" ? GOOGLE.token : MICROSOFT.token, form, signal, NAMES[provider]);
      const idToken = str(reply.body["id_token"]);
      if (!reply.ok || idToken === null) throw refused(provider, errorWord(reply.body["error"]));
      return provider === "google" ? { provider, idToken } : { provider, idToken, rawNonce: rawNonce ?? "" };
    } finally {
      loopback.close();
    }
  }

  /** GitHub: the device flow, polling at GitHub's interval and slowing down when told to. */
  private async github(signal: AbortSignal, scope: string = GITHUB.scope): Promise<DesktopSignInCredential> {
    const clientId = this.deps.clients.github?.clientId ?? "";
    const started = await postForm(this.fetcher, GITHUB.deviceCode, { client_id: clientId, scope }, signal, "GitHub");
    const deviceError = errorWord(started.body["error"]);
    if (deviceError !== null) throw deviceFlowError(deviceError);
    const deviceCode = str(started.body["device_code"]);
    const userCode = str(started.body["user_code"]);
    const verificationUri = str(started.body["verification_uri"]);
    const expiresInS = num(started.body["expires_in"]);
    if (!started.ok || deviceCode === null || userCode === null || verificationUri === null || expiresInS === null) {
      throw new SignInError("GitHub did not start the sign-in. Try again in a moment.", "provider");
    }
    if (!isGitHubPage(verificationUri)) {
      throw new SignInError("GitHub sent a sign-in address that is not on github.com, so Zenith did not open it.", "refused");
    }
    let intervalS = num(started.body["interval"]) ?? DEVICE_DEFAULT_INTERVAL_S;
    const deadline = this.now() + expiresInS * 1000;

    this.deps.onProgress({ provider: "github", kind: "code", userCode, verificationUri, expiresInS });
    await this.deps.openExternal(verificationUri);

    for (;;) {
      await this.sleep(intervalS * 1000, signal);
      if (this.now() >= deadline) throw deviceFlowError("expired_token");
      const reply = await postForm(
        this.fetcher,
        GITHUB.token,
        { client_id: clientId, device_code: deviceCode, grant_type: GITHUB.grantType },
        signal,
        "GitHub",
      );
      const accessToken = str(reply.body["access_token"]);
      if (reply.ok && accessToken !== null) return { provider: "github", accessToken };
      const error = errorWord(reply.body["error"]);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        intervalS = num(reply.body["interval"]) ?? intervalS + DEVICE_SLOW_DOWN_S;
        continue;
      }
      throw deviceFlowError(error);
    }
  }
}

function isGitHubPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === GITHUB.verificationOrigin && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function deviceFlowError(error: string | null): SignInError {
  switch (error) {
    case "expired_token":
      return new SignInError("The GitHub code expired before it was entered. Start again for a new code.", "timeout");
    case "access_denied":
      return new SignInError("Sign-in was cancelled on GitHub.", "cancelled");
    case "device_flow_disabled":
      return new SignInError(
        "GitHub sign-in is not switched on for Zenith's GitHub app yet (its device flow is off). Choose another way to sign in.",
        "unavailable",
      );
    default:
      return refused("github", error);
  }
}

// ------------------------------------------------------------------ the IPC surface

/**
 * The request handlers the preload script can reach for signing in, by channel. ipc.ts
 * registers them behind its trusted-sender check; the progress event goes out on
 * `EVENTS.signInProgress` from `NativeSignInDeps.onProgress`.
 */
export function signInHandlers(service: NativeSignIn): Record<string, (...args: unknown[]) => unknown> {
  return {
    [CHANNELS.signInProviders]: () => service.providers(),
    [CHANNELS.signInStart]: (provider: unknown) => {
      if (!isSignInProvider(provider)) throw new SignInError("That is not a way to sign in to Zenith.", "refused");
      return service.start(provider);
    },
    [CHANNELS.signInRepoAvailability]: () => service.repoAvailability(),
    [CHANNELS.signInRepoStart]: () => service.startRepo(),
    [CHANNELS.signInCancel]: () => {
      service.cancel();
      return undefined;
    },
  };
}
