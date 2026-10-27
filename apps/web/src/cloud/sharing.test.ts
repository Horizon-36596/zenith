import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { shareSentence, sharingChip } from "@horizon36596/zenith-core";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo, type CloudWorld, type PublishedAt } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import {
  BROKEN_LINK,
  DEFAULT_DRAFT,
  EXTEND_CHOICES,
  addTeam,
  draftProjectionChoice,
  draftSettings,
  draftToRequest,
  expiryInstant,
  extendedExpiry,
  isBrokenLinkHash,
  newerRevisionFor,
  parseShareHash,
  parseTeamNumber,
  removeTeam,
  shareLink,
  whyCannotExtend,
  whyCannotShare,
  withAudience,
  type ExpiryChoice,
  type ShareDraft,
} from "./shareModel";
import {
  createShare,
  extendShare,
  getCloud,
  openSharingSheet,
  revokeShare,
  setShareMode,
  closeSharingSheet,
  setSharingBackend,
  sharesOf,
  sharesOnPage,
  sharingBlockedReason,
  showAllShares,
  SIGNED_OUT,
} from "./store";
import { ADD_ANOTHER_TEAM, EVERY_TEAM_DELETED, draftLeadWords, fromTeamWords, noInvitesWords, sentenceFor, shareIsOpen, sharedByWords, whoWords } from "./words";
import { teamWords } from "./proposalsApi";
import { STATUS_INLINE, STATUS_WORDS, withTeamStatus } from "../account/words";
import { localDateTimeMs, toLocalInput } from "../account/invites";
import { includesCommands, isCoarsened, projectionTitle, storedChoice } from "./projectionModel";
import { revisionProjector } from "./revisionProjection";
import type { Audience, Level, Mode, Share } from "./types";

/**
 * The sharing UI's model and the store, in node, against the in-memory cloud and its real rules
 * (`cloudFixture.test.ts`). The M-C3 contract (spec 13 section 16): the dialog's sentence matches
 * the stored share for every combination of level, audience, mode, expiry and every option the
 * dialog has (command names, the auto's name, coarsen).
 */

// These tests drive the in-memory cloud, which makes real P-256 keys and signatures for every device
// and team, like the cloud package's own tests (see vitest.config.ts). Each takes well under a second on
// an idle machine, but late in `pnpm ship`'s full run a laptop held to its sustained power limit runs
// them three or four times slower and the 5-second default fails them. 30 seconds still catches a hang.
vi.setConfig({ testTimeout: 30_000 });

const DAY = 86_400_000;
/**
 * A stand-in projection for the tests of the sentence and the store, which do not read it. The
 * projection itself is tested against the starter autos in `projection.test.ts`.
 */
const PROJECTION = '{"kind":"projection"}';
const REVISION = { id: "000001-AAAAAAAAAAA", n: 1 };

/** The starter's collect-and-score and the robot and field it was made with, for the sentence grid. */
const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const starterText = (relative: string): string => readFileSync(`${starter}${relative}`, "utf8");
const GRID_FILES = {
  content: starterText("autos/collect-and-score.auto.json"),
  robot: starterText("autos/robot.json"),
  field: starterText("autos/field/biobuzz.field.json"),
  waypoints: starterText("autos/waypoints.json"),
};
/** The name the dialog calls that auto: its own title. */
const GRID_AUTO_NAME = "Collect and score";

