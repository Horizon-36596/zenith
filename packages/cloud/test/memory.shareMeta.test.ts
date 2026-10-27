/**
 * A share's terms, as the owner team signs them. The plain fields of a share document (its auto,
 * its mode, its level, whether it is revoked) are the server's to write, and a device that seals a
 * projection into a share on the strength of them seals what the server chose. Every share now
 * carries a manifest the owner team signed, naming its auto, audience, mode, level, revocation and a
 * sequence number, and the device that rotates the team's key lists the team's live shares, each by
 * the digest of its manifest, in the next device roster. These tests are a server that rewrites a
 * share's terms or makes one up, alone and with a member taken off the team who kept the key she
 * held; each worked before the terms were signed. The last ones check that honest shares, made
 * before a rotation or by their link, keep working.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  commitLinkKey,
  commitShareKey,
  decodeShareManifestBody,
  deriveLinkId,
  deriveLinkKey,
  linkSecretToText,
  MemoryDeviceKeyStore,
  newShareKey,
  sealText,
  shareManifestDigest,
  shareProjectionDigest,
  signShareManifest,
  teamKeyDigest,
  wrapLinkSecretForOwner,
  wrapShareKeyForOwner,
  wrapShareKeyToTeam,
  type Envelope,
  type ShareManifest,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { SHARE_MANIFEST_OLDER, SHARE_NOT_LISTED, SHARE_TERMS_CHANGED, SHARE_WITHOUT_MANIFEST } from "../src/client.js";
import { isCloudError } from "../src/errors.js";
import { teamKeyAt, type KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

const DAY_MS = 86_400_000;

async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
async function grant(approver: MemoryBackend, device: MemoryBackend, teamId: string): Promise<void> {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  await (await approver.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  await device.listAutos(teamId);
}
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string): Promise<MemoryBackend> {
  const member = await person(database, uid);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  await grant(approver, member, teamId);
  return member;
}
async function teamWithAuto(database: MemoryDatabase, uid: string, number: number, name: string) {
  const owner = await person(database, uid);
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: `{"secret":"${name} one"}` });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}
/** A second auto of the team, never shared with anyone, published once. */
async function unsharedAuto(owner: MemoryBackend, teamId: string) {
  const auto = await owner.createAuto(teamId, { title: "far-side 7-ball" });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"X one"}' });
  await r1.sent;
  return { autoId: auto.value.id, r1: r1.value.id };
}
async function publish(owner: MemoryBackend, teamId: string, autoId: string, baseRevision: string, text: string): Promise<string> {
  const published = await owner.publishRevision({ teamId, autoId, baseRevision, content: `{"secret":"${text}"}`, followProjection: `{"secret":"${text}, projected"}` });
  await published.sent;
  return published.value.id;
}
const keyVersion = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
const rawDoc = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as Record<string, unknown>;
const termsOf = (database: MemoryDatabase, shareId: string) => decodeShareManifestBody((rawDoc(database, shareId).manifest as ShareManifest).body);

/** The error `run` throws, or null when it resolves. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
const isTampered = (error: unknown, message?: string): boolean => isCloudError(error, "tampered") && (message === undefined || error.message === message);

/** What a device reads of a share, or the error that stops it, as a word the tests compare. */
async function readOf(run: () => Promise<{ projection: string } | null>): Promise<string> {
  try {
    const share = await run();
    return share === null ? "nothing" : share.projection;
  } catch (error) {
    return isCloudError(error) ? `refused: ${error.code}` : `failed: ${String(error)}`;
  }
}

/** Team Alpha, a member Mallory it takes off after she kept the key she held, and an auto made after. */
async function withRemovedMember() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const alice = await person(database, "alice");
  const created = await alice.createTeam({ number: 1111, name: "Alpha" });
  await created.sent;
  const teamId = created.value.id;
  const mallory = await join(database, alice, teamId, "mallory");
  const kept = await keysOf(mallory).openTeam(teamId);
  const oldKv = kept.newest.key.version;
  await (await alice.removeMember(teamId, "mallory")).sent;
  expect(keyVersion(database, teamId)).toBe(oldKv + 1);
  const auto = await alice.createAuto(teamId, { title: "made after removal" });
  await auto.sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"secret":"one"}' });
  await r1.sent;
  return { database, alice, mallory, teamId, kept, oldKv, autoId: auto.value.id, r1: r1.value.id };
}

