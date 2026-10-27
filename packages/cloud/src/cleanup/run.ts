/**
 * One run of the retention clean-up: read what might be due, decide with `planCleanup`, and delete
 * in writes of at most DELETES_PER_WRITE documents. The time comes in from the caller.
 *
 * The reads are narrowed to what can be due, so a daily run costs a few reads, not one per document
 * in the database: shares and invites that ended before the cutoff by expiry or by revocation, what
 * hangs under those shares, every bug report (its reporter, status and times only, never its text),
 * and, for the accounts check, every profile, membership, admin and beta tester (selected by path
 * only).
 * `planCleanup` then decides every deletion from that snapshot again.
 *
 * Profiles and memberships are read before sign-in is asked about their accounts. So an account made
 * during the run cannot be taken for a deleted one: a profile exists only after its sign-in account
 * does, and sign-in is asked afterwards. Then, for the accounts sign-in no longer has, their devices,
 * and their grants and key requests in every team, found by uid with collection-group queries (so
 * teams the account had already left are covered too), are read, with whether each team a grant is
 * in still exists, so a team that loses a grant can be marked "rotation pending" without ever
 * creating one.
 */
import {
  accountIdsIn,
  countByKind,
  isAllowedWrite,
  isDeletablePath,
  packWrites,
  planCleanup,
  plannedDeletes,
  retentionCutoff,
  CLEANUP_KINDS,
  DELETES_PER_WRITE,
  INVITE_REVOKE_KIND,
  type AccountCheck,
  type CleanupKind,
  type CleanupPlan,
  type PlannedDelete,
  type SnapshotDoc,
} from "./plan.js";
import type { RestQuery } from "./rest.js";

/** What the runner needs from the database and sign-in. `AdminRest` is the real one. */
export interface CleanupSource {
  query(query: RestQuery): Promise<SnapshotDoc[]>;
  /**
   * Deletes `paths` and sets `rotationPending: true` on each team document in `rotations`, in one
   * atomic write. A rotation mark on a team that does not exist fails the whole write.
   */
  deleteAll(paths: readonly string[], rotations?: readonly string[]): Promise<void>;
  existingAccounts(uids: readonly string[]): Promise<Set<string>>;
  /** Which of the document paths exist. */
  existingDocuments(paths: readonly string[]): Promise<Set<string>>;
}

export interface CleanupOptions {
  now: Date;
  /** Read and decide, and delete nothing. */
  dryRun: boolean;
}

/** The names the summary uses for each kind of delete. */
export const KIND_LABELS: Record<CleanupKind, string> = {
  share: "shares/{id}",
  timeRequest: "shares/{id}/timeRequests/{teamId}",
  proposal: "proposals/{id}",
  invite: "invites/{code}",
  profile: "users/{uid} of deleted accounts",
  membership: "teams/{teamId}/members/{uid} of deleted accounts",
  device: "users/{uid}/devices/{deviceId} of deleted accounts",
  grant: "teams/{teamId}/keyGrants/{deviceId} of deleted accounts",
  keyRequest: "teams/{teamId}/keyRequests/{deviceId} of deleted accounts",
  betaTester: "betaTesters/{uid} of deleted accounts",
  betaRequest: "betaRequests/{uid}",
  bugReport: "bugReports/{id}",
  rotation: "teams/{teamId} marked rotation pending (not deleted)",
};

