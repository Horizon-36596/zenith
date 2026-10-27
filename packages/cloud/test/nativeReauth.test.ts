/**
 * Delete my account signs the person in again first, because Firebase deletes only a recent
 * sign-in. In a browser that is Firebase's popup; in the desktop app, whose page the popup refuses,
 * the caller hands in `reauthenticate`, which runs the desktop sign-in for the account's own provider,
 * and its credential goes to `reauthenticateWithCredential`. Either way, a sign-in that is cancelled,
 * fails, or is another account's deletes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCredential, SignInProvider } from "../src/backend.js";
import { DIFFERENT_ACCOUNT_NOT_DELETED, isCloudError, SIGN_IN_AGAIN_TO_DELETE } from "../src/errors.js";
import { FirebaseBackend } from "../src/firebase/firebaseBackend.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

const auth = vi.hoisted(() => ({
  reauthenticateWithPopup: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("firebase/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("firebase/auth")>()), ...auth }));

const CREDENTIALS: Record<SignInProvider, NativeCredential> = {
  github: { provider: "github", accessToken: "gh-token" },
  google: { provider: "google", idToken: "google-id-token" },
  microsoft: { provider: "microsoft", idToken: "ms-id-token", rawNonce: "raw" },
};

const nothingDeleted = (e: unknown) => isCloudError(e, "reauth-required") && /Nothing was deleted/.test((e as Error).message);

/** Stands in for the rest of the delete, which needs Firestore: reaching it means the sign-in passed. */
class ReachedTheDeletes extends Error {}

let apps = 0;

/** A FirebaseBackend whose signed-in user is a stand-in with the given sign-in method. */
async function firebaseSignedInWith(providerId: string) {
  apps += 1;
  const backend = new FirebaseBackend({
    config: { projectId: "demo-zenith", apiKey: "demo-api-key", authDomain: "demo-zenith.firebaseapp.com" },
    persistence: false,
    appName: `native-reauth-${String(apps)}`,
  });
  // After Auth has read its (empty) saved session, so the stand-in is not mistaken for one.
  await backend.auth.authStateReady();
  const user = { uid: "vic", email: null, providerData: [{ providerId }] };
  Object.defineProperty(backend.auth, "currentUser", { get: () => user });
  const deletes = vi.spyOn(backend, "listMyTeams").mockRejectedValue(new ReachedTheDeletes());
  return { backend, user, deletes };
}

