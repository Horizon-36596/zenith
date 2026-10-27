/**
 * Proposal keys. A proposal is for the team that owns the share, but the share key is held by every
 * team the share was made to, so a proposal is sealed under a key of its own, wrapped to the owner
 * team's verified public key and sealed under the proposing team's key. These tests hand the stored
 * proposal to someone with every key she could hold, as a server could, and check that only the two
 * teams of the proposal read it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aadFor,
  createTeamKeys,
  MemoryDeviceKeyStore,
  openProposalAsOwner,
  openProposalAsSender,
  sealProposal,
  teamEncKeyFor,
  unwrapShareKeyAsOwner,
  unwrapShareKeyAsTeam,
  type Envelope,
  type ProposalBinding,
  type ShareKey,
  type ShareKeyWrap,
} from "../src/crypto/index.js";
import { isCloudError } from "../src/errors.js";
import { teamKeyAt, teamPairAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { proposalWithKeys, rejectsWith, type StoredProposal } from "./cryptoHelpers.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
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
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: `{"secret":"${name} one"}` });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}
const keyVersion = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: { v: number } }).encKey.v;
const proposalDoc = (database: MemoryDatabase, proposalId: string) => database.peek(`proposals/${proposalId}`) as unknown as StoredProposal;
const shareDocOf = (database: MemoryDatabase, shareId: string) =>
  database.peek(`shares/${shareId}`) as unknown as { projection: Envelope; keyWraps: Record<string, ShareKeyWrap> };
const diffsOf = (proposals: { diff: string }[]) => proposals.map((p) => p.diff).sort();

/** The share key a team on the share holds, opened with its keys from the wrap the share gives it. */
async function shareKeyOf(database: MemoryDatabase, shareId: string, teamId: string, keys: OpenedTeam): Promise<ShareKey> {
  const doc = shareDocOf(database, shareId);
  const wrap = doc.keyWraps[teamId] as ShareKeyWrap;
  return unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: doc.projection.kv, wrap, pair: teamPairAt(keys, wrap.ekv) });
}

/** Alpha shares its auto with Bravo and Charlie at propose level, and Bravo sends Alpha a proposal. */
async function threeTeams() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const b = await teamWithAuto(database, "bea", 2222, "Bravo");
  const c = await teamWithAuto(database, "cai", 3333, "Charlie");
  const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [b.teamId, c.teamId], level: "propose", mode: "pinned", projection: '{"v":"Y"}' });
  await share.sent;
  const shareId = share.value.id;
  const sent = await b.owner.sendProposal({ shareId, fromTeamId: b.teamId, baseRevision: a.r1, diff: '{"bravo":"our secret plan"}' });
  await sent.sent;
  return { database, a, b, c, shareId, proposalId: sent.value.id };
}

