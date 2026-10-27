/**
 * Known limit, documented rather than fixed: a fork of another team's key, signed by a member that
 * team removed. A device follows another team's key forward only by signatures, each version signed
 * by the team signing key of the version below, and every member who held key n holds that signing
 * key. A team's own devices also check the signed rosters, so for them only an owner, an admin or a
 * holder of the recovery code can sign a version n+1 they take; another team's devices cannot see
 * those rosters, so they follow a version n+1 signed by any former member who kept key n. Like the
 * freshness limit, it needs the device never to have seen the team's real n+1, which the server
 * arranges by showing it the fork instead.
 *
 * These tests play that fork from both sides and pin the two things that limit it: the safety code,
 * which differs from the team's own, and the check this device makes once the server, or anything
 * else, shows it the real n+1 under the version it pinned for the fork: the key reads as changed and
 * the safety code says the server's key differs, rather than the fork being kept in silence.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  MemoryDeviceKeyStore,
  openText,
  rotateTeamKeys,
  teamSafetyCode,
  unwrapShareKeyAsTeam,
  type Envelope,
  type ShareKeyWrap,
  type TeamEncKey,
} from "../src/crypto/index.js";
import { type KeyRing } from "../src/keys/keyring.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
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
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}
type StoredShare = DocData & { keyWraps: Record<string, ShareKeyWrap>; projection: Envelope };
const shareOf = (database: MemoryDatabase, shareId: string) => database.peek(`shares/${shareId}`) as StoredShare;
const encKeyOf = (database: MemoryDatabase, teamId: string) => (database.peek(`teams/${teamId}`) as { encKey: TeamEncKey }).encKey;
const showEncKey = (database: MemoryDatabase, teamId: string, encKey: TeamEncKey) => {
  database.seed(`teams/${teamId}`, { ...(database.peek(`teams/${teamId}`) as DocData), encKey });
};

describe("known limit: a partner team's key forked by a member it removed", () => {
  it("is followed by the sharing team's device, which then sees the real key as changed", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const pete = await join(database, p.owner, p.teamId, "pete"); // an ordinary editor of Partner
    const shown = (await a.owner.checkPartnerKeys([p.teamId]))[0]!.keyId;
    const made = await a.owner.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], mode: "follow", projection: '{"s":"one"}',
      expectedKeys: { [p.teamId]: shown },
    });
    await made.sent;
    const shareId = made.value.id;

    // Pete keeps Partner's key 1, and Partner removes him, which rotates to a real version 2.
    const kept = await keysOf(pete).openTeam(p.teamId, { extractable: true });
    await (await p.owner.removeMember(p.teamId, "pete")).sent;
    const real = encKeyOf(database, p.teamId);
    expect(real.v).toBe(2);

    // Pete forks version 2 with the version 1 signing key he kept; the server shows Alpha his fork.
    const fork = await rotateTeamKeys(p.teamId, kept.newest);
    showEncKey(database, p.teamId, fork.encKey);
    // Alpha's device takes it as Partner's signed rotation: this is the limit.
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("rotated");
    const r2 = await a.owner.publishRevision({ teamId: a.teamId, autoId: a.autoId, baseRevision: a.r1, content: '{"s":"two"}', followProjection: '{"s":"after pete left"}' });
    await r2.sent;
    const share = shareOf(database, shareId);
    const kv = share.projection.kv;
    const key = await unwrapShareKeyAsTeam({ shareId, teamId: p.teamId, shareKeyVersion: kv, wrap: share.keyWraps[p.teamId]!, pair: fork.pair });
    expect(await openText(key, share.projection, aadFor.shareProjection({ shareId, autoId: a.autoId, kv }))).toBe('{"s":"after pete left"}');
    // The safety code Alpha's device shows is the fork's, which is not Partner's own. It is shown as a
    // replaced key, so the app asks for the new code to be compared, which is what catches the fork.
    const code = await a.owner.teamSafetyCode(p.teamId);
    expect(code).toEqual({ safetyCode: await teamSafetyCode(fork.encKey), pinned: true, serverKeyDiffers: false, keyReplaced: true });
    expect(code.safetyCode).not.toBe(await teamSafetyCode(real));

    // Once Alpha's device is shown Partner's real version 2, it does not keep the fork in silence.
    showEncKey(database, p.teamId, real);
    expect((await a.owner.checkPartnerKeys([p.teamId]))[0]?.status).toBe("changed");
    expect(await a.owner.teamSafetyCode(p.teamId)).toEqual({ safetyCode: await teamSafetyCode(fork.encKey), pinned: true, serverKeyDiffers: true });
  }, 60_000);
});

describe("known limit: the sharing team's key forked by a member it removed, seen by a partner", () => {
  it("is followed by the partner's device, which then sees the real key as changed", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const o = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const mallory = await join(database, o.owner, o.teamId, "mallory"); // an ordinary editor of Alpha
    const made = await o.owner.createShare({
      teamId: o.teamId, autoId: o.autoId, revision: o.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: '{"s":"one"}',
      expectedKeys: { [p.teamId]: (await o.owner.checkPartnerKeys([p.teamId]))[0]!.keyId },
    });
    await made.sent;
    // The partner opens the share once, which pins Alpha's key 1 on the partner's device.
    expect((await p.owner.getShare(made.value.id, p.teamId))?.projection).toBe('{"s":"one"}');

    const kept = await keysOf(mallory).openTeam(o.teamId, { extractable: true });
    await (await o.owner.removeMember(o.teamId, "mallory")).sent;
    const real = encKeyOf(database, o.teamId);
    expect(real.v).toBe(2);

    // Mallory forks Alpha's version 2 from the version 1 signing key she kept. Alpha's own devices
    // would refuse it (no roster of Alpha's lets an editor sign a rotation), but the partner's device
    // sees no roster of Alpha's, and follows the signature: this is the limit.
    const fork = await rotateTeamKeys(o.teamId, kept.newest);
    showEncKey(database, o.teamId, fork.encKey);
    // The partner pinned Alpha's key only by opening a share from Alpha, which the server alone can
    // make, so a key signed from it reads as met for the first time: the share dialog shows its
    // safety code, the fork's, before anything is sent.
    expect((await p.owner.checkPartnerKeys([o.teamId]))[0]?.status).toBe("first-use");
    // What the partner shares with Alpha now is wrapped to Mallory's fork.
    const partnerShare = await p.owner.createShare({
      teamId: p.teamId, autoId: p.autoId, revision: p.r1, audience: "teams", teamIds: [o.teamId], projection: '{"s":"partner plan"}',
    });
    await partnerShare.sent;
    const share = shareOf(database, partnerShare.value.id);
    const kv = share.projection.kv;
    const key = await unwrapShareKeyAsTeam({ shareId: partnerShare.value.id, teamId: o.teamId, shareKeyVersion: kv, wrap: share.keyWraps[o.teamId]!, pair: fork.pair });
    expect(await openText(key, share.projection, aadFor.shareProjection({ shareId: partnerShare.value.id, autoId: p.autoId, kv }))).toBe('{"s":"partner plan"}');

    // Once the partner's device is shown Alpha's real version 2, it reads as changed.
    showEncKey(database, o.teamId, real);
    expect((await p.owner.checkPartnerKeys([o.teamId]))[0]?.status).toBe("changed");
    // Nobody on the partner's device checked the fork's code, so it is not shown as a checked pin.
    expect(await p.owner.teamSafetyCode(o.teamId)).toEqual({ safetyCode: await teamSafetyCode(fork.encKey), pinned: false, serverKeyDiffers: true });
  }, 60_000);
});
