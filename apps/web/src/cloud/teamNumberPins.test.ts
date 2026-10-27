/**
 * Sharing by team number, when the server is not to be trusted with the number. The web app turns a
 * typed number into a team through the number's claim record, which the server writes, verified or
 * not. So this device pins each number to the team it shared with under it, per signed-in user, and
 * asks before sending to a team whose safety code it never showed.
 *
 * Runs against the in-memory cloud and its real rules.
 */
import { describe, expect, it, vi } from "vitest";
import { NOW_MS, cloudWorld, memberWithTeam, publishTo, type CloudWorld } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { NO_ANSWERS, answerOptions, withAnswer } from "./keyAnswers";
import type { CreateShareOptions, PartnerKeyWarning, ShareRequest } from "./types";

const DAY = 86_400_000;

/** The options the share dialog sends once the person chose to send on every one of `warnings`. */
const answerEach = (warnings: readonly PartnerKeyWarning[]): CreateShareOptions => answerOptions(warnings.reduce(withAnswer, NO_ANSWERS));

async function setup(numbers: number[] = [12345]) {
  const world = await cloudWorld(numbers);
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const results: Array<{ ok: boolean; sentence: string }> = [];
  const api = createCloudSharingApi(world.owner.backend, {
    now: () => NOW_MS,
    onPendingResult: (result) => {
      results.push(result);
    },
  });
  const request = (teamNumbers: number[], projection = '{"kind":"projection"}'): ShareRequest => ({
    autoId: at.autoId,
    audience: "teams",
    teamNumbers,
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
    projection,
  });
  return { world, api, request, results };
}

/**
 * Plays a server that makes a team of its own, gives it `number`, and points the number's claim at
 * it, marked verified as a Horizon admin would.
 */
async function pointClaimAtServerTeam(world: CloudWorld, number: number) {
  const fake = await memberWithTeam(world.database, "server", 99999, "Partner team 1");
  const claim = world.database.peek(`claims/${String(number)}`) as Record<string, unknown>;
  world.database.seed(`claims/${String(number)}`, { ...claim, teamId: fake.teamId, status: "verified" });
  const fakeTeam = world.database.peek(`teams/${fake.teamId}`) as Record<string, unknown>;
  world.database.seed(`teams/${fake.teamId}`, { ...fakeTeam, number, status: "verified" });
  return fake;
}

describe("a team number the server points at a team of its own", () => {
  it("asks about the changed number with both safety codes, and sends nothing until the person chooses", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    // A first share, after seeing the partner's safety code, pins the number to the real partner.
    await api.createShare(world.owner.teamId, request([12345], '{"v":"first"}'), answerEach(await api.checkPartnerKeys([12345])));
    expect(await api.checkPartnerKeys([12345])).toEqual([]);

    const fake = await pointClaimAtServerTeam(world, 12345);
    const warnings = await api.checkPartnerKeys([12345]);
    expect(warnings).toEqual([
      {
        kind: "number-changed",
        teamNumber: 12345,
        teamName: "Partner team 1",
        safetyCode: (await world.owner.backend.teamSafetyCode(fake.teamId)).safetyCode,
        teamId: fake.teamId,
        keyId: (await world.owner.backend.checkPartnerKeys([fake.teamId]))[0]?.keyId,
        previousTeamName: "Partner team 1",
        previousSafetyCode: (await world.owner.backend.teamSafetyCode(partner.teamId)).safetyCode,
      },
    ]);

    // No silent share: the adapter refuses it even when the dialog is skipped.
    await expect(api.createShare(world.owner.teamId, request([12345], '{"v":"second, meant for 12345"}'))).rejects.toThrow(
      "Team number 12345 now leads to a different team from the one this device shared with before. Compare both teams' safety codes before sharing with it.",
    );
    expect(await fake.backend.listReceivedShares(fake.teamId)).toEqual([]);
    expect((await api.listShares(world.owner.teamId)).map((share) => share.projection)).toEqual(['{"v":"first"}']);
  });

  it("shares with the new team only once the person accepts the change, and pins the number to it", async () => {
    const { world, api, request } = await setup();
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    const fake = await pointClaimAtServerTeam(world, 12345);
    const shown = await api.checkPartnerKeys([12345]);
    expect(shown.map((warning) => warning.kind)).toEqual(["number-changed"]);
    const made = await api.createShare(world.owner.teamId, request([12345], '{"v":"chosen"}'), answerEach(shown));
    expect(made.teamNumbers).toEqual([12345]);
    expect((await fake.backend.getShare(made.id, fake.teamId))?.projection).toBe('{"v":"chosen"}');
    expect(world.owner.backend.teamNumberPin(12345)).toEqual({ teamId: fake.teamId, seen: true });
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("refuses a first share when the number leads to another team than the one whose code was just shown", async () => {
    const { world, api, request } = await setup();
    const shown = await api.checkPartnerKeys([12345]);
    expect(shown.map((warning) => warning.kind)).toEqual(["first-use"]);
    // Between the dialog showing the real partner's code and the send, the server swaps the claim.
    const fake = await pointClaimAtServerTeam(world, 12345);
    await expect(api.createShare(world.owner.teamId, request([12345]), answerEach(shown))).rejects.toThrow(
      "Team number 12345 led to a different team a moment ago, so nothing was sent. Share again to see the team it leads to now.",
    );
    expect(await fake.backend.listReceivedShares(fake.teamId)).toEqual([]);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
  });

  it("refuses a share that waited for the connection when the number changed meanwhile", async () => {
    const { world, api, request, results } = await setup();
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    const fake = await pointClaimAtServerTeam(world, 12345);
    forgetClaim(world, 12345);
    await world.owner.backend.setOnline(false);
    const waiting = await api.createShare(world.owner.teamId, request([12345]));
    expect(waiting.waitsForConnection).toBe(true);
    await world.owner.backend.setOnline(true);
    // The share that waited sends in the background once the connection is back.
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.sentence).toMatch(/^Did not share with team 12345: Team number 12345 now leads to a different team/);
    expect(await fake.backend.listReceivedShares(fake.teamId)).toEqual([]);
  });
});

