/**
 * Sign-out terminates Firestore and then deletes its offline cache (spec 13 section 6). When the
 * delete fails, for example because another tab still holds the shared cache, Firestore must be
 * opened again, or every later call fails until a reload, and the person is told the cache stayed
 * (issue #380 finding 4). The queued Outbox entries go back, as issue #338 made them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudError, SIGN_OUT_CACHE_KEPT } from "../src/errors.js";
import { FirebaseBackend } from "../src/firebase/firebaseBackend.js";

const firestore = vi.hoisted(() => {
  let opened = 0;
  return {
    opened: () => opened,
    initializeFirestore: vi.fn((_app: unknown, _settings: unknown) => ({ instance: ++opened })),
    terminate: vi.fn(() => Promise.resolve()),
    clearIndexedDbPersistence: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  initializeFirestore: firestore.initializeFirestore,
  terminate: firestore.terminate,
  clearIndexedDbPersistence: firestore.clearIndexedDbPersistence,
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/auth")>()),
  signOut: vi.fn(() => Promise.resolve()),
}));

let apps = 0;

function persistentBackend(): FirebaseBackend {
  apps += 1;
  return new FirebaseBackend({
    config: { projectId: "demo-zenith", apiKey: "demo-api-key", authDomain: "demo-zenith.firebaseapp.com" },
    appName: `sign-out-${String(apps)}`,
  });
}

/** The Firestore instance the backend's store now talks to. */
const storeDb = (backend: FirebaseBackend): unknown =>
  (backend as unknown as { firestoreStore: { db: unknown } }).firestoreStore.db;

/** The kind of offline cache the `at`-th call to `initializeFirestore` asked for (negative counts from the end). */
const cacheKind = (at: number): unknown =>
  (firestore.initializeFirestore.mock.calls.at(at) as unknown as [unknown, { localCache: { kind: unknown } }] | undefined)?.[1].localCache.kind;

describe("FirebaseBackend.signOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A persistent cache is used only where IndexedDB exists; nothing here opens it.
    vi.stubGlobal("indexedDB", {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a fresh Firestore after clearing the cache", async () => {
    const backend = persistentBackend();
    const before = firestore.opened();
    await backend.signOut();
    expect(firestore.clearIndexedDbPersistence).toHaveBeenCalledTimes(1);
    expect(firestore.opened()).toBe(before + 1);
    expect(storeDb(backend)).toEqual({ instance: before + 1 });
  });

  it("opens Firestore again and says the cache stayed when clearing it fails after terminate", async () => {
    const backend = persistentBackend();
    const before = firestore.opened();
    firestore.clearIndexedDbPersistence.mockRejectedValueOnce(Object.assign(new Error("in use"), { code: "failed-precondition" }));
    const failed = await backend.signOut().then(
      () => null,
      (error: unknown) => error,
    );
    expect(isCloudError(failed, "unavailable")).toBe(true);
    expect((failed as Error).message).toBe(SIGN_OUT_CACHE_KEPT);
    expect(firestore.terminate).toHaveBeenCalledTimes(1);
    expect(firestore.opened()).toBe(before + 1);
    expect(storeDb(backend)).toEqual({ instance: before + 1 });
    // The cache that stayed is never opened again: the next account in this tab must not read it.
    expect(cacheKind(-1)).toBe("memory");
    expect(cacheKind(-2)).toBe("persistent");
    // And a later sign-out has no persistent cache left to clear.
    await backend.signOut();
    expect(firestore.clearIndexedDbPersistence).toHaveBeenCalledTimes(1);
    expect(cacheKind(-1)).toBe("memory");
  });

  it("opens the persistent cache again after a sign-out that cleared it", async () => {
    persistentBackend();
    const backend = persistentBackend();
    await backend.signOut();
    expect(cacheKind(-1)).toBe("persistent");
  });

  it("leaves Firestore alone when terminate itself fails, and passes that failure on", async () => {
    const backend = persistentBackend();
    const before = firestore.opened();
    firestore.terminate.mockRejectedValueOnce(new Error("terminate failed"));
    await expect(backend.signOut()).rejects.toThrow("terminate failed");
    expect(firestore.opened()).toBe(before);
  });
});