/** Horizon's cloud with one published auto, and the session the sharing store is signed in to. */
async function sharingCloud(): Promise<{ world: CloudWorld; at: PublishedAt; session: typeof SIGNED_OUT }> {
  const world = await cloudWorld();
  ownerSawPartnerCodes(world);
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const session = { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" };
  return { world, at, session };
}

describe("the share dialog's draft", () => {
  it("starts at the spec's defaults: specific teams, view, pinned, 7 days", () => {
    expect(DEFAULT_DRAFT).toEqual({
      audience: "teams",
      teamNumbers: [],
      level: "view",
      mode: "pinned",
      expiry: { kind: "days", days: 7 },
      coarsen: false,
      includeCommands: false,
      includeTitle: false,
    });
    expect(draftSettings(DEFAULT_DRAFT, NOW_MS).expiresAt).toBe(new Date(NOW_MS + 7 * DAY).toISOString());
  });

  it("works out every expiry choice", () => {
    expect(expiryInstant({ kind: "days", days: 1 }, NOW_MS)).toBe(new Date(NOW_MS + DAY).toISOString());
    expect(expiryInstant({ kind: "days", days: 30 }, NOW_MS)).toBe(new Date(NOW_MS + 30 * DAY).toISOString());
    // "Until a date" works to the last moment of that day on this computer's clock, or to the
    // minute given with it.
    expect(expiryInstant({ kind: "date", date: "2026-10-04" }, NOW_MS)).toBe(
      new Date(2026, 9, 4, 23, 59, 59, 999).toISOString(),
    );
    expect(expiryInstant({ kind: "date", date: "2026-10-04", time: "" }, NOW_MS)).toBe(
      new Date(2026, 9, 4, 23, 59, 59, 999).toISOString(),
    );
    expect(expiryInstant({ kind: "date", date: "2026-10-04", time: "15:30" }, NOW_MS)).toBe(
      new Date(2026, 9, 4, 15, 30, 0, 0).toISOString(),
    );
    expect(expiryInstant({ kind: "date", date: "2026-10-04", time: "25:00" }, NOW_MS)).toBeNull();
    expect(expiryInstant({ kind: "date", date: "2026-10-04", time: "noon" }, NOW_MS)).toBeNull();
    expect(expiryInstant({ kind: "date", date: "2026-02-30" }, NOW_MS)).toBeNull();
    expect(expiryInstant({ kind: "date", date: "" }, NOW_MS)).toBeNull();
  });

  it("says why it cannot share yet", () => {
    expect(whyCannotShare(DEFAULT_DRAFT, NOW_MS)).toBe("Add at least one team number first.");
    const one = addTeam(DEFAULT_DRAFT, 12345);
    expect(whyCannotShare(one, NOW_MS)).toBeNull();
    expect(whyCannotShare({ ...one, expiry: { kind: "date", date: "2026-09-01" } }, NOW_MS)).toMatch(/already passed/);
    expect(whyCannotShare({ ...one, expiry: { kind: "date", date: "nope" } }, NOW_MS)).toMatch(/Pick the date/);
    expect(whyCannotShare(withAudience(DEFAULT_DRAFT, "link"), NOW_MS)).toBeNull();
  });

  it("refuses a ninth team as it is added, and a draft of nine before it is sent (ADR 0009 section 4)", () => {
    let draft = DEFAULT_DRAFT;
    for (let number = 11111; number < 11119; number += 1) draft = addTeam(draft, number);
    expect(draft.teamNumbers).toHaveLength(8);
    expect(whyCannotShare(draft, NOW_MS)).toBeNull();
    expect(parseTeamNumber("11119", draft, 36596)).toEqual({
      ok: false,
      why: "One share can name at most 8 teams. Share with these first, then make a second share for team 11119.",
    });
    expect(whyCannotShare(addTeam(draft, 11119), NOW_MS)).toMatch(/^One share can name at most 8 teams, and this one names 9\./);
  });

  it("reads team numbers, and refuses your own team, a repeat and anything that is not a number", () => {
    const draft = addTeam(DEFAULT_DRAFT, 12345);
    expect(parseTeamNumber(" 23456 ", draft, 36596)).toEqual({ ok: true, teamNumber: 23456 });
    expect(parseTeamNumber("#23456", draft, 36596)).toEqual({ ok: true, teamNumber: 23456 });
    expect(parseTeamNumber("", draft, 36596)).toMatchObject({ ok: false });
    // One sentence for every number that is not a team number, the same one the Teams sheet shows (issue #502).
    const range = "Use a whole number from 1 to 999999.";
    expect(parseTeamNumber("12a", draft, 36596)).toEqual({ ok: false, why: `"12a" is not a team number. ${range}` });
    expect(parseTeamNumber("0", draft, 36596)).toEqual({ ok: false, why: `"0" is not a team number. ${range}` });
    expect(parseTeamNumber("99999999999", draft, 36596)).toEqual({ ok: false, why: `"99999999999" is not a team number. ${range}` });
    expect(parseTeamNumber("36596", draft, 36596)).toMatchObject({ ok: false, why: expect.stringMatching(/own team/) });
    expect(parseTeamNumber("12345", draft, 36596)).toMatchObject({ ok: false, why: expect.stringMatching(/already/) });
  });

  it("adds and removes teams, never twice", () => {
    const two = addTeam(addTeam(addTeam(DEFAULT_DRAFT, 12345), 23456), 12345);
    expect(two.teamNumbers).toEqual([12345, 23456]);
    expect(removeTeam(two, 12345).teamNumbers).toEqual([23456]);
  });

  it("takes a link back to view, since a link is view only", () => {
    const propose: ShareDraft = { ...addTeam(DEFAULT_DRAFT, 12345), level: "propose" };
    const link = withAudience(propose, "link");
    expect(link.level).toBe("view");
    expect(draftSettings({ ...link, level: "propose" }, NOW_MS).level).toBe("view");
    expect(draftSettings(link, NOW_MS).teamNumbers).toEqual([]);
  });

  it("builds the link as an address with the id after #/s/, and reads the id back", () => {
    expect(shareLink("abc", "https://example.org/zenith/app/")).toBe("https://example.org/zenith/app/#/s/abc");
    expect(shareLink("abc", "https://example.org/zenith/app")).toBe("https://example.org/zenith/app/#/s/abc");
    expect(shareLink("abc", "https://example.org/app/#/old")).toBe("https://example.org/app/#/s/abc");
    const id = "mE2hEqbRBNwNgvtr-NU7DQ";
    expect(parseShareHash(new URL(shareLink(id, "https://example.org/app/")).hash)).toBe(id);
    expect(parseShareHash("#/s/short")).toBeNull();
    expect(parseShareHash("#/join/mE2hEqbRBNwNgvtr-NU7DQ")).toBeNull();
    expect(parseShareHash("")).toBeNull();
  });

  it("tells an invite or share link cut short from a whole one and from any other address", () => {
    expect(BROKEN_LINK).toBe("That link is not complete. Check it, or ask for a new one.");
    expect(isBrokenLinkHash("#/join/garbage")).toBe(true);
    expect(isBrokenLinkHash("#/join/AbCdEfGhIjKl")).toBe(false);
    expect(isBrokenLinkHash("#/join/abc")).toBe(true);
    expect(isBrokenLinkHash("#/join/")).toBe(true);
    expect(isBrokenLinkHash("#/s/doesnotexist")).toBe(true);
    expect(isBrokenLinkHash("#/s/mE2hEqbRBNwNgvtr-NU7DQ")).toBe(false);
    expect(isBrokenLinkHash("#/review/a/b/1")).toBe(false);
    expect(isBrokenLinkHash("")).toBe(false);
  });

  it("puts the projection, the revision it is given and the sharer's choices into the request, and nothing else from the auto", () => {
    const request = draftToRequest(addTeam(DEFAULT_DRAFT, 12345), "libraryAutoIdAAAAAAAAA", REVISION, NOW_MS, PROJECTION);
    expect(request.projection).toBe(PROJECTION);
    expect(request).toMatchObject({ revision: 1, revisionId: REVISION.id });
    expect(Object.keys(request).sort()).toEqual(
      ["audience", "autoId", "choice", "expiresAt", "level", "mode", "projection", "revision", "revisionId", "teamNumbers"].sort(),
    );
    expect(request.choice).toEqual({ coarsen: DEFAULT_DRAFT.coarsen, includeCommands: DEFAULT_DRAFT.includeCommands, title: null });
  });
});

describe("the share dialog's lead for an auto that already has a share", () => {
  const nobody = shareSentence({ audience: "teams", teamNumbers: [], level: "view", mode: "pinned", expiresAt: null, includeCommands: false }, NOW_MS);

  it("never says nobody outside the team can see it, and asks for a team number instead", () => {
    expect(nobody).toMatch(/^Nobody outside your team can see this auto yet\./);
    expect(draftLeadWords({ audience: "teams", teamNumbers: [] }, 1, nobody)).toBe(ADD_ANOTHER_TEAM);
    expect(ADD_ANOTHER_TEAM).not.toMatch(/nobody/i);
  });

  it("keeps the usual sentence with no share yet, or once a team is chosen", () => {
    expect(draftLeadWords({ audience: "teams", teamNumbers: [] }, 0, nobody)).toBe(nobody);
    expect(draftLeadWords({ audience: "teams", teamNumbers: [12345] }, 2, "Team 12345 can view this auto.")).toBe("Team 12345 can view this auto.");
    expect(draftLeadWords({ audience: "link", teamNumbers: [] }, 1, "Anyone with the link can view this auto.")).toBe("Anyone with the link can view this auto.");
  });
});

describe("extending", () => {
  it("counts more days from the current end, or from now once it has passed, and never shortens", () => {
    const current = new Date(NOW_MS + DAY).toISOString();
    expect(extendedExpiry(current, { kind: "days", days: 7 }, NOW_MS)).toBe(new Date(NOW_MS + 8 * DAY).toISOString());
    const past = new Date(NOW_MS - DAY).toISOString();
    expect(extendedExpiry(past, { kind: "days", days: 1 }, NOW_MS)).toBe(new Date(NOW_MS + DAY).toISOString());
    expect(extendedExpiry(null, { kind: "days", days: 7 }, NOW_MS)).toBeNull();
    expect(EXTEND_CHOICES.map((entry) => entry.label)).toEqual([
      "1 more day",
      "7 more days",
      "30 more days",
    ]);
  });

  it("takes a date and time on this computer's clock, which must be later than both the end and now", () => {
    const local = (ms: number): string => toLocalInput(ms);
    const current = new Date(NOW_MS + DAY).toISOString();
    // toLocalInput drops the seconds, so a time two days out, rounded down to its minute.
    const later = NOW_MS + 2 * DAY;
    const laterMinute = localDateTimeMs(local(later)) ?? 0;
    expect(extendedExpiry(current, { kind: "at", local: local(later) }, NOW_MS)).toBe(new Date(laterMinute).toISOString());
    expect(whyCannotExtend(current, { kind: "at", local: local(later) }, NOW_MS)).toBeNull();

    // Earlier than the current end: refused, never a shorter share.
    const sooner = local(NOW_MS + DAY / 2);
    expect(extendedExpiry(current, { kind: "at", local: sooner }, NOW_MS)).toBeNull();
    expect(whyCannotExtend(current, { kind: "at", local: sooner }, NOW_MS)).toBe(
      "That is not later than when it ends now. Pick a later time.",
    );
    // In the past: refused, even for a share that has already ended.
    const ended = new Date(NOW_MS - 2 * DAY).toISOString();
    const yesterday = local(NOW_MS - DAY);
    expect(extendedExpiry(ended, { kind: "at", local: yesterday }, NOW_MS)).toBeNull();
    expect(whyCannotExtend(ended, { kind: "at", local: yesterday }, NOW_MS)).toBe("That time has already passed. Pick a later one.");
    // Not a date and time, and no end date at all.
    expect(whyCannotExtend(current, { kind: "at", local: "" }, NOW_MS)).toBe("Pick the date and time it should end.");
    expect(extendedExpiry(current, { kind: "at", local: "2026-02-30T10:00" }, NOW_MS)).toBeNull();
    expect(whyCannotExtend(null, { kind: "days", days: 7 }, NOW_MS)).toBe("This has no end date, so there is nothing to extend.");
    expect(whyCannotExtend(current, { kind: "days", days: 1 }, NOW_MS)).toBeNull();
  });

  it("extends a stored share to a picked date and time through the store", async () => {
    const { world, at, session } = await sharingCloud();
    setSharingBackend(createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }), session, { now: () => NOW_MS });
    const made = await createShare(
      draftToRequest(addTeam(DEFAULT_DRAFT, 12345), at.autoId, { id: at.revisionId, n: at.n }, NOW_MS, PROJECTION),
      "Shared.",
    );
    if (made === null) throw new Error(getCloud().error ?? "not shared");
    const target = localDateTimeMs(toLocalInput(NOW_MS + 20 * DAY)) ?? 0;
    const next = extendedExpiry(made.expiresAt, { kind: "at", local: toLocalInput(NOW_MS + 20 * DAY) }, NOW_MS);
    expect(next).toBe(new Date(target).toISOString());
    const extended = await extendShare(made.id, next, "Extended.");
    expect(extended?.expiresAt).toBe(new Date(target).toISOString());
  });
});

