/**
 * A share's key after a team key it is wrapped under changes. Removing a member or revoking a device
 * rotates that team's key, and whoever was taken off keeps the old one, so the next thing the
 * sharing team seals under the share moves the share to a new key, and a partner seals nothing
 * under the old one.
 */
import { describe, expect, it } from "vitest";
import { aadFor, bytesEqual, MemoryDeviceKeyStore, openText, unwrapShareKeyAsOwner, type Envelope, type ShareKeyWrap } from "../src/crypto/index.js";
import { isCloudError } from "../src/errors.js";
import { teamKeyAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { proposalWithKeys, type StoredProposal } from "./cryptoHelpers.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function person(database: MemoryDatabase, uid: string, deviceKeys = new MemoryDeviceKeyStore(), trust = new MemoryTrustStore()): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys, trust });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
const keysOf = (backend: MemoryBackend): KeyRing => (backend as unknown as { keys: KeyRing }).keys;
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

interface ShareDocLike {
  autoId: string;
  projection: Envelope;
  ownerWrap: Envelope & { kv: number };
  keyWraps: Record<string, ShareKeyWrap>;
  prevKeys?: Record<string, Envelope>;
}
const shareDocOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as unknown as ShareDocLike;

/** What someone holding the owner team's old keys reads of a share's projection, or null. */
async function projectionWithOwnerKeys(database: MemoryDatabase, shareId: string, teamId: string, keys: OpenedTeam): Promise<string | null> {
  const doc = shareDocOf(database, shareId);
  try {
    const shareKey = await unwrapShareKeyAsOwner({ shareId, teamId, shareKeyVersion: doc.projection.kv, wrap: doc.ownerWrap, teamKey: teamKeyAt(keys, doc.ownerWrap.kv) });
    return await openText(shareKey, doc.projection, aadFor.shareProjection({ shareId, autoId: doc.autoId, kv: shareKey.version }));
  } catch {
    return null;
  }
}

/** What someone holding a partner team's old keys reads of a proposal it sent, through any key she holds, or null. */
async function proposalWithTeamKeys(database: MemoryDatabase, proposalId: string, keys: OpenedTeam): Promise<string | null> {
  return proposalWithKeys(proposalId, database.peek(`proposals/${proposalId}`) as unknown as StoredProposal, { chain: keys.chain });
}

const diffsOf = (proposals: { diff: string }[]) => proposals.map((p) => p.diff).sort();

describe("a share's key after a team key it is wrapped under changes", () => {
  it("a member removed from the sharing team cannot read what a following share shows after her removal", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"before"}' });
    await share.sent;
    // What Eve keeps while she is a member: her team key.
    const eveKeys: OpenedTeam = await keysOf(eve).openTeam(a.teamId);
    const kv = keyVersion(database, a.teamId);
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    expect(keyVersion(database, a.teamId)).toBe(kv + 1);
    // Alice publishes after the removal, and her following share moves to the new revision.
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"after removal"}', followProjection: '{"secret":"after removal"}' });
    await r2.sent;
    // The server hands Eve the share document.
    expect(await projectionWithOwnerKeys(database, share.value.id, a.teamId, eveKeys)).not.toBe('{"secret":"after removal"}');
  }, 60_000);

  it("a member removed from a partner team cannot read a proposal her team sends after removing her", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const eve = await join(database, p.owner, p.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"before"}' });
    await share.sent;
    const eveKeys: OpenedTeam = await keysOf(eve).openTeam(p.teamId);
    const kv = keyVersion(database, p.teamId);
    // Olga, an owner of the partner team, removes Eve; her device rotated and pinned kv + 1.
    await (await p.owner.removeMember(p.teamId, "eve")).sent;
    expect(keyVersion(database, p.teamId)).toBe(kv + 1);
    // A proposal that is refused is safe; one that is sent must be closed to Eve.
    const sent = await p.owner
      .sendProposal({ shareId: share.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"secret":"proposed after removal"}' })
      .then(async (queued) => {
        await queued.sent;
        return queued.value.id;
      })
      .catch(() => null);
    if (sent !== null) expect(await proposalWithTeamKeys(database, sent, eveKeys)).not.toBe('{"secret":"proposed after removal"}');
  }, 60_000);

  it("a partner refuses to send a proposal under a stale share key, and sends it once the sharing team updates the share", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const eve = await join(database, p.owner, p.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"v":"before"}' });
    await share.sent;
    const eveKeys = await keysOf(eve).openTeam(p.teamId);
    await (await p.owner.removeMember(p.teamId, "eve")).sent;
    const propose = () => p.owner.sendProposal({ shareId: share.value.id, fromTeamId: p.teamId, baseRevision: a.r1, diff: '{"secret":"proposed after removal"}' });
    const refused = await propose().then(() => null, (error: unknown) => error);
    expect(isCloudError(refused, "conflict")).toBe(true);
    expect((refused as Error).message).toMatch(/Ask the team that shared this auto to update the share/);
    expect(database.peek(`shares/${share.value.id}`)).toMatchObject({ projection: { kv: 1 } });
    // The sharing team updates the share, which re-keys it to the partner's new public key.
    await (await a.owner.updateShare(share.value.id, { revision: a.r1, projection: '{"v":"refreshed"}' })).sent;
    const doc = shareDocOf(database, share.value.id);
    expect(doc.projection.kv).toBe(2);
    expect(doc.keyWraps[p.teamId]?.ekv).toBe(keyVersion(database, p.teamId));
    const sent = await propose();
    await sent.sent;
    expect(await proposalWithTeamKeys(database, sent.value.id, eveKeys)).toBe(null);
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"secret":"proposed after removal"}']);
  }, 60_000);

  it("the sharing team and the partner still open revisions and proposals made before a re-key", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    await join(database, a.owner, a.teamId, "eve");
    await join(database, p.owner, p.teamId, "mallory");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    const propose = async (baseRevision: string, diff: string) => {
      const sent = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision, diff });
      await sent.sent;
    };
    await propose(a.r1, '{"n":1}');

    // The sharing team removes a member, then publishes: the share moves to key 2.
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"two"}', followProjection: '{"v":"two"}' });
    await r2.sent;
    const afterOwner = shareDocOf(database, shareId);
    expect(afterOwner.projection.kv).toBe(2);
    expect(Object.keys(afterOwner.prevKeys ?? {})).toEqual(["1"]);
    expect(afterOwner.ownerWrap.kv).toBe(keyVersion(database, a.teamId));
    expect((await a.owner.listRevisions(a.teamId, a.autoId)).map((r) => r.content).sort()).toEqual(['{"secret":"Alpha one"}', '{"secret":"two"}']);
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"n":1}']);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"two"}');
    expect(diffsOf(await p.owner.listProposals(p.teamId, "sent"))).toEqual(['{"n":1}']);
    await propose(r2.value.id, '{"n":2}');

    // The partner removes a member: it refuses to propose until the sharing team updates the share,
    // which moves it to key 3, wrapped to the partner's new public key.
    await (await p.owner.removeMember(p.teamId, "mallory")).sent;
    await expect(propose(r2.value.id, '{"n":3}')).rejects.toThrow(/update the share/);
    await (await a.owner.updateShare(shareId, { revision: r2.value.id, projection: '{"v":"two again"}' })).sent;
    const afterPartner = shareDocOf(database, shareId);
    expect(afterPartner.projection.kv).toBe(3);
    expect(Object.keys(afterPartner.prevKeys ?? {}).sort()).toEqual(["1", "2"]);
    expect(afterPartner.keyWraps[p.teamId]?.ekv).toBe(keyVersion(database, p.teamId));
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"v":"two again"}');
    expect(diffsOf(await p.owner.listProposals(p.teamId, "sent"))).toEqual(['{"n":1}', '{"n":2}']);
    await propose(r2.value.id, '{"n":3}');
    expect(diffsOf(await a.owner.listProposals(a.teamId, "received"))).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(diffsOf(await p.owner.listProposals(p.teamId, "sent"))).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  }, 60_000);

  it("a share whose keys are all current keeps its key when it is published to, updated or given another team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], level: "propose", mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const shareId = share.value.id;
    const before = shareDocOf(database, shareId);
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"two"}', followProjection: '{"v":"two"}' });
    await r2.sent;
    await (await a.owner.updateShare(shareId, { revision: r2.value.id, projection: '{"v":"two again"}' })).sent;
    await (await a.owner.setShareTeams(shareId, [p.teamId, q.teamId])).sent;
    const sent = await p.owner.sendProposal({ shareId, fromTeamId: p.teamId, baseRevision: r2.value.id, diff: '{"n":1}' });
    await sent.sent;
    const after = shareDocOf(database, shareId);
    expect(after.projection.kv).toBe(1);
    expect(after.prevKeys).toBeUndefined();
    expect(bytesEqual(after.ownerWrap.ct, before.ownerWrap.ct)).toBe(true);
    // Adding a team wraps the same key again to every team, so the new manifest signs only wraps
    // this device made; the partner's wrap is to the same team key version as before.
    expect(after.keyWraps[p.teamId]?.ekv).toBe(before.keyWraps[p.teamId]?.ekv);
    expect((await p.owner.listProposals(p.teamId, "sent")).map((proposal) => proposal.diff)).toEqual(['{"n":1}']);
    expect((await q.owner.getShare(shareId, q.teamId))?.projection).toBe('{"v":"two again"}');
  }, 60_000);

  it("an editor who did not make a following share re-keys it when she publishes after a removal", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const bea = await join(database, a.owner, a.teamId, "bea");
    const eve = await join(database, a.owner, a.teamId, "eve");
    const share = await a.owner.createShare({ teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"v":"one"}' });
    await share.sent;
    const eveKeys = await keysOf(eve).openTeam(a.teamId);
    await (await a.owner.removeMember(a.teamId, "eve")).sent;
    const r2 = await bea.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"secret":"by bea"}', followProjection: '{"secret":"by bea"}' });
    await r2.sent;
    expect(shareDocOf(database, share.value.id).projection.kv).toBe(2);
    expect(await projectionWithOwnerKeys(database, share.value.id, a.teamId, eveKeys)).toBe(null);
    expect((await p.owner.getShare(share.value.id, p.teamId))?.projection).toBe('{"secret":"by bea"}');
  }, 60_000);
});
