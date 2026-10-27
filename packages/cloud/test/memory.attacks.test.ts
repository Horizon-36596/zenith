/**
 * Attacks by a server that writes whatever it likes, each one reproduced through `database.seed` and
 * `database.peek` and kept here so it stays fixed. Every case failed before its fix: the server read a
 * team's paths, or got a key it must never hold. Horizon runs the server, and must never be able to
 * read a team's paths, so each case plays Horizon as the attacker.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  approvalKey,
  checkDeviceRecord,
  createRecovery,
  createTeamKeys,
  deviceFingerprint,
  deviceIdFor,
  deviceRecord,
  generateDeviceKeys,
  makeApprovalMac,
  makeGrantProof,
  makeKeyGrant,
  MemoryDeviceKeyStore,
  newApprovalSecret,
  newRecoveryCode,
  openKeyGrant,
  openRecovery,
  openText,
  recoveryCodeFromText,
  rotateTeamKeys,
  sealText,
  unwrapShareKeyAsTeam,
  type DeviceKeys,
  type Envelope,
  type KeyGrant,
  type NewTeamKeys,
  type RecoveryRecord,
  type TeamKey,
} from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { cryptoRandomBytes } from "../src/ids.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { rosterNonce, sealRoster } from "../src/keys/roster.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { SERVER_TIME, type DocData } from "../src/store.js";

/**
 * Few iterations for approval codes' keys. These tests derive 21 of them, and at the app's 600,000
 * each takes about a quarter of a second, which pushed the slowest past 5 s on a busy Windows
 * machine. The count does not change what an approval checks; `crypto.vectors.test.ts` checks the
 * real one.
 */
const FAST_APPROVAL_KDF = 10;

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

/** The device id and approval code a waiting device shows for `teamId`. */
async function codeOf(device: MemoryBackend, teamId: string): Promise<{ deviceId: string; approvalCode: string }> {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}

/** Alice's team, with one auto and a secret path in its first revision. */
async function library(database: MemoryDatabase, aliceKeys = new MemoryDeviceKeyStore()) {
  const alice = await person(database, "alice", aliceKeys);
  const team = await alice.createTeam({ number: 36596, name: "Horizon" });
  await team.sent;
  const teamId = team.value.id;
  const auto = await alice.createAuto(teamId, { title: "Close side" });
  await auto.sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"far-side 7-ball"}' });
  await r1.sent;
  return { alice, teamId, autoId: auto.value.id, r1: r1.value.id, recoveryCode: team.value.recoveryCode };
}

