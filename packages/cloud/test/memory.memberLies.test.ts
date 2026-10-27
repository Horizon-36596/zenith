/**
 * The member documents are the server's word, so they may only lower what a device does, never
 * spare it a rotation or a refusal. Whether a removal, a revocation, a demotion or a settings change
 * must rotate the team key, or must be refused, comes from the signed roster (keys/roster.ts). The
 * attacks here are played by the server, which lies in a member document or withholds a device's own
 * grant, with an admin or a thief who holds the key. Each worked before the client made those
 * decisions from the roster: the target kept the authority to make the next key, made it, and read
 * what the team wrote after. The last tests pin the refusals that close them, from a device that
 * cannot open the roster, one the roster gives no say, and the device being revoked itself.
 */
import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { isCloudError } from "../src/errors.js";
import { CANNOT_DEMOTE_ADMIN, CANNOT_REMOVE_ADMIN, CANNOT_REVOKE_ADMIN_DEVICE, CANNOT_STOP_MEMBER_APPROVALS, type KeyRing } from "../src/keys/keyring.js";
import { roleIn as roleOf, type Roster } from "../src/keys/roster.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { REVOKE_NEEDS_KEY_CHANGE } from "../src/client.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

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
async function codeOf(device: MemoryBackend, teamId: string) {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}

/** A member who joins through an invite that approves at once, and gets the key from `approver`. */
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

