/**
 * The retention clean-up's runner and command line with an in-memory source: dry runs delete
 * nothing, a failed write stops the run and is reported, a failed sign-in check deletes nothing tied
 * to accounts, the log carries ids and counts only, and the command line refuses what it must.
 * The real APIs are exercised against the emulators in emulator.cleanup.test.ts.
 */
import { describe, expect, it } from "vitest";
import { main, parseArgs, readServiceAccount, resolveTarget, UsageError } from "../src/cleanup/cli.js";
import type { SnapshotDoc } from "../src/cleanup/plan.js";
import type { RestQuery } from "../src/cleanup/rest.js";
import { formatReport, runCleanup, type CleanupSource } from "../src/cleanup/run.js";

const NOW = new Date("2026-09-28T04:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A source over a map of full documents that answers queries the way Firestore does, closely enough. */
class FakeSource implements CleanupSource {
  readonly deleted: string[][] = [];
  failWrite: number | null = null;
  failAccounts = false;
  /** Runs once, just before the first delete is applied: a write by someone else during the run. */
  beforeFirstDelete: (() => void) | null = null;
  constructor(
    readonly docs: Map<string, Record<string, unknown>>,
    readonly accounts: Set<string>,
  ) {}

  query(query: RestQuery): Promise<SnapshotDoc[]> {
    const out: SnapshotDoc[] = [];
    for (const [path, data] of this.docs) {
      const segments = path.split("/");
      const collection = segments[segments.length - 2];
      const parent = segments.slice(0, -2).join("/");
      if (collection !== query.collection) continue;
      if (query.allDescendants !== true && parent !== query.parent) continue;
      const matches = (query.where ?? []).every((f) => {
        const value = data[f.field];
        if (f.op === "EQUAL") return value === f.value;
        return value instanceof Date && f.value instanceof Date && value.getTime() < f.value.getTime();
      });
      if (!matches) continue;
      out.push({ path, data: Object.fromEntries(query.select.filter((k) => k in data).map((k) => [k, data[k]])) });
    }
    return Promise.resolve(out);
  }

  deleteAll(paths: readonly string[], rotations: readonly string[] = []): Promise<void> {
    if (this.failWrite === this.deleted.length) return Promise.reject(new Error("PERMISSION_DENIED: Missing or insufficient permissions."));
    // Like the commit's precondition: a mark on a team that does not exist fails the whole write.
    if (rotations.some((path) => !this.docs.has(path))) return Promise.reject(new Error("NOT_FOUND: No document to update."));
    this.beforeFirstDelete?.();
    this.beforeFirstDelete = null;
    this.deleted.push([...paths]);
    for (const path of paths) this.docs.delete(path);
    for (const path of rotations) this.docs.set(path, { ...this.docs.get(path), rotationPending: true });
    return Promise.resolve();
  }

  existingDocuments(paths: readonly string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(paths.filter((path) => this.docs.has(path))));
  }

  existingAccounts(uids: readonly string[]): Promise<Set<string>> {
    if (this.failAccounts) return Promise.reject(new Error("PERMISSION_DENIED: firebaseauth.users.get"));
    return Promise.resolve(new Set(uids.filter((uid) => this.accounts.has(uid))));
  }
}

function seed(): FakeSource {
  const docs = new Map<string, Record<string, unknown>>([
    ["shares/old", { expiresAt: ago(40), revokedAt: null, projection: '{"secret":"auto content"}', createdBy: "here" }],
    ["shares/old/timeRequests/teamB", { reason: "next-event", requestedBy: "here" }],
    ["proposals/p1", { shareId: "old", diff: '{"secret":"diff content"}' }],
    ["shares/live", { expiresAt: new Date(NOW.getTime() + 3 * DAY), revokedAt: null }],
    ["invites/oldInvite", { teamId: "t1", expiresAt: ago(45), revoked: false }],
    ["users/gone", { displayName: "Ada Lovelace" }],
    ["teams/t1/members/gone", { displayName: "Ada Lovelace", role: "viewer" }],
    ["users/here", { displayName: "Grace Hopper" }],
    ["teams/t1/members/here", { displayName: "Grace Hopper", role: "owner" }],
    ["adminLog/e1", { at: ago(400), by: "here", action: "queue.list" }],
  ]);
  return new FakeSource(docs, new Set(["here"]));
}

