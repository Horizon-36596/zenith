/**
 * `DocStore.getWithPending` over the Firestore SDK: a document read with a write of this device's that
 * the server has not acknowledged applied says so, and stops saying so once the server acknowledges
 * it. The team open relies on it to leave the pin alone while the team key it reads may be a rotation
 * the server has not taken yet. The offline half needs no server; the acknowledged half runs against
 * the Firestore emulator (`pnpm test:rules`) and is skipped, saying so, without it.
 */
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectFirestoreEmulator, disableNetwork, enableNetwork, initializeFirestore, memoryLocalCache, setLogLevel, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirestoreStore } from "../src/firebase/firestoreStore.js";
import { SERVER_TIME } from "../src/store.js";
import { EMULATOR_HOST, SKIP_MESSAGE, startEmulatorEnvironment, storeOf } from "./emulatorHarness.js";

const PROJECT = "demo-zenith-pending";

const apps: FirebaseApp[] = [];
let counter = 0;

/** A Firestore client of its own, connected to the emulator when `emulator` is set. */
function firestore(emulator: boolean, uid = "alice"): Firestore {
  counter += 1;
  const app = initializeApp({ projectId: PROJECT, apiKey: "demo-key" }, `pending-${String(counter)}`);
  apps.push(app);
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  if (emulator) {
    const [host, port] = (EMULATOR_HOST ?? "").split(":");
    connectFirestoreEmulator(db, host ?? "127.0.0.1", Number(port), { mockUserToken: { user_id: uid } });
  }
  return db;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => deleteApp(app)));
});

describe("the Firestore store's pending-write signal, offline", () => {
  it("says a document written on this device and not yet sent carries a pending write", async () => {
    setLogLevel("silent");
    const db = firestore(false);
    await disableNetwork(db);
    const store = new FirestoreStore(db);
    const handle = store.commit([{ op: "set", path: "things/a", data: { n: 1 } }]);
    handle.sent.catch(() => undefined);
    expect(await store.getWithPending("things/a")).toEqual({ data: { n: 1 }, pendingWrites: true });
    const update = store.commit([{ op: "update", path: "things/a", data: { n: 2 } }]);
    update.sent.catch(() => undefined);
    expect(await store.getWithPending("things/a")).toEqual({ data: { n: 2 }, pendingWrites: true });
    expect(await store.get("things/a")).toEqual({ n: 2 });
  });
});

if (EMULATOR_HOST === undefined) {
  describe("the Firestore store's pending-write signal (Firestore emulator)", () => {
    it.skip(SKIP_MESSAGE, () => undefined);
  });
} else {
  let env: RulesTestEnvironment | undefined;
  // Loading the rules into the emulator can take longer than the default ten seconds while the other
  // emulator suites start beside it.
  beforeAll(async () => {
    env = await startEmulatorEnvironment(PROJECT);
    await env.clearFirestore();
    // A profile is written only with beta access (the private beta): open the beta for this project.
    await env.withSecurityRulesDisabled(async (context) => {
      await storeOf(context.firestore()).commit([{ op: "set", path: "config/access", data: { betaOpen: true } }]).sent;
    });
  }, 60_000);
  afterAll(async () => {
    await env?.cleanup();
  });
  describe("the Firestore store's pending-write signal (Firestore emulator)", () => {
    it("clears once the server acknowledges the write", async () => {
      setLogLevel("silent");
      const db = firestore(true);
      const store = new FirestoreStore(db);
      // A profile is the simplest document the rules let a signed-in user write for themselves.
      const path = "users/alice";
      await disableNetwork(db);
      const handle = store.commit([{ op: "set", path, data: { displayName: "alice", createdAt: SERVER_TIME } }]);
      expect((await store.getWithPending(path)).pendingWrites).toBe(true);
      await enableNetwork(db);
      await handle.sent;
      const read = await store.getWithPending(path);
      expect(read.pendingWrites).toBe(false);
      expect(read.data?.displayName).toBe("alice");
    }, 60_000);
  });
}
