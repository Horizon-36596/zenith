/**
 * A refused read, or a member document shown lower, is the server's word: it may make a key change
 * fail, but it must never make a device the roster lets rotate skip the rotation. Both attacks here
 * worked before: the server refused one read, or lowered one member document, the change went
 * through under the old key, and a thief or an admin who left read what the team wrote next.
 */
import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { REMOVE_NEEDS_KEY_CHANGE, REVOKE_NEEDS_KEY_CHANGE } from "../src/client.js";
import { CloudError } from "../src/errors.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { uidOf, type Caller } from "./cryptoHelpers.js";
import type { DocData, Query } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (b: MemoryBackend): KeyRing => (b as unknown as { keys: KeyRing }).keys;
async function codeOf(device: MemoryBackend, teamId: string) {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("already holds");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string) {
  const member = await person(database, uid);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const { deviceId, approvalCode } = await codeOf(member, teamId);
  await (await approver.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
  await member.listAutos(teamId);
  return member;
}
const kvOf = (db: MemoryDatabase, teamId: string) => (db.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
async function publish(author: MemoryBackend, teamId: string, autoId: string, content: string): Promise<string> {
  const base = (await author.listRevisions(teamId, autoId))[0]!.id;
  const revision = await author.publishRevision({ teamId, autoId, baseRevision: base, content });
  await revision.sent;
  return revision.value.id;
}

async function setup() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const alice = await person(database, "alice");
  const team = await alice.createTeam({ number: 36596, name: "Horizon" });
  await team.sent;
  const teamId = team.value.id;
  const auto = await alice.createAuto(teamId, { title: "Close side" });
  await auto.sent;
  await (await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"one"}' })).sent;
  return { database, alice, teamId, autoId: auto.value.id, recoveryCode: team.value.recoveryCode };
}

describe("an owner revoking a teammate's stolen phone while the server refuses her one grant listing", () => {
  it("fails and changes nothing, instead of marking the key pending, and a second try rotates it", async () => {
    const { database, alice, teamId, autoId } = await setup();
    const bob = await join(database, alice, teamId, "bob");
    await (await alice.completeKeyRotation(teamId)).sent; // Bob's device is now in the roster, as an editor's.
    await bob.listAutos(teamId);
    const bobDevice = (await keysOf(bob).device()).deviceId;
    const kv = kvOf(database, teamId);

    const realQuery = database.query.bind(database);
    let lied = false;
    database.query = (caller: Caller, query: Query) => {
      if (!lied && uidOf(caller) === "alice" && query.collection.endsWith("/keyGrants") && (query.where ?? []).length === 0) {
        lied = true;
        throw new CloudError("permission-denied", "Missing or insufficient permissions.");
      }
      return realQuery(caller, query);
    };
    await expect(alice.revokeDevice(teamId, bobDevice)).rejects.toMatchObject({ code: "permission-denied", message: REVOKE_NEEDS_KEY_CHANGE });
    database.query = realQuery;
    expect(lied).toBe(true);
    expect(kvOf(database, teamId)).toBe(kv);
    expect(database.peek(`teams/${teamId}`)).not.toMatchObject({ rotationPending: true });
    expect(database.peek(`teams/${teamId}/keyGrants/${bobDevice}`)).not.toBeNull();

    await (await alice.revokeDevice(teamId, bobDevice)).sent;
    expect(kvOf(database, teamId)).toBe(kv + 1);
    const after = await publish(alice, teamId, autoId, '{"secret":"written after the revocation"}');
    keysOf(bob).forget(teamId);
    const read = await bob.openRevision(teamId, autoId, after).then((r) => r?.content ?? null, () => null);
    expect(read).toBeNull();
  }, 60_000);
});

describe("an owner using the recovery code on a new laptop while the server shows her as an editor and hides a pending rotation", () => {
  it("does not write under a key an admin who left still holds", async () => {
    const { database, alice, teamId, autoId, recoveryCode } = await setup();
    const carol = await join(database, alice, teamId, "carol");
    await (await alice.setRole(teamId, "carol", "admin")).sent;
    await carol.listAutos(teamId);
    const carolDevice = (await keysOf(carol).device()).deviceId;
    const carolGrant = database.peek(`teams/${teamId}/keyGrants/${carolDevice}`)!;
    const carolMember = database.peek(`teams/${teamId}/members/carol`)!;
    await (await carol.leaveTeam(teamId)).sent;
    database.seed(`teams/${teamId}`, { ...database.peek(`teams/${teamId}`)!, rotationPending: false });
    const kv = kvOf(database, teamId);

    const aliceMember = `teams/${teamId}/members/alice`;
    const realRead = database.read.bind(database);
    database.read = (caller: Caller, path: string) => {
      const doc = realRead(caller, path);
      return path === aliceMember && doc !== null ? { ...doc, role: "editor" } : doc;
    };
    const laptop = await person(database, "alice");
    const used = await laptop.useRecoveryCode(teamId, recoveryCode).then(async (queued) => { await queued.sent; return true; }, () => false);
    database.read = realRead;
    if (!used) return; // Refusing is safe: the laptop holds no key to write under.

    expect(kvOf(database, teamId)).toBeGreaterThan(kv);
    const written = await publish(laptop, teamId, autoId, '{"secret":"written on the laptop"}');
    database.seed(`teams/${teamId}/members/carol`, carolMember as DocData);
    database.seed(`teams/${teamId}/keyGrants/${carolDevice}`, carolGrant as DocData);
    keysOf(carol).forget(teamId);
    const read = await carol.openRevision(teamId, autoId, written).then((r) => r?.content ?? null, () => null);
    expect(read).toBeNull();
  }, 60_000);
});

describe("an owner removing an editor while the server withholds her own grant once", () => {
  it("fails and changes nothing, instead of marking the key pending, and a second try rotates it", async () => {
    const { database, alice, teamId } = await setup();
    const bob = await join(database, alice, teamId, "bob");
    await (await alice.completeKeyRotation(teamId)).sent; // Bob is now in the roster, as an editor.
    await bob.listAutos(teamId);
    const aliceGrant = `teams/${teamId}/keyGrants/${(await keysOf(alice).device()).deviceId}`;
    const kv = kvOf(database, teamId);
    keysOf(alice).forget(teamId);

    const realRead = database.read.bind(database);
    let lied = false;
    database.read = (caller: Caller, path: string) => {
      if (!lied && uidOf(caller) === "alice" && path === aliceGrant) {
        lied = true;
        return null;
      }
      return realRead(caller, path);
    };
    await expect(alice.removeMember(teamId, "bob")).rejects.toMatchObject({ code: "no-key", message: REMOVE_NEEDS_KEY_CHANGE });
    database.read = realRead;
    expect(lied).toBe(true);
    expect(kvOf(database, teamId)).toBe(kv);
    expect(database.peek(`teams/${teamId}`)).not.toMatchObject({ rotationPending: true });
    expect(database.peek(`teams/${teamId}/members/bob`)).not.toBeNull();

    await (await alice.removeMember(teamId, "bob")).sent;
    expect(kvOf(database, teamId)).toBe(kv + 1);
  }, 60_000);
});
