/**
 * `CloudBackend` on Firebase: Authentication for sign-in and Firestore for the data, on the Spark
 * plan (ADR 0009). Firestore's offline cache is on: IndexedDB with several tabs sharing it, where
 * the platform has IndexedDB, and memory otherwise (Node, for tests).
 */
import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider } from "firebase/app-check";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  deleteUser,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  isSignInWithEmailLink,
  OAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendSignInLinkToEmail,
  signInWithCredential,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type Auth,
  type AuthCredential,
  type AuthProvider,
  type User,
} from "firebase/auth";
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  memoryLruGarbageCollector,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  type Firestore,
} from "firebase/firestore";
import type { CloudUser, DeleteAccountOptions, NativeCredential, SignInProvider } from "../backend.js";
import { CloudClient } from "../client.js";
import { CloudError, DIFFERENT_ACCOUNT_NOT_DELETED, SIGN_IN_AGAIN_TO_DELETE, SIGN_OUT_CACHE_KEPT } from "../errors.js";
import { IndexedDbDeviceKeyStore, MemoryDeviceKeyStore, type DeviceKeyStore } from "../crypto/device.js";
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import type { TrustStore } from "../keys/trust.js";
import type { DocStore } from "../store.js";
import { FirestoreStore } from "./firestoreStore.js";

export interface FirebaseBackendOptions {
  /** The web app's Firebase config from the console (cloud/README.md step 3). Not a secret. */
  config: FirebaseOptions;
  /**
   * App Check (spec 13 section 13, cloud/README.md step 7). When given, every request carries an App
   * Check token, so once enforcement is on in the console only the real app can use the quota. The
   * SDK offers both reCAPTCHA providers; which one the owner registers is a console choice.
   */
  appCheck?: { provider: "recaptcha-enterprise" | "recaptcha-v3"; siteKey: string };
  /** Keep Firestore's cache in IndexedDB so the library opens offline. Default true where possible. */
  persistence?: boolean;
  /** Point the SDK at local emulators, for tests. */
  emulators?: { firestore?: { host: string; port: number }; authUrl?: string };
  /** A name for the Firebase app, so tests can run several at once. */
  appName?: string;
  random?: RandomBytes;
  /**
   * Where this device keeps its own keys (spec 14 section 4.1). Default: IndexedDB (`zenith-keys`)
   * where there is IndexedDB and `persistence` is on, memory otherwise. Pass a `MemoryDeviceKeyStore`
   * on a shared computer, so the keys go when the page closes.
   */
  deviceKeys?: DeviceKeyStore;
  /** Where this device keeps the team keys it has seen: pass `new StorageTrustStore(localStorage)`. Default: memory. */
  trust?: TrustStore;
}

const hasIndexedDb = () => typeof globalThis.indexedDB !== "undefined";
const hasWindow = () => typeof (globalThis as { window?: unknown }).window !== "undefined";

function providerFor(provider: SignInProvider): AuthProvider {
  switch (provider) {
    case "github":
      return new GithubAuthProvider();
    case "google":
      return new GoogleAuthProvider();
    case "microsoft":
      // There is no Microsoft class in the SDK; Microsoft is the generic OAuth provider with the id
      // "microsoft.com" (ADR 0009 section 2).
      return new OAuthProvider("microsoft.com");
  }
}

/** The provider a signed-in user signs in again with, or null for an email link. */
function signInProviderOf(user: User): SignInProvider | null {
  for (const { providerId } of user.providerData) {
    if (providerId === "github.com") return "github";
    if (providerId === "google.com") return "google";
    if (providerId === "microsoft.com") return "microsoft";
  }
  return null;
}

/**
 * How recent an email-link sign-in must be for Firebase to delete the account. APPROX: Firebase says
 * only "recently" in what could be read from here, and secondary sources give five minutes. It is
 * used only for email-link accounts, which v1 does not offer; the providers always sign in
 * again instead, which needs no number.
 */
const RECENT_SIGN_IN_S = 5 * 60;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

/**
 * The Firebase credential for a sign-in the app ran itself (ADR 0011): Google's ID token, Microsoft's
 * ID token with the raw nonce whose SHA-256 the token carries, or GitHub's access token.
 */
