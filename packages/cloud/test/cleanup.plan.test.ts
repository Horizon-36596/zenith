/**
 * The retention clean-up's decisions (`src/cleanup/plan.ts`), with a fixed time and no database: what
 * is deleted, what is kept, the 30-day boundary, and how deletes are packed into writes.
 */
import { describe, expect, it } from "vitest";
import {
  accountIdsIn,
  BETA_REQUEST_MAX_DAYS,
  betaRequestDue,
  bugReportDue,
  isAllowedWrite,
  isDeletablePath,
  isRotationPath,
  packWrites,
  planCleanup,
  plannedDeletes,
  retentionCutoff,
  type AccountCheck,
  type CleanupPlan,
  type SnapshotDoc,
} from "../src/cleanup/plan.js";

const NOW = new Date("2026-09-28T04:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

const doc = (path: string, data: Record<string, unknown> = {}): SnapshotDoc => ({ path, data });
const share = (id: string, expiresAt: Date, revokedAt: Date | null = null) => doc(`shares/${id}`, { expiresAt, revokedAt });
const invite = (code: string, teamId: string, expiresAt: Date, revoked = false) => doc(`invites/${code}`, { teamId, expiresAt, revoked });
const revokeEntry = (teamId: string, entryId: string, code: string, at: Date) =>
  doc(`teams/${teamId}/activity/${entryId}`, { kind: "invite.revoke", target: code, at });

const noAccounts: AccountCheck = { checked: new Set(), existing: new Set() };

function deletedPaths(docs: SnapshotDoc[], accounts: AccountCheck | null = noAccounts): string[] {
  return plannedDeletes(planCleanup({ docs, now: NOW, accounts })).map((d) => d.path);
}

describe("retention clean-up plan: beta requests", () => {
  const request = (uid: string, createdAt: unknown) => doc(`betaRequests/${uid}`, { createdAt });

  it("keeps a request for 30 days and deletes it one millisecond later, each in its own write", () => {
    expect(BETA_REQUEST_MAX_DAYS).toBe(30);
    expect(betaRequestDue({ createdAt: ago(30) }, NOW)).toBe(false);
    expect(betaRequestDue({ createdAt: ago(30, 1) }, NOW)).toBe(true);
    expect(betaRequestDue({}, NOW)).toBe(false);
    const docs = [request("fresh", ago(1)), request("exactly30", ago(30)), request("old", ago(30, 1)), request("older", ago(90)), request("noTime", "soon")];
    const plan = planCleanup({ docs, now: NOW, accounts: noAccounts });
    expect(plan.groups).toEqual([
      { deletes: [{ kind: "betaRequest", path: "betaRequests/old" }] },
      { deletes: [{ kind: "betaRequest", path: "betaRequests/older" }] },
    ]);
  });

  it("deletes the request of an account sign-in no longer has with its other leftovers, and keeps one that exists", () => {
    const accounts: AccountCheck = { checked: new Set(["gone", "here", "lapsed"]), existing: new Set(["here"]) };
    const docs = [doc("users/gone"), request("gone", ago(2)), request("here", ago(2)), request("lapsed", ago(40))];
    expect(accountIdsIn(docs)).toEqual(["gone", "here", "lapsed"]);
    const plan = planCleanup({ docs, now: NOW, accounts });
    // A request already due by its age is deleted once, on its own.
    expect(plan.groups).toEqual([
      { deletes: [{ kind: "betaRequest", path: "betaRequests/lapsed" }] },
      { deletes: [{ kind: "betaRequest", path: "betaRequests/gone" }, { kind: "profile", path: "users/gone" }] },
    ]);
    // Without a sign-in check, only the age decides.
    expect(deletedPaths(docs, null)).toEqual(["betaRequests/lapsed"]);
  });
});

describe("retention clean-up plan: shares", () => {
  it("keeps a live share, one revoked 29 days ago and one that ended exactly 30 days ago", () => {
    const docs = [
      share("live", ahead(7)),
      share("revoked29", ahead(3), ago(29)),
      share("expired29", ago(29)),
      share("exactly30", ago(30)),
      share("revokedExactly30", ahead(1), ago(30)),
    ];
    expect(deletedPaths(docs)).toEqual([]);
  });

  it("deletes a share one millisecond past 30 days, by expiry or by revocation", () => {
    const docs = [share("expired", ago(30, 1)), share("revoked", ahead(5), ago(30, 1))];
    expect(deletedPaths(docs).sort()).toEqual(["shares/expired", "shares/revoked"]);
  });

  it("uses the earlier of revocation and expiry as the end", () => {
    // Expired 45 days ago, revoked later than that (the rules would refuse it, but the plan does not rely on them).
    expect(deletedPaths([share("a", ago(45), ago(10))])).toEqual(["shares/a"]);
    // Revoked 45 days ago, expiry far ahead.
    expect(deletedPaths([share("b", ahead(300), ago(45))])).toEqual(["shares/b"]);
    // Neither is past the cutoff.
    expect(deletedPaths([share("c", ago(10), ago(20))])).toEqual([]);
  });

  it("deletes an expired share's time requests and proposals with it, before the share, in one group", () => {
    const docs = [
      share("old", ago(31)),
      doc("shares/old/timeRequests/teamB", {}),
      doc("shares/old/timeRequests/teamC", {}),
      doc("proposals/p1", { shareId: "old" }),
      doc("proposals/p2", { shareId: "live" }),
      share("live", ahead(2)),
      doc("shares/live/timeRequests/teamB", {}),
    ];
    const plan = planCleanup({ docs, now: NOW, accounts: noAccounts });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.deletes).toEqual([
      { kind: "proposal", path: "proposals/p1" },
      { kind: "timeRequest", path: "shares/old/timeRequests/teamB" },
      { kind: "timeRequest", path: "shares/old/timeRequests/teamC" },
      { kind: "share", path: "shares/old" },
    ]);
  });

  it("keeps a share without a readable expiry, and says so", () => {
    const plan = planCleanup({ docs: [doc("shares/odd", { expiresAt: "soon", revokedAt: null })], now: NOW, accounts: noAccounts });
    expect(plannedDeletes(plan)).toEqual([]);
    expect(plan.notices.join(" ")).toContain("1 share has no readable expiry");
  });
});

