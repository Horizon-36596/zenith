/**
 * Which device signed a share. Anyone who holds team key n can sign a manifest at version n: a
 * member who has left while the rotation that cuts her waits, or a thief with a stolen device. The
 * rotation that takes key n from them used to list every live share signed at n in the next roster,
 * so a share they forged then received every later publish. The manifest now names the device that
 * signed it and carries that device's signature, and a rotation lists a share only when the device
 * that signed it is one the new roster keeps. These tests are that thief and that member, with the
 * server on their side, and the honest shares a rotation must keep.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  commitLinkKey,
  decodeShareManifestBody,
  deriveLinkId,
  deriveLinkKey,
  linkSecretToText,
  MemoryDeviceKeyStore,
  sealText,
  shareProjectionDigest,
  signShareManifest,
  wrapLinkSecretForOwner,
  type DeviceKeys,
  type ShareManifest,
} from "../src/crypto/index.js";
import { SHARE_NOT_LISTED } from "../src/client.js";
import { isCloudError } from "../src/errors.js";
import { teamKeyAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

const DAY_MS = 86_400_000;

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
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string): Promise<MemoryBackend> {
  const member = await person(database, uid);
  const invite = await approver.createInvite(teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  await grant(approver, member, teamId);
  return member;
}
/** Alice's second device, signed in as her and given the team key by her first. */
async function secondDevice(database: MemoryDatabase, alice: MemoryBackend, teamId: string): Promise<MemoryBackend> {
  const laptop = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  laptop.signInAs("alice");
  await (await laptop.requestTeamKey(teamId)).sent;
  await grant(alice, laptop, teamId);
  return laptop;
}
async function teamWithAuto(database: MemoryDatabase) {
  const alice = await person(database, "alice");
  const created = await alice.createTeam({ number: 1111, name: "Alpha" });
  await created.sent;
  const teamId = created.value.id;
  const auto = await alice.createAuto(teamId, { title: "secret auto" });
  await auto.sent;
  const r1 = await alice.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  return { alice, teamId, autoId: auto.value.id, r1: r1.value.id };
}
const keyVersion = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
const manifestOf = (database: MemoryDatabase, shareId: string) => (database.peek(`shares/${shareId}`) as { manifest: ShareManifest }).manifest;
const listed = async (backend: MemoryBackend, teamId: string) => (await keysOf(backend).openTeam(teamId)).roster.shares.map((s) => s.shareId);

/**
 * A following link share of `autoId` forged with `kept`, a copy of the team's keys, and signed at its
 * newest version by the device `signer`. `named`, when given, is the device the manifest claims
 * signed it, whose public keys it then carries.
 */
async function forgeLinkShare(database: MemoryDatabase, kept: OpenedTeam, signer: DeviceKeys, autoId: string, revision: string, named: DeviceKeys = signer) {
  const kv = kept.newest.key.version;
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const shareId = await deriveLinkId(secret);
  const linkKey = await deriveLinkKey(secret);
  const expiresAt = new Date(database.now().getTime() + 30 * DAY_MS);
  const projection = await sealText(linkKey, '{"v":"placeholder"}', aadFor.shareProjection({ shareId, autoId, kv: 1 }));
  const signed = await signShareManifest({
    body: {
      shareId, ownerTeamId: kept.teamId, autoId, revisionId: revision, audience: "link", mode: "follow", level: "view", revoked: false,
      expiresAtMs: expiresAt.getTime(), seq: 1, skv: 1, wkv: kv, okv: kv, device: signer.deviceId, termsSeq: 1, termsDevices: [signer.deviceId], choice: null, teams: [],
      projection: await shareProjectionDigest({ shareId, projection }),
      commit: await commitLinkKey({ shareId, secret }),
    },
    signingKey: kept.chain.get(kv)!.pair.signingKey,
    device: signer,
  });
  let manifest: ShareManifest = signed;
  if (named !== signer) {
    // The body names `named`, and carries its public keys, but only `signer` could sign it.
    const body = { ...decodeShareManifestBody(signed.body), device: named.deviceId };
    const terms = { tsig: signed.tsig, tkeys: signed.tkeys };
    const again = await signShareManifest({ body, signingKey: kept.chain.get(kv)!.pair.signingKey, device: named, terms });
    const byThief = await signShareManifest({ body, signingKey: kept.chain.get(kv)!.pair.signingKey, device: { ...signer, deviceId: named.deviceId }, terms });
    manifest = { ...again, dsig: byThief.dsig };
  }
  database.seed(`shares/${shareId}`, {
    ownerTeamId: kept.teamId, autoId, audience: "link", teamIds: [], level: "view", mode: "follow", revision,
    expiresAt, revokedAt: null, createdBy: "someone", createdAt: database.now(), updatedAt: database.now(),
    projection,
    linkWrap: await wrapLinkSecretForOwner({ shareId, teamId: kept.teamId, autoId, secret, teamKey: teamKeyAt(kept, kv) }),
    manifest,
  });
  return { shareId, secret };
}

/** What a stranger holding the link sees on it. */
async function seenByLink(database: MemoryDatabase, secret: Uint8Array): Promise<string | undefined> {
  const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  return (await stranger.openLinkShare(linkSecretToText(secret)))?.projection;
}

