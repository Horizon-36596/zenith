/**
 * The signed device roster (keys/roster.ts): what a rotation keeps, and what a device that opens the
 * team accepts. The attacks are played by the server working with a member who holds the key, and
 * each failed before the roster: the member kept reading the team's paths after she was removed.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  createRecovery,
  createTeamKeys,
  deviceRecord,
  generateDeviceKeys,
  makeGrantProof,
  makeKeyGrant,
  MemoryDeviceKeyStore,
  newRecoveryCode,
  openKeyGrant,
  openRecovery,
  openRecoverySigner,
  openText,
  recoveryCodeFromText,
  recoveryFingerprint,
  rotateTeamKeys,
  sealBytes,
  wrapToPublicKey,
  type DeviceKeys,
  type Envelope,
  type KeyGrant,
  type RecoveryRecord,
  type NewTeamKeys,
  type TeamKey,
} from "../src/crypto/index.js";
import { exportAesKey, sha256 } from "../src/crypto/primitives.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { cryptoRandomBytes } from "../src/ids.js";
import { CANNOT_REMOVE_ADMIN, CannotRotateError, MAX_DEVICES_PER_MEMBER, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { endorseRecoveredDevice, mayRotate, openRoster, paddedRosterLength, rosterNonce, sealRoster, type Roster, type RosterKeys } from "../src/keys/roster.js";
import { MAX_ROSTER_BYTES, type TeamKeyDoc } from "../src/types.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { DELETE_FIELD, SERVER_TIME, type DocData, type Write } from "../src/store.js";

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

/** A signed-in user on a device of their own. */
async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

/** The key session inside a backend, as a member's own app holds it. */
function keysOf(backend: MemoryBackend): KeyRing {
  return (backend as unknown as { keys: KeyRing }).keys;
}

/** The device id and approval code a waiting device shows for `teamId`. */
async function codeOf(device: MemoryBackend, teamId: string): Promise<{ deviceId: string; approvalCode: string }> {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}

/** Alice's team, with one auto and a secret path in its first revision. */
async function library(database: MemoryDatabase, aliceKeys = new MemoryDeviceKeyStore(), aliceTrust = new MemoryTrustStore()) {
  const alice = await person(database, "alice", aliceKeys, aliceTrust);
  const team = await alice.createTeam({ number: 36596, name: "Horizon" });
  await team.sent;
  const teamId = team.value.id;
  const auto = await alice.createAuto(teamId, { title: "Close side" });
  await auto.sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"far-side 7-ball"}' });
  await r1.sent;
  return { alice, teamId, autoId: auto.value.id, r1: r1.value.id, recoveryCode: team.value.recoveryCode };
}

/** A member who joins through an invite that approves at once, and gets the key from `approver`. */
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()) {
  const member = await person(database, uid, deviceKeys, trust);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const { deviceId, approvalCode } = await codeOf(member, teamId);
  await (await approver.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
  // The member's device opens the team, which pins it; a grant nobody opened needs asking again after a rotation.
  await member.listAutos(teamId);
  return member;
}

/** Another device of a member who is already in the team, waiting for the key. */
function newDevice(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  return person(database, uid);
}

/** Asks for the key on `device` and has `approver` type the code it shows. */
async function approveDevice(device: MemoryBackend, approver: MemoryBackend, teamId: string): Promise<void> {
  await (await device.requestTeamKey(teamId)).sent;
  const { deviceId, approvalCode } = await codeOf(device, teamId);
  await (await approver.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
  await device.listAutos(teamId);
}

/** The team key a device's grant holds, opened with that device's private key, as the device's thief would. */
async function keyFromGrant(database: MemoryDatabase, teamId: string, device: DeviceKeys): Promise<TeamKey | null> {
  const grant = database.peek(`teams/${teamId}/keyGrants/${device.deviceId}`) as (KeyGrant & { approverUid: string }) | null;
  if (grant === null) return null;
  const approver = grant.approverDeviceId === device.deviceId
    ? deviceRecord(device)
    : (database.peek(`users/${grant.approverUid}/devices/${grant.approverDeviceId}`) as unknown as ReturnType<typeof deviceRecord>);
  return openKeyGrant({ teamId, grant, device, approver: { deviceId: grant.approverDeviceId, record: approver } });
}

/** A revision's content, opened with `key`, or null when `key` does not open it. */
async function readWith(database: MemoryDatabase, teamId: string, autoId: string, revisionId: string, key: TeamKey): Promise<string | null> {
  const doc = database.peek(`teams/${teamId}/autos/${autoId}/revisions/${revisionId}`) as { content: Envelope } | null;
  if (doc === null || doc.content.kv !== key.version) return null;
  return openText(key, doc.content, aadFor.revision({ teamId, autoId, revisionId, field: "content", kv: doc.content.kv })).catch(() => null);
}

/** The version of the team's key. */
function keyVersion(database: MemoryDatabase, teamId: string): number {
  return (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
}

/** Applies `writes` as the server, without the rules. */
function serverApplies(database: MemoryDatabase, writes: readonly Write[]): void {
  for (const write of writes) {
    if (write.op === "delete") {
      unseed(database, write.path);
    } else if (write.op === "set") {
      database.seed(write.path, write.data);
    } else {
      const next: DocData = { ...(database.peek(write.path) ?? {}), ...write.data };
      for (const [key, value] of Object.entries(write.data)) if (value === DELETE_FIELD) delete next[key];
      database.seed(write.path, next);
    }
  }
}

/** The server removes a document, bypassing the rules. */
function unseed(database: MemoryDatabase, path: string): void {
  (database as unknown as { docs: Map<string, DocData> }).docs.delete(path);
}

/** A new revision by `author`, and its id. */
async function publish(author: MemoryBackend, teamId: string, autoId: string, content: string): Promise<string> {
  const base = (await author.listRevisions(teamId, autoId))[0]!.id;
  const revision = await author.publishRevision({ teamId, autoId, baseRevision: base, content });
  await revision.sent;
  return revision.value.id;
}

/** The same device in a new session, so nothing it opened before is kept in memory. */
function fresh(database: MemoryDatabase, uid: string, deviceKeys: MemoryDeviceKeyStore, trust: MemoryTrustStore): MemoryBackend {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  return backend;
}

// Alone each test here takes about 2 s, but test:rules runs every cloud test beside the Firestore
// emulator, where one passed 30 s (issue #423). The long limit only stops that load from failing them.

describe("a member who plants a device under a teammate's name, working with the server", () => {
  for (const mode of ["approved by itself", "approved by a made-up device"] as const) {
    it(`gets it nothing once she is removed, when the grant is ${mode}`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId, autoId } = await library(database);
      const mallory = await join(database, alice, teamId, "mallory");
      const eve = await join(database, alice, teamId, "eve");
      // Mallory holds key 1. The server seeds a device record under Eve's uid, and Mallory makes its
      // grant: signed by the device itself, or by another made-up device with no grant, and proved
      // under key 1, which she can do.
      const opened = await keysOf(mallory).openTeam(teamId, { extractable: true });
      const teamKey = opened.newest.key;
      const planted = await generateDeviceKeys();
      database.seed(`users/eve/devices/${planted.deviceId}`, { ...deviceRecord(planted), createdAt: SERVER_TIME });
      let approver: DeviceKeys = planted;
      if (mode === "approved by a made-up device") {
        approver = await generateDeviceKeys();
        database.seed(`users/eve/devices/${approver.deviceId}`, { ...deviceRecord(approver), createdAt: SERVER_TIME });
      }
      const grant = await makeKeyGrant({ teamId, teamKey, recipient: { deviceId: planted.deviceId, uid: "eve", record: deviceRecord(planted) }, approver });
      const proof = await makeGrantProof({ teamId, deviceId: planted.deviceId, uid: "eve", fingerprint: planted.fingerprint, teamKey });
      database.seed(`teams/${teamId}/keyGrants/${planted.deviceId}`, {
        ...grant, uid: "eve", proof, approverUid: "eve", createdAt: SERVER_TIME, updatedAt: SERVER_TIME,
      } as unknown as DocData);

      // Alice removes Mallory, which rotates to key 2, and later rotates again to key 3.
      await (await alice.removeMember(teamId, "mallory")).sent;
      expect(keyVersion(database, teamId)).toBe(2);
      expect(database.peek(`teams/${teamId}/keyGrants/${planted.deviceId}`)).toBe(null);
      const r2 = await publish(alice, teamId, autoId, '{"secret":"after removal"}');
      await (await alice.completeKeyRotation(teamId)).sent;
      expect(database.peek(`teams/${teamId}/keyGrants/${planted.deviceId}`)).toBe(null);
      const stolen = await keyFromGrant(database, teamId, planted).catch(() => null);
      expect(stolen === null ? null : await readWith(database, teamId, autoId, r2, stolen)).toBe(null);
      // Eve's real device keeps the key throughout.
      expect((await eve.openRevision(teamId, autoId, r2))?.content).toBe('{"secret":"after removal"}');
    }, 120_000);
  }
});

describe("a member who swaps in a recovery record of her own, working with the server", () => {
  it("gets no later key from it: a rotation wraps the next key only to the recovery key the signed roster names", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, recoveryCode } = await library(database);
    const mallory = await join(database, alice, teamId, "mallory");
    const opened = await keysOf(mallory).openTeam(teamId, { extractable: true });
    // A recovery record for a code Mallory made, holding key 1, with its check sealed under key 1.
    const real = database.peek(`teams/${teamId}/recovery/current`) as DocData;
    const theirs = newRecoveryCode();
    const record = await createRecovery({ teamId, teamKey: opened.newest.key, code: theirs });
    database.seed(`teams/${teamId}/recovery/current`, { ...record, updatedBy: "alice", updatedAt: new Date() } as unknown as DocData);

    // The rotation is refused, so the removal waits for a key change; nothing is wrapped to Mallory's record.
    expect(await code(alice.removeMember(teamId, "mallory").then((q) => q.sent))).toBe("tampered");
    const now = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
    const key = await openRecovery({ teamId, record: now, code: theirs }).catch(() => null);
    expect(key?.version ?? 0).toBeLessThanOrEqual(1);

    // With the real record back, the removal rotates, and only the team's own code opens the new key.
    database.seed(`teams/${teamId}/recovery/current`, real);
    await (await alice.removeMember(teamId, "mallory")).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    const after = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
    expect(await openRecovery({ teamId, record: after, code: theirs }).catch(() => null)).toBe(null);
    expect((await openRecovery({ teamId, record: after, code: await recoveryCodeFromText(recoveryCode) })).version).toBe(2);
  }, 120_000);
});

