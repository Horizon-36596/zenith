/**
 * The signed manifest of a share to teams. A wrap to a team's public key proves nothing about who
 * made the key inside it, and the `ekv` beside a wrap is only the server's word, so every device
 * that opens a share key, or seals under one, checks the manifest the owner team signed: which key
 * it made, and to which key version of each team it wrapped it. These tests are a server that
 * writes, withholds and rolls back what it likes, with and without a member a team removed.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  commitShareKey,
  decodeShareManifestBody,
  encodeShareManifestBody,
  MemoryDeviceKeyStore,
  newShareKey,
  openText,
  sealText,
  signShareManifest,
  teamKeyDigest,
  unwrapShareKeyAsTeam,
  wrapShareKeyForOwner,
  wrapShareKeyToTeam,
  type Envelope,
  type ShareKeyWrap,
  type ShareManifest,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { SHARE_SIGNED_WITH_OLDER_KEY, SHARE_WITHOUT_MANIFEST } from "../src/client.js";
import { proposalWithKeys, uidOf, type StoredProposal } from "./cryptoHelpers.js";
import { isCloudError } from "../src/errors.js";
import { teamKeyAt, teamPairAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore, readPin, type TrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
const trustOf = (backend: MemoryBackend): TrustStore => (backend as unknown as { trust: TrustStore }).trust;
async function codeOf(device: MemoryBackend, teamId: string) {
  const status = await device.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  return { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
}
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
const keyVersion = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;

interface ShareDocLike {
  autoId: string;
  projection: Envelope;
  ownerWrap: Envelope & { kv: number };
  keyWraps: Record<string, ShareKeyWrap>;
  prevKeys?: Record<string, Envelope>;
  manifest: ShareManifest;
}
const shareDocOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as unknown as ShareDocLike;
const rawShareDoc = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as Record<string, unknown>;

/** The code of the `CloudError` a call fails with, or "ok" when it does not fail. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "ok";
  } catch (error) {
    return isCloudError(error) ? error.code : String(error);
  }
}

/** Sends a proposal and returns its id once stored, or null when it is refused before or after it is queued. */
async function proposalSent(backend: MemoryBackend, input: Parameters<MemoryBackend["sendProposal"]>[0]): Promise<string | null> {
  try {
    const queued = await backend.sendProposal(input);
    await queued.sent;
    return queued.value.id;
  } catch {
    return null;
  }
}

/** What someone holding a partner team's old keys reads of a share's projection, given the wrap she kept. */
async function projectionWithWrap(database: MemoryDatabase, shareId: string, teamId: string, wrap: ShareKeyWrap, keys: OpenedTeam): Promise<string | null> {
  const doc = shareDocOf(database, shareId);
  try {
    const shareKey = await unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: doc.projection.kv, wrap, pair: teamPairAt(keys, wrap.ekv) });
    return await openText(shareKey, doc.projection, aadFor.shareProjection({ shareId, autoId: doc.autoId, kv: shareKey.version }));
  } catch {
    return null;
  }
}

/**
 * What someone holding a team's old keys reads of a proposal, or null: through share key `kv` from
 * the wrap she kept, and through her team's keys on the proposal's own wraps.
 */
async function proposalWithWrap(database: MemoryDatabase, proposalId: string, shareId: string, teamId: string, wrap: ShareKeyWrap, kv: number, keys: OpenedTeam): Promise<string | null> {
  const proposal = database.peek(`proposals/${proposalId}`) as unknown as StoredProposal;
  const shareKey = await unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: kv, wrap, pair: teamPairAt(keys, wrap.ekv) }).catch(() => undefined);
  return proposalWithKeys(proposalId, proposal, { chain: keys.chain, ...(shareKey === undefined ? {} : { shareKey }) });
}

