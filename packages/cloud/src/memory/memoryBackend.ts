/**
 * `CloudBackend` in memory. Several backends can share one `MemoryDatabase`, one per simulated
 * device or user, and every read and write goes through the same permission rules as Firestore
 * (`rules.ts`). Nothing leaves the process, so the web app's tests and UI work can use it freely.
 *
 * Signing in is simulated: `signInAs` picks any user, and the provider and email-link methods sign
 * in a user whose uid is derived from the provider or the email address.
 */
import type { CloudUser, DeleteAccountOptions, NativeCredential, SignInProvider } from "../backend.js";
import { CloudClient } from "../client.js";
import { CloudError, DIFFERENT_ACCOUNT_NOT_DELETED, SIGN_IN_AGAIN_TO_DELETE } from "../errors.js";
import type { DeviceKeyStore } from "../crypto/device.js";
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import type { TrustStore } from "../keys/trust.js";
import type { DocStore } from "../store.js";
import { MemoryDatabase } from "./memoryStore.js";
import { MemoryStore } from "./memoryStore.js";

export interface MemoryBackendOptions {
  /** Shared by every simulated device; a new empty database when omitted. */
  database?: MemoryDatabase;
  /** The device clock. Defaults to the database's clock. */
  now?: () => Date;
  random?: RandomBytes;
  /**
   * Where this simulated device keeps its own keys. Default: memory, so each `MemoryBackend` is its
   * own device; pass one store to several backends to make them one device.
   */
  deviceKeys?: DeviceKeyStore;
  /** Where this simulated device keeps the team keys it has seen. Default: memory. */
  trust?: TrustStore;
}

const LINK_PARAMETER = "zenithMemorySignIn";

const PROVIDER_IDS: Record<SignInProvider, string> = { github: "github.com", google: "google.com", microsoft: "microsoft.com" };

const providerOfId = (providerId: string): SignInProvider | null =>
  (Object.keys(PROVIDER_IDS) as SignInProvider[]).find((provider) => PROVIDER_IDS[provider] === providerId) ?? null;

/** The one simulated user per provider that every sign-in with that provider signs in as. */
const providerUserUid = (provider: SignInProvider): string => `memory-${provider}-user`;

/** Whether a credential carries what Firebase would need, so an empty token fails as it would there. */
const usableCredential = (credential: NativeCredential): boolean =>
  credential.provider === "github"
    ? credential.accessToken !== ""
    : credential.idToken !== "" && (credential.provider !== "microsoft" || credential.rawNonce !== "");

export class MemoryBackend extends CloudClient {
  readonly kind = "memory" as const;
  readonly database: MemoryDatabase;
  readonly connection: MemoryStore;
  private user: CloudUser | null = null;
  private readonly listeners = new Set<(user: CloudUser | null) => void>();
  /** The last link `sendSignInLink` would have emailed, for tests and demos. */
  lastSignInLink: string | null = null;
  /**
   * What the next "sign in again" does when the sign-in is stale: the person finishes it, or closes
   * the window. Tests set it; the default finishes. A delete given `reauthenticate` asks that instead.
   */
  reauthentication: "finishes" | "cancelled" = "finishes";
  /** How many times the person was asked to sign in again, for tests. */
  reauthentications = 0;
  private signInStale = false;

  constructor(options: MemoryBackendOptions = {}) {
    const database = options.database ?? new MemoryDatabase();
    const now = options.now ?? database.now;
    super({
      now,
      random: options.random ?? cryptoRandomBytes,
      ...(options.deviceKeys === undefined ? {} : { deviceKeys: options.deviceKeys }),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
      ...(database.approvalKdfIterations === undefined ? {} : { approvalKdfIterations: database.approvalKdfIterations }),
    });
    this.database = database;
    this.connection = new MemoryStore(database, () => this.user?.uid ?? null, now);
  }

  protected store(): DocStore {
    return this.connection;
  }

  currentUser(): CloudUser | null {
    return this.user === null ? null : { ...this.user, providerIds: [...this.user.providerIds] };
  }

  onAuthChange(listener: (user: CloudUser | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentUser());
    return () => this.listeners.delete(listener);
  }

  /** Signs in as any user; the test and demo entry point. */
  signInAs(uid: string, options: { email?: string; providerIds?: string[] } = {}): CloudUser {
    this.user = { uid, email: options.email ?? null, providerIds: options.providerIds ?? ["memory"] };
    this.signInStale = false;
    this.emit();
    return this.currentUser() as CloudUser;
  }

