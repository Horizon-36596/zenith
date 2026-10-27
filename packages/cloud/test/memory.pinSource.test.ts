/**
 * Where a partner pin came from. Opening a received share pins the key of the team it claims to
 * come from, on first use and with no safety code shown, and the server alone can make such a
 * share. So a pin written that way, or reached from one by signed rotations, is kept as `first-use`
 * and vouches for no proposal's signer: before this, the server made a share "from" a team with a
 * key of its own, the owner device opened it at sign-in and pinned that key, and a proposal the
 * server then signed with it was listed as that team's, on a share not made to it, or even as the
 * real partner's on the real share at a version older than the one the manifest names. A pin this
 * device checked (a share made to the key whose code the person was shown, or a key signed from
 * such a pin) still anchors proposals as before.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryDeviceKeyStore,
  aadFor,
  commitShareKey,
  createTeamKeys,
  generateDeviceKeys,
  newShareKey,
  rotateTeamKeys,
  sealProposal,
  sealText,
  signProposal,
  shareProjectionDigest,
  signShareManifest,
  teamKeyDigest,
  wrapShareKeyToTeam,
  type TeamEncKey,
  type TeamKey,
  type TeamKeyPair,
} from "../src/crypto/index.js";
import { MemoryTrustStore, readEarlierPartnerPins, readPin, writePartnerPin } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { uidOf, type Caller } from "./cryptoHelpers.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;
const LONG = 60_000;

async function person(database: MemoryDatabase, uid: string, trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
async function join(
  database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, trust = new MemoryTrustStore(), role: "admin" | "editor" = "editor",
): Promise<MemoryBackend> {
  const member = await person(database, uid, trust);
  // An admin invite never approves at once (owner ruling 2026-10-25): an admin waits, and is approved with the key.
  const invite = await approver.createInvite(teamId, { role, autoApprove: role !== "admin" });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  const code = { deviceId: status.device.deviceId, approvalCode: status.approvalCode };
  await (role === "admin" ? await approver.approveMember(teamId, uid, code) : await approver.grantDeviceKey(teamId, code.deviceId, code.approvalCode)).sent;
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
type Team = Awaited<ReturnType<typeof teamWithAuto>>;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;

/** `owner` shares its auto with `teams` at propose level, following the latest version. */
async function shareTo(owner: Team, teams: readonly Team[]): Promise<string> {
  const checks = await owner.owner.checkPartnerKeys(teams.map((team) => team.teamId));
  const made = await owner.owner.createShare({
    teamId: owner.teamId, autoId: owner.autoId, revision: owner.r1, audience: "teams", teamIds: teams.map((team) => team.teamId), level: "propose",
    mode: "follow", projection: '{"s":"one"}', expectedKeys: Object.fromEntries(checks.map((check) => [check.teamId, check.keyId])),
  });
  await made.sent;
  return made.value.id;
}

/**
 * A proposal written straight into the database, as the server can: sealed to the owner team's
 * public key with `fromTeamKey` and signed with `signingKey`, both of version `fkv` of team `from`.
 */
async function seedProposal(
  database: MemoryDatabase,
  input: {
    proposalId: string; shareId: string; ownerTeamId: string; autoId: string; fromTeamId: string; baseRevision: string; fkv: number;
    fromTeamKey: TeamKey; signingKey: TeamKeyPair["signingKey"]; diff: string;
  },
): Promise<void> {
  const encKey = encKeyOf(database, input.ownerTeamId);
  const binding = { proposalId: input.proposalId, shareId: input.shareId, ownerTeamId: input.ownerTeamId, fromTeamId: input.fromTeamId, okv: encKey.v, fkv: input.fkv };
  const sealed = await sealProposal({ binding, diffText: input.diff, ownerEncKey: encKey, fromTeamKey: input.fromTeamKey });
  const sig = await signProposal({ binding, context: { autoId: input.autoId, baseRevision: input.baseRevision }, sealed, signingKey: input.signingKey });
  database.seed(`proposals/${input.proposalId}`, {
    shareId: input.shareId, ownerTeamId: input.ownerTeamId, autoId: input.autoId, fromTeamId: input.fromTeamId, baseRevision: input.baseRevision,
    status: "open", createdBy: "someone", createdAt: database.now(), ...sealed, sig,
  });
}

/** A version 2 of `teamId`'s key that the server made, shown as its `teamKeys/2` record. The server holds no key of any team. */
async function serverVersionTwo(database: MemoryDatabase, teamId: string) {
  const fakeOne = await createTeamKeys(teamId);
  const fakeTwo = await rotateTeamKeys(teamId, fakeOne);
  database.seed(`teams/${teamId}/teamKeys/2`, fakeTwo.record as unknown as DocData);
  return fakeTwo;
}