/** A member who joins through an invite that approves at once, and gets the key from `owner`. */
async function join(database: MemoryDatabase, owner: MemoryBackend, teamId: string, uid: string, deviceKeys = new MemoryDeviceKeyStore()) {
  const member = await person(database, uid, deviceKeys);
  const invite = await owner.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const { deviceId, approvalCode } = await codeOf(member, teamId);
  await (await owner.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
  return member;
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

/**
 * A device roster for a team key the attacker made, signed by the attacker's device and naming it as
 * the only device: what a server, or a member holding an old key, can make for a key of its own.
 */
async function forgedRoster(teamId: string, made: NewTeamKeys, signer: DeviceKeys, uid: string): Promise<DocData> {
  const roster = {
    v: 1 as const,
    teamId,
    kv: made.key.version,
    rotator: signer.deviceId,
    nonce: rosterNonce(cryptoRandomBytes),
    members: [{ uid, role: "owner" as const }],
    devices: [{ deviceId: signer.deviceId, uid, encSpki: signer.encSpki, signSpki: signer.signSpki, fingerprint: signer.fingerprint }],
    recovery: new Uint8Array(32),
    via: [],
  };
  const sealed = await sealRoster({ teamId, key: made.key, pairSpki: made.record.pairSpki, signSpki: made.record.signSpki, roster, signer: signer.signing.privateKey, random: cryptoRandomBytes });
  return { roster: sealed.roster as unknown as DocData, rosterSig: sealed.rosterSig, digest: sealed.digest };
}

/** A revision's content, opened with `key`, or null when `key` does not open it. */
async function readWith(database: MemoryDatabase, teamId: string, autoId: string, revisionId: string, key: TeamKey): Promise<string | null> {
  const doc = database.peek(`teams/${teamId}/autos/${autoId}/revisions/${revisionId}`) as { content: Envelope } | null;
  if (doc === null || doc.content.kv !== key.version) return null;
  return openText(key, doc.content, aadFor.revision({ teamId, autoId, revisionId, field: "content", kv: doc.content.kv })).catch(() => null);
}

describe("a server that slips a device of its own into an approval", () => {
  it("gets no grant: Approve grants the one device whose code was typed, and a code shown for another device is refused", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    const nina = await person(database, "nina");
    const invite = await alice.createInvite(teamId, { role: "editor" });
    await invite.sent;
    await (await nina.redeemInvite(invite.value.code)).sent;
    const ninaCode = await codeOf(nina, teamId);

    // The server adds a device of its own under Nina's name, with a key request beside hers.
    const evil = await generateDeviceKeys();
    database.seed(`users/nina/devices/${evil.deviceId}`, { ...deviceRecord(evil), createdAt: SERVER_TIME });
    database.seed(`teams/${teamId}/keyRequests/${evil.deviceId}`, { uid: "nina", deviceId: evil.deviceId, createdAt: SERVER_TIME });

    // Nina's code does not match the server's device, so naming it with her code is refused.
    expect(await code(alice.approveMember(teamId, "nina", { deviceId: evil.deviceId, approvalCode: ninaCode.approvalCode }))).toBe("wrong-code");
    await (await alice.approveMember(teamId, "nina", ninaCode)).sent;
    expect(database.peek(`teams/${teamId}/keyGrants/${evil.deviceId}`)).toBe(null);
    expect(await keyFromGrant(database, teamId, evil)).toBe(null);
    expect((await nina.openRevision(teamId, autoId, r1))?.content).toBe('{"secret":"far-side 7-ball"}');
    // Its request is still waiting, and a grant to it needs a code the server cannot show on Nina's screen.
    expect(await code(alice.grantDeviceKey(teamId, evil.deviceId, ninaCode.approvalCode))).toBe("wrong-code");
  });
});

describe("a server that makes device records in bulk to match a waiting device's code", () => {
  it("is refused: a record whose keys are not P-256 public keys is never listed or granted", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId } = await library(database);
    const nina = await person(database, "nina");
    const invite = await alice.createInvite(teamId, { role: "editor" });
    await invite.sent;
    await (await nina.redeemInvite(invite.value.code)).sent;
    const ninaCode = await codeOf(nina, teamId);

    // Its own encryption key, so it could open a grant, and 91 random bytes as the signing key: a
    // new try costs two hashes, not a key pair. The record's fingerprint and id match its bytes.
    const evil = await generateDeviceKeys();
    const junk = crypto.getRandomValues(new Uint8Array(91));
    const fingerprint = await deviceFingerprint(evil.encSpki, junk);
    const deviceId = deviceIdFor(fingerprint);
    database.seed(`users/nina/devices/${deviceId}`, { v: 1, encSpki: evil.encSpki, signSpki: junk, fingerprint, createdAt: SERVER_TIME });
    database.seed(`teams/${teamId}/keyRequests/${deviceId}`, { uid: "nina", deviceId, createdAt: SERVER_TIME });

    // Owners and admins see the request, marked as matching no device, so they can delete it; it is never offered for approval.
    expect((await alice.listKeyRequests(teamId)).filter((request) => request.deviceId === deviceId)).toMatchObject([{ matchesDevice: false, code: "" }]);
    expect(await code(alice.approveMember(teamId, "nina", { deviceId, approvalCode: ninaCode.approvalCode }))).toBe("tampered");
    expect(database.peek(`teams/${teamId}/keyGrants/${deviceId}`)).toBe(null);
    await expect(checkDeviceRecord(deviceId, { v: 1, encSpki: evil.encSpki, signSpki: junk, fingerprint })).rejects.toMatchObject({ code: "bad-key" });
  });
});

