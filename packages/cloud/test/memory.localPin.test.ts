/**
 * A rotating write this device has queued but the server has not acknowledged is applied to every
 * read until the server answers, as the Firestore SDK does. A team open in that window used to pin
 * the version the write makes, so when another admin rotated first and the server refused the write,
 * the pin named a key that never existed and every later open failed as "tampered". An open now
 * leaves the pin where it is while the team document it read carries this device's unsent writes;
 * the rotation is pinned once it is acknowledged, and a refused one pins nothing.
 */
import { describe, expect, it } from "vitest";
import { bytesEqual } from "../src/crypto/bytes.js";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { isCloudError } from "../src/errors.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore, readPin, writePin, type Pin } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData, Write } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

/** A signed-in user on a device of their own. */
async function person(database: MemoryDatabase, uid: string, trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust });
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

/** The team's key as the server holds it. */
function serverKey(database: MemoryDatabase, teamId: string): { v: number; fingerprint: Uint8Array } {
  return (database.peek(`teams/${teamId}`) as { encKey: { v: number; fingerprint: Uint8Array } }).encKey;
}

/** A new revision by `author`, and its id. */
async function publish(author: MemoryBackend, teamId: string, autoId: string, content: string): Promise<string> {
  const base = (await author.listRevisions(teamId, autoId))[0]!.id;
  const revision = await author.publishRevision({ teamId, autoId, baseRevision: base, content });
  await revision.sent;
  return revision.value.id;
}

/**
 * Alice's team with one auto, Carol as an admin in the signed roster, and Eve as an editor. Alice's
 * device keeps its pins in `trust`.
 */
async function setup() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const trust = new MemoryTrustStore();
  const alice = await person(database, "alice", trust);
  const team = await alice.createTeam({ number: 1111, name: "Alpha" });
  await team.sent;
  const teamId = team.value.id;
  const auto = await alice.createAuto(teamId, { title: "Alpha auto" });
  await auto.sent;
  await (await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"one"}' })).sent;
  const carol = await join(database, alice, teamId, "carol");
  await (await alice.setRole(teamId, "carol", "admin")).sent;
  await carol.listAutos(teamId);
  await join(database, alice, teamId, "eve");
  await alice.listAutos(teamId);
  const pinOf = (): Pin | null => readPin(trust, "alice", "team", teamId);
  return { database, alice, carol, teamId, autoId: auto.value.id, pinOf };
}

/**
 * Takes Alice's device offline just as its next write to the team's key records is committed, so the
 * write is queued and, as the Firestore SDK does, applied to what the device reads until it is sent.
 */
function dropConnectionOnNextRotation(backend: MemoryBackend): void {
  const connection = backend.connection as unknown as { commit(writes: Write[]): unknown; online: boolean };
  const commit = connection.commit.bind(connection);
  let armed = true;
  connection.commit = (writes: Write[]) => {
    if (armed && writes.some((w) => w.path.includes("/teamKeys/"))) {
      armed = false;
      connection.online = false;
    }
    return commit(writes);
  };
}

type Docs = Map<string, DocData>;
const docsOf = (database: MemoryDatabase) => (database as unknown as { docs: Docs }).docs;