/** What `backend` lists as received for `teamId`: each proposal's sending team and diff, sorted by diff. */
async function received(backend: MemoryBackend, teamId: string): Promise<Array<[string, string]>> {
  return (await backend.listProposals(teamId, "received")).map((proposal): [string, string] => [proposal.fromTeamId, proposal.diff]).sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * A share "from" `fromTeamId` to `toTeamId` that the server made from nothing: a key version 2 of
 * its own for `fromTeamId` (seeded as `teamKeys/2`), a share key wrapped to `toTeamId`'s public key,
 * a manifest signed with the fake version 2 and a device of its own, and an inbox entry.
 */
async function serverMadeShare(
  database: MemoryDatabase,
  input: { shareId: string; fromTeamId: string; toTeamId: string; autoId: string; fake?: Awaited<ReturnType<typeof createTeamKeys>> },
) {
  const fake = input.fake ?? (await serverVersionTwo(database, input.fromTeamId));
  const okv = fake.key.version;
  const device = await generateDeviceKeys();
  const to = encKeyOf(database, input.toTeamId);
  const shareKey = await newShareKey(1);
  const wrap = await wrapShareKeyToTeam({ shareId: input.shareId, teamId: input.toTeamId, shareKey, encKey: to });
  const commit = await commitShareKey({ shareId: input.shareId, shareKey });
  const projection = await sealText(shareKey, '{"server":"projection"}', aadFor.shareProjection({ shareId: input.shareId, autoId: input.autoId, kv: 1 }));
  const expires = new Date(database.now().getTime() + 7 * 86_400_000);
  const body = {
    shareId: input.shareId, ownerTeamId: input.fromTeamId, autoId: input.autoId, revisionId: "r1fake", audience: "teams" as const,
    mode: "follow" as const, level: "view" as const, revoked: false, expiresAtMs: expires.getTime(), seq: 1, skv: 1, wkv: okv, okv,
    device: device.deviceId, termsSeq: 1, termsDevices: [device.deviceId], choice: null,
    projection: await shareProjectionDigest({ shareId: input.shareId, projection }),
    teams: [[input.toTeamId, to.v, await teamKeyDigest({ teamId: input.toTeamId, v: to.v, fingerprint: to.fingerprint, signSpki: to.signSpki })] as const],
    commit,
  };
  const manifest = await signShareManifest({ body, signingKey: fake.pair.signingKey, device });
  const now = database.now();
  database.seed(`shares/${input.shareId}`, {
    ownerTeamId: input.fromTeamId, autoId: input.autoId, revision: "r1fake", audience: "teams", teamIds: [input.toTeamId], level: "view", mode: "follow",
    expiresAt: expires, revokedAt: null, createdBy: "someone", createdAt: now, updatedAt: now,
    projection, keyWraps: { [input.toTeamId]: wrap }, manifest,
  } as unknown as DocData);
  database.seed(`teams/${input.toTeamId}/inbox/${input.shareId}`, { ownerTeamId: input.fromTeamId, createdAt: now } as unknown as DocData);
  return fake;
}

describe("a pin the server planted with a share of its own", () => {
  it("does not anchor a proposal the server made as from that team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const t = await teamWithAuto(database, "tess", 3333, "Third");
    const shareId = await shareTo(o, [p]);
    const amyTrust = new MemoryTrustStore();
    const amy = await join(database, o.owner, o.teamId, "amy", amyTrust);
    expect(readPin(amyTrust, "amy", "partner", t.teamId)).toBeNull();

    // The server, holding no key of any team, makes a share "from" Third to Alpha.
    const fake = await serverMadeShare(database, { shareId: "fakeShareFromThird00000", fromTeamId: t.teamId, toTeamId: o.teamId, autoId: t.autoId });
    const inbox = await amy.listReceivedShares(o.teamId);
    // Opening it pinned the server's key as Third's, on first use and silently, and kept as such.
    expect(inbox.map((share) => share.ownerTeamId)).toContain(t.teamId);
    expect(readPin(amyTrust, "amy", "partner", t.teamId)).toMatchObject({ v: 2, firstUse: true });

    // Now the server writes a proposal "from" Third on Alpha's share to Partner, signed with its key.
    await seedProposal(database, {
      proposalId: "plantedPinProposal000000", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: t.teamId, baseRevision: o.r1, fkv: 2,
      fromTeamKey: fake.key, signingKey: fake.pair.signingKey, diff: '{"server":"chosen change"}',
    });
    // Nothing is listed as Third's, since Third never signed anything.
    expect(await received(amy, o.teamId)).toEqual([]);
  }, LONG);
});

