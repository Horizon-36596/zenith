/**
 * A team open that started before this device's rotation and finished after the rotation was
 * acknowledged used to write the older version's pin back, and cache the older open, so a server that
 * then put back the state from before had the owner publish under the key the removed member held.
 * The open now reads the pin again just before writing it, a team pin never goes down, and a cached
 * open is served only while the pin still names the team's key.
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


type Docs = Map<string, DocData>;
const docsOf = (database: MemoryDatabase) => (database as unknown as { docs: Docs }).docs;
const snap = (database: MemoryDatabase) => new Map([...docsOf(database)].map(([p, d]) => [p, structuredClone(d)]));
const restore = (database: MemoryDatabase, snapshot: Docs) => { const d = docsOf(database); d.clear(); for (const [p, v] of snapshot) d.set(p, v); };

/** Delays the answer to the next listing of `collection` (computed now) until `gate` opens. */
function delayNextList(backend: MemoryBackend, collection: string) {
  const store = backend.connection as unknown as { list: (q: { collection: string }) => Promise<unknown> };
  const original = store.list.bind(store);
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  let armed = true;
  let reached!: () => void;
  const hit = new Promise<void>((res) => (reached = res));
  store.list = async (q) => {
    if (armed && q.collection === collection) {
      armed = false;
      const answer = await original(q);
      reached();
      await gate;
      return answer;
    }
    return original(q);
  };
  return { open, hit };
}

describe("an open of the team that started before the rotation and finishes after its acknowledgement", () => {
  it("does not put the pin back to the version the removed member holds", async () => {
    const s = await setup();
    const { database, alice, aliceTrust, teamId, autoId } = s;
    const eve = await join(database, alice, teamId, "eve");
    await alice.listAutos(teamId);
    const kv = keyVersion(database, teamId);
    const snapshot = snap(database);
    // Alice's app refreshes the library (any read that opens the team) just as she removes Eve. The
    // server (or only the network) delivers the answer to one read of that refresh late.
    keysOf(alice).forget(teamId);
    const late = delayNextList(alice, `teams/${teamId}/teamKeys`);
    const refresh = alice.listAutos(teamId);
    await late.hit;
    // One open of a team runs at a time on a device, so the removal's open waits for the late one:
    // the late answer is let through while the removal waits, and the removal then rotates the key.
    const removal = alice.removeMember(teamId, "eve").then(async (queued) => queued.sent);
    late.open();
    await refresh.catch(() => undefined);
    await removal;
    expect(keyVersion(database, teamId)).toBe(kv + 1);
    const pinAfterRefresh = JSON.parse((aliceTrust as unknown as { get(k: string): string }).get(`zenith.pin.team.alice.${teamId}`)).v;
    // The server now puts back the state from before the removal.
    restore(database, snapshot);
    expect(keyVersion(database, teamId)).toBe(kv);
    const inSession = await refusal(async () => {
      const base = (await alice.listRevisions(teamId, autoId))[0]!.id;
      return alice.publishRevision({ teamId, autoId, baseRevision: base, content: '{"secret":"same session"}' });
    });
    const fresh = aliceAgain(s);
    let newest = "";
    const newSession = await refusal(async () => {
      const base = (await fresh.listRevisions(teamId, autoId))[0]!.id;
      const q = await fresh.publishRevision({ teamId, autoId, baseRevision: base, content: '{"secret":"new session"}' });
      newest = q.value.id;
      return q;
    });
    keysOf(eve).forget(teamId);
    const eveRead = await eve.openRevision(teamId, autoId, newest).then((r) => r?.content ?? null, (e) => `refused: ${String(e)}`);
    expect(pinAfterRefresh).toBe(kv + 1);
    expect(inSession).not.toBe(null);
    expect(newSession).not.toBe(null);
  }, 60_000);
});
