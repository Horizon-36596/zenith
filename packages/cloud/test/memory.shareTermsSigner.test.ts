/**
 * Who chose a share's terms. Anyone who holds the team's newest key, a member who has left while the
 * rotation that cuts her waits or a thief with a stolen device before it is revoked, can sign a
 * manifest at that key. Version 4 named the device that made a share and carried its signature over
 * the share's origin, so a share forged whole was dropped at the rotation; but a forger could change
 * an honest share's terms, swapping the key a partner team is named by for one of the server's, or its
 * level, its team list, its pinned revision or its end, and keep the honest origin signature. An
 * honest publish then signed it again, the rotation kept it, and the next re-key followed the forged
 * key to the server, past the revocation.
 *
 * A manifest now names the devices that signed its terms at the key that signs it (`tdev`), carries
 * the last one's signature over the terms (`tsig`) and its public keys (`tkeys`), and counts every
 * signature of the terms (`tseq`). A rotation lists a share only when every one of those devices is
 * one it keeps. These tests are that member and that thief, with the server on their side, and the
 * honest changes a rotation must keep. Against `MemoryBackend`; `database.seed` plays a server that
 * writes whatever it likes.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  createTeamKeys,
  MAX_TERMS_DEVICES,
  MemoryDeviceKeyStore,
  openText,
  readShareManifest,
  rotateTeamKeys,
  signShareManifest,
  teamKeyDigest,
  unwrapShareKeyAsTeam,
  wrapShareKeyToTeam,
  type DeviceKeys,
  type ShareKeyWrap,
  type ShareManifest,
  type ShareManifestBody,
  type TeamEncKey,
  type TeamKeyPair,
  unwrapShareKeyAsOwner,
} from "../src/crypto/index.js";
import { SHARE_NOT_LISTED, SHARE_TERMS_OLDER, SHARE_TERMS_SIGNERS_FULL } from "../src/client.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { teamKeyAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

const DAY_MS = 86_400_000;

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}
const sent = async (queued: Promise<{ sent: Promise<unknown> }>) => (await queued).sent;

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
async function grant(approver: MemoryBackend, device: MemoryBackend, teamId: string): Promise<void> {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  await (await approver.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  await device.listAutos(teamId);
}
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, role: "editor" | "admin" = "editor"): Promise<MemoryBackend> {
  const member = await person(database, uid);
  // An admin invite never approves at once (owner ruling 2026-10-25): an admin waits, and is approved with the key.
  const invite = await approver.createInvite(teamId, { role, autoApprove: role !== "admin" });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  if (role === "admin") {
    const status = await member.teamKeyStatus(teamId);
    if (status.state !== "waiting") throw new Error("already holds the key");
    await (await approver.approveMember(teamId, uid, { deviceId: status.device.deviceId, approvalCode: status.approvalCode })).sent;
    await member.listAutos(teamId);
  } else {
    await grant(approver, member, teamId);
  }
  return member;
}
/** Another device of `uid`, given the team key by `first`. */
async function secondDevice(database: MemoryDatabase, first: MemoryBackend, uid: string, teamId: string): Promise<MemoryBackend> {
  const laptop = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  laptop.signInAs(uid);
  await (await laptop.requestTeamKey(teamId)).sent;
  await grant(first, laptop, teamId);
  return laptop;
}
async function teamWithAuto(database: MemoryDatabase, uid: string, number: number, name: string) {
  const owner = await person(database, uid);
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}

type StoredShare = DocData & { keyWraps: Record<string, ShareKeyWrap>; projection: { kv: number }; manifest: ShareManifest; teamIds: string[]; expiresAt: Date };
const shareOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as StoredShare;
const termsOf = (database: MemoryDatabase, shareId: string) => readShareManifest(shareOf(database, shareId).manifest);
const keyVersion = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
const listed = async (backend: MemoryBackend, teamId: string) => (await keysOf(backend).openTeam(teamId)).roster.shares.map((s) => s.shareId);
const deviceOf = async (backend: MemoryBackend) => (await keysOf(backend).device()).deviceId;

