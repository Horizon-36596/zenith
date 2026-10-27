/**
 * Signed proposals. Anyone can wrap a key to a team's public `encKey`, so a proposal's `ownerWrap`
 * alone says nothing about who sent it: the server by itself could make a proposal "from" a partner
 * team and have the owner team open it as that team's. The proposing device now signs each proposal
 * with its team's signing key of the version the proposal is sealed under (`fkv`), over the binding
 * its ciphertexts carry, the auto and base revision, and a digest of the sealed diff and both wraps.
 * The owner team checks the signature with the signing key this device pinned for the proposing
 * team, walked forward through that team's signed rotations, and does not list a proposal that fails.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MemoryDeviceKeyStore,
  createTeamKeys,
  rotateTeamKeys,
  sealProposal,
  signProposal,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { MAX_EARLIER_PARTNER_PINS, MemoryTrustStore, readEarlierPartnerPins, readPin, writePartnerPin } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
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
const proposalDoc = (database: MemoryDatabase, proposalId: string) => database.peek(`proposals/${proposalId}`) as DocData;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;

/** Alpha shares its auto with Partner at propose level, following the latest version, and Partner sends one proposal. */
async function sharedAndProposed() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const o = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const made = await o.owner.createShare({
    teamId: o.teamId, autoId: o.autoId, revision: o.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"s":"one"}',
    expectedKeys: { [p.teamId]: (await o.owner.checkPartnerKeys([p.teamId]))[0]!.keyId },
  });
  await made.sent;
  const shareId = made.value.id;
  const sent = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"honest":"change"}' });
  await sent.sent;
  return { database, o, p, shareId, honestId: sent.value.id };
}

/** What the owner team lists as received: each proposal's sending team and diff. */
async function received(backend: MemoryBackend, teamId: string): Promise<Array<[string, string]>> {
  return (await backend.listProposals(teamId, "received")).map((proposal) => [proposal.fromTeamId, proposal.diff]);
}

describe("a proposal the partner team signed", () => {
  it("is stored with its 64-byte signature, and the owner team lists it", async () => {
    const { database, o, p, honestId } = await sharedAndProposed();
    const doc = proposalDoc(database, honestId);
    expect(doc["sig"]).toBeInstanceOf(Uint8Array);
    expect((doc["sig"] as Uint8Array).byteLength).toBe(64);
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
    // The team that sent it still reads it as sent, and the signature is not part of what it is shown.
    const sent = await p.owner.listProposals(p.teamId, "sent");
    expect(sent.map((proposal) => proposal.diff)).toEqual(['{"honest":"change"}']);
    expect("sig" in (sent[0] as object)).toBe(false);
  });
});

describe("the bytes a proposal's signature is over", () => {
  it("are the label, a zero byte and the digest of the sealed fields, as rebuilt here with node:crypto", async () => {
    const { database, o, p, shareId, honestId } = await sharedAndProposed();
    const doc = proposalDoc(database, honestId) as unknown as {
      diff: { kv: number; iv: Uint8Array; ct: Uint8Array };
      ownerWrap: { epk: Uint8Array; iv: Uint8Array; ct: Uint8Array; ekv: number };
      fromWrap: { kv: number; iv: Uint8Array; ct: Uint8Array };
      sig: Uint8Array;
    };
    const label =
      `zenith/v1/proposal-signature|proposal=${honestId}|share=${shareId}|owner=${o.teamId}|from=${p.teamId}` +
      `|okv=${String(doc.ownerWrap.ekv)}|fkv=${String(doc.fromWrap.kv)}|auto=${o.autoId}|base=${o.r1}`;
    const parts = [doc.diff.iv, doc.diff.ct, doc.ownerWrap.epk, doc.ownerWrap.iv, doc.ownerWrap.ct, doc.fromWrap.iv, doc.fromWrap.ct];
    const hash = createHash("sha256");
    for (const part of parts) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.byteLength);
      hash.update(length);
      hash.update(part);
    }
    const signed = Buffer.concat([Buffer.from(label, "utf8"), Buffer.from([0]), hash.digest()]);
    const signSpki = encKeyOf(database, p.teamId).signSpki;
    const key = createPublicKey({ key: Buffer.from(signSpki), format: "der", type: "spki" });
    expect(nodeVerify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, doc.sig)).toBe(true);
  });
});