describe("a code read out for one team or member", () => {
  it("never approves the same device into another team, because the code is bound to the team and the member", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId } = await library(database);
    const second = await alice.createTeam({ number: 12345, name: "Second" });
    await second.sent;
    const ninaKeys = new MemoryDeviceKeyStore();
    const nina = await person(database, "nina", ninaKeys);
    for (const team of [teamId, second.value.id]) {
      const invite = await alice.createInvite(team, { role: "editor" });
      await invite.sent;
      await (await nina.redeemInvite(invite.value.code)).sent;
    }
    const first = await codeOf(nina, teamId);
    const other = await codeOf(nina, second.value.id);
    // The same device waits in both teams, with a different code in each.
    expect(other.deviceId).toBe(first.deviceId);
    expect(other.approvalCode.slice(0, 13)).not.toBe(first.approvalCode.slice(0, 13));
    expect(await code(alice.approveMember(second.value.id, "nina", { deviceId: first.deviceId, approvalCode: first.approvalCode }))).toBe("wrong-code");
    expect(database.peek(`teams/${second.value.id}/keyGrants/${first.deviceId}`)).toBe(null);
    await (await alice.approveMember(second.value.id, "nina", other)).sent;
    expect((await nina.teamKeyStatus(second.value.id)).state).toBe("ready");
  });
});

describe("a server that puts back a revoked device's grant", () => {
  it("gets that device nothing at the next rotation: an old grant is never carried to the new key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const aliceKeys = new MemoryDeviceKeyStore();
    const { alice, teamId, autoId } = await library(database, aliceKeys);
    const laptopKeys = new MemoryDeviceKeyStore();
    const laptop = new MemoryBackend({ database, deviceKeys: laptopKeys });
    laptop.signInAs("alice");
    await (await laptop.requestTeamKey(teamId)).sent;
    const laptopCode = await codeOf(laptop, teamId);
    await (await alice.grantDeviceKey(teamId, laptopCode.deviceId, laptopCode.approvalCode)).sent;
    expect((await laptop.teamKeyStatus(teamId)).state).toBe("ready");
    const laptopDevice = (await laptopKeys.load("alice"))!;
    const oldGrant = database.peek(`teams/${teamId}/keyGrants/${laptopDevice.deviceId}`) as DocData;

    // The laptop is stolen and revoked: its grant goes and the key rotates to version 2.
    await (await alice.revokeDevice(teamId, laptopDevice.deviceId)).sent;
    expect((database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v).toBe(2);

    // Later a member is removed. Just before, the server puts the laptop's old grant back.
    await join(database, alice, teamId, "eve");
    database.seed(`teams/${teamId}/keyGrants/${laptopDevice.deviceId}`, oldGrant);
    await (await alice.removeMember(teamId, "eve")).sent;
    expect((database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v).toBe(3);
    expect((database.peek(`teams/${teamId}/keyGrants/${laptopDevice.deviceId}`) as { kv: number } | null)?.kv ?? 0).toBeLessThan(3);

    const base = (await alice.listRevisions(teamId, autoId))[0]!.id;
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: base, content: '{"secret":"after the laptop was stolen"}' });
    await r2.sent;
    const stolen = await keyFromGrant(database, teamId, laptopDevice).catch(() => null);
    expect(stolen === null ? null : await readWith(database, teamId, autoId, r2.value.id, stolen)).toBe(null);
  });
});

describe("two grants that approve each other", () => {
  it("are dropped at the next rotation, although each signature and proof checks: no device of the roster approved either", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId } = await library(database);
    const eveKeys = new MemoryDeviceKeyStore();
    const eve = await person(database, "eve", eveKeys);
    const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await eve.redeemInvite(invite.value.code)).sent;
    const eveCode = await codeOf(eve, teamId);
    await (await alice.grantDeviceKey(teamId, eveCode.deviceId, eveCode.approvalCode)).sent;
    const eveDevice = (await eveKeys.load("eve"))!;
    const held = database.peek(`teams/${teamId}/keyGrants/${eveDevice.deviceId}`) as unknown as KeyGrant & { approverUid: string };
    const approverRecord = database.peek(`users/${held.approverUid}/devices/${held.approverDeviceId}`) as unknown as ReturnType<typeof deviceRecord>;
    const teamKey = await openKeyGrant({ teamId, grant: held, device: eveDevice, approver: { deviceId: held.approverDeviceId, record: approverRecord }, extractable: true });

    // Someone holding the key (a device taken off, working with the server) adds two devices of
    // Eve's whose grants name each other as approver, each signed by the other and proved under the key.
    const [first, second] = [await generateDeviceKeys(), await generateDeviceKeys()];
    const seedGrant = async (device: DeviceKeys, approver: DeviceKeys) => {
      const grant = await makeKeyGrant({ teamId, teamKey, recipient: { deviceId: device.deviceId, uid: "eve", record: deviceRecord(device) }, approver });
      const proof = await makeGrantProof({ teamId, deviceId: device.deviceId, uid: "eve", fingerprint: device.fingerprint, teamKey });
      database.seed(`teams/${teamId}/keyGrants/${device.deviceId}`, {
        ...grant, uid: "eve", proof, approverUid: "eve", createdAt: SERVER_TIME, updatedAt: SERVER_TIME,
      } as unknown as DocData);
    };
    for (const device of [first, second]) database.seed(`users/eve/devices/${device.deviceId}`, { ...deviceRecord(device), createdAt: SERVER_TIME });
    await seedGrant(first, second);
    await seedGrant(second, first);

    await (await alice.completeKeyRotation(teamId)).sent;
    expect((database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v).toBe(2);
    for (const device of [first, second]) expect(database.peek(`teams/${teamId}/keyGrants/${device.deviceId}`)).toBe(null);
    expect((database.peek(`teams/${teamId}/keyGrants/${eveDevice.deviceId}`) as { kv: number }).kv).toBe(2);
  });
});

