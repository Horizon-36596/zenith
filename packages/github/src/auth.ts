import { AuthError } from "./errors.js";

/**
 * How the client gets a bearer token for `api.github.com`. v1 ships one implementation
 * (`PatAuth`, a pasted fine-grained PAT, site/docs/github.md); this seam is
 * what lets a later device-flow implementation plug in without touching `GitHubClient`,
 * `GitHubProject`, `propose` or `loadReview`.
 */
export interface AuthProvider {
  /** Resolves to a bearer token, or rejects (typically with `AuthError`) when none is available. */
  token(): Promise<string>;
}

/** v1's only `AuthProvider`: a fine-grained personal access token pasted into the app or the CLI. */
export class PatAuth implements AuthProvider {
  // A real JS private field (`#pat`), not a TypeScript `private` constructor parameter: the latter
  // still compiles to an ordinary own enumerable property, so `JSON.stringify(patAuthInstance)` (or
  // any code that walks `state.backend`'s object graph down to this) would print the token in the
  // clear. `#pat` has no enumerable representation at
  // all — `Object.keys`, `JSON.stringify` and `for...in` all skip it.
  #pat: string;

  constructor(pat: string) {
    if (!pat.trim()) throw new AuthError("A personal access token is required.");
    this.#pat = pat;
  }

  async token(): Promise<string> {
    return this.#pat;
  }
}

/** What `validateToken` reports back about the token it was given. */
export interface TokenInfo {
  login: string;
  /**
   * Scopes from the `x-oauth-scopes` response header. GitHub sets this header for classic PATs and
   * OAuth Apps; a fine-grained PAT authenticates fine but does not echo its permissions here, so
   * this is `[]` for one, not a sign that the token has no access.
   */
  scopes: string[];
}

/**
 * Confirms the token works and reports who it belongs to, the way the app's sign-in screen and
 * `zenith propose`'s preflight both want (06 §2). Throws `AuthError` on 401/403.
 */
export async function validateToken(
  auth: AuthProvider,
  apiBase = "https://api.github.com",
  fetchImpl: typeof fetch = fetch,
): Promise<TokenInfo> {
  const token = await auth.token();
  const response = await fetchImpl(`${apiBase}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      `GitHub rejected this token (${response.status}). Paste a fresh fine-grained PAT with repo contents and pull requests read/write.`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new AuthError(`Could not validate the token: GitHub returned ${response.status}.`, response.status);
  }
  const body = (await response.json()) as { login: string };
  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  return { login: body.login, scopes };
}

/** Loads, saves and clears the pasted token. Never `localStorage` (00-decisions.md GitHub mode). */
export interface TokenStore {
  load(): string | null;
  save(token: string): void;
  clear(): void;
}

/** Works anywhere; the token disappears when the page or process does. */
export class MemoryTokenStore implements TokenStore {
  private token: string | null = null;

  load(): string | null {
    return this.token;
  }

  save(token: string): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
  }
}

/**
 * The browser store. Memory is the source of truth; when `persist` is on and `sessionStorage` is
 * reachable, the token is mirrored there too, so a page reload does not force a re-paste. Falls
 * back to memory-only, quietly, if storage throws (private browsing, a locked-down iframe).
 * Deliberately has no `localStorage` mode: the token must not outlive the browser session.
 */
export class BrowserTokenStore implements TokenStore {
  private readonly memory = new MemoryTokenStore();
  private readonly storage: Storage | null;

  constructor(options: { persist?: boolean; storage?: Storage } = {}) {
    const persist = options.persist ?? true;
    const candidate = options.storage ?? (typeof sessionStorage === "undefined" ? null : sessionStorage);
    this.storage = persist ? candidate : null;
    if (this.storage) {
      try {
        const stored = this.storage.getItem(BrowserTokenStore.KEY);
        if (stored) this.memory.save(stored);
      } catch {
        this.storage = null;
      }
    }
  }

  private static readonly KEY = "zenith.github.token";

  load(): string | null {
    return this.memory.load();
  }

  save(token: string): void {
    this.memory.save(token);
    try {
      this.storage?.setItem(BrowserTokenStore.KEY, token);
    } catch {
      // sessionStorage can throw (quota, privacy mode); memory still has the token.
    }
  }

  clear(): void {
    this.memory.clear();
    try {
      this.storage?.removeItem(BrowserTokenStore.KEY);
    } catch {
      // Nothing to clean up if storage was never reachable.
    }
  }
}

/** Node (the CLI) has no browser storage; the token lives only where the caller puts it. */
export class NodeTokenStore implements TokenStore {
  load(): string | null {
    return null;
  }

  save(): void {
    // Intentionally a no-op: see the class comment.
  }

  clear(): void {
    // Intentionally a no-op: see the class comment.
  }
}
