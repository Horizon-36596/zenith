/**
 * A first share with a team is never made without its safety code shown. The share dialog checks
 * each number before it sends (`checkPartnerKeys`), and the send looks each number up again. A
 * server that answers "no such team" to the check and points the number at a team of its own for
 * the send used to get a first share made with no code shown, and its key trusted on first use.
 * Now the check says plainly that it found no team, and the send refuses any number whose code this
 * device has neither shown now nor recorded as seen before.
 *
 * Runs against the in-memory cloud and its real rules.
 */
import { describe, expect, it } from "vitest";
import { NOW_MS, cloudWorld, memberWithTeam, publishTo } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { NO_ANSWERS, answerOptions, needsSafetyCodeShown, withAnswer } from "./keyAnswers";
import { checkPartnerKeys, createShare, getCloud, setSharingBackend } from "./store";
import type { CreateShareOptions, PartnerKeyWarning, ShareRequest } from "./types";

const DAY = 86_400_000;

const answerEach = (warnings: readonly PartnerKeyWarning[]): CreateShareOptions => answerOptions(warnings.reduce(withAnswer, NO_ANSWERS));

async function setup() {
  const world = await cloudWorld([12345]);
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
  const request = (teamNumbers: number[]): ShareRequest => ({
    autoId: at.autoId,
    audience: "teams",
    teamNumbers,
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
    projection: '{"kind":"projection","secret":"meant for 12345"}',
  });
  return { world, api, request };
}

describe("a first share whose safety code the dialog never showed", () => {
  it("is refused when the server hides the team from the check and shows its own team to the send", async () => {
    const { world, api, request } = await setup();
    // The server's own team, which will take number 12345's claim at the send.
    const fake = await memberWithTeam(world.database, "server", 99999, "Partner team 1");
    const claim = world.database.peek("claims/12345") as Record<string, unknown>;

    // The dialog's check: the server says no team holds 12345. The check says so, rather than
    // returning nothing to warn about.
    world.database.seed("claims/12345", { ...claim, teamId: null });
    await expect(api.checkPartnerKeys([12345])).rejects.toThrow(/^No team on Zenith has claimed number 12345/);

    // The send, a moment later: the claim leads to the server's team. Nothing is made.
    world.database.seed("claims/12345", { ...claim, teamId: fake.teamId });
    const fakeTeam = world.database.peek(`teams/${fake.teamId}`) as Record<string, unknown>;
    world.database.seed(`teams/${fake.teamId}`, { ...fakeTeam, number: 12345 });
    const refused = await api.createShare(world.owner.teamId, request([12345]), answerOptions(NO_ANSWERS)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(
      "Did not share with team 12345: this device has not shown you that team's safety code yet. Share again to see it, and compare it with that team.",
    );
    // The dialog can tell this refusal from any other, and checks again to show the code.
    expect(needsSafetyCodeShown(refused)).toBe(true);
    expect(await world.owner.backend.listTeamShares(world.owner.teamId)).toEqual([]);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();

    // Checking again now shows the team the number leads to, with its safety code.
    expect((await api.checkPartnerKeys([12345])).map((warning) => [warning.kind, warning.teamId])).toEqual([["first-use", fake.teamId]]);
  });

  it("is refused when made with no dialog at all, and pins nothing", async () => {
    const { world, api, request } = await setup();
    await expect(api.createShare(world.owner.teamId, request([12345]))).rejects.toThrow(/has not shown you that team's safety code yet/);
    expect(world.owner.backend.teamNumberPin(12345)).toBeNull();
    expect((await api.checkPartnerKeys([12345])).map((warning) => warning.kind)).toEqual(["first-use"]);
  });

  it("is made once the code was shown, and again later without asking", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    const made = await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    expect(made.teamNumbers).toEqual([12345]);
    expect(world.owner.backend.teamNumberPin(12345)).toEqual({ teamId: partner.teamId, seen: true });
    // A number whose code this device recorded as seen needs no answer again.
    const again = await api.createShare(world.owner.teamId, request([12345]));
    expect(again.teamNumbers).toEqual([12345]);
  });

  it("does not count an answer about another team than the one the number leads to", async () => {
    const { world, api, request } = await setup();
    const fake = await memberWithTeam(world.database, "server", 99999, "Partner team 1");
    const shown = answerEach(await api.checkPartnerKeys([12345]));
    // The answer names the real partner; the server now leads the number elsewhere.
    const claim = world.database.peek("claims/12345") as Record<string, unknown>;
    world.database.seed("claims/12345", { ...claim, teamId: fake.teamId });
    await expect(api.createShare(world.owner.teamId, request([12345]), shown)).rejects.toThrow(/led to a different team a moment ago/);
    expect(await world.owner.backend.listTeamShares(world.owner.teamId)).toEqual([]);
  });
});

describe("the sharing store, as the share dialog uses it", () => {
  it("tells the dialog a share was refused for a code never shown, so it checks again and shows the code", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    let refusedForCode = 0;
    expect(
      await createShare(request([12345]), "Shared.", {}, () => {
        refusedForCode += 1;
      }),
    ).toBeNull();
    expect(refusedForCode).toBe(1);
    expect(getCloud().error).toMatch(/has not shown you that team's safety code yet/);
    // What the dialog does next: check again, which shows the code to compare.
    const checked = await checkPartnerKeys([12345]);
    expect(checked.ok && checked.warnings.map((warning) => [warning.kind, warning.teamId])).toEqual([["first-use", partner.teamId]]);
    expect(getCloud().error).toBeNull();
  });

  it("does not call it for any other refusal, and says when the check finds no team", async () => {
    const { world, api, request } = await setup();
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    let refusedForCode = 0;
    expect(
      await createShare(request([99999]), "Shared.", {}, () => {
        refusedForCode += 1;
      }),
    ).toBeNull();
    expect(refusedForCode).toBe(0);
    expect(await checkPartnerKeys([99999])).toEqual({ ok: false, why: expect.stringMatching(/^No team on Zenith has claimed number 99999/) as unknown });
    expect(getCloud().error).toMatch(/^No team on Zenith has claimed number 99999/);
  });
});
