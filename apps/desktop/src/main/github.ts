/**
 * The GitHub token for opening pull requests, held in the main process only
 * (site/docs/github.md, site/docs/editor.md).
 *
 * Where it comes from, in order: a personal access token the user pasted, kept encrypted with
 * Electron's `safeStorage` (Windows DPAPI) and never in plain text; then the GitHub CLI's own token
 * (`gh auth token`, read with `execFile` when `gh` is installed and signed in, and never stored by
 * Zenith). The token never crosses the bridge: the renderer only ever learns the login it belongs
 * to, and it is only ever sent to api.github.com.
 */
import { AuthError, GitHubClient, GitHubError, openOrUpdatePull, PatAuth, validateToken } from "@horizon36596/zenith-github";
import type { DesktopGhCliStatus, DesktopGitHubStatus, DesktopPullRequestResult } from "../../../web/src/project/desktopBridge.js";
import { BridgeError } from "./confine.js";
import { execGh, readGhCli, type GhRunner } from "./ghCli.js";

/** The subset of Electron's `safeStorage` this module uses, so tests can supply a fake. */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Where the encrypted token lives between runs (the settings file); base64 of the ciphertext. */
export interface SecretSlot {
  get(): string | null;
  set(value: string | null): void;
}

export interface GitHubAuthDeps {
  box: SecretBox;
  slot: SecretSlot;
  /** `gh auth token`, or null when gh is missing or signed out. */
  ghToken?: () => Promise<string | null>;
  /** Resolves the login a token belongs to; throws when GitHub refuses it. */
  whoAmI?: (token: string) => Promise<string>;
  /** Whether the GitHub CLI is installed and signed in, so the git panel can say which (ghCli.ts). */
  ghStatus?: () => Promise<DesktopGhCliStatus>;
}

/** The line for a call to GitHub that never got an answer: no network, no DNS, a firewall. */
export const UNREACHABLE_GITHUB = "Could not reach GitHub. Check the connection and try again.";

/**
 * A failed call to api.github.com, worded for the person. GitHub's own answers keep their message;
 * anything else (fetch's "fetch failed", a DNS error) means GitHub was never reached.
 */
export function githubFailure(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof GitHubError) return new BridgeError(error.message);
  return new BridgeError(UNREACHABLE_GITHUB);
}

/** `gh auth token` for github.com, read the same way the sign-in dialog reads it (ghCli.ts). */
export const readGhToken = async (run: GhRunner = execGh): Promise<string | null> => (await readGhCli(run)).token;

const defaultWhoAmI = async (token: string): Promise<string> => (await validateToken(new PatAuth(token))).login;

export class GitHubAuth {
  private readonly box: SecretBox;
  private readonly slot: SecretSlot;
  private readonly ghToken: () => Promise<string | null>;
  private readonly whoAmI: (token: string) => Promise<string>;
  private readonly ghStatus: (() => Promise<DesktopGhCliStatus>) | null;
  /** A pasted token kept for this run only, when the OS offers no encryption to store it with. */
  #session: string | null = null;
  #login: { token: string; login: string } | null = null;

  constructor(deps: GitHubAuthDeps) {
    this.box = deps.box;
    this.slot = deps.slot;
    this.ghToken = deps.ghToken ?? (() => readGhToken());
    this.whoAmI = deps.whoAmI ?? defaultWhoAmI;
    this.ghStatus = deps.ghStatus ?? null;
  }

  private stored(): string | null {
    const value = this.slot.get();
    if (value === null || !this.box.isEncryptionAvailable()) return null;
    try {
      return this.box.decryptString(Buffer.from(value, "base64"));
    } catch {
      // Encrypted under another Windows account or a reinstalled OS: unusable, so forget it.
      this.slot.set(null);
      return null;
    }
  }

  /** The token to use and where it came from, or null when the user has to paste one. */
  async current(): Promise<{ token: string; source: "stored" | "gh" | "session" } | null> {
    const stored = this.stored();
    if (stored !== null) return { token: stored, source: "stored" };
    if (this.#session !== null) return { token: this.#session, source: "session" };
    const gh = await this.ghToken();
    return gh === null ? null : { token: gh, source: "gh" };
  }

  async token(): Promise<string> {
    const current = await this.current();
    if (current === null) {
      throw new BridgeError(
        "Sign in to GitHub first: Zenith needs it to open the pull request.",
      );
    }
    return current.token;
  }

  /** The login for the current token, remembered per token so it costs one request per run. */
  async login(): Promise<string | null> {
    const current = await this.current();
    if (current === null) return null;
    if (this.#login !== null && this.#login.token === current.token) return this.#login.login;
    try {
      const login = await this.whoAmI(current.token);
      this.#login = { token: current.token, login };
      return login;
    } catch {
      return null;
    }
  }

  async status(): Promise<DesktopGitHubStatus> {
    const current = await this.current();
    // With no token, the panel says whether the GitHub CLI could give one: not installed, or not signed in.
    const cli = current === null && this.ghStatus !== null ? (await this.ghStatus().catch(() => null))?.state : undefined;
    return {
      source: current?.source ?? null,
      login: current === null ? null : await this.login(),
      canStore: this.box.isEncryptionAvailable(),
      ...(cli === undefined ? {} : { cli }),
    };
  }

  /**
   * Checks a pasted token against GitHub, then keeps it encrypted, or for this run only when the OS
   * offers no encryption or `remember` is false (the sign-in dialog's "remember" box).
   */
  async setToken(token: unknown, remember: unknown = true): Promise<DesktopGitHubStatus> {
    if (typeof token !== "string" || token.trim() === "" || token.length > 1000) {
      throw new BridgeError("Paste a GitHub personal access token.");
    }
    const trimmed = token.trim();
    let login: string;
    try {
      login = await this.whoAmI(trimmed);
    } catch (error) {
      // Only GitHub's own refusal means the token is bad; a call that never reached GitHub says so.
      if (error instanceof AuthError && (error.status === 401 || error.status === 403)) {
        throw new BridgeError("GitHub did not accept that token. Check that it is complete and has not expired.");
      }
      throw githubFailure(error);
    }
    if (remember !== false && this.box.isEncryptionAvailable()) {
      this.slot.set(this.box.encryptString(trimmed).toString("base64"));
      this.#session = null;
    } else if (remember === false) {
      this.slot.set(null);
      this.#session = trimmed;
    } else {
      this.#session = trimmed;
    }
    this.#login = { token: trimmed, login };
    return this.status();
  }

  async forgetToken(): Promise<DesktopGitHubStatus> {
    this.slot.set(null);
    this.#session = null;
    this.#login = null;
    return this.status();
  }
}

/**
 * Opens the pull request from `head` into `base`, or updates the body of the one already open into
 * that base; one from the same branch into another base is left alone (issue #407).
 */
export async function openOrUpdatePullRequest(input: {
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<DesktopPullRequestResult> {
  const client = new GitHubClient(new PatAuth(input.token));
  try {
    // The package's own helper, which `zenith propose` and the web app use too.
    const { pull, created } = await openOrUpdatePull(client, {
      owner: input.owner,
      repo: input.repo,
      branch: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { url: pull.htmlUrl, number: pull.number, created };
  } catch (error) {
    throw githubFailure(error);
  }
}