describe("a rotation the server refuses, after this device opened it before it was sent", () => {
  it("does not lock the device out of its team, and the next open moves the pin to the rotation that landed", async () => {
    const { database, alice, carol, teamId, pinOf } = await setup();
    const before = serverKey(database, teamId);
    expect(pinOf()?.v).toBe(before.v);
    dropConnectionOnNextRotation(alice);
    const removal = await alice.removeMember(teamId, "eve");
    removal.sent.catch(() => undefined);
    // The library refreshes while the write waits: the device opens its own new key, and pins nothing.
    keysOf(alice).forget(teamId);
    await alice.listAutos(teamId);
    expect(pinOf()?.v).toBe(before.v);
    // Carol, online, rotates first, so the server refuses Alice's write.
    await (await carol.completeKeyRotation(teamId)).sent;
    const carols = serverKey(database, teamId);
    expect(carols.v).toBe(before.v + 1);
    await alice.setOnline(true);
    const refused = await removal.sent.then(() => null, (error: unknown) => error);
    expect(refused).not.toBe(null);
    expect(pinOf()?.v).toBe(before.v);
    // Carol's key is the real one. Alice's device, pinned at the version before it, walks the
    // rosters forward to Carol's and opens the team.
    keysOf(alice).forget(teamId);
    const outcome = await alice.listAutos(teamId).then(() => "opened", (error: unknown) => (isCloudError(error) ? error.code : String(error)));
    expect(outcome).toBe("opened");
    const pin = pinOf();
    expect(pin?.v).toBe(carols.v);
    expect(pin !== null && bytesEqual(pin.fingerprint, carols.fingerprint)).toBe(true);
  }, 60_000);
});

describe("a rotation this device made, opened before it was sent", () => {
  it("is pinned once the server acknowledges it, so a server that then puts back the state from before is refused", async () => {
    const { database, alice, teamId, autoId, pinOf } = await setup();
    const before = serverKey(database, teamId);
    const snapshot = new Map([...docsOf(database)].map(([path, data]) => [path, structuredClone(data)]));
    dropConnectionOnNextRotation(alice);
    const removal = await alice.removeMember(teamId, "eve");
    // An open while the write waits sees the new key but does not pin it.
    keysOf(alice).forget(teamId);
    await alice.listAutos(teamId);
    expect(pinOf()?.v).toBe(before.v);
    await alice.setOnline(true);
    await removal.sent;
    const made = serverKey(database, teamId);
    expect(made.v).toBe(before.v + 1);
    const pin = pinOf();
    expect(pin?.v).toBe(made.v);
    expect(pin !== null && bytesEqual(pin.fingerprint, made.fingerprint)).toBe(true);
    // The server rolls the whole write back, as if it had never arrived.
    const docs = docsOf(database);
    docs.clear();
    for (const [path, data] of snapshot) docs.set(path, data);
    expect(serverKey(database, teamId).v).toBe(before.v);
    await expect(publish(alice, teamId, autoId, '{"secret":"after eve left"}')).rejects.toThrow(/not the ones this device saw before/);
    expect(pinOf()?.v).toBe(made.v);
  }, 60_000);
});

describe("a team pin", () => {
  it("is never replaced by a different key under the same version", () => {
    const trust = new MemoryTrustStore();
    const first = { v: 3, fingerprint: new Uint8Array(32).fill(1), signSpki: new Uint8Array(91).fill(2) };
    const other = { v: 3, fingerprint: new Uint8Array(32).fill(9), signSpki: new Uint8Array(91).fill(2) };
    const otherSigner = { v: 3, fingerprint: new Uint8Array(32).fill(1), signSpki: new Uint8Array(91).fill(8) };
    writePin(trust, "alice", "team", "t1", first, new Uint8Array(32).fill(4));
    writePin(trust, "alice", "team", "t1", other, new Uint8Array(32).fill(5));
    writePin(trust, "alice", "team", "t1", otherSigner, new Uint8Array(32).fill(5));
    const kept = readPin(trust, "alice", "team", "t1");
    expect(kept !== null && bytesEqual(kept.fingerprint, first.fingerprint) && bytesEqual(kept.signSpki, first.signSpki)).toBe(true);
    expect(kept !== null && kept.rosterDigest !== undefined && bytesEqual(kept.rosterDigest, new Uint8Array(32).fill(4))).toBe(true);
    // The same key again, and a newer one, are still written.
    writePin(trust, "alice", "team", "t1", { ...other, v: 4 }, new Uint8Array(32).fill(6));
    expect(readPin(trust, "alice", "team", "t1")?.v).toBe(4);
  });
});
