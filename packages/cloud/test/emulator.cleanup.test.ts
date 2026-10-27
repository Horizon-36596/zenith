/**
 * The retention clean-up against the Firestore and Auth emulators: the real REST calls, a real run
 * over seeded data, and the command line as the workflow runs it. A run must delete exactly the
 * documents the retention policy says are due and nothing else, a dry run must delete nothing, and
 * the log must carry no personal data. Runs under `pnpm test:rules`, which starts both emulators;
 * skipped, saying so, otherwise.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRest } from "../src/cleanup/rest.js";
import { formatReport, runCleanup } from "../src/cleanup/run.js";
import type { DocData, Write } from "../src/store.js";
import { EMULATOR_HOST, startEmulatorEnvironment, storeOf } from "./emulatorHarness.js";

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PROJECT = "demo-zenith-cleanup";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const NOW = new Date("2026-09-28T04:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const share = (expiresAt: Date, revokedAt: Date | null, extra: DocData = {}): DocData => ({
  ownerTeamId: "tA",
  autoId: "a1",
  audience: "teams",
  teamIds: ["tB"],
  level: "propose",
  mode: "pinned",
  revision: "000001-abc",
  expiresAt,
  revokedAt,
  createdBy: "here",
  createdAt: ago(60),
  updatedAt: ago(60),
  projection: '{"auto":"Secret Auto Name"}',
  ...extra,
});
const invite = (expiresAt: Date, revoked: boolean): DocData => ({
  teamId: "tA",
  role: "editor",
  expiresAt,
  maxUses: 1,
  uses: 0,
  autoApprove: false,
  createdBy: "here",
  createdAt: ago(60),
  revoked,
});

/** Due: the retention policy says these go. */
const DUE: Record<string, DocData> = {
  "shares/expired31": share(ago(31), null),
  "shares/expired31/timeRequests/tB": { shareId: "expired31", teamId: "tB", ownerTeamId: "tA", requestedBy: "gone", requestedAt: ago(32), status: "open", reason: "next-event" },
  "shares/expired31/timeRequests/tC": { shareId: "expired31", teamId: "tC", ownerTeamId: "tA", requestedBy: "here", requestedAt: ago(33), status: "declined" },
  "proposals/propOld1": { shareId: "expired31", ownerTeamId: "tA", autoId: "a1", fromTeamId: "tB", baseRevision: "000001-abc", diff: '{"note":"Secret Diff"}', status: "open", createdBy: "gone", createdAt: ago(40) },
  "proposals/propOld2": { shareId: "expired31", ownerTeamId: "tA", autoId: "a1", fromTeamId: "tB", baseRevision: "000001-abc", diff: "{}", status: "rejected", createdBy: "gone", createdAt: ago(40) },
  "shares/revoked45": share(ahead(300), ago(45)),
  "invites/expired31": invite(ago(31), false),
  "invites/revokedLongAgo": invite(ahead(20), true),
  "users/gone": { displayName: "Ada Lovelace", createdAt: ago(200) },
  // The private beta tester entry the owner made for the gone account in the console.
  "betaTesters/gone": { name: "Ada Lovelace" },
  "teams/tA/members/gone": { uid: "gone", teamId: "tA", role: "viewer", displayName: "Ada Lovelace", joinedAt: ago(200) },
  "teams/tB/members/gone": { uid: "gone", teamId: "tB", role: "pending", displayName: "Ada Lovelace", joinedAt: ago(100) },
  "users/gone/devices/dGone": { v: 1, encSpki: "public key", createdAt: ago(200) },
  "teams/tA/keyGrants/dGone": { v: 1, teamId: "tA", deviceId: "dGone", uid: "gone", kv: 1, createdAt: ago(200) },
  // Team tB has no team document: its grant goes, and no mark is written, so no team is made.
  "teams/tB/keyGrants/dGone": { v: 1, teamId: "tB", deviceId: "dGone", uid: "gone", kv: 1, createdAt: ago(100) },
  // A team the gone account had left before it was deleted, found by a collection-group query.
  "teams/tC/keyGrants/dGone": { v: 1, teamId: "tC", deviceId: "dGone", uid: "gone", kv: 1, createdAt: ago(250) },
  "teams/tA/keyRequests/dGone2": { uid: "gone", deviceId: "dGone2", createdAt: ago(150) },
  "teams/tC/keyRequests/dGone3": { uid: "gone", deviceId: "dGone3", createdAt: ago(250) },
  // Bug reports: one sent more than 90 days ago, one closed more than 30 days ago, and one by the gone account.
  "bugReports/reportOld": { reporter: "here", status: "triaged", createdAt: ago(91), whatHappened: "Secret Report Text" },
  "bugReports/reportClosed": { reporter: "here", status: "closed", createdAt: ago(40), updatedAt: ago(31), updatedBy: "here", whatHappened: "Secret Report Text" },
  "bugReports/reportGone": { reporter: "gone", status: "new", createdAt: ago(2), whatHappened: "Secret Report Text" },
};

