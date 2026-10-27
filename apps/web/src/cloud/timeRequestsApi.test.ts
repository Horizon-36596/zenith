/**
 * Requests for more time (spec 13 section 8.4) through the web adapter, against the in-memory
 * cloud and its real permission rules: team 12345 asks Horizon for more time on a share, Horizon
 * reads the request and grants or declines it, and a grant moves the share's end. Also the pure
 * helpers the forms use to turn a pick into an end, and the `queued` mark a write made offline
 * carries, which the confirmations use to say the write is still on this computer (section 6).
 */
import { describe, expect, it } from "vitest";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import {
  TIME_REQUEST_REASON_IDS,
  TIME_REQUEST_REASON_WORDS,
  createCloudTimeRequestsApi,
  moreDays,
  pickInstant,
  pickProblem,
  requestsOfShare,
  type CloudTimeRequest,
} from "./timeRequestsApi";

const DAY = 86_400_000;
const inDays = (days: number): string => new Date(NOW_MS + days * DAY).toISOString();

/** Horizon shares an auto with team 12345 for `days` days. */
async function sharedFor(days: number) {
  const world = await cloudWorld([12345]);
  ownerSawPartnerCodes(world);
  const partner = world.partners[0];
  if (partner === undefined) throw new Error("no partner");
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const sharing = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
  const share = await sharing.createShare(world.owner.teamId, {
    autoId: at.autoId,
    audience: "teams",
    teamNumbers: [12345],
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: inDays(days),
    projection: '{"kind":"projection"}',
  });
  return {
    world,
    partner,
    share,
    sharing,
    asker: createCloudTimeRequestsApi(partner.backend),
    owner: createCloudTimeRequestsApi(world.owner.backend),
  };
}

const request = (patch: Partial<CloudTimeRequest>): CloudTimeRequest => ({
  shareId: "s1",
  teamId: "t1",
  team: "Team 12345",
  ownerTeamId: "t0",
  ownerTeam: "Team 36596",
  status: "open",
  reason: null,
  wantedUntil: null,
  requestedAt: inDays(0),
  decidedAt: null,
  grantedUntil: null,
  ...patch,
});

describe("the pure part of requests for more time", () => {
  it("has words for every reason the cloud takes", () => {
    for (const reason of TIME_REQUEST_REASON_IDS) expect(TIME_REQUEST_REASON_WORDS[reason]).toMatch(/\.$/);
  });

  it("counts more days from the share's end, or from now once it has ended or its end is unknown", () => {
    expect(moreDays(inDays(3), 7, NOW_MS)).toBe(inDays(10));
    expect(moreDays(inDays(-3), 7, NOW_MS)).toBe(inDays(7));
    expect(moreDays(null, 1, NOW_MS)).toBe(inDays(1));
  });

  it("turns each pick into an end, and says why one cannot be sent", () => {
    expect(pickInstant({ kind: "days", days: 30 }, inDays(2), null, NOW_MS)).toBe(inDays(32));
    expect(pickInstant({ kind: "asked" }, inDays(2), inDays(9), NOW_MS)).toBe(inDays(9));
    expect(pickInstant({ kind: "none" }, inDays(2), inDays(9), NOW_MS)).toBeNull();
    expect(pickInstant({ kind: "date", date: "not a date" }, null, null, NOW_MS)).toBeNull();

    expect(pickProblem({ kind: "none" }, null, null, NOW_MS, "ask")).toBeNull();
    expect(pickProblem({ kind: "none" }, null, null, NOW_MS, "grant")).toBe("Pick how much more time to give.");
    expect(pickProblem({ kind: "date", date: "" }, null, null, NOW_MS, "ask")).toBe("Pick the date it should end.");
    expect(pickProblem({ kind: "asked" }, inDays(-1), null, NOW_MS, "grant")).toBe("That end has already passed. Pick a later one.");
    // A grant never shortens a share; a request may name any later end.
    expect(pickProblem({ kind: "asked" }, inDays(3), inDays(5), NOW_MS, "grant")).toBe(
      "That is not later than the share ends now. Pick a later end.",
    );
    expect(pickProblem({ kind: "asked" }, inDays(3), inDays(5), NOW_MS, "ask")).toBeNull();
  });

  it("lists a share's requests open first, then newest first", () => {
    const listed = requestsOfShare(
      [
        request({ teamId: "a", status: "granted", requestedAt: inDays(2) }),
        request({ teamId: "b", status: "open", requestedAt: inDays(1) }),
        request({ teamId: "c", status: "declined", requestedAt: inDays(3) }),
        request({ shareId: "other", teamId: "d" }),
      ],
      "s1",
    );
    expect(listed.map((entry) => entry.teamId)).toEqual(["b", "c", "a"]);
  });
});