describe("a server that puts back a replaced recovery record", () => {
  it("gets nothing the old code opens: replacing the code rotates the key, and a rotation refuses a record behind it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, recoveryCode } = await library(database);
    const oldRecord = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
    // The old code leaked, so the owner replaces it.
    await (await alice.replaceRecoveryCode(teamId)).sent;
    expect((database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v).toBe(2);

    // The server puts the old record back, then a member is removed and the key rotates again.
    database.seed(`teams/${teamId}/recovery/current`, oldRecord as unknown as DocData);
    await join(database, alice, teamId, "eve").catch(() => undefined);
    await code(alice.removeMember(teamId, "eve").then((q) => q.sent));
    const record = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
    const opened = await openRecovery({ teamId, record, code: await recoveryCodeFromText(recoveryCode) }).catch(() => null);
    // The old code opens at most key 1, which the team stopped using when the code was replaced.
    expect(opened?.version ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("a server that makes up a whole team for a new device", () => {
  it("is refused on the device's first use: the grant carries no approval MAC under the code on its screen", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId } = await library(database);
    const bobKeys = new MemoryDeviceKeyStore();
    const bob = await person(database, "bob", bobKeys);
    const invite = await alice.createInvite(teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await bob.redeemInvite(invite.value.code)).sent;
    const bobDevice = (await bobKeys.load("bob"))!;

    // The server's own team: version 1 and a version 2 signed by it, its public keys, and a grant to
    // Bob's device from a device of its own, with a MAC under a code it had to guess.
    const forged1 = await createTeamKeys(teamId);
    const forged2 = await rotateTeamKeys(teamId, forged1);
    const evil = await generateDeviceKeys();
    database.seed(`users/mallory/devices/${evil.deviceId}`, { ...deviceRecord(evil), createdAt: SERVER_TIME });
    const { digest, ...roster2 } = await forgedRoster(teamId, forged2, evil, "mallory");
    database.seed(`teams/${teamId}/teamKeys/1`, { ...forged1.record, ...(await forgedRoster(teamId, forged1, evil, "mallory")), createdBy: "mallory", createdAt: SERVER_TIME });
    database.seed(`teams/${teamId}/teamKeys/2`, { ...forged2.record, ...roster2, createdBy: "mallory", createdAt: SERVER_TIME });
    database.seed(`teams/${teamId}`, { ...(database.peek(`teams/${teamId}`) as DocData), encKey: forged2.encKey });
    const grant = await makeKeyGrant({ teamId, teamKey: forged2.key, recipient: { deviceId: bobDevice.deviceId, uid: "bob", record: deviceRecord(bobDevice) }, approver: evil });
    const proof = await makeGrantProof({ teamId, deviceId: bobDevice.deviceId, uid: "bob", fingerprint: bobDevice.fingerprint, teamKey: forged2.key });
    const guess = await approvalKey({ teamId, deviceId: bobDevice.deviceId, secret: newApprovalSecret(), iterations: FAST_APPROVAL_KDF });
    const mac = await makeApprovalMac(guess, {
      teamId,
      deviceId: bobDevice.deviceId,
      uid: "bob",
      teamKey: forged2.key,
      encFingerprint: forged2.encKey.fingerprint,
      signSpki: forged2.encKey.signSpki,
      rosterDigest: digest as unknown as Uint8Array,
    });
    const at = new Date();
    const grantDoc = { ...grant, uid: "bob", proof, approverUid: "mallory", createdAt: at, updatedAt: at };
    for (const approval of [undefined, { v: 1, kv: 2, mac }]) {
      database.seed(`teams/${teamId}/keyGrants/${bobDevice.deviceId}`, approval === undefined ? grantDoc : { ...grantDoc, approval });
      const status = await bob.teamKeyStatus(teamId);
      expect(status.state).toBe("waiting");
      // So Bob writes nothing under the server's key.
      expect(await code(bob.publishRevision({ teamId, autoId, baseRevision: null, content: '{"secret":"bob wrote this"}' }))).toBe("no-key");
    }
  }, 20_000);
});

describe("an approval made over the key before a rotation", () => {
  it("never approves a newer key: a member holding the old key cannot move a waiting device onto a key of their own", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId } = await library(database);
    const mallory = await join(database, alice, teamId, "mallory");
    const bobKeys = new MemoryDeviceKeyStore();
    const bob = await person(database, "bob", bobKeys);
    const invite = await alice.createInvite(teamId, { role: "editor" });
    await invite.sent;
    await (await bob.redeemInvite(invite.value.code)).sent;
    // Alice approves Bob with the code on his screen: his grant carries a MAC over key 1. Bob has not opened it yet.
    await (await alice.approveMember(teamId, "bob", await codeOf(bob, teamId))).sent;
    const bobDevice = (await bobKeys.load("bob"))!;
    const bobGrant = `teams/${teamId}/keyGrants/${bobDevice.deviceId}`;
    const approval = (database.peek(bobGrant) as { approval: { kv: number } }).approval;
    expect(approval.kv).toBe(1);

    // Mallory holds key 1, so she can make a key 2 of her own that the chain accepts, signed by pair 1.
    // The server installs it and moves Bob's grant onto it, keeping Alice's approval.
    const opened = await (mallory as unknown as { keys: KeyRing }).keys.openTeam(teamId, { extractable: true });
    const forged = await rotateTeamKeys(teamId, opened.newest);
    const { digest: _digest, ...roster2 } = await forgedRoster(teamId, forged, opened.device, "mallory");
    database.seed(`teams/${teamId}/teamKeys/2`, { ...forged.record, ...roster2 });
    database.seed(`teams/${teamId}`, { ...(database.peek(`teams/${teamId}`) as DocData), encKey: forged.encKey });
    const grant = await makeKeyGrant({ teamId, teamKey: forged.key, recipient: { deviceId: bobDevice.deviceId, uid: "bob", record: deviceRecord(bobDevice) }, approver: opened.device });
    const proof = await makeGrantProof({ teamId, deviceId: bobDevice.deviceId, uid: "bob", fingerprint: bobDevice.fingerprint, teamKey: forged.key });
    const at = new Date();
    database.seed(bobGrant, { ...grant, uid: "bob", proof, approverUid: "mallory", approval, createdAt: at, updatedAt: at });

    // Bob's device refuses the key: the approval is over key 1, not the key 2 it was given.
    expect((await bob.teamKeyStatus(teamId)).state).toBe("waiting");
    expect(await code(bob.publishRevision({ teamId, autoId, baseRevision: null, content: '{"secret":"bob wrote this"}' }))).toBe("no-key");
  }, 20_000);

  it("is removed by an honest rotation, and the device that had not opened its grant asks again and gets the new key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    const bob = await person(database, "bob");
    const invite = await alice.createInvite(teamId, { role: "editor" });
    await invite.sent;
    await (await bob.redeemInvite(invite.value.code)).sent;
    await (await alice.approveMember(teamId, "bob", await codeOf(bob, teamId))).sent;
    // Alice replaces the recovery code, which rotates the key, before Bob's device opens its grant.
    await (await alice.replaceRecoveryCode(teamId)).sent;
    const { deviceId } = await codeOf(bob, teamId);
    const grant = database.peek(`teams/${teamId}/keyGrants/${deviceId}`) as DocData;
    expect(grant.kv).toBe(2);
    expect(Object.hasOwn(grant, "approval")).toBe(false);

    expect(await bob.teamKeyStatus(teamId)).toMatchObject({ state: "waiting", requested: false });
    await (await bob.requestTeamKey(teamId)).sent;
    const again = await codeOf(bob, teamId);
    await (await alice.grantDeviceKey(teamId, again.deviceId, again.approvalCode)).sent;
    expect((await bob.teamKeyStatus(teamId)).state).toBe("ready");
    expect((await bob.openRevision(teamId, autoId, r1))?.content).toBe('{"secret":"far-side 7-ball"}');
  }, 20_000);
});

