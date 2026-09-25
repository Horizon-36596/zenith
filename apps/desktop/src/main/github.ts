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
import { execFile } from "node:child_process";
import { GitHubClient, PatAuth, validateToken } from "@horizon36596/zenith-github";
import type { DesktopGitHubStatus, DesktopPullRequestResult } from "../../../web/src/project/desktopBridge.js";
import { BridgeError } from "./confine.js";

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
}

export const readGhToken = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      const token = String(stdout).trim();
      resolve(error === null && token !== "" ? token : null);
    });
  });

const defaultWhoAmI = async (token: string): Promise<string> => (await validateToken(new PatAuth(token))).login;

export class GitHubAuth {
  private readonly box: SecretBox;
  private readonly slot: SecretSlot;
  private readonly ghToken: () => Promise<string | null>;
  private readonly whoAmI: (token: string) => Promise<string>;
  /** A pasted token kept for this run only, when the OS offers no encryption to store it with. */
  #session: string | null = null;
  #login: { token: string; login: string } | null = null;

  constructor(deps: GitHubAuthDeps) {
    this.box = deps.box;
    this.slot = deps.slot;
    this.ghToken = deps.ghToken ?? readGhToken;
    this.whoAmI = deps.whoAmI ?? defaultWhoAmI;
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
        "Zenith needs a GitHub token to open the pull request. Paste a personal access token with the repo scope, or sign in with the GitHub CLI (gh auth login).",
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
    return {
      source: current?.source ?? null,
      login: current === null ? null : await this.login(),
      canStore: this.box.isEncryptionAvailable(),
    };
  }

  /** Checks a pasted token against GitHub, then keeps it encrypted (or for this run only). */
  async setToken(token: unknown): Promise<DesktopGitHubStatus> {
    if (typeof token !== "string" || token.trim() === "" || token.length > 1000) {
      throw new BridgeError("Paste a GitHub personal access token.");
    }
    const trimmed = token.trim();
    let login: string;
    try {
      login = await this.whoAmI(trimmed);
    } catch {
      throw new BridgeError("GitHub did not accept that token. Check that it is complete and has not expired.");
    }
    if (this.box.isEncryptionAvailable()) {
      this.slot.set(this.box.encryptString(trimmed).toString("base64"));
      this.#session = null;
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

/** Opens the pull request from `head` into `base`, or updates the body of the one already open. */
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
  const existing = await client.pulls.listForBranch(input.owner, input.repo, input.head, "open");
  const open = existing[0];
  if (open !== undefined) {
    const updated = await client.pulls.update(input.owner, input.repo, open.number, { body: input.body });
    return { url: updated.htmlUrl, number: updated.number, created: false };
  }
  const created = await client.pulls.create(input.owner, input.repo, {
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body,
  });
  return { url: created.htmlUrl, number: created.number, created: true };
}