/** The plain fields of a following view share that Mallory, not Alpha, writes. */
const madeUpTerms = (ownerTeamId: string, autoId: string, revision: string) => ({
  ownerTeamId,
  autoId,
  level: "view",
  mode: "follow",
  revision,
  expiresAt: new Date(Date.now() + 30 * DAY_MS),
  revokedAt: null,
  createdBy: "mallory",
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** Mallory's made-up link share of `autoId`, its secret sealed under the key she kept; with a manifest signed with it when `signed`. */
async function madeUpLinkShare(s: Awaited<ReturnType<typeof withRemovedMember>>, signed: boolean): Promise<{ shareId: string; secret: Uint8Array }> {
  const device = await keysOf(s.mallory).device();
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const shareId = await deriveLinkId(secret);
  const linkKey = await deriveLinkKey(secret);
  const oldVersion = s.kept.chain.get(s.oldKv);
  if (oldVersion === undefined) throw new Error("Mallory kept no key.");
  const terms = madeUpTerms(s.teamId, s.autoId, s.r1);
  const doc: Record<string, unknown> = {
    ...terms,
    audience: "link",
    teamIds: [],
    projection: await sealText(linkKey, '{"v":"placeholder"}', aadFor.shareProjection({ shareId, autoId: s.autoId, kv: linkKey.version })),
    linkWrap: await wrapLinkSecretForOwner({ shareId, teamId: s.teamId, autoId: s.autoId, secret, teamKey: teamKeyAt(s.kept, s.oldKv) }),
  };
  if (signed) {
    doc.manifest = await signShareManifest({
      body: {
        shareId,
        ownerTeamId: s.teamId,
        autoId: s.autoId,
        revisionId: s.r1,
        audience: "link",
        mode: "follow",
        level: "view",
        revoked: false,
        expiresAtMs: terms.expiresAt.getTime(),
        seq: 1,
        skv: 1,
        wkv: s.oldKv,
        okv: s.oldKv,
        device: device.deviceId,
        termsSeq: 1,
        termsDevices: [device.deviceId],
        choice: null,
        projection: await shareProjectionDigest({ shareId, projection: doc.projection as Envelope }),
        teams: [],
        commit: await commitLinkKey({ shareId, secret }),
      },
      signingKey: oldVersion.pair.signingKey,
      device,
    });
  }
  s.database.seed(`shares/${shareId}`, doc);
  return { shareId, secret };
}

describe("a share the server makes up with a member taken off the team", () => {
  it("refuses a publish when a made-up link share of the auto has no manifest, so the removed member reads nothing new", async () => {
    const s = await withRemovedMember();
    const { secret } = await madeUpLinkShare(s, false);
    const refused = await failure(() => s.alice.publishRevision({ teamId: s.teamId, autoId: s.autoId, baseRevision: s.r1, content: '{"secret":"two"}', followProjection: '{"secret":"two, projected"}' }));
    expect(isTampered(refused, SHARE_WITHOUT_MANIFEST)).toBe(true);
    expect(await readOf(() => s.mallory.openLinkShare(linkSecretToText(secret)))).toBe('{"v":"placeholder"}');
  });

  it("skips a made-up link share signed with the key the removed member kept, publishes the rest, and does not list it as the team's", async () => {
    const s = await withRemovedMember();
    const { shareId, secret } = await madeUpLinkShare(s, true);
    const r2 = await publish(s.alice, s.teamId, s.autoId, s.r1, "two");
    expect(r2).not.toBe(s.r1);
    expect(await readOf(() => s.mallory.openLinkShare(linkSecretToText(secret)))).toBe('{"v":"placeholder"}');
    expect((await s.alice.listTeamShares(s.teamId)).map((share) => share.id)).not.toContain(shareId);
    // Every other change the owner team makes to it is refused with the same sentence.
    for (const change of [() => s.alice.setShareMode(shareId, "pinned"), () => s.alice.revokeShare(shareId), () => s.alice.updateShare(shareId, { revision: r2, projection: '{"v":"three"}' })]) {
      expect(isTampered(await failure(change), SHARE_NOT_LISTED)).toBe(true);
    }
  });

  it("neither re-keys nor wraps to her own team a made-up share signed with the signing key she kept, and does not list it as the team's", async () => {
    const s = await withRemovedMember();
    const evil = await s.mallory.createTeam({ number: 6666, name: "Evil" });
    await evil.sent;
    const evilId = evil.value.id;
    const evilEnc = (s.database.peek(`teams/${evilId}`) as { encKey: TeamEncKey }).encKey;
    const shareId = "madeUpShareToEvil00000";
    const shareKey = await newShareKey(1);
    const oldVersion = s.kept.chain.get(s.oldKv);
    if (oldVersion === undefined) throw new Error("Mallory kept no key.");
    const wrap = await wrapShareKeyToTeam({ shareId, teamId: evilId, shareKey, encKey: evilEnc });
    const terms = madeUpTerms(s.teamId, s.autoId, s.r1);
    const device = await keysOf(s.mallory).device();
    const projection = await sealText(shareKey, '{"v":"placeholder"}', aadFor.shareProjection({ shareId, autoId: s.autoId, kv: 1 }));
    const manifest = await signShareManifest({
      body: {
        shareId,
        ownerTeamId: s.teamId,
        autoId: s.autoId,
        revisionId: s.r1,
        audience: "teams",
        mode: "follow",
        level: "view",
        revoked: false,
        expiresAtMs: terms.expiresAt.getTime(),
        seq: 1,
        skv: 1,
        wkv: s.oldKv,
        okv: s.oldKv,
        device: device.deviceId,
        termsSeq: 1,
        termsDevices: [device.deviceId],
        choice: null,
        projection: await shareProjectionDigest({ shareId, projection }),
        teams: [[evilId, wrap.ekv, await teamKeyDigest({ teamId: evilId, ...evilEnc })]],
        commit: await commitShareKey({ shareId, shareKey }),
      },
      signingKey: oldVersion.pair.signingKey,
      device,
    });
    s.database.seed(`shares/${shareId}`, {
      ...terms,
      audience: "teams",
      teamIds: [evilId],
      projection,
      keyWraps: { [evilId]: wrap },
      ownerWrap: await wrapShareKeyForOwner({ shareId, teamId: s.teamId, shareKey, teamKey: oldVersion.key }),
      manifest,
    });
    s.database.seed(`teams/${evilId}/inbox/${shareId}`, { shareId, ownerTeamId: s.teamId, createdBy: "mallory", createdAt: new Date() });

    const r2 = await publish(s.alice, s.teamId, s.autoId, s.r1, "two");
    expect(rawDoc(s.database, shareId).manifest).toEqual(manifest);
    expect(await readOf(() => s.mallory.getShare(shareId, evilId))).toBe('{"v":"placeholder"}');
    // The web app's follow-latest hook moves each share with updateShare, one at a time.
    expect(isTampered(await failure(() => s.alice.updateShare(shareId, { revision: r2, projection: '{"secret":"three"}' })), SHARE_NOT_LISTED)).toBe(true);
    expect(await readOf(() => s.mallory.getShare(shareId, evilId))).toBe('{"v":"placeholder"}');
    expect((await s.alice.listTeamShares(s.teamId)).map((share) => share.id)).not.toContain(shareId);
  });
});

describe("a share's terms the server rewrites", () => {
  it("refuses a publish into a pinned share of one auto that the server points at an auto never shared and makes follow", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const x = await unsharedAuto(a.owner, a.teamId);
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "pinned", projection: '{"v":"Y projection"}' });
    await share.sent;
    database.seed(`shares/${share.value.id}`, { ...rawDoc(database, share.value.id), autoId: x.autoId, mode: "follow" });
    const refused = await failure(() => publish(a.owner, a.teamId, x.autoId, x.r1, "X two"));
    expect(isTampered(refused, SHARE_TERMS_CHANGED)).toBe(true);
    expect(await readOf(() => p.owner.getShare(share.value.id))).toBe("refused: tampered");
    // Put back as it was, the share shows what it always did.
    database.seed(`shares/${share.value.id}`, { ...rawDoc(database, share.value.id), autoId: a.autoId, mode: "pinned" });
    expect(await readOf(() => p.owner.getShare(share.value.id))).toBe('{"v":"Y projection"}');
  });

  it("refuses a pinned share the server makes follow, though it is still of the auto published", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "pinned", projection: '{"v":"one"}' });
    await share.sent;
    database.seed(`shares/${share.value.id}`, { ...rawDoc(database, share.value.id), mode: "follow" });
    expect(isTampered(await failure(() => publish(a.owner, a.teamId, a.autoId, a.r1, "two")), SHARE_TERMS_CHANGED)).toBe(true);
  });

  it("refuses a view share the server raises to propose, for the owner team and the partner, and takes no proposal on it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "view", mode: "follow", projection: '{"v":"view"}' });
    await share.sent;
    database.seed(`shares/${share.value.id}`, { ...rawDoc(database, share.value.id), level: "propose" });
    expect(isTampered(await failure(() => a.owner.getShare(share.value.id)), SHARE_TERMS_CHANGED)).toBe(true);
    expect(isTampered(await failure(() => p.owner.getShare(share.value.id)), SHARE_TERMS_CHANGED)).toBe(true);
    expect(isTampered(await failure(() => a.owner.updateShare(share.value.id, { revision: a.r1, projection: '{"v":"propose, fuller"}' })), SHARE_TERMS_CHANGED)).toBe(true);
    const proposal = await failure(() => p.owner.sendProposal({ shareId: share.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"v":"a change"}' }));
    expect(proposal).not.toBeNull();
    expect(database.paths().filter((path) => path.startsWith("proposals/"))).toEqual([]);
  });

  it("refuses a revoked share the server un-revokes, by clearing its end or by putting back its manifest from before", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"before"}' });
    await share.sent;
    const before = rawDoc(database, share.value.id);
    await (await a.owner.revokeShare(share.value.id)).sent;
    const revoked = rawDoc(database, share.value.id);
    expect(termsOf(database, share.value.id)).toMatchObject({ revoked: true, seq: 2 });

    database.seed(`shares/${share.value.id}`, { ...revoked, revokedAt: null });
    expect(isTampered(await failure(() => publish(a.owner, a.teamId, a.autoId, a.r1, "after revoke")), SHARE_TERMS_CHANGED)).toBe(true);

    database.seed(`shares/${share.value.id}`, before);
    expect(isTampered(await failure(() => publish(a.owner, a.teamId, a.autoId, a.r1, "after revoke")), SHARE_MANIFEST_OLDER)).toBe(true);
    expect(await readOf(() => p.owner.getShare(share.value.id))).toBe('{"v":"before"}');
  });

  it("seals nothing into a share revoked on one device and put back, on the owner's other device, once a rotation has listed the team's shares", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const laptop = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    laptop.signInAs("alice");
    await (await laptop.requestTeamKey(a.teamId)).sent;
    await grant(a.owner, laptop, a.teamId);
    await join(database, a.owner, a.teamId, "bob");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"before"}' });
    await share.sent;
    const before = rawDoc(database, share.value.id);
    await (await a.owner.revokeShare(share.value.id)).sent;
    // The server puts the share back as it was before the revoke; the laptop never saw the revoke.
    database.seed(`shares/${share.value.id}`, before);
    // The first device takes Bob off, and so lists the team's live shares: not this one.
    await (await a.owner.removeMember(a.teamId, "bob")).sent;
    const roster = (await keysOf(a.owner).openTeam(a.teamId)).roster;
    expect(roster.shares.map((entry) => entry.shareId)).not.toContain(share.value.id);
    // The laptop publishes: the share it cannot vouch for is skipped, and gets nothing new.
    await laptop.listAutos(a.teamId);
    await publish(laptop, a.teamId, a.autoId, a.r1, "after revoke");
    expect(await readOf(() => p.owner.getShare(share.value.id))).toBe('{"v":"before"}');
  });

  it("gives a stranger with the link nothing of another auto when the server points the link share at it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const link = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "link", mode: "pinned", projection: '{"v":"public teaser"}' });
    await link.sent;
    const secret = link.value.linkSecret as string;
    const x = await unsharedAuto(a.owner, a.teamId);
    database.seed(`shares/${link.value.id}`, { ...rawDoc(database, link.value.id), autoId: x.autoId, mode: "follow" });
    expect(isTampered(await failure(() => publish(a.owner, a.teamId, x.autoId, x.r1, "X two")), SHARE_TERMS_CHANGED)).toBe(true);
    const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    expect(await readOf(() => stranger.openLinkShare(secret))).toBe("refused: tampered");
  });
});

