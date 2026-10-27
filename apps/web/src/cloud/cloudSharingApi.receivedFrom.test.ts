/**
 * Who a received share is from. The server writes the sharing team's number, name and status, so
 * the Partners panel compares the sharing team with the team this device pinned under that number
 * when it shared with it. A share from another team that claims the number is flagged, and a
 * proposal to it is not sent. With no pin for the number yet, the panel shows the sharing team's
 * safety code once, as the first share with a team does.
 *
 * Runs against the in-memory cloud and its real rules.
 */
import { describe, expect, it } from "vitest";
import { NOW_MS, cloudWorld, fixedRandom, memberWithTeam, publishTo, type CloudMember, type CloudWorld } from "./cloudFixture.test";
import { MemoryBackend } from "@horizon36596/zenith-cloud/memory";
import { createCloudSharingApi } from "./cloudSharingApi";
import { NO_ANSWERS, answerOptions, withAnswer } from "./keyAnswers";
import { fromTeamCheckWords, fromTeamWords, sharedByWords } from "./words";

const DAY = 86_400_000;

/** `from` shares an auto with `to`'s team through the sharing adapter, answering the dialog. */
async function shareWith(from: CloudMember, to: CloudMember, level: "view" | "propose" = "view") {
  const api = createCloudSharingApi(from.backend, { now: () => NOW_MS });
  const at = await publishTo(from, "p.auto.json", '{"kind":"auto"}\n');
  const warnings = await api.checkPartnerKeys([to.teamNumber]);
  const made = await api.createShare(
    from.teamId,
    {
      autoId: at.autoId,
      audience: "teams",
      teamNumbers: [to.teamNumber],
      level,
      mode: "pinned",
      revision: at.n,
      revisionId: at.revisionId,
      expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
      projection: `{"v":"from ${from.uid}"}`,
    },
    answerOptions(warnings.reduce(withAnswer, NO_ANSWERS)),
  );
  return { made, at };
}

/** Plays a server that makes a team of its own and names it Horizon, with number 36596, verified. */
async function fakeHorizon(world: CloudWorld): Promise<CloudMember> {
  const fake = await memberWithTeam(world.database, "server", 99999, "Fake");
  const doc = world.database.peek(`teams/${fake.teamId}`) as Record<string, unknown>;
  world.database.seed(`teams/${fake.teamId}`, { ...doc, number: 36596, name: "Horizon", status: "verified" });
  return { ...fake, teamNumber: 36596 };
}

describe("a received share from a team claiming a number this device knows as another team", () => {
  it("is flagged as only claiming the number, and a proposal to it is not sent", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    // The partner shares with Horizon once, so its device pins 36596 to Horizon's team.
    await shareWith(partner, world.owner);
    expect(partner.backend.teamNumberPin(36596)).toEqual({ teamId: world.owner.teamId, seen: true });

    // The server's own "Horizon" shares with the partner, taking proposals.
    const fake = await fakeHorizon(world);
    const at = await publishTo(fake, "f.auto.json", '{"kind":"auto"}\n');
    const made = await fake.backend.createShare({
      teamId: fake.teamId,
      autoId: at.autoId,
      revision: at.revisionId,
      audience: "teams",
      teamIds: [partner.teamId],
      level: "propose",
      mode: "pinned",
      projection: '{"v":"from the server"}',
    });
    await made.sent;

    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === made.value.id);
    expect(shown).toMatchObject({ fromTeamNumber: 36596, fromTeamCheck: { kind: "mismatch" } });
    if (shown === undefined) throw new Error("the share was not listed");
    expect(fromTeamWords(shown)).toBe("A team claiming to be 36596");
    expect(sharedByWords(shown)).toBe("shared by a team claiming to be 36596");
    expect(fromTeamCheckWords(shown)).toBe(
      "Claims to be from team 36596, but it is not the team you know as 36596. Proposals to it are not sent.",
    );

    // A proposal the partner sends on it is refused before anything is sealed to the server's key.
    await expect(
      partner.backend.sendProposal({ shareId: made.value.id, fromTeamId: partner.teamId, baseRevision: at.revisionId, diff: '{"v":"partner strategy"}' }),
    ).rejects.toMatchObject({ code: "key-changed" });
    expect(await fake.backend.listProposals(fake.teamId, "received")).toEqual([]);
  });

  it("opened by its id, is flagged the same way", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    await shareWith(partner, world.owner);
    const fake = await fakeHorizon(world);
    const { made } = await shareWith(fake, partner);
    expect(await partnerApi.openShare(made.id)).toMatchObject({ fromTeamCheck: { kind: "mismatch" } });
  });
});

describe("a received share from the team this device knows under its number", () => {
  it("is shown as from that team, and takes proposals", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    await shareWith(partner, world.owner);
    const { made, at } = await shareWith(world.owner, partner, "propose");

    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === made.id);
    expect(shown).toMatchObject({ fromTeamNumber: 36596, fromTeamName: "Horizon", fromTeamCheck: { kind: "known" } });
    if (shown === undefined) throw new Error("the share was not listed");
    expect(fromTeamWords(shown)).toBe("Team 36596 (unverified)");
    expect(fromTeamCheckWords(shown)).toBeNull();
    const sent = await partner.backend.sendProposal({ shareId: made.id, fromTeamId: partner.teamId, baseRevision: at.revisionId, diff: '{"v":"idea"}' });
    await sent.sent;
    expect((await world.owner.backend.listProposals(world.owner.teamId, "received")).map((p) => p.diff)).toEqual(['{"v":"idea"}']);
  });
});