describe("FirebaseBackend.deleteAccount signs in again", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.reauthenticateWithPopup.mockResolvedValue(undefined);
    auth.reauthenticateWithCredential.mockResolvedValue(undefined);
  });

  it("through reauthenticate, for the account's own provider, when it is given, and never in a popup", async () => {
    for (const [providerId, provider] of [
      ["github.com", "github"],
      ["google.com", "google"],
      ["microsoft.com", "microsoft"],
    ] as const) {
      vi.clearAllMocks();
      const { backend, user, deletes } = await firebaseSignedInWith(providerId);
      const reauthenticate = vi.fn(async (asked: SignInProvider) => CREDENTIALS[asked]);
      await expect(backend.deleteAccount({ reauthenticate })).rejects.toBeInstanceOf(ReachedTheDeletes);
      expect(reauthenticate).toHaveBeenCalledWith(provider);
      expect(auth.reauthenticateWithCredential).toHaveBeenCalledTimes(1);
      const [withUser, credential] = auth.reauthenticateWithCredential.mock.calls[0] as [unknown, { providerId: string }];
      expect(withUser).toBe(user);
      expect(credential.providerId).toBe(providerId);
      expect(auth.reauthenticateWithPopup).not.toHaveBeenCalled();
      expect(deletes).toHaveBeenCalledTimes(1);
    }
  });

  it("in Firebase's popup, with the account's own provider, when reauthenticate is not given", async () => {
    const { backend, user } = await firebaseSignedInWith("google.com");
    await expect(backend.deleteAccount()).rejects.toBeInstanceOf(ReachedTheDeletes);
    expect(auth.reauthenticateWithPopup).toHaveBeenCalledTimes(1);
    const [withUser, provider] = auth.reauthenticateWithPopup.mock.calls[0] as [unknown, { providerId: string }];
    expect(withUser).toBe(user);
    expect(provider.providerId).toBe("google.com");
    expect(auth.reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it("deletes nothing when the desktop sign-in is cancelled or fails", async () => {
    const { backend, deletes } = await firebaseSignedInWith("github.com");
    const reauthenticate = vi.fn(async () => {
      throw new Error("Sign-in was cancelled.");
    });
    await expect(backend.deleteAccount({ reauthenticate })).rejects.toSatisfy(
      (e: unknown) => nothingDeleted(e) && (e as Error).message === SIGN_IN_AGAIN_TO_DELETE,
    );
    expect(auth.reauthenticateWithCredential).not.toHaveBeenCalled();
    expect(auth.reauthenticateWithPopup).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes nothing when Firebase refuses the credential as another account's", async () => {
    const { backend, deletes } = await firebaseSignedInWith("microsoft.com");
    auth.reauthenticateWithCredential.mockRejectedValue(Object.assign(new Error("mismatch"), { code: "auth/user-mismatch" }));
    await expect(backend.deleteAccount({ reauthenticate: async () => CREDENTIALS.microsoft })).rejects.toSatisfy(
      (e: unknown) => nothingDeleted(e) && (e as Error).message === DIFFERENT_ACCOUNT_NOT_DELETED,
    );
    expect(deletes).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });
});

describe("MemoryBackend.deleteAccount signs in again the same way", () => {
  async function memberSignedInWith(provider: SignInProvider) {
    const database = new MemoryDatabase();
    const backend = new MemoryBackend({ database });
    const user = await backend.signInWithProvider(provider);
    await (await backend.saveProfile({ displayName: "Vic" })).sent;
    backend.setSignInStale();
    return { backend, database, uid: user.uid };
  }

  it("asks reauthenticate for the account's own provider and deletes once it hands back that account", async () => {
    const { backend, database, uid } = await memberSignedInWith("microsoft");
    const reauthenticate = vi.fn(async (asked: SignInProvider) => CREDENTIALS[asked]);
    await backend.deleteAccount({ reauthenticate });
    expect(reauthenticate).toHaveBeenCalledWith("microsoft");
    expect(backend.reauthentications).toBe(1);
    expect(backend.currentUser()).toBeNull();
    expect(database.peek(`users/${uid}`)).toBeNull();
  });

  it("deletes nothing when the desktop sign-in is cancelled, whatever reauthentication says", async () => {
    const { backend, database, uid } = await memberSignedInWith("github");
    backend.reauthentication = "finishes";
    await expect(
      backend.deleteAccount({
        reauthenticate: async () => {
          throw new Error("Sign-in was cancelled.");
        },
      }),
    ).rejects.toSatisfy((e: unknown) => nothingDeleted(e) && (e as Error).message === SIGN_IN_AGAIN_TO_DELETE);
    expect(backend.currentUser()?.uid).toBe(uid);
    expect(database.peek(`users/${uid}`)).not.toBeNull();
  });

  it("deletes nothing when the sign-in is another account's, or hands back an unusable credential", async () => {
    const { backend, database, uid } = await memberSignedInWith("github");
    await expect(backend.deleteAccount({ reauthenticate: async () => CREDENTIALS.google })).rejects.toSatisfy(
      (e: unknown) => nothingDeleted(e) && (e as Error).message === DIFFERENT_ACCOUNT_NOT_DELETED,
    );
    await expect(backend.deleteAccount({ reauthenticate: async () => ({ provider: "github", accessToken: "" }) })).rejects.toSatisfy(
      nothingDeleted,
    );
    expect(backend.currentUser()?.uid).toBe(uid);
    expect(database.peek(`users/${uid}`)).not.toBeNull();
  });
});