describe("honest shares under signed terms", () => {
  it("signs a new manifest at every step of a share's life, from its making through a rotation, and seals nothing into it once revoked", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Quebec");
    await join(database, a.owner, a.teamId, "bob");
    const made = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"one"}' });
    await made.sent;
    const kept = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"one"}' });
    await kept.sent;
    const id = made.value.id;
    expect(termsOf(database, id)).toMatchObject({ autoId: a.autoId, audience: "teams", mode: "follow", level: "view", revoked: false, seq: 1 });

    const r2 = await publish(a.owner, a.teamId, a.autoId, a.r1, "two");
    expect(await readOf(() => p.owner.getShare(id))).toBe('{"secret":"two, projected"}');
    // The publish signs the revision it moved the share to.
    expect(termsOf(database, id)).toMatchObject({ revisionId: r2, seq: 2 });

    await (await a.owner.setShareLevel(id, "propose")).sent;
    expect(termsOf(database, id)).toMatchObject({ level: "propose", seq: 3 });
    expect((await p.owner.getShare(id))?.level).toBe("propose");

    await (await a.owner.setShareTeams(id, [p.teamId, q.teamId])).sent;
    expect(termsOf(database, id)).toMatchObject({ seq: 4 });
    expect(termsOf(database, id).teams.map(([teamId]) => teamId).sort()).toEqual([p.teamId, q.teamId].sort());
    expect(await readOf(() => q.owner.getShare(id))).toBe('{"secret":"two, projected"}');

    await (await a.owner.revokeShare(id)).sent;
    expect(termsOf(database, id)).toMatchObject({ revoked: true, seq: 5 });

    const before = keyVersion(database, a.teamId);
    await (await a.owner.removeMember(a.teamId, "bob")).sent;
    expect(keyVersion(database, a.teamId)).toBe(before + 1);
    const listed = (await keysOf(a.owner).openTeam(a.teamId)).roster.shares.map((entry) => entry.shareId);
    expect(listed).toEqual([kept.value.id]);

    const revokedProjection = rawDoc(database, id).projection;
    await publish(a.owner, a.teamId, a.autoId, r2, "three");
    expect(await readOf(() => p.owner.getShare(kept.value.id))).toBe('{"secret":"three, projected"}');
    // The rotation carried the live share forward past Bob, re-keyed and signed with the newest key,
    // and the publish signed it again; the revoked share was not carried.
    expect(termsOf(database, kept.value.id)).toMatchObject({ okv: before + 1, wkv: before + 1, seq: 4 });
    expect(rawDoc(database, id).projection).toEqual(revokedProjection);
  });

  it("keeps a share made before a rotation working, because each rotation lists it by the digest of its manifest", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "pinned", projection: '{"v":"one"}' });
    await share.sent;
    const id = share.value.id;
    /** Removes `uid`, and checks that the rotation listed the share by the digest of its manifest then. */
    const removeListing = async (uid: string): Promise<void> => {
      const digest = await shareManifestDigest(rawDoc(database, id).manifest as ShareManifest);
      await (await a.owner.removeMember(a.teamId, uid)).sent;
      const opened = await keysOf(a.owner).openTeam(a.teamId);
      expect(opened.roster.shares.find((listed) => listed.shareId === id)?.digest).toEqual(digest);
    };

    await join(database, a.owner, a.teamId, "bob");
    await removeListing("bob");
    // Listed, and so carried forward to the newest key: it opens, and a change of mode signs it again.
    expect(termsOf(database, id)).toMatchObject({ okv: keyVersion(database, a.teamId), seq: 2 });
    expect((await a.owner.listTeamShares(a.teamId)).map((listed) => listed.id)).toContain(id);
    await (await a.owner.setShareMode(id, "follow")).sent;
    expect(termsOf(database, id)).toMatchObject({ mode: "follow", okv: keyVersion(database, a.teamId), seq: 3 });

    await join(database, a.owner, a.teamId, "carol");
    await removeListing("carol");
    await publish(a.owner, a.teamId, a.autoId, a.r1, "two");
    expect(await readOf(() => p.owner.getShare(id))).toBe('{"secret":"two, projected"}');
  });

  it("keeps a link share working through a rotation and a change of mode", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const link = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "link", mode: "pinned", projection: '{"v":"teaser"}' });
    await link.sent;
    const secret = link.value.linkSecret as string;
    expect(termsOf(database, link.value.id)).toMatchObject({ audience: "link", teams: [], level: "view", seq: 1 });
    await join(database, a.owner, a.teamId, "bob");
    await (await a.owner.removeMember(a.teamId, "bob")).sent;
    expect((await keysOf(a.owner).openTeam(a.teamId)).roster.shares.map((entry) => entry.shareId)).toContain(link.value.id);
    await (await a.owner.setShareMode(link.value.id, "follow")).sent;
    await publish(a.owner, a.teamId, a.autoId, a.r1, "two");
    const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    expect(await readOf(() => stranger.openLinkShare(secret))).toBe('{"secret":"two, projected"}');
    expect((await a.owner.getShare(link.value.id))?.linkSecret).toBe(secret);
  });

  it("gives the sharer's choices back to the team that made the share only, and refuses choices swapped from another share", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const make = async (ownerChoice: string) => {
      const made = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"one"}', ownerChoice });
      await made.sent;
      return made.value.id;
    };
    const fine = await make('{"coarsen":false}');
    const coarse = await make('{"coarsen":true}');
    expect((await a.owner.getShare(fine))?.ownerChoice).toBe('{"coarsen":false}');
    expect((await a.owner.listTeamShares(a.teamId)).map((share) => share.ownerChoice).sort()).toEqual(['{"coarsen":false}', '{"coarsen":true}']);
    expect((await p.owner.getShare(fine))?.ownerChoice).toBeUndefined();
    expect(JSON.stringify(await p.owner.listReceivedShares(p.teamId))).not.toContain("coarsen");
    // The server moves the coarse share's sealed choices onto the fine one.
    database.seed(`shares/${coarse}`, { ...rawDoc(database, coarse), ownerChoice: rawDoc(database, fine).ownerChoice });
    expect(isTampered(await failure(() => a.owner.getShare(coarse)))).toBe(true);
  });

  it("takes the sharer's choices by their size once sealed, so a title written as escapes fits and choices that do not compress are refused", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const make = async (ownerChoice: string) => {
      const made = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"one"}', ownerChoice });
      await made.sent;
      return made.value.id;
    };
    const escaped = JSON.stringify({ coarsen: true, includeCommands: false, title: "\u0001".repeat(200) });
    expect(new TextEncoder().encode(escaped).byteLength).toBeGreaterThan(1024);
    expect((await a.owner.getShare(await make(escaped)))?.ownerChoice).toBe(escaped);
    const noise = Array.from(crypto.getRandomValues(new Uint8Array(1200)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const refused = await failure(() => make(noise));
    expect(isCloudError(refused, "invalid")).toBe(true);
    expect(String(refused)).toContain("The choices made for this share");
  });

  it("refuses a share a rotation did not list, with a sentence that says how to share again, and publishes the rest", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    // The server hides the share from the device that rotates, then shows it again.
    const hidden = rawDoc(database, share.value.id);
    database.seed(`shares/${share.value.id}`, { ...hidden, ownerTeamId: p.teamId });
    await join(database, a.owner, a.teamId, "bob");
    await (await a.owner.removeMember(a.teamId, "bob")).sent;
    database.seed(`shares/${share.value.id}`, hidden);
    const refused = await failure(() => a.owner.setShareLevel(share.value.id, "propose"));
    expect(isTampered(refused, SHARE_NOT_LISTED)).toBe(true);
    expect(SHARE_NOT_LISTED).toContain("make a new share of the auto for the same teams");
    await publish(a.owner, a.teamId, a.autoId, a.r1, "two");
    expect(await readOf(() => p.owner.getShare(share.value.id))).toBe('{"v":"one"}');
  });
});