describe("a member who relabels her own device as a teammate's, working with the server", () => {
  for (const when of ["approved since the last rotation", "in the roster since a rotation"] as const) {
    it(`gets it nothing once she is removed, when her device was ${when}`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId, autoId } = await library(database);
      const malloryKeys = new MemoryDeviceKeyStore();
      const mallory = await join(database, alice, teamId, "mallory", malloryKeys);
      await join(database, alice, teamId, "eve");
      if (when === "in the roster since a rotation") await (await alice.completeKeyRotation(teamId)).sent;
      const device = (await malloryKeys.load("mallory"))!;
      // Alice approved Mallory's device. The server copies its record under Eve's uid and names Eve
      // on the grant, and Mallory, who holds the key, makes the proof again for Eve's uid.
      const opened = await keysOf(mallory).openTeam(teamId, { extractable: true });
      const path = `teams/${teamId}/keyGrants/${device.deviceId}`;
      const grant = database.peek(path) as DocData;
      database.seed(`users/eve/devices/${device.deviceId}`, database.peek(`users/mallory/devices/${device.deviceId}`) as DocData);
      const proof = await makeGrantProof({ teamId, deviceId: device.deviceId, uid: "eve", fingerprint: device.fingerprint, teamKey: opened.newest.key });
      database.seed(path, { ...grant, uid: "eve", proof });

      await (await alice.removeMember(teamId, "mallory")).sent;
      expect(database.peek(path)).toBe(null);
      const r2 = await publish(alice, teamId, autoId, '{"secret":"after removal"}');
      const stolen = await keyFromGrant(database, teamId, device).catch(() => null);
      expect(stolen === null ? null : await readWith(database, teamId, autoId, r2, stolen)).toBe(null);
    }, 120_000);
  }
});

