/**
 * A partner loaded from a received cloud share remembers it (spec 13 sections 8.3 and 9): the
 * share's id, revision, level, the sharing team and when it last changed, which the Partners panel
 * turns into "updated 3 hours ago" and, once the share has moved on, a newer version to reload. A
 * reload keeps the partner's colour, offset and visibility.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ReceivedShare } from "./types";
import { receivedShareSource, reloadSharePartner } from "../alliance/cloudSource";
import { newerShareOf, partnerShareOf, partnerUpdatedWords } from "./partnerShare";
import { fileSource } from "../alliance/source";
import { getAllianceState, loadPartners, resetAlliance, setPartnerOffset, setPartnerVisible } from "../alliance/store";
import { readViewedShare } from "./SharedAutoViewer";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const PROPOSE = readFileSync(`${starter}partners/starter-collect-and-score.propose.projection.json`, "utf8");
const VIEW = readFileSync(`${starter}partners/starter-partner.projection.json`, "utf8");

const NOW_MS = Date.parse("2026-09-27T12:00:00Z");

const received = (patch: Partial<ReceivedShare> = {}): ReceivedShare => ({
  id: "Zq3fK9xT2mNp7LwR4sVb8A",
  audience: "teams",
  fromTeamNumber: 36596,
  fromTeamName: "Horizon",
  fromTeamStatus: "unverified",
  fromTeamId: "team-horizon",
  teamIds: ["team-me"],
  level: "propose",
  mode: "follow",
  revision: 2,
  revisionId: "000002-abc",
  expiresAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-09-27T09:00:00.000Z",
  projection: PROPOSE,
  ...patch,
});

afterEach(() => {
  resetAlliance();
});

describe("a partner from a received cloud share", () => {
  it("carries the share's id, revision, level, sharing team and last change", async () => {
    const { added } = await loadPartners(receivedShareSource(received()));
    expect(added).toHaveLength(1);
    expect(added[0]?.share).toEqual({
      shareId: "Zq3fK9xT2mNp7LwR4sVb8A",
      revision: 2,
      revisionId: "000002-abc",
      level: "propose",
      mode: "follow",
      fromTeamId: "team-horizon",
      fromTeam: "Team 36596 (unverified)",
      teamIds: ["team-me"],
      updatedAt: "2026-09-27T09:00:00.000Z",
    });
    expect(partnerUpdatedWords(partnerShareOf(received()), NOW_MS)).toBe("updated 3 hours ago");
  });

  it("carries no share when it came from a file", async () => {
    const { added } = await loadPartners(fileSource([{ name: "partner.projection.json", size: VIEW.length, text: () => Promise.resolve(VIEW) }]));
    expect(added[0]?.share).toBeUndefined();
  });

  it("notices a newer revision, or a change of level, and nothing else", () => {
    const loaded = partnerShareOf(received());
    expect(newerShareOf(loaded, [received()])).toBeNull();
    expect(newerShareOf(loaded, [received({ updatedAt: "2026-09-27T11:00:00.000Z", expiresAt: "2026-10-10T12:00:00.000Z" })])).toBeNull();
    expect(newerShareOf(loaded, [received({ revision: 3, revisionId: "000003-def" })])?.revision).toBe(3);
    expect(newerShareOf(loaded, [received({ level: "view", projection: VIEW })])?.level).toBe("view");
    expect(newerShareOf(loaded, [])).toBeNull();
  });

  it("reloads a newer version in place, keeping its colour, offset and visibility", async () => {
    const { added } = await loadPartners(receivedShareSource(received()));
    const id = added[0]?.id ?? "";
    setPartnerOffset(id, 1.5);
    setPartnerVisible(id, false);
    reloadSharePartner(id, received({ revision: 3, revisionId: "000003-def", updatedAt: "2026-09-27T11:30:00.000Z" }));
    const [partner] = getAllianceState().partners;
    expect(getAllianceState().partners).toHaveLength(1);
    expect(partner).toMatchObject({ id, colour: added[0]?.colour, offsetS: 1.5, visible: false });
    expect(partner?.share).toMatchObject({ revision: 3, revisionId: "000003-def", updatedAt: "2026-09-27T11:30:00.000Z" });
  });

  it("says a damaged share in one sentence that asks the team that shared it", () => {
    const { loaded } = readViewedShare(received({ projection: '{"zenith":' }));
    const problem = loaded.ok ? "" : loaded.reason;
    expect(problem).toMatch(/^The auto shared by Team 36596/);
    expect(problem).toContain("Ask that team to share it again.");
    expect(problem).not.toContain("download");
  });
});