describe("proposals on a share to several teams", () => {
  it("a third team on the share cannot read the proposal another team sent, with every key it holds, even when the server hands it the proposal", async () => {
    const { database, a, c, shareId, proposalId } = await threeTeams();
    // Charlie opens the share normally, as it may, so it holds the share key.
    expect((await c.owner.getShare(shareId))?.projection).toBe('{"v":"Y"}');
    const cKeys = await keysOf(c.owner).openTeam(c.teamId);
    const shareKey = await shareKeyOf(database, shareId, c.teamId, cKeys);
    // The server hands Charlie Bravo's proposal document.
    expect(await proposalWithKeys(proposalId, proposalDoc(database, proposalId), { chain: cKeys.chain, shareKey })).toBe(null);
    // The same attempts with Alpha's keys read it, so the null above is Charlie's keys failing.
    const aKeys = await keysOf(a.owner).openTeam(a.teamId);
    expect(await proposalWithKeys(proposalId, proposalDoc(database, proposalId), { chain: aKeys.chain })).toBe('{"bravo":"our secret plan"}');
    // Nor does the server's list of what Charlie sent or received show it.
    expect(await c.owner.listProposals(c.teamId, "received")).toEqual([]);
    expect(await c.owner.listProposals(c.teamId, "sent")).toEqual([]);
  }, 60_000);

  it("the team that owns the share reads the proposal, through its key pair of the version the proposal key was wrapped to", async () => {
    const { database, a, proposalId } = await threeTeams();
    expect(proposalDoc(database, proposalId).ownerWrap?.ekv).toBe(keyVersion(database, a.teamId));
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"bravo":"our secret plan"}']);
  }, 60_000);

  it("the team that sent the proposal reads what it sent, also after the share is revoked", async () => {
    const { database, a, b, shareId, proposalId } = await threeTeams();
    expect(proposalDoc(database, proposalId).fromWrap?.kv).toBe(keyVersion(database, b.teamId));
    expect(diffsOf(await b.owner.listProposals(b.teamId, "sent"))).toEqual(['{"bravo":"our secret plan"}']);
    await (await a.owner.revokeShare(shareId)).sent;
    expect(diffsOf(await b.owner.listProposals(b.teamId, "sent"))).toEqual(['{"bravo":"our secret plan"}']);
  }, 60_000);

  it("a proposal whose wraps the server swaps with another proposal's opens for neither team", async () => {
    const { database, a, b, shareId, proposalId } = await threeTeams();
    const second = await b.owner.sendProposal({ shareId, fromTeamId: b.teamId, baseRevision: a.r1, diff: '{"bravo":"second"}' });
    await second.sent;
    const other = proposalDoc(database, second.value.id);
    const doc = database.peek(`proposals/${proposalId}`) as Record<string, unknown>;
    database.seed(`proposals/${proposalId}`, { ...doc, ownerWrap: other.ownerWrap, fromWrap: other.fromWrap });
    // The owner team does not list it at all: its signature no longer covers the wraps it carries.
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"bravo":"second"}']);
    await expect(b.owner.listProposals(b.teamId, "sent")).rejects.toSatisfy((error: unknown) => isCloudError(error, "tampered"));
  }, 60_000);

  it("refuses a proposal in the format from before each proposal had its own key", async () => {
    const { database, a, b, proposalId } = await threeTeams();
    const doc = database.peek(`proposals/${proposalId}`) as Record<string, unknown> & { ownerWrap: ShareKeyWrap };
    const { ownerWrap, ...rest } = doc;
    // The old format: no owner wrap, and the share key's wrap to the proposing team as fromWrap.
    database.seed(`proposals/${proposalId}`, { ...rest, fromWrap: ownerWrap });
    await expect(a.owner.listProposals(a.teamId, "received")).rejects.toThrow(/format from before each proposal had its own key/);
    await expect(b.owner.listProposals(b.teamId, "sent")).rejects.toThrow(/format from before each proposal had its own key/);
  }, 60_000);
});

describe("proposals after the owner team's key changes", () => {
  it("the owner team still opens proposals sent before it rotated its key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const b = await teamWithAuto(database, "bea", 2222, "Bravo");
    await join(database, a.owner, a.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [b.teamId], level: "propose", projection: '{"v":"Y"}' });
    await share.sent;
    const sent = await b.owner.sendProposal({ shareId: share.value.id, fromTeamId: b.teamId, baseRevision: a.r1, diff: '{"n":1}' });
    await sent.sent;
    const kv = keyVersion(database, a.teamId);
    expect(proposalDoc(database, sent.value.id).ownerWrap?.ekv).toBe(kv);
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    expect(keyVersion(database, a.teamId)).toBe(kv + 1);
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"n":1}']);
    expect(diffsOf(await b.owner.listProposals(b.teamId, "sent"))).toEqual(['{"n":1}']);
  }, 60_000);

  it("a member removed from the owner team, holding its old key, cannot read a proposal sent after the owner team rotated", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const b = await teamWithAuto(database, "bea", 2222, "Bravo");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [b.teamId], level: "propose", projection: '{"v":"Y"}' });
    await share.sent;
    const shareId = share.value.id;
    // What Eve keeps while she is a member: her team's keys, and through them the share key.
    const eveKeys = await keysOf(eve).openTeam(a.teamId);
    const kept = database.peek(`shares/${shareId}`) as unknown as { projection: Envelope; ownerWrap: Envelope };
    const eveShareKey = await unwrapShareKeyAsOwner({ shareId, teamId: a.teamId, shareKeyVersion: kept.projection.kv, wrap: kept.ownerWrap, teamKey: teamKeyAt(eveKeys, kept.ownerWrap.kv) });
    const kv = keyVersion(database, a.teamId);
    // The device that removes Eve goes away before it carries the share forward to the new key.
    vi.spyOn(a.owner, "carryForwardShares").mockResolvedValue({ carried: [], left: [] });
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    expect(keyVersion(database, a.teamId)).toBe(kv + 1);
    // Bravo sees Alpha's newer key and wraps to nothing older: it refuses until Alpha updates the share.
    const propose = () => b.owner.sendProposal({ shareId, fromTeamId: b.teamId, baseRevision: a.r1, diff: '{"secret":"after removal"}' });
    const refused = await propose().then(() => null, (error: unknown) => error);
    expect(isCloudError(refused, "conflict")).toBe(true);
    await (await a.owner.updateShare(shareId, { revision: a.r1, projection: '{"v":"Y again"}' })).sent;
    const sent = await propose();
    await sent.sent;
    // The proposal key is wrapped to Alpha's newest verified key, which Eve never held.
    const doc = proposalDoc(database, sent.value.id);
    expect(doc.ownerWrap?.ekv).toBe(kv + 1);
    expect(eveKeys.chain.has(kv + 1)).toBe(false);
    expect(await proposalWithKeys(sent.value.id, doc, { chain: eveKeys.chain, shareKey: eveShareKey })).toBe(null);
    expect(await proposalWithKeys(sent.value.id, doc, { chain: (await keysOf(a.owner).openTeam(a.teamId)).chain })).toBe('{"secret":"after removal"}');
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"secret":"after removal"}']);
  }, 60_000);
});

