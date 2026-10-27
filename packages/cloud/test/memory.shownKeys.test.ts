/**
 * A share key is wrapped only to the partner key whose safety code the person was shown. The share
 * dialog checks the keys first (`checkPartnerKeys`), and each check names its key exactly (`keyId`);
 * the send hands those back (`expectedKeys`), and a team whose key is not the one named stops the
 * wrap with "key-changed". Accepting a changed key needs the key named too, so what is trusted is
 * the key that was shown and nothing else. The partner's safety code this device shows afterwards is
 * the code of the key it pinned. Against `MemoryBackend`, whose rules are the in-memory copy of
 * cloud/firestore.rules; `database.seed` plays a server that writes whatever it likes.
 */
import { describe, expect, it } from "vitest";
import { createTeamKeys, MemoryDeviceKeyStore, teamEncKeyFor } from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
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

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}

async function teamWithAuto(database: MemoryDatabase, uid: string, number: number, name: string) {
  const owner = await person(database, uid);
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: "{}" });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}

/** Plays a server that serves `teamId` with a key pair of its own under the same version. */
async function swapKey(database: MemoryDatabase, teamId: string): Promise<void> {
  const forged = await createTeamKeys(teamId);
  const doc = database.peek(`teams/${teamId}`) as DocData;
  database.seed(`teams/${teamId}`, { ...doc, encKey: teamEncKeyFor(forged.pair) });
}

async function world() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const q = await teamWithAuto(database, "quinn", 3333, "Third");
  const share = (options: { expectedKeys?: Record<string, string>; acceptKeyChanges?: string[]; teamIds?: string[] } = {}) =>
    a.owner
      .createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: options.teamIds ?? [p.teamId], projection: "{}", ...options })
      .then((queued) => queued.sent.then(() => queued.value));
  const keyIdOf = async (teamId: string): Promise<string> => {
    const check = (await a.owner.checkPartnerKeys([teamId]))[0];
    if (check === undefined) throw new Error("no check");
    return check.keyId;
  };
  return { database, a, p, q, share, keyIdOf };
}

describe("the key a share is wrapped to", () => {
  it("names each key exactly, and the same key the same way on every read", async () => {
    const { p, database, keyIdOf } = await world();
    const first = await keyIdOf(p.teamId);
    expect(first).toMatch(/^1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{122}$/);
    expect(await keyIdOf(p.teamId)).toBe(first);
    await swapKey(database, p.teamId);
    expect(await keyIdOf(p.teamId)).not.toBe(first);
  });

  it("wraps to the key that was shown on a first share, and pins it", async () => {
    const { a, p, share, keyIdOf } = await world();
    const shown = await keyIdOf(p.teamId);
    await share({ expectedKeys: { [p.teamId]: shown } });
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]).toMatchObject({ status: "same", keyId: shown });
  });

  it("refuses a first share when the key the server serves on the send is not the one shown", async () => {
    const { a, p, database, share, keyIdOf } = await world();
    const shown = await keyIdOf(p.teamId);
    await swapKey(database, p.teamId);
    expect(await code(share({ expectedKeys: { [p.teamId]: shown } }))).toBe("key-changed");
    // Nothing is pinned: the next check still treats the team as new, with the key served now.
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("first-use");
    expect(await a.owner.listTeamShares(a.teamId)).toEqual([]);
  });

  it("refuses the whole share when one of its teams shows another key, and wraps to none of them", async () => {
    const { a, p, q, database, share, keyIdOf } = await world();
    const shown = { [p.teamId]: await keyIdOf(p.teamId), [q.teamId]: await keyIdOf(q.teamId) };
    await swapKey(database, q.teamId);
    expect(await code(share({ teamIds: [p.teamId, q.teamId], expectedKeys: shown }))).toBe("key-changed");
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("first-use");
  });

  it("accepts a changed key only when the key accepted is named, and only that key", async () => {
    const { a, p, database, share, keyIdOf } = await world();
    await share({ expectedKeys: { [p.teamId]: await keyIdOf(p.teamId) } });
    await swapKey(database, p.teamId);
    const shown = await keyIdOf(p.teamId);
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("changed");

    // Accepting without naming the key accepts nothing.
    expect(await code(share({ acceptKeyChanges: [p.teamId] }))).toBe("key-changed");
    // Another key swapped in after the warning is not the one accepted.
    const real = database.peek(`teams/${p.teamId}`) as DocData;
    await swapKey(database, p.teamId);
    expect(await code(share({ acceptKeyChanges: [p.teamId], expectedKeys: { [p.teamId]: shown } }))).toBe("key-changed");
    // The key that was shown is.
    database.seed(`teams/${p.teamId}`, real);
    expect(await code(share({ acceptKeyChanges: [p.teamId], expectedKeys: { [p.teamId]: shown } }))).toBe("allowed");
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]).toMatchObject({ status: "same", keyId: shown });
  });

  it("refuses to add a team to a share when the key it shows on the send is not the one shown", async () => {
    const { a, p, q, database, share, keyIdOf } = await world();
    const made = await share({ expectedKeys: { [p.teamId]: await keyIdOf(p.teamId) } });
    const shown = await keyIdOf(q.teamId);
    await swapKey(database, q.teamId);
    const add = () => a.owner.setShareTeams(made.id, [p.teamId, q.teamId], { expectedKeys: { [q.teamId]: shown } }).then((queued) => queued.sent);
    expect(await code(add())).toBe("key-changed");
    expect((await a.owner.getShare(made.id))?.teamIds).toEqual([p.teamId]);
  });
});

