/**
 * The signed-in GitHub session: where the pasted token lives, and the one `GitHubClient` built on
 * it (site/docs/github.md, `packages/github/README.md`).
 *
 * The token is held here and nowhere else. It is never put in the store, never in a URL, never in
 * a log line and never in `localStorage`; "remember for this tab" mirrors it to `sessionStorage`
 * through `BrowserTokenStore`, which the browser drops when the tab closes. `GitHubClient` sends
 * it to `api.github.com` and to nothing else.
 */
import {
  AuthError,
  BrowserTokenStore,
  GitHubClient,
  PatAuth,
  validateToken,
} from "@horizon36596/zenith-github";
import type { GitHubAuth } from "./types";

let store: BrowserTokenStore | null = null;
let client: GitHubClient | null = null;

/** A store that can see the `sessionStorage` mirror, for reading it back and for clearing it. */
const mirrorStore = (): BrowserTokenStore => new BrowserTokenStore({ persist: true });

/** The client for the signed-in account, or null when nobody is signed in. */
export const currentClient = (): GitHubClient | null => client;

/** Throws rather than returning null, for the call sites where being signed in is a precondition. */
export function requireClient(): GitHubClient {
  if (client === null) throw new AuthError("Sign in to GitHub first.");
  return client;
}

/**
 * Validates a pasted token and, if GitHub accepts it, makes it this tab's session. `remember`
 * decides whether it survives a page reload; either way it dies with the tab.
 */
export async function signIn(token: string, remember: boolean): Promise<GitHubAuth> {
  const trimmed = token.trim();
  if (trimmed === "") throw new AuthError("Paste a fine-grained personal access token to sign in.");

  // Never leave an older token behind in the mirror, whichever way this sign-in goes.
  mirrorStore().clear();
  const auth = new PatAuth(trimmed);
  const info = await validateToken(auth);

  store = new BrowserTokenStore({ persist: remember });
  store.save(trimmed);
  client = new GitHubClient(auth);
  return { login: info.login, scopes: info.scopes };
}

/** Drops the token from memory and from the tab's storage. */
export function signOut(): void {
  mirrorStore().clear();
  store?.clear();
  store = null;
  client = null;
}

/**
 * Picks the session back up after a reload, when the user asked this tab to remember it. Returns
 * null when there is nothing stored, and clears the mirror when GitHub no longer accepts what is.
 */
export async function restoreSession(): Promise<GitHubAuth | null> {
  const mirror = mirrorStore();
  const token = mirror.load();
  if (token === null) return null;
  const auth = new PatAuth(token);
  try {
    const info = await validateToken(auth);
    store = mirror;
    client = new GitHubClient(auth);
    return { login: info.login, scopes: info.scopes };
  } catch {
    mirror.clear();
    return null;
  }
}

/** What the sign-in screen says about a token that carries no `x-oauth-scopes` header. */
export const describeScopes = (scopes: readonly string[]): string =>
  scopes.length === 0 ? "fine-grained token (its permissions are not listed by the API)" : scopes.join(", ");
