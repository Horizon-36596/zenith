/**
 * A team this device opened once is served from memory while the team document still shows the key
 * it checked (keys/keyring.ts, `openTeam`). The team's safety code is made from the team document's
 * `encKey`, so the cached open must hold to every public field of it, not only the version and the
 * encryption key's fingerprint: a server that swaps the signing key beside the right encryption key
 * would show a member, and through them a partner who compares codes, a false code.
 */
import { describe, expect, it } from "vitest";
import { generateDeviceKeys, MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;

async function teamOfTwoVersions(database: MemoryDatabase) {
  const alice = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  alice.signInAs("alice");
  await (await alice.saveProfile({ displayName: "alice" })).sent;
  const made = await alice.createTeam({ number: 36596, name: "Horizon" });
  await made.sent;
  const teamId = made.value.id;
  // At version 2 the key carries a signature from version 1, which a swap can change too.
  await (await alice.completeKeyRotation(teamId)).sent;
  return { alice, teamId };
}

describe("a cached open of a team", () => {
  for (const swap of ["the signing key", "the signature"] as const) {
    it(`is not served when the server swaps ${swap} beside the encryption key the cache checked`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId } = await teamOfTwoVersions(database);
      const before = await alice.teamKeyStatus(teamId);
      if (before.state !== "ready") throw new Error("Alice's device holds the key.");
      // The cached open is served from here on.
      await keysOf(alice).openTeam(teamId);

      const team = database.peek(`teams/${teamId}`) as DocData & { encKey: { signSpki: Uint8Array; sig: Uint8Array } };
      const other = await generateDeviceKeys();
      const encKey = swap === "the signing key" ? { ...team.encKey, signSpki: other.signSpki } : { ...team.encKey, sig: new Uint8Array(64).fill(7) };
      database.seed(`teams/${teamId}`, { ...team, encKey } as unknown as DocData);

      expect(await code(keysOf(alice).openTeam(teamId))).toBe("tampered");
      expect(await code(alice.teamKeyStatus(teamId))).toBe("tampered");
    }, 30_000);
  }
});
