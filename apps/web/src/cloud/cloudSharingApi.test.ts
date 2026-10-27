/**
 * The sharing adapter against the in-memory cloud and its real permission rules
 * (spec 13 section 8, ADR 0009 section 4): every `SharingApi` method, team
 * numbers turned into team ids and back, revision ids and numbers, every failure as a sentence, and
 * the eight-team limit checked before anything is sent.
 */
import { describe, expect, it } from "vitest";
import { CloudError } from "@horizon36596/zenith-cloud";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo, type CloudWorld } from "./cloudFixture.test";
import { SHARE_TEAM_LIMIT, createCloudSharingApi, sharingErrorSentence, teamLimitProblem } from "./cloudSharingApi";
import type { ShareRequest } from "./types";

const DAY = 86_400_000;
const PROJECTION = '{"kind":"projection"}';
const inDays = (days: number): string => new Date(NOW_MS + days * DAY).toISOString();

type Request = ShareRequest;

async function sharingSetup(partners?: readonly number[]) {
  const world = await cloudWorld(partners);
  ownerSawPartnerCodes(world);
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
  const request = (patch: Partial<Request> = {}): Request => ({
    autoId: at.autoId,
    audience: "teams",
    teamNumbers: [12345],
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: inDays(7),
    projection: PROJECTION,
    ...patch,
  });
  return { world, at, api, request };
}

const partnerApi = (world: CloudWorld, index: number) => {
  const partner = world.partners[index];
  if (partner === undefined) throw new Error(`no partner ${String(index)}`);
  return { partner, api: createCloudSharingApi(partner.backend, { now: () => NOW_MS }) };
};