describe("retention clean-up runner", () => {
  it("deletes what the plan says and keeps the rest", async () => {
    const source = seed();
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect([...source.docs.keys()].sort()).toEqual(["adminLog/e1", "shares/live", "teams/t1/members/here", "users/here"]);
    expect(report.deleted).toHaveLength(6);
    expect(report.writes).toEqual({ planned: 1, sent: 1 });
  });

  it("deletes a deleted account's devices and grants, and marks the team that held them rotation pending", async () => {
    const source = seed();
    source.docs.set("teams/t1", { name: "Team one", createdBy: "here" });
    source.docs.set("users/gone/devices/dGone", { encSpki: "public key" });
    source.docs.set("users/here/devices/dHere", { encSpki: "public key" });
    source.docs.set("teams/t1/keyGrants/dGone", { uid: "gone", wrap: "wrapped key" });
    source.docs.set("teams/t1/keyGrants/dHere", { uid: "here", wrap: "wrapped key" });
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect(source.docs.has("users/gone/devices/dGone")).toBe(false);
    expect(source.docs.has("teams/t1/keyGrants/dGone")).toBe(false);
    expect(source.docs.has("users/here/devices/dHere")).toBe(true);
    expect(source.docs.has("teams/t1/keyGrants/dHere")).toBe(true);
    expect(source.docs.get("teams/t1")).toEqual({ name: "Team one", createdBy: "here", rotationPending: true });
    const lines = formatReport(report).join("\n");
    expect(lines).toContain("1 teams/{teamId}/keyGrants/{deviceId} of deleted accounts");
    expect(lines).toContain("1 teams/{teamId} marked rotation pending (not deleted)");
  });

  it("deletes a deleted account's grants and key requests in teams it had already left", async () => {
    const source = seed();
    source.docs.set("teams/t3", { name: "Left long ago" });
    source.docs.set("teams/t3/keyGrants/dGone", { uid: "gone", wrap: "wrapped key" });
    source.docs.set("teams/t3/keyRequests/dGone2", { uid: "gone", deviceId: "dGone2" });
    source.docs.set("teams/t1/keyRequests/dGone3", { uid: "gone", deviceId: "dGone3" });
    source.docs.set("teams/t3/keyRequests/dHere", { uid: "here", deviceId: "dHere" });
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    for (const path of ["teams/t3/keyGrants/dGone", "teams/t3/keyRequests/dGone2", "teams/t1/keyRequests/dGone3"]) expect(source.docs.has(path), path).toBe(false);
    expect(source.docs.has("teams/t3/keyRequests/dHere")).toBe(true);
    expect(source.docs.get("teams/t3")).toEqual({ name: "Left long ago", rotationPending: true });
    expect(formatReport(report).join("\n")).toContain("2 teams/{teamId}/keyRequests/{deviceId} of deleted accounts");
  });

  it("deletes a deleted account's beta tester entry, and keeps the entries of accounts that exist and the beta switch", async () => {
    const source = seed();
    source.docs.set("betaTesters/gone", { name: "Ada Lovelace" });
    source.docs.set("betaTesters/here", { name: "Grace Hopper" });
    source.docs.set("config/access", { betaOpen: false });
    const dry = await runCleanup(source, { now: NOW, dryRun: true });
    const dryLines = formatReport(dry);
    expect(dryLines).toContain("  betaTesters/gone");
    expect(dryLines).toContain("  1 betaTesters/{uid} of deleted accounts");
    expect(dryLines).toContain("  2 beta testers");
    expect(dryLines.join("\n")).not.toContain("Ada Lovelace");
    expect(source.docs.has("betaTesters/gone")).toBe(true);
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect(source.docs.has("betaTesters/gone")).toBe(false);
    expect(source.docs.get("betaTesters/here")).toEqual({ name: "Grace Hopper" });
    expect(source.docs.get("config/access")).toEqual({ betaOpen: false });
  });

  it("deletes a beta request after 30 days or with its account, and never logs the name or email", async () => {
    const source = seed();
    source.docs.set("betaRequests/gone", { name: "Ada Lovelace", email: "ada@example.org", createdAt: ago(2) });
    source.docs.set("betaRequests/here", { name: "Grace Hopper", email: "grace@example.org", createdAt: ago(2) });
    source.docs.set("betaRequests/lapsed", { name: "Old Request", createdAt: ago(31) });
    const dry = await runCleanup(source, { now: NOW, dryRun: true });
    const dryText = formatReport(dry).join("\n");
    expect(dryText).toContain("  betaRequests/gone");
    expect(dryText).toContain("  betaRequests/lapsed");
    expect(dryText).toContain("  2 betaRequests/{uid}");
    expect(dryText).toContain("  3 beta requests");
    for (const secret of ["Ada Lovelace", "ada@example.org", "Old Request"]) expect(dryText).not.toContain(secret);
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect(source.docs.has("betaRequests/gone")).toBe(false);
    expect(source.docs.has("betaRequests/lapsed")).toBe(false);
    expect(source.docs.get("betaRequests/here")).toMatchObject({ name: "Grace Hopper" });
  });

  it("marks every team before it deletes a grant, when one account's leftovers need more than one write", async () => {
    const source = seed();
    source.docs.set("teams/ta", { name: "A" });
    source.docs.set("teams/tb", { name: "B" });
    source.docs.set("teams/ta/members/gone", { role: "viewer" });
    source.docs.set("teams/tb/members/gone", { role: "viewer" });
    // The first write holds the expired share and invite. Then 396 grants in one team and one in
    // the other put the second team's only grant last in the next write of 400, with its mark, as
    // the plan used to order it, at the start of the write after that, which fails.
    for (let i = 0; i < 396; i++) source.docs.set(`teams/ta/keyGrants/d${String(i).padStart(3, "0")}`, { uid: "gone" });
    source.docs.set("teams/tb/keyGrants/dOnly", { uid: "gone" });
    source.failWrite = 2;
    const failed = await runCleanup(source, { now: NOW, dryRun: false });
    expect(failed.problems.join(" ")).toContain("Write 3 of");
    expect(source.docs.get("teams/tb")).toEqual({ name: "B", rotationPending: true });
    expect(source.docs.get("teams/ta")).toEqual({ name: "A", rotationPending: true });
    // The profile is deleted last, so the next run finds the account and deletes the rest.
    expect(source.docs.has("users/gone")).toBe(true);
    source.failWrite = null;
    const again = await runCleanup(source, { now: NOW, dryRun: false });
    expect(again.problems).toEqual([]);
    expect([...source.docs.keys()].filter((path) => path.includes("gone") || path.includes("/keyGrants/"))).toEqual([]);
  });

  it("never marks, and so never makes, a team that no longer exists", async () => {
    const source = seed();
    source.docs.set("teams/t1/keyGrants/dGone", { uid: "gone" });
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect(source.docs.has("teams/t1/keyGrants/dGone")).toBe(false);
    expect(source.docs.has("teams/t1")).toBe(false);
  });

  it("also deletes a request for more time made on a due share while the run was deleting", async () => {
    const source = seed();
    source.beforeFirstDelete = () => source.docs.set("shares/old/timeRequests/teamLate", { requestedBy: "here" });
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect(source.docs.has("shares/old/timeRequests/teamLate")).toBe(false);
    expect(report.deleted.map((d) => d.path)).toContain("shares/old/timeRequests/teamLate");
  });

  it("deletes nothing on a dry run", async () => {
    const source = seed();
    const before = [...source.docs.keys()];
    const report = await runCleanup(source, { now: NOW, dryRun: true });
    expect(source.deleted).toEqual([]);
    expect([...source.docs.keys()]).toEqual(before);
    expect(report.deleted).toEqual([]);
    expect(report.writes).toEqual({ planned: 1, sent: 0 });
  });

  it("stops at a failed write and reports it for the next run", async () => {
    const source = seed();
    source.failWrite = 0;
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.deleted).toEqual([]);
    expect(report.problems.join(" ")).toContain("Write 1 of 1 failed (PERMISSION_DENIED");
    expect(report.problems.join(" ")).toContain("the next run deletes what is left");
  });

  it("deletes nothing tied to accounts when sign-in cannot be checked, and still cleans shares", async () => {
    const source = seed();
    source.failAccounts = true;
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(source.docs.has("users/gone")).toBe(true);
    expect(source.docs.has("shares/old")).toBe(false);
    expect(report.accountsChecked).toBeNull();
    expect(report.problems.join(" ")).toContain("Sign-in could not be checked");
  });

  it("deletes bug reports that are due and those of deleted accounts, reading no report's text", async () => {
    const source = seed();
    source.docs.set("bugReports/rOld", { reporter: "here", status: "new", createdAt: ago(95), whatHappened: "Secret words." });
    source.docs.set("bugReports/rGone", { reporter: "gone", status: "new", createdAt: ago(2), whatHappened: "Secret words." });
    source.docs.set("bugReports/rKept", { reporter: "here", status: "triaged", createdAt: ago(2), updatedAt: ago(1), whatHappened: "Secret words." });
    const queries: RestQuery[] = [];
    const query = source.query.bind(source);
    source.query = (q) => {
      queries.push(q);
      return query(q);
    };
    const report = await runCleanup(source, { now: NOW, dryRun: false });
    expect(report.problems).toEqual([]);
    expect([...source.docs.keys()].filter((path) => path.startsWith("bugReports/"))).toEqual(["bugReports/rKept"]);
    const reportQuery = queries.find((q) => q.collection === "bugReports");
    expect(reportQuery?.select).not.toContain("whatHappened");
    expect(formatReport(report).join("\n")).toContain("2 bugReports/{id}");
  });

  it("logs ids and counts only, never a field of a document", async () => {
    for (const dryRun of [true, false]) {
      const lines = formatReport(await runCleanup(seed(), { now: NOW, dryRun })).join("\n");
      for (const secret of ["Ada", "Lovelace", "Grace", "auto content", "diff content", "next-event", "queue.list"]) {
        expect(lines).not.toContain(secret);
      }
      expect(lines).toContain("1 shares/{id}");
      expect(lines).toContain("1 users/{uid} of deleted accounts");
      if (dryRun) expect(lines).toContain("  teams/t1/members/gone");
    }
  });
});