describe("a proposal the server made on its own", () => {
  it("is not listed when it carries no signature (the review's reproduction)", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    // The server holds no team key: it reads Alpha's public encKey and makes up the partner's side.
    const encKey = encKeyOf(database, o.teamId);
    const proposalId = "forgedProposal000000000";
    const fake = await createTeamKeys(p.teamId); // any key of version 1 stands in for the partner's team key
    const sealed = await sealProposal({
      binding: { proposalId, shareId, ownerTeamId: o.teamId, fromTeamId: p.teamId, okv: encKey.v, fkv: 1 },
      diffText: '{"server":"chosen change"}', ownerEncKey: encKey, fromTeamKey: fake.key,
    });
    database.seed(`proposals/${proposalId}`, {
      shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, status: "open", createdBy: "olga",
      createdAt: database.now(), ...sealed,
    });
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
  });

  it("is not listed when it is signed with a signing key of the server's own", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    const encKey = encKeyOf(database, o.teamId);
    const proposalId = "forgedProposal000000001";
    const fake = await createTeamKeys(p.teamId);
    const binding = { proposalId, shareId, ownerTeamId: o.teamId, fromTeamId: p.teamId, okv: encKey.v, fkv: 1 };
    const sealed = await sealProposal({ binding, diffText: '{"server":"chosen change"}', ownerEncKey: encKey, fromTeamKey: fake.key });
    const sig = await signProposal({ binding, context: { autoId: o.autoId, baseRevision: o.r1 }, sealed, signingKey: fake.pair.signingKey });
    database.seed(`proposals/${proposalId}`, {
      shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, status: "open", createdBy: "olga",
      createdAt: database.now(), ...sealed, sig,
    });
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
  });

  it("is not listed when it keeps a real signature over a diff and wraps the server swapped in", async () => {
    const { database, o, p, shareId, honestId } = await sharedAndProposed();
    const encKey = encKeyOf(database, o.teamId);
    const honest = proposalDoc(database, honestId);
    const fake = await createTeamKeys(p.teamId);
    const binding = { proposalId: honestId, shareId, ownerTeamId: o.teamId, fromTeamId: p.teamId, okv: encKey.v, fkv: 1 };
    const swapped = await sealProposal({ binding, diffText: '{"server":"chosen change"}', ownerEncKey: encKey, fromTeamKey: fake.key });
    database.seed(`proposals/${honestId}`, { ...honest, diff: swapped.diff, ownerWrap: swapped.ownerWrap });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  });

  it("is not listed when the server moves a signed proposal to another base revision", async () => {
    const { database, o, honestId } = await sharedAndProposed();
    const r2 = await o.owner.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    database.seed(`proposals/${honestId}`, { ...proposalDoc(database, honestId), baseRevision: r2.value.id });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  });

  it("is not listed when it is signed at a partner key version the server made up", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    // A version 2 of the partner's key that the partner's version 1 never signed.
    const fakeOne = await createTeamKeys(p.teamId);
    const fakeTwo = await rotateTeamKeys(p.teamId, fakeOne);
    const partnerDoc = database.peek(`teams/${p.teamId}`) as DocData;
    database.seed(`teams/${p.teamId}`, { ...partnerDoc, encKey: fakeTwo.encKey });
    database.seed(`teams/${p.teamId}/teamKeys/2`, fakeTwo.record as unknown as DocData);
    const encKey = encKeyOf(database, o.teamId);
    const proposalId = "forgedProposal000000002";
    const binding = { proposalId, shareId, ownerTeamId: o.teamId, fromTeamId: p.teamId, okv: encKey.v, fkv: 2 };
    const sealed = await sealProposal({ binding, diffText: '{"server":"chosen change"}', ownerEncKey: encKey, fromTeamKey: fakeTwo.key });
    const sig = await signProposal({ binding, context: { autoId: o.autoId, baseRevision: o.r1 }, sealed, signingKey: fakeTwo.pair.signingKey });
    database.seed(`proposals/${proposalId}`, {
      shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, status: "open", createdBy: "olga",
      createdAt: database.now(), ...sealed, sig,
    });
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
  });
});

