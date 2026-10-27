/**
 * Which partner key a share is re-keyed to. A share's manifest names, for each team it was made to,
 * the key the sharer wrapped to, as `teamKeyDigest` of that key, and a device that re-keys the share
 * later wraps to that key or to a newer one the partner team signed from it, and to nothing else. It
 * used to trust whatever key the server showed when the device had never pinned the partner, which
 * is every other member of the sharing team and the sharer's own second device: the server showed a
 * key pair of its own as the partner's next version, the share looked stale, and the next publish
 * re-keyed it to the server. These tests are that server, and the honest rotations a re-key must
 * still follow. Against `MemoryBackend`; `database.seed` plays a server that writes whatever it likes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aadFor,
  createTeamKeys,
  MemoryDeviceKeyStore,
  openText,
  readShareManifest,
  rotateTeamKeys,
  teamEncKeyFor,
  teamKeyDigest,
  unwrapShareKeyAsTeam,
  type ShareKeyWrap,
  type ShareManifest,
} from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const backend = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  return backend;
}
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
/** A second device of `uid`, given the team key by `first`, the device that made the share. */
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

type StoredShare = DocData & { keyWraps: Record<string, ShareKeyWrap>; projection: { kv: number }; manifest: ShareManifest };
const shareOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as StoredShare;
const encKeyOf = (database: MemoryDatabase, teamId: string) =>
  (database.peek(`teams/${teamId}`) as { encKey: { v: number; fingerprint: Uint8Array; signSpki: Uint8Array } }).encKey;

/** Alpha shares a following auto with Partner from the owner's device, after showing Partner's safety code; Ann is an editor of Alpha. */
async function world() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const ann = await join(database, a.owner, a.teamId, "ann");
  const shown = (await a.owner.checkPartnerKeys([p.teamId]))[0]!.keyId;
  const made = await a.owner.createShare({
    teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"s":"one"}',
    expectedKeys: { [p.teamId]: shown },
  });
  await made.sent;
  return { database, a, p, ann, shareId: made.value.id };
}

/** Plays a server that shows `teamId` with a key pair of its own at the version after the real one, signed by a first version of its own. */
async function showForgedNextKey(database: MemoryDatabase, teamId: string) {
  const f1 = await createTeamKeys(teamId);
  const f2 = await rotateTeamKeys(teamId, { key: f1.key, pair: f1.pair });
  const doc = database.peek(`teams/${teamId}`) as DocData;
  database.seed(`teams/${teamId}`, { ...doc, encKey: f2.encKey });
  return { f1, f2 };
}

/** The partner's projection opened with `pair`, or null when the share's wrap for it does not open with it. */
async function openedWith(database: MemoryDatabase, shareId: string, teamId: string, autoId: string, pair: Parameters<typeof unwrapShareKeyAsTeam>[0]["pair"]) {
  const share = shareOf(database, shareId);
  const kv = share.projection.kv;
  try {
    const key = await unwrapShareKeyAsTeam({ shareId, teamId, shareKeyVersion: kv, wrap: share.keyWraps[teamId]!, pair });
    return await openText(key, share.projection as never, aadFor.shareProjection({ shareId, autoId, kv }));
  } catch {
    return null;
  }
}