describe("retention clean-up plan: invites", () => {
  it("deletes an invite that expired more than 30 days ago and keeps one that expired 29 or exactly 30 days ago", () => {
    const docs = [invite("old", "t1", ago(31)), invite("recent", "t1", ago(29)), invite("edge", "t1", ago(30)), invite("live", "t1", ahead(7))];
    expect(deletedPaths(docs)).toEqual(["invites/old"]);
  });

  it("dates a revocation from the team's invite.revoke activity entry", () => {
    const docs = [
      invite("revokedLongAgo", "t1", ahead(20), true),
      revokeEntry("t1", "e1", "revokedLongAgo", ago(31)),
      invite("revokedRecently", "t1", ahead(20), true),
      revokeEntry("t1", "e2", "revokedRecently", ago(10)),
    ];
    expect(deletedPaths(docs)).toEqual(["invites/revokedLongAgo"]);
  });

  it("keeps a revoked invite until its expiry passes when no entry dates the revocation", () => {
    expect(deletedPaths([invite("undated", "t1", ahead(20), true)])).toEqual([]);
    expect(deletedPaths([invite("undatedOld", "t1", ago(31), true)])).toEqual(["invites/undatedOld"]);
  });

  it("takes the latest revoke entry, and only from the invite's own team", () => {
    const docs = [
      invite("code1", "t1", ahead(20), true),
      // An entry anyone in the team could write earlier by hand, then the real one.
      revokeEntry("t1", "e1", "code1", ago(60)),
      revokeEntry("t1", "e2", "code1", ago(5)),
      invite("code2", "t1", ahead(20), true),
      revokeEntry("tOther", "e3", "code2", ago(60)),
    ];
    expect(deletedPaths(docs)).toEqual([]);
  });

  it("ignores a revoke entry for an invite that is not revoked", () => {
    expect(deletedPaths([invite("live", "t1", ahead(20), false), revokeEntry("t1", "e1", "live", ago(60))])).toEqual([]);
  });
});