describe("a proposal signed after the partner team rotated its key", () => {
  it("is listed by an owner device whose pin is older, through the partner's signed rotation", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    // A second member of Alpha, on her own device, publishes to the following share later.
    const amy = await join(database, o.owner, o.teamId, "amy");
    // Partner removes a member, which rotates its key to version 2.
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    expect(encKeyOf(database, p.teamId).v).toBe(2);
    // Amy's publish re-keys the share to Partner's version 2, so Partner may propose again.
    const r2 = await amy.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const later = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"after":"rotation"}' });
    await later.sent;
    expect((proposalDoc(database, later.value.id)["fromWrap"] as { kv: number }).kv).toBe(2);

    // Alice's device pinned Partner at version 1 and walks the signed rotation to version 2.
    expect((await received(o.owner, o.teamId)).map(([, diff]) => diff).sort()).toEqual(['{"after":"rotation"}', '{"honest":"change"}']);
    // The pin is not raised by listing, so the proposal signed at version 1 is listed again.
    expect((await received(o.owner, o.teamId)).map(([, diff]) => diff).sort()).toEqual(['{"after":"rotation"}', '{"honest":"change"}']);
  });

  it("is listed beside the older one once this device's pin moved past it, through the pin it held before", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    // Alice's own publish re-keys the share to Partner's version 2 and raises her pin to it.
    const r2 = await o.owner.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const later = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"after":"rotation"}' });
    await later.sent;
    // The proposal signed under version 1 is checked with the version 1 pin this device held before.
    expect((await received(o.owner, o.teamId)).map(([, diff]) => diff).sort()).toEqual(['{"after":"rotation"}', '{"honest":"change"}']);
  });

  it("is the only one listed by an owner device whose first pin of the partner is newer than the older one's key", async () => {
    const { database, o, p, shareId } = await sharedAndProposed();
    const amy = await join(database, o.owner, o.teamId, "amy");
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    // Amy's publish re-keys the share, and her device's first pin of Partner is version 2.
    const r2 = await amy.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const later = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"after":"rotation"}' });
    await later.sent;
    // Signatures only reach forward, and this device never trusted a key of Partner's version 1, so
    // the proposal signed under it cannot be checked here and is not listed: fail closed.
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}']]);
  });
});

describe("the partner pins a device held before", () => {
  const key = (v: number, fill: number) => ({ v, fingerprint: new Uint8Array(32).fill(fill), signSpki: new Uint8Array(91).fill(fill) });

  it("keeps each pin a newer version replaces, oldest first, and at most the newest few", () => {
    const store = new MemoryTrustStore();
    writePartnerPin(store, "u", "t", key(1, 1), "checked");
    writePartnerPin(store, "u", "t", key(1, 1), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
    writePartnerPin(store, "u", "t", key(2, 2), "checked");
    writePartnerPin(store, "u", "t", key(4, 4), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([key(1, 1), key(2, 2)]);
    expect(readPin(store, "u", "partner", "t")).toEqual(key(4, 4));
    for (let v = 5; v < 5 + MAX_EARLIER_PARTNER_PINS + 2; v += 1) writePartnerPin(store, "u", "t", key(v, v), "checked");
    const kept = readEarlierPartnerPins(store, "u", "t");
    expect(kept).toHaveLength(MAX_EARLIER_PARTNER_PINS);
    expect(kept.at(-1)?.v).toBe(4 + MAX_EARLIER_PARTNER_PINS + 1);
    // Another user on the same device has none.
    expect(readEarlierPartnerPins(store, "someone else", "t")).toEqual([]);
  });

  it("forgets them when a key the person accepted replaces the pin under the same or an older version", () => {
    const store = new MemoryTrustStore();
    writePartnerPin(store, "u", "t", key(1, 1), "checked");
    writePartnerPin(store, "u", "t", key(2, 2), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([key(1, 1)]);
    writePartnerPin(store, "u", "t", key(2, 9), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
    writePartnerPin(store, "u", "t", key(3, 3), "checked");
    writePartnerPin(store, "u", "t", key(1, 7), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
  });

  it("reads as none when what is kept cannot be read", () => {
    const store = new MemoryTrustStore();
    store.set("zenith.pin.partner-was.u.t", "not json");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
    store.set("zenith.pin.partner-was.u.t", JSON.stringify([{ v: 1, fp: "AA", sk: "AA" }]));
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
  });
});