describe("a device roster the server swaps", () => {
  it("is refused by a device that saw the team before, whether the pinned roster or a newer one is swapped", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId } = await library(database);
    const bobKeys = new MemoryDeviceKeyStore();
    const bobTrust = new MemoryTrustStore();
    const bob = await person(database, "bob", bobKeys, bobTrust);
    const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await bob.redeemInvite(invite.value.code)).sent;
    const bobCode = await codeOf(bob, teamId);
    await (await alice.grantDeviceKey(teamId, bobCode.deviceId, bobCode.approvalCode)).sent;
    const eve = await join(database, alice, teamId, "eve");
    // Bob's device opens the team at key 1 and pins its roster.
    expect((await bob.listAutos(teamId)).length).toBe(1);
    await (await alice.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(2);

    // Eve holds key 2 but was never an owner or admin: a roster 2 she makes and signs is refused by
    // Bob's device, which pinned roster 1 and walks from it.
    const record2Path = `teams/${teamId}/teamKeys/2`;
    const record2 = database.peek(record2Path) as DocData;
    const opened = await keysOf(eve).openTeam(teamId, { extractable: true });
    const hers: Roster = {
      ...opened.roster,
      rotator: opened.device.deviceId,
      nonce: rosterNonce(cryptoRandomBytes),
      devices: [...opened.roster.devices.filter((d) => d.deviceId !== opened.device.deviceId), { deviceId: opened.device.deviceId, uid: "eve", encSpki: opened.device.encSpki, signSpki: opened.device.signSpki, fingerprint: opened.device.fingerprint }],
    };
    const sealed = await sealRoster({
      teamId, key: opened.newest.key, pairSpki: record2.pairSpki as Uint8Array, signSpki: record2.signSpki as Uint8Array, roster: hers,
      signer: opened.device.signing.privateKey, random: cryptoRandomBytes,
    });
    const refused = () => code(fresh(database, "bob", bobKeys, bobTrust).listAutos(teamId));
    database.seed(record2Path, { ...record2, roster: sealed.roster as unknown as DocData, rosterSig: sealed.rosterSig });
    expect(await refused()).toBe("tampered");
    // The real roster 2 with a signature that is not its rotator's is refused too.
    database.seed(record2Path, { ...record2, rosterSig: sealed.rosterSig });
    expect(await refused()).toBe("tampered");
    // With the real record, Bob's device walks to roster 2 and pins it.
    database.seed(record2Path, record2);
    expect((await fresh(database, "bob", bobKeys, bobTrust).listAutos(teamId)).length).toBe(1);

    // The pinned roster sealed again under the same key, so that it opens and says the same, has
    // another digest, and is refused.
    const plain2 = await openRoster(teamId, opened.newest.key, record2 as unknown as { kv: number; roster: Envelope });
    const aliceOpened = await keysOf(alice).openTeam(teamId);
    const resealed = await sealRoster({
      teamId, key: opened.newest.key, pairSpki: record2.pairSpki as Uint8Array, signSpki: record2.signSpki as Uint8Array,
      roster: plain2.roster, signer: aliceOpened.device.signing.privateKey, random: cryptoRandomBytes,
    });
    database.seed(record2Path, { ...record2, roster: resealed.roster as unknown as DocData, rosterSig: resealed.rosterSig });
    const error = await fresh(database, "bob", bobKeys, bobTrust).listAutos(teamId).then(() => null, (e: unknown) => e);
    expect(isCloudError(error, "tampered") && /device list is not the one this device saw before/.test(error.message)).toBe(true);
    database.seed(record2Path, record2);
    const first = (await alice.listRevisions(teamId, autoId))[0]!.id;
    expect((await fresh(database, "bob", bobKeys, bobTrust).openRevision(teamId, autoId, first))?.content).toBe('{"secret":"far-side 7-ball"}');
  }, 120_000);
});

describe("a roster whose maker deleted their account", () => {
  it("still checks on a device that walks through it, since the roster holds the keys its checks need", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId } = await library(database);
    const bobKeys = new MemoryDeviceKeyStore();
    const bobTrust = new MemoryTrustStore();
    await join(database, alice, teamId, "bob", bobKeys, bobTrust);
    const dan = await join(database, alice, teamId, "dan");
    // Making Dan an admin rotates to key 2, which puts his device in the roster; he then makes key 3.
    await (await alice.setRole(teamId, "dan", "admin")).sent;
    await (await dan.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(3);
    await (await alice.setRole(teamId, "dan", "editor")).sent;
    const r = await publish(alice, teamId, autoId, '{"secret":"after Dan"}');
    // Dan deletes his account, which deletes his device records. Bob's device pinned key 1.
    await dan.deleteAccount();
    expect(database.paths().some((path) => path.startsWith("users/dan/devices/"))).toBe(false);
    expect((await fresh(database, "bob", bobKeys, bobTrust).openRevision(teamId, autoId, r))?.content).toBe('{"secret":"after Dan"}');
  }, 120_000);
});

describe("two devices of one member that approved each other at different times", () => {
  it("both keep the key at the next rotation, made from the device approved second, which a teammate's device accepts", async () => {
    const database = new MemoryDatabase();
    const phoneKeys = new MemoryDeviceKeyStore();
    const { alice: phone, teamId, autoId } = await library(database, phoneKeys);
    const bobKeys = new MemoryDeviceKeyStore();
    const bobTrust = new MemoryTrustStore();
    const bob = await join(database, phone, teamId, "bob", bobKeys, bobTrust);
    expect((await bob.listAutos(teamId)).length).toBe(1);
    const leaver = await join(database, phone, teamId, "leaver");
    expect(leaver).toBeDefined();

    // Alice's phone (in roster 1) approves her laptop.
    const laptop = await newDevice(database, "alice");
    await approveDevice(laptop, phone, teamId);
    expect((await laptop.listAutos(teamId)).length).toBe(1);
    // The phone's browser storage is cleared: it keeps its keys but forgets the team, so the laptop
    // approves it again. Now each grant names the other as its approver.
    const phoneAgain = await person(database, "alice", phoneKeys, new MemoryTrustStore());
    expect((await phoneAgain.teamKeyStatus(teamId)).state).toBe("waiting");
    await approveDevice(phoneAgain, laptop, teamId);
    expect((await phoneAgain.listAutos(teamId)).length).toBe(1);
    const phoneId = (await phoneAgain.thisDevice()).deviceId;
    const laptopId = (await laptop.thisDevice()).deviceId;
    expect((database.peek(`teams/${teamId}/keyGrants/${phoneId}`) as { approverDeviceId: string }).approverDeviceId).toBe(laptopId);
    expect((database.peek(`teams/${teamId}/keyGrants/${laptopId}`) as { approverDeviceId: string }).approverDeviceId).toBe(phoneId);

    // The laptop removes a member: it is not in roster 1, so roster 2 carries its grant from the phone.
    await (await laptop.removeMember(teamId, "leaver")).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    for (const deviceId of [phoneId, laptopId]) expect((database.peek(`teams/${teamId}/keyGrants/${deviceId}`) as { kv: number }).kv).toBe(2);
    const roster2 = (await keysOf(laptop).openTeam(teamId)).roster;
    expect(roster2.rotator).toBe(laptopId);
    expect(roster2.via.map((link) => [link.kind, link.deviceId])).toEqual([["grant", laptopId]]);
    const r2 = await publish(laptop, teamId, autoId, '{"secret":"from the laptop"}');
    // Bob's device walks from roster 1 to roster 2 and accepts it, and the phone reads it too.
    expect((await fresh(database, "bob", bobKeys, bobTrust).openRevision(teamId, autoId, r2))?.content).toBe('{"secret":"from the laptop"}');
    expect((await phoneAgain.openRevision(teamId, autoId, r2))?.content).toBe('{"secret":"from the laptop"}');
  }, 120_000);
});