describe("the dialog's sentence matches the stored share (spec 13 M-C3)", () => {
  const audiences: ReadonlyArray<{ audience: Audience; teams: number[] }> = [
    { audience: "teams", teams: [12345] },
    { audience: "teams", teams: [12345, 23456, 34567] },
    { audience: "link", teams: [] },
  ];
  const levels: readonly Level[] = ["view", "propose"];
  const modes: readonly Mode[] = ["pinned", "follow"];
  // One cloud per audience, level and mode, made when its first test runs. Every share is a new
  // document, so the tests on one cloud do not disturb each other. Each test reads its share back
  // from the Sharing page's list, which opens every share of the team, so a single cloud for the
  // whole grid made each test slower than the one before: the last opened all 480 shares.
  const clouds = new Map<string, ReturnType<typeof sharingCloud>>();
  const cloudFor = (key: string): ReturnType<typeof sharingCloud> => {
    let cloud = clouds.get(key);
    if (cloud === undefined) {
      cloud = sharingCloud();
      clouds.set(key, cloud);
    }
    return cloud;
  };
  const expiries: readonly ExpiryChoice[] = [
    { kind: "days", days: 1 },
    { kind: "days", days: 7 },
    { kind: "days", days: 30 },
    { kind: "date", date: "2026-12-24" },
    { kind: "date", date: "2026-12-24", time: "09:15" },
  ];
  const flags = [false, true] as const;

  // Real projections of a starter auto, built once per choice, so the options the dialog puts into
  // the projection (coarsen, command names, the auto's name) are read back from what was stored.
  const projector = revisionProjector(GRID_FILES, null, 1);
  const built = new Map<string, string>();
  function projectionFor(draft: ShareDraft): string {
    const choice = draftProjectionChoice(draft, GRID_AUTO_NAME);
    const key = JSON.stringify(choice);
    const cached = built.get(key);
    if (cached !== undefined) return cached;
    if (!projector.ok) throw new Error(projector.reason);
    const canonical = projector.build(choice);
    if (canonical === null) throw new Error(`not projected: ${key}`);
    built.set(key, canonical);
    return canonical;
  }

  for (const who of audiences) {
    for (const level of levels) {
      for (const mode of modes) {
        for (const expiry of expiries) {
          for (const includeCommands of flags) {
            for (const includeTitle of flags) {
              for (const coarsen of flags) {
                const options = [includeCommands ? "command names" : "", includeTitle ? "auto's name" : "", coarsen ? "coarsened" : ""].filter(
                  (word) => word !== "",
                );
                it(`${who.audience} ${String(who.teams.length)}, ${level}, ${mode}, ${expiry.kind}${expiry.kind === "days" ? String(expiry.days) : (expiry.time ?? "")}${options.map((word) => `, ${word}`).join("")}`, async () => {
                  const { world, at } = await cloudFor(`${who.audience} ${String(who.teams.length)} ${level} ${mode}`);
                  const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
                  const draft: ShareDraft = withAudience(
                    { ...DEFAULT_DRAFT, teamNumbers: who.teams, level, mode, expiry, includeCommands, includeTitle, coarsen },
                    who.audience,
                  );
                  const said = shareSentence(draftSettings(draft, NOW_MS), NOW_MS);
                  expect(said.includes("command names and their settings")).toBe(includeCommands);
                  expect(said.includes("They will see this auto's name")).toBe(includeTitle);
                  const request = draftToRequest(draft, at.autoId, { id: at.revisionId, n: at.n }, NOW_MS, projectionFor(draft));
                  // The choices live in the projection alone: the stored share has no field for any of them.
                  for (const option of ["includeCommands", "includeTitle", "coarsen", "title"]) expect(Object.keys(request)).not.toContain(option);
                  const stored = await api.createShare(world.owner.teamId, request);
                  const readBack = (share: Share): string =>
                    shareSentence(
                      { ...share, includeCommands: includesCommands(share.projection), includeTitle: projectionTitle(share.projection) !== null },
                      NOW_MS,
                    );
                  expect(readBack(stored)).toBe(said);
                  // What the Sharing page reads back from the cloud is the same share again, with the
                  // same options a rebuild of it would keep.
                  const listed = (await api.listShares(world.owner.teamId)).find((share) => share.id === stored.id);
                  if (listed === undefined) throw new Error("the share was not listed");
                  expect(readBack(listed)).toBe(said);
                  expect(storedChoice(listed.projection, listed.level)).toEqual(draftProjectionChoice(draft, GRID_AUTO_NAME));
                  expect(isCoarsened(listed.projection)).toBe(coarsen);
                  expect(projectionTitle(listed.projection)).toBe(includeTitle ? GRID_AUTO_NAME : null);
                });
              }
            }
          }
        }
      }
    }
  }
});