describe("a rotation lists only the shares a device it keeps signed", () => {
  it("leaves off a link share a member forged after leaving, so the next publish does not reach her", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const mallory = await join(database, alice, teamId, "mallory");
    const kept = await keysOf(mallory).openTeam(teamId);
    const oldKv = kept.newest.key.version;
    await (await mallory.leaveTeam(teamId)).sent;
    // After she has left, with the server, she forges a following link share signed at key n.
    const { shareId, secret } = await forgeLinkShare(database, kept, await keysOf(mallory).device(), autoId, r1);
    // An owner completes the pending rotation, which is what cuts her off.
    await (await alice.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(oldKv + 1);
    expect(await listed(alice, teamId)).not.toContain(shareId);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two, after the rotation"}' });
    await r2.sent;
    expect(await seenByLink(database, secret)).toBe('{"v":"placeholder"}');
    // The team's own list leaves it out too.
    expect((await alice.listTeamShares(teamId)).map((s) => s.id)).not.toContain(shareId);
  });

  it("leaves off a link share forged on a stolen device, so the next publish does not reach the thief", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const laptop = await secondDevice(database, alice, teamId);
    const kept = await keysOf(laptop).openTeam(teamId);
    const stolen = await keysOf(laptop).device();
    const { shareId, secret } = await forgeLinkShare(database, kept, stolen, autoId, r1);
    await (await alice.revokeDevice(teamId, stolen.deviceId)).sent;
    const roster = (await keysOf(alice).openTeam(teamId)).roster;
    expect(roster.devices.map((d) => d.deviceId)).not.toContain(stolen.deviceId);
    expect(roster.shares.map((s) => s.shareId)).not.toContain(shareId);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two, after revoking"}' });
    await r2.sent;
    expect(await seenByLink(database, secret)).toBe('{"v":"placeholder"}');
  });

  it("refuses a share whose manifest names a device the rotation keeps but was signed by another", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const laptop = await secondDevice(database, alice, teamId);
    const kept = await keysOf(laptop).openTeam(teamId);
    const stolen = await keysOf(laptop).device();
    const phone = await keysOf(alice).device();
    const { shareId, secret } = await forgeLinkShare(database, kept, stolen, autoId, r1, phone);
    expect(decodeShareManifestBody(manifestOf(database, shareId).body).device).toBe(phone.deviceId);
    await (await alice.revokeDevice(teamId, stolen.deviceId)).sent;
    expect(await listed(alice, teamId)).not.toContain(shareId);
    // Every device of the team refuses to open or seal into it: the device signature does not verify.
    await expect(alice.getShare(shareId, teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await expect(
      alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' }),
    ).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    expect(await seenByLink(database, secret)).toBe('{"v":"placeholder"}');
  });

  it("keeps a share made on a device the rotation keeps, and seals the next publish into it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    await join(database, alice, teamId, "bob");
    const made = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    const secret = made.value.linkSecret!;
    const before = keyVersion(database, teamId);
    // Removing a member rotates the key at once, from a device the new roster keeps.
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(keyVersion(database, teamId)).toBe(before + 1);
    expect(await listed(alice, teamId)).toContain(made.value.id);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    expect((await stranger.openLinkShare(secret))?.projection).toBe('{"s":"two"}');
  });

  it("stops a share last signed by a device that is then revoked, and says why when the team changes it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const laptop = await secondDevice(database, alice, teamId);
    const made = await laptop.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "pinned", projection: '{"s":"one"}' });
    await made.sent;
    await (await alice.revokeDevice(teamId, (await keysOf(laptop).device()).deviceId)).sent;
    expect(await listed(alice, teamId)).not.toContain(made.value.id);
    await expect(alice.setShareLevel(made.value.id, "view")).rejects.toThrow(SHARE_NOT_LISTED);
  });

  it("moves a following share's signer to the device that publishes into it, and still stops it when the device that made it is revoked", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const laptop = await secondDevice(database, alice, teamId);
    const laptopId = (await keysOf(laptop).device()).deviceId;
    const made = await laptop.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    expect(decodeShareManifestBody(manifestOf(database, made.value.id).body).device).toBe(laptopId);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const body = decodeShareManifestBody(manifestOf(database, made.value.id).body);
    expect(body.device).toBe((await keysOf(alice).device()).deviceId);
    expect(body.termsDevices).toEqual([laptopId]);
    expect(body.revisionId).toBe(r2.value.id);
    // The device that made it could have made any share at all with the key being replaced, so the
    // rotation that drops it drops the share too, whoever signed it last; the team shares it again.
    await (await alice.revokeDevice(teamId, laptopId)).sent;
    expect(await listed(alice, teamId)).not.toContain(made.value.id);
    const r3 = await alice.publishRevision({ teamId, autoId, baseRevision: r2.value.id, content: '{"s":"three"}', followProjection: '{"s":"three"}' });
    await r3.sent;
    const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    expect((await stranger.openLinkShare(made.value.linkSecret!))?.projection).toBe('{"s":"two"}');
  });
});