describe("the cloud sharing adapter", () => {
  it("creates a share to teams named by number, and lists it back with numbers, the revision and ISO times", async () => {
    const { world, at, api, request } = await sharingSetup();
    const made = await api.createShare(world.owner.teamId, request({ teamNumbers: [12345, 23456] }));
    expect(made).toMatchObject({
      autoId: at.autoId,
      audience: "teams",
      teamNumbers: [12345, 23456],
      revision: 1,
      revisionId: at.revisionId,
      expiresAt: inDays(7),
      revokedAt: null,
      projection: PROJECTION,
    });
    // Stored under the cloud's team ids, with an inbox entry for each team.
    const stored = world.database.peek(`shares/${made.id}`);
    expect(stored?.teamIds).toEqual([world.partners[0]?.teamId, world.partners[1]?.teamId]);
    expect(stored?.revision).toBe(at.revisionId);
    expect(world.database.peek(`teams/${world.partners[1]?.teamId ?? ""}/inbox/${made.id}`)).not.toBeNull();

    // Read back, it is the same share; only the creation time is now the server's own stamp.
    const [listed] = await api.listShares(world.owner.teamId);
    expect({ ...listed, createdAt: "" }).toEqual({ ...made, createdAt: "" });
    expect(Math.abs(Date.parse(listed?.createdAt ?? "") - NOW_MS)).toBeLessThan(1000);
  });

  it("creates an anyone-with-the-link share with no teams, which only views", async () => {
    const { world, api, request } = await sharingSetup();
    const link = await api.createShare(world.owner.teamId, request({ audience: "link", teamNumbers: [] }));
    expect(link).toMatchObject({ audience: "link", teamNumbers: [], level: "view" });
    await expect(api.createShare(world.owner.teamId, request({ audience: "link", teamNumbers: [], level: "propose" }))).rejects.toThrow(
      "An anyone-with-the-link share is view only.",
    );
  });

  it("refuses, in sentences, a number nobody holds, the sharer's own team, no team, and no end date", async () => {
    const { world, api, request } = await sharingSetup();
    await expect(api.createShare(world.owner.teamId, request({ teamNumbers: [99999] }))).rejects.toThrow(
      /No team on Zenith has claimed number 99999/,
    );
    await expect(api.createShare(world.owner.teamId, request({ teamNumbers: [36596] }))).rejects.toThrow(/your own team/);
    await expect(api.createShare(world.owner.teamId, request({ teamNumbers: [] }))).rejects.toThrow(
      "Add at least one team number first.",
    );
    await expect(api.createShare(world.owner.teamId, request({ expiresAt: null }))).rejects.toThrow(/needs a date it ends/);
    expect(await api.listShares(world.owner.teamId)).toEqual([]);
  });

  it("holds the eight-team limit of ADR 0009 before sending anything", async () => {
    expect(SHARE_TEAM_LIMIT).toBe(8);
    expect(teamLimitProblem(8)).toBeNull();
    expect(teamLimitProblem(9)).toBe(
      "One share can name at most 8 teams, and this one names 9. Share with the first 8, then make a second share for the others.",
    );
    const numbers = [11111, 11112, 11113, 11114, 11115, 11116, 11117, 11118, 11119];
    const { world, api, request } = await sharingSetup(numbers);
    const before = world.database.paths().length;
    await expect(api.createShare(world.owner.teamId, request({ teamNumbers: numbers }))).rejects.toThrow(teamLimitProblem(9) ?? "");
    // Refused before a single read or write: nothing was stored.
    expect(world.database.paths().length).toBe(before);
    // Eight is fine, and the rules take it too.
    const eight = await api.createShare(world.owner.teamId, request({ teamNumbers: numbers.slice(0, 8) }));
    expect(eight.teamNumbers).toEqual(numbers.slice(0, 8));
  });

  it("extends, changes level and mode, updates and revokes, reading each change back", async () => {
    const { world, api, request } = await sharingSetup();
    const share = await api.createShare(world.owner.teamId, request());
    expect((await api.extendShare(share.id, inDays(30))).expiresAt).toBe(inDays(30));
    await expect(api.extendShare(share.id, null)).rejects.toThrow(/needs a date it ends/);
    expect((await api.setLevel(share.id, "propose")).level).toBe("propose");
    expect((await api.setMode(share.id, "follow")).mode).toBe("follow");

    const next = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto","v":2}\n');
    const updated = await api.updateShare(share.id, { revisionId: next.revisionId, projection: '{"kind":"projection","v":2}' });
    expect(updated).toMatchObject({ revision: 2, revisionId: next.revisionId, projection: '{"kind":"projection","v":2}' });

    await api.revokeShare(share.id);
    const [revoked] = await api.listShares(world.owner.teamId);
    expect(revoked?.revokedAt).not.toBeNull();
    await expect(api.revokeShare(share.id)).rejects.toThrow("That share was revoked; make a new one instead.");
    await expect(api.setLevel("0000000000000000000000", "view")).rejects.toThrow("That share does not exist, or you cannot open it.");
  });

  it("refuses a link at the propose level, and a change by a team that only received the share, as sentences", async () => {
    const { world, api, request } = await sharingSetup();
    const link = await api.createShare(world.owner.teamId, request({ audience: "link", teamNumbers: [] }));
    await expect(api.setLevel(link.id, "propose")).rejects.toThrow("An anyone-with-the-link share is view only.");
    const share = await api.createShare(world.owner.teamId, request());
    const { api: theirs } = partnerApi(world, 0);
    await expect(theirs.revokeShare(share.id)).rejects.toThrow(
      "The cloud refused that. Your role in the team may not allow it, or the share has ended or was revoked.",
    );
  });

  it("lists, extends and revokes the team's invites, and shows none to a member who cannot read them", async () => {
    const { world, api } = await sharingSetup();
    const invite = await world.owner.backend.createInvite(world.owner.teamId, { role: "viewer" });
    await invite.sent;
    const [listed] = await api.listInvites(world.owner.teamId);
    expect(listed).toMatchObject({ code: invite.value.code, role: "viewer", maxUses: 1, uses: 0, revoked: false });
    const later = new Date(invite.value.expiresAt.getTime() + 7 * DAY).toISOString();
    expect((await api.extendInvite(invite.value.code, later)).expiresAt).toBe(later);
    await api.revokeInvite(invite.value.code);
    expect((await api.listInvites(world.owner.teamId))[0]?.revoked).toBe(true);

    // Someone outside the team reads no invites, and is not told why in an error.
    const { partner, api: theirs } = partnerApi(world, 0);
    expect(await theirs.listInvites(world.owner.teamId)).toEqual([]);
    expect(await theirs.listInvites(partner.teamId)).toEqual([]);
  });

  it("gives the receiving team the share, from team 36596, and nobody else", async () => {
    const { world, api, request } = await sharingSetup();
    const share = await api.createShare(world.owner.teamId, request({ mode: "follow" }));
    const { partner, api: theirs } = partnerApi(world, 0);
    const received = await theirs.listReceived(partner.teamId);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: share.id,
      audience: "teams",
      fromTeamNumber: 36596,
      fromTeamName: "Horizon",
      level: "view",
      mode: "follow",
      revision: 1,
      projection: PROJECTION,
    });
    const { partner: other, api: third } = partnerApi(world, 1);
    expect(await third.listReceived(other.teamId)).toEqual([]);
    expect(await third.openShare(share.id)).toBeNull();
    // A revoked share leaves the inbox.
    await api.revokeShare(share.id);
    expect(await theirs.listReceived(partner.teamId)).toEqual([]);
  });

  it("carries each team's number status with its name: on a share's teams and on a received share", async () => {
    const { world, api, request } = await sharingSetup([12345, 23456]);
    // A Horizon admin has checked Horizon's number, and 23456 is disputed.
    const seedStatus = (teamId: string, status: string): void => {
      const team = world.database.peek(`teams/${teamId}`);
      world.database.seed(`teams/${teamId}`, { ...team, status });
    };
    seedStatus(world.owner.teamId, "verified");
    seedStatus(world.partners[1]?.teamId ?? "", "contested");
    const made = await createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }).createShare(
      world.owner.teamId,
      request({ teamNumbers: [12345, 23456] }),
    );
    const [listed] = await api.listShares(world.owner.teamId);
    expect(listed?.id).toBe(made.id);
    expect(listed?.teamStatuses).toEqual({ 12345: "unverified", 23456: "contested" });

    const { partner, api: theirs } = partnerApi(world, 0);
    const [received] = await theirs.listReceived(partner.teamId);
    expect(received?.fromTeamStatus).toBe("verified");
    // Someone who cannot read the team knows its status no more than its name.
    const link = await api.createShare(world.owner.teamId, request({ audience: "link", teamNumbers: [] }));
    expect((await createCloudSharingApi(world.stranger, { now: () => NOW_MS }).openLink(link.linkSecret ?? ""))?.fromTeamStatus).toBeNull();
  });

  it("opens an anyone-with-the-link share by its secret with nobody signed in, and nothing else", async () => {
    const { world, api, request } = await sharingSetup();
    const link = await api.createShare(world.owner.teamId, request({ audience: "link", teamNumbers: [] }));
    const teams = await api.createShare(world.owner.teamId, request());
    const secret = link.linkSecret ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The owner's own list of shares carries the secret, so the link can be copied again.
    expect((await api.listShares(world.owner.teamId)).find((share) => share.id === link.id)?.linkSecret).toBe(secret);
    const anyone = createCloudSharingApi(world.stranger, { now: () => NOW_MS });
    expect(await anyone.openLink(secret)).toMatchObject({ id: link.id, audience: "link", projection: PROJECTION, linkSecret: secret });
    // A stranger cannot read the team, so the share says only that a team made it.
    expect((await anyone.openLink(secret))?.fromTeamNumber).toBeNull();
    // The share's id is not its link: it opens nothing, and neither does a team share's id.
    expect(await anyone.openLink(link.id)).toBeNull();
    expect(await anyone.openLink(teams.id)).toBeNull();
    expect(await anyone.openShare(link.id)).toBeNull();
    // What the cloud stores for the share holds its projection only as ciphertext.
    expect(JSON.stringify(world.database.peek(`shares/${link.id}`))).not.toContain("kind");
    await api.revokeShare(link.id);
    expect(await anyone.openLink(secret)).toBeNull();
  });

  it("reads a revision's files back from the library for its own team only", async () => {
    const world = await cloudWorld([12345]);
    ownerSawPartnerCodes(world);
    const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n', { robot: "{}", field: "{ }" });
    const api = createCloudSharingApi(world.owner.backend);
    expect(await api.revisionFiles(world.owner.teamId, at.autoId, at.revisionId)).toEqual({
      content: '{"kind":"auto"}\n',
      robot: "{}",
      field: "{ }",
    });
    expect(await api.revisionFiles(world.owner.teamId, at.autoId, "000009-AAAAAAAAAAA")).toBeNull();
    const { api: theirs } = partnerApi(world, 0);
    expect(await theirs.revisionFiles(world.owner.teamId, at.autoId, at.revisionId)).toBeNull();
  });
});