describe("a received share from a number this device has not shared with", () => {
  it("shows the sharing team's safety code to compare, the one on that team's own page", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    const { made } = await shareWith(world.owner, partner);
    expect(partner.backend.teamNumberPin(36596)).toBeNull();

    const horizonCode = (await world.owner.backend.teamKeyStatus(world.owner.teamId)) as { safetyCode: string };
    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === made.id);
    expect(shown?.fromTeamCheck).toEqual({ kind: "first-use", safetyCode: horizonCode.safetyCode });
    if (shown === undefined) throw new Error("the share was not listed");
    expect(fromTeamCheckWords(shown)).toBe(
      `First share from team 36596 on this device. Compare its safety code with them: ${horizonCode.safetyCode}.`,
    );
  });
});

/** Adds `uid` to `owner`'s team with the team key, then removes them, so the team replaces its key. */
async function replaceKey(world: CloudWorld, uid: string): Promise<void> {
  const owner = world.owner;
  const member = new MemoryBackend({ database: world.database, random: fixedRandom(902) });
  member.signInAs(uid);
  await (await member.saveProfile({ displayName: uid })).sent;
  const invite = await owner.backend.createInvite(owner.teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.redeemInvite(invite.value.code)).sent;
  const status = await member.teamKeyStatus(owner.teamId);
  if (status.state !== "waiting") throw new Error("already holds the key");
  await (await owner.backend.grantDeviceKey(owner.teamId, status.device.deviceId, status.approvalCode)).sent;
  await (await owner.backend.removeMember(owner.teamId, uid)).sent;
}

describe("a received share from a number this device has not shared with, after that team replaced its key", () => {
  it("says the safety code changed and shows the new one to compare, not the first-share words", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    const { made } = await shareWith(world.owner, partner);
    const first = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === made.id)!;
    expect(first.fromTeamCheck).not.toHaveProperty("keyReplaced");
    expect(fromTeamCheckWords(first)).toMatch(/^First share from team 36596 on this device\./);

    await replaceKey(world, "mo");
    const rotated = (await world.owner.backend.teamKeyStatus(world.owner.teamId)) as { safetyCode: string; keyVersion: number };
    expect(rotated.keyVersion).toBe(2);
    const changed = `Team 36596's safety code changed, because they replaced their team key. Compare the new code with them before you trust this share: ${rotated.safetyCode}.`;
    const after = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === made.id)!;
    expect(after.fromTeamCheck).toEqual({ kind: "first-use", safetyCode: rotated.safetyCode, keyReplaced: true });
    expect(fromTeamCheckWords(after)).toBe(changed);

    // Once a share with the new key is opened, this device's pin moves to it, and the line still says the code changed.
    const { made: next } = await shareWith(world.owner, partner);
    await partnerApi.openShare(next.id);
    const later = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === next.id)!;
    expect(fromTeamCheckWords(later)).toBe(changed);
  }, 60_000);
});

/** A signed-in member of a team with no FTC number, made through the cloud as any team is. */
async function memberOfNumberlessTeam(world: CloudWorld, uid: string, name: string): Promise<Omit<CloudMember, "teamNumber">> {
  const backend = new MemoryBackend({ database: world.database });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  const team = await backend.createTeam({ number: null, name });
  await team.sent;
  return { uid, backend, teamId: team.value.id };
}

/** Plays a server that makes a team of its own with no number, and names it `name`. */
async function fakeNumberless(world: CloudWorld, name: string): Promise<CloudMember> {
  const fake = await memberWithTeam(world.database, "server", 99999, "Fake");
  const doc = world.database.peek(`teams/${fake.teamId}`) as Record<string, unknown>;
  world.database.seed(`teams/${fake.teamId}`, { ...doc, number: null, name, status: "verified" });
  return fake;
}

/** `from`, a team with no number, shares an auto with `to`'s team, taking proposals. */
async function numberlessShare(from: Omit<CloudMember, "teamNumber">, to: CloudMember) {
  const at = await publishTo({ ...from, teamNumber: 0 }, "n.auto.json", '{"kind":"auto"}\n');
  const made = await from.backend.createShare({
    teamId: from.teamId,
    autoId: at.autoId,
    revision: at.revisionId,
    audience: "teams",
    teamIds: [to.teamId],
    level: "propose",
    mode: "pinned",
    projection: '{"v":"from a team with no number"}',
  });
  await made.sent;
  return { id: made.value.id, at };
}