describe("a server that lies about a share's key", () => {
  it("raises a partner's key version beside its wrap, and the sharing team still re-keys the share, so a member removed from the partner reads nothing published after", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const mallory = await join(database, p.owner, p.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"before"}' });
    await share.sent;
    const malloryKeys = await keysOf(mallory).openTeam(p.teamId);
    const keptWrap = shareDocOf(database, share.value.id).keyWraps[p.teamId] as ShareKeyWrap;
    await (await p.owner.removeMember(p.teamId, "mallory")).sent;
    const pv = keyVersion(database, p.teamId);
    expect(pv).toBe(keptWrap.ekv + 1);
    // The server says the partner's wrap is already at its new key. Only the number changes.
    const doc = rawShareDoc(database, share.value.id);
    database.seed(`shares/${share.value.id}`, { ...doc, keyWraps: { [p.teamId]: { ...keptWrap, ekv: pv } } });
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"after"}', followProjection: '{"secret":"after"}' });
    await r2.sent;
    expect(shareDocOf(database, share.value.id).projection.kv).toBe(2);
    expect(await projectionWithWrap(database, share.value.id, p.teamId, keptWrap, malloryKeys)).toBe(null);
    expect((await p.owner.getShare(share.value.id, p.teamId))?.projection).toBe('{"secret":"after"}');
  }, 60_000);

  it("shows the sharing team's device a partner key older than the one it pinned, and the share is re-keyed or nothing is written", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const mallory = await join(database, p.owner, p.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"before"}' });
    await share.sent;
    const malloryKeys = await keysOf(mallory).openTeam(p.teamId);
    const keptWrap = shareDocOf(database, share.value.id).keyWraps[p.teamId] as ShareKeyWrap;
    const oldTeam = database.peek(`teams/${p.teamId}`);
    await (await p.owner.removeMember(p.teamId, "mallory")).sent;
    // Alice's device sees the rotation (signed chain) when she makes a second share, and pins it.
    const other = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"other"}' });
    await other.sent;
    expect(shareDocOf(database, other.value.id).keyWraps[p.teamId]?.ekv).toBe(keptWrap.ekv + 1);
    // Now the server shows Alice's device the partner's old team document.
    const real = database.read.bind(database);
    database.read = (caller, path) => (uidOf(caller) === "alice" && path === `teams/${p.teamId}` ? structuredClone(oldTeam) : real(caller, path));
    // A refusal is safe: nothing is sealed under the old key.
    const published = await outcome(async () => {
      const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"after"}', followProjection: '{"secret":"after"}' });
      await r2.sent;
    });
    expect(published).toBe("key-changed");
    expect(await projectionWithWrap(database, share.value.id, p.teamId, keptWrap, malloryKeys)).not.toBe('{"secret":"after"}');
  }, 60_000);

  it("makes a share key of its own and wraps it to the partner's public key, and the partner neither shows what it seals nor proposes under it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"before"}' });
    await share.sent;
    const shareId = share.value.id;
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"before"}');
    // The server alone: no team key, only public keys.
    const doc = rawShareDoc(database, shareId) as Record<string, unknown> & { projection: Envelope };
    const evil = await newShareKey(doc.projection.kv + 1);
    const projection = await sealText(evil, '{"v":"made by the server"}', aadFor.shareProjection({ shareId, autoId: a.autoId, kv: evil.version }));
    const wrap = await wrapShareKeyToTeam({ shareId, teamId: p.teamId, shareKey: evil, encKey: encKeyOf(database, p.teamId) });
    database.seed(`shares/${shareId}`, { ...doc, projection, keyWraps: { [p.teamId]: wrap } });
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe("tampered");
    const sent = await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"secret":"proposal"}' });
    expect(sent).toBe(null);
  }, 60_000);

  it("raises a third team's key version beside its wrap, and a partner does not propose under a key a member removed from that team holds", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const mallory = await join(database, q.owner, q.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId, q.teamId], level: "propose", projection: '{"v":"before"}' });
    await share.sent;
    const shareId = share.value.id;
    const malloryKeys = await keysOf(mallory).openTeam(q.teamId);
    const keptWrap = shareDocOf(database, shareId).keyWraps[q.teamId] as ShareKeyWrap;
    const keptKv = shareDocOf(database, shareId).projection.kv;
    await (await q.owner.removeMember(q.teamId, "mallory")).sent;
    const doc = rawShareDoc(database, shareId) as Record<string, unknown> & { keyWraps: Record<string, ShareKeyWrap> };
    database.seed(`shares/${shareId}`, { ...doc, keyWraps: { ...doc.keyWraps, [q.teamId]: { ...keptWrap, ekv: keyVersion(database, q.teamId) } } });
    expect(await outcome(() => p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"secret":"proposal"}' }))).toBe("conflict");
    expect(database.paths().filter((path) => path.startsWith("proposals/"))).toEqual([]);
    // Once the sharing team updates the share, the proposal goes under a key Mallory cannot open.
    await (await a.owner.updateShare(shareId, { revision: a.r1, projection: '{"v":"after"}' })).sent;
    const sent = await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"secret":"proposal"}' });
    expect(sent).not.toBe(null);
    expect(await proposalWithWrap(database, sent as string, shareId, q.teamId, keptWrap, keptKv, malloryKeys)).toBe(null);
  }, 60_000);
});