describe("a server that makes up a partner team's rotation", () => {
  it("shows it as changed, not rotated, so a share is not wrapped to the server's key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    const zed = await person(database, "zed");
    const partner = await zed.createTeam({ number: 11111, name: "Partner" });
    await partner.sent;
    const p = partner.value.id;
    await (await alice.createShare({ teamId, autoId, audience: "teams", teamIds: [p], revision: r1, projection: "{}" })).sent;

    // Version 2 of the partner's keys, signed with the server's own version 1.
    const evil = await rotateTeamKeys(p, await createTeamKeys(p));
    database.seed(`teams/${p}`, { ...(database.peek(`teams/${p}`) as DocData), encKey: evil.encKey });
    database.seed(`teams/${p}/teamKeys/2`, { ...evil.record, createdBy: "mallory", createdAt: SERVER_TIME });
    expect((await alice.checkPartnerKeys([p]))[0]).toMatchObject({ status: "changed", keyVersion: 2 });
    expect(await code(alice.createShare({ teamId, autoId, audience: "teams", teamIds: [p], revision: r1, projection: '{"secret":"shared path"}' }))).toBe("key-changed");
    const shares = database.paths().filter((path) => path.startsWith("shares/"));
    for (const path of shares) {
      const doc = database.peek(path) as { keyWraps: Record<string, Parameters<typeof unwrapShareKeyAsTeam>[0]["wrap"]>; projection: Envelope };
      const wrap = doc.keyWraps[p];
      if (wrap === undefined) continue;
      const shareId = path.split("/")[1]!;
      await expect(unwrapShareKeyAsTeam({ shareId, teamId: p, shareKeyVersion: doc.projection.kv, wrap, pair: evil.pair })).rejects.toThrow();
    }
  });
});

