/**
 * The shares the team made that stopped when its key changed, and "Share again": which the Sharing
 * page lists, the share dialog's settings for sharing one again, the notice itself, and the whole
 * path on the in-memory cloud, from a device the team takes the key from to the share made again.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "@horizon36596/zenith-cloud/memory";
import { memoryStorage } from "../account/storage";
import { click, html, tagOf, text } from "../account/keys/testMarkup";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { expiryInstant } from "./shareModel";
import { StoppedShares } from "./StoppedShares";
import { SharedAgain, shareAgainDraft, sharesAgain, stoppedToList } from "./stoppedSharesModel";
import { createShare, getCloud, refreshSharing, setSharingBackend } from "./store";
import type { Share, StoppedShare } from "./types";
import { STOPPED_SHARES } from "./words";

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const stopped = (over: Partial<StoppedShare> = {}): StoppedShare => ({
  id: "stoppedShare1",
  autoId: "auto1",
  audience: "teams",
  teamNumbers: [12345, 23456],
  level: "propose",
  mode: "follow",
  revision: 3,
  revisionId: "000003-abc",
  expiresAt: iso(NOW_MS + 5 * DAY),
  createdAt: iso(NOW_MS - 2 * DAY),
  reason: "device-removed",
  ...over,
});

const share = (over: Partial<Share> = {}): Share => ({
  id: "newShare1",
  autoId: "auto1",
  audience: "teams",
  teamNumbers: [23456, 12345],
  level: "propose",
  mode: "follow",
  revision: 4,
  revisionId: "000004-def",
  projection: "{}",
  expiresAt: iso(NOW_MS + 5 * DAY),
  revokedAt: null,
  createdAt: iso(NOW_MS - DAY),
  createdBy: "horizon-owner",
  ...over,
});

describe("which stopped shares the Sharing page lists", () => {
  it("stops listing one once a live share made after it carries its auto, audience, teams, level and mode", () => {
    const entry = stopped();
    expect(sharesAgain(share(), entry, NOW_MS)).toBe(true);
    expect(stoppedToList([entry], [share()], new Set(), NOW_MS)).toEqual([]);
    // Any difference, and it is still listed: the team did not share that again.
    for (const other of [
      share({ teamNumbers: [12345] }),
      share({ level: "view" }),
      share({ mode: "pinned" }),
      share({ autoId: "auto2" }),
      share({ createdAt: iso(NOW_MS - 3 * DAY) }),
      share({ revokedAt: iso(NOW_MS - 1000) }),
      share({ expiresAt: iso(NOW_MS - 1000) }),
      share({ id: entry.id }),
    ]) {
      expect(stoppedToList([entry], [other], new Set(), NOW_MS), JSON.stringify(other)).toEqual([entry]);
    }
  });

  it("matches a link share by its auto and mode alone, since a link is view only and names no team", () => {
    const link = stopped({ audience: "link", teamNumbers: [], level: "view" });
    expect(sharesAgain(share({ audience: "link", teamNumbers: [], level: "view" }), link, NOW_MS)).toBe(true);
    expect(sharesAgain(share(), link, NOW_MS)).toBe(false);
  });

  it("leaves out one this device shared again, one that has ended, and those of another auto when narrowed", () => {
    const a = stopped({ id: "a" });
    const b = stopped({ id: "b", expiresAt: iso(NOW_MS) });
    const c = stopped({ id: "c", autoId: "auto2" });
    expect(stoppedToList([a, b, c], [], new Set(), NOW_MS).map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(stoppedToList([a, b, c], [], new Set(["a"]), NOW_MS).map((entry) => entry.id)).toEqual(["c"]);
    expect(stoppedToList([a, b, c], [], new Set(), NOW_MS, "auto1").map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("the share dialog's settings for sharing one again", () => {
  it("carries its audience, teams, level, mode and end, to the minute on this computer's clock", () => {
    const end = new Date(2026, 9, 4, 17, 30, 0).getTime();
    const draft = shareAgainDraft(stopped({ expiresAt: iso(end) }));
    expect(draft).toMatchObject({ audience: "teams", teamNumbers: [12345, 23456], level: "propose", mode: "follow" });
    expect(draft.expiry).toEqual({ kind: "date", date: "2026-10-04", time: "17:30" });
    expect(expiryInstant(draft.expiry, NOW_MS)).toBe(iso(end));
  });

  it("keeps an end of day as the whole day, and starts from the most private projection options", () => {
    const end = new Date(2026, 9, 4, 23, 59, 59, 999).getTime();
    const draft = shareAgainDraft(stopped({ expiresAt: iso(end) }));
    expect(draft.expiry).toEqual({ kind: "date", date: "2026-10-04" });
    expect(expiryInstant(draft.expiry, NOW_MS)).toBe(iso(end));
    expect(draft).toMatchObject({ coarsen: false, includeCommands: false, includeTitle: false });
  });

  it("makes a link view only, with no teams", () => {
    expect(shareAgainDraft(stopped({ audience: "link", teamNumbers: [], level: "propose" }))).toMatchObject({ audience: "link", teamNumbers: [], level: "view" });
  });
});

describe("the ids this device shared again", () => {
  it("are kept per team, newest last, and a bad stored value reads as none", () => {
    const storage = memoryStorage();
    const kept = new SharedAgain(storage);
    kept.add("team1", "a");
    kept.add("team1", "b");
    kept.add("team1", "a");
    kept.add("team2", "c");
    kept.add("team1", "not an id!");
    expect([...kept.ids("team1")]).toEqual(["b", "a"]);
    expect([...kept.ids("team2")]).toEqual(["c"]);
    storage.set("zenith.cloud.sharedAgain.team3", "{not json");
    expect(kept.ids("team3").size).toBe(0);
    for (let i = 0; i < 60; i += 1) kept.add("team4", `id${String(i)}`);
    expect(kept.ids("team4").size).toBe(50);
    expect(kept.ids("team4").has("id59")).toBe(true);
  });
});

describe("the stopped-shares notice", () => {
  const item = { share: stopped({ unnamedTeams: 1 }), autoLabel: "first-auto.auto.json", whyNot: null };

  it("shows nothing when no share stopped", () => {
    expect(html(createElement(StoppedShares, { items: [], nowMs: NOW_MS, onShareAgain: () => undefined }))).toBe("");
  });

  it("says why each stopped, who it was for, and what it carried", () => {
    const markup = html(createElement(StoppedShares, { items: [item], nowMs: NOW_MS, onShareAgain: () => undefined }));
    const shown = text(markup);
    expect(shown).toContain(STOPPED_SHARES.lead);
    expect(shown).toContain("Teams 12345, 23456 and 1 team with no number");
    expect(shown).toContain(STOPPED_SHARES.reason["device-removed"]);
    expect(shown).toContain("first-auto.auto.json · revision 3");
    expect(shown).toContain("View and propose");
    expect(shown).toContain("Follows the latest version");
    expect(tagOf(markup, "stopped-share-stoppedShare1")).toContain('data-reason="device-removed"');
    expect(tagOf(markup, "stopped-share-stoppedShare1-again")).toContain('aria-disabled="false"');
  });

  it("calls Share again with the share, and disables it with the reason when it cannot open the dialog", () => {
    const asked: string[] = [];
    const tree = StoppedShares({ items: [item], nowMs: NOW_MS, onShareAgain: (entry) => asked.push(entry.id) });
    click(tree, "stopped-share-stoppedShare1-again");
    expect(asked).toEqual(["stoppedShare1"]);
    const blocked = html(createElement(StoppedShares, { items: [{ ...item, whyNot: STOPPED_SHARES.openFirst("first-auto.auto.json") }], nowMs: NOW_MS, onShareAgain: () => undefined }));
    expect(tagOf(blocked, "stopped-share-stoppedShare1-again")).toContain('aria-disabled="true"');
  });

  it("keeps every sentence short and plain", () => {
    const words = [
      STOPPED_SHARES.lead,
      ...Object.values(STOPPED_SHARES.reason),
      STOPPED_SHARES.shareAgainHint,
      STOPPED_SHARES.openFirst("first-auto.auto.json"),
      STOPPED_SHARES.dialog,
    ];
    for (const string of words) {
      for (const sentence of string.split(/(?<=[.:?])\s+/)) expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(16);
      expect(string).not.toMatch(/!/);
    }
  });
});

describe("a share made on a device the team took the key from", () => {
  it("is listed as stopped with its terms, shared again with them, and then no longer listed", async () => {
    const world = await cloudWorld([12345]);
    ownerSawPartnerCodes(world);
    const partner = world.partners[0]!;
    const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
    // The owner's laptop, given the team key by her first device, makes a share and is then lost.
    const laptop = new MemoryBackend({ database: world.database });
    laptop.signInAs(world.owner.uid);
    await (await laptop.requestTeamKey(world.owner.teamId)).sent;
    const status = await laptop.teamKeyStatus(world.owner.teamId);
    if (status.state !== "waiting") throw new Error("the laptop already holds the key");
    await (await world.owner.backend.grantDeviceKey(world.owner.teamId, status.device.deviceId, status.approvalCode)).sent;
    const shown = (await laptop.checkPartnerKeys([partner.teamId]))[0]!.keyId;
    const end = new Date(NOW_MS + 10 * DAY);
    const made = await laptop.createShare({
      teamId: world.owner.teamId, autoId: at.autoId, revision: at.revisionId, audience: "teams", teamIds: [partner.teamId],
      level: "propose", mode: "follow", expiresAt: end, projection: '{"kind":"projection"}', expectedKeys: { [partner.teamId]: shown },
    });
    await made.sent;
    await (await world.owner.backend.revokeDevice(world.owner.teamId, status.device.deviceId)).sent;

    const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    const [entry] = await api.listStopped(world.owner.teamId);
    expect(entry).toMatchObject({
      id: made.value.id, autoId: at.autoId, audience: "teams", teamNumbers: [12345], level: "propose", mode: "follow",
      revision: at.n, revisionId: at.revisionId, expiresAt: end.toISOString(), reason: "device-removed",
    });
    expect(await api.listShares(world.owner.teamId)).toEqual([]);

    const storage = new SharedAgain(memoryStorage());
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS, storage });
    await refreshSharing();
    expect(stoppedToList(getCloud().stopped, getCloud().shares, getCloud().sharedAgain, NOW_MS).map((s) => s.id)).toEqual([made.value.id]);

    // Share again, as the dialog sends it from the stopped share's settings: the stopped share is
    // no longer listed on this device.
    const draft = shareAgainDraft(entry!);
    const again = await createShare(
      {
        autoId: at.autoId, audience: draft.audience, teamNumbers: draft.teamNumbers, level: draft.level, mode: draft.mode,
        revision: at.n, revisionId: at.revisionId, expiresAt: expiryInstant(draft.expiry, NOW_MS), projection: '{"kind":"projection"}',
      },
      "Shared.",
      {},
      undefined,
      entry!.id,
    );
    expect(again).not.toBeNull();
    expect(getCloud().sharedAgain.has(made.value.id)).toBe(true);
    expect(storage.ids(world.owner.teamId).has(made.value.id)).toBe(true);
    expect(stoppedToList(getCloud().stopped, getCloud().shares, getCloud().sharedAgain, NOW_MS)).toEqual([]);
    // Another device of the team, with nothing kept, sees the new share carries the same terms.
    expect(stoppedToList(getCloud().stopped, getCloud().shares, new Set(), NOW_MS)).toEqual([]);
    expect((await partner.backend.listReceivedShares(partner.teamId)).map((s) => s.id)).toContain(again?.id);
  });
});
