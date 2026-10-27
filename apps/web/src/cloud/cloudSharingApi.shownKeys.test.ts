/**
 * The safety code the share dialog shows is bound to the key the share is wrapped to. The dialog
 * shows the code of the key the server serves when it checks; the send reads the key again. A server
 * that serves another key on that second read, one that is also new to this device, must not get the
 * share, and must not have that key recorded as the one the person saw. The same holds for a changed
 * key or a changed number the person accepted: what is trusted is exactly the key they were shown.
 *
 * Every answer here goes through the dialog's own answer logic (`keyAnswers.ts`), and everything
 * runs against the in-memory cloud and its real rules.
 */
import { describe, expect, it } from "vitest";
import { createTeamKeys, teamEncKeyFor } from "@horizon36596/zenith-cloud/crypto";
import { NOW_MS, cloudWorld, memberWithTeam, publishTo, type CloudMember, type CloudWorld } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { NO_ANSWERS, answerOptions, answered, withAnswer } from "./keyAnswers";
import type { CreateShareOptions, PartnerKeyWarning, ShareRequest } from "./types";

const DAY = 86_400_000;

async function setup() {
  const world = await cloudWorld([12345]);
  const partner = world.partners[0];
  if (partner === undefined) throw new Error("no partner");
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
  const request = (projection = '{"kind":"secret projection"}'): ShareRequest => ({
    autoId: at.autoId,
    audience: "teams",
    teamNumbers: [12345],
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
    projection,
  });
  return { world, partner, api, request };
}

/** The options the dialog sends once the person chose to send on every one of `warnings`. */
function answerEach(warnings: readonly PartnerKeyWarning[]): CreateShareOptions {
  return answerOptions(warnings.reduce(withAnswer, NO_ANSWERS));
}

/** Plays a server that serves `teamId` with a key pair of its own under the same version. */
async function swapKey(world: CloudWorld, teamId: string): Promise<void> {
  const forged = await createTeamKeys(teamId);
  const doc = world.database.peek(`teams/${teamId}`) as Record<string, unknown>;
  world.database.seed(`teams/${teamId}`, { ...doc, encKey: teamEncKeyFor(forged.pair) });
}

/** Plays a server that makes a team of its own and points `number`'s claim at it, marked verified. */
async function pointClaimAtServerTeam(world: CloudWorld, number: number): Promise<CloudMember> {
  const fake = await memberWithTeam(world.database, "server", 99999, "Partner team 1");
  const claim = world.database.peek(`claims/${String(number)}`) as Record<string, unknown>;
  world.database.seed(`claims/${String(number)}`, { ...claim, teamId: fake.teamId, status: "verified" });
  const fakeTeam = world.database.peek(`teams/${fake.teamId}`) as Record<string, unknown>;
  world.database.seed(`teams/${fake.teamId}`, { ...fakeTeam, number, status: "verified" });
  return fake;
}

/** What reached `member`'s team: the projections of the shares it can open. */
async function receivedBy(member: CloudMember): Promise<string[]> {
  return (await member.backend.listReceivedShares(member.teamId)).map((share) => share.projection);
}