describe("grants approved by an admin who is then removed", () => {
  it("are dropped at the removal, and the device is approved again by someone who stays", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId } = await library(database);
    const dan = await join(database, alice, teamId, "dan");
    const bobKeys = new MemoryDeviceKeyStore();
    const bob = await join(database, alice, teamId, "bob", bobKeys);
    // Making Dan an admin rotates the key, so the new roster records it.
    await (await alice.setRole(teamId, "dan", "admin")).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    const roster2 = (await keysOf(alice).openTeam(teamId)).roster;
    expect(roster2.members.find((member) => member.uid === "dan")?.role).toBe("admin");

    // Dan approves Bob's new tablet, and Alice's own new laptop.
    const tablet = await newDevice(database, "bob");
    await approveDevice(tablet, dan, teamId);
    expect((await tablet.listAutos(teamId)).length).toBe(1);
    const tabletId = (await tablet.thisDevice()).deviceId;
    const aliceLaptop = await newDevice(database, "alice");
    await approveDevice(aliceLaptop, dan, teamId);
    const laptopId = (await aliceLaptop.thisDevice()).deviceId;

    // Alice removes Dan: both grants he made are dropped, since he is not a device that stays.
    const rotation = await keysOf(alice).rotationWrites(teamId, { uids: ["dan"] });
    expect(rotation.dropped.sort()).toEqual([(await dan.thisDevice()).deviceId, laptopId, tabletId].sort());
    await (await alice.removeMember(teamId, "dan")).sent;
    expect(keyVersion(database, teamId)).toBe(3);
    expect(database.peek(`teams/${teamId}/keyGrants/${tabletId}`)).toBe(null);
    expect(await code(tablet.listAutos(teamId))).toBe("no-key");

    // Bob's first device approves the tablet again, and it reads what was written after.
    const r3 = await publish(alice, teamId, autoId, '{"secret":"after Dan left"}');
    await approveDevice(tablet, bob, teamId);
    expect((await tablet.openRevision(teamId, autoId, r3))?.content).toBe('{"secret":"after Dan left"}');
  }, 120_000);
});

describe("a device that used the recovery code", () => {
  it("keeps the key until the next rotation by someone else, then needs approving again", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId, recoveryCode } = await library(database);
    await join(database, alice, teamId, "carol");
    const carolLaptop = await newDevice(database, "carol");
    await (await carolLaptop.useRecoveryCode(teamId, recoveryCode)).sent;
    expect((await carolLaptop.listAutos(teamId)).length).toBe(1);
    const laptopId = (await carolLaptop.thisDevice()).deviceId;
    expect((database.peek(`teams/${teamId}/keyGrants/${laptopId}`) as { recoverySig?: Uint8Array }).recoverySig?.length).toBe(64);

    await (await alice.completeKeyRotation(teamId)).sent;
    expect(database.peek(`teams/${teamId}/keyGrants/${laptopId}`)).toBe(null);
    expect(await code(carolLaptop.listAutos(teamId))).toBe("no-key");
    // Using the code again works; so would a teammate's approval.
    await (await carolLaptop.useRecoveryCode(teamId, recoveryCode)).sent;
    const r2 = await publish(alice, teamId, autoId, '{"secret":"after the code"}');
    expect((await carolLaptop.openRevision(teamId, autoId, r2))?.content).toBe('{"secret":"after the code"}');
  }, 120_000);

  it("makes the next key itself when it is an owner's or admin's, and a teammate's device accepts the roster it signs", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId, recoveryCode } = await library(database);
    const bobKeys = new MemoryDeviceKeyStore();
    const bobTrust = new MemoryTrustStore();
    const bob = await join(database, alice, teamId, "bob", bobKeys, bobTrust);
    expect((await bob.listAutos(teamId)).length).toBe(1);
    await join(database, alice, teamId, "leaver");
    // Alice lost her phone and uses the recovery code on a new laptop, which makes the next key in
    // the same write, then removes a member from it.
    const laptop = await newDevice(database, "alice");
    await (await laptop.useRecoveryCode(teamId, recoveryCode)).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    const laptopId = (await laptop.thisDevice()).deviceId;
    const roster2 = (await keysOf(laptop).openTeam(teamId)).roster;
    expect(roster2.rotator).toBe(laptopId);
    // With only the code's authority, the roster also carries the grants of the devices it adds
    // since roster 1 (Bob's and the leaver's, approved by Alice's lost phone).
    expect(roster2.via.map((link) => link.kind)).toEqual(["recovery", "grant", "grant"]);
    expect((database.peek(`teams/${teamId}/keyGrants/${laptopId}`) as DocData).recoverySig).toBeUndefined();
    await (await laptop.removeMember(teamId, "leaver")).sent;
    expect(keyVersion(database, teamId)).toBe(3);
    const r3 = await publish(laptop, teamId, autoId, '{"secret":"from the recovered laptop"}');
    expect((await fresh(database, "bob", bobKeys, bobTrust).openRevision(teamId, autoId, r3))?.content).toBe('{"secret":"from the recovered laptop"}');
  }, 120_000);

  it("rotates in the same write while a rotation is pending, with the recovery key's endorsement in the roster", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, recoveryCode } = await library(database);
    const carol = await join(database, alice, teamId, "carol");
    await (await carol.leaveTeam(teamId)).sent;
    expect((database.peek(`teams/${teamId}`) as { rotationPending?: boolean }).rotationPending).toBe(true);
    const laptop = await newDevice(database, "alice");
    await (await laptop.useRecoveryCode(teamId, recoveryCode)).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    expect((await keysOf(laptop).openTeam(teamId)).roster.via.map((link) => link.kind)).toEqual(["recovery"]);
    expect((await alice.listAutos(teamId)).length).toBe(1);
  }, 120_000);
});

describe("an admin whose device no owner or admin approved", () => {
  it("cannot make the next key: a removal from it waits for a rotation, which an owner then makes, and it keeps the key only once an owner or admin approves it", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId } = await library(database);
    const eve = await join(database, alice, teamId, "eve");
    const dan = await join(database, alice, teamId, "dan");
    await (await alice.setRole(teamId, "dan", "admin")).sent;
    await join(database, alice, teamId, "leaver");
    // With members allowed to approve devices, Eve (an editor) approves Dan's new tablet.
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
    const tablet = await newDevice(database, "dan");
    await approveDevice(tablet, eve, teamId);
    expect((await tablet.listAutos(teamId)).length).toBe(1);
    const tabletId = (await keysOf(tablet).device()).deviceId;

    // The tablet cannot rotate: the roster names neither it nor an owner's or admin's approval of it.
    await expect(keysOf(tablet).rotationWrites(teamId)).rejects.toBeInstanceOf(CannotRotateError);
    expect(await code(tablet.completeKeyRotation(teamId))).toBe("permission-denied");
    const before = keyVersion(database, teamId);
    await (await tablet.removeMember(teamId, "leaver")).sent;
    expect(keyVersion(database, teamId)).toBe(before);
    expect((database.peek(`teams/${teamId}`) as { rotationPending?: boolean }).rotationPending).toBe(true);
    expect(database.peek(`teams/${teamId}/members/leaver`)).toBe(null);

    // Alice rotates. The setting lets members approve devices of members who are not owners or
    // admins only, so the tablet, an admin's, is dropped until an owner or admin approves it.
    await (await alice.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(before + 1);
    expect((await rosterOf(alice, teamId)).devices.some((device) => device.uid === "dan" && device.deviceId === tabletId)).toBe(false);
    expect(await code(tablet.listAutos(teamId))).toBe("no-key");
    await approveDevice(tablet, alice, teamId);
    const r = await publish(alice, teamId, autoId, '{"secret":"after the rotation"}');
    expect((await tablet.openRevision(teamId, autoId, r))?.content).toBe('{"secret":"after the rotation"}');
    // Approved by an owner, the tablet can make the next key, and is in the roster as an admin's device.
    await (await tablet.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(before + 2);
    expect(dan).toBeDefined();
  }, 120_000);
});

