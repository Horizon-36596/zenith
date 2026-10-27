/**
 * Connects the permission suite to the Firestore emulator, loading cloud/firestore.rules. The
 * emulator is found through FIRESTORE_EMULATOR_HOST, which `firebase emulators:exec` sets
 * (`pnpm test:rules`). Without it the emulator suites are skipped, and say why.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { setLogLevel, type Firestore } from "firebase/firestore";
import { FirestoreStore } from "../src/firebase/firestoreStore.js";
import type { DocData, Write } from "../src/store.js";
import type { PermissionHarness } from "./permissions.suite.js";

export const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

export const SKIP_MESSAGE =
  "Firestore emulator tests skipped: FIRESTORE_EMULATOR_HOST is not set. Run `pnpm test:rules` " +
  "(it needs Java 21 and downloads the emulator on first use) to run them against cloud/firestore.rules.";

const RULES_PATH = fileURLToPath(new URL("../../../cloud/firestore.rules", import.meta.url));

export async function startEmulatorEnvironment(projectId: string): Promise<RulesTestEnvironment> {
  const [host, port] = (EMULATOR_HOST ?? "").split(":");
  setLogLevel("silent");
  return initializeTestEnvironment({
    projectId,
    firestore: { host: host ?? "127.0.0.1", port: Number(port), rules: readFileSync(RULES_PATH, "utf8") },
  });
}

/** The compat Firestore from rules-unit-testing works with the modular functions the store uses. */
export function storeOf(firestore: unknown): FirestoreStore {
  return new FirestoreStore(firestore as Firestore);
}

export function emulatorHarness(env: () => RulesTestEnvironment): PermissionHarness {
  return {
    async reset(docs: Record<string, DocData>) {
      await env().clearFirestore();
      await env().withSecurityRulesDisabled(async (ctx) => {
        const writes: Write[] = Object.entries(docs).map(([path, data]) => ({ op: "set", path, data }));
        for (let i = 0; i < writes.length; i += 400) await storeOf(ctx.firestore()).commit(writes.slice(i, i + 400)).sent;
      });
    },
    as: (uid) => storeOf(uid === null ? env().unauthenticatedContext().firestore() : env().authenticatedContext(uid).firestore()),
    async peek(path) {
      let data: DocData | null = null;
      await env().withSecurityRulesDisabled(async (ctx) => {
        data = await storeOf(ctx.firestore()).get(path);
      });
      return data;
    },
  };
}