/**
 * Alpha (Alice, its owner) shares a following auto with Partner (Olga) from Alice's phone, after
 * showing Partner's safety code. Ann is an editor of Alpha who never pinned Partner's key, and Bob an
 * editor whose device is later stolen.
 */
async function world(mode: "follow" | "pinned" = "follow") {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const ann = await join(database, a.owner, a.teamId, "ann");
  const bob = await join(database, a.owner, a.teamId, "bob");
  const shown = (await a.owner.checkPartnerKeys([p.teamId]))[0]!.keyId;
  const made = await a.owner.createShare({
    teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode, projection: '{"s":"one"}',
    expectedKeys: { [p.teamId]: shown },
  });
  await made.sent;
  let base = a.r1;
  /** A publish of the next revision by `by`, which a following share receives as `followProjection`. */
  const publish = async (by: MemoryBackend, followProjection: string) => {
    const r = await by.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: base, content: JSON.stringify({ s: followProjection }), followProjection });
    await r.sent;
    base = r.value.id;
    return r.value.id;
  };
  return { database, a, p, ann, bob, shareId: made.value.id, publish };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * A new manifest for `shareId` with `change` applied to its terms, signed with `kept`, a copy of the
 * team's newest key, by `thief`'s device. With `how` "sign" the thief signs the terms too and so is
 * named among their signers; with "carry" it keeps the honest terms signature and its signers.
 */
async function forgeTerms(
  database: MemoryDatabase,
  shareId: string,
  kept: OpenedTeam,
  thief: DeviceKeys,
  change: Partial<ShareManifestBody>,
  plain: DocData = {},
  how: "sign" | "carry" = "sign",
): Promise<ShareManifestBody> {
  const path = `shares/${shareId}`;
  const doc = shareOf(database, shareId);
  const old = readShareManifest(doc.manifest);
  const kv = kept.newest.key.version;
  const next: ShareManifestBody = { ...old, ...change, seq: old.seq + 1, okv: kv, device: thief.deviceId };
  if (how === "sign") {
    next.termsSeq = old.termsSeq + 1;
    next.termsDevices = [...old.termsDevices.filter((id) => id !== thief.deviceId), thief.deviceId];
  }
  const manifest = await signShareManifest({
    body: next,
    signingKey: kept.chain.get(kv)!.pair.signingKey,
    device: thief,
    ...(how === "carry" ? { terms: { tsig: doc.manifest.tsig, tkeys: doc.manifest.tkeys } } : {}),
  });
  database.seed(path, { ...doc, ...plain, manifest });
  return next;
}

/** A key pair of the server's own for `teamId` at version 1, and its "rotation" to version 2, signed from it. */
async function serverKeys(teamId: string) {
  const f1 = await createTeamKeys(teamId);
  const f2 = await rotateTeamKeys(teamId, { key: f1.key, pair: f1.pair });
  const digest1 = await teamKeyDigest({ teamId, v: 1, fingerprint: f1.pair.fingerprint, signSpki: f1.pair.signSpki });
  return { f1, f2, digest1 };
}
type ServerKeys = Awaited<ReturnType<typeof serverKeys>>;

/** Plays a server that shows `teamId` with its own key pairs: version 1's record swapped, and version 2 as the team's key. */
function showServerKeys(database: MemoryDatabase, teamId: string, keys: ServerKeys): void {
  const team = database.peek(`teams/${teamId}`) as DocData;
  database.seed(`teams/${teamId}`, { ...team, encKey: keys.f2.encKey });
  const path = `teams/${teamId}/teamKeys/1`;
  database.seed(path, { ...(database.peek(path) as DocData), pairSpki: keys.f1.record.pairSpki, signSpki: keys.f1.record.signSpki });
}

/** The partner's projection opened with `pair`, or null when the share's wrap for it does not open with it. */
async function openedWith(database: MemoryDatabase, shareId: string, teamId: string, autoId: string, pair: TeamKeyPair): Promise<string | null> {
  const share = shareOf(database, shareId);
  const kv = share.projection.kv;
  try {
    const key = await unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: kv, wrap: share.keyWraps[teamId]!, pair });
    return await openText(key, share.projection as never, aadFor.shareProjection({ shareId, autoId, kv }));
  } catch {
    return null;
  }
}