describe("the first share with a team", () => {
  it("shows the team's safety code before sending, and records that the person saw it", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    expect(await api.checkPartnerKeys([12345])).toEqual([
      {
        kind: "first-use",
        teamNumber: 12345,
        teamName: "Partner team 1",
        safetyCode: (await world.owner.backend.teamSafetyCode(partner.teamId)).safetyCode,
        teamId: partner.teamId,
        keyId: (await world.owner.backend.checkPartnerKeys([partner.teamId]))[0]?.keyId,
      },
    ]);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    expect(world.owner.backend.teamNumberPin(12345)).toEqual({ teamId: partner.teamId, seen: true });
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("asks for a verified claim too", async () => {
    const { world, api } = await setup();
    const claim = world.database.peek("claims/12345") as Record<string, unknown>;
    world.database.seed("claims/12345", { ...claim, status: "verified" });
    expect((await api.checkPartnerKeys([12345])).map((warning) => warning.kind)).toEqual(["first-use"]);
  });

  it("refuses a first share made without showing the code, pins nothing, and shows the code next time", async () => {
    const { world, api, request } = await setup();
    await expect(api.createShare(world.owner.teamId, request([12345]))).rejects.toThrow(
      "Did not share with team 12345: this device has not shown you that team's safety code yet. Share again to see it, and compare it with that team.",
    );
    expect(await world.owner.backend.listTeamShares(world.owner.teamId)).toEqual([]);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
    expect((await api.checkPartnerKeys([12345])).map((warning) => warning.kind)).toEqual(["first-use"]);
  });
});

describe("a team number this device shared with before", () => {
  it("asks nothing when the number still leads to the same team", async () => {
    const { world, api, request } = await setup();
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
    const again = await api.createShare(world.owner.teamId, request([12345]));
    expect(again.teamNumbers).toEqual([12345]);
    // A share made without the dialog does not undo the record that the code was seen.
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("is pinned for the signed-in user only: another user on the same device is asked again", async () => {
    const { world, api, request } = await setup([12345, 23456]);
    const other = world.partners[1];
    if (other === undefined) throw new Error("no second partner");
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    expect(await api.checkPartnerKeys([12345])).toEqual([]);

    // The second partner's owner signs in on this device, with its pins kept.
    world.owner.backend.signInAs(other.uid);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
    expect((await api.checkPartnerKeys([12345])).map((warning) => warning.kind)).toEqual(["first-use"]);

    world.owner.backend.signInAs(world.owner.uid);
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("still makes a share that waited for the connection, once it is back", async () => {
    const { world, api, request, results } = await setup([12345, 23456]);
    await api.createShare(world.owner.teamId, request([23456]), answerEach(await api.checkPartnerKeys([23456])));
    forgetClaim(world, 23456);
    await world.owner.backend.setOnline(false);
    const waiting = await api.createShare(world.owner.teamId, request([23456]));
    expect(waiting.waitsForConnection).toBe(true);
    await world.owner.backend.setOnline(true);
    // The share that waited sends in the background once the connection is back.
    await vi.waitFor(() => expect(results).toHaveLength(1));
    // With the id the share dialog waits on, and the share that was made, which it then shows.
    expect(results).toEqual([
      { ok: true, sentence: "Back online: shared with team 23456.", waitingId: waiting.id, share: expect.objectContaining({ teamNumbers: [23456] }) },
    ]);
  });
});

/** Plays a device that has not read the number's claim since the page loaded, so offline it cannot. */
function forgetClaim(world: CloudWorld, number: number): void {
  const connection = (world.owner.backend as unknown as { connection: { cache: Map<string, unknown> } }).connection;
  connection.cache.delete(`claims/${String(number)}`);
}