export function nativeAuthCredential(credential: NativeCredential): AuthCredential {
  switch (credential.provider) {
    case "google":
      return GoogleAuthProvider.credential(credential.idToken);
    case "microsoft":
      return new OAuthProvider("microsoft.com").credential({ idToken: credential.idToken, rawNonce: credential.rawNonce });
    case "github":
      return GithubAuthProvider.credential(credential.accessToken);
  }
}

function toCloudUser(user: User): CloudUser {
  return {
    uid: user.uid,
    email: user.email,
    providerIds: user.providerData.map((p) => p.providerId),
  };
}

export class FirebaseBackend extends CloudClient {
  readonly kind = "firebase" as const;
  readonly app: FirebaseApp;
  readonly auth: Auth;
  private firestore: Firestore;
  private firestoreStore: FirestoreStore;
  /** Whether Firestore keeps its cache in IndexedDB; turned off for good when sign-out cannot clear it. */
  private persistent: boolean;
  private online: boolean;

  constructor(private readonly options: FirebaseBackendOptions) {
    super({
      random: options.random ?? cryptoRandomBytes,
      deviceKeys: options.deviceKeys ?? ((options.persistence ?? true) && hasIndexedDb() ? new IndexedDbDeviceKeyStore() : new MemoryDeviceKeyStore()),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
    });
    this.app = initializeApp(options.config, options.appName);
    if (options.appCheck !== undefined) {
      const { provider, siteKey } = options.appCheck;
      initializeAppCheck(this.app, {
        provider: provider === "recaptcha-enterprise" ? new ReCaptchaEnterpriseProvider(siteKey) : new ReCaptchaV3Provider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    }
    this.auth = hasWindow()
      ? initializeAuth(this.app, {
          // The session survives restarts, so a user who signed in once stays signed in offline.
          persistence: [indexedDBLocalPersistence, browserLocalPersistence],
          popupRedirectResolver: browserPopupRedirectResolver,
        })
      : getAuth(this.app);
    if (options.emulators?.authUrl !== undefined) {
      connectAuthEmulator(this.auth, options.emulators.authUrl, { disableWarnings: true });
    }
    this.persistent = (options.persistence ?? true) && hasIndexedDb();
    this.firestore = this.openFirestore();
    this.firestoreStore = new FirestoreStore(this.firestore);

    const navigatorOnline = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
    this.online = navigatorOnline ?? true;
    if (hasWindow()) {
      const target = globalThis as unknown as { addEventListener(type: string, listener: () => void): void };
      target.addEventListener("online", () => this.setOnline(true));
      target.addEventListener("offline", () => this.setOnline(false));
    }
  }

  private openFirestore(): Firestore {
    const db = initializeFirestore(this.app, {
      localCache: this.persistent
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : // The default memory cache drops documents no listener holds; LRU keeps what was read,
          // so the library still opens offline within the session (ADR 0009 section 3).
          memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() }),
    });
    const emulator = this.options.emulators?.firestore;
    if (emulator !== undefined) connectFirestoreEmulator(db, emulator.host, emulator.port);
    return db;
  }

  private setOnline(online: boolean): void {
    this.online = online;
    this.outboxList.notify();
  }

  protected store(): DocStore {
    return this.firestoreStore;
  }

  currentUser(): CloudUser | null {
    return this.auth.currentUser === null ? null : toCloudUser(this.auth.currentUser);
  }

  onAuthChange(listener: (user: CloudUser | null) => void): () => void {
    return onAuthStateChanged(this.auth, (user) => listener(user === null ? null : toCloudUser(user)));
  }

  async signInWithProvider(provider: SignInProvider): Promise<CloudUser> {
    const credential = await signInWithPopup(this.auth, providerFor(provider));
    return toCloudUser(credential.user);
  }

  /** No popup and so no origin check: the desktop app's route, whose page is not on a web address. */
  async signInWithNativeCredential(credential: NativeCredential): Promise<CloudUser> {
    const result = await signInWithCredential(this.auth, nativeAuthCredential(credential));
    return toCloudUser(result.user);
  }

  async sendSignInLink(email: string, continueUrl: string): Promise<void> {
    await sendSignInLinkToEmail(this.auth, email, { url: continueUrl, handleCodeInApp: true });
  }

  isSignInLink(url: string): boolean {
    return isSignInWithEmailLink(this.auth, url);
  }