describe("the sharing store", () => {
  let cloud: Awaited<ReturnType<typeof sharingCloud>>;
  beforeEach(async () => {
    cloud = await sharingCloud();
    setSharingBackend(createCloudSharingApi(cloud.world.owner.backend, { now: () => NOW_MS }), cloud.session, { now: () => NOW_MS });
  });

  it("says Sign in to share while signed out, and Open an auto first with nothing open", () => {
    setSharingBackend(createCloudSharingApi(cloud.world.stranger), SIGNED_OUT);
    expect(sharingBlockedReason(true)).toBe("Sign in to share.");
    setSharingBackend(createCloudSharingApi(cloud.world.owner.backend), cloud.session, { now: () => NOW_MS });
    expect(sharingBlockedReason(false)).toBe("Open an auto first.");
    expect(sharingBlockedReason(true)).toBeNull();
  });

  it("creates, changes and revokes a share, and the chip follows", async () => {
    const { autoId } = cloud.at;
    openSharingSheet("share");
    expect(getCloud().sheet).toBe("share");

    const draft = addTeam(addTeam(DEFAULT_DRAFT, 12345), 23456);
    const request = draftToRequest(draft, autoId, { id: cloud.at.revisionId, n: cloud.at.n }, NOW_MS, PROJECTION);
    const share = await createShare(request, "Shared.");
    expect(getCloud().error).toBeNull();
    expect(share).not.toBeNull();
    if (share === null) return;
    expect(getCloud().shares).toHaveLength(1);
    expect(sharingChip(sharesOf(getCloud().shares, autoId), NOW_MS).label).toBe("Shared with 2 teams");
    expect(sentenceFor(share, NOW_MS)).toContain("Teams 12345 and 23456 can view this auto");

    await setShareMode(share.id, "follow", "Changed.");
    await extendShare(share.id, new Date(NOW_MS + 30 * DAY).toISOString(), "Extended.");
    const changed = getCloud().shares[0];
    expect(changed).toMatchObject({ mode: "follow", expiresAt: new Date(NOW_MS + 30 * DAY).toISOString() });

    await revokeShare(share.id, "Revoked.");
    expect(getCloud().shares[0]?.revokedAt).not.toBeNull();
    expect(sharingChip(sharesOf(getCloud().shares, autoId), NOW_MS).label).toBe("Team only");

    // A second revoke is refused, and the store says why instead of throwing.
    await revokeShare(share.id, "Revoked.");
    expect(getCloud().error).toMatch(/revoked/);
  });

  it("says why, as a sentence, when the cloud refuses a share", async () => {
    const request = draftToRequest(addTeam(DEFAULT_DRAFT, 99999), cloud.at.autoId, { id: cloud.at.revisionId, n: 1 }, NOW_MS, PROJECTION);
    expect(await createShare(request, "Shared.")).toBeNull();
    expect(getCloud().error).toMatch(/^No team on Zenith has claimed number 99999/);
  });

  it("lists only the open auto's shares, newest first", () => {
    const base: Omit<Share, "id" | "autoId" | "createdAt"> = {
      audience: "teams",
      teamNumbers: [1],
      level: "view",
      mode: "pinned",
      revision: 1,
      revisionId: REVISION.id,
      expiresAt: null,
      revokedAt: null,
      projection: PROJECTION,
      createdBy: "someone",
    };
    const shares: Share[] = [
      { ...base, id: "a", autoId: "x", createdAt: "2026-09-01T00:00:00Z" },
      { ...base, id: "b", autoId: "y", createdAt: "2026-09-02T00:00:00Z" },
      { ...base, id: "c", autoId: "x", createdAt: "2026-09-03T00:00:00Z" },
    ];
    expect(sharesOf(shares, "x").map((share) => share.id)).toEqual(["c", "a"]);
    expect(sharesOf(shares, null)).toEqual([]);
  });
});

