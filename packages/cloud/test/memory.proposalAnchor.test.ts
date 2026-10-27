/**
 * Which key a received proposal's signature is checked with. The owner team's device takes the
 * proposing team's signing key only from the share the proposal is on: the share must be the owner
 * team's own, its manifest (checked with the owner team's own key chain) must name the proposing
 * team, and the key must be the one that manifest names for it, or a newer one reached from it by
 * that team's signed rotations. A pin of the proposing team is checked on top, and is the only way to
 * reach a key older than the one the manifest names. Before this, a device with no pin of the
 * proposing team trusted whatever key the server showed, so the server alone could make a proposal
 * that another member's device, or the sharer's own for a team never on the share, listed as real.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryDeviceKeyStore,
  createTeamKeys,
  rotateTeamKeys,
  sealProposal,
  signProposal,
  type TeamEncKey,
  type TeamKey,
  type TeamKeyPair,
} from "../src/crypto/index.js";
import { type KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore, readPin } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
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
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
async function join(database: MemoryDatabase, approver: MemoryBackend, teamId: string, uid: string, trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const member = await person(database, uid, trust);
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
type Team = Awaited<ReturnType<typeof teamWithAuto>>;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;
const fromWrapKv = (database: MemoryDatabase, proposalId: string) => ((database.peek(`proposals/${proposalId}`) as DocData)["fromWrap"] as { kv: number }).kv;

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

describe("a proposal the server made with a partner key of its own (the review's reproduction)", () => {
  it("is not listed by another member of the owner team, whose device never pinned the partner", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    const honest = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"honest":"change"}' });
    await honest.sent;
    const amyTrust = new MemoryTrustStore();
    const amy = await join(database, o.owner, o.teamId, "amy", amyTrust);
    expect(readPin(amyTrust, "amy", "partner", p.teamId)).toBeNull();

    const fake = await serverVersionTwo(database, p.teamId);
    await seedProposal(database, {
      proposalId: "forgedAnchorProposal0000", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, fkv: 2,
      fromTeamKey: fake.key, signingKey: fake.pair.signingKey, diff: '{"server":"chosen change"}',
    });

    // The manifest names Partner's version 1, and the server's version 2 is not signed from it.
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
    // Listing pins nothing.
    expect(readPin(amyTrust, "amy", "partner", p.teamId)).toBeNull();
  }, LONG);

  it("is not listed by the sharer's own device as from a team the share was never made to", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const shareId = await shareTo(o, [p]);
    const fake = await serverVersionTwo(database, q.teamId);
    await seedProposal(database, {
      proposalId: "forgedAnchorProposal0001", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: q.teamId, baseRevision: o.r1, fkv: 2,
      fromTeamKey: fake.key, signingKey: fake.pair.signingKey, diff: '{"server":"chosen change"}',
    });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);
});

describe("a proposal really signed by a team, on a share it does not belong to", () => {
  it("is not listed when the share it names was not made to that team, on a device that never pinned the team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const toPartner = await shareTo(o, [p]);
    // Alpha also shares with Third, so Alice's device pinned Third's real key.
    await shareTo(o, [q]);
    expect(readPin(keysOfTrust(o.owner), "alice", "partner", q.teamId)).not.toBeNull();
    // Third's own key signs a proposal "on" the share made to Partner alone.
    const third = await keysOf(q.owner).openTeam(q.teamId, { extractable: true });
    await seedProposal(database, {
      proposalId: "offShareAnchorProposal00", shareId: toPartner, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: q.teamId, baseRevision: o.r1, fkv: 1,
      fromTeamKey: third.newest.key, signingKey: third.newest.pair.signingKey, diff: '{"third":"change"}',
    });
    // The manifest does not name Third, so a device with no pin of Third has nothing to anchor it.
    const amy = await join(database, o.owner, o.teamId, "amy");
    expect(await received(amy, o.teamId)).toEqual([]);
    // Alice's pin anchors Third's key, as it anchors a team taken off a share: the signature is
    // really Third's, and it is listed as Third's.
    expect(await received(o.owner, o.teamId)).toEqual([[q.teamId, '{"third":"change"}']]);
  }, LONG);

  it("is not listed when the share it names belongs to another team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const b = await teamWithAuto(database, "bea", 4444, "Beta");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await shareTo(o, [p]); // Alice's device pinned Partner.
    const betaShare = await shareTo(b, [p]);
    // Partner's own key signs a proposal to Alpha that names Beta's share, which is made to Partner.
    const partner = await keysOf(p.owner).openTeam(p.teamId, { extractable: true });
    await seedProposal(database, {
      proposalId: "otherOwnerAnchorProposal", shareId: betaShare, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, fkv: 1,
      fromTeamKey: partner.newest.key, signingKey: partner.newest.pair.signingKey, diff: '{"moved":"share"}',
    });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);

  it("is not listed when it is for an auto other than the one the share shows", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    const other = await o.owner.createAuto(o.teamId, { title: "Not shared" });
    await other.sent;
    const partner = await keysOf(p.owner).openTeam(p.teamId, { extractable: true });
    await seedProposal(database, {
      proposalId: "otherAutoAnchorProposal0", shareId, ownerTeamId: o.teamId, autoId: other.value.id, fromTeamId: p.teamId, baseRevision: o.r1, fkv: 1,
      fromTeamKey: partner.newest.key, signingKey: partner.newest.pair.signingKey, diff: '{"unseen":"auto"}',
    });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);
});

describe("an honest proposal", () => {
  it("is listed by another member of the owner team whose device never pinned the partner", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    const sent = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"honest":"change"}' });
    await sent.sent;
    const amy = await join(database, o.owner, o.teamId, "amy");
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"honest":"change"}']]);
  }, LONG);

  it("is listed on each share it was sent on when one owner team shares with two teams", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const shareId = await shareTo(o, [p, q]);
    for (const [team, diff] of [[p, '{"from":"partner"}'], [q, '{"from":"third"}'], [p, '{"from":"partner again"}']] as const) {
      await (await team.owner.sendProposal({ shareId, fromTeamId: team.teamId, baseRevision: o.r1, diff })).sent;
    }
    const amy = await join(database, o.owner, o.teamId, "amy");
    const expected: Array<[string, string]> = [[p.teamId, '{"from":"partner again"}'], [p.teamId, '{"from":"partner"}'], [q.teamId, '{"from":"third"}']];
    expect(await received(amy, o.teamId)).toEqual(expected);
    expect(await received(o.owner, o.teamId)).toEqual(expected);
  }, LONG);
});

describe("proposals around the partner team's rotation", () => {
  /** Partner sends one proposal at its version 1, then removes a member, which rotates it to version 2. */
  async function rotatedAfterOne() {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    const before = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"before":"rotation"}' });
    await before.sent;
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    expect(encKeyOf(database, p.teamId).v).toBe(2);
    return { database, o, p, shareId };
  }

  it("lists a proposal at the partner's newer key, reached from the key the manifest names, on a device that never pinned the partner", async () => {
    const { database, o, p, shareId } = await rotatedAfterOne();
    const amy = await join(database, o.owner, o.teamId, "amy");
    // The share still names Partner's version 1, so Partner's app sends nothing now; a proposal at
    // version 2, signed with Partner's real version 2 key, is reached from the manifest's key.
    const partner = await keysOf(p.owner).openTeam(p.teamId, { extractable: true });
    expect(partner.newest.key.version).toBe(2);
    await seedProposal(database, {
      proposalId: "forwardAnchorProposal000", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, fkv: 2,
      fromTeamKey: partner.newest.key, signingKey: partner.newest.pair.signingKey, diff: '{"after":"rotation"}',
    });
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}'], [p.teamId, '{"before":"rotation"}']]);
  }, LONG);

  it("lists the newer proposal once the share is re-keyed, and the older one only on devices that pinned the partner's older key", async () => {
    const { database, o, p, shareId } = await rotatedAfterOne();
    const amy = await join(database, o.owner, o.teamId, "amy");
    // Amy's publish re-keys the share to Partner's version 2, and Partner proposes again.
    const r2 = await amy.publishRevision({ teamId: o.teamId, autoId: o.autoId, baseRevision: o.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const after = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"after":"rotation"}' });
    await after.sent;
    expect(fromWrapKv(database, after.value.id)).toBe(2);

    // Alice pinned Partner's version 1 when she shared, so both are checked.
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}'], [p.teamId, '{"before":"rotation"}']]);
    // A device that never pinned the partner is anchored by the manifest alone, which now names
    // version 2; signatures only reach forward, so the proposal signed at version 1 is not listed.
    const ann = await join(database, o.owner, o.teamId, "ann");
    expect(await received(ann, o.teamId)).toEqual([[p.teamId, '{"after":"rotation"}']]);
  }, LONG);

  it("does not list a proposal at a key the manifest's key reaches when this device pinned a different key there", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const pete = await join(database, p.owner, p.teamId, "pete");
    const shareId = await shareTo(o, [p]);
    // Pete keeps Partner's version 1 key, and Partner removes him, which rotates to a real version 2.
    const kept = await keysOf(pete).openTeam(p.teamId, { extractable: true });
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    // Alice shares a second auto with Partner, which pins Partner's real version 2 on her device.
    const second = await o.owner.createAuto(o.teamId, { title: "Second" });
    await second.sent;
    const secondRev = await o.owner.publishRevision({ teamId: o.teamId, autoId: second.value.id, baseRevision: null, content: '{"s":"x"}' });
    await secondRev.sent;
    const check = (await o.owner.checkPartnerKeys([p.teamId]))[0]!;
    await (await o.owner.createShare({
      teamId: o.teamId, autoId: second.value.id, revision: secondRev.value.id, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"s":"x"}',
      expectedKeys: { [p.teamId]: check.keyId },
    })).sent;
    expect(readPin(keysOfTrust(o.owner), "alice", "partner", p.teamId)?.v).toBe(2);

    // Pete forks version 2 from the version 1 key he kept, the server shows the fork, and Pete signs
    // a proposal on the first share, which still names Partner's version 1.
    const fork = await rotateTeamKeys(p.teamId, kept.newest);
    database.seed(`teams/${p.teamId}`, { ...(database.peek(`teams/${p.teamId}`) as DocData), encKey: fork.encKey });
    database.seed(`teams/${p.teamId}/teamKeys/2`, fork.record as unknown as DocData);
    await seedProposal(database, {
      proposalId: "forkedAnchorProposal0000", shareId, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId, baseRevision: o.r1, fkv: 2,
      fromTeamKey: fork.key, signingKey: fork.pair.signingKey, diff: '{"pete":"fork"}',
    });
    // Alice's pin of the real version 2 is checked on top of the manifest's anchor.
    expect(await received(o.owner, o.teamId)).toEqual([]);
    // A device with no pin of Partner follows the fork: the known limit of a fork a team's partners
    // cannot see.
    const amy = await join(database, o.owner, o.teamId, "amy");
    expect(await received(amy, o.teamId)).toEqual([[p.teamId, '{"pete":"fork"}']]);
  }, LONG);
});

