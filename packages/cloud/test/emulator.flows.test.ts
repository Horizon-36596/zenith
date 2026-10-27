import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
  initializeFirestore,
  memoryLocalCache,
  memoryLruGarbageCollector,
} from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { FirestoreStore } from "../src/firebase/firestoreStore.js";
import { EMULATOR_HOST, SKIP_MESSAGE, emulatorHarness, startEmulatorEnvironment } from "./emulatorHarness.js";
import { defineFlowSuite } from "./flows.suite.js";
import { StoreClient } from "./storeClient.js";

const PROJECT = "demo-zenith-flows";
let env: RulesTestEnvironment | undefined;
const apps: FirebaseApp[] = [];
let counter = 0;

/** One simulated device: its own Firebase app, memory cache and emulator connection as `uid`. */
function device(uid: string | null, email: string | null = null): StoreClient {
  const [host, port] = (EMULATOR_HOST ?? "").split(":");
  counter += 1;
  const app = initializeApp({ projectId: PROJECT, apiKey: "demo-key" }, `device-${String(counter)}`);
  apps.push(app);
  const db = initializeFirestore(app, { localCache: memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() }) });
  connectFirestoreEmulator(db, host ?? "127.0.0.1", Number(port), uid === null ? undefined : { mockUserToken: { user_id: uid, ...(email === null ? {} : { email }) } });
  return new StoreClient(new FirestoreStore(db), uid, (online) => (online ? enableNetwork(db) : disableNetwork(db)), email);
}

// Each case makes several round trips to the emulator, which is far slower than memory.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

if (EMULATOR_HOST === undefined) {
  describe("cloud client flows (Firestore emulator)", () => {
    it.skip(SKIP_MESSAGE, () => undefined);
  });
} else {
  beforeAll(async () => {
    env = await startEmulatorEnvironment(PROJECT);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => deleteApp(app)));
  });
  afterAll(async () => {
    await env?.cleanup();
  });
  defineFlowSuite("Firestore emulator and SDK, cloud/firestore.rules", () => {
    const base = emulatorHarness(() => {
      if (env === undefined) throw new Error("The emulator environment did not start.");
      return env;
    });
    return {
      reset: (docs) => base.reset(docs),
      user: async (uid, options) => device(uid, options?.email ?? null),
      anonymous: async () => device(null),
      peek: (path) => base.peek(path),
    };
  });
}
