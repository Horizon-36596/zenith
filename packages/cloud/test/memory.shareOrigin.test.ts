/**
 * Which device made a share. Anyone who holds team key n can sign a manifest at version n, a member
 * who has left while the rotation that cuts her waits or a thief with a stolen device, and every
 * ordinary publish before that rotation signed such a share again, from an honest device, so that
 * the rotation found it signed by a device it keeps and listed it. Making a share is the first
 * signature of its terms: the manifest names the devices that signed its terms at the key that signs
 * it (`tdev`), the device that made the share first, and carries the last one's signature over the
 * terms (`tsig`) and its keys (`tkeys`), which a publish carries unchanged. A rotation lists a share
 * only when the device that last signed it and every device that signed its terms are kept, the last
 * with the key the new roster holds for it. These tests are that member and that thief, with the
 * server on their side, and the honest shares a rotation keeps. `memory.shareTermsSigner.test.ts`
 * covers a change of an honest share's terms.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  commitLinkKey,
  deriveLinkId,
  deriveLinkKey,
  linkSecretToText,
  MemoryDeviceKeyStore,
  readShareManifest,
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
 * A following link share of `autoId` forged with `kept`, a copy of the team's keys, signed at its
 * newest version by the device `signer`. By default `signer` also signs its terms; `terms` names
 * another device as their signer instead, with that device's public keys and `tsig` as its signature.
 */
