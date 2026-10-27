/**
 * What the daily retention clean-up deletes, decided from a snapshot of documents and the time the
 * runner passes in. Pure: no clock, no network, no randomness, so every rule here is unit-tested with
 * a fixed `now`.
 *
 * It keeps the deletions the public retention policy (the docs site's Retention policy page, and spec
 * 13 section 12.4) promises, and nothing else:
 * - a share that ended (expired or revoked) more than 30 days ago, with the requests for more time
 *   under it and the proposals sent on it;
 * - an invite that ended (expired or revoked) more than 30 days ago;
 * - what is left of an account that no longer exists in sign-in: its profile, its team memberships,
 *   its devices' public keys, its devices' grants of team keys and its requests for them, in every
 *   team, including teams it had already left, its entry in the private beta's tester list
 *   (`betaTesters/{uid}`, which holds the name an admin typed) and its request for beta access
 *   (`betaRequests/{uid}`, which holds the name and email it sent). A team that loses a grant this way is marked
 *   "rotation pending" before any of it is deleted, so its owners and admins make a new key that the
 *   gone account's devices never held;
 * - a bug report 30 days after a Horizon admin closed it, or 90 days after it was sent, whichever
 *   comes first, and every bug report of an account that no longer exists in sign-in;
 * - a request for beta access that nobody decided within BETA_REQUEST_MAX_DAYS of being sent.
 *
 * Only documents at those paths can ever be deleted; `isDeletablePath` is the whole list. The one
 * other write is `{ rotationPending: true }` on `teams/{teamId}` (`isRotationPath`), and only on a
 * team that exists. Everything the policy keeps (team libraries, activity logs, inboxes, tombstones in
 * `deletedTeams`, team-number claims and their history, verification requests, disputes, the Horizon
 * admin log) is never at one of those paths, so it is kept whatever the snapshot says.
 */

/** A document as the runner read it: its path and only the fields the plan reads. Times are `Date`. */
export interface SnapshotDoc {
  /** The path from the database root, for example `shares/abc` or `teams/t1/members/uid1`. */
  path: string;
  data: Readonly<Record<string, unknown>>;
}

/** What sign-in said about the account ids the runner asked it about. */
export interface AccountCheck {
  /** Every account id the runner asked about. An id not in here is never treated as deleted. */
  checked: ReadonlySet<string>;
  /** Those of them that still have a sign-in account. */
  existing: ReadonlySet<string>;
}

export interface CleanupInput {
  docs: readonly SnapshotDoc[];
  /** The time of the run. The plan never reads a clock. */
  now: Date;
  /** Null when sign-in was not checked: then nothing tied to an account is deleted. */
  accounts: AccountCheck | null;
}

/**
 * Why a document is written. Every kind is a delete but `rotation`, which sets `rotationPending: true`
 * on a team. Also the names the runner prints in its summary.
 */
export type CleanupKind =
  | "share"
  | "timeRequest"
  | "proposal"
  | "invite"
  | "profile"
  | "membership"
  | "device"
  | "grant"
  | "keyRequest"
  | "betaTester"
  | "betaRequest"
  | "bugReport"
  | "rotation";

export const CLEANUP_KINDS: readonly CleanupKind[] = [
  "share",
  "timeRequest",
  "proposal",
  "invite",
  "profile",
  "membership",
  "device",
  "grant",
  "keyRequest",
  "betaTester",
  "betaRequest",
  "bugReport",
  "rotation",
];

/** One planned write: a delete of `path`, or for kind `rotation` the mark on the team at `path`. */
export interface PlannedDelete {
  kind: CleanupKind;
  path: string;
}

/**
 * Deletions that belong together: a share with what hangs under it, or one invite, or one deleted
 * account's documents. The runner keeps a group in one atomic write whenever it fits. A deleted
 * account's group starts with its rotation marks and ends with its profile, so a group split across
 * writes marks every team before it deletes anything, and a write that fails leaves the profile for
 * the next run to find the account by.
 */
export interface DeleteGroup {
  /** In the order to delete: what hangs under a share comes before the share. */
  deletes: PlannedDelete[];
}

export interface CleanupPlan {
  groups: DeleteGroup[];
  /**
   * Account ids whose `admins/{uid}` document outlives their sign-in account. Who is a Horizon admin
   * is for the admins to decide, on the review page, so the clean-up names them and deletes nothing.
   */
  staleAdmins: string[];
  /** Sentences for the run's log: ids and counts only, never a document's contents. */
  notices: string[];
}