describe("a planted pin of a partner the share names, below the key the manifest names", () => {
  it("does not anchor a proposal the server made as from the partner at that older version", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    // Partner rotates to a real version 2, and Alpha's publish re-keys the share to it (ekv 2).
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    const r2 = await o.owner.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const annTrust = new MemoryTrustStore();
    const ann = await join(database, o.owner, o.teamId, "ann", annTrust);
    expect(readPin(annTrust, "ann", "partner", p.teamId)).toBeNull();

    // The server shows Ann alone a version 1 record of Partner's of its own (Partner is at 2, so
    // version 1 is read from teamKeys/1), and makes a share "from" Partner to Alpha signed with it.
    const fakeOne = await createTeamKeys(p.teamId);
    const realRead = database.read.bind(database);
    database.read = (caller: Caller, path: string) =>
      uidOf(caller) === "ann" && path === `teams/${p.teamId}/teamKeys/1` ? (fakeOne.record as unknown as DocData) : realRead(caller, path);
    await serverMadeShare(database, { shareId: "fakeShareFromPartner0000", fromTeamId: p.teamId, toTeamId: o.teamId, autoId: p.autoId, fake: fakeOne });
    expect((await ann.listReceivedShares(o.teamId)).map((share) => share.ownerTeamId)).toContain(p.teamId);
    expect(readPin(annTrust, "ann", "partner", p.teamId)).toMatchObject({ v: 1, firstUse: true });

    // The server writes a proposal "from" Partner, at version 1, on Alpha's real share to Partner.
    await seedProposal(database, {
      proposalId: "plantedOlderPinProposal0", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: r2.value.id, fkv: 1,
      fromTeamKey: fakeOne.key, signingKey: fakeOne.pair.signingKey, diff: '{"server":"chosen change"}',
    });
    // Partner never signed it, so nothing is listed as Partner's.
    expect(await received(ann, o.teamId)).toEqual([]);
  }, LONG);
});