export interface CleanupReport {
  now: Date;
  cutoff: Date;
  dryRun: boolean;
  /** Documents read, by what they were read for. */
  read: { label: string; count: number }[];
  /** Account ids sign-in was asked about, or null when the check failed. */
  accountsChecked: number | null;
  plan: CleanupPlan;
  /** What was deleted; empty on a dry run. */
  deleted: PlannedDelete[];
  /** Writes planned, and writes sent successfully. */
  writes: { planned: number; sent: number };
  /** What went wrong, as sentences with statuses and ids only. A run with problems exits non-zero. */
  problems: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeByPath(...lists: SnapshotDoc[][]): SnapshotDoc[] {
  const byPath = new Map<string, SnapshotDoc>();
  for (const list of lists) for (const doc of list) byPath.set(doc.path, doc);
  return [...byPath.values()];
}

/** A single path segment from a document field, or null when it is not one. */
function segment(value: unknown): string | null {
  return typeof value === "string" && value !== "" && !value.includes("/") ? value : null;
}

/** Reads everything the plan needs, in the order the module comment explains. */
export async function loadSnapshot(source: CleanupSource, now: Date): Promise<{ docs: SnapshotDoc[]; read: { label: string; count: number }[] }> {
  const cutoff = retentionCutoff(now);
  const read: { label: string; count: number }[] = [];
  const docs: SnapshotDoc[] = [];
  const take = (label: string, list: SnapshotDoc[]) => {
    read.push({ label, count: list.length });
    docs.push(...list);
  };

  // Shares that ended before the cutoff, by expiry or by revocation, and what hangs under them.
  const shareFields = ["expiresAt", "revokedAt"];
  const shares = mergeByPath(
    await source.query({ parent: "", collection: "shares", where: [{ field: "expiresAt", op: "LESS_THAN", value: cutoff }], select: shareFields }),
    await source.query({ parent: "", collection: "shares", where: [{ field: "revokedAt", op: "LESS_THAN", value: cutoff }], select: shareFields }),
  );
  take("shares that ended before the cutoff", shares);
  const timeRequests: SnapshotDoc[] = [];
  const proposals: SnapshotDoc[] = [];
  for (const share of shares) {
    const shareId = share.path.slice("shares/".length);
    timeRequests.push(...(await source.query({ parent: share.path, collection: "timeRequests", select: [] })));
    proposals.push(...(await source.query({ parent: "", collection: "proposals", where: [{ field: "shareId", op: "EQUAL", value: shareId }], select: ["shareId"] })));
  }
  take("requests for more time on those shares", timeRequests);
  take("proposals on those shares", proposals);

  // Invites that ended before the cutoff by expiry, and revoked ones with the time of revocation.
  const inviteFields = ["teamId", "expiresAt", "revoked"];
  const expiredInvites = await source.query({ parent: "", collection: "invites", where: [{ field: "expiresAt", op: "LESS_THAN", value: cutoff }], select: inviteFields });
  const revokedInvites = await source.query({ parent: "", collection: "invites", where: [{ field: "revoked", op: "EQUAL", value: true }], select: inviteFields });
  const invites = mergeByPath(expiredInvites, revokedInvites);
  take("invites that expired before the cutoff or were revoked", invites);
  const expiredPaths = new Set(expiredInvites.map((doc) => doc.path));
  const revocations: SnapshotDoc[] = [];
  for (const invite of revokedInvites) {
    if (expiredPaths.has(invite.path)) continue;
    const teamId = segment(invite.data.teamId);
    if (teamId === null) continue;
    const code = invite.path.slice("invites/".length);
    const entries = await source.query({
      parent: `teams/${teamId}`,
      collection: "activity",
      where: [{ field: "target", op: "EQUAL", value: code }],
      select: ["kind", "target", "at"],
    });
    revocations.push(...entries.filter((entry) => entry.data.kind === INVITE_REVOKE_KIND));
  }
  take("activity entries recording those revocations", revocations);

  // Every bug report, by the fields that decide when it is due and whose it is. There are few, and a
  // report of a deleted account is due whatever its age, so none can be left unread.
  take("bug reports", await source.query({ parent: "", collection: "bugReports", select: ["reporter", "status", "createdAt", "updatedAt"] }));

  // Everything tied to an account id, by path only.
  take("profiles", await source.query({ parent: "", collection: "users", select: [] }));
  take("team memberships", await source.query({ parent: "", collection: "members", allDescendants: true, select: [] }));
  take("Horizon admins", await source.query({ parent: "", collection: "admins", select: [] }));
  take("beta testers", await source.query({ parent: "", collection: "betaTesters", select: [] }));
  // Every beta request, by when it was sent: one is due after 30 days, or with its account.
  take("beta requests", await source.query({ parent: "", collection: "betaRequests", select: ["createdAt"] }));
  return { docs, read };
}

/**
 * What deleted accounts left besides their profile and memberships: each one's device records, and
 * in every team, whether or not it is still a member, its devices' grants and its key requests, with
 * the document of each team a grant is in when that team exists.
 */
export async function loadAccountLeftovers(
  source: CleanupSource,
  gone: ReadonlySet<string>,
): Promise<{ docs: SnapshotDoc[]; read: { label: string; count: number }[] }> {
  const devices: SnapshotDoc[] = [];
  const grants: SnapshotDoc[] = [];
  const requests: SnapshotDoc[] = [];
  const teamPaths = new Set<string>();
  for (const uid of [...gone].sort()) {
    const id = segment(uid);
    if (id === null) continue;
    devices.push(...(await source.query({ parent: `users/${id}`, collection: "devices", select: [] })));
    const byUid = [{ field: "uid", op: "EQUAL" as const, value: uid }];
    for (const grant of await source.query({ parent: "", collection: "keyGrants", allDescendants: true, where: byUid, select: ["uid"] })) {
      const s = grant.path.split("/");
      if (s.length !== 4 || s[0] !== "teams" || s[2] !== "keyGrants") continue;
      grants.push(grant);
      teamPaths.add(`teams/${s[1] ?? ""}`);
    }
    requests.push(...(await source.query({ parent: "", collection: "keyRequests", allDescendants: true, where: byUid, select: ["uid"] })));
  }
  const existing = teamPaths.size === 0 ? new Set<string>() : await source.existingDocuments([...teamPaths].sort());
  const teams = [...teamPaths].filter((path) => existing.has(path)).map((path) => ({ path, data: {} }));
  return {
    docs: [...devices, ...grants, ...requests, ...teams],
    read: [
      { label: "device records of deleted accounts", count: devices.length },
      { label: "key grants of deleted accounts", count: grants.length },
      { label: "key requests of deleted accounts", count: requests.length },
      { label: "teams those grants are in, that still exist", count: teams.length },
    ],
  };
}

/** Reads, decides and, unless it is a dry run, deletes. Never throws for a failed write; see `problems`. */
export async function runCleanup(source: CleanupSource, options: CleanupOptions): Promise<CleanupReport> {
  const { now, dryRun } = options;
  const problems: string[] = [];
  const { docs, read } = await loadSnapshot(source, now);

  const uids = accountIdsIn(docs);
  let accounts: AccountCheck | null = null;
  try {
    accounts = { checked: new Set(uids), existing: await source.existingAccounts(uids) };
  } catch (error) {
    problems.push(`Sign-in could not be checked (${errorText(error)}), so nothing tied to an account was deleted.`);
  }
  if (accounts !== null) {
    const known = accounts;
    const gone = new Set(uids.filter((uid) => !known.existing.has(uid)));
    // Every account gone at once is a misconfigured check, which the plan refuses; nothing to read.
    if (gone.size > 0 && gone.size < uids.length) {
      try {
        const leftovers = await loadAccountLeftovers(source, gone);
        docs.push(...leftovers.docs);
        read.push(...leftovers.read);
      } catch (error) {
        problems.push(`What deleted accounts left could not be read (${errorText(error)}), so nothing tied to an account was deleted.`);
        accounts = null;
      }
    }
  }

  const plan = planCleanup({ docs, now, accounts });
  const writes = packWrites(plan);
  const deleted: PlannedDelete[] = [];
  let sent = 0;
  if (!dryRun) {
    for (const [index, write] of writes.entries()) {
      const refused = write.find((entry) => !isAllowedWrite(entry));
      if (refused !== undefined) {
        problems.push(`Refused to write ${refused.path}: the clean-up never writes documents at that path. Nothing more was deleted.`);
        break;
      }
      try {
        const deletes = write.filter((entry) => entry.kind !== "rotation").map((entry) => entry.path);
        const rotations = write.filter((entry) => entry.kind === "rotation").map((entry) => entry.path);
        await source.deleteAll(deletes, rotations);
      } catch (error) {
        problems.push(
          `Write ${String(index + 1)} of ${String(writes.length)} failed (${errorText(error)}). Nothing after it was sent; the next run deletes what is left.`,
        );
        break;
      }
      sent += 1;
      deleted.push(...write);
    }
    // A team may ask for more time on an expired share in the moment between the read above and
    // the share's delete. Once the share is gone the rules refuse any new request, so one more look
    // under each deleted share finds every such straggler.
    if (problems.length === 0) {
      try {
        const stragglers: PlannedDelete[] = [];
        for (const entry of deleted) {
          if (entry.kind !== "share") continue;
          for (const doc of await source.query({ parent: entry.path, collection: "timeRequests", select: [] })) {
            stragglers.push({ kind: "timeRequest", path: doc.path });
          }
        }
        for (let start = 0; start < stragglers.length; start += DELETES_PER_WRITE) {
          const write = stragglers.slice(start, start + DELETES_PER_WRITE).filter((entry) => isDeletablePath(entry.path));
          await source.deleteAll(write.map((entry) => entry.path));
          deleted.push(...write);
        }
      } catch (error) {
        problems.push(`The last look for requests for more time under deleted shares failed (${errorText(error)}).`);
      }
    }
  }
  return {
    now,
    cutoff: retentionCutoff(now),
    dryRun,
    read,
    accountsChecked: accounts === null ? null : uids.length,
    plan,
    deleted,
    writes: { planned: writes.length, sent },
    problems,
  };
}

/**
 * The run's log. Collection names, document ids and counts only: no field of any document, no email
 * address, no name, no auto content. A dry run lists every path it would delete.
 */
export function formatReport(report: CleanupReport): string[] {
  const lines: string[] = [];
  const mode = report.dryRun ? "dry run: nothing is deleted" : "deleting";
  lines.push(`Retention clean-up at ${report.now.toISOString()} (${mode}). Ended before ${report.cutoff.toISOString()} is due.`);
  lines.push("Read:");
  for (const { label, count } of report.read) lines.push(`  ${String(count)} ${label}`);
  lines.push(
    report.accountsChecked === null ? "  sign-in: not checked" : `  sign-in: checked ${String(report.accountsChecked)} account ids`,
  );

  const planned = plannedDeletes(report.plan);
  const isDelete = (entry: PlannedDelete) => entry.kind !== "rotation";
  if (report.dryRun) {
    const deletes = planned.filter(isDelete).length;
    const marks = planned.length - deletes;
    const also = marks === 0 ? "" : `, and would mark ${String(marks)} team${marks === 1 ? "" : "s"} rotation pending`;
    lines.push(planned.length === 0 ? "Would delete nothing." : `Would delete ${String(deletes)} documents${also}:`);
    for (const entry of planned) lines.push(isDelete(entry) ? `  ${entry.path}` : `  ${entry.path} (marked rotation pending, not deleted)`);
  }
  const counts = countByKind(report.dryRun ? planned : report.deleted);
  lines.push(report.dryRun ? "Summary of what would be deleted:" : "Summary of what was deleted:");
  for (const kind of CLEANUP_KINDS) lines.push(`  ${String(counts[kind])} ${KIND_LABELS[kind]}`);
  // Deleted documents only: a team marked rotation pending is counted on its own line above.
  const total = (report.dryRun ? planned : report.deleted).filter(isDelete).length;
  const writes = report.dryRun
    ? `${String(report.writes.planned)} write${report.writes.planned === 1 ? "" : "s"}`
    : `${String(report.writes.sent)} of ${String(report.writes.planned)} planned writes`;
  lines.push(`  ${String(total)} in all, in ${writes}`);

  if (report.plan.staleAdmins.length > 0) {
    lines.push(
      `Kept for the admins: ${String(report.plan.staleAdmins.length)} admins/{uid} documents whose account no longer exists (remove them on the review page, Beta access, as cloud/README.md step 6 says): ${report.plan.staleAdmins.join(", ")}`,
    );
  }
  for (const notice of report.plan.notices) lines.push(`Note: ${notice}`);
  for (const problem of report.problems) lines.push(`Problem: ${problem}`);
  return lines;
}