describe("cloud failures as sentences", () => {
  it("says what each kind of failure means, and keeps the cloud's own sentences", () => {
    expect(sharingErrorSentence(new CloudError("permission-denied", "The database's access rules do not allow this write."))).toBe(
      "The cloud refused that. Your role in the team may not allow it, or the share has ended or was revoked.",
    );
    expect(sharingErrorSentence(new CloudError("signed-out", "x"))).toBe("Sign in to share.");
    expect(sharingErrorSentence(new CloudError("unavailable", "offline"))).toMatch(/cannot reach the cloud/);
    expect(sharingErrorSentence(new CloudError("not-found", "no trailing stop"))).toBe("That no longer exists, or you cannot open it.");
    expect(sharingErrorSentence(new CloudError("invalid", "A share must expire after the moment it is made."))).toBe(
      "A share must expire after the moment it is made.",
    );
    expect(sharingErrorSentence(new Error("Plain sentence."))).toBe("Plain sentence.");
    expect(sharingErrorSentence("thrown text")).toBe("The request failed. Try again in a moment.");
  });
});

describe("a share to a team that was later deleted", () => {
  it("counts the deleted team, and marks the share when every team it names is gone", async () => {
    const { world, api, request } = await sharingSetup([12345, 23456]);
    const both = await api.createShare(world.owner.teamId, request({ teamNumbers: [12345, 23456] }));
    const one = await api.createShare(world.owner.teamId, request({ teamNumbers: [12345] }));
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    await (await partner.backend.deleteTeam(partner.teamId)).sent;

    // A fresh adapter, as after a reload: it reads each team again.
    const later = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    const listed = await later.listShares(world.owner.teamId);
    const byId = new Map(listed.map((share) => [share.id, share]));
    expect(byId.get(both.id)).toMatchObject({ teamNumbers: [23456], deletedTeams: 1 });
    expect(byId.get(both.id)?.everyTeamDeleted).toBeUndefined();
    expect(byId.get(one.id)).toMatchObject({ teamNumbers: [], deletedTeams: 1, everyTeamDeleted: true });
  });
});