/** What the thief can read of the share with the team key it kept: the owner's wrap opened with it, or null. */
async function readByKeptKey(database: MemoryDatabase, shareId: string, autoId: string, kept: OpenedTeam): Promise<string | null> {
  const share = shareOf(database, shareId);
  const kv = share.projection.kv;
  const ownerWrap = share.ownerWrap as { kv: number };
  if (!kept.chain.has(ownerWrap.kv)) return null;
  try {
    const key = await unwrapShareKeyAsOwner({ shareId, teamId: kept.teamId, shareKeyVersion: kv, wrap: ownerWrap as never, teamKey: teamKeyAt(kept, ownerWrap.kv) });
    return await openText(key, share.projection as never, aadFor.shareProjection({ shareId, autoId, kv }));
  } catch {
    return null;
  }
}

/** Bob's stolen device: the team keys and the device keys the thief holds. */
async function steal(w: World) {
  return { kept: await keysOf(w.bob).openTeam(w.a.teamId), device: await keysOf(w.bob).device() };
}

describe("a forged change of an honest share's terms does not outlast the revocation", () => {
  it("drops a share whose partner key a thief swapped for the server's, though an honest publish signed it again, so the next re-key never wraps to the server", async () => {
    const w = await world();
    const thief = await steal(w);
    const server = await serverKeys(w.p.teamId);
    // Before the revocation the thief names the server's key for Partner, and signs the terms.
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { teams: [[w.p.teamId, 1, server.digest1]] });
    // Ann's ordinary publish signs the share again from an honest device; she never pinned Partner.
    await w.publish(w.ann, "two");
    const body = termsOf(w.database, w.shareId);
    expect(body.device).toBe(await deviceOf(w.ann));
    expect(body.termsDevices).toContain(thief.device.deviceId);
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    // The server now shows its own next key for Partner, signed from the one the forged terms name.
    showServerKeys(w.database, w.p.teamId, server);
    await w.publish(w.ann, "three, after the revocation");
    expect(await openedWith(w.database, w.shareId, w.p.teamId, w.a.autoId, server.f2.pair)).toBe(null);
    expect(await openedWith(w.database, w.shareId, w.p.teamId, w.a.autoId, server.f1.pair)).toBe(null);
    await expect(w.ann.updateShare(w.shareId, { revision: "000003-anything", projection: '{"s":"three"}' })).rejects.toThrow(SHARE_NOT_LISTED);
  }, 60_000);

  it("drops it when a member who has left makes the swap while the rotation waits", async () => {
    const w = await world();
    const mallory = await join(w.database, w.a.owner, w.a.teamId, "mallory");
    const kept = await keysOf(mallory).openTeam(w.a.teamId);
    const malloryDevice = await keysOf(mallory).device();
    await sent(mallory.leaveTeam(w.a.teamId));
    const server = await serverKeys(w.p.teamId);
    await forgeTerms(w.database, w.shareId, kept, malloryDevice, { teams: [[w.p.teamId, 1, server.digest1]] });
    // Nothing new is sealed under the key Mallory still holds while the rotation waits.
    await expect(w.publish(w.ann, "two")).rejects.toMatchObject({ code: "conflict" });
    await sent(w.a.owner.completeKeyRotation(w.a.teamId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    showServerKeys(w.database, w.p.teamId, server);
    await w.publish(w.ann, "three, after the rotation");
    expect(await openedWith(w.database, w.shareId, w.p.teamId, w.a.autoId, server.f2.pair)).toBe(null);
  }, 60_000);

  it("drops it though an honest extension signed the forged terms again before the revocation", async () => {
    const w = await world();
    const thief = await steal(w);
    const server = await serverKeys(w.p.teamId);
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { teams: [[w.p.teamId, 1, server.digest1]] });
    // Alice extends the share: a change of its terms, which she signs, on top of the forged ones.
    const until = new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + 7 * DAY_MS);
    await sent(w.a.owner.extendShare(w.shareId, until));
    const body = termsOf(w.database, w.shareId);
    expect(body.termsDevices.at(-1)).toBe(await deviceOf(w.a.owner));
    expect(body.termsDevices).toContain(thief.device.deviceId);
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    showServerKeys(w.database, w.p.teamId, server);
    await w.publish(w.ann, "three, after the revocation");
    expect(await openedWith(w.database, w.shareId, w.p.teamId, w.a.autoId, server.f2.pair)).toBe(null);
  }, 60_000);

  it("drops it though the server's own rotation made an honest publish re-key to it before the revocation", async () => {
    const w = await world();
    const thief = await steal(w);
    const server = await serverKeys(w.p.teamId);
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { teams: [[w.p.teamId, 1, server.digest1]] });
    // Before the revocation the server shows its next key, and Ann's publish re-keys to it: a change
    // of the share's terms, signed by her. The thief holds the team key, so this reveals nothing new.
    showServerKeys(w.database, w.p.teamId, server);
    await w.publish(w.ann, "two");
    expect(termsOf(w.database, w.shareId).termsDevices).toEqual([await deviceOf(w.a.owner), thief.device.deviceId, await deviceOf(w.ann)]);
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await w.publish(w.ann, "three, after the revocation");
    expect(await openedWith(w.database, w.shareId, w.p.teamId, w.a.autoId, server.f2.pair)).not.toBe("three, after the revocation");
    expect(await readByKeptKey(w.database, w.shareId, w.a.autoId, thief.kept)).not.toBe("three, after the revocation");
  }, 60_000);

  it("refuses at once a changed partner key that keeps the honest terms signature, and drops the share at the revocation", async () => {
    const w = await world();
    const thief = await steal(w);
    const server = await serverKeys(w.p.teamId);
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { teams: [[w.p.teamId, 1, server.digest1]] }, {}, "carry");
    // The terms signature no longer verifies over the terms, so no device opens or seals into it.
    await expect(w.a.owner.getShare(w.shareId, w.a.teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await expect(w.p.owner.getShare(w.shareId, w.p.teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    expect(await code(w.publish(w.ann, "two"))).toBe("tampered");
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
  }, 60_000);
});

describe("the same holds for every other term", () => {
  it("drops a share whose level a thief raised", async () => {
    const w = await world();
    const thief = await steal(w);
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { level: "propose" }, { level: "propose" });
    await w.publish(w.ann, "two");
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await expect(w.a.owner.setShareLevel(w.shareId, "view")).rejects.toThrow(SHARE_NOT_LISTED);
  }, 60_000);

  it("drops a share to which a thief added a team of the server's, so it gets nothing published after the revocation", async () => {
    const w = await world();
    const thief = await steal(w);
    const x = await teamWithAuto(w.database, "xena", 3333, "Xavier");
    const xKey = (w.database.peek(`teams/${x.teamId}`) as { encKey: TeamEncKey }).encKey;
    // The thief holds the team key, so it opens the share key and wraps it to Xavier too.
    const doc = shareOf(w.database, w.shareId);
    const shareKey = await unwrapShareKeyAsOwner({
      shareId: w.shareId, teamId: w.a.teamId, shareKeyVersion: doc.projection.kv, wrap: doc.ownerWrap as never, teamKey: teamKeyAt(thief.kept, (doc.ownerWrap as { kv: number }).kv), extractable: true,
    });
    const body = readShareManifest(doc.manifest);
    const teams = [...body.teams, [x.teamId, xKey.v, await teamKeyDigest({ teamId: x.teamId, ...xKey })] as const].sort(([l], [r]) => (l < r ? -1 : 1));
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { teams }, {
      teamIds: [...doc.teamIds, x.teamId],
      keyWraps: { ...doc.keyWraps, [x.teamId]: await wrapShareKeyToTeam({ shareId: w.shareId, teamId: x.teamId, shareKey, encKey: xKey }) },
    });
    w.database.seed(`teams/${x.teamId}/inbox/${w.shareId}`, { shareId: w.shareId, ownerTeamId: w.a.teamId, createdBy: "bob", createdAt: w.database.now() });
    await w.publish(w.ann, "two");
    expect((await x.owner.getShare(w.shareId, x.teamId))?.projection).toBe("two");
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await w.publish(w.ann, "three, after the revocation");
    expect((await x.owner.getShare(w.shareId, x.teamId))?.projection).not.toBe("three, after the revocation");
  }, 60_000);

  it("drops a pinned share a thief pointed at a revision the team never shared, though Alice extended it on top", async () => {
    const w = await world("pinned");
    const thief = await steal(w);
    const secret = await w.publish(w.a.owner, "two, never shared");
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { revisionId: secret }, { revision: secret });
    await sent(w.a.owner.extendShare(w.shareId, new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + DAY_MS)));
    expect(termsOf(w.database, w.shareId).device).toBe(await deviceOf(w.a.owner));
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await expect(w.a.owner.setShareLevel(w.shareId, "propose")).rejects.toThrow(SHARE_NOT_LISTED);
  }, 60_000);

  it("drops a share whose end a thief moved later", async () => {
    const w = await world();
    const thief = await steal(w);
    const later = new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + 300 * DAY_MS);
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { expiresAtMs: later.getTime() }, { expiresAt: later });
    await w.publish(w.ann, "two");
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await w.publish(w.ann, "three, after the revocation");
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe("two");
  }, 60_000);

  it("drops a revoked share a thief made live again, though a device that never saw the revocation sealed into it", async () => {
    const w = await world();
    const thief = await steal(w);
    await sent(w.a.owner.revokeShare(w.shareId));
    await forgeTerms(w.database, w.shareId, thief.kept, thief.device, { revoked: false }, { revokedAt: null });
    // Ann's device never saw the revocation, so it takes the share as live and seals into it.
    await w.publish(w.ann, "two");
    expect(termsOf(w.database, w.shareId).device).toBe(await deviceOf(w.ann));
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await w.publish(w.ann, "three, after the revocation");
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe("two");
  }, 60_000);
});