describe("retention clean-up plan: deleted accounts", () => {
  const docs = [
    doc("users/gone"),
    doc("teams/t1/members/gone"),
    doc("teams/t2/members/gone"),
    doc("users/here"),
    doc("teams/t1/members/here"),
    doc("users/unasked"),
    doc("admins/goneAdmin"),
    doc("admins/here"),
  ];
  const accounts: AccountCheck = { checked: new Set(["gone", "here", "goneAdmin"]), existing: new Set(["here"]) };

  it("deletes the profile and memberships of an account sign-in no longer has, memberships first", () => {
    const plan = planCleanup({ docs, now: NOW, accounts });
    expect(plan.groups).toEqual([
      {
        deletes: [
          { kind: "membership", path: "teams/t1/members/gone" },
          { kind: "membership", path: "teams/t2/members/gone" },
          { kind: "profile", path: "users/gone" },
        ],
      },
    ]);
  });

  it("deletes a gone account's device records and key grants, and marks each team that still exists rotation pending", () => {
    const leftovers = [
      ...docs,
      doc("users/gone/devices/d1"),
      doc("users/gone/devices/d2"),
      doc("users/here/devices/d3"),
      doc("teams/t1/keyGrants/d1", { uid: "gone" }),
      doc("teams/t1/keyGrants/d2", { uid: "gone" }),
      doc("teams/t1/keyGrants/d3", { uid: "here" }),
      doc("teams/t2/keyGrants/d1", { uid: "gone" }),
      doc("teams/t1"),
    ];
    const plan = planCleanup({ docs: leftovers, now: NOW, accounts });
    // One group, one atomic write: the mark is never sent without the grants it is for.
    expect(plan.groups).toHaveLength(1);
    const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    expect([...plannedDeletes(plan)].sort(byPath)).toEqual([
      { kind: "grant", path: "teams/t1/keyGrants/d1" },
      { kind: "grant", path: "teams/t1/keyGrants/d2" },
      { kind: "membership", path: "teams/t1/members/gone" },
      { kind: "rotation", path: "teams/t1" },
      { kind: "grant", path: "teams/t2/keyGrants/d1" },
      { kind: "membership", path: "teams/t2/members/gone" },
      { kind: "profile", path: "users/gone" },
      { kind: "device", path: "users/gone/devices/d1" },
      { kind: "device", path: "users/gone/devices/d2" },
    ].sort(byPath));
    // Team t2 was not found to exist, so it is not marked: a mark never creates a team.
    expect(plannedDeletes(plan).filter((d) => d.kind === "rotation").map((d) => d.path)).toEqual(["teams/t1"]);
    // A grant whose uid field is missing or another account's is kept.
    expect(deletedPaths([...docs, doc("teams/t1/keyGrants/d9", {}), doc("teams/t1"), doc("teams/t1/keyGrants/d8", { uid: "here" })], accounts)).not.toContain("teams/t1/keyGrants/d9");
  });

  it("marks a gone account's teams first and deletes its profile last, and a split group marks in a write of its own", () => {
    const leftovers = [
      ...docs,
      doc("teams/t1"),
      doc("teams/t2"),
      doc("teams/t1/keyGrants/d1", { uid: "gone" }),
      doc("teams/t2/keyGrants/d2", { uid: "gone" }),
      doc("teams/t2/keyRequests/d3", { uid: "gone" }),
      doc("teams/t2/keyRequests/d4", { uid: "here" }),
      doc("users/gone/devices/d1"),
    ];
    const plan = planCleanup({ docs: leftovers, now: NOW, accounts });
    const deletes = plannedDeletes(plan);
    expect(deletes.slice(0, 2)).toEqual([
      { kind: "rotation", path: "teams/t1" },
      { kind: "rotation", path: "teams/t2" },
    ]);
    expect(deletes[deletes.length - 1]).toEqual({ kind: "profile", path: "users/gone" });
    expect(deletes).toContainEqual({ kind: "keyRequest", path: "teams/t2/keyRequests/d3" });
    expect(deletes.map((d) => d.path)).not.toContain("teams/t2/keyRequests/d4");
    const writes = packWrites(plan, 3);
    expect(writes[0]).toEqual([
      { kind: "rotation", path: "teams/t1" },
      { kind: "rotation", path: "teams/t2" },
    ]);
    expect(writes.flat()).toHaveLength(deletes.length);
    expect(writes.slice(1).flat().some((d) => d.kind === "rotation")).toBe(false);
  });

  it("deletes the beta tester entry of an account sign-in no longer has, with its other leftovers, and keeps one that exists", () => {
    const withTesters = [...docs, doc("betaTesters/gone", { name: "Ada Lovelace" }), doc("betaTesters/here", { name: "Grace Hopper" }), doc("betaTesters/unasked")];
    const plan = planCleanup({ docs: withTesters, now: NOW, accounts });
    expect(plan.groups).toEqual([
      {
        deletes: [
          { kind: "betaTester", path: "betaTesters/gone" },
          { kind: "membership", path: "teams/t1/members/gone" },
          { kind: "membership", path: "teams/t2/members/gone" },
          { kind: "profile", path: "users/gone" },
        ],
      },
    ]);
    // A tester whose account is gone and who never made a profile is found by the entry alone.
    const testerOnly: AccountCheck = { checked: new Set(["testerOnly", "here"]), existing: new Set(["here"]) };
    expect(deletedPaths([doc("betaTesters/testerOnly"), doc("users/here"), doc("betaTesters/here")], testerOnly)).toEqual(["betaTesters/testerOnly"]);
    expect(accountIdsIn([doc("betaTesters/testerOnly"), doc("users/here")])).toEqual(["here", "testerOnly"]);
  });

  it("names an admin whose account is gone for the console, and deletes nothing in admins", () => {
    const plan = planCleanup({ docs, now: NOW, accounts });
    expect(plan.staleAdmins).toEqual(["goneAdmin"]);
    expect(plannedDeletes(plan).some((d) => d.path.startsWith("admins/"))).toBe(false);
  });

  it("never deletes for an account id sign-in was not asked about", () => {
    expect(deletedPaths(docs, accounts)).not.toContain("users/unasked");
  });

  it("deletes nothing tied to accounts when sign-in was not checked", () => {
    const plan = planCleanup({ docs, now: NOW, accounts: null });
    expect(plannedDeletes(plan)).toEqual([]);
    expect(plan.notices.join(" ")).toContain("Sign-in was not checked");
  });

  it("deletes nothing tied to accounts when sign-in reports every account gone", () => {
    const plan = planCleanup({ docs, now: NOW, accounts: { checked: new Set(["gone", "here", "goneAdmin"]), existing: new Set() } });
    expect(plannedDeletes(plan)).toEqual([]);
    expect(plan.staleAdmins).toEqual([]);
    expect(plan.notices.join(" ")).toContain("misconfigured");
  });

  it("lists the account ids of profiles, memberships and admins", () => {
    expect(accountIdsIn(docs)).toEqual(["gone", "goneAdmin", "here", "unasked"]);
  });
});