describe("sealProposal", () => {
  const binding: ProposalBinding = { proposalId: "p1", shareId: "s1", ownerTeamId: "owner", fromTeamId: "from", okv: 3, fkv: 5 };

  async function sealed() {
    const owner = await createTeamKeys("owner");
    const from = await createTeamKeys("from");
    const ownerPair = { ...owner.pair, version: 3 };
    const fromKey = { ...from.key, version: 5 };
    const ownerEncKey = { ...teamEncKeyFor(owner.pair), v: 3, sig: new Uint8Array(64) };
    const proposal = await sealProposal({ binding, diffText: '{"n":1}', ownerEncKey, fromTeamKey: fromKey });
    return { proposal, ownerPair, fromKey };
  }

  it("opens for the owner team's key pair and the proposing team's key, and for nothing bound otherwise", async () => {
    const { proposal, ownerPair, fromKey } = await sealed();
    expect(proposal.diff.kv).toBe(1);
    expect(proposal.ownerWrap.ekv).toBe(3);
    expect(proposal.fromWrap.kv).toBe(5);
    expect(await openProposalAsOwner({ binding, diff: proposal.diff, ownerWrap: proposal.ownerWrap, pair: ownerPair })).toBe('{"n":1}');
    expect(await openProposalAsSender({ binding, diff: proposal.diff, fromWrap: proposal.fromWrap, teamKey: fromKey })).toBe('{"n":1}');
    for (const moved of [{ proposalId: "p2" }, { shareId: "s2" }, { ownerTeamId: "other" }, { fromTeamId: "other" }]) {
      await rejectsWith(openProposalAsOwner({ binding: { ...binding, ...moved }, diff: proposal.diff, ownerWrap: proposal.ownerWrap, pair: ownerPair }), "decrypt-failed");
      await rejectsWith(openProposalAsSender({ binding: { ...binding, ...moved }, diff: proposal.diff, fromWrap: proposal.fromWrap, teamKey: fromKey }), "decrypt-failed");
    }
    await rejectsWith(openProposalAsOwner({ binding: { ...binding, fkv: 4 }, diff: proposal.diff, ownerWrap: proposal.ownerWrap, pair: ownerPair }), "decrypt-failed");
    await rejectsWith(openProposalAsSender({ binding: { ...binding, okv: 2 }, diff: proposal.diff, fromWrap: proposal.fromWrap, teamKey: fromKey }), "decrypt-failed");
    await rejectsWith(openProposalAsOwner({ binding: { ...binding, okv: 2 }, diff: proposal.diff, ownerWrap: proposal.ownerWrap, pair: ownerPair }), "bad-envelope");
    await rejectsWith(openProposalAsOwner({ binding, diff: proposal.diff, ownerWrap: proposal.ownerWrap, pair: { ...ownerPair, version: 2 } }), "wrong-key-version");
    await rejectsWith(openProposalAsSender({ binding, diff: proposal.diff, fromWrap: proposal.fromWrap, teamKey: { ...fromKey, version: 4 } }), "wrong-key-version");
  });

  it("wraps only to the key versions its binding names", async () => {
    const owner = await createTeamKeys("owner");
    const from = await createTeamKeys("from");
    await rejectsWith(sealProposal({ binding: { ...binding, okv: 1, fkv: 2 }, diffText: "{}", ownerEncKey: owner.encKey, fromTeamKey: from.key }), "bad-input");
    await rejectsWith(sealProposal({ binding: { ...binding, okv: 2, fkv: 1 }, diffText: "{}", ownerEncKey: owner.encKey, fromTeamKey: from.key }), "bad-input");
    expect(aadFor.proposalDiff(binding)).toBe("zenith/v1/proposal-diff|proposal=p1|share=s1|owner=owner|from=from|okv=3|fkv=5");
  });
});