describe("a replayed older statement of the terms", () => {
  it("is refused by a device that saw the newer terms, though its manifest is one higher", async () => {
    const w = await world();
    const q = await teamWithAuto(w.database, "quinn", 3333, "Third");
    const shown = (await w.a.owner.checkPartnerKeys([q.teamId]))[0]!.keyId;
    await sent(w.a.owner.setShareTeams(w.shareId, [w.p.teamId, q.teamId], { expectedKeys: { [q.teamId]: shown } }));
    const withQuinn = shareOf(w.database, w.shareId);
    const old = readShareManifest(withQuinn.manifest);
    // Alice takes Third off the share, which re-keys it: new terms, one count higher. Partner opens it.
    await sent(w.a.owner.setShareTeams(w.shareId, [w.p.teamId]));
    const now = termsOf(w.database, w.shareId);
    expect(now.termsSeq).toBe(old.termsSeq + 1);
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe('{"s":"one"}');
    // The thief puts back the terms with Third on them, which Alice signed then, in a manifest one
    // higher for the share key of now, and wraps that key to Third again.
    const thief = await steal(w);
    const current = shareOf(w.database, w.shareId);
    const shareKey = await unwrapShareKeyAsOwner({
      shareId: w.shareId, teamId: w.a.teamId, shareKeyVersion: current.projection.kv, wrap: current.ownerWrap as never,
      teamKey: teamKeyAt(thief.kept, (current.ownerWrap as { kv: number }).kv), extractable: true,
    });
    const qKey = (w.database.peek(`teams/${q.teamId}`) as { encKey: TeamEncKey }).encKey;
    const kv = thief.kept.newest.key.version;
    const replay = await signShareManifest({
      body: { ...old, seq: now.seq + 1, okv: kv, device: thief.device.deviceId, skv: now.skv, wkv: now.wkv, commit: now.commit, ...(now.projection === undefined ? {} : { projection: now.projection }) },
      signingKey: thief.kept.chain.get(kv)!.pair.signingKey,
      device: thief.device,
      terms: { tsig: withQuinn.manifest.tsig, tkeys: withQuinn.manifest.tkeys },
    });
    w.database.seed(`shares/${w.shareId}`, {
      ...current,
      teamIds: withQuinn.teamIds,
      keyWraps: { ...current.keyWraps, [q.teamId]: await wrapShareKeyToTeam({ shareId: w.shareId, teamId: q.teamId, shareKey, encKey: qKey }) },
      manifest: replay,
    });
    await expect(w.a.owner.getShare(w.shareId, w.a.teamId)).rejects.toThrow(SHARE_TERMS_OLDER);
    await expect(w.a.owner.setShareLevel(w.shareId, "propose")).rejects.toThrow(SHARE_TERMS_OLDER);
    await expect(w.p.owner.getShare(w.shareId, w.p.teamId)).rejects.toThrow(SHARE_TERMS_OLDER);
    // Ann's device never saw the newer terms, so it takes these as current and publishes into them:
    // the limit every count pin has. Alice's device, which does the rotation, saw them, and so the
    // rotation leaves the share out.
    await w.publish(w.ann, "two");
    await sent(w.a.owner.revokeDevice(w.a.teamId, thief.device.deviceId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await w.publish(w.ann, "three, after the revocation");
    expect((await q.owner.getShare(w.shareId, q.teamId))?.projection).toBe("two");
  }, 60_000);

  it("is refused when it is taken from before the team key changed, whatever a device has seen", async () => {
    const w = await world();
    const before = shareOf(w.database, w.shareId);
    const old = readShareManifest(before.manifest);
    await join(w.database, w.a.owner, w.a.teamId, "mallory");
    await sent(w.a.owner.removeMember(w.a.teamId, "mallory"));
    await w.publish(w.ann, "two");
    const now = termsOf(w.database, w.shareId);
    expect(now.okv).toBe(old.okv + 1);
    // Bob, still a member, splices the old terms signature into a manifest at the new key.
    const thief = await steal(w);
    const kv = thief.kept.newest.key.version;
    const replay = await signShareManifest({
      body: { ...old, seq: now.seq + 1, okv: kv, device: thief.device.deviceId, commit: now.commit, skv: now.skv, wkv: now.wkv, ...(now.projection === undefined ? {} : { projection: now.projection }) },
      signingKey: thief.kept.chain.get(kv)!.pair.signingKey,
      device: thief.device,
      terms: { tsig: before.manifest.tsig, tkeys: before.manifest.tkeys },
    });
    w.database.seed(`shares/${w.shareId}`, { ...shareOf(w.database, w.shareId), manifest: replay });
    // Alice's new laptop has seen nothing of the share, and still refuses it: the terms signature is
    // over the key version the terms were signed at, which is not the one that signs this manifest.
    const laptop = await secondDevice(w.database, w.a.owner, "alice", w.a.teamId);
    await expect(laptop.getShare(w.shareId, w.a.teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await expect(w.p.owner.getShare(w.shareId, w.p.teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
  }, 60_000);
});

describe("honest changes of a share's terms survive a rotation that keeps the device that made them", () => {
  /** Removing Bob rotates Alpha's key; each test then checks the share is listed and gets the next publish. */
  async function rotateAndCheck(w: World, publisher: MemoryBackend = w.ann) {
    const before = keyVersion(w.database, w.a.teamId);
    await sent(w.a.owner.removeMember(w.a.teamId, "bob"));
    expect(keyVersion(w.database, w.a.teamId)).toBe(before + 1);
    expect(await listed(w.a.owner, w.a.teamId)).toContain(w.shareId);
    await w.publish(publisher, "after the rotation");
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe("after the rotation");
  }

  it("names the device that made a share as the one that signed its terms, once", async () => {
    const w = await world();
    const body = termsOf(w.database, w.shareId);
    expect(body).toMatchObject({ seq: 1, termsSeq: 1, termsDevices: [await deviceOf(w.a.owner)] });
  }, 60_000);

  it("carries the terms signature unchanged through a follow publish from another member", async () => {
    const w = await world();
    const before = shareOf(w.database, w.shareId).manifest;
    await w.publish(w.ann, "two");
    const after = shareOf(w.database, w.shareId).manifest;
    expect(readShareManifest(after)).toMatchObject({ device: await deviceOf(w.ann), seq: 2, termsSeq: 1, termsDevices: [await deviceOf(w.a.owner)] });
    expect(Array.from(after.tsig)).toEqual(Array.from(before.tsig));
    expect(Array.from(after.tkeys)).toEqual(Array.from(before.tkeys));
    await rotateAndCheck(w);
  }, 60_000);

  it("keeps a share an admin extended", async () => {
    const w = await world();
    const admin = await join(w.database, w.a.owner, w.a.teamId, "adam", "admin");
    await sent(admin.extendShare(w.shareId, new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + DAY_MS)));
    expect(termsOf(w.database, w.shareId)).toMatchObject({ termsSeq: 2, termsDevices: [await deviceOf(w.a.owner), await deviceOf(admin)] });
    await rotateAndCheck(w);
  }, 60_000);

  it("keeps a share whose level changed", async () => {
    const w = await world();
    await sent(w.a.owner.setShareLevel(w.shareId, "propose"));
    expect(termsOf(w.database, w.shareId)).toMatchObject({ level: "propose", termsSeq: 2, termsDevices: [await deviceOf(w.a.owner)] });
    await rotateAndCheck(w);
  }, 60_000);

  it("keeps a share with a team added and then taken off", async () => {
    const w = await world();
    const admin = await join(w.database, w.a.owner, w.a.teamId, "adam", "admin");
    const q = await teamWithAuto(w.database, "quinn", 3333, "Third");
    const shown = (await admin.checkPartnerKeys([q.teamId]))[0]!.keyId;
    await sent(admin.setShareTeams(w.shareId, [w.p.teamId, q.teamId], { expectedKeys: { [q.teamId]: shown } }));
    await sent(w.a.owner.setShareTeams(w.shareId, [w.p.teamId]));
    expect(termsOf(w.database, w.shareId)).toMatchObject({ termsSeq: 3, termsDevices: [await deviceOf(admin), await deviceOf(w.a.owner)] });
    await rotateAndCheck(w);
  }, 60_000);

  it("keeps a share re-keyed to the partner's honest rotation by a member who never pinned it", async () => {
    const w = await world();
    await join(w.database, w.p.owner, w.p.teamId, "pete");
    await sent(w.p.owner.removeMember(w.p.teamId, "pete"));
    await w.publish(w.ann, "two");
    const body = termsOf(w.database, w.shareId);
    expect(body.teams[0]?.[1]).toBe(2);
    expect(body).toMatchObject({ termsSeq: 2, termsDevices: [await deviceOf(w.a.owner), await deviceOf(w.ann)] });
    await rotateAndCheck(w);
  }, 60_000);

  it("keeps a share made on the maker's second device, which the rotation keeps", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, "alice", w.a.teamId);
    const shown = (await laptop.checkPartnerKeys([w.p.teamId]))[0]!.keyId;
    const made = await laptop.createShare({
      teamId: w.a.teamId, autoId: w.a.autoId, revision: w.a.r1, audience: "teams", teamIds: [w.p.teamId], mode: "follow", projection: '{"s":"one"}',
      expectedKeys: { [w.p.teamId]: shown },
    });
    await made.sent;
    await sent(laptop.setShareLevel(made.value.id, "propose"));
    await sent(w.a.owner.removeMember(w.a.teamId, "bob"));
    expect(await listed(w.a.owner, w.a.teamId)).toContain(made.value.id);
    await w.publish(laptop, "after the rotation");
    expect((await w.p.owner.getShare(made.value.id, w.p.teamId))?.projection).toBe("after the rotation");
  }, 60_000);

  it("keeps a link share whose end changed", async () => {
    const w = await world();
    const made = await w.a.owner.createShare({ teamId: w.a.teamId, autoId: w.a.autoId, revision: w.a.r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    const laptop = await secondDevice(w.database, w.a.owner, "alice", w.a.teamId);
    await sent(laptop.extendShare(made.value.id, new Date(shareOf(w.database, made.value.id).expiresAt.getTime() + DAY_MS)));
    expect(termsOf(w.database, made.value.id).termsDevices).toEqual([await deviceOf(w.a.owner), await deviceOf(laptop)]);
    await sent(w.a.owner.removeMember(w.a.teamId, "bob"));
    expect(await listed(w.a.owner, w.a.teamId)).toContain(made.value.id);
    await w.publish(w.ann, "after the rotation");
    const stranger = new MemoryBackend({ database: w.database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    expect((await stranger.openLinkShare(made.value.linkSecret!))?.projection).toBe("after the rotation");
  }, 60_000);

  it("signs the terms again at the first write after a rotation, so a device that changed them before it may later go", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, "alice", w.a.teamId);
    const laptopId = await deviceOf(laptop);
    await sent(laptop.extendShare(w.shareId, new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + DAY_MS)));
    const before = termsOf(w.database, w.shareId);
    await sent(w.a.owner.removeMember(w.a.teamId, "bob"));
    // The first manifest at the new key is the one the rotating device writes when it carries the
    // share forward: signed at the new key, by that device alone, terms and all.
    expect(await listed(w.a.owner, w.a.teamId)).toContain(w.shareId);
    expect(termsOf(w.database, w.shareId)).toMatchObject({ okv: before.okv + 1, termsSeq: before.termsSeq + 1, termsDevices: [await deviceOf(w.a.owner)] });
    await w.publish(w.ann, "two");
    await sent(w.a.owner.revokeDevice(w.a.teamId, laptopId));
    expect(await listed(w.a.owner, w.a.teamId)).toContain(w.shareId);
    await w.publish(w.ann, "after the revocation");
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe("after the revocation");
  }, 60_000);

  it("stops a share whose terms a device then dropped changed at the key being replaced, and says why", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, "alice", w.a.teamId);
    const laptopId = await deviceOf(laptop);
    await sent(laptop.extendShare(w.shareId, new Date(shareOf(w.database, w.shareId).expiresAt.getTime() + DAY_MS)));
    await w.publish(w.ann, "two");
    expect(termsOf(w.database, w.shareId).termsDevices).toContain(laptopId);
    await sent(w.a.owner.revokeDevice(w.a.teamId, laptopId));
    expect(await listed(w.a.owner, w.a.teamId)).not.toContain(w.shareId);
    await expect(w.a.owner.setShareLevel(w.shareId, "propose")).rejects.toThrow(SHARE_NOT_LISTED);
    await w.publish(w.ann, "three");
    expect((await w.p.owner.getShare(w.shareId, w.p.teamId))?.projection).toBe("two");
  }, 60_000);

  it(`refuses a change of terms on a ${String(MAX_TERMS_DEVICES + 1)}th device at one key, lets one already named make it, and never refuses a revocation`, { timeout: 60_000 }, async () => {
    const w = await world();
    const admins: MemoryBackend[] = [];
    for (let i = 1; i <= MAX_TERMS_DEVICES; i++) admins.push(await join(w.database, w.a.owner, w.a.teamId, `admin${String(i)}`, "admin"));
    let end = shareOf(w.database, w.shareId).expiresAt.getTime();
    for (const admin of admins.slice(0, MAX_TERMS_DEVICES - 1)) await sent(admin.extendShare(w.shareId, new Date((end += DAY_MS))));
    expect(termsOf(w.database, w.shareId).termsDevices).toHaveLength(MAX_TERMS_DEVICES);
    await expect(admins[MAX_TERMS_DEVICES - 1]!.extendShare(w.shareId, new Date((end += DAY_MS)))).rejects.toThrow(SHARE_TERMS_SIGNERS_FULL);
    await sent(w.a.owner.extendShare(w.shareId, new Date(end)));
    expect(termsOf(w.database, w.shareId).termsDevices.at(-1)).toBe(await deviceOf(w.a.owner));
    // A revocation is never refused for it: nothing is sealed into a revoked share again, so the
    // device that revokes it is named alone.
    await sent(admins[MAX_TERMS_DEVICES - 1]!.revokeShare(w.shareId));
    expect(termsOf(w.database, w.shareId)).toMatchObject({ revoked: true, termsDevices: [await deviceOf(admins[MAX_TERMS_DEVICES - 1]!)] });
  });
});