describe("retention clean-up plan: bug reports", () => {
  const report = (id: string, data: Record<string, unknown>) => doc(`bugReports/${id}`, { reporter: "here", status: "new", ...data });
  const accounts: AccountCheck = { checked: new Set(["gone", "here"]), existing: new Set(["here"]) };

  it("deletes a report sent more than 90 days ago, whatever its status, and keeps one sent exactly 90 days ago", () => {
    const docs = [report("old", { createdAt: ago(90, 1) }), report("oldTriaged", { createdAt: ago(200), status: "triaged" }), report("exactly90", { createdAt: ago(90) })];
    expect(deletedPaths(docs).sort()).toEqual(["bugReports/old", "bugReports/oldTriaged"]);
  });

  it("deletes a report closed more than 30 days ago, and keeps one closed 30 days ago or triaged long ago", () => {
    const docs = [
      report("closed31", { createdAt: ago(40), status: "closed", updatedAt: ago(30, 1) }),
      report("closed30", { createdAt: ago(40), status: "closed", updatedAt: ago(30) }),
      report("triaged", { createdAt: ago(80), status: "triaged", updatedAt: ago(70) }),
      report("recent", { createdAt: ago(1) }),
    ];
    expect(deletedPaths(docs)).toEqual(["bugReports/closed31"]);
    expect(bugReportDue({ status: "closed" }, NOW)).toBe(false);
  });

  it("deletes every report of an account sign-in no longer has, with that account, once each", () => {
    const docs = [
      report("fresh", { reporter: "gone", createdAt: ago(1) }),
      report("stale", { reporter: "gone", createdAt: ago(100) }),
      report("mine", { reporter: "here", createdAt: ago(1) }),
    ];
    expect(deletedPaths(docs, accounts).sort()).toEqual(["bugReports/fresh", "bugReports/stale"]);
    // Without a sign-in check, only what is due by time goes.
    expect(deletedPaths(docs, null)).toEqual(["bugReports/stale"]);
  });

  it("asks sign-in about reporters, since deleting an account in the app removes its profile", () => {
    expect(accountIdsIn([report("r1", { reporter: "gone" }), doc("users/here")])).toEqual(["gone", "here"]);
  });
});