  async signInWithProvider(provider: SignInProvider): Promise<CloudUser> {
    return this.signInAsProviderUser(provider);
  }

  /**
   * Like `signInWithProvider`, for a credential the app got itself: the same user per provider. The
   * fake checks only that the credential carries what Firebase would need, so a test that hands it an
   * empty token fails as it would against the real service.
   */
  async signInWithNativeCredential(credential: NativeCredential): Promise<CloudUser> {
    if (!usableCredential(credential)) throw new CloudError("invalid", "The sign-in did not return a usable credential. Try again.");
    return this.signInAsProviderUser(credential.provider);
  }

  /** The one simulated user per provider that both sign-in methods sign in as. */
  private signInAsProviderUser(provider: SignInProvider): CloudUser {
    return this.signInAs(providerUserUid(provider), { providerIds: [PROVIDER_IDS[provider]] });
  }

  async sendSignInLink(email: string, continueUrl: string): Promise<void> {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new CloudError("invalid", "That does not look like an email address.");
    const url = new URL(continueUrl);
    url.searchParams.set(LINK_PARAMETER, email);
    this.lastSignInLink = url.toString();
  }

  isSignInLink(url: string): boolean {
    try {
      return new URL(url).searchParams.has(LINK_PARAMETER);
    } catch {
      return false;
    }
  }

  async completeSignInLink(email: string, url: string): Promise<CloudUser> {
    if (!this.isSignInLink(url) || new URL(url).searchParams.get(LINK_PARAMETER) !== email) {
      throw new CloudError("invalid", "That sign-in link is not for this email address. Ask for a new link.");
    }
    return this.signInAs(`email-${email.toLowerCase()}`, { email, providerIds: ["emailLink"] });
  }

  async signOut(): Promise<void> {
    this.keys.clear();
    const drop = this.outboxList.dropQueued();
    try {
      this.connection.clear();
    } catch (error) {
      drop.restore();
      throw error;
    }
    drop.done();
    this.user = null;
    this.emit();
  }

  isOnline(): boolean {
    return this.connection.isOnline();
  }

  /** Simulates losing or regaining the connection. Coming back online sends the outbox in order. */
  async setOnline(online: boolean): Promise<void> {
    const flushed = this.connection.setOnline(online);
    this.outboxList.notify();
    await flushed;
  }

  /**
   * Simulates a sign-in too old for deleting the account, as Firebase has after a few minutes: until
   * the person signs in again, deleting the sign-in account is refused.
   */
  setSignInStale(stale = true): void {
    this.signInStale = stale;
  }

  /**
   * Like Firebase: the account's own provider signs in again, through `reauthenticate` when given
   * (the desktop app's route) and otherwise as `reauthentication` says. A credential that fails, is
   * not usable, or is another account's, refuses the delete before anything is deleted.
   */
  protected async confirmRecentSignIn(reauthenticate?: DeleteAccountOptions["reauthenticate"]): Promise<void> {
    if (!this.signInStale) return;
    this.reauthentications += 1;
    // The first of the account's sign-in methods that is a provider, as Firebase's backend picks it.
    const provider = (this.user?.providerIds ?? []).map(providerOfId).find((p) => p !== null) ?? null;
    if (reauthenticate !== undefined && provider !== null) {
      let credential: NativeCredential;
      try {
        credential = await reauthenticate(provider);
      } catch (error) {
        throw new CloudError("reauth-required", SIGN_IN_AGAIN_TO_DELETE, { cause: error });
      }
      if (!usableCredential(credential)) throw new CloudError("reauth-required", SIGN_IN_AGAIN_TO_DELETE);
      if (providerUserUid(credential.provider) !== this.user?.uid) throw new CloudError("reauth-required", DIFFERENT_ACCOUNT_NOT_DELETED);
    } else if (this.reauthentication === "cancelled") {
      throw new CloudError("reauth-required", SIGN_IN_AGAIN_TO_DELETE);
    }
    this.signInStale = false;
  }

  protected async deleteSignInAccount(): Promise<void> {
    if (this.signInStale) {
      throw new CloudError("reauth-required", "The sign-in is too old to delete; sign in again first.");
    }
    this.user = null;
    this.emit();
  }

  private emit(): void {
    const user = this.currentUser();
    for (const listener of this.listeners) listener(user);
  }
}