  async completeSignInLink(email: string, url: string): Promise<CloudUser> {
    if (!this.isSignInLink(url)) throw new CloudError("invalid", "That is not a Zenith sign-in link. Ask for a new link.");
    const credential = await signInWithEmailLink(this.auth, email, url);
    return toCloudUser(credential.user);
  }

  /**
   * Signs out, then deletes the offline cache and opens a fresh, empty one (spec 13 section 6). Writes
   * still queued live in that cache, so they go with it and the Outbox marks them dropped; if a step
   * fails, the person may still be signed in with those writes queued, so the Outbox puts them back.
   * When Firestore was terminated but the cache could not be deleted (another tab holding the shared
   * cache), Firestore is opened again on a memory cache, never the one that stayed, so later calls
   * still work and the next account in this tab cannot read the last one's documents; the person is
   * told the cache was not cleared (issue #380).
   */
  async signOut(): Promise<void> {
    this.keys.clear();
    const drop = this.outboxList.dropQueued();
    let terminated = false;
    try {
      await signOut(this.auth);
      await terminate(this.firestore);
      terminated = true;
      if (this.persistent) await clearIndexedDbPersistence(this.firestore);
    } catch (error) {
      drop.restore();
      if (!terminated) throw error;
      // The cache that stayed belongs to the account that just signed out, so it is never opened
      // again here: Firestore comes back on a memory cache, which the next account starts empty.
      this.persistent = false;
      this.reopenFirestore();
      throw new CloudError("unavailable", SIGN_OUT_CACHE_KEPT, { cause: error });
    }
    drop.done();
    this.reopenFirestore();
  }

  /** A fresh Firestore after `terminate`, which refuses every later call on the old instance. */
  private reopenFirestore(): void {
    this.firestore = this.openFirestore();
    this.firestoreStore = new FirestoreStore(this.firestore);
  }

  isOnline(): boolean {
    return this.online;
  }

  /**
   * Firebase deletes a sign-in account only after a recent sign-in, and refuses with
   * `auth/requires-recent-login` otherwise. How recent is not something the client can read, so a
   * GitHub, Microsoft or Google account always signs in again, with the same provider, before
   * anything is deleted: in a popup, or through `reauthenticate` where the popup cannot open (the
   * desktop app), whose credential goes to `reauthenticateWithCredential`. Either way Firebase
   * refuses a different account with `auth/user-mismatch`. An email-link account cannot sign in
   * again here; its sign-in time is checked instead.
   */
  protected async confirmRecentSignIn(reauthenticate?: DeleteAccountOptions["reauthenticate"]): Promise<void> {
    const user = this.auth.currentUser;
    if (user === null) throw new CloudError("signed-out", "Sign in to delete your account.");
    const provider = signInProviderOf(user);
    if (provider === null) {
      const { authTime } = await user.getIdTokenResult();
      if (this.now().getTime() - Date.parse(authTime) > RECENT_SIGN_IN_S * 1000) {
        throw new CloudError(
          "reauth-required",
          "Deleting your account needs a fresh sign-in. Nothing was deleted. Sign out, sign in again with a new link, and then delete your account straight away.",
        );
      }
      return;
    }
    try {
      if (reauthenticate === undefined) await reauthenticateWithPopup(user, providerFor(provider));
      else await reauthenticateWithCredential(user, nativeAuthCredential(await reauthenticate(provider)));
    } catch (error) {
      const code = errorCode(error);
      if (code === "auth/user-mismatch") {
        throw new CloudError("reauth-required", DIFFERENT_ACCOUNT_NOT_DELETED, { cause: error });
      }
      if (code === "auth/network-request-failed") {
        throw new CloudError("unavailable", "The sign-in service cannot be reached. Nothing was deleted; try again when you are online.", { cause: error });
      }
      throw new CloudError("reauth-required", SIGN_IN_AGAIN_TO_DELETE, { cause: error });
    }
  }

  protected async deleteSignInAccount(): Promise<void> {
    const user = this.auth.currentUser;
    if (user === null) return;
    try {
      await deleteUser(user);
    } catch (error) {
      if (errorCode(error) !== "auth/requires-recent-login") throw error;
      // Only if Firebase's idea of "recent" was shorter than the time the deletes took.
      throw new CloudError(
        "reauth-required",
        "Your profile and team memberships were deleted, but the sign-in service wants you to sign in again before it deletes the sign-in itself. Sign in, then press Delete my account again.",
        { cause: error },
      );
    }
  }
}
