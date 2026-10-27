/**
 * Nothing new is sealed under a team key a removed member may still hold (security review M2). While
 * a rotation is due, a publish, a new auto, a new share, a share update, a team added to a share and a
 * proposal are refused with a sentence that says who can make the new key. The `rotationPending` mark
 * is the server's word, so a device also works out from the newest roster that a rotation is due: a
 * member it names who is no longer active, or, for an owner or admin, a device it names with no grant.
 */
import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { ROTATE_BEFORE_SEALING, ROTATE_BEFORE_SEALING_ADMIN } from "../src/client.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string): Promise<MemoryBackend> {
  const member = await person(database, uid);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  await (await approver.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  await member.listAutos(teamId);
  return member;
}
/** A team of Alice (owner), Bob and Mallory (editors), with one auto, whose newest roster names all three. */
async function team() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const alice = await person(database, "alice");
  const created = await alice.createTeam({ number: 1111, name: "Alpha" });
  await created.sent;
  const teamId = created.value.id;
  const auto = await alice.createAuto(teamId, { title: "secret auto" });
  await auto.sent;
  const bob = await join(database, alice, teamId, "bob");
  const mallory = await join(database, alice, teamId, "mallory");
  await (await alice.completeKeyRotation(teamId)).sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  await bob.listAutos(teamId);
  return { database, alice, bob, mallory, teamId, autoId: auto.value.id, r1: r1.value.id };
}
/** The server drops the "rotation pending" mark, and every device forgets what it opened. */
function hideMark(t: Awaited<ReturnType<typeof team>>): void {
  const doc = t.database.peek(`teams/${t.teamId}`)!;
  t.database.seed(`teams/${t.teamId}`, { ...doc, rotationPending: false });
  for (const backend of [t.alice, t.bob]) keysOf(backend).forget(t.teamId);
}

describe("sealing while a rotation is due", () => {
  it("refuses a publish after a member left, telling an owner to make a new key and anyone else to ask one, until the key changes", async () => {
    const t = await team();
    await (await t.mallory.leaveTeam(t.teamId)).sent;
    const publish = (by: MemoryBackend) => by.publishRevision({ teamId: t.teamId, autoId: t.autoId, baseRevision: t.r1, content: '{"s":"two"}' });
    await expect(publish(t.alice)).rejects.toMatchObject({ code: "conflict", message: ROTATE_BEFORE_SEALING_ADMIN });
    await expect(publish(t.bob)).rejects.toMatchObject({ code: "conflict", message: ROTATE_BEFORE_SEALING });
    await expect(t.bob.createAuto(t.teamId, { title: "new" })).rejects.toMatchObject({ code: "conflict" });
    await (await t.alice.completeKeyRotation(t.teamId)).sent;
    await (await publish(t.bob)).sent;
  });

  it("works out from the roster that a member left when the server hides the mark", async () => {
    const t = await team();
    await (await t.mallory.leaveTeam(t.teamId)).sent;
    hideMark(t);
    const status = await t.alice.teamKeyStatus(t.teamId);
    expect(status).toMatchObject({ state: "ready", rotationPending: true });
    await expect(t.bob.publishRevision({ teamId: t.teamId, autoId: t.autoId, baseRevision: t.r1, content: '{"s":"two"}' })).rejects.toMatchObject({
      code: "conflict",
      message: ROTATE_BEFORE_SEALING,
    });
  });

  it("works out on an owner's device that a device the roster names lost its grant when the server hides the mark", async () => {
    const t = await team();
    const malloryDevice = await keysOf(t.mallory).device();
    await (await t.mallory.revokeDevice(t.teamId, malloryDevice.deviceId)).sent;
    hideMark(t);
    expect(await t.alice.teamKeyStatus(t.teamId)).toMatchObject({ state: "ready", rotationPending: true });
    await expect(t.alice.createAuto(t.teamId, { title: "new" })).rejects.toMatchObject({ code: "conflict", message: ROTATE_BEFORE_SEALING_ADMIN });
  });

  it("seals as before when nobody left", async () => {
    const t = await team();
    expect(await t.alice.teamKeyStatus(t.teamId)).toMatchObject({ state: "ready", rotationPending: false });
    await (await t.bob.publishRevision({ teamId: t.teamId, autoId: t.autoId, baseRevision: t.r1, content: '{"s":"two"}' })).sent;
  });
});
