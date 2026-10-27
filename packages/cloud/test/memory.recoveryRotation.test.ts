/**
 * A rotation whose maker's only authority is the recovery code (keys/roster.ts, `checkRosterStep`).
 * The code is on paper where a member who is not an owner or admin may have seen it, so with it, and
 * the server's help, she can sign the next roster. These tests are that member, Eve, an editor, who
 * then tries to keep more than the code gave her: a device planted under the owner's name, which
 * would make the key after it and outlive a new code, or a role raised while her device claims to be
 * the owner's. Bob's device, which saw the team before, walks to her roster and must refuse it.
 */
import { describe, expect, it } from "vitest";
import {
  deviceRecord,
  generateDeviceKeys,
  MemoryDeviceKeyStore,
  openRecoverySigner,
  recoveryCodeFromText,
  rotateTeamKeys,
  type DeviceKeys,
  type RecoveryRecord,
} from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { cryptoRandomBytes } from "../src/ids.js";
import { RECOVERY_CANNOT_RAISE, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { endorseRecoveredDevice, ROSTER_RAISES_AUTHORITY, ROSTER_UNAPPROVED_DEVICE, rosterNonce, sealRoster, type Roster, type RosterDevice } from "../src/keys/roster.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData, Write } from "../src/store.js";

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

/**
 * The code of the `CloudError` a call fails with and the messages of its causes, as
 * `code: message | cause | ...`, so a test can see which check refused; "allowed" when it does not fail.
 */
async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (!isCloudError(error)) throw error;
    const messages: string[] = [];
    for (let cause: unknown = error.cause; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
    return `${error.code}: ${messages.join(" | ")}`;
  }
  return "allowed";
}

async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;