/** Kept: everything else, including the 30-day boundary and what the policy keeps for good. */
const KEPT: Record<string, DocData> = {
  "shares/live": share(ahead(7), null),
  "shares/live/timeRequests/tB": { shareId: "live", teamId: "tB", ownerTeamId: "tA", requestedBy: "here", requestedAt: ago(1), status: "open" },
  "proposals/propLive": { shareId: "live", ownerTeamId: "tA", autoId: "a1", fromTeamId: "tB", baseRevision: "000001-abc", diff: "{}", status: "open", createdBy: "here", createdAt: ago(1) },
  "shares/revoked29": share(ahead(3), ago(29)),
  "shares/exactly30": share(ago(30), null),
  "shares/deletedTeamShare": share(ahead(4), ago(10), { ownerTeamId: "tDel" }),
  "invites/expired29": invite(ago(29), false),
  "invites/exactly30": invite(ago(30), false),
  "invites/revokedRecently": invite(ahead(20), true),
  "invites/revokedUndated": invite(ahead(20), true),
  "invites/live": invite(ahead(7), false),
  "teams/tA": { number: 12345, name: "Team A", status: "unverified", createdBy: "here", createdAt: ago(300) },
  "teams/tA/activity/revokeOld": { at: ago(31), by: "here", kind: "invite.revoke", target: "revokedLongAgo" },
  "teams/tA/activity/revokeNew": { at: ago(5), by: "here", kind: "invite.revoke", target: "revokedRecently" },
  "teams/tA/activity/shareRevoke": { at: ago(45), by: "gone", kind: "share.revoke", target: "revoked45" },
  "teams/tA/autos/a1": { title: "Secret Auto Name", createdBy: "gone", createdAt: ago(300), updatedAt: ago(300) },
  "teams/tA/autos/a1/revisions/000001-abc": { n: 1, baseRevision: null, author: "gone", createdAt: ago(300), content: "{}", diverged: false },
  "teams/tA/settings/sharing": { editorsMayProposeShare: true },
  "teams/tA/members/here": { uid: "here", teamId: "tA", role: "owner", displayName: "Grace Hopper", joinedAt: ago(300) },
  "teams/tB/inbox/expired31": { shareId: "expired31", ownerTeamId: "tA", createdBy: "here", createdAt: ago(60) },
  "users/here": { displayName: "Grace Hopper", createdAt: ago(300) },
  "users/here/devices/dHere": { v: 1, encSpki: "public key", createdAt: ago(300) },
  "teams/tA/keyGrants/dHere": { v: 1, teamId: "tA", deviceId: "dHere", uid: "here", kv: 1, createdAt: ago(300) },
  "teams/tA/keyRequests/dHere2": { uid: "here", deviceId: "dHere2", createdAt: ago(3) },
  "admins/here": { name: "Grace Hopper" },
  "admins/goneAdmin": { name: "Former Admin" },
  "betaTesters/here": { name: "Grace Hopper" },
  "config/access": { betaOpen: true },
  "deletedTeams/tDel": { deletedBy: "gone", deletedAt: ago(100) },
  "claims/12345": { teamId: null, status: "unverified", claimedAt: ago(300), historyCount: 2, disputeId: null, requestId: null },
  "claims/12345/history/0": { kind: "claim", teamId: "tDel", otherTeamId: null, by: "gone", at: ago(300) },
  "claims/12345/history/1": { kind: "release", teamId: "tDel", otherTeamId: null, by: "gone", at: ago(100) },
  "adminLog/entry1": { by: "here", at: ago(400), action: "share.preview", target: "revoked45" },
  "disputes/d1": { teamNumber: 12345, holderTeamId: "tDel", challengerTeamId: "tA", openedBy: "here", createdAt: ago(500), status: "final" },
  "verifications/v1": { teamNumber: 12345, teamId: "tA", requestedBy: "here", createdAt: ago(500), status: "decided" },
  "bugReports/reportNew": { reporter: "here", status: "new", createdAt: ago(89), whatHappened: "Secret Report Text" },
  "bugReports/reportClosed29": { reporter: "here", status: "closed", createdAt: ago(40), updatedAt: ago(29), updatedBy: "here", whatHappened: "Secret Report Text" },
};