describe("the Sharing page narrowed to one auto", () => {
  const base: Omit<Share, "id" | "autoId" | "createdAt"> = {
    audience: "teams",
    teamNumbers: [1],
    level: "view",
    mode: "pinned",
    revision: 1,
    revisionId: REVISION.id,
    expiresAt: null,
    revokedAt: null,
    projection: PROJECTION,
    createdBy: "someone",
  };
  const shares: Share[] = [
    { ...base, id: "a", autoId: "x", createdAt: "2026-09-01T00:00:00Z" },
    { ...base, id: "b", autoId: "y", createdAt: "2026-09-02T00:00:00Z" },
    { ...base, id: "c", autoId: "x", createdAt: "2026-09-03T00:00:00Z" },
  ];

  it("lists only that auto's shares, and every share with no filter", () => {
    expect(sharesOnPage(shares, "x").map((share) => share.id)).toEqual(["a", "c"]);
    expect(sharesOnPage(shares, null).map((share) => share.id)).toEqual(["a", "b", "c"]);
    expect(sharesOnPage(shares, "nothing")).toEqual([]);
  });

  it("is set by opening the page for an auto, and cleared by Show all, by closing and by the share dialog", async () => {
    const { world, session } = await sharingCloud();
    setSharingBackend(createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }), session, { now: () => NOW_MS });
    openSharingSheet("sharing", { autoId: "x" });
    expect(getCloud()).toMatchObject({ sheet: "sharing", sharingAutoId: "x" });
    showAllShares();
    expect(getCloud()).toMatchObject({ sheet: "sharing", sharingAutoId: null });
    openSharingSheet("sharing", { autoId: "x" });
    closeSharingSheet();
    expect(getCloud().sharingAutoId).toBeNull();
    openSharingSheet("sharing", { autoId: "x" });
    openSharingSheet("share", { autoId: "x" });
    expect(getCloud().sharingAutoId).toBeNull();
    openSharingSheet("sharing");
    expect(getCloud().sharingAutoId).toBeNull();
    // Another session's autos are not this one's: switching team clears it.
    openSharingSheet("sharing", { autoId: "x" });
    setSharingBackend(createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }), session, { now: () => NOW_MS });
    expect(getCloud().sharingAutoId).toBeNull();
    closeSharingSheet();
  });
});