describe("a pin from a real received share", () => {
  it("anchors nothing until this device shares with that team after being shown its safety code", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const t = await teamWithAuto(database, "tess", 3333, "Third");
    // Alice shares with Partner and Third, Third proposes, and Alice then takes Third off.
    const shareId = await shareTo(o, [p, t]);
    await (await t.owner.sendProposal({ shareId, fromTeamId: t.teamId, baseRevision: o.r1, diff: '{"from":"third"}' })).sent;
    await (await o.owner.setShareTeams(shareId, [p.teamId])).sent;
    // Third really shares an auto of its own with Alpha, and Amy's device opens it.
    const fromThird = await shareTo(t, [o]);
    const amyTrust = new MemoryTrustStore();
    const amy = await join(database, o.owner, o.teamId, "amy", amyTrust, "admin");
    expect((await amy.listReceivedShares(o.teamId)).map((share) => share.id)).toEqual([fromThird]);
    expect(readPin(amyTrust, "amy", "partner", t.teamId)).toMatchObject({ v: 1, firstUse: true });

    // Amy's pin of Third is Third's real key, but nobody on her device checked it: the share dialog
    // shows its code as for a team met for the first time, and it anchors no proposal.
    expect((await amy.checkPartnerKeys([t.teamId]))[0]?.status).toBe("first-use");
    expect(await amy.teamSafetyCode(t.teamId)).toMatchObject({ pinned: false, serverKeyDiffers: false });
    expect(await received(amy, o.teamId)).toEqual([]);
    // Alice shared with Third after seeing its code, so her pin keeps Third's proposal listed.
    expect(await received(o.owner, o.teamId)).toEqual([[t.teamId, '{"from":"third"}']]);

    // Amy shares a second auto with Third, to the key whose code she was shown: now it is checked.
    const second = await amy.createAuto(o.teamId, { title: "Second" });
    await second.sent;
    const secondRev = await amy.publishRevision({ teamId: o.teamId, autoId: second.value.id, baseRevision: null, content: '{"s":"x"}' });
    await secondRev.sent;
    const shown = (await amy.checkPartnerKeys([t.teamId]))[0]!;
    await (await amy.createShare({
      teamId: o.teamId, autoId: second.value.id, revision: secondRev.value.id, audience: "teams", teamIds: [t.teamId], level: "propose", projection: '{"s":"x"}',
      expectedKeys: { [t.teamId]: shown.keyId },
    })).sent;
    expect(readPin(amyTrust, "amy", "partner", t.teamId)?.firstUse).toBeUndefined();
    expect((await amy.checkPartnerKeys([t.teamId]))[0]?.status).toBe("same");
    expect(await amy.teamSafetyCode(t.teamId)).toMatchObject({ pinned: true, serverKeyDiffers: false });
    expect(await received(amy, o.teamId)).toEqual([[t.teamId, '{"from":"third"}']]);
  }, LONG);

  it("stays first use when it moves forward by the team's signed rotation, and so do the earlier pins it keeps", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    await (await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"before":"rotation"}' })).sent;
    // Partner shares an auto of its own with Alpha, following its latest version, and Amy opens it.
    const fromPartner = await shareTo(p, [o]);
    const amyTrust = new MemoryTrustStore();
    const amy = await join(database, o.owner, o.teamId, "amy", amyTrust);
    expect((await amy.listReceivedShares(o.teamId)).map((share) => share.id)).toEqual([fromPartner]);
    expect(readPin(amyTrust, "amy", "partner", p.teamId)).toMatchObject({ v: 1, firstUse: true });

    // Partner rotates, and its next publish signs its share with its version 2, which Amy opens.
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    const pr2 = await p.owner.publishRevision({ teamId: p.teamId, autoId: p.autoId, baseRevision: p.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await pr2.sent;
    expect((await amy.listReceivedShares(o.teamId))[0]?.projection).toBe('{"s":"two"}');
    expect(readPin(amyTrust, "amy", "partner", p.teamId)).toMatchObject({ v: 2, firstUse: true });
    expect(readEarlierPartnerPins(amyTrust, "amy", p.teamId)).toMatchObject([{ v: 1, firstUse: true }]);

    // Alice's publish re-keys her share to Partner's version 2, and Partner proposes again.
    const r2 = await o.owner.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    await (await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"after":"rotation"}' })).sent;

    // Alice's earlier pin of version 1 was checked when she shared, so it still reaches the older proposal.
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}'], [p.teamId, '{"before":"rotation"}']]);
    // Amy's was only trusted on first use, so only the manifest anchors, and it names version 2.
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}']]);
  }, LONG);

  it("is not made checked by a first share made without a shown key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await (await o.owner.createShare({
      teamId: o.teamId, autoId: o.autoId, revision: o.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"s":"one"}',
    })).sent;
    expect((await o.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("first-use");
    expect(await o.owner.teamSafetyCode(p.teamId)).toMatchObject({ pinned: false });
  }, LONG);
});

describe("the trust a partner pin carries", () => {
  const key = (v: number, fill: number) => ({ v, fingerprint: new Uint8Array(32).fill(fill), signSpki: new Uint8Array(91).fill(fill) });

  it("becomes checked when a checked write names the same key, and a first-use write never takes that back", () => {
    const store = new MemoryTrustStore();
    writePartnerPin(store, "u", "t", key(1, 1), "first-use");
    expect(readPin(store, "u", "partner", "t")).toEqual({ ...key(1, 1), firstUse: true });
    writePartnerPin(store, "u", "t", key(1, 1), "checked");
    expect(readPin(store, "u", "partner", "t")).toEqual(key(1, 1));
    writePartnerPin(store, "u", "t", key(1, 1), "first-use");
    expect(readPin(store, "u", "partner", "t")).toEqual(key(1, 1));
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([]);
  });

  it("keeps each earlier pin with the trust it had", () => {
    const store = new MemoryTrustStore();
    writePartnerPin(store, "u", "t", key(1, 1), "first-use");
    writePartnerPin(store, "u", "t", key(2, 2), "first-use");
    writePartnerPin(store, "u", "t", key(3, 3), "checked");
    writePartnerPin(store, "u", "t", key(4, 4), "checked");
    expect(readEarlierPartnerPins(store, "u", "t")).toEqual([{ ...key(1, 1), firstUse: true }, { ...key(2, 2), firstUse: true }, key(3, 3)]);
    expect(readPin(store, "u", "partner", "t")).toEqual(key(4, 4));
  });

  it("reads a pin stored without its trust as first use", () => {
    const store = new MemoryTrustStore();
    const stored = { v: 1, fp: "A".repeat(43), sk: "A".repeat(122) };
    store.set("zenith.pin.partner.u.t", JSON.stringify(stored));
    store.set("zenith.pin.partner-was.u.t", JSON.stringify([stored]));
    expect(readPin(store, "u", "partner", "t")?.firstUse).toBe(true);
    expect(readEarlierPartnerPins(store, "u", "t")[0]?.firstUse).toBe(true);
  });
});