describe("a share's signed manifest", () => {
  it("is refused when it is missing, with a sentence that says why", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"one"}' });
    await share.sent;
    const { manifest: _manifest, ...doc } = rawShareDoc(database, share.value.id);
    database.seed(`shares/${share.value.id}`, doc);
    await expect(p.owner.getShare(share.value.id, p.teamId)).rejects.toThrow(SHARE_WITHOUT_MANIFEST);
    await expect(a.owner.getShare(share.value.id, a.teamId)).rejects.toThrow(SHARE_WITHOUT_MANIFEST);
  }, 60_000);

  it("lets the partner open a share and propose after the sharing team re-keys it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await join(database, p.owner, p.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    await (await p.owner.removeMember(p.teamId, "mallory")).sent;
    await (await a.owner.updateShare(shareId, { revision: a.r1, projection: '{"v":"two"}' })).sent;
    const doc = shareDocOf(database, shareId);
    const body = decodeShareManifestBody(doc.manifest.body);
    expect({ skv: body.skv, okv: body.okv, teams: body.teams }).toEqual({ skv: 2, okv: 1, teams: [[p.teamId, 2, await teamKeyDigest({ teamId: p.teamId, ...encKeyOf(database, p.teamId) })]] });
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"two"}');
    const sent = await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":1}' });
    expect(sent).not.toBe(null);
    expect((await a.owner.listProposals(a.teamId, "received")).map((proposal) => proposal.diff)).toEqual(['{"n":1}']);
  }, 60_000);

  it("lets a team added to a share open it and propose, under a manifest that names it", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    await (await a.owner.setShareTeams(shareId, [p.teamId, q.teamId])).sent;
    const body = decodeShareManifestBody(shareDocOf(database, shareId).manifest.body);
    expect(body.teams.map(([teamId]) => teamId)).toEqual([p.teamId, q.teamId].sort());
    expect(body.skv).toBe(1);
    expect((await q.owner.getShare(shareId, q.teamId))?.projection).toBe('{"v":"one"}');
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"one"}');
    expect(await proposalSent(q.owner, { shareId, fromTeamId: q.teamId, baseRevision: a.r1, diff: '{"n":1}' })).not.toBe(null);
  }, 60_000);

  it("is checked by a partner at the sharing team's new key version through its signed rotations, which raises the partner's pin", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await join(database, a.owner, a.teamId, "eve");
    await join(database, a.owner, a.teamId, "fay");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"one"}');
    expect(readPin(trustOf(p.owner), "olga", "partner", a.teamId)?.v).toBe(1);
    // Two rotations, so the partner walks two signed steps from the version it pinned.
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    await (await a.owner.removeMember(a.teamId, "fay")).sent;
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"two"}', followProjection: '{"v":"two"}' });
    await r2.sent;
    expect(decodeShareManifestBody(shareDocOf(database, shareId).manifest.body).okv).toBe(3);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"two"}');
    expect(readPin(trustOf(p.owner), "olga", "partner", a.teamId)?.v).toBe(3);
    expect(await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"n":1}' })).not.toBe(null);
  }, 60_000);

  it("keeps older revisions and proposals open through the older share keys after re-keys", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await join(database, a.owner, a.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    expect(await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":1}' })).not.toBe(null);
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"two"}', followProjection: '{"v":"two"}' });
    await r2.sent;
    expect(Object.keys(shareDocOf(database, shareId).prevKeys ?? {})).toEqual(["1"]);
    expect(await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"n":2}' })).not.toBe(null);
    expect((await a.owner.listProposals(a.teamId, "received")).map((proposal) => proposal.diff).sort()).toEqual(['{"n":1}', '{"n":2}']);
    expect((await p.owner.listProposals(p.teamId, "sent")).map((proposal) => proposal.diff).sort()).toEqual(['{"n":1}', '{"n":2}']);
    expect((await a.owner.listRevisions(a.teamId, a.autoId)).map((revision) => revision.content).sort()).toEqual(['{"secret":"Alpha one"}', '{"secret":"two"}']);
  }, 60_000);

  it("is refused when a removed member signs it with the sharing team's old signing key, once the reader has seen a newer one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const mallory = await join(database, a.owner, a.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    const malloryKeys = await keysOf(mallory).openTeam(a.teamId);
    await (await a.owner.removeMember(a.teamId, "mallory")).sent;
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"two"}', followProjection: '{"v":"two"}' });
    await r2.sent;
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"two"}');

    // Mallory, with the server, makes a key of her own one version up and signs a manifest for it
    // with the signing key of version 1, which she still holds.
    const doc = rawShareDoc(database, shareId) as Record<string, unknown> & { projection: Envelope };
    const evil = await newShareKey(doc.projection.kv + 1);
    const partnerKey = encKeyOf(database, p.teamId);
    const signed = decodeShareManifestBody((doc.manifest as ShareManifest).body);
    const malloryDevice = await keysOf(mallory).device();
    const manifest = await signShareManifest({
      body: {
        ...signed, seq: signed.seq + 1, skv: evil.version, wkv: 1, okv: 1, device: malloryDevice.deviceId, termsSeq: signed.termsSeq + 1, termsDevices: [malloryDevice.deviceId],
        teams: [[p.teamId, partnerKey.v, await teamKeyDigest({ teamId: p.teamId, ...partnerKey })]],
        commit: await commitShareKey({ shareId, shareKey: evil }),
      },
      signingKey: teamPairAt(malloryKeys, 1).signingKey,
      device: malloryDevice,
    });
    database.seed(`shares/${shareId}`, {
      ...doc,
      projection: await sealText(evil, '{"v":"from mallory"}', aadFor.shareProjection({ shareId, autoId: a.autoId, kv: evil.version })),
      keyWraps: { [p.teamId]: await wrapShareKeyToTeam({ shareId, teamId: p.teamId, shareKey: evil, encKey: partnerKey }) },
      ownerWrap: await wrapShareKeyForOwner({ shareId, teamId: a.teamId, shareKey: evil, teamKey: teamKeyAt(malloryKeys, 1) }),
      manifest,
    });
    await expect(p.owner.getShare(shareId, p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
    expect(await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"secret":"proposal"}' })).toBe(null);
    await expect(a.owner.getShare(shareId, a.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);

    // A partner device that never opened this share, but pinned the sharing team's newer key, refuses it too.
    const other = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: r2.value.id, audience: "teams", teamIds: [p.teamId], projection: '{"v":"other"}' });
    await other.sent;
    const second = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
    second.signInAs("olga");
    await (await second.requestTeamKey(p.teamId)).sent;
    const { deviceId, approvalCode } = await codeOf(second, p.teamId);
    await (await p.owner.grantDeviceKey(p.teamId, deviceId, approvalCode)).sent;
    expect((await second.getShare(other.value.id, p.teamId))?.projection).toBe('{"v":"other"}');
    expect(readPin(trustOf(second), "olga", "partner", a.teamId)?.v).toBe(2);
    await expect(second.getShare(shareId, p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
  }, 60_000);

  it("is refused when the key it commits to is not the key the wrap holds", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    const honest = rawShareDoc(database, shareId) as Record<string, unknown> & { manifest: ShareManifest };
    // The server keeps the owner team's manifest, but wraps a key of its own at the same version.
    const evil = await newShareKey(1);
    database.seed(`shares/${shareId}`, {
      ...honest,
      projection: await sealText(evil, '{"v":"made by the server"}', aadFor.shareProjection({ shareId, autoId: a.autoId, kv: 1 })),
      keyWraps: { [p.teamId]: await wrapShareKeyToTeam({ shareId, teamId: p.teamId, shareKey: evil, encKey: encKeyOf(database, p.teamId) }) },
    });
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe("tampered");
    expect(await proposalSent(p.owner, { shareId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":1}' })).toBe(null);

    // The owner team's manifest with another commitment in it no longer carries the owner team's signature.
    const body = decodeShareManifestBody(honest.manifest.body);
    const swapped = encodeShareManifestBody({ ...body, commit: await commitShareKey({ shareId, shareKey: evil }) });
    database.seed(`shares/${shareId}`, { ...honest, manifest: { ...honest.manifest, body: swapped } });
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe("tampered");

    // And one the owner team signed over a commitment to another key opens nothing.
    const owner = await keysOf(a.owner).openTeam(a.teamId);
    const misSigned = await signShareManifest({ body: { ...body, commit: await commitShareKey({ shareId, shareKey: evil }) }, signingKey: owner.newest.pair.signingKey, device: owner.device });
    database.seed(`shares/${shareId}`, { ...honest, manifest: misSigned });
    expect(await outcome(() => p.owner.getShare(shareId, p.teamId))).toBe("tampered");
    expect(await outcome(() => a.owner.getShare(shareId, a.teamId))).toBe("tampered");
    database.seed(`shares/${shareId}`, honest);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"one"}');
  }, 60_000);

  it("is refused when it was made for another share and replayed onto this one", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const first = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"first"}' });
    await first.sent;
    const second = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"v":"second"}' });
    await second.sent;
    const firstDoc = rawShareDoc(database, first.value.id);
    const secondDoc = rawShareDoc(database, second.value.id);
    // Only the manifest of the second share, beside the first share's own key.
    database.seed(`shares/${first.value.id}`, { ...firstDoc, manifest: secondDoc.manifest });
    expect(await outcome(() => p.owner.getShare(first.value.id, p.teamId))).toBe("tampered");
    expect(await outcome(() => a.owner.getShare(first.value.id, a.teamId))).toBe("tampered");
    // The second share whole, key fields and all, put under the first share's id.
    database.seed(`shares/${first.value.id}`, secondDoc);
    expect(await outcome(() => p.owner.getShare(first.value.id, p.teamId))).toBe("tampered");
    expect(await outcome(() => a.owner.getShare(first.value.id, a.teamId))).toBe("tampered");
    // The first share, as it was, still opens.
    database.seed(`shares/${first.value.id}`, firstDoc);
    expect((await p.owner.getShare(first.value.id, p.teamId))?.projection).toBe('{"v":"first"}');
  }, 60_000);

  it("is on a link share too, and a link share passed off as a share to teams opens nothing", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const link = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "link", projection: '{"v":"link"}' });
    await link.sent;
    const linkId = link.value.id;
    const doc = rawShareDoc(database, linkId) as Record<string, unknown> & { projection: Envelope };
    expect(decodeShareManifestBody((doc.manifest as ShareManifest).body)).toMatchObject({ audience: "link", teams: [], autoId: a.autoId });
    // The server turns the link share into a share to the partner, with a key of its own.
    const evil = await newShareKey(1);
    const { linkWrap: _linkWrap, ...rest } = doc;
    database.seed(`shares/${linkId}`, {
      ...rest,
      audience: "teams",
      teamIds: [p.teamId],
      projection: await sealText(evil, '{"v":"made by the server"}', aadFor.shareProjection({ shareId: linkId, autoId: a.autoId, kv: 1 })),
      keyWraps: { [p.teamId]: await wrapShareKeyToTeam({ shareId: linkId, teamId: p.teamId, shareKey: evil, encKey: encKeyOf(database, p.teamId) }) },
    });
    // Its manifest names no teams, and says it is a link share.
    expect(await outcome(() => p.owner.getShare(linkId, p.teamId))).toBe("tampered");
    expect(await proposalSent(p.owner, { shareId: linkId, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"n":1}' })).toBe(null);
    // And with no manifest at all, it is refused with its own sentence.
    const { manifest: _manifest, ...unsigned } = rawShareDoc(database, linkId);
    database.seed(`shares/${linkId}`, unsigned);
    await expect(p.owner.getShare(linkId, p.teamId)).rejects.toThrow(SHARE_WITHOUT_MANIFEST);
  }, 60_000);
});