/**
 * How long an ended share or invite is kept: 30 days. SPEC: the retention policy ("kept 30 days
 * after they end") and spec 13 section 12.4.
 */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** RETENTION_DAYS in milliseconds. */
export const RETENTION_MS = RETENTION_DAYS * DAY_MS;

/**
 * The moment before which a share or invite must have ended to be deleted at `now`. Something that
 * ended exactly RETENTION_DAYS ago is kept; it is deleted from the first run after that.
 */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_MS);
}

/**
 * How long a bug report is kept at most, closed or not: 90 days after it was sent. SPEC: the owner's
 * ruling of 2026-10-01 on bug reports ("kept 30 days after closing or 90 days after sending,
 * whichever comes first") and the retention policy; a closed report goes sooner, after
 * RETENTION_DAYS, like anything else that ended.
 */
export const BUG_REPORT_MAX_DAYS = 90;

/** The moment before which a bug report must have been sent to be deleted at `now`, closed or not. */
export function bugReportCutoff(now: Date): Date {
  return new Date(now.getTime() - BUG_REPORT_MAX_DAYS * DAY_MS);
}

/**
 * Whether a bug report is due at `now`: closed (by a Horizon admin, whose change sets `updatedAt`)
 * more than RETENTION_DAYS ago, or sent more than BUG_REPORT_MAX_DAYS ago. A report whose times cannot
 * be read is kept.
 */
export function bugReportDue(data: Readonly<Record<string, unknown>>, now: Date): boolean {
  const createdAt = dateOf(data.createdAt);
  const updatedAt = dateOf(data.updatedAt);
  if (createdAt !== null && createdAt.getTime() < bugReportCutoff(now).getTime()) return true;
  return data.status === "closed" && updatedAt !== null && updatedAt.getTime() < retentionCutoff(now).getTime();
}

/**
 * How long a request for beta access waits for a Horizon admin: 30 days after it was sent. SPEC: the
 * owner's ruling of 2026-10-02 on the beta dashboard and the retention policy ("deleted when decided,
 * after 30 days, or with the account").
 */
export const BETA_REQUEST_MAX_DAYS = 30;

/** Whether a beta request is due at `now`: sent more than BETA_REQUEST_MAX_DAYS ago. One with no readable time is kept. */
export function betaRequestDue(data: Readonly<Record<string, unknown>>, now: Date): boolean {
  const createdAt = dateOf(data.createdAt);
  return createdAt !== null && createdAt.getTime() < now.getTime() - BETA_REQUEST_MAX_DAYS * DAY_MS;
}

/** The activity kind the app writes, in the same write, when an invite is revoked. */
export const INVITE_REVOKE_KIND = "invite.revoke";

type Parsed =
  | { type: "share"; shareId: string }
  | { type: "timeRequest"; shareId: string }
  | { type: "proposal" }
  | { type: "invite"; code: string }
  | { type: "activity"; teamId: string }
  | { type: "profile"; uid: string }
  | { type: "membership"; teamId: string; uid: string }
  | { type: "admin"; uid: string }
  | { type: "betaTester"; uid: string }
  | { type: "betaRequest"; uid: string }
  | { type: "device"; uid: string }
  | { type: "grant"; teamId: string }
  | { type: "keyRequest"; teamId: string }
  | { type: "team"; teamId: string }
  | { type: "bugReport" }
  | { type: "other" };

function parse(path: string): Parsed {
  const s = path.split("/");
  if (s.some((segment) => segment === "")) return { type: "other" };
  if (s.length === 2) {
    const [collection, id] = s as [string, string];
    if (collection === "shares") return { type: "share", shareId: id };
    if (collection === "proposals") return { type: "proposal" };
    if (collection === "invites") return { type: "invite", code: id };
    if (collection === "users") return { type: "profile", uid: id };
    if (collection === "admins") return { type: "admin", uid: id };
    if (collection === "betaTesters") return { type: "betaTester", uid: id };
    if (collection === "betaRequests") return { type: "betaRequest", uid: id };
    if (collection === "teams") return { type: "team", teamId: id };
    if (collection === "bugReports") return { type: "bugReport" };
  }
  if (s.length === 4) {
    const [collection, parent, sub, id] = s as [string, string, string, string];
    if (collection === "shares" && sub === "timeRequests") return { type: "timeRequest", shareId: parent };
    if (collection === "teams" && sub === "activity") return { type: "activity", teamId: parent };
    if (collection === "teams" && sub === "members") return { type: "membership", teamId: parent, uid: id };
    if (collection === "teams" && sub === "keyGrants") return { type: "grant", teamId: parent };
    if (collection === "teams" && sub === "keyRequests") return { type: "keyRequest", teamId: parent };
    if (collection === "users" && sub === "devices") return { type: "device", uid: parent };
  }
  return { type: "other" };
}

