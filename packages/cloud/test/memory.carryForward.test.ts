/**
 * The team that shares carries its shares forward when its key changes. A partner that has seen the
 * sharing team's newer key refuses a share signed with an older one (`SHARE_SIGNED_WITH_OLDER_KEY`):
 * a member the team removed kept the older key and could have signed it. So once a rotation is
 * stored, a device of the sharing team signs again, with the newest key and under a new share key,
 * every share the new roster lists, and a device that opens the team later finishes what an
 * interrupted run left. A share the rotation dropped is not carried, and a share a removed member
 * forged with the old key stays refused by the partner.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aadFor,
  commitShareKey,
  decodeShareManifestBody,
  MemoryDeviceKeyStore,
  newShareKey,
  openText,
  sealText,
  signShareManifest,
  teamKeyDigest,
  unwrapShareKeyAsOwner,
  wrapShareKeyForOwner,
  wrapShareKeyToTeam,
  type Envelope,
  type ShareManifest,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { CARRY_FORWARD_PROJECTION_BYTES_PER_WRITE, CARRY_FORWARD_SHARES_PER_WRITE, SHARE_SIGNED_WITH_OLDER_KEY } from "../src/client.js";
import { teamKeyAt, teamPairAt, type KeyRing, type OpenedTeam } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData, Write } from "../src/store.js";
import type { Caller } from "./cryptoHelpers.js";

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

interface ShareDocLike {
  autoId: string;
  projection: Envelope;
  ownerWrap: Envelope & { kv: number };
  manifest: ShareManifest;
}
const shareDocOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as unknown as ShareDocLike;
const manifestOf = (database: MemoryDatabase, shareId: string) => decodeShareManifestBody(shareDocOf(database, shareId).manifest.body);
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;

/** What someone holding `keys`, a copy of the sharing team's keys, reads of a share through its owner wrap, or null. */
async function projectionWithOwnerKeys(database: MemoryDatabase, shareId: string, teamId: string, keys: OpenedTeam): Promise<string | null> {
  const doc = shareDocOf(database, shareId);
  try {
    const shareKey = await unwrapShareKeyAsOwner({ shareId, teamId, shareKeyVersion: doc.projection.kv, wrap: doc.ownerWrap, teamKey: teamKeyAt(keys, doc.ownerWrap.kv) });
    return await openText(shareKey, doc.projection, aadFor.shareProjection({ shareId, autoId: doc.autoId, kv: shareKey.version }));
  } catch {
    return null;
  }
}

/** Alpha (Alice, with Bob an editor) shares with Partner (Olga). */
async function world() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const bob = await join(database, a.owner, a.teamId, "bob");
  /** A share to Partner made on `by`, after it was shown Partner's key. */
  const shareToPartner = async (by: MemoryBackend, options: { mode?: "pinned" | "follow"; projection?: string } = {}) => {
    const shown = (await by.checkPartnerKeys([p.teamId]))[0]!.keyId;
    const made = await by.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: options.projection ?? '{"s":"one"}',
      level: "view", mode: options.mode ?? "pinned", expiresAt: new Date(database.now().getTime() + 7 * DAY_MS),
      expectedKeys: { [p.teamId]: shown },
    });
    await made.sent;
    return made.value;
  };
  /** Olga learns Alpha's newest key: she opens a share Alpha makes to Partner after its key changed. */
  const partnerSeesNewestKey = async () => {
    const fresh = await shareToPartner(a.owner, { projection: '{"s":"fresh"}' });
    expect((await p.owner.getShare(fresh.id, p.teamId))?.projection).toBe('{"s":"fresh"}');
    return fresh;
  };
  return { database, a, p, bob, shareToPartner, partnerSeesNewestKey };
}

