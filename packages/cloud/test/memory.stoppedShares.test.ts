/**
 * Which of a team's own shares stopped when its key changed. A rotation lists in the next roster only
 * the shares that every device it keeps signed, so a share made, or last changed, on a device the
 * team removed stops there, and the team's devices refuse to seal into it (`SHARE_NOT_LISTED`). The
 * team is told which shares stopped, with their terms, so it can share them again: the terms come
 * from the manifest the team's own older key signed, and the stopped state from the roster the team
 * signed, so the database can at most leave a stopped share out.
 */
import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import type { KeyRing } from "../src/keys/keyring.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

const DAY_MS = 86_400_000;

/** Each person's first device's stores, so a test can open that same device again with another clock. */
const devices = new Map<string, { deviceKeys: MemoryDeviceKeyStore; trust: MemoryTrustStore }>();

async function person(database: MemoryDatabase, uid: string): Promise<MemoryBackend> {
  const stores = { deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() };
  devices.set(uid, stores);
  const backend = new MemoryBackend({ database, ...stores });
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

/** Alpha (Alice) and Partner (Olga), with Bob an editor of Alpha. */
async function world() {
  const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
  const a = await teamWithAuto(database, "alice", 1111, "Alpha");
  const p = await teamWithAuto(database, "olga", 2222, "Partner");
  const bob = await join(database, a.owner, a.teamId, "bob");
  /** A share to Partner made on `by`, after it was shown Partner's key. */
  const shareToPartner = async (by: MemoryBackend, options: { level?: "view" | "propose"; mode?: "pinned" | "follow"; days?: number } = {}) => {
    const shown = (await by.checkPartnerKeys([p.teamId]))[0]!.keyId;
    const made = await by.createShare({
      teamId: a.teamId, autoId: a.autoId, revision: a.r1, audience: "teams", teamIds: [p.teamId], projection: '{"s":"one"}',
      level: options.level ?? "view", mode: options.mode ?? "pinned",
      expiresAt: new Date(database.now().getTime() + (options.days ?? 7) * DAY_MS),
      expectedKeys: { [p.teamId]: shown },
    });
    await made.sent;
    return made.value;
  };
  return { database, a, p, bob, shareToPartner };
}

describe("the shares that stopped when the team key changed", () => {
  it("lists a share made on a device the team took the key from, with the terms its manifest signs", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, w.a.teamId);
    const made = await w.shareToPartner(laptop, { level: "propose", mode: "follow", days: 10 });
    const kept = await w.shareToPartner(w.a.owner);
    expect(await w.a.owner.listStoppedShares(w.a.teamId)).toEqual([]);

    await (await w.a.owner.revokeDevice(w.a.teamId, (await keysOf(laptop).device()).deviceId)).sent;

    expect((await w.a.owner.listTeamShares(w.a.teamId)).map((s) => s.id)).toEqual([kept.id]);
    const stopped = await w.a.owner.listStoppedShares(w.a.teamId);
    expect(stopped).toEqual([
      {
        id: made.id,
        ownerTeamId: w.a.teamId,
        autoId: w.a.autoId,
        audience: "teams",
        teamIds: [w.p.teamId],
        level: "propose",
        mode: "follow",
        revision: w.a.r1,
        expiresAt: made.expiresAt,
        createdAt: expect.any(Date) as Date,
        reason: "device-removed",
      },
    ]);
  }, 60_000);

  it("does not stop the partner listing what it received once the team shares a stopped share again", async () => {
    const w = await world();
    const made = await w.shareToPartner(w.bob);
    expect((await w.p.owner.listReceivedShares(w.p.teamId)).map((s) => s.id)).toEqual([made.id]);
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    const again = await w.shareToPartner(w.a.owner);
    // Opening the new share moves the partner's pin of Alpha's key to the new version, so the
    // stopped share, signed with the older one, is refused and left out, not a reason to list nothing.
    expect((await w.p.owner.getShare(again.id, w.p.teamId))?.id).toBe(again.id);
    expect((await w.p.owner.listReceivedShares(w.p.teamId)).map((s) => s.id)).toEqual([again.id]);
  }, 60_000);

  it("lists a link share made by a member the team removed", async () => {
    const w = await world();
    await (await w.a.owner.updateTeamSettings(w.a.teamId, { editorsMayLinkShare: true })).sent;
    const made = await w.bob.createShare({ teamId: w.a.teamId, autoId: w.a.autoId, revision: w.a.r1, audience: "link", mode: "pinned", projection: '{"s":"one"}' });
    await made.sent;
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    const stopped = await w.a.owner.listStoppedShares(w.a.teamId);
    expect(stopped.map((s) => [s.id, s.audience, s.teamIds, s.reason])).toEqual([[made.value.id, "link", [], "device-removed"]]);
  }, 60_000);

  it("lists a share an owner made whose terms were last changed on a device the team took the key from", async () => {
    const w = await world();
    const laptop = await secondDevice(w.database, w.a.owner, w.a.teamId);
    const made = await w.shareToPartner(w.a.owner);
    const later = new Date(w.database.now().getTime() + 20 * DAY_MS);
    await (await laptop.extendShare(made.id, later)).sent;
    await (await w.a.owner.revokeDevice(w.a.teamId, (await keysOf(laptop).device()).deviceId)).sent;
    const stopped = await w.a.owner.listStoppedShares(w.a.teamId);
    expect(stopped.map((s) => [s.id, s.reason])).toEqual([[made.id, "device-removed"]]);
    expect(stopped[0]?.expiresAt).toEqual(later);
  }, 60_000);

  it("leaves out live, revoked and ended shares", async () => {
    const w = await world();
    const live = await w.shareToPartner(w.a.owner);
    const revoked = await w.shareToPartner(w.bob);
    await (await w.bob.revokeShare(revoked.id)).sent;
    const ending = await w.shareToPartner(w.bob, { days: 1 });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    expect((await w.a.owner.listStoppedShares(w.a.teamId)).map((s) => s.id)).toEqual([ending.id]);
    // Two days on, on the same device, the stopped share has ended by the end its manifest signs.
    const twoDaysOn = new MemoryBackend({ database: w.database, ...devices.get("alice")!, now: () => new Date(w.database.now().getTime() + 2 * DAY_MS) });
    twoDaysOn.signInAs("alice");
    expect(await twoDaysOn.listStoppedShares(w.a.teamId)).toEqual([]);
    expect((await w.a.owner.listTeamShares(w.a.teamId)).map((s) => s.id)).toEqual([live.id]);
  }, 60_000);

  it("says a share every signer of which the team kept, but the rotation did not see, was not listed", async () => {
    const w = await world();
    const made = await w.shareToPartner(w.a.owner);
    const path = `shares/${made.id}`;
    const doc = w.database.peek(path) as DocData;
    // The database hides the share from the device that changes the key, then shows it again.
    w.database.seed(path, { ...doc, ownerTeamId: "someone-else" });
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    w.database.seed(path, doc);
    const stopped = await w.a.owner.listStoppedShares(w.a.teamId);
    expect(stopped.map((s) => [s.id, s.reason])).toEqual([[made.id, "not-listed"]]);
  }, 60_000);

  it("never lists a stopped share with terms the database changed", async () => {
    const w = await world();
    const made = await w.shareToPartner(w.bob);
    await (await w.a.owner.removeMember(w.a.teamId, "bob")).sent;
    const path = `shares/${made.id}`;
    const doc = w.database.peek(path) as DocData;
    w.database.seed(path, { ...doc, level: "propose" });
    expect(await w.a.owner.listStoppedShares(w.a.teamId)).toEqual([]);
    w.database.seed(path, { ...doc, teamIds: [w.a.teamId] });
    expect(await w.a.owner.listStoppedShares(w.a.teamId)).toEqual([]);
    w.database.seed(path, doc);
    expect((await w.a.owner.listStoppedShares(w.a.teamId)).map((s) => s.id)).toEqual([made.id]);
  }, 60_000);
});