describe("a server that makes up the keys of a team the sharer is a member of", () => {
  it("refuses them the first time the member shares with it, since the device already holds that team's key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    // Alice is also a member of the partner team, and her device holds its key.
    const zed = await person(database, "zed");
    const partner = await zed.createTeam({ number: 11111, name: "Partner" });
    await partner.sent;
    const p = partner.value.id;
    const invite = await zed.createInvite(p, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await alice.redeemInvite(invite.value.code)).sent;
    const { deviceId, approvalCode } = await codeOf(alice, p);
    await (await zed.grantDeviceKey(p, deviceId, approvalCode)).sent;
    expect((await alice.teamKeyStatus(p)).state).toBe("ready");

    // Before Alice ever shares with it, the server swaps in keys of its own under the same version.
    const evil = await createTeamKeys(p);
    database.seed(`teams/${p}`, { ...(database.peek(`teams/${p}`) as DocData), encKey: evil.encKey });
    expect((await alice.checkPartnerKeys([p]))[0]).toMatchObject({ status: "member-key-differs", keyVersion: 1 });
    expect(await code(alice.createShare({ teamId, autoId, audience: "teams", teamIds: [p], revision: r1, projection: '{"secret":"shared path"}' }))).toBe("key-changed");
    expect(database.paths().filter((path) => path.startsWith("shares/"))).toEqual([]);
  }, 20_000);
});

