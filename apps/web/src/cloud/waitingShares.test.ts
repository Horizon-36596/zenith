/**
 * A share made to the team that waits for its team to sign it again. Once a partner device has seen
 * the sharing team's newer key, it refuses a share that team signed with an older one, since someone
 * the team took off could have signed it. The Partners panel lists such a share as waiting, by who
 * it is from alone, until the sharing team's app carries it forward to its newer key.
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { html, text } from "../account/keys/testMarkup";
import { NOW_MS, cloudWorld, fixedRandom, type CloudMember, type CloudWorld } from "./cloudFixture.test";
import { MemoryBackend } from "@horizon36596/zenith-cloud/memory";
import { createCloudSharingApi } from "./cloudSharingApi";
import { WaitingShares } from "./ReceivedShares";
import type { WaitingShare } from "./types";
import { WAITING_SHARES } from "./words";

const DAY = 86_400_000;

/** Adds `uid` to `owner`'s team as an editor, with the team key on their device. */
async function joinTeam(world: CloudWorld, uid: string, seed: number): Promise<MemoryBackend> {
  const owner = world.owner;
  const member = new MemoryBackend({ database: world.database, random: fixedRandom(seed) });
  member.signInAs(uid);
  await (await member.saveProfile({ displayName: uid })).sent;
  const invite = await owner.backend.createInvite(owner.teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(owner.teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  await (await owner.backend.grantDeviceKey(owner.teamId, status.device.deviceId, status.approvalCode)).sent;
  return member;
}

/** A pinned share of a new auto from `from` to `to`'s team, after `from` was shown `to`'s key. */
async function share(from: CloudMember, to: CloudMember, projection: string): Promise<string> {
  const auto = await from.backend.createAuto(from.teamId, { title: projection });
  await auto.sent;
  const revision = await from.backend.publishRevision({ teamId: from.teamId, autoId: auto.value.id, baseRevision: null, content: "{}" });
  await revision.sent;
  const shown = (await from.backend.checkPartnerKeys([to.teamId]))[0]!.keyId;
  const made = await from.backend.createShare({
    teamId: from.teamId, autoId: auto.value.id, revision: revision.value.id, audience: "teams", teamIds: [to.teamId], projection,
    expiresAt: new Date(NOW_MS + 7 * DAY), expectedKeys: { [to.teamId]: shown },
  });
  await made.sent;
  return made.value.id;
}

describe("a share waiting for its team to sign it again", () => {
  it("is listed as waiting while the sharing team has not carried it forward, and as received once it has", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    const before = await share(world.owner, partner, '{"v":"before"}');
    expect((await partnerApi.listReceived(partner.teamId)).map((s) => s.id)).toEqual([before]);

    // Horizon removes a member, on a device that goes away before it carries the share forward.
    await joinTeam(world, "mo", 901);
    const carry = vi.spyOn(world.owner.backend, "carryForwardShares").mockResolvedValue({ carried: [], left: [] });
    await (await world.owner.backend.removeMember(world.owner.teamId, "mo")).sent;
    carry.mockRestore();
    // The partner sees Horizon's newer key on a share made after the change.
    const after = await share(world.owner, partner, '{"v":"after"}');
    expect((await partnerApi.openShare(after))?.projection).toBe('{"v":"after"}');

    expect((await partnerApi.listReceived(partner.teamId)).map((s) => s.id)).toEqual([after]);
    expect(await partnerApi.listWaiting(partner.teamId)).toEqual([
      { id: before, fromTeamId: world.owner.teamId, fromTeamNumber: 36596, fromTeamName: "Horizon", fromTeamStatus: "unverified", fromTeamCheck: expect.anything() as unknown },
    ]);

    // The next time Horizon's team is opened, its app carries the share forward.
    expect((await world.owner.backend.carryForwardShares(world.owner.teamId)).carried).toEqual([before]);
    expect(await partnerApi.listWaiting(partner.teamId)).toEqual([]);
    expect((await partnerApi.listReceived(partner.teamId)).map((s) => s.id).sort()).toEqual([before, after].sort());
  }, 60_000);

  it("shows who it is from and why it waits, and nothing when none waits", () => {
    const waiting: WaitingShare = { id: "waiting1", fromTeamId: "t1", fromTeamNumber: 36596, fromTeamName: "Horizon", fromTeamStatus: "unverified" };
    expect(html(createElement(WaitingShares, { waiting: [] }))).toBe("");
    const shown = text(html(createElement(WaitingShares, { waiting: [waiting] })));
    expect(shown).toContain("Waiting for team 36596 (unverified) to update a share");
    expect(shown).toContain(WAITING_SHARES.why);
    const claiming = text(html(createElement(WaitingShares, { waiting: [{ ...waiting, fromTeamCheck: { kind: "mismatch" } }] })));
    expect(claiming).toContain("Waiting for a team claiming to be 36596 to update a share");
  });

  it("keeps every sentence short and plain", () => {
    for (const sentence of WAITING_SHARES.why.split(/(?<=[.:?])\s+/)) expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(16);
    expect(WAITING_SHARES.why).not.toMatch(/!/);
  });
});