describe("retention clean-up plan: what is always kept", () => {
  const ancient = new Date("2020-01-01T00:00:00.000Z");
  const kept = [
    doc("deletedTeams/t9", { deletedAt: ancient, expiresAt: ancient }),
    doc("claims/12345", { claimedAt: ancient, expiresAt: ancient }),
    doc("claims/12345/history/0", { at: ancient, by: "gone" }),
    doc("adminLog/entry1", { at: ancient, by: "gone", expiresAt: ancient }),
    doc("disputes/d1", { createdAt: ancient }),
    doc("verifications/v1", { createdAt: ancient }),
    doc("teams/t1", { createdBy: "gone" }),
    doc("teams/t1/activity/a1", { at: ancient, by: "gone", kind: "share.revoke" }),
    doc("teams/t1/inbox/oldShare", { shareId: "oldShare", createdAt: ancient }),
    doc("teams/t1/autos/a1", { createdBy: "gone" }),
    doc("teams/t1/autos/a1/revisions/000001-abc", { author: "gone" }),
    doc("teams/t1/settings/sharing", {}),
    doc("admins/gone", {}),
    doc("config/access", { betaOpen: true }),
    // Paths shaped like deletable ones at the wrong depth.
    doc("teams/t1/shares/s1", { expiresAt: ancient, revokedAt: null }),
    doc("x/y/invites/i1", { teamId: "t1", expiresAt: ancient, revoked: false }),
  ];

  it("never plans a delete outside the deletable paths, whatever the dates and accounts", () => {
    const accounts: AccountCheck = { checked: new Set(["gone", "other"]), existing: new Set(["other"]) };
    expect(deletedPaths([...kept, doc("users/other")], accounts)).toEqual([]);
    for (const { path } of kept) expect(isDeletablePath(path)).toBe(false);
  });

  it("recognises exactly the deletable paths", () => {
    for (const path of ["shares/s", "shares/s/timeRequests/t", "proposals/p", "invites/i", "users/u", "teams/t/members/u", "users/u/devices/d", "teams/t/keyGrants/d", "teams/t/keyRequests/d", "betaTesters/u", "betaRequests/u", "bugReports/r"]) {
      expect(isDeletablePath(path)).toBe(true);
    }
    for (const path of ["shares", "shares/", "shares//timeRequests/t", "users/u/extra", "teams/t/members", "adminLog/e", "teams/t", "teams/t/teamKeys/1", "teams/t/recovery/current", "bugReports", "bugReports/r/extra/x", "betaTesters", "betaTesters/u/extra/x", "betaRequests", "betaRequests/u/extra/x", "config/access"]) {
      expect(isDeletablePath(path)).toBe(false);
    }
  });

  it("writes a rotation mark only to a team document, and never deletes one", () => {
    expect(isRotationPath("teams/t")).toBe(true);
    for (const path of ["teams", "teams/t/members/u", "users/u", "shares/s", "deletedTeams/t"]) expect(isRotationPath(path), path).toBe(false);
    expect(isAllowedWrite({ kind: "rotation", path: "teams/t" })).toBe(true);
    expect(isAllowedWrite({ kind: "rotation", path: "users/u" })).toBe(false);
    expect(isAllowedWrite({ kind: "grant", path: "teams/t" })).toBe(false);
  });
});