describe("retention clean-up command line", () => {
  it("parses its options", () => {
    expect(parseArgs(["--", "--dry-run"])).toEqual({ dryRun: true, project: null, now: null, help: false });
    expect(parseArgs(["--project", "demo-x", "--now", "2026-01-01T00:00:00Z"]).now?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(() => parseArgs(["--delete-everything"])).toThrow(UsageError);
    expect(() => parseArgs(["--now", "yesterday"])).toThrow(UsageError);
    expect(() => parseArgs(["--project"])).toThrow(UsageError);
  });

  it("says it is not configured, and exits 2, when there is no key and no emulator", async () => {
    const lines: string[] = [];
    const status = await main(["--dry-run"], {}, (line) => lines.push(line));
    expect(status).toBe(2);
    expect(lines).toEqual(["Clean-up is not configured: ZENITH_FIREBASE_SERVICE_ACCOUNT is not set. Nothing was read or deleted."]);
  });

  it("refuses --now against the real project", () => {
    expect(() => resolveTarget({ ZENITH_FIREBASE_SERVICE_ACCOUNT: "{}" }, parseArgs(["--now", "2030-01-01T00:00:00Z"]))).toThrow(/emulators only/);
  });

  it("needs both emulator hosts and a project", () => {
    expect(() => resolveTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:1" }, parseArgs(["--project", "demo-x"]))).toThrow(/both/);
    expect(() => resolveTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:1", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:2" }, parseArgs([]))).toThrow(/--project/);
  });

  it("uses the key's project, and refuses a --project that differs", () => {
    const key = JSON.stringify({ project_id: "zenith-abc", client_email: "clean-up@example.com", private_key: "not-a-real-key" });
    expect(resolveTarget({ ZENITH_FIREBASE_SERVICE_ACCOUNT: key }, parseArgs([])).target.projectId).toBe("zenith-abc");
    expect(() => resolveTarget({ ZENITH_FIREBASE_SERVICE_ACCOUNT: key }, parseArgs(["--project", "other"]))).toThrow(UsageError);
  });

  it("reports a malformed key without quoting any of it", () => {
    const text = '{"project_id": "zenith-abc", "private_key": "fragment-that-must-not-print" ';
    let message = "";
    try {
      readServiceAccount(text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("is not valid JSON");
    expect(message).not.toContain("fragment");
    expect(() => readServiceAccount('{"project_id":"x"}')).toThrow(/needs project_id, client_email and private_key/);
  });
});