describe("the key a first share is wrapped to", () => {
  it("refuses a key the server swaps in after the person saw the real team's code", async () => {
    const { world, partner, api, request } = await setup();
    const warnings = await api.checkPartnerKeys([12345]);
    const realCode = (await partner.backend.teamKeyStatus(partner.teamId)) as { safetyCode: string };
    expect(warnings).toMatchObject([{ kind: "first-use", teamNumber: 12345, teamName: "Partner team 1", safetyCode: realCode.safetyCode }]);

    // The person compares the code with the partner in person, and it matches. Then the server
    // serves a key of its own, still new to this device.
    await swapKey(world, partner.teamId);
    await expect(api.createShare(world.owner.teamId, request(), answerEach(warnings))).rejects.toThrow(
      /not the one whose safety code you were shown, so nothing was sent/,
    );

    // Nothing was made, and nothing records that the person saw the server's key.
    expect(await api.listShares(world.owner.teamId)).toEqual([]);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
    const again = await api.checkPartnerKeys([12345]);
    expect(again.map((warning) => warning.kind)).toEqual(["first-use"]);
    expect(again[0]?.safetyCode).not.toBe(realCode.safetyCode);
  });

  it("shares with the key that was shown, and records that the person saw it", async () => {
    const { world, partner, api, request } = await setup();
    const warnings = await api.checkPartnerKeys([12345]);
    const made = await api.createShare(world.owner.teamId, request(), answerEach(warnings));
    expect(made.teamNumbers).toEqual([12345]);
    expect(await receivedBy(partner)).toEqual(['{"kind":"secret projection"}']);
    expect(world.owner.backend.teamNumberPin(12345)).toEqual({ teamId: partner.teamId, seen: true });
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("shows the code again, rather than taking the old answer, when a second check finds another key", async () => {
    const { world, partner, api } = await setup();
    const first = await api.checkPartnerKeys([12345]);
    const answers = first.reduce(withAnswer, NO_ANSWERS);
    // The dialog checks again before it sends; by then the server serves a key of its own.
    await swapKey(world, partner.teamId);
    const second = await api.checkPartnerKeys([12345]);
    expect(second.map((warning) => warning.kind)).toEqual(["first-use"]);
    expect(second.filter((warning) => !answered(answers, warning))).toEqual(second);
    // The answer still counts for the key it was given about.
    expect(first.every((warning) => answered(answers, warning))).toBe(true);
  });
});

describe("a changed key the person accepts", () => {
  it("trusts exactly the key whose code was shown, and refuses another one swapped in after", async () => {
    const { world, partner, api, request } = await setup();
    await api.createShare(world.owner.teamId, request('{"v":"first"}'), answerEach(await api.checkPartnerKeys([12345])));

    await swapKey(world, partner.teamId);
    const shown = await api.checkPartnerKeys([12345]);
    expect(shown.map((warning) => warning.kind)).toEqual(["key-changed"]);
    // A second key swapped in between the warning and the send is not the one accepted.
    await swapKey(world, partner.teamId);
    await expect(api.createShare(world.owner.teamId, request('{"v":"second"}'), answerEach(shown))).rejects.toThrow(
      /not the one whose safety code you were shown/,
    );
    // Accepting a change without naming the key shown accepts nothing.
    await expect(api.createShare(world.owner.teamId, request('{"v":"second"}'), { acceptKeyChanges: [12345] })).rejects.toThrow(/safety code/);
    expect((await api.listShares(world.owner.teamId)).map((share) => share.projection)).toEqual(['{"v":"first"}']);

    // Answering the warning for the key served now shares, and pins that key.
    const now = await api.checkPartnerKeys([12345]);
    await api.createShare(world.owner.teamId, request('{"v":"accepted"}'), answerEach(now));
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });
});

describe("a changed number the person accepts", () => {
  it("wraps to the key of the new team that was shown, and refuses a key that team shows after", async () => {
    const { world, api, request } = await setup();
    await api.createShare(world.owner.teamId, request('{"v":"first"}'), answerEach(await api.checkPartnerKeys([12345])));

    // The server points 12345 at a team of its own, which the person chooses after comparing codes.
    const fake = await pointClaimAtServerTeam(world, 12345);
    const shown = await api.checkPartnerKeys([12345]);
    expect(shown.map((warning) => warning.kind)).toEqual(["number-changed"]);

    await swapKey(world, fake.teamId);
    await expect(api.createShare(world.owner.teamId, request('{"v":"second"}'), answerEach(shown))).rejects.toThrow(
      /not the one whose safety code you were shown/,
    );
    expect(await receivedBy(fake)).toEqual([]);
  });
});

describe("the partner's safety code this device shows", () => {
  it("is the code of the key this device pinned, and says when the server shows another", async () => {
    const { world, partner, api, request } = await setup();
    await api.createShare(world.owner.teamId, request(), answerEach(await api.checkPartnerKeys([12345])));
    const real = (await partner.backend.teamKeyStatus(partner.teamId)) as { safetyCode: string };
    expect(await world.owner.backend.teamSafetyCode(partner.teamId)).toEqual({ safetyCode: real.safetyCode, pinned: true, serverKeyDiffers: false });

    await swapKey(world, partner.teamId);
    expect(await world.owner.backend.teamSafetyCode(partner.teamId)).toEqual({ safetyCode: real.safetyCode, pinned: true, serverKeyDiffers: true });
  });

  it("names the earlier team by the code this device pinned for it, when its number moves on", async () => {
    const { world, partner, api, request } = await setup();
    await api.createShare(world.owner.teamId, request(), answerEach(await api.checkPartnerKeys([12345])));
    const real = (await partner.backend.teamKeyStatus(partner.teamId)) as { safetyCode: string };
    // The server swaps the old team's key too, so its code would match whatever it likes.
    await swapKey(world, partner.teamId);
    await pointClaimAtServerTeam(world, 12345);
    const warnings = await api.checkPartnerKeys([12345]);
    expect(warnings).toMatchObject([{ kind: "number-changed", previousSafetyCode: real.safetyCode }]);
  });
});