describe("requests for more time through the cloud", () => {
  it("goes from team 12345 to Horizon, is granted there, and moves the share's end", async () => {
    const { world, partner, share, sharing, asker, owner } = await sharedFor(2);

    const asked = await asker.ask({ shareId: share.id, teamId: partner.teamId, reason: "next-event", wantedUntil: inDays(14) });
    expect(asked.queued).toBe(false);
    expect(asked.value).toMatchObject({ shareId: share.id, team: "Team 12345 (unverified)", ownerTeam: "Team 36596 (unverified)", status: "open", reason: "next-event", wantedUntil: inDays(14) });
    // One open request at a time.
    await expect(asker.ask({ shareId: share.id, teamId: partner.teamId })).rejects.toThrow(/already/);

    const [received] = await owner.list(world.owner.teamId, "received");
    expect(received).toMatchObject({ shareId: share.id, teamId: partner.teamId, status: "open" });
    await owner.decide(share.id, partner.teamId, { status: "granted", expiresAt: inDays(14) });

    const [shareNow] = await sharing.listShares(world.owner.teamId);
    expect(shareNow?.expiresAt).toBe(inDays(14));
    const [sent] = await asker.list(partner.teamId, "sent");
    expect(sent).toMatchObject({ status: "granted", grantedUntil: inDays(14) });
  });

  it("is declined without changing the share, after which the team may ask again", async () => {
    const { world, partner, share, sharing, asker, owner } = await sharedFor(2);
    await asker.ask({ shareId: share.id, teamId: partner.teamId, reason: "still-testing" });
    await owner.decide(share.id, partner.teamId, { status: "declined" });
    const [shareNow] = await sharing.listShares(world.owner.teamId);
    expect(shareNow?.expiresAt).toBe(inDays(2));
    expect((await asker.list(partner.teamId, "sent"))[0]?.status).toBe("declined");
    expect((await asker.ask({ shareId: share.id, teamId: partner.teamId })).value.status).toBe("open");
  });

  it("refuses a request from a team the share was not made to, in a sentence", async () => {
    const { world, share } = await sharedFor(2);
    // Horizon's own team is not among the teams the share was made to.
    const own = createCloudTimeRequestsApi(world.owner.backend);
    await expect(own.ask({ shareId: share.id, teamId: world.owner.teamId })).rejects.toThrow(
      "That share was not made to your team, so there is no team to ask.",
    );
  });

  it("marks a request made offline as queued, and it reaches Horizon once the connection is back", async () => {
    const { world, partner, share, asker, owner } = await sharedFor(2);
    // The Partners panel has read the share while online, as it does before showing the button.
    await createCloudSharingApi(partner.backend, { now: () => NOW_MS }).listReceived(partner.teamId);
    await partner.backend.setOnline(false);
    const asked = await asker.ask({ shareId: share.id, teamId: partner.teamId, reason: "still-planning" });
    expect(asked.queued).toBe(true);
    expect(await owner.list(world.owner.teamId, "received")).toEqual([]);
    await partner.backend.setOnline(true);
    const [received] = await owner.list(world.owner.teamId, "received");
    expect(received).toMatchObject({ shareId: share.id, reason: "still-planning", status: "open" });
  });

  it("marks a share made offline as queued, so its confirmation can say it is still on this computer", async () => {
    const { world, share } = await sharedFor(2);
    await world.owner.backend.setOnline(false);
    const sharing = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    const made = await sharing.createShare(world.owner.teamId, {
      autoId: share.autoId,
      audience: "teams",
      teamNumbers: [12345],
      level: "view",
      mode: "pinned",
      revision: share.revision,
      revisionId: share.revisionId,
      expiresAt: inDays(7),
      projection: '{"kind":"projection"}',
    });
    expect(made.queued).toBe(true);
    expect(share.queued).toBeUndefined();
  });

  it("lists a share that has ended among the team's ended shares", async () => {
    const { partner, share, asker, sharing } = await sharedFor(2);
    expect(await asker.ended(partner.teamId)).toEqual([]);
    await sharing.revokeShare(share.id);
    const [ended] = await asker.ended(partner.teamId);
    expect(ended).toMatchObject({ shareId: share.id, fromTeam: "Team 36596 (unverified)" });
  });
});