describe("a share that cannot anchor a proposal", () => {
  it("lists nothing for a proposal whose share is missing", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await shareTo(o, [p]);
    const partner = await keysOf(p.owner).openTeam(p.teamId, { extractable: true });
    await seedProposal(database, {
      proposalId: "noShareAnchorProposal000", shareId: "noSuchShare000000000000", ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId,
      baseRevision: o.r1, fkv: 1, fromTeamKey: partner.newest.key, signingKey: partner.newest.pair.signingKey, diff: '{"no":"share"}',
    });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);

  it("lists a team's proposals after it is taken off the share only on devices that pinned the team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const shareId = await shareTo(o, [p, q]);
    await (await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"from":"partner"}' })).sent;
    await (await q.owner.sendProposal({ shareId, fromTeamId: q.teamId, baseRevision: o.r1, diff: '{"from":"third"}' })).sent;
    expect(await received(o.owner, o.teamId)).toHaveLength(2);
    await (await o.owner.setShareTeams(shareId, [q.teamId])).sent;
    // Alice pinned Partner when she shared, and that pin still anchors Partner's key.
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"from":"partner"}'], [q.teamId, '{"from":"third"}']]);
    // The manifest no longer names Partner, so a device with no pin of Partner lists only Third's.
    const amy = await join(database, o.owner, o.teamId, "amy");
    expect(await received(amy, o.teamId)).toEqual([[q.teamId, '{"from":"third"}']]);
  }, LONG);

  it("lists a revoked share's proposals until the owner team's key next changes, since no rotation lists a revoked share", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const shareId = await shareTo(o, [p]);
    await (await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: o.r1, diff: '{"from":"partner"}' })).sent;
    await (await o.owner.revokeShare(shareId)).sent;
    expect(await received(o.owner, o.teamId)).toEqual([[p.teamId, '{"from":"partner"}']]);
    await join(database, o.owner, o.teamId, "mia");
    await (await o.owner.removeMember(o.teamId, "mia")).sent;
    expect(encKeyOf(database, o.teamId).v).toBe(2);
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);

  it("lists nothing for a proposal on a link share, which names no teams", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await shareTo(o, [p]);
    const link = await o.owner.createShare({ teamId: o.teamId, autoId: o.autoId, revision: o.r1, audience: "link", projection: '{"s":"one"}' });
    await link.sent;
    const partner = await keysOf(p.owner).openTeam(p.teamId, { extractable: true });
    await seedProposal(database, {
      proposalId: "linkShareAnchorProposal0", shareId: link.value.id, ownerTeamId: o.teamId, autoId: o.autoId, fromTeamId: p.teamId,
      baseRevision: o.r1, fkv: 1, fromTeamKey: partner.newest.key, signingKey: partner.newest.pair.signingKey, diff: '{"link":"share"}',
    });
    expect(await received(o.owner, o.teamId)).toEqual([]);
  }, LONG);
});

function keysOfTrust(backend: MemoryBackend): MemoryTrustStore {
  return (backend as unknown as { trust: MemoryTrustStore }).trust;
}