describe("a partner team's safety code on this device", () => {
  it("is the code of the key served now before any pin, then of the key pinned, and says when the server shows another", async () => {
    const { a, p, database, share, keyIdOf } = await world();
    const real = await p.owner.teamKeyStatus(p.teamId);
    if (real.state !== "ready") throw new Error("the partner holds its key");
    expect(await a.owner.teamSafetyCode(p.teamId)).toEqual({ safetyCode: real.safetyCode, pinned: false, serverKeyDiffers: false });
    await share({ expectedKeys: { [p.teamId]: await keyIdOf(p.teamId) } });
    expect(await a.owner.teamSafetyCode(p.teamId)).toEqual({ safetyCode: real.safetyCode, pinned: true, serverKeyDiffers: false });

    await swapKey(database, p.teamId);
    expect(await a.owner.teamSafetyCode(p.teamId)).toEqual({ safetyCode: real.safetyCode, pinned: true, serverKeyDiffers: true });
  });

  it("follows a rotation the team signed, whose code the team's own page shows", async () => {
    const { a, p, database, share, keyIdOf } = await world();
    await share({ expectedKeys: { [p.teamId]: await keyIdOf(p.teamId) } });
    // A real rotation: a new version signed by the pinned one.
    const bea = await person(database, "bea");
    const invite = await p.owner.createInvite(p.teamId, { role: "editor", autoApprove: true });
    await invite.sent;
    await (await bea.redeemInvite(invite.value.code)).sent;
    const waiting = await bea.teamKeyStatus(p.teamId);
    if (waiting.state !== "waiting") throw new Error("a new member waits for the key");
    await (await p.owner.grantDeviceKey(p.teamId, waiting.device.deviceId, waiting.approvalCode)).sent;
    await bea.teamKeyStatus(p.teamId);
    await (await p.owner.removeMember(p.teamId, "bea")).sent;
    const rotated = await p.owner.teamKeyStatus(p.teamId);
    if (rotated.state !== "ready") throw new Error("the partner holds its key");
    expect(rotated.keyVersion).toBe(2);
    expect(await a.owner.teamSafetyCode(p.teamId)).toEqual({ safetyCode: rotated.safetyCode, pinned: true, serverKeyDiffers: false, keyReplaced: true });
  });
});