// ---------------------------------------------------------------------------- authority from signed state only

/**
 * A device the server writes under `uid`'s name, with a grant of the newest key that `approver`'s own
 * device signs and proves: what a member who holds the key, working with the server, can plant.
 */
async function plantUnder(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, approverUid: string): Promise<DeviceKeys> {
  const opened = await keysOf(approver).openTeam(teamId, { extractable: true });
  const planted = await generateDeviceKeys();
  database.seed(`users/${uid}/devices/${planted.deviceId}`, { ...deviceRecord(planted), createdAt: SERVER_TIME });
  const grant = await makeKeyGrant({ teamId, teamKey: opened.newest.key, recipient: { deviceId: planted.deviceId, uid, record: deviceRecord(planted) }, approver: opened.device });
  const proof = await makeGrantProof({ teamId, deviceId: planted.deviceId, uid, fingerprint: planted.fingerprint, teamKey: opened.newest.key });
  database.seed(`teams/${teamId}/keyGrants/${planted.deviceId}`, { ...grant, uid, proof, approverUid, createdAt: SERVER_TIME, updatedAt: SERVER_TIME } as unknown as DocData);
  return planted;
}

/** The newest roster, as `member`'s device opens and checks it. */
async function rosterOf(member: MemoryBackend, teamId: string): Promise<Roster> {
  return (await keysOf(member).openTeam(teamId)).roster;
}

/** Runs `work` while the server shows `path` as `lie`, then puts back what it held (an empty document for none). */
async function whileServerSays<T>(database: MemoryDatabase, path: string, lie: (real: DocData | null) => DocData, work: () => Promise<T>): Promise<T> {
  const real = database.peek(path);
  database.seed(path, lie(real));
  try {
    return await work();
  } finally {
    database.seed(path, real ?? {});
  }
}

const settingsPath = (teamId: string) => `teams/${teamId}/settings/sharing`;
const memberPath = (teamId: string, uid: string) => `teams/${teamId}/members/${uid}`;

describe("an approver's authority comes from the previous roster alone", () => {
  for (const lie of ["members may approve devices", "Mallory is an admin"] as const) {
    it(`so a device Mallory planted is not kept when the server says ${lie} during an honest rotation`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId, autoId } = await library(database);
      const mallory = await join(database, alice, teamId, "mallory");
      const eve = await join(database, alice, teamId, "eve");
      const planted = await plantUnder(database, mallory, teamId, "eve", "mallory");
      const path = lie === "members may approve devices" ? settingsPath(teamId) : memberPath(teamId, "mallory");
      await whileServerSays(
        database,
        path,
        (real) => (lie === "members may approve devices" ? { ...(real ?? {}), membersMayApproveDevices: true } : { ...real!, role: "admin" }),
        async () => (await alice.completeKeyRotation(teamId)).sent,
      );
      expect(keyVersion(database, teamId)).toBe(2);
      expect((await rosterOf(alice, teamId)).devices.some((device) => device.deviceId === planted.deviceId)).toBe(false);

      await (await alice.removeMember(teamId, "mallory")).sent;
      expect(keyVersion(database, teamId)).toBe(3);
      const r3 = await publish(alice, teamId, autoId, '{"secret":"after removal"}');
      const stolen = await keyFromGrant(database, teamId, planted).catch(() => null);
      expect(stolen === null ? null : await readWith(database, teamId, autoId, r3, stolen)).toBe(null);
      expect((await eve.openRevision(teamId, autoId, r3))?.content).toBe('{"secret":"after removal"}');
    }, 60_000);
  }

  for (const lie of ["Eve is an admin now", "members may approve devices"] as const) {
    it(`so a device Eve, an editor in the roster, planted under Bob is not kept when the server says ${lie}`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId } = await library(database);
      await join(database, alice, teamId, "bob");
      const eve = await join(database, alice, teamId, "eve");
      await (await alice.completeKeyRotation(teamId)).sent;
      await eve.listAutos(teamId);
      expect((await rosterOf(alice, teamId)).members).toContainEqual({ uid: "eve", role: "editor" });
      const planted = await plantUnder(database, eve, teamId, "bob", "eve");
      const path = lie === "Eve is an admin now" ? memberPath(teamId, "eve") : settingsPath(teamId);
      await whileServerSays(
        database,
        path,
        (real) => (lie === "Eve is an admin now" ? { ...real!, role: "admin" } : { ...(real ?? {}), membersMayApproveDevices: true }),
        async () => (await alice.completeKeyRotation(teamId)).sent,
      );
      await (await alice.removeMember(teamId, "eve")).sent;
      expect((await rosterOf(alice, teamId)).devices.some((device) => device.deviceId === planted.deviceId)).toBe(false);
      expect(database.peek(`teams/${teamId}/keyGrants/${planted.deviceId}`)).toBe(null);
    }, 60_000);
  }
});

describe("a device a member approves under the setting for an owner's or admin's name", () => {
  for (const owner of ["alice", "dan"] as const) {
    it(`is not kept at the next rotation when it is ${owner === "alice" ? "the owner's" : "an admin's"}, so it never gets the authority to make a key`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId } = await library(database);
      const eve = await join(database, alice, teamId, "eve");
      await join(database, alice, teamId, "bob");
      await join(database, alice, teamId, "dan");
      await (await alice.setRole(teamId, "dan", "admin")).sent;
      await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
      await eve.listAutos(teamId);
      const roster = await rosterOf(alice, teamId);
      expect(roster.membersMayApprove).toBe(true);
      expect(roster.members).toContainEqual({ uid: "eve", role: "editor" });
      expect(roster.members).toContainEqual({ uid: "bob", role: "editor" });
      // Eve, an editor in the roster, working with the server, approves a device it made under the owner's or admin's name.
      const planted = await plantUnder(database, eve, teamId, owner, "eve");
      await (await alice.completeKeyRotation(teamId)).sent;
      const next = await rosterOf(alice, teamId);
      expect(next.devices.some((device) => device.deviceId === planted.deviceId)).toBe(false);
      expect(database.peek(`teams/${teamId}/keyGrants/${planted.deviceId}`)).toBe(null);
      // The same approval for an editor's device is still kept, as the setting allows.
      const forBob = await plantUnder(database, eve, teamId, "bob", "eve");
      await (await alice.completeKeyRotation(teamId)).sent;
      expect((await rosterOf(alice, teamId)).devices.some((device) => device.deviceId === forBob.deviceId)).toBe(true);
    }, 60_000);
  }
});

