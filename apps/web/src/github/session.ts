/**
 * The signed-in GitHub session: where the token lives, and the one `GitHubClient` built on it
 * (site/docs/github.md, `packages/github/README.md`).
 *
 * The token is held here and nowhere else. It is never put in the store, never in a URL and never
 * in a log line. Where it is remembered is the person's choice at sign-in (`TokenKeep`): only in
 * this page's memory, mirrored to `sessionStorage` until the tab closes (the default), or, when
 * they ask for it, to `localStorage` in this browser until they sign out, so reopening Zenith does
 * not mean signing in again. `GitHubClient` sends it to `api.github.com` and to nothing else.
 */
import {
  AuthError,
  BrowserTokenStore,
  GitHubClient,
  PatAuth,
  validateToken,
} from "@horizon36596/zenith-github";
import type { GitHubAuth, TokenKeep } from "./types";

let store: BrowserTokenStore | null = null;
let client: GitHubClient | null = null;

/** The page's `localStorage`, or null where reading it throws (site data blocked). */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A store for one way of keeping the token. "browser" falls back to memory, not to the tab, when
 * `localStorage` cannot be reached, so the token is never kept somewhere the person did not pick.
 */
function storeFor(keep: TokenKeep): BrowserTokenStore {
  if (keep === "page") return new BrowserTokenStore({ persist: false });
  if (keep === "tab") return new BrowserTokenStore({ persist: true });
  const storage = browserStorage();
  return storage === null ? new BrowserTokenStore({ persist: false }) : new BrowserTokenStore({ persist: true, storage });
}

/** Every mirror a token can be in, newest choice first when reading back. */
const mirrors = (): Array<{ keep: TokenKeep; store: BrowserTokenStore }> => [
  { keep: "tab", store: storeFor("tab") },
  ...(browserStorage() === null ? [] : [{ keep: "browser" as const, store: storeFor("browser") }]),
];

/** Never leave an older token behind in any mirror. */
function clearMirrors(): void {
  for (const { store: mirror } of mirrors()) mirror.clear();
}

/** The client for the signed-in account, or null when nobody is signed in. */
export const currentClient = (): GitHubClient | null => client;

/** Throws rather than returning null, for the call sites where being signed in is a precondition. */
export function requireClient(): GitHubClient {
  if (client === null) throw new AuthError("Sign in to GitHub first.");
  return client;
}

/**
 * Validates a token, pasted or from "Sign in with GitHub", and, if GitHub accepts it, makes it this
 * page's session, kept the way `keep` says.
 */
export async function signIn(token: string, keep: TokenKeep, via: "token" | "oauth" = "token"): Promise<GitHubAuth> {
  const trimmed = token.trim();
  if (trimmed === "") throw new AuthError("Paste a fine-grained personal access token to sign in.");

  // Never leave an older token behind in a mirror, whichever way this sign-in goes.
  clearMirrors();
  const auth = new PatAuth(trimmed);
  const info = await validateToken(auth);

  store = storeFor(keep);
  store.save(trimmed);
  client = new GitHubClient(auth);
  return { login: info.login, scopes: info.scopes, via, keep };
}

/**
 * Makes the GitHub CLI's token this window's session, in the desktop app (issue #213). Unlike a
 * pasted token it is never mirrored anywhere, not even to `sessionStorage`: it lives in this module's
 * memory until sign-out or until Zenith closes, and a reload asks the CLI again with one click.
 */
export async function signInWithCli(token: string): Promise<GitHubAuth> {
  const trimmed = token.trim();
  if (trimmed === "") throw new AuthError("The GitHub CLI gave Zenith no token. Run gh auth login, then try again.");
  // A remembered pasted token would come back on reload in place of this one, so it goes.
  clearMirrors();
  const auth = new PatAuth(trimmed);
  const info = await validateToken(auth);
  store = new BrowserTokenStore({ persist: false });
  store.save(trimmed);
  client = new GitHubClient(auth);
  return { login: info.login, scopes: info.scopes, via: "cli" };
}

/** Drops the token from memory and from every place it was remembered. */
export function signOut(): void {
  clearMirrors();
  store?.clear();
  store = null;
  client = null;
}

/**
 * Picks the session back up after a reload, or after the browser reopens when it was kept there.
 * Returns null when there is nothing stored, and clears a mirror whose token GitHub no longer
 * accepts.
 */
export async function restoreSession(): Promise<GitHubAuth | null> {
  for (const { keep, store: mirror } of mirrors()) {
    const token = mirror.load();
    if (token === null) continue;
    const auth = new PatAuth(token);
    try {
      const info = await validateToken(auth);
      store = mirror;
      client = new GitHubClient(auth);
      return { login: info.login, scopes: info.scopes, keep };
    } catch {
      mirror.clear();
    }
  }
  return null;
}

/** What the sign-in screen says about a token that carries no `x-oauth-scopes` header. */
export const describeScopes = (scopes: readonly string[]): string =>
  scopes.length === 0 ? "fine-grained token (its permissions are not listed by the API)" : scopes.join(", ");
