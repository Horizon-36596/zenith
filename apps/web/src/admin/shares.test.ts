/**
 * The admin dashboard's All shares list, as pure functions: each share's status (a deleted owner
 * team first, then revoked, then expired), the words of each column, newest first, and the status,
 * audience and team-search filters.
 */
import { describe, expect, it } from "vitest";
import type { Share, Team } from "@horizon36596/zenith-cloud";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { whenWords } from "../account/words";
import {
  countWords,
  filterShareRows,
  NO_FILTERS,
  shareRows,
  shareStatus,
  shareTeamIds,
  type TeamsById,
} from "./shares";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T12:00:00Z").getTime();
const at = (days: number) => new Date(NOW + days * DAY);

function team(id: string, number: number | null, name: string, status: Team["status"] = "unverified"): Team {
  // The team's public key is metadata too; the admin view never uses it.
  return { id, number, name, status, createdBy: "someone", createdAt: at(-30), encKey: { v: 1, spki: new Uint8Array(91), fingerprint: new Uint8Array(32), signSpki: new Uint8Array(91), sig: null } };
}

function share(id: string, over: Partial<Share> = {}): Share {
  return {
    id,
    ownerTeamId: "H",
    autoId: "autoOneXXXXXXXXXXXXXXX",
    audience: "teams",
    teamIds: ["P"],
    level: "view",
    mode: "pinned",
    revision: "000002-abcdefgh",
    expiresAt: at(5),
    revokedAt: null,
    createdBy: "alice",
    createdAt: at(-2),
    updatedAt: at(-1),
    projection: '{"title":"Close side"}',
    ...over,
  };
}

const teams: TeamsById = new Map<string, Team | null>([
  ["H", team("H", 36596, "Horizon", "verified")],
  ["P", team("P", 12345, "Partner")],
  ["Q", team("Q", null, "No number yet")],
  ["G", null],
]);

describe("share status", () => {
  it("is team deleted, then revoked, then expired, then live", () => {
    expect(shareStatus(share("a", { revokedAt: at(-1), expiresAt: at(-1) }), false, NOW)).toBe("team-deleted");
    expect(shareStatus(share("a", { revokedAt: at(-1), expiresAt: at(-1) }), true, NOW)).toBe("revoked");
    expect(shareStatus(share("a", { expiresAt: at(-1) }), true, NOW)).toBe("expired");
    expect(shareStatus(share("a", { expiresAt: new Date(NOW) }), true, NOW)).toBe("expired");
    expect(shareStatus(share("a"), true, NOW)).toBe("live");
  });
});