describe("carrying a team's shares forward to its new key", () => {
  it("lets the partner open a pinned and a following share right after the rotation, once it has seen the newer key", async () => {
    const w = await world();
    const pinned = await w.shareToPartner(w.a.owner, { projection: '{"s":"pinned"}' });
    const follow = await w.shareToPartner(w.a.owner, { mode: "follow", projection: '{"s":"follow"}' });
    expect((await w.p.owner.getShare(pinned.id, w.p.teamId))?.projection).toBe('{"s":"pinned"}');
    expect((await w.p.owner.getShare(follow.id, w.p.teamId))?.projection).toBe('{"s":"follow"}');
    const bobKeys = await keysOf(w.bob).openTeam(w.a.teamId);
    const before = manifestOf(w.database, pinned.id);

    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    const fresh = await w.partnerSeesNewestKey();

    expect((await w.p.owner.getShare(pinned.id, w.p.teamId))?.projection).toBe('{"s":"pinned"}');
    expect((await w.p.owner.getShare(follow.id, w.p.teamId))?.projection).toBe('{"s":"follow"}');
    expect((await w.p.owner.listReceivedShares(w.p.teamId)).map((s) => s.id).sort()).toEqual([pinned.id, follow.id, fresh.id].sort());
    expect(await w.p.owner.listWaitingShares(w.p.teamId)).toEqual([]);

    // Signed again at the new key by the device that rotated, which alone now signs the terms, and
    // moved to a new share key that the removed member's old team key does not open.
    const after = manifestOf(w.database, pinned.id);
    const aliceDevice = (await keysOf(w.a.owner).device()).deviceId;
    expect(after).toMatchObject({ okv: 2, wkv: 2, skv: before.skv + 1, seq: before.seq + 1, termsSeq: before.termsSeq + 1, termsDevices: [aliceDevice], revisionId: w.a.r1 });
    expect(shareDocOf(w.database, pinned.id).ownerWrap.kv).toBe(2);
    expect(await projectionWithOwnerKeys(w.database, pinned.id, w.a.teamId, bobKeys)).toBe(null);
    // The sharing team's own devices still open and update both.
    expect((await w.a.owner.getShare(pinned.id, w.a.teamId))?.projection).toBe('{"s":"pinned"}');
    expect(await w.a.owner.listStoppedShares(w.a.teamId)).toEqual([]);
  }, 60_000);

  it("is finished by another device of the team when the device that rotated never carried the shares", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, w.a.teamId);
    const pinned = await w.shareToPartner(w.a.owner, { projection: '{"s":"pinned"}' });
    const follow = await w.shareToPartner(w.a.owner, { mode: "follow", projection: '{"s":"follow"}' });
    expect((await w.p.owner.getShare(pinned.id, w.p.teamId))?.projection).toBe('{"s":"pinned"}');
    // The device that removes Bob goes offline, or is closed, before it carries anything.
    vi.spyOn(w.a.owner, "carryForwardShares").mockResolvedValue({ carried: [], left: [] });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    expect(manifestOf(w.database, pinned.id).okv).toBe(1);
    const fresh = await w.partnerSeesNewestKey();

    // Until then the partner refuses both, and lists them as waiting for Alpha to update them.
    await expect(w.p.owner.getShare(pinned.id, w.p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
    expect((await w.p.owner.listReceivedShares(w.p.teamId)).map((s) => s.id)).toEqual([fresh.id]);
    expect((await w.p.owner.listWaitingShares(w.p.teamId)).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [{ id: pinned.id, ownerTeamId: w.a.teamId }, { id: follow.id, ownerTeamId: w.a.teamId }].sort((x, y) => x.id.localeCompare(y.id)),
    );

    const carried = await laptop.carryForwardShares(w.a.teamId);
    expect(carried.carried.sort()).toEqual([pinned.id, follow.id].sort());
    expect(carried.left).toEqual([]);
    expect((await w.p.owner.getShare(pinned.id, w.p.teamId))?.projection).toBe('{"s":"pinned"}');
    expect((await w.p.owner.getShare(follow.id, w.p.teamId))?.projection).toBe('{"s":"follow"}');
    expect(await w.p.owner.listWaitingShares(w.p.teamId)).toEqual([]);
    const laptopDevice = (await keysOf(laptop).device()).deviceId;
    expect(manifestOf(w.database, pinned.id)).toMatchObject({ okv: 2, termsDevices: [laptopDevice] });
    // A second run finds nothing left to carry.
    expect(await laptop.carryForwardShares(w.a.teamId)).toEqual({ carried: [], left: [] });
  }, 60_000);

  it("does not carry a share the rotation stopped", async () => {
    const w = await world();
    const kept = await w.shareToPartner(w.a.owner);
    const byBob = await w.shareToPartner(w.bob, { projection: '{"s":"bob"}' });
    expect((await w.p.owner.getShare(byBob.id, w.p.teamId))?.projection).toBe('{"s":"bob"}');
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    await w.partnerSeesNewestKey();

    expect(manifestOf(w.database, byBob.id).okv).toBe(1);
    expect(manifestOf(w.database, kept.id).okv).toBe(2);
    expect(await w.a.owner.carryForwardShares(w.a.teamId)).toEqual({ carried: [], left: [] });
    expect(manifestOf(w.database, byBob.id).okv).toBe(1);
    expect((await w.a.owner.listStoppedShares(w.a.teamId)).map((s) => s.id)).toEqual([byBob.id]);
    await expect(w.p.owner.getShare(byBob.id, w.p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
    expect((await w.p.owner.listWaitingShares(w.p.teamId)).map((s) => s.id)).toEqual([byBob.id]);
  }, 60_000);

  it("leaves a share a removed member forged with the old key refused by the partner", async () => {
    const w = await world();
    const honest = await w.shareToPartner(w.a.owner, { projection: '{"s":"honest"}' });
    const bobKeys = await keysOf(w.bob).openTeam(w.a.teamId);
    const bobDevice = await keysOf(w.bob).device();
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    await w.partnerSeesNewestKey();

    // Bob, with the server, makes a share of his own to Partner, signed with version 1, which he kept.
    const forgedId = "forgedShareByBob000001";
    const shareKey = await newShareKey(1);
    const partnerKey = encKeyOf(w.database, w.p.teamId);
    const signed = manifestOf(w.database, honest.id);
    const manifest = await signShareManifest({
      body: {
        ...signed, shareId: forgedId, seq: 1, skv: 1, wkv: 1, okv: 1, device: bobDevice.deviceId, termsSeq: 1, termsDevices: [bobDevice.deviceId],
        teams: [[w.p.teamId, partnerKey.v, await teamKeyDigest({ teamId: w.p.teamId, ...partnerKey })]],
        commit: await commitShareKey({ shareId: forgedId, shareKey }),
      },
      signingKey: teamPairAt(bobKeys, 1).signingKey,
      device: bobDevice,
    });
    const honestDoc = w.database.peek(`shares/${honest.id}`) as DocData;
    const { prevKeys: _prevKeys, ...rest } = honestDoc;
    w.database.seed(`shares/${forgedId}`, {
      ...rest,
      createdBy: "bob",
      projection: await sealText(shareKey, '{"s":"from bob"}', aadFor.shareProjection({ shareId: forgedId, autoId: w.a.autoId, kv: 1 })),
      keyWraps: { [w.p.teamId]: await wrapShareKeyToTeam({ shareId: forgedId, teamId: w.p.teamId, shareKey, encKey: partnerKey }) },
      ownerWrap: await wrapShareKeyForOwner({ shareId: forgedId, teamId: w.a.teamId, shareKey, teamKey: teamKeyAt(bobKeys, 1) }),
      manifest,
    });
    w.database.seed(`teams/${w.p.teamId}/inbox/${forgedId}`, { shareId: forgedId, ownerTeamId: w.a.teamId, createdBy: "bob", createdAt: w.database.now() });

    await expect(w.p.owner.getShare(forgedId, w.p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
    expect(await w.a.owner.carryForwardShares(w.a.teamId)).toEqual({ carried: [], left: [] });
    expect(manifestOf(w.database, forgedId).okv).toBe(1);
    await expect(w.p.owner.getShare(forgedId, w.p.teamId)).rejects.toThrow(SHARE_SIGNED_WITH_OLDER_KEY);
    expect((await w.p.owner.listWaitingShares(w.p.teamId)).map((s) => s.id)).toEqual([forgedId]);
    expect((await w.p.owner.getShare(honest.id, w.p.teamId))?.projection).toBe('{"s":"honest"}');
  }, 60_000);

  it("carries many shares in bounded writes", async () => {
    const w = await world();
    const count = 2 * CARRY_FORWARD_SHARES_PER_WRITE + 1;
    const made: string[] = [];
    for (let i = 0; i < count; i += 1) made.push((await w.shareToPartner(w.a.owner, { projection: `{"s":${String(i)}}` })).id);
    const commits: Write[][] = [];
    const commit = w.database.commit.bind(w.database);
    vi.spyOn(w.database, "commit").mockImplementation((caller: Caller, writes: Write[]) => {
      commits.push(writes);
      commit(caller, writes);
    });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;

    const carries = commits.filter((writes) => writes.every((write) => write.path.startsWith("shares/")));
    expect(carries.map((writes) => writes.length)).toEqual([CARRY_FORWARD_SHARES_PER_WRITE, CARRY_FORWARD_SHARES_PER_WRITE, 1]);
    expect(carries.flat().map((write) => write.path).sort()).toEqual(made.map((id) => `shares/${id}`).sort());
    for (const id of made) expect(manifestOf(w.database, id).okv).toBe(2);
  }, 120_000);

  it("splits a write of large shares by the size of their projections", async () => {
    const w = await world();
    // Text that barely compresses, so each sealed projection is most of a megabyte.
    let state = 1;
    const noise = (length: number): string => {
      let text = "";
      for (let i = 0; i < length; i += 1) {
        state = (state * 48_271) % 2_147_483_647;
        // The printable characters from "#" to "~" but the backslash, which JSON would escape.
        const code = 35 + (state % 91);
        text += String.fromCharCode(code >= 92 ? code + 1 : code);
      }
      return text;
    };
    const made: string[] = [];
    for (let i = 0; i < 6; i += 1) made.push((await w.shareToPartner(w.a.owner, { projection: JSON.stringify({ s: noise(900_000) }) })).id);
    const sealed = (shareDocOf(w.database, made[0]!).projection.ct as Uint8Array).byteLength;
    const perWrite = Math.floor(CARRY_FORWARD_PROJECTION_BYTES_PER_WRITE / sealed);
    expect(perWrite).toBeLessThan(6);
    const commits: Write[][] = [];
    const commit = w.database.commit.bind(w.database);
    vi.spyOn(w.database, "commit").mockImplementation((caller: Caller, writes: Write[]) => {
      commits.push(writes);
      commit(caller, writes);
    });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;

    const carries = commits.filter((writes) => writes.every((write) => write.path.startsWith("shares/")));
    expect(carries.map((writes) => writes.length)).toEqual([perWrite, 6 - perWrite]);
    for (const id of made) expect(manifestOf(w.database, id).okv).toBe(2);
  }, 120_000);

  it("on an editor's device, carries a following share and leaves a pinned share someone else made", async () => {
    const w = await world();
    const pinned = await w.shareToPartner(w.a.owner);
    const follow = await w.shareToPartner(w.a.owner, { mode: "follow" });
    const cara = await join(w.database, w.a.owner, w.a.teamId, "cara");
    vi.spyOn(w.a.owner, "carryForwardShares").mockResolvedValue({ carried: [], left: [] });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    expect(await cara.carryForwardShares(w.a.teamId)).toEqual({ carried: [follow.id], left: [pinned.id] });
    expect(manifestOf(w.database, pinned.id).okv).toBe(1);
    expect(manifestOf(w.database, follow.id).okv).toBe(2);
  }, 60_000);
});