describe("a newer version is not shared", () => {
  const at = (iso: string): Date => new Date(iso);
  const r1 = { id: "000001-AAAAAAAAAAA", n: 1, createdAt: at("2026-09-20T10:00:00Z") };
  const r2 = { id: "000002-BBBBBBBBBBB", n: 2, createdAt: at("2026-09-21T10:00:00Z") };
  const r2b = { id: "000002-CCCCCCCCCCC", n: 2, createdAt: at("2026-09-22T10:00:00Z") };
  const pinned = {
    mode: "pinned" as Mode,
    revision: 1,
    revisionId: r1.id,
    revokedAt: null,
    expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
  };

  it("offers the newest revision to a pinned share in force that is on an older one", () => {
    expect(newerRevisionFor(pinned, [r1, r2], NOW_MS)).toBe(r2);
    expect(newerRevisionFor({ ...pinned, expiresAt: null }, [r2, r1], NOW_MS)).toBe(r2);
  });

  it("counts a diverged sibling published later as newer, and an earlier one as not", () => {
    expect(newerRevisionFor({ ...pinned, revision: 2, revisionId: r2.id }, [r1, r2, r2b], NOW_MS)).toBe(r2b);
    expect(newerRevisionFor({ ...pinned, revision: 2, revisionId: r2b.id }, [r1, r2, r2b], NOW_MS)).toBeNull();
  });

  it("offers nothing when the share is up to date, follows the latest, was revoked or has ended", () => {
    expect(newerRevisionFor({ ...pinned, revision: 2, revisionId: r2.id }, [r1, r2], NOW_MS)).toBeNull();
    expect(newerRevisionFor({ ...pinned, mode: "follow" }, [r1, r2], NOW_MS)).toBeNull();
    expect(newerRevisionFor({ ...pinned, revokedAt: new Date(NOW_MS).toISOString() }, [r1, r2], NOW_MS)).toBeNull();
    expect(newerRevisionFor({ ...pinned, expiresAt: new Date(NOW_MS - DAY).toISOString() }, [r1, r2], NOW_MS)).toBeNull();
    expect(newerRevisionFor(pinned, [], NOW_MS)).toBeNull();
  });

  it("compares by number when the shared revision is not in the list the library has loaded", () => {
    expect(newerRevisionFor(pinned, [r2], NOW_MS)).toBe(r2);
    expect(newerRevisionFor({ ...pinned, revision: 2, revisionId: "000002-ZZZZZZZZZZZ" }, [r2], NOW_MS)).toBeNull();
  });
});