async function forgeLinkShare(
  database: MemoryDatabase,
  kept: OpenedTeam,
  signer: DeviceKeys,
  autoId: string,
  revision: string,
  terms?: { device: DeviceKeys; tsig: Uint8Array },
) {
  const kv = kept.newest.key.version;
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const shareId = await deriveLinkId(secret);
  const linkKey = await deriveLinkKey(secret);
  const expiresAt = new Date(database.now().getTime() + 30 * DAY_MS);
  const projection = await sealText(linkKey, '{"v":"placeholder"}', aadFor.shareProjection({ shareId, autoId, kv: 1 }));
  const manifest = await signShareManifest({
    body: {
      shareId, ownerTeamId: kept.teamId, autoId, revisionId: revision, audience: "link", mode: "follow", level: "view", revoked: false,
      expiresAtMs: expiresAt.getTime(), seq: 1, skv: 1, wkv: kv, okv: kv, device: signer.deviceId, termsSeq: 1, termsDevices: [terms?.device.deviceId ?? signer.deviceId],
      choice: null, projection: await shareProjectionDigest({ shareId, projection }), teams: [], commit: await commitLinkKey({ shareId, secret }),
    },
    signingKey: kept.chain.get(kv)!.pair.signingKey,
    device: signer,
    ...(terms === undefined ? {} : { terms: { tsig: terms.tsig, tkeys: new Uint8Array([...terms.device.encSpki, ...terms.device.signSpki]) } }),
  });
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
async function seenByLink(database: MemoryDatabase, secret: Uint8Array | string): Promise<string | undefined> {
  const stranger = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  return (await stranger.openLinkShare(typeof secret === "string" ? secret : linkSecretToText(secret)))?.projection;
}

describe("a publish before a rotation does not carry a forged share past it", () => {
  it("drops a following link share a member forged after leaving, and refuses a publish while the rotation waits", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const mallory = await join(database, alice, teamId, "mallory");
    const kept = await keysOf(mallory).openTeam(teamId);
    const malloryDevice = await keysOf(mallory).device();
    const oldKv = kept.newest.key.version;
    await (await mallory.leaveTeam(teamId)).sent;
    const { shareId, secret } = await forgeLinkShare(database, kept, malloryDevice, autoId, r1);
    // A publish while the rotation is pending would seal under the key Mallory still holds, so it is
    // refused until Alice makes a new key.
    await expect(alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' })).rejects.toMatchObject({ code: "conflict" });
    await (await alice.completeKeyRotation(teamId)).sent;
    expect(keyVersion(database, teamId)).toBe(oldKv + 1);
    expect(await listed(alice, teamId)).not.toContain(shareId);
    const r3 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"three"}', followProjection: '{"s":"three, after the rotation"}' });
    await r3.sent;
    // Mallory, rotated out, sees nothing published after the rotation.
    expect(await seenByLink(database, secret)).not.toBe('{"s":"three, after the rotation"}');
    expect((await alice.listTeamShares(teamId)).map((s) => s.id)).not.toContain(shareId);
  });

  it("drops a following link share forged on a stolen device, though the next publish signed it again before the revocation", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const bob = await join(database, alice, teamId, "bob");
    const stolen = await keysOf(bob).openTeam(teamId);
    const bobDevice = await keysOf(bob).device();
    const { shareId, secret } = await forgeLinkShare(database, stolen, bobDevice, autoId, r1);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    await (await alice.revokeDevice(teamId, bobDevice.deviceId)).sent;
    expect(await listed(alice, teamId)).not.toContain(shareId);
    const r3 = await alice.publishRevision({ teamId, autoId, baseRevision: r2.value.id, content: '{"s":"three"}', followProjection: '{"s":"after revocation"}' });
    await r3.sent;
    expect(await seenByLink(database, secret)).not.toBe('{"s":"after revocation"}');
  });

  it("refuses a forged share that names a device the rotation keeps as the one that signed its terms, with a terms signature that device never made", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const bob = await join(database, alice, teamId, "bob");
    const stolen = await keysOf(bob).openTeam(teamId);
    const bobDevice = await keysOf(bob).device();
    const aliceDevice = await keysOf(alice).device();
    // The thief names Alice's device as the one that signed the terms, with its public keys, but
    // cannot make its signature.
    const { shareId, secret } = await forgeLinkShare(database, stolen, bobDevice, autoId, r1, { device: aliceDevice, tsig: crypto.getRandomValues(new Uint8Array(64)) });
    expect(readShareManifest(manifestOf(database, shareId)).termsDevices).toEqual([aliceDevice.deviceId]);
    // Every device of the team refuses to open or seal into it: the terms signature does not verify.
    await expect(alice.getShare(shareId, teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await expect(
      alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' }),
    ).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await (await alice.revokeDevice(teamId, bobDevice.deviceId)).sent;
    expect(await listed(alice, teamId)).not.toContain(shareId);
    expect(await seenByLink(database, secret)).toBe('{"v":"placeholder"}');
  });

  it("keeps an honest share made on a kept device through the rotation, though another member's device signed it last", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const ann = await join(database, alice, teamId, "ann");
    await join(database, alice, teamId, "bob");
    const made = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    const r2 = await ann.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const body = readShareManifest(manifestOf(database, made.value.id));
    expect(body.device).toBe((await keysOf(ann).device()).deviceId);
    expect(body.termsDevices).toEqual([(await keysOf(alice).device()).deviceId]);
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(await listed(alice, teamId)).toContain(made.value.id);
    const r3 = await ann.publishRevision({ teamId, autoId, baseRevision: r2.value.id, content: '{"s":"three"}', followProjection: '{"s":"three"}' });
    await r3.sent;
    expect(await seenByLink(database, made.value.linkSecret!)).toBe('{"s":"three"}');
  });

  it("keeps an honest share to teams through the rotation, re-keyed under the new team key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const olga = await person(database, "olga");
    const partner = await olga.createTeam({ number: 2222, name: "Partner" });
    await partner.sent;
    await join(database, alice, teamId, "bob");
    const made = await alice.createShare({ teamId, autoId, revision: r1, audience: "teams", teamIds: [partner.value.id], mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(await listed(alice, teamId)).toContain(made.value.id);
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    expect((await olga.getShare(made.value.id, partner.value.id))?.projection).toBe('{"s":"two"}');
  });

  it("stops a share made on a device the team then drops, though a kept device signed it last, and says why", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    const laptop = await secondDevice(database, alice, teamId);
    const laptopId = (await keysOf(laptop).device()).deviceId;
    const made = await laptop.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    const r2 = await alice.publishRevision({ teamId, autoId, baseRevision: r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const body = readShareManifest(manifestOf(database, made.value.id));
    expect(body.device).toBe((await keysOf(alice).device()).deviceId);
    expect(body.termsDevices).toEqual([laptopId]);
    await (await alice.revokeDevice(teamId, laptopId)).sent;
    expect(await listed(alice, teamId)).not.toContain(made.value.id);
    await expect(alice.setShareLevel(made.value.id, "view")).rejects.toThrow(SHARE_NOT_LISTED);
    const r3 = await alice.publishRevision({ teamId, autoId, baseRevision: r2.value.id, content: '{"s":"three"}', followProjection: '{"s":"three"}' });
    await r3.sent;
    expect(await seenByLink(database, made.value.linkSecret!)).toBe('{"s":"two"}');
  });

  it("refuses a share whose terms signature the server replaced, and leaves it out at the next rotation", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const { alice, teamId, autoId, r1 } = await teamWithAuto(database);
    await join(database, alice, teamId, "bob");
    const made = await alice.createShare({ teamId, autoId, revision: r1, audience: "link", mode: "follow", projection: '{"s":"one"}' });
    await made.sent;
    const path = `shares/${made.value.id}`;
    const doc = database.peek(path) as { manifest: ShareManifest } & Record<string, unknown>;
    database.seed(path, { ...doc, manifest: { ...doc.manifest, tsig: crypto.getRandomValues(new Uint8Array(64)) } });
    await expect(alice.getShare(made.value.id, teamId)).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
    await (await alice.removeMember(teamId, "bob")).sent;
    expect(await listed(alice, teamId)).not.toContain(made.value.id);
  });
});