describe("a server that puts back a share from before a team was taken off", () => {
  it("is refused by every device that saw the newer share key, so the team taken off reads nothing new", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    const olga = await person(database, "olga");
    const pt = await olga.createTeam({ number: 2, name: "P" });
    await pt.sent;
    const quinn = await person(database, "quinn");
    const qt = await quinn.createTeam({ number: 3, name: "Q" });
    await qt.sent;
    const [P, Q] = [pt.value.id, qt.value.id];
    const made = await alice.createShare({ teamId, autoId, audience: "teams", teamIds: [P, Q], revision: r1, level: "propose", projection: '{"v":1}' });
    await made.sent;
    const shareId = made.value.id;
    const before = database.peek(`shares/${shareId}`) as DocData;

    // Q is taken off: a new share key, which P's device reads.
    await (await alice.setShareTeams(shareId, [P])).sent;
    expect((await olga.getShare(shareId, P))?.projection).toBe('{"v":1}');

    // The server puts back the share as it was, still wrapped to Q.
    database.seed(`shares/${shareId}`, before);
    expect(await code(alice.updateShare(shareId, { revision: r1, projection: '{"secret":"new path"}' }))).toBe("tampered");
    expect(await code(alice.getShare(shareId))).toBe("tampered");
    expect(await code(olga.getShare(shareId, P))).toBe("tampered");
    expect(await code(olga.sendProposal({ shareId, fromTeamId: P, baseRevision: r1, diff: '{"secret":"proposal"}' }))).toBe("tampered");
    const stored = database.peek(`shares/${shareId}`) as { projection: Envelope };
    expect(stored.projection.kv).toBe(1);
    expect(database.paths().filter((path) => path.startsWith("proposals/"))).toEqual([]);
  });
});

describe("a server that puts back an older title", () => {
  it("is refused by a device that read the newer one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const aliceKeys = new MemoryDeviceKeyStore();
    const { alice, teamId, autoId } = await library(database, aliceKeys);
    const path = `teams/${teamId}/autos/${autoId}`;
    const first = database.peek(path) as DocData;
    // A second generation of the title, sealed as any client that renames the auto would.
    const key = (await keyFromGrant(database, teamId, (await aliceKeys.load("alice"))!))!;
    const title = await sealText(key, "Far side seven ball", aadFor.autoTitle({ teamId, autoId, gen: 2, kv: 1 }));
    database.seed(path, { ...first, title, titleGen: 2 });
    expect((await alice.listAutos(teamId)).map((a) => a.title)).toEqual(["Far side seven ball"]);
    // The generation is sealed into the title, so it cannot be relabelled either.
    database.seed(path, { ...first, titleGen: 2 });
    expect(await code(alice.listAutos(teamId))).toBe("tampered");
    database.seed(path, first);
    expect(await code(alice.listAutos(teamId))).toBe("tampered");
  });
});

describe("what the server stores in the clear", () => {
  it("holds no git commit id: it is sealed with the revision, because a public repository can be searched for it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: "{}", gitSha: sha });
    await r2.sent;
    const stored = database.peek(`teams/${teamId}/autos/${autoId}/revisions/${r2.value.id}`) as { gitSha: unknown };
    expect(typeof stored.gitSha).toBe("object");
    expect(JSON.stringify(stored, (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value))).not.toContain(sha);
    expect((await alice.openRevision(teamId, autoId, r2.value.id))?.gitSha).toBe(sha);
    expect((await alice.listRevisions(teamId, autoId)).find((r) => r.id === r2.value.id)?.gitSha).toBe(sha);
  });

  it("is described truthfully in a data export: Horizon cannot read a team's content, and a link secret is marked as one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await library(database);
    await (await alice.createShare({ teamId, autoId, revision: r1, audience: "link", projection: "{}" })).sent;
    const out = await alice.exportMyData();
    const text = out.notIncluded.join("\n");
    expect(text).not.toMatch(/Ask Horizon/);
    expect(text).toMatch(/Horizon cannot read it/);
    expect(out.notes?.join("\n")).toMatch(/linkSecret/);
  });
});