/** Accounts sign-in still has. `gone` and `goneAdmin` were deleted. */
const LIVE_ACCOUNTS = [{ localId: "here", email: "grace.hopper@example.org", displayName: "Grace Hopper" }];

const PERSONAL = ["Ada", "Lovelace", "Grace", "Hopper", "grace.hopper@example.org", "Former Admin", "Secret Auto Name", "Secret Diff", "next-event", "Secret Report Text"];

async function authRequest(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`http://${AUTH_HOST ?? ""}${path}`, {
    ...init,
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`Auth emulator ${path}: HTTP ${String(response.status)}`);
}

if (EMULATOR_HOST === undefined || AUTH_HOST === undefined) {
  describe("retention clean-up (emulators)", () => {
    it.skip("Clean-up emulator tests skipped: run `pnpm test:rules` to start the Firestore and Auth emulators.", () => undefined);
  });
} else {
  let env: RulesTestEnvironment | undefined;
  const environment = () => {
    if (env === undefined) throw new Error("The emulator environment did not start.");
    return env;
  };
  const rest = new AdminRest({
    projectId: PROJECT,
    firestoreOrigin: `http://${EMULATOR_HOST}`,
    identityOrigin: `http://${AUTH_HOST}/identitytoolkit.googleapis.com`,
    token: () => Promise.resolve("owner"),
  });

  async function seed(docs: Record<string, DocData>): Promise<void> {
    await environment().clearFirestore();
    await environment().withSecurityRulesDisabled(async (ctx) => {
      const writes: Write[] = Object.entries(docs).map(([path, data]) => ({ op: "set", path, data }));
      for (let i = 0; i < writes.length; i += 400) await storeOf(ctx.firestore()).commit(writes.slice(i, i + 400)).sent;
    });
    await authRequest(`/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
    for (const account of LIVE_ACCOUNTS) {
      await authRequest(`/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { method: "POST", body: JSON.stringify(account) });
    }
  }

  async function existing(paths: string[]): Promise<string[]> {
    const found: string[] = [];
    await environment().withSecurityRulesDisabled(async (ctx) => {
      const store = storeOf(ctx.firestore());
      for (const path of paths) if ((await store.get(path)) !== null) found.push(path);
    });
    return found.sort();
  }

  const all = [...Object.keys(DUE), ...Object.keys(KEPT)];

  beforeAll(async () => {
    env = await startEmulatorEnvironment(PROJECT);
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  describe("retention clean-up (emulators)", () => {
    beforeEach(async () => {
      await seed({ ...DUE, ...KEPT });
    });

    it("sees exactly which accounts sign-in still has", async () => {
      expect([...(await rest.existingAccounts(["here", "gone", "goneAdmin"]))]).toEqual(["here"]);
      expect([...(await rest.existingAccounts(["gone"]))]).toEqual([]);
    });

    it("deletes nothing on a dry run, and lists exactly what is due", async () => {
      const report = await runCleanup(rest, { now: NOW, dryRun: true });
      expect(report.problems).toEqual([]);
      expect(await existing(all)).toEqual([...all].sort());
      const lines = formatReport(report);
      const listed = lines.filter((line) => /^ {2}[A-Za-z]+\/\S+$/.test(line)).map((line) => line.trim());
      expect(listed.sort()).toEqual(Object.keys(DUE).sort());
      expect(report.plan.staleAdmins).toEqual(["goneAdmin"]);
    });

    it("deletes exactly what is due and keeps everything else, and a second run deletes nothing", async () => {
      const report = await runCleanup(rest, { now: NOW, dryRun: false });
      expect(report.problems).toEqual([]);
      expect(report.deleted.filter((d) => d.kind !== "rotation").map((d) => d.path).sort()).toEqual(Object.keys(DUE).sort());
      expect(report.deleted.filter((d) => d.kind === "rotation").map((d) => d.path)).toEqual(["teams/tA"]);
      expect(await existing(all)).toEqual(Object.keys(KEPT).sort());
      // Team A lost a grant of the gone account's, so its owners are asked to rotate; team B was not made.
      await environment().withSecurityRulesDisabled(async (ctx) => {
        const store = storeOf(ctx.firestore());
        expect(await store.get("teams/tA")).toMatchObject({ name: "Team A", rotationPending: true });
        expect(await store.get("teams/tB")).toBeNull();
      });

      const again = await runCleanup(rest, { now: NOW, dryRun: false });
      expect(again.deleted).toEqual([]);
      expect(again.problems).toEqual([]);
    });

    it("runs from the command line as the workflow does, and prints no personal data", () => {
      const run = (extra: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", "packages/cloud/src/cleanup/cli.ts", "--project", PROJECT, "--now", NOW.toISOString(), ...extra], {
          cwd: REPO,
          encoding: "utf8",
          env: { ...process.env, ZENITH_FIREBASE_SERVICE_ACCOUNT: "" },
        });
      const dry = run(["--dry-run"]);
      expect(dry.status, dry.stdout + dry.stderr).toBe(0);
      expect(dry.stdout).toContain(`Would delete ${String(Object.keys(DUE).length)} documents, and would mark 1 team rotation pending:`);
      const real = run([]);
      expect(real.status, real.stdout + real.stderr).toBe(0);
      expect(real.stdout).toContain(`${String(Object.keys(DUE).length)} in all`);
      for (const output of [dry.stdout + dry.stderr, real.stdout + real.stderr]) {
        for (const secret of PERSONAL) expect(output).not.toContain(secret);
      }
    });
  });

  describe("retention clean-up (emulators, many documents)", () => {
    it("deletes more than one write's worth, in writes of at most 400", async () => {
      const many: Record<string, DocData> = { "invites/keep": invite(ahead(7), false) };
      for (let i = 0; i < 450; i += 1) many[`invites/old${String(i).padStart(3, "0")}`] = invite(ago(40), false);
      await seed(many);
      const report = await runCleanup(rest, { now: NOW, dryRun: false });
      expect(report.problems).toEqual([]);
      expect(report.writes).toEqual({ planned: 2, sent: 2 });
      expect(report.deleted).toHaveLength(450);
      expect(await existing(Object.keys(many))).toEqual(["invites/keep"]);
    });
  });
}