describe("a re-key wraps only to the partner key the share's manifest names, or one the partner signed from it", () => {
  it("names each team's key in the manifest as the sharer wrapped to it", async () => {
    const { database, p, shareId } = await world();
    const body = readShareManifest(shareOf(database, shareId).manifest);
    const key = encKeyOf(database, p.teamId);
    expect(body.teams).toEqual([[p.teamId, key.v, await teamKeyDigest({ teamId: p.teamId, ...key })]]);
  });

  it("refuses a publish by an editor who never pinned the partner when the server shows its own next partner key", async () => {
    const { database, a, p, ann, shareId } = await world();
    const { f2 } = await showForgedNextKey(database, p.teamId);
    const before = shareOf(database, shareId).projection.kv;
    const publish = async () => {
      const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"secret two"}' });
      await r2.sent;
    };
    expect(await code(publish())).toBe("key-changed");
    expect(shareOf(database, shareId).projection.kv).toBe(before);
    expect(await openedWith(database, shareId, p.teamId, a.autoId, f2.pair)).toBe(null);
  });

  it("refuses the same through updateShare, which the web app's follow-latest hook calls after every publish", async () => {
    const { database, a, p, ann, shareId } = await world();
    const { f2 } = await showForgedNextKey(database, p.teamId);
    const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}' });
    await r2.sent;
    expect(await code(ann.updateShare(shareId, { revision: r2.value.id, projection: '{"s":"secret two"}' }).then((queued) => queued.sent))).toBe("key-changed");
    expect(await openedWith(database, shareId, p.teamId, a.autoId, f2.pair)).toBe(null);
  });

  it("refuses the server's key on the sharer's own second device, which never pinned the partner either", async () => {
    const { database, a, p, shareId } = await world();
    const laptop = await secondDevice(database, a.owner, "alice", a.teamId);
    const { f2 } = await showForgedNextKey(database, p.teamId);
    const publish = async () => {
      const r2 = await laptop.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"secret two"}' });
      await r2.sent;
    };
    expect(await code(publish())).toBe("key-changed");
    expect(await openedWith(database, shareId, p.teamId, a.autoId, f2.pair)).toBe(null);
  });

  it("refuses the server's key when it also swaps the partner's record of the version the manifest names", async () => {
    const { database, a, p, ann, shareId } = await world();
    const { f1, f2 } = await showForgedNextKey(database, p.teamId);
    const path = `teams/${p.teamId}/teamKeys/1`;
    database.seed(path, { ...(database.peek(path) as DocData), pairSpki: f1.record.pairSpki, signSpki: f1.record.signSpki });
    const publish = async () => {
      const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"secret two"}' });
      await r2.sent;
    };
    expect(await code(publish())).toBe("key-changed");
    expect(await openedWith(database, shareId, p.teamId, a.autoId, f2.pair)).toBe(null);
  });

  it("never trusts a partner key on first use for a team already on the share, even at the version the manifest names", async () => {
    const { database, a, p, ann, shareId } = await world();
    // The sharing team's key changes, and the device that changes it goes away before it carries the
    // share forward, so the next publish must re-key the share.
    await join(database, a.owner, a.teamId, "mallory");
    vi.spyOn(a.owner, "carryForwardShares").mockResolvedValue({ carried: [], left: [] });
    await (await a.owner.removeMember(a.teamId, "mallory")).sent;
    // The server shows Ann a partner key pair of its own under the version the manifest names.
    const forged = await createTeamKeys(p.teamId);
    const doc = database.peek(`teams/${p.teamId}`) as DocData;
    database.seed(`teams/${p.teamId}`, { ...doc, encKey: teamEncKeyFor(forged.pair) });
    const publish = async () => {
      const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"secret two"}' });
      await r2.sent;
    };
    expect(await code(publish())).toBe("key-changed");
    expect(await openedWith(database, shareId, p.teamId, a.autoId, forged.pair)).toBe(null);
  });

  it("refuses to wrap the share key again to the server's key when an editor adds a team", async () => {
    const { database, a, p, ann, shareId } = await world();
    const q = await teamWithAuto(database, "quinn", 3333, "Third");
    const forged = await createTeamKeys(p.teamId);
    const doc = database.peek(`teams/${p.teamId}`) as DocData;
    database.seed(`teams/${p.teamId}`, { ...doc, encKey: teamEncKeyFor(forged.pair) });
    const shown = (await ann.checkPartnerKeys([q.teamId]))[0]!.keyId;
    expect(await code(ann.setShareTeams(shareId, [p.teamId, q.teamId], { expectedKeys: { [q.teamId]: shown } }).then((queued) => queued.sent))).toBe("key-changed");
    expect(await openedWith(database, shareId, p.teamId, a.autoId, forged.pair)).toBe(null);
  });

  it("re-keys to a partner key the partner signed from the one the manifest names, and records that key", async () => {
    const { database, a, p, ann, shareId } = await world();
    // The partner removes a member, which rotates its key, signed from the old one.
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    const next = encKeyOf(database, p.teamId);
    expect(next.v).toBe(2);
    const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    const share = shareOf(database, shareId);
    expect(share.projection.kv).toBe(2);
    expect(readShareManifest(share.manifest).teams).toEqual([[p.teamId, 2, await teamKeyDigest({ teamId: p.teamId, ...next })]]);
    // The partner key a share names is one of its terms, so Ann signs the terms that name the new one.
    const annDevice = (await (ann as unknown as { keys: { device(): Promise<{ deviceId: string }> } }).keys.device()).deviceId;
    expect(readShareManifest(share.manifest)).toMatchObject({ termsSeq: 2 });
    expect(readShareManifest(share.manifest).termsDevices.at(-1)).toBe(annDevice);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"s":"two"}');
  });

  it("lets the sharer's second device publish and re-key after the partner rotates honestly", async () => {
    const { database, a, p, shareId } = await world();
    const laptop = await secondDevice(database, a.owner, "alice", a.teamId);
    await join(database, p.owner, p.teamId, "pete");
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    const r2 = await laptop.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"two, from the laptop"}' });
    await r2.sent;
    expect(shareOf(database, shareId).projection.kv).toBe(2);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"s":"two, from the laptop"}');
  });

  it("follows two honest partner rotations in one re-key", async () => {
    const { database, a, p, ann, shareId } = await world();
    for (const uid of ["pete", "paul"]) {
      await join(database, p.owner, p.teamId, uid);
      await (await p.owner.removeMember(p.teamId, uid)).sent;
    }
    expect(encKeyOf(database, p.teamId).v).toBe(3);
    const r2 = await ann.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"two"}' });
    await r2.sent;
    expect(readShareManifest(shareOf(database, shareId).manifest).teams[0]?.[1]).toBe(3);
    expect((await p.owner.getShare(shareId, p.teamId))?.projection).toBe('{"s":"two"}');
  });
});