describe("roles and the sharing setting in the next roster come from the one before", () => {
  it("so the server cannot make Eve an admin in the roster during an honest rotation, and her device cannot then make the next key", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    const bobKeys = new MemoryDeviceKeyStore();
    const bobTrust = new MemoryTrustStore();
    await join(database, alice, teamId, "bob", bobKeys, bobTrust);
    const eve = await join(database, alice, teamId, "eve");
    await whileServerSays(database, memberPath(teamId, "eve"), (real) => ({ ...real!, role: "admin" }), async () => (await alice.completeKeyRotation(teamId)).sent);
    const roster2 = await rosterOf(alice, teamId);
    expect(roster2.members).toContainEqual({ uid: "eve", role: "editor" });
    // With the server still saying she is an admin, Eve's own app cannot make roster 3.
    await eve.listAutos(teamId);
    const outcome = await whileServerSays(database, memberPath(teamId, "eve"), (real) => ({ ...real!, role: "admin" }), () => code(eve.completeKeyRotation(teamId).then((queued) => queued.sent)));
    expect(outcome).toBe("permission-denied");
    expect(keyVersion(database, teamId)).toBe(2);
    expect((await fresh(database, "bob", bobKeys, bobTrust).listAutos(teamId)).length).toBe(1);
  }, 60_000);

  it("so a role lie at one honest rotation gives Eve no say at the next, and a device she plants later is dropped with her", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await join(database, alice, teamId, "bob");
    const eve = await join(database, alice, teamId, "eve");
    await whileServerSays(database, memberPath(teamId, "eve"), (real) => ({ ...real!, role: "admin" }), async () => (await alice.completeKeyRotation(teamId)).sent);
    await eve.listAutos(teamId);
    const planted = await plantUnder(database, eve, teamId, "bob", "eve");
    await (await alice.completeKeyRotation(teamId)).sent;
    await (await alice.removeMember(teamId, "eve")).sent;
    expect((await rosterOf(alice, teamId)).devices.some((device) => device.deviceId === planted.deviceId)).toBe(false);
  }, 60_000);

  it("so a member the server made up is not in the next roster, even as an owner", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await join(database, alice, teamId, "bob");
    database.seed(memberPath(teamId, "zed"), { uid: "zed", teamId, role: "owner", displayName: "Zed", joinedAt: SERVER_TIME } as unknown as DocData);
    await (await alice.completeKeyRotation(teamId)).sent;
    const roster = await rosterOf(alice, teamId);
    expect(roster.members.map((member) => member.uid)).toEqual(["alice", "bob"]);
  }, 60_000);

  it("so a removed member the server puts back does not count as staying", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await join(database, alice, teamId, "bob");
    await join(database, alice, teamId, "mallory");
    const real = database.peek(memberPath(teamId, "mallory")) as DocData;
    await (await alice.removeMember(teamId, "mallory")).sent;
    database.seed(memberPath(teamId, "mallory"), { ...real, role: "owner" });
    await (await alice.completeKeyRotation(teamId)).sent;
    expect((await rosterOf(alice, teamId)).members.some((member) => member.uid === "mallory")).toBe(false);
  }, 60_000);

  it("so the server can lower a role or turn the setting off, and only an owner's or admin's own change raises them", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    const eve = await join(database, alice, teamId, "eve");
    // Alice's own changes, which rotate in the same write, are recorded.
    await (await alice.setRole(teamId, "eve", "admin")).sent;
    expect((await rosterOf(alice, teamId)).members).toContainEqual({ uid: "eve", role: "admin" });
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
    expect((await rosterOf(alice, teamId)).membersMayApprove).toBe(true);
    await eve.listAutos(teamId);
    await (await eve.completeKeyRotation(teamId)).sent;
    // The server's word only lowers them.
    await whileServerSays(database, memberPath(teamId, "eve"), (real) => ({ ...real!, role: "viewer" }), async () =>
      whileServerSays(database, settingsPath(teamId), (real) => ({ ...(real ?? {}), membersMayApproveDevices: false }), async () => (await alice.completeKeyRotation(teamId)).sent),
    );
    const lowered = await rosterOf(alice, teamId);
    expect(lowered.members).toContainEqual({ uid: "eve", role: "viewer" });
    expect(lowered.membersMayApprove).toBe(false);
    // Once lowered, the server putting the old values back does not raise them again.
    await (await alice.completeKeyRotation(teamId)).sent;
    const after = await rosterOf(alice, teamId);
    expect(after.members).toContainEqual({ uid: "eve", role: "viewer" });
    expect(after.membersMayApprove).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------- the recovery code's own start

describe("a device with no pin that uses the recovery code", () => {
  it("refuses a key chain and rosters the server made up around the real recovery record's public keys", async () => {
    const database = new MemoryDatabase();
    const { teamId, recoveryCode } = await library(database);
    const real = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord & DocData;
    // The server, with no team key and no member's device, makes a history of its own.
    const f1 = await createTeamKeys(teamId);
    const f2 = await rotateTeamKeys(teamId, f1);
    const evil = await generateDeviceKeys();
    const dev = { deviceId: evil.deviceId, uid: "mallory", encSpki: evil.encSpki, signSpki: evil.signSpki, fingerprint: evil.fingerprint };
    const base = {
      v: 1 as const, teamId, rotator: evil.deviceId, members: [{ uid: "alice", role: "owner" as const }, { uid: "mallory", role: "owner" as const }],
      membersMayApprove: false, devices: [dev], recovery: await recoveryFingerprint(real), via: [], recoveryAnchor: null,
    };
    const sealed = async (made: NewTeamKeys, kv: number) => {
      const out = await sealRoster({ teamId, key: made.key, pairSpki: made.record.pairSpki, signSpki: made.record.signSpki, roster: { ...base, kv, nonce: rosterNonce(cryptoRandomBytes) }, signer: evil.signing.privateKey, random: cryptoRandomBytes });
      return { roster: out.roster as unknown as DocData, rosterSig: out.rosterSig };
    };
    database.seed(`teams/${teamId}/teamKeys/1`, { ...f1.record, ...(await sealed(f1, 1)) } as unknown as DocData);
    database.seed(`teams/${teamId}/teamKeys/2`, { ...f2.record, ...(await sealed(f2, 2)) } as unknown as DocData);
    database.seed(`teams/${teamId}`, { ...(database.peek(`teams/${teamId}`) as DocData), encKey: f2.encKey } as unknown as DocData);
    const raw = await exportAesKey(f2.key.key);
    const wrap = await wrapToPublicKey(real.spki, raw, aadFor.recovery({ teamId, kv: 2 }), cryptoRandomBytes);
    const check = await sealBytes(f2.key, await sha256(real.spki), aadFor.recoveryCheck({ teamId, kv: 2 }), cryptoRandomBytes);
    database.seed(`teams/${teamId}/recovery/current`, { ...real, kv: 2, teamKey: wrap, check } as unknown as DocData);
    // Alice types the real code on a new laptop.
    const laptop = await newDevice(database, "alice");
    expect(await code(laptop.useRecoveryCode(teamId, recoveryCode).then((queued) => queued.sent))).toBe("tampered");
    expect(database.peek(`teams/${teamId}/keyGrants/${(await keysOf(laptop).device()).deviceId}`)).toBe(null);
  }, 120_000);

  it("refuses a roster its code was made with that a removed member who holds its key sealed again with other contents", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, recoveryCode } = await library(database);
    const bob = await join(database, alice, teamId, "bob");
    // What Bob, an editor who never was in a roster, keeps before he is removed: key 1, his grant, and his device's keys.
    const held = await keysOf(bob).openTeam(teamId, { extractable: true });
    const bobDevice = held.device;
    const bobGrant = database.peek(`teams/${teamId}/keyGrants/${bobDevice.deviceId}`)!;
    const recovery1 = database.peek(`teams/${teamId}/recovery/current`)!;
    const bobMember = database.peek(`teams/${teamId}/members/bob`)!;
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(keyVersion(database, teamId)).toBe(2);

    // With the server, Bob seals roster 1 again under key 1, naming himself an owner with his device,
    // and keeps the real recovery anchor in it. The server puts back what version 1 held.
    const record1 = database.peek(`teams/${teamId}/teamKeys/1`) as unknown as TeamKeyDoc & DocData;
    const real1 = await openRoster(teamId, held.newest.key, record1);
    const forged: Roster = {
      ...real1.roster,
      members: [...real1.roster.members, { uid: "bob", role: "owner" }],
      devices: [...real1.roster.devices, { deviceId: bobDevice.deviceId, uid: "bob", encSpki: bobDevice.encSpki, signSpki: bobDevice.signSpki, fingerprint: bobDevice.fingerprint }],
    };
    const resealed = await sealRoster({ teamId, key: held.newest.key, pairSpki: record1.pairSpki, signSpki: record1.signSpki, roster: forged, signer: bobDevice.signing.privateKey, random: cryptoRandomBytes });
    database.seed(`teams/${teamId}/teamKeys/1`, { ...record1, roster: resealed.roster, rosterSig: resealed.rosterSig } as unknown as DocData);
    database.seed(`teams/${teamId}/keyGrants/${bobDevice.deviceId}`, bobGrant);
    database.seed(`teams/${teamId}/recovery/current`, recovery1);
    database.seed(`teams/${teamId}/members/bob`, { ...bobMember, role: "owner" });
    // From the forged roster 1, Bob's device makes a version 2 of his own, which the server serves.
    const opened: OpenedTeam = { ...held, roster: forged, rosterDigest: resealed.digest };
    serverApplies(database, (await keysOf(bob).rotationWrites(teamId, {}, { opened })).writes);
    unseed(database, `teams/${teamId}/members/bob`);

    // Alice types the real code on a new laptop, which has never seen the team.
    const laptop = await newDevice(database, "alice");
    expect(await code(laptop.useRecoveryCode(teamId, recoveryCode).then((queued) => queued.sent))).toBe("tampered");
    expect(database.peek(`teams/${teamId}/keyGrants/${(await keysOf(laptop).device()).deviceId}`)).toBe(null);
    // Had the laptop taken it, it would write under a key Bob holds.
    expect((await keyFromGrant(database, teamId, bobDevice))?.version).toBe(2);
  }, 60_000);

  it("can be shown the team as it was when its code was made, so a member removed since reads what it writes (a known limit)", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId, recoveryCode } = await library(database);
    const bob = await join(database, alice, teamId, "bob");
    const bobDevice = await keysOf(bob).device();
    // The server keeps everything as it was at version 1, the version the code was made at.
    const atVersion1 = new Map(database.paths().map((path) => [path, database.peek(path)!]));
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(keyVersion(database, teamId)).toBe(2);
    // Then it shows that copy to a new laptop, where Alice types the real code.
    database.clear();
    for (const [path, data] of atVersion1) database.seed(path, data);
    const laptop = await newDevice(database, "alice");
    await (await laptop.useRecoveryCode(teamId, recoveryCode)).sent;
    const written = await publish(laptop, teamId, autoId, '{"secret":"written on the laptop"}');
    // In that copy Bob is still a member, so the laptop's own rotation gave his device the key it
    // wrote under. A new code, made after Bob left, moves the anchor on.
    const bobKey = await keyFromGrant(database, teamId, bobDevice);
    expect(bobKey === null ? null : await readWith(database, teamId, autoId, written, bobKey)).toBe('{"secret":"written on the laptop"}');
  }, 60_000);

  it("cannot be shown the team as it was before its code was made, so a new code after a removal leaves the removed member nothing", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await join(database, alice, teamId, "bob");
    const atVersion1 = new Map(database.paths().map((path) => [path, database.peek(path)!]));
    await (await alice.removeMember(teamId, "bob")).sent;
    const replaced = await alice.replaceRecoveryCode(teamId);
    await replaced.sent;
    expect(keyVersion(database, teamId)).toBe(3);
    database.clear();
    for (const [path, data] of atVersion1) database.seed(path, data);
    const laptop = await newDevice(database, "alice");
    expect(await code(laptop.useRecoveryCode(teamId, replaced.value.recoveryCode).then((queued) => queued.sent))).toBe("invalid");
  }, 60_000);

  it("starts from the roster its code was made with, after the code is replaced and the key rotates again", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId, autoId, recoveryCode } = await library(database);
    const replaced = await alice.replaceRecoveryCode(teamId);
    await replaced.sent;
    await join(database, alice, teamId, "bob");
    await (await alice.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(3);
    const r = await publish(alice, teamId, autoId, '{"secret":"key 3"}');
    const laptop = await newDevice(database, "alice");
    expect(await code(laptop.useRecoveryCode(teamId, recoveryCode).then((queued) => queued.sent))).toBe("invalid");
    await (await laptop.useRecoveryCode(teamId, replaced.value.recoveryCode)).sent;
    expect((await laptop.openRevision(teamId, autoId, r))?.content).toBe('{"secret":"key 3"}');
  }, 120_000);
});