/** The version of the team's key. */
function keyVersion(database: MemoryDatabase, teamId: string): number {
  return (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
}

/** The newest roster, as `member`'s device opens and checks it. */
async function rosterOf(member: MemoryBackend, teamId: string): Promise<Roster> {
  return (await keysOf(member).openTeam(teamId)).roster;
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

/** What `work` threw, or null when it went through and was sent. */
async function refusal(work: () => Promise<{ sent: Promise<unknown> }>): Promise<unknown> {
  try {
    await (await work()).sent;
    return null;
  } catch (error) {
    return error;
  }
}

const memberPath = (teamId: string, uid: string) => `teams/${teamId}/members/${uid}`;
const grantPath = (teamId: string, deviceId: string) => `teams/${teamId}/keyGrants/${deviceId}`;

/** Asks for the key on `device` and has `approver` type the code it shows. */
async function approveDevice(device: MemoryBackend, approver: MemoryBackend, teamId: string): Promise<string> {
  await (await device.requestTeamKey(teamId)).sent;
  const { deviceId, approvalCode } = await codeOf(device, teamId);
  await (await approver.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
  await device.listAutos(teamId);
  return deviceId;
}

/** Runs `work` while the server withholds this device's own grant, so `member` cannot open the team. */
async function withoutOwnGrant<T>(database: MemoryDatabase, member: MemoryBackend, teamId: string, work: () => Promise<T>): Promise<T> {
  const path = grantPath(teamId, (await keysOf(member).device()).deviceId);
  const grant = database.peek(path)!;
  unseed(database, path);
  keysOf(member).forget(teamId);
  try {
    return await work();
  } finally {
    database.seed(path, grant);
  }
}

/** Alice's team, one auto with a secret in it, and Carol, an admin in the signed roster. */
async function setup() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const aliceKeys = new MemoryDeviceKeyStore();
  const aliceTrust = new MemoryTrustStore();
  const alice = await person(database, "alice", aliceKeys, aliceTrust);
  const team = await alice.createTeam({ number: 36596, name: "Horizon" });
  await team.sent;
  const teamId = team.value.id;
  const auto = await alice.createAuto(teamId, { title: "Close side" });
  await auto.sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"one"}' });
  await r1.sent;
  const carol = await join(database, alice, teamId, "carol");
  await (await alice.setRole(teamId, "carol", "admin")).sent;
  await carol.listAutos(teamId);
  expect((await rosterOf(alice, teamId)).members).toContainEqual({ uid: "carol", role: "admin" });
  return { database, alice, aliceKeys, aliceTrust, carol, teamId, autoId: auto.value.id, recoveryCode: team.value.recoveryCode };
}

/** Alice's app in a new session, so nothing it opened before is kept in memory. */
function aliceAgain(s: Awaited<ReturnType<typeof setup>>): MemoryBackend {
  const backend = new MemoryBackend({ database: s.database, deviceKeys: s.aliceKeys, trust: s.aliceTrust });
  backend.signInAs("alice");
  return backend;
}

/**
 * What `target` gets after the server puts her member document back as an admin's (and, with
 * `grant`, a grant the server kept): whether she makes the next key, and what she reads of a
 * revision Alice writes afterwards.
 */
async function whatTheTargetGets(s: Awaited<ReturnType<typeof setup>>, target: MemoryBackend, uid: string, grant?: { path: string; data: DocData }) {
  const { database, teamId, autoId } = s;
  const before = keyVersion(database, teamId);
  const realMember = database.peek(memberPath(teamId, uid));
  database.seed(memberPath(teamId, uid), { uid, role: "admin", displayName: uid, joinedAt: new Date() } as unknown as DocData);
  if (grant !== undefined) database.seed(grant.path, grant.data);
  keysOf(target).forget(teamId);
  const madeTheNextKey = (await refusal(() => target.completeKeyRotation(teamId))) === null;
  if (realMember === null) unseed(database, memberPath(teamId, uid));
  else database.seed(memberPath(teamId, uid), realMember);
  const after = await publish(aliceAgain(s), teamId, autoId, '{"secret":"written after"}');
  keysOf(target).forget(teamId);
  database.seed(memberPath(teamId, uid), { uid, role: "admin", displayName: uid, joinedAt: new Date() } as unknown as DocData);
  const read = await target.openRevision(teamId, autoId, after).then((revision) => revision?.content ?? null, () => null);
  expect(keyVersion(database, teamId)).toBe(madeTheNextKey ? before + 1 : before);
  return { madeTheNextKey, read };
}

describe("an owner removing an admin whom the server shows as still waiting to join", () => {
  it("rotates the key in the same write, since the signed roster names her an admin, so she makes no next key and reads nothing new", async () => {
    const s = await setup();
    const { database, alice, carol, teamId } = s;
    const real = database.peek(memberPath(teamId, "carol"))!;
    database.seed(memberPath(teamId, "carol"), { ...real, role: "pending" });
    const kv = keyVersion(database, teamId);
    await (await alice.removeMember(teamId, "carol")).sent;
    expect(database.peek(memberPath(teamId, "carol"))).toBe(null);
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    expect((await rosterOf(alice, teamId)).members.some((member) => member.uid === "carol")).toBe(false);
    expect(await whatTheTargetGets(s, carol, "carol")).toEqual({ madeTheNextKey: false, read: null });
  }, 60_000);
});

describe("an owner whose own grant the server withholds, removing an admin whom it shows as an editor", () => {
  it("is refused, since without the signed roster the device cannot tell she is not an admin, and goes through with a rotation once the grant is back", async () => {
    const s = await setup();
    const { database, alice, carol, teamId } = s;
    const aliceDevice = (await keysOf(alice).device()).deviceId;
    const grant = database.peek(grantPath(teamId, aliceDevice))!;
    unseed(database, grantPath(teamId, aliceDevice));
    const real = database.peek(memberPath(teamId, "carol"))!;
    database.seed(memberPath(teamId, "carol"), { ...real, role: "editor" });
    keysOf(alice).forget(teamId);
    const kv = keyVersion(database, teamId);
    const error = await refusal(() => alice.removeMember(teamId, "carol"));
    expect(isCloudError(error, "permission-denied") && error.message).toBe(CANNOT_REMOVE_ADMIN);
    expect(database.peek(memberPath(teamId, "carol"))).not.toBe(null);
    expect(keyVersion(database, teamId)).toBe(kv);

    database.seed(grantPath(teamId, aliceDevice), grant);
    database.seed(memberPath(teamId, "carol"), real);
    await (await alice.removeMember(teamId, "carol")).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    expect(await whatTheTargetGets(s, carol, "carol")).toEqual({ madeTheNextKey: false, read: null });
  }, 60_000);
});

describe("an owner demoting an admin whom the server already shows as an editor", () => {
  it("rotates in the same write, so the signed roster makes her an editor and the server cannot put her back", async () => {
    const s = await setup();
    const { database, alice, teamId } = s;
    const kv = keyVersion(database, teamId);
    const real = database.peek(memberPath(teamId, "carol"))!;
    database.seed(memberPath(teamId, "carol"), { ...real, role: "editor" });
    await (await alice.setRole(teamId, "carol", "editor")).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    expect((await rosterOf(alice, teamId)).members).toContainEqual({ uid: "carol", role: "editor" });
    // The server then shows her as an admin again; Alice's next rotation keeps her an editor.
    database.seed(memberPath(teamId, "carol"), { ...real, role: "admin" });
    await (await alice.completeKeyRotation(teamId)).sent;
    expect((await rosterOf(alice, teamId)).members).toContainEqual({ uid: "carol", role: "editor" });
  }, 60_000);
});

describe("an owner revoking her own lost phone while the server shows her as an editor", () => {
  it("fails and changes nothing, since her device may change the key, and rotates once the server tells the truth, so the phone makes no next key and reads nothing new", async () => {
    const s = await setup();
    const { database, alice, teamId } = s;
    // Alice's phone, approved from her first device, and in the roster after a rotation.
    const phone = await person(database, "alice");
    await (await phone.requestTeamKey(teamId)).sent;
    const { deviceId, approvalCode } = await codeOf(phone, teamId);
    await (await alice.grantDeviceKey(teamId, deviceId, approvalCode)).sent;
    await phone.listAutos(teamId);
    await (await alice.completeKeyRotation(teamId)).sent;
    await phone.listAutos(teamId);
    expect((await rosterOf(alice, teamId)).devices.some((device) => device.deviceId === deviceId)).toBe(true);
    const kv = keyVersion(database, teamId);
    const phoneGrant = database.peek(grantPath(teamId, deviceId))!;
    // The phone is stolen. Alice revokes it while the server says she is an editor, and so refuses
    // her device the grants a rotation reads.
    const real = database.peek(memberPath(teamId, "alice"))!;
    database.seed(memberPath(teamId, "alice"), { ...real, role: "editor" });
    const error = await refusal(() => alice.revokeDevice(teamId, deviceId));
    database.seed(memberPath(teamId, "alice"), real);
    // Alice's device may change the key, so the refused read fails the revocation rather than
    // leaving the phone's key current under a "rotation pending" mark.
    expect(isCloudError(error, "permission-denied") && error.message).toBe(REVOKE_NEEDS_KEY_CHANGE);
    expect(keyVersion(database, teamId)).toBe(kv);
    expect(database.peek(grantPath(teamId, deviceId))).not.toBe(null);

    await (await alice.revokeDevice(teamId, deviceId)).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    expect((await rosterOf(aliceAgain(s), teamId)).devices.some((device) => device.deviceId === deviceId)).toBe(false);
    // The thief, with the server putting the phone's grant back, tries to make the next key and read.
    expect(await whatTheTargetGets(s, phone, "alice", { path: grantPath(teamId, deviceId), data: phoneGrant })).toEqual({ madeTheNextKey: false, read: null });
  }, 60_000);
});

describe("an owner removing a member whom the server shows as still waiting to join, though she holds a grant", () => {
  it("rotates the key in the same write, since only a member with no grant and no place in the roster is declined without one", async () => {
    const s = await setup();
    const { database, alice, teamId, autoId } = s;
    const eve = await join(database, alice, teamId, "eve");
    expect(roleOf(await rosterOf(alice, teamId), "eve")).toBe(null);
    const real = database.peek(memberPath(teamId, "eve"))!;
    database.seed(memberPath(teamId, "eve"), { ...real, role: "pending" });
    const kv = keyVersion(database, teamId);
    await (await alice.removeMember(teamId, "eve")).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    const after = await publish(alice, teamId, autoId, '{"secret":"after eve left"}');
    database.seed(memberPath(teamId, "eve"), real);
    keysOf(eve).forget(teamId);
    expect(await eve.openRevision(teamId, autoId, after).then((revision) => revision?.content ?? null, () => null)).toBe(null);
  }, 60_000);
});

describe("lowering an owner's or admin's authority from a device that cannot make the next key", () => {
  it("is refused for a demotion, whether the device cannot open the roster or the roster gives it no say", async () => {
    const s = await setup();
    const { database, alice, teamId } = s;
    const kv = keyVersion(database, teamId);
    const blind = await withoutOwnGrant(database, alice, teamId, () => refusal(() => alice.setRole(teamId, "carol", "editor")));
    expect(isCloudError(blind, "permission-denied") && blind.message).toBe(CANNOT_DEMOTE_ADMIN);
    // Dan, an admin, on a tablet an editor approved while members may approve devices.
    const eve = await join(database, alice, teamId, "eve");
    const dan = await join(database, alice, teamId, "dan");
    await (await alice.setRole(teamId, "dan", "admin")).sent;
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
    await eve.listAutos(teamId);
    const tablet = await person(database, "dan");
    await approveDevice(tablet, eve, teamId);
    const kvBefore = keyVersion(database, teamId);
    const cannot = await refusal(() => tablet.setRole(teamId, "carol", "editor"));
    expect(isCloudError(cannot, "permission-denied") && cannot.message).toBe(CANNOT_DEMOTE_ADMIN);
    expect(database.peek(memberPath(teamId, "carol"))).toMatchObject({ role: "admin" });
    expect(keyVersion(database, teamId)).toBe(kvBefore);
    // A raise from the tablet is not refused: it counts for the rules, and the roster stays as it was.
    await (await tablet.setRole(teamId, "eve", "admin")).sent;
    expect(roleOf(await rosterOf(alice, teamId), "eve")).toBe("editor");
    expect(kvBefore).toBeGreaterThan(kv);
    expect(dan).toBeDefined();
  }, 60_000);

  it("is refused for taking the key from an owner's device, from a device that cannot open the roster or from that device itself", async () => {
    const s = await setup();
    const { database, alice, carol, teamId } = s;
    const phone = await person(database, "alice");
    const phoneId = await approveDevice(phone, alice, teamId);
    await (await alice.completeKeyRotation(teamId)).sent;
    await phone.listAutos(teamId);
    const kv = keyVersion(database, teamId);
    const blind = await withoutOwnGrant(database, alice, teamId, () => refusal(() => alice.revokeDevice(teamId, phoneId)));
    expect(isCloudError(blind, "permission-denied") && blind.message).toBe(CANNOT_REVOKE_ADMIN_DEVICE);
    const itself = await refusal(() => phone.revokeDevice(teamId, phoneId));
    expect(isCloudError(itself, "permission-denied") && itself.message).toBe(CANNOT_REVOKE_ADMIN_DEVICE);
    expect(database.peek(grantPath(teamId, phoneId))).not.toBe(null);
    expect(keyVersion(database, teamId)).toBe(kv);
    // From Carol's device, an admin's in the roster, it rotates.
    await (await carol.revokeDevice(teamId, phoneId)).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
  }, 60_000);

  it("is refused for turning off members approving devices, and goes through with a rotation once the device can make one", async () => {
    const s = await setup();
    const { database, alice, teamId } = s;
    await join(database, alice, teamId, "bob");
    const eve = await join(database, alice, teamId, "eve");
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: true })).sent;
    await eve.listAutos(teamId);
    expect((await rosterOf(alice, teamId)).membersMayApprove).toBe(true);
    const blind = await withoutOwnGrant(database, alice, teamId, () => refusal(() => alice.updateTeamSettings(teamId, { membersMayApproveDevices: false })));
    expect(isCloudError(blind, "permission-denied") && blind.message).toBe(CANNOT_STOP_MEMBER_APPROVALS);
    expect((await alice.getTeamSettings(teamId)).membersMayApproveDevices).toBe(true);
    // With her grant back, the change rotates, and the roster says members may not approve.
    await (await alice.updateTeamSettings(teamId, { membersMayApproveDevices: false })).sent;
    expect((await rosterOf(alice, teamId)).membersMayApprove).toBe(false);
  }, 60_000);
});

describe("an owner using the recovery code on a new laptop while the server hides that a rotation is pending", () => {
  it("rotates in the same write, since the roster lets the laptop make the next key, so a member who left reads nothing it writes", async () => {
    const s = await setup();
    const { database, carol, teamId, autoId, recoveryCode } = s;
    // Carol keeps the key she held when she leaves; the server then clears the mark her leaving set.
    const held = (await keysOf(carol).openTeam(teamId, { extractable: true })).newest.key;
    await (await carol.leaveTeam(teamId)).sent;
    expect(database.peek(`teams/${teamId}`)).toMatchObject({ rotationPending: true });
    database.seed(`teams/${teamId}`, { ...database.peek(`teams/${teamId}`)!, rotationPending: false });
    const kv = keyVersion(database, teamId);
    const laptop = await person(database, "alice");
    await (await laptop.useRecoveryCode(teamId, recoveryCode)).sent;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    const written = await publish(laptop, teamId, autoId, '{"secret":"written on the laptop"}');
    const revision = database.peek(`teams/${teamId}/autos/${autoId}/revisions/${written}`) as { content: { kv: number } };
    expect(revision.content.kv).toBe(kv + 1);
    expect(held.version).toBe(kv);
  }, 60_000);
});