describe("a member who squats the id of a teammate's next device", () => {
  it("is shown to owners and admins, who delete the request, and the recovery code clears it in the write that grants", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, recoveryCode } = await library(database);
    const eve = await join(database, alice, teamId, "eve");
    const pat = await person(database, "pat");
    const invite = await alice.createInvite(teamId, { role: "editor" });
    await invite.sent;
    await (await pat.redeemInvite(invite.value.code)).sent;

    // Eve's laptop, whose id Pat learns, and a record and a request Pat puts at that id first.
    const laptopKeys = new MemoryDeviceKeyStore();
    const laptopDevice = await generateDeviceKeys();
    await laptopKeys.save("eve", laptopDevice);
    const squat = async (deviceId: string) => {
      const record = deviceRecord(await generateDeviceKeys());
      database.seed(`users/pat/devices/${deviceId}`, { ...record, createdAt: SERVER_TIME });
      database.seed(`teams/${teamId}/keyRequests/${deviceId}`, { uid: "pat", deviceId, createdAt: SERVER_TIME });
    };
    await squat(laptopDevice.deviceId);
    const laptop = new MemoryBackend({ database, deviceKeys: laptopKeys });
    laptop.signInAs("eve");
    expect(await code(laptop.requestTeamKey(teamId).then((q) => q.sent))).toBe("permission-denied");

    // Alice sees it as a request that matches no device, never offered for approval, and deletes it.
    const listed = (await alice.listKeyRequests(teamId)).filter((request) => request.deviceId === laptopDevice.deviceId);
    expect(listed).toMatchObject([{ uid: "pat", matchesDevice: false, code: "" }]);
    expect(await eve.listKeyRequests(teamId)).toEqual([]);
    await (await alice.declineKeyRequest(teamId, laptopDevice.deviceId)).sent;
    await (await laptop.requestTeamKey(teamId)).sent;
    const laptopCode = await codeOf(laptop, teamId);
    await (await alice.grantDeviceKey(teamId, laptopCode.deviceId, laptopCode.approvalCode)).sent;
    expect((await laptop.teamKeyStatus(teamId)).state).toBe("ready");

    // Alice's new device, whose id Pat squats too, uses the recovery code: the grant deletes the request.
    const freshKeys = new MemoryDeviceKeyStore();
    const freshDevice = await generateDeviceKeys();
    await freshKeys.save("alice", freshDevice);
    await squat(freshDevice.deviceId);
    const fresh = new MemoryBackend({ database, deviceKeys: freshKeys });
    fresh.signInAs("alice");
    await (await fresh.useRecoveryCode(teamId, recoveryCode)).sent;
    expect(database.peek(`teams/${teamId}/keyRequests/${freshDevice.deviceId}`)).toBe(null);
    expect((await fresh.teamKeyStatus(teamId)).state).toBe("ready");
    // A member who is not an owner or admin cannot delete it, so the rules refuse the grant.
    const eveTabletKeys = new MemoryDeviceKeyStore();
    const eveTablet = await generateDeviceKeys();
    await eveTabletKeys.save("eve", eveTablet);
    await squat(eveTablet.deviceId);
    const tablet = new MemoryBackend({ database, deviceKeys: eveTabletKeys });
    tablet.signInAs("eve");
    expect(await code(tablet.useRecoveryCode(teamId, recoveryCode).then((q) => q.sent))).toBe("permission-denied");
    expect(database.peek(`teams/${teamId}/keyGrants/${eveTablet.deviceId}`)).toBe(null);
  });
});

describe("an admin invite never lets anyone in at once (owner ruling 2026-10-25)", () => {
  const inviteDoc = (teamId: string, autoApprove: boolean): DocData => ({
    teamId,
    role: "admin",
    expiresAt: new Date(Date.now() + 86_400_000),
    maxUses: 1,
    uses: 0,
    autoApprove,
    createdBy: "alice",
    createdAt: SERVER_TIME,
    revoked: false,
  });

  it("is refused by the app and by the rules", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    await expect(alice.createInvite(teamId, { role: "admin", autoApprove: true })).rejects.toThrow(
      "An admin invite cannot let people in at once.",
    );
    expect(await code(Promise.resolve().then(() => database.commit("alice", [{ op: "set", path: "invites/AdminAtOnce0000000001", data: inviteDoc(teamId, true) }])))).toBe("permission-denied");

    const waits = await alice.createInvite(teamId, { role: "admin", autoApprove: false });
    await waits.sent;
    const path = `invites/${waits.value.code}`;
    expect(await code(Promise.resolve().then(() => database.commit("alice", [{ op: "update", path, data: { autoApprove: true } }])))).toBe("permission-denied");
    expect(database.peek(path)).toMatchObject({ autoApprove: false });
  });

  it("leaves whoever opens an older admin invite that approved automatically waiting for approval", async () => {
    const database = new MemoryDatabase();
    const { alice, teamId } = await library(database);
    const older = "AdminAtOnce0000000002";
    database.seed(`invites/${older}`, { ...inviteDoc(teamId, true), createdAt: new Date() });
    const mallory = await person(database, "mallory");
    await (await mallory.redeemInvite(older)).sent;
    expect(database.peek(`teams/${teamId}/members/mallory`)).toMatchObject({ role: "pending", requestedRole: "admin" });
    expect((await alice.listMembers(teamId)).find((m) => m.uid === "mallory")?.role).toBe("pending");
  });
});