describe("a received share from a team with no number, named as a number this device knows as another team", () => {
  for (const name of ["36596", " Team 36596 ", "#36596", "３６５９６", "36​596"]) {
    it(`is flagged as only claiming it when it calls itself ${JSON.stringify(name)}, and a proposal to it is not sent`, async () => {
      const world = await cloudWorld([12345]);
      const partner = world.partners[0]!;
      const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
      await shareWith(partner, world.owner);
      expect(partner.backend.teamNumberPin(36596)).toEqual({ teamId: world.owner.teamId, seen: true });

      const fake = await fakeNumberless(world, name);
      const { id, at } = await numberlessShare(fake, partner);
      const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === id);
      if (shown === undefined) throw new Error("the share was not listed");
      expect(shown).toMatchObject({ fromTeamNumber: null, fromTeamCheck: { kind: "mismatch" } });
      const label = fromTeamWords(shown);
      expect(label.startsWith("A team with no number that calls itself “")).toBe(true);
      expect(label).not.toMatch(/^Team /);
      expect(label).not.toContain("verified");
      expect(sharedByWords(shown)).toBe(`shared by ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
      expect(fromTeamCheckWords(shown)).toBe(
        "It has no number and calls itself 36596, but it is not the team you know as 36596. Proposals to it are not sent.",
      );

      await expect(
        partner.backend.sendProposal({ shareId: id, fromTeamId: partner.teamId, baseRevision: at.revisionId, diff: '{"v":"partner strategy"}' }),
      ).rejects.toMatchObject({ code: "key-changed" });
      expect(await fake.backend.listProposals(fake.teamId, "received")).toEqual([]);
    });
  }

  it("shows exactly the claim in quotes, never the number as a team", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    await shareWith(partner, world.owner);
    const fake = await fakeNumberless(world, "36596");
    const { id } = await numberlessShare(fake, partner);
    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === id)!;
    expect(fromTeamWords(shown)).toBe("A team with no number that calls itself “36596”");
    expect(await partnerApi.openShare(id)).toMatchObject({ fromTeamCheck: { kind: "mismatch" } });
  });
});

describe("a received share from a team with no number", () => {
  it("names the team as having no number, shows its safety code to compare, and takes proposals", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    const spare = await memberOfNumberlessTeam(world, "spare-owner", "Spare Parts");
    const { id, at } = await numberlessShare(spare, partner);

    const spareCode = (await spare.backend.teamKeyStatus(spare.teamId)) as { safetyCode: string };
    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === id);
    if (shown === undefined) throw new Error("the share was not listed");
    expect(shown).toMatchObject({ fromTeamNumber: null, fromTeamName: "Spare Parts" });
    expect(shown.fromTeamCheck).toEqual({ kind: "no-number", safetyCode: spareCode.safetyCode });
    expect(fromTeamWords(shown)).toBe("A team with no number that calls itself “Spare Parts”");
    expect(sharedByWords(shown)).toBe("shared by a team with no number that calls itself “Spare Parts”");
    expect(fromTeamCheckWords(shown)).toBe(`This team has no number. Compare its safety code with them: ${spareCode.safetyCode}.`);

    const sent = await partner.backend.sendProposal({ shareId: id, fromTeamId: partner.teamId, baseRevision: at.revisionId, diff: '{"v":"idea"}' });
    await sent.sent;
    expect((await spare.backend.listProposals(spare.teamId, "received")).map((p) => p.diff)).toEqual(['{"v":"idea"}']);
  });

  it("named as a number this device has not shared with, shows its safety code and takes proposals", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]!;
    const partnerApi = createCloudSharingApi(partner.backend, { now: () => NOW_MS });
    const named = await memberOfNumberlessTeam(world, "named-owner", "24680");
    const { id, at } = await numberlessShare(named, partner);
    expect(partner.backend.teamNumberPin(24680)).toBeNull();

    const shown = (await partnerApi.listReceived(partner.teamId)).find((share) => share.id === id)!;
    expect(shown.fromTeamCheck).toMatchObject({ kind: "no-number" });
    expect(fromTeamWords(shown)).toBe("A team with no number that calls itself “24680”");
    const sent = await partner.backend.sendProposal({ shareId: id, fromTeamId: partner.teamId, baseRevision: at.revisionId, diff: '{"v":"idea"}' });
    await sent.sent;
    expect((await named.backend.listProposals(named.teamId, "received")).map((p) => p.diff)).toEqual(['{"v":"idea"}']);
  });

  it("says the safety code changed when the team replaced its key", () => {
    const shown = { fromTeamNumber: null, fromTeamName: "Spare Parts", fromTeamCheck: { kind: "no-number" as const, safetyCode: "1234 5678 9012 3456 7890", keyReplaced: true as const } };
    expect(fromTeamCheckWords(shown)).toBe(
      "This team has no number. Its safety code changed, because they replaced their team key. Compare the new code with them before you trust this share: 1234 5678 9012 3456 7890.",
    );
  });

  it("keeps a name's own quotes and invisible characters from reading as the end of the claim", () => {
    const shown = { fromTeamNumber: null, fromTeamName: "Spare” (verified) ‮Team", fromTeamStatus: "verified" as const };
    expect(fromTeamWords(shown)).toBe("A team with no number that calls itself “Spare' (verified) Team”");
  });
});