describe("retention clean-up plan: determinism and cutoff", () => {
  it("gives the same plan whatever order the documents were read in", () => {
    const docs = [
      share("s1", ago(40)),
      doc("proposals/p1", { shareId: "s1" }),
      doc("shares/s1/timeRequests/t2"),
      invite("i1", "t1", ago(40)),
      share("s2", ago(35)),
      doc("users/gone"),
      doc("teams/t1/members/gone"),
    ];
    const accounts: AccountCheck = { checked: new Set(["gone", "here"]), existing: new Set(["here"]) };
    const forward = planCleanup({ docs, now: NOW, accounts });
    const backward = planCleanup({ docs: [...docs].reverse(), now: NOW, accounts });
    expect(backward).toEqual(forward);
  });

  it("puts the cutoff exactly 30 days before now", () => {
    expect(retentionCutoff(NOW).toISOString()).toBe("2026-08-29T04:17:00.000Z");
  });
});

describe("retention clean-up plan: packing writes", () => {
  const group = (prefix: string, n: number) => ({
    deletes: Array.from({ length: n }, (_, i) => ({ kind: "proposal" as const, path: `proposals/${prefix}${String(i)}` })),
  });
  const plan = (sizes: number[]): CleanupPlan => ({ groups: sizes.map((n, i) => group(`g${String(i)}-`, n)), staleAdmins: [], notices: [] });

  it("fills writes up to the limit without splitting a group", () => {
    const writes = packWrites(plan([3, 3, 3]), 7);
    expect(writes.map((w) => w.length)).toEqual([6, 3]);
  });

  it("splits only a group larger than the limit, in order", () => {
    const writes = packWrites(plan([2, 9, 1]), 4);
    expect(writes.map((w) => w.length)).toEqual([2, 4, 4, 1, 1]);
    expect(writes.flat().map((d) => d.path)).toEqual(plannedDeletes(plan([2, 9, 1])).map((d) => d.path));
  });

  it("uses writes of at most 400 by default", () => {
    const writes = packWrites(plan([250, 250, 450]));
    expect(writes.map((w) => w.length)).toEqual([250, 250, 400, 50]);
    expect(Math.max(...writes.map((w) => w.length))).toBeLessThanOrEqual(400);
  });

  it("makes no write for an empty plan", () => {
    expect(packWrites(plan([]))).toEqual([]);
  });
});