describe("share rows", () => {
  it("names the owner team, a short share id, the audience, the level, the version and the times", () => {
    const [row] = shareRows([share("shareAbcdefXXXXXXXXXXX", { teamIds: ["P", "Q"], level: "propose" })], teams, NOW);
    expect(row).toMatchObject({
      status: "live",
      owner: "36596 Horizon",
      ownerStatus: "verified",
      shortId: "Share shareA",
      audience: "Teams 12345 Partner, No number yet",
      level: "View and propose",
      version: "Pinned to revision 2",
      expiryLabel: "Ends",
      expiry: whenWords(at(5)),
      created: whenWords(at(-2)),
      updated: whenWords(at(-1)),
    });
  });

  it("says anyone with the link, follows latest and ended", () => {
    const [row] = shareRows(
      [share("a", { audience: "link", teamIds: [], mode: "follow", revision: "000004-xyz", expiresAt: at(-1), projection: '{"kind":"projection"}' })],
      teams,
      NOW,
    );
    expect(row).toMatchObject({
      status: "expired",
      audience: "Anyone with the link",
      level: "View only",
      version: "Follows the latest version, now revision 4",
      expiryLabel: "Ended",
      expiry: whenWords(at(-1)),
    });
  });

  it("marks a share whose team is gone, and names a recipient that is gone", () => {
    const [row] = shareRows([share("a", { ownerTeamId: "G", teamIds: ["G2"] })], teams, NOW);
    expect(row).toMatchObject({ status: "team-deleted", owner: "A team that no longer exists", ownerStatus: null });
    expect(row?.audience).toBe("A deleted team");
  });

  it("ends a share whose every team was deleted, and names a deleted team beside a live one", () => {
    const [gone] = shareRows([share("a", { teamIds: ["G2"] })], teams, NOW);
    expect(gone).toMatchObject({ status: "team-deleted", audience: "A deleted team" });
    const [mixed] = shareRows([share("b", { teamIds: ["P", "G2"] })], teams, NOW);
    expect(mixed?.status).toBe("live");
    expect(mixed?.audience).toMatch(/^Team 12345 .*Partner.* and a deleted team$/);
  });

  it("lists newest first, with the id breaking a tie", () => {
    const rows = shareRows([share("b", { createdAt: at(-3) }), share("c", { createdAt: at(-1) }), share("a", { createdAt: at(-3) })], teams, NOW);
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("never carries what the share shows: no projection, title or command names", () => {
    const projection = '{"title":"Close side","commands":["scoreTips"]}';
    const [row] = shareRows([share("a", { projection })], teams, NOW);
    const text = JSON.stringify(row);
    expect(text).not.toContain("Close side");
    expect(text).not.toContain("scoreTips");
    expect(Object.keys(row ?? {})).not.toContain("share");
    expect(Object.keys(row ?? {})).not.toContain("projection");
  });
});

describe("share filters", () => {
  const shares = [
    share("live", { createdAt: at(-1) }),
    share("link", { audience: "link", teamIds: [], createdAt: at(-2) }),
    share("revoked", { revokedAt: at(-1), createdAt: at(-3) }),
    share("expired", { ownerTeamId: "Q", teamIds: ["H"], expiresAt: at(-1), createdAt: at(-4) }),
    share("gone", { ownerTeamId: "G", createdAt: at(-5) }),
  ];
  const rows = shareRows(shares, teams, NOW);
  const ids = (filters: Partial<typeof NO_FILTERS>) => filterShareRows(rows, { ...NO_FILTERS, ...filters }).map((r) => r.id);

  it("keeps everything with no filter", () => {
    expect(ids({})).toEqual(["live", "link", "revoked", "expired", "gone"]);
  });

  it("filters by status and by audience, together", () => {
    expect(ids({ status: "live" })).toEqual(["live", "link"]);
    expect(ids({ status: "revoked" })).toEqual(["revoked"]);
    expect(ids({ status: "expired" })).toEqual(["expired"]);
    expect(ids({ status: "team-deleted" })).toEqual(["gone"]);
    expect(ids({ audience: "link" })).toEqual(["link"]);
    expect(ids({ audience: "teams", status: "live" })).toEqual(["live"]);
  });

  it("searches the owner and the named teams by number or name, ignoring case", () => {
    expect(ids({ search: "12345" })).toEqual(["live", "revoked", "gone"]);
    expect(ids({ search: " no NUMBER " })).toEqual(["expired"]);
    expect(ids({ search: "36596" })).toEqual(["live", "link", "revoked", "expired"]);
    expect(ids({ search: "no longer exists" })).toEqual(["gone"]);
    expect(ids({ search: "99999" })).toEqual([]);
  });

  it("counts what it shows", () => {
    expect(countWords(5, 5)).toBe("5 shares");
    expect(countWords(1, 1)).toBe("1 share");
    expect(countWords(2, 5)).toBe("2 of 5 shares");
  });

  it("names every team once, owners first", () => {
    expect(shareTeamIds(shares)).toEqual(["H", "Q", "G", "P"]);
  });
});

describe("All shares against the in-memory cloud", () => {
  it("a Horizon admin reads every team's shares; a team owner is refused", async () => {
    const database = new MemoryDatabase();
    database.seed("admins/hana", { name: "Reviewer" });
    database.seed("teams/teamHorizonXXXXXXXXXXX", { number: 36596, name: "Horizon", status: "unverified", createdBy: "alice", createdAt: at(-9) });
    database.seed("teams/teamHorizonXXXXXXXXXXX/members/alice", { uid: "alice", teamId: "teamHorizonXXXXXXXXXXX", role: "owner", displayName: "Alice", joinedAt: at(-9) });
    for (const [id, owner] of [["shareOneXXXXXXXXXXXXXX", "teamHorizonXXXXXXXXXXX"], ["shareTwoXXXXXXXXXXXXXX", "teamGoneXXXXXXXXXXXXXX"]] as const) {
      const doc: Record<string, unknown> = { ...share(id, { ownerTeamId: owner, teamIds: [], audience: "link" }) };
      delete doc.id;
      database.seed(`shares/${id}`, doc);
    }
    const hana = new MemoryBackend({ database });
    hana.signInAs("hana");
    const all = await hana.listAllShares();
    const found = new Map<string, Team | null>();
    for (const id of shareTeamIds(all)) found.set(id, await hana.getTeam(id));
    expect(shareRows(all, found, NOW).map((r) => [r.id, r.status])).toEqual([
      ["shareOneXXXXXXXXXXXXXX", "live"],
      ["shareTwoXXXXXXXXXXXXXX", "team-deleted"],
    ]);
    const alice = new MemoryBackend({ database });
    alice.signInAs("alice");
    await expect(alice.listAllShares()).rejects.toThrow("Only Horizon admins can see every share.");
  });
});