async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()) {
  const member = await person(database, uid, deviceKeys, trust);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  await (await approver.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  await member.listAutos(teamId);
  return member;
}

/** Applies `writes` as the server, without the rules (an update merges). */
function serverApplies(database: MemoryDatabase, writes: readonly Write[]): void {
  for (const write of writes) {
    if (write.op === "set") database.seed(write.path, write.data);
    else if (write.op === "update") database.seed(write.path, { ...(database.peek(write.path) ?? {}), ...write.data });
  }
}

/** Alice's team with Bob and Eve, editors, in a roster Bob's device has pinned; and the recovery code. */
async function team(database: MemoryDatabase) {
  const alice = await person(database, "alice");
  const made = await alice.createTeam({ number: 36596, name: "Horizon" });
  await made.sent;
  const teamId = made.value.id;
  const auto = await alice.createAuto(teamId, { title: "Close side" });
  await auto.sent;
  const bobKeys = new MemoryDeviceKeyStore();
  const bobTrust = new MemoryTrustStore();
  const bob = await join(database, alice, teamId, "bob", bobKeys, bobTrust);
  const eve = await join(database, alice, teamId, "eve");
  await (await alice.completeKeyRotation(teamId)).sent;
  await bob.listAutos(teamId);
  await eve.listAutos(teamId);
  return { alice, bob, eve, teamId, bobKeys, bobTrust, recoveryCode: made.value.recoveryCode };
}

/**
 * The next key version made by Eve's new laptop with the recovery code and the server's help: the
 * laptop claims `uid`, the recovery key endorses it, `shape` changes the honest roster it would sign,
 * and the server serves it with a grant of the new key for Bob's device.
 */
async function eveRotatesWithTheCode(
  database: MemoryDatabase,
  eve: MemoryBackend,
  bob: MemoryBackend,
  teamId: string,
  recoveryCode: string,
  uid: string,
  shape: (roster: Roster, planted: RosterDevice) => Roster,
): Promise<void> {
  const held: OpenedTeam = await keysOf(eve).openTeam(teamId, { extractable: true });
  const previous = held.roster;
  const laptop: DeviceKeys = await generateDeviceKeys();
  const planted: DeviceKeys = await generateDeviceKeys();
  const entry = (keys: DeviceKeys, owner: string): RosterDevice => ({ deviceId: keys.deviceId, uid: owner, encSpki: keys.encSpki, signSpki: keys.signSpki, fingerprint: keys.fingerprint });
  // The server holds the laptop's record under every name it is shown with.
  for (const name of new Set([uid, "eve"])) database.seed(`users/${name}/devices/${laptop.deviceId}`, { ...deviceRecord(laptop) } as unknown as DocData);

  const record = database.peek(`teams/${teamId}/recovery/current`) as unknown as RecoveryRecord;
  const signer = await openRecoverySigner({ teamId, record, code: await recoveryCodeFromText(recoveryCode) });
  const me = entry(laptop, uid);
  const signature = await endorseRecoveredDevice(signer, { teamId, kv: previous.kv, deviceId: me.deviceId, uid, fingerprint: me.fingerprint });
  const next = await rotateTeamKeys(teamId, held.newest);
  const honest: Roster = {
    v: 1,
    teamId,
    kv: next.key.version,
    rotator: laptop.deviceId,
    nonce: rosterNonce(cryptoRandomBytes),
    members: previous.members,
    membersMayApprove: previous.membersMayApprove,
    devices: [...previous.devices, me].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
    recovery: previous.recovery,
    via: [{ kind: "recovery", ...me, kv: previous.kv, recoverySpki: record.spki, recoverySignSpki: record.signSpki, signature }],
    recoveryAnchor: null,
    shares: [],
  };
  const roster = shape(honest, entry(planted, "alice"));
  const sealed = await sealRoster({ teamId, key: next.key, pairSpki: next.record.pairSpki, signSpki: next.record.signSpki, roster, signer: laptop.signing.privateKey, random: cryptoRandomBytes });
  database.seed(`teams/${teamId}/teamKeys/${String(next.key.version)}`, { ...next.record, roster: sealed.roster, rosterSig: sealed.rosterSig } as unknown as DocData);
  database.seed(`teams/${teamId}`, { ...(database.peek(`teams/${teamId}`) as DocData), encKey: next.encKey } as unknown as DocData);
  // Bob's device gets the new key from the laptop, so it opens the team at the new version.
  const rotated: OpenedTeam = { ...held, device: laptop, newest: { key: next.key, pair: next.pair }, roster, rosterDigest: sealed.digest };
  const bobDevice = await keysOf(bob).device();
  const existing = database.peek(`teams/${teamId}/keyGrants/${bobDevice.deviceId}`) as never;
  serverApplies(database, [await keysOf(eve).grantWrite(rotated, { uid: "bob", deviceId: bobDevice.deviceId, record: deviceRecord(bobDevice) }, existing)]);
}

/** Bob's device in a new session, so nothing it opened before is kept in memory. */
function fresh(database: MemoryDatabase, keys: MemoryDeviceKeyStore, trust: MemoryTrustStore): MemoryBackend {
  const backend = new MemoryBackend({ database, deviceKeys: keys, trust });
  backend.signInAs("bob");
  return backend;
}

describe("a rotation made with only the recovery code's authority", () => {
  it("is accepted when it keeps the roster and adds only its own device (the harness is sound)", async () => {
    const database = new MemoryDatabase();
    const { bob, eve, teamId, bobKeys, bobTrust, recoveryCode } = await team(database);
    await eveRotatesWithTheCode(database, eve, bob, teamId, recoveryCode, "eve", (roster) => roster);
    expect(await code(fresh(database, bobKeys, bobTrust).listAutos(teamId))).toBe("allowed");
  }, 60_000);

  it("is refused when it plants a device under the owner's name, which could make the next key", async () => {
    const database = new MemoryDatabase();
    const { bob, eve, teamId, bobKeys, bobTrust, recoveryCode } = await team(database);
    await eveRotatesWithTheCode(database, eve, bob, teamId, recoveryCode, "eve", (roster, planted) => ({
      ...roster,
      devices: [...roster.devices, planted].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
    }));
    expect(await reason(fresh(database, bobKeys, bobTrust).listAutos(teamId))).toMatch(new RegExp(`^tampered: .*${ROSTER_UNAPPROVED_DEVICE}`));
  }, 60_000);

  it("is refused when it plants a device under an editor's name that nobody approved", async () => {
    const database = new MemoryDatabase();
    const { bob, eve, teamId, bobKeys, bobTrust, recoveryCode } = await team(database);
    await eveRotatesWithTheCode(database, eve, bob, teamId, recoveryCode, "eve", (roster, planted) => ({
      ...roster,
      devices: [...roster.devices, { ...planted, uid: "eve" }].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
    }));
    expect(await reason(fresh(database, bobKeys, bobTrust).listAutos(teamId))).toMatch(new RegExp(`^tampered: .*${ROSTER_UNAPPROVED_DEVICE}`));
  }, 60_000);

  it("is refused when it raises a role, even when the device that signs it claims to be the owner's", async () => {
    const database = new MemoryDatabase();
    const { bob, eve, teamId, bobKeys, bobTrust, recoveryCode } = await team(database);
    await eveRotatesWithTheCode(database, eve, bob, teamId, recoveryCode, "alice", (roster) => ({
      ...roster,
      members: roster.members.map((member) => (member.uid === "eve" ? { uid: "eve", role: "admin" as const } : member)),
    }));
    expect(await reason(fresh(database, bobKeys, bobTrust).listAutos(teamId))).toMatch(new RegExp(`^tampered: .*${ROSTER_RAISES_AUTHORITY}`));
  }, 60_000);

  it("is refused when it turns on members approving devices, even when its device claims to be the owner's", async () => {
    const database = new MemoryDatabase();
    const { bob, eve, teamId, bobKeys, bobTrust, recoveryCode } = await team(database);
    await eveRotatesWithTheCode(database, eve, bob, teamId, recoveryCode, "alice", (roster) => ({ ...roster, membersMayApprove: true }));
    expect(await reason(fresh(database, bobKeys, bobTrust).listAutos(teamId))).toMatch(new RegExp(`^tampered: .*${ROSTER_RAISES_AUTHORITY}`));
  }, 60_000);
});

describe("an honest device whose only authority to rotate is the recovery code", () => {
  // The state an owner's or admin's new device is in once the recovery code gave it the key and
  // nothing else did: in no roster, approved by nobody, with the recovery key's endorsement on its
  // own grant. Eve's laptop gets there as an editor; the roster it is shown names her an admin, so
  // the rotation reaches the raise check rather than the owner-or-admin guard before it.
  async function eveLaptopAsAdmin(database: MemoryDatabase) {
    const { teamId, recoveryCode } = await team(database);
    const laptop = await person(database, "eve");
    await (await laptop.useRecoveryCode(teamId, recoveryCode)).sent;
    const held = await keysOf(laptop).openTeam(teamId, { extractable: true });
    const roster: Roster = { ...held.roster, members: held.roster.members.map((member) => (member.uid === "eve" ? { uid: "eve", role: "admin" as const } : member)) };
    // The server's rules, which read the member documents, let an admin read what a rotation reads.
    const memberPath = `teams/${teamId}/members/eve`;
    database.seed(memberPath, { ...(database.peek(memberPath) as DocData), role: "admin" });
    return { laptop, teamId, opened: { ...held, roster } as OpenedTeam };
  }

  it("refuses, before anything is written, a rotation that would make someone an admin", async () => {
    const database = new MemoryDatabase();
    const { laptop, teamId, opened } = await eveLaptopAsAdmin(database);
    const before = database.paths().length;
    const refused = keysOf(laptop).rotationWrites(teamId, {}, { opened, roles: { bob: "admin" } });
    await expect(refused).rejects.toThrow(RECOVERY_CANNOT_RAISE);
    expect(await code(refused)).toBe("invalid");
    expect(database.paths().length).toBe(before);
  }, 60_000);

  it("refuses a rotation that would let members approve devices, and makes one that changes neither", async () => {
    const database = new MemoryDatabase();
    const { laptop, teamId, opened } = await eveLaptopAsAdmin(database);
    await expect(keysOf(laptop).rotationWrites(teamId, {}, { opened, membersMayApprove: true })).rejects.toThrow(RECOVERY_CANNOT_RAISE);
    const rotation = await keysOf(laptop).rotationWrites(teamId, {}, { opened });
    expect(rotation.kv).toBe(opened.newest.key.version + 1);
  }, 60_000);
});