/**
 * True for the only document paths the clean-up may ever delete: `shares/{id}`,
 * `shares/{id}/timeRequests/{teamId}`, `proposals/{id}`, `invites/{code}`, `users/{uid}`,
 * `teams/{teamId}/members/{uid}`, `users/{uid}/devices/{deviceId}`,
 * `teams/{teamId}/keyGrants/{deviceId}`, `teams/{teamId}/keyRequests/{deviceId}`,
 * `betaTesters/{uid}`, `betaRequests/{uid}` and `bugReports/{id}`. The runner checks every delete against it again before sending.
 */
export function isDeletablePath(path: string): boolean {
  const type = parse(path).type;
  return (
    type === "share" ||
    type === "timeRequest" ||
    type === "proposal" ||
    type === "invite" ||
    type === "profile" ||
    type === "membership" ||
    type === "device" ||
    type === "grant" ||
    type === "keyRequest" ||
    type === "betaTester" ||
    type === "betaRequest" ||
    type === "bugReport"
  );
}

/**
 * True for the only path the clean-up writes anything but a delete to: `teams/{teamId}`, and there it
 * only sets `rotationPending: true` on a team that exists. The runner checks it again before sending.
 */
export function isRotationPath(path: string): boolean {
  return parse(path).type === "team";
}

/** True when the clean-up may make `entry`: a delete at a deletable path, or a rotation mark on a team. */
export function isAllowedWrite(entry: PlannedDelete): boolean {
  return entry.kind === "rotation" ? isRotationPath(entry.path) : isDeletablePath(entry.path);
}

/**
 * The account ids the snapshot's profiles, memberships, admins, beta testers, beta requests and bug
 * reports belong to, sorted. A beta tester is asked about because an admin names one by uid and
 * nothing in the app removes the entry when the account is deleted, and a beta request because an
 * account deleted outside the app leaves it behind. A
 * bug report's reporter is asked about too, because deleting an account in the app removes its
 * profile at once, and its reports are then found by nothing else.
 */
export function accountIdsIn(docs: readonly SnapshotDoc[]): string[] {
  const ids = new Set<string>();
  for (const doc of docs) {
    const parsed = parse(doc.path);
    if (
      parsed.type === "profile" ||
      parsed.type === "membership" ||
      parsed.type === "admin" ||
      parsed.type === "betaTester" ||
      parsed.type === "betaRequest"
    ) {
      ids.add(parsed.uid);
    }
    else if (parsed.type === "bugReport" && typeof doc.data.reporter === "string" && doc.data.reporter !== "") ids.add(doc.data.reporter);
  }
  return [...ids].sort();
}