describe("the recovery code gives the authority to rotate", () => {
  for (const which of ["in the roster as an editor's", "not in the roster"] as const) {
    it(`to a device ${which}`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId, recoveryCode } = await library(database);
      const eve = await join(database, alice, teamId, "eve");
      await (await alice.completeKeyRotation(teamId)).sent;
      const previous = await rosterOf(eve, teamId);
      const own = previous.devices.find((device) => device.uid === "eve")!;
      const other = await generateDeviceKeys();
      const rotator: RosterKeys = which === "not in the roster" ? { deviceId: other.deviceId, uid: "eve", encSpki: other.encSpki, signSpki: other.signSpki, fingerprint: other.fingerprint } : own;
      const record = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
      const signer = await openRecoverySigner({ teamId, record, code: await recoveryCodeFromText(recoveryCode) });
      const signature = await endorseRecoveredDevice(signer, { teamId, kv: previous.kv, deviceId: rotator.deviceId, uid: "eve", fingerprint: rotator.fingerprint });
      const link = { kind: "recovery" as const, ...rotator, kv: previous.kv, recoverySpki: record.spki, recoverySignSpki: record.signSpki, signature };
      expect(await mayRotate({ teamId, previous, rotator, via: [] })).toBe(false);
      expect(await mayRotate({ teamId, previous, rotator, via: [link] })).toBe(true);
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------- pins, removals, size

describe("a team pin with no roster digest", () => {
  it("counts as no pin, so the device needs approving again", async () => {
    const database = new MemoryDatabase();
    const aliceKeys = new MemoryDeviceKeyStore();
    const aliceTrust = new MemoryTrustStore();
    const { teamId } = await library(database, aliceKeys, aliceTrust);
    const key = `zenith.pin.team.alice.${teamId}`;
    const pin = JSON.parse(aliceTrust.get(key)!) as Record<string, unknown>;
    delete pin.rh;
    aliceTrust.set(key, JSON.stringify(pin));
    expect(await code(fresh(database, "alice", aliceKeys, aliceTrust).listAutos(teamId))).toBe("no-key");
  }, 120_000);
});

describe("removing an owner or admin of the newest roster", () => {
  it("is refused from a device that cannot make the next key, since they could still make one", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    const eve = await join(database, alice, teamId, "eve");
    await join(database, alice, teamId, "dan");
    await join(database, alice, teamId, "carol");
    await (await alice.setRole(teamId, "dan", "admin")).sent;
    await (await alice.setRole(teamId, "carol", "admin")).sent;
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
    await eve.listAutos(teamId);
    // Dan's tablet, approved by Eve (an editor), cannot rotate.
    const tablet = await newDevice(database, "dan");
    await approveDevice(tablet, eve, teamId);
    await expect(keysOf(tablet).rotationWrites(teamId)).rejects.toBeInstanceOf(CannotRotateError);
    const error = await tablet.removeMember(teamId, "carol").then(() => null, (e: unknown) => e);
    expect(isCloudError(error, "permission-denied") && error.message).toBe(CANNOT_REMOVE_ADMIN);
    expect(database.peek(`teams/${teamId}/members/carol`)).not.toBe(null);
    // From Alice's device, which rotates in the same write, it goes through.
    await (await alice.removeMember(teamId, "carol")).sent;
    expect(database.peek(`teams/${teamId}/members/carol`)).toBe(null);
  }, 60_000);
});

describe("the sealed roster's size", () => {
  it("is padded to fixed buckets, so its ciphertext tells only roughly how big the team is", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await join(database, alice, teamId, "bob");
    await (await alice.completeKeyRotation(teamId)).sent;
    for (const kv of [1, 2]) expect((database.peek(`teams/${teamId}/teamKeys/${String(kv)}`) as { roster: Envelope }).roster.ct.byteLength).toBe(4096);
    expect(paddedRosterLength(1)).toBe(4080);
    expect(paddedRosterLength(4081)).toBe(8176);
    expect(paddedRosterLength(MAX_ROSTER_BYTES - 16)).toBe(MAX_ROSTER_BYTES - 16);
    expect(paddedRosterLength(MAX_ROSTER_BYTES - 15)).toBe(null);
  }, 120_000);
});

describe("a member who registers device after device", () => {
  it(`keeps at most ${String(MAX_DEVICES_PER_MEMBER)} at a rotation, her roster devices first, so the roster stays small enough to rotate`, async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    const eve = await join(database, alice, teamId, "eve");
    await (await alice.completeKeyRotation(teamId)).sent;
    await eve.listAutos(teamId);
    const first = (await keysOf(eve).device()).deviceId;
    for (let i = 0; i < MAX_DEVICES_PER_MEMBER + 2; i += 1) await plantUnder(database, eve, teamId, "eve", "eve");
    await (await alice.completeKeyRotation(teamId)).sent;
    const hers = (await rosterOf(alice, teamId)).devices.filter((device) => device.uid === "eve");
    expect(hers.length).toBe(MAX_DEVICES_PER_MEMBER);
    expect(hers.some((device) => device.deviceId === first)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------- the first review's probe, ported

describe("a device planted under a teammate's name before the roster (the first review's probe)", () => {
  for (const mode of ["approved by itself", "approved by a made-up device", "approved by Mallory's own device"] as const) {
    it(`gets no key after Mallory is removed, ${mode}`, async () => {
      const database = new MemoryDatabase();
      const { alice, teamId, autoId } = await library(database);
      const mallory = await join(database, alice, teamId, "mallory");
      await join(database, alice, teamId, "eve");
      const opened = await keysOf(mallory).openTeam(teamId, { extractable: true });
      const planted = await generateDeviceKeys();
      const ghost = await generateDeviceKeys();
      database.seed(`users/eve/devices/${planted.deviceId}`, { ...deviceRecord(planted), createdAt: SERVER_TIME });
      let approver: DeviceKeys = planted;
      if (mode === "approved by Mallory's own device") approver = opened.device;
      if (mode === "approved by a made-up device") {
        approver = ghost;
        database.seed(`users/eve/devices/${ghost.deviceId}`, { ...deviceRecord(ghost), createdAt: SERVER_TIME });
      }
      const teamKey = opened.newest.key;
      const grant = await makeKeyGrant({ teamId, teamKey, recipient: { deviceId: planted.deviceId, uid: "eve", record: deviceRecord(planted) }, approver });
      const proof = await makeGrantProof({ teamId, deviceId: planted.deviceId, uid: "eve", fingerprint: planted.fingerprint, teamKey });
      database.seed(`teams/${teamId}/keyGrants/${planted.deviceId}`, { ...grant, uid: "eve", proof, approverUid: "eve", createdAt: SERVER_TIME, updatedAt: SERVER_TIME } as unknown as DocData);
      await (await alice.removeMember(teamId, "mallory")).sent;
      expect(keyVersion(database, teamId)).toBe(2);
      expect(database.peek(`teams/${teamId}/keyGrants/${planted.deviceId}`)).toBe(null);
      const r2 = await publish(alice, teamId, autoId, '{"secret":"after removal"}');
      const stolen = await keyFromGrant(database, teamId, planted).catch(() => null);
      expect(stolen === null ? null : await readWith(database, teamId, autoId, r2, stolen)).toBe(null);
    }, 120_000);
  }
});