describe("a team's number status wherever its name appears (spec 13 section 4.2)", () => {
  const from = { fromTeamNumber: 36596, fromTeamName: "Horizon" };

  it("follows a received share's team, and reads a contested number plainly", () => {
    expect(fromTeamWords({ ...from, fromTeamStatus: "unverified" })).toBe("Team 36596 (unverified)");
    expect(fromTeamWords({ ...from, fromTeamStatus: "verified" })).toBe("Team 36596 (verified)");
    expect(fromTeamWords({ ...from, fromTeamStatus: "contested" })).toBe("Team 36596 (number contested)");
    expect(sharedByWords({ ...from, fromTeamStatus: "contested" })).toBe("shared by Team 36596 (number contested)");
    // Unknown to this viewer: the name alone, or no team at all for a link opened signed out.
    expect(fromTeamWords({ ...from, fromTeamStatus: null })).toBe("Team 36596");
    expect(fromTeamWords({ fromTeamNumber: null, fromTeamName: null, fromTeamStatus: null })).toBe("Shared link");
  });

  it("follows each team a share names, on the Sharing page", () => {
    expect(whoWords({ audience: "teams", teamNumbers: [12345], teamStatuses: { 12345: "unverified" } })).toBe("Team 12345 (unverified)");
    expect(
      whoWords({ audience: "teams", teamNumbers: [12345, 23456], teamStatuses: { 12345: "verified", 23456: "contested" } }),
    ).toBe("Teams 12345 (verified), 23456 (number contested)");
    expect(whoWords({ audience: "teams", teamNumbers: [12345] })).toBe("Team 12345");
    expect(whoWords({ audience: "link", teamNumbers: [], teamStatuses: {} })).toBe("Anyone with the link");
  });

  it("names a team that was deleted since as a deleted team, never as a bare Teams", () => {
    expect(whoWords({ audience: "teams", teamNumbers: [], deletedTeams: 1 })).toBe("A deleted team");
    expect(whoWords({ audience: "teams", teamNumbers: [], deletedTeams: 2 })).toBe("2 deleted teams");
    expect(whoWords({ audience: "teams", teamNumbers: [12345], teamStatuses: { 12345: "unverified" }, deletedTeams: 1 })).toBe(
      "Team 12345 (unverified) and a deleted team",
    );
    expect(teamWords("deleted")).toBe("A deleted team");
  });

  it("tells an editor under Invites that only owners and admins see them", () => {
    expect(noInvitesWords(true)).toBe("No invites.");
    expect(noInvitesWords(false)).toContain("Only owners and admins see the invites.");
  });

  it("lists a share whose every team was deleted as ended, and says why instead of who can view", () => {
    const live = {
      id: "s",
      autoId: "a",
      audience: "teams",
      teamNumbers: [],
      deletedTeams: 1,
      level: "view",
      mode: "pinned",
      revision: 1,
      revisionId: "000001-x",
      projection: "{}",
      expiresAt: new Date(NOW_MS + 30 * 86_400_000).toISOString(),
      revokedAt: null,
      createdAt: new Date(NOW_MS).toISOString(),
      createdBy: "u",
    } satisfies Share;
    expect(shareIsOpen(live, NOW_MS)).toBe(true);
    const gone: Share = { ...live, everyTeamDeleted: true };
    expect(shareIsOpen(gone, NOW_MS)).toBe(false);
    expect(sentenceFor(gone, NOW_MS)).toBe(EVERY_TEAM_DELETED);
  });

  it("follows a proposal's team", () => {
    expect(teamWords({ number: 12345, name: "Partner", status: "unverified" })).toBe("Team 12345 (unverified)");
    expect(teamWords({ number: 12345, name: "Partner", status: "contested" })).toBe("Team 12345 (number contested)");
    expect(teamWords({ number: null, name: "Partner", status: "unverified" })).toBe("A team with no number that calls itself “Partner”");
    expect(teamWords({ number: null, name: "36596", status: "verified" })).toBe("A team with no number that calls itself “36596”");
    expect(teamWords(null)).toBe("Another team");
  });

  it("uses the account's own words for each status", () => {
    for (const status of ["unverified", "verified", "contested"] as const) {
      expect(STATUS_INLINE[status].toLowerCase()).toContain(STATUS_WORDS[status].toLowerCase());
      expect(withTeamStatus("Team 1", status)).toBe(`Team 1 (${STATUS_INLINE[status]})`);
    }
  });
});