function dateOf(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * When a share ended: the earlier of its revocation and its expiry, or null when it has neither a
 * valid expiry nor a revocation (then it is kept). A live share's end is in the future.
 */
export function shareEnd(data: Readonly<Record<string, unknown>>): Date | null {
  const expiresAt = dateOf(data.expiresAt);
  const revokedAt = dateOf(data.revokedAt);
  if (expiresAt === null) return revokedAt;
  return revokedAt === null ? expiresAt : earlier(revokedAt, expiresAt);
}

/**
 * When an invite ended. An invite records only that it was revoked, not when, so the time of the
 * revocation is the latest `invite.revoke` entry for its code in its team's activity log (the app
 * writes one in the same write as the revocation, at the server's time). The latest, not the
 * earliest, so an entry any member could add by hand can only make the invite stay longer. With no
 * such entry the invite counts as ending at its expiry, which is never earlier than a revocation.
 */
export function inviteEnd(data: Readonly<Record<string, unknown>>, revokedAt: Date | null): Date | null {
  const expiresAt = dateOf(data.expiresAt);
  if (data.revoked !== true || revokedAt === null) return expiresAt;
  return expiresAt === null ? revokedAt : earlier(revokedAt, expiresAt);
}

/** Decides every deletion. Pure: the same snapshot and `now` always give the same plan. */
export function planCleanup(input: CleanupInput): CleanupPlan {
  const cutoff = retentionCutoff(input.now).getTime();
  const ended = (end: Date | null) => end !== null && end.getTime() < cutoff;
  const notices: string[] = [];

  // Sort by path so the plan does not depend on the order the runner read documents in.
  const docs = [...input.docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Shares, and what hangs under them.
  const expiredShares = new Set<string>();
  let undatedShares = 0;
  for (const doc of docs) {
    const parsed = parse(doc.path);
    if (parsed.type !== "share") continue;
    const end = shareEnd(doc.data);
    if (end === null) undatedShares += 1;
    else if (ended(end)) expiredShares.add(parsed.shareId);
  }
  const shareGroups = new Map<string, PlannedDelete[]>();
  for (const shareId of expiredShares) shareGroups.set(shareId, []);
  for (const doc of docs) {
    const parsed = parse(doc.path);
    if (parsed.type === "timeRequest" && expiredShares.has(parsed.shareId)) {
      shareGroups.get(parsed.shareId)?.push({ kind: "timeRequest", path: doc.path });
    } else if (parsed.type === "proposal") {
      const shareId = doc.data.shareId;
      if (typeof shareId === "string" && expiredShares.has(shareId)) shareGroups.get(shareId)?.push({ kind: "proposal", path: doc.path });
    }
  }
  const groups: DeleteGroup[] = [];
  for (const [shareId, children] of shareGroups) {
    groups.push({ deletes: [...children, { kind: "share", path: `shares/${shareId}` }] });
  }
  if (undatedShares > 0) {
    notices.push(`${String(undatedShares)} share${undatedShares === 1 ? " has" : "s have"} no readable expiry and were kept.`);
  }

  // Invites. The revocation time comes from the invite's own team's activity log.
  const revokedAt = new Map<string, Date>();
  for (const doc of docs) {
    const parsed = parse(doc.path);
    if (parsed.type !== "activity" || doc.data.kind !== INVITE_REVOKE_KIND) continue;
    const code = doc.data.target;
    const at = dateOf(doc.data.at);
    if (typeof code !== "string" || at === null) continue;
    const key = `${parsed.teamId}/${code}`;
    const seen = revokedAt.get(key);
    if (seen === undefined || at.getTime() > seen.getTime()) revokedAt.set(key, at);
  }
  for (const doc of docs) {
    const parsed = parse(doc.path);
    if (parsed.type !== "invite") continue;
    const teamId = doc.data.teamId;
    const revoked = typeof teamId === "string" ? revokedAt.get(`${teamId}/${parsed.code}`) ?? null : null;
    if (ended(inviteEnd(doc.data, revoked))) groups.push({ deletes: [{ kind: "invite", path: doc.path }] });
  }

  // Bug reports that are due by time. A report of a deleted account goes with that account below.
  const reportsDue = new Set<string>();
  for (const doc of docs) {
    if (parse(doc.path).type !== "bugReport" || !bugReportDue(doc.data, input.now)) continue;
    reportsDue.add(doc.path);
    groups.push({ deletes: [{ kind: "bugReport", path: doc.path }] });
  }

  // Beta requests nobody decided in time. A request of a deleted account goes with that account below.
  const requestsDue = new Set<string>();
  for (const doc of docs) {
    if (parse(doc.path).type !== "betaRequest" || !betaRequestDue(doc.data, input.now)) continue;
    requestsDue.add(doc.path);
    groups.push({ deletes: [{ kind: "betaRequest", path: doc.path }] });
  }

  // What is left of deleted accounts.
  const staleAdmins: string[] = [];
  const accounts = input.accounts;
  if (accounts === null) {
    notices.push("Sign-in was not checked, so nothing tied to an account was deleted.");
  } else if (accounts.checked.size > 0 && ![...accounts.checked].some((uid) => accounts.existing.has(uid))) {
    // Every account gone at once means the check is pointed at the wrong project or cannot read
    // sign-in, not that everyone left. Deleting on that answer would wipe every profile.
    notices.push(
      `Sign-in reported none of the ${String(accounts.checked.size)} account ids it was asked about, which means the check is misconfigured; nothing tied to an account was deleted.`,
    );
  } else {
    const gone = (uid: string) => accounts.checked.has(uid) && !accounts.existing.has(uid);
    const byAccount = new Map<string, PlannedDelete[]>();
    const add = (uid: string, entry: PlannedDelete) => {
      const list = byAccount.get(uid) ?? [];
      list.push(entry);
      byAccount.set(uid, list);
    };
    // Teams the runner found to exist, which alone may be marked "rotation pending".
    const teams = new Set<string>();
    for (const doc of docs) {
      const parsed = parse(doc.path);
      if (parsed.type === "team") teams.add(parsed.teamId);
    }
    const marked = new Set<string>();
    for (const doc of docs) {
      const parsed = parse(doc.path);
      if (parsed.type === "membership" && gone(parsed.uid)) add(parsed.uid, { kind: "membership", path: doc.path });
      else if (parsed.type === "profile" && gone(parsed.uid)) add(parsed.uid, { kind: "profile", path: doc.path });
      else if (parsed.type === "device" && gone(parsed.uid)) add(parsed.uid, { kind: "device", path: doc.path });
      else if (parsed.type === "betaTester" && gone(parsed.uid)) add(parsed.uid, { kind: "betaTester", path: doc.path });
      else if (parsed.type === "betaRequest" && gone(parsed.uid)) {
        if (!requestsDue.has(doc.path)) add(parsed.uid, { kind: "betaRequest", path: doc.path });
      }
      else if (parsed.type === "grant" && typeof doc.data.uid === "string" && gone(doc.data.uid)) {
        const uid = doc.data.uid;
        add(uid, { kind: "grant", path: doc.path });
        // A device of the gone account held this team's key: the team makes a new one.
        if (teams.has(parsed.teamId) && !marked.has(`${uid}/${parsed.teamId}`)) {
          marked.add(`${uid}/${parsed.teamId}`);
          add(uid, { kind: "rotation", path: `teams/${parsed.teamId}` });
        }
      } else if (parsed.type === "keyRequest" && typeof doc.data.uid === "string" && gone(doc.data.uid)) {
        add(doc.data.uid, { kind: "keyRequest", path: doc.path });
      } else if (parsed.type === "bugReport" && typeof doc.data.reporter === "string" && gone(doc.data.reporter)) {
        if (!reportsDue.has(doc.path)) add(doc.data.reporter, { kind: "bugReport", path: doc.path });
      } else if (parsed.type === "admin" && gone(parsed.uid)) staleAdmins.push(parsed.uid);
    }
    // The marks first, so no team loses a grant before it is marked, even when the group is split
    // across writes, and the profile last, since it is what the next run finds the account by if a
    // write fails. Between them, in path order: the beta request and tester entry, each team's grants, key requests
    // and membership, then the devices.
    const rank = (entry: PlannedDelete) => (entry.kind === "rotation" ? 0 : entry.kind === "profile" ? 2 : 1);
    for (const deletes of byAccount.values()) groups.push({ deletes: [...deletes].sort((a, b) => rank(a) - rank(b)) });
  }

  return { groups, staleAdmins, notices };
}

/** Every delete of the plan, in order. */
export function plannedDeletes(plan: CleanupPlan): PlannedDelete[] {
  return plan.groups.flatMap((group) => group.deletes);
}

/** How many deletes of each kind the plan holds. */
export function countByKind(deletes: readonly PlannedDelete[]): Record<CleanupKind, number> {
  const counts = Object.fromEntries(CLEANUP_KINDS.map((kind) => [kind, 0])) as Record<CleanupKind, number>;
  for (const entry of deletes) counts[entry.kind] += 1;
  return counts;
}

/**
 * How many documents one write deletes. Firestore takes at most 500 writes in one commit; 400 is the
 * same margin the app's team deletion uses. SET BY HAND from that limit.
 */
export const DELETES_PER_WRITE = 400;

/**
 * Packs the plan's groups into writes of at most `max` deletes, in order. A group is never split
 * across writes unless it alone is larger than `max`; then it is split in order, so what hangs under
 * a share is deleted before the share and a write that fails leaves the share to be found again by
 * the next run. A split group's rotation marks go first, in a write of their own that deletes
 * nothing, so every team is marked before any of its grants goes.
 */
export function packWrites(plan: CleanupPlan, max: number = DELETES_PER_WRITE): PlannedDelete[][] {
  if (!Number.isInteger(max) || max < 1) throw new Error("A write must hold at least one delete.");
  const writes: PlannedDelete[][] = [];
  let current: PlannedDelete[] = [];
  const flush = () => {
    if (current.length > 0) writes.push(current);
    current = [];
  };
  for (const group of plan.groups) {
    if (group.deletes.length > max) {
      flush();
      const marks = group.deletes.filter((entry) => entry.kind === "rotation");
      const rest = group.deletes.filter((entry) => entry.kind !== "rotation");
      for (let start = 0; start < marks.length; start += max) writes.push(marks.slice(start, start + max));
      for (let start = 0; start < rest.length; start += max) writes.push(rest.slice(start, start + max));
      continue;
    }
    if (current.length + group.deletes.length > max) flush();
    current.push(...group.deletes);
  }
  flush();
  return writes;
}
