/**
 * The admin dashboard's All shares list (spec 13 section 13): every share of every team, as the
 * Horizon admins see it to keep the service safe and to answer reports. This file turns the stored
 * shares and their teams into rows, and filters them; it reads nothing and draws nothing.
 *
 * An admin sees a share's settings and the teams it involves, and never what it shows: a row is
 * built from the share's metadata alone, never from its projection, so it names the share by a
 * short form of its id rather than by the auto's title.
 */
import type { ShareSummary as Share, Team, TeamStatus } from "@horizon36596/zenith-cloud";
import { revisionNumber } from "@horizon36596/zenith-cloud/sharing";
import { teamLabel, whenWords } from "../account/words";

/**
 * Where a share stands now. A deleted owner team outranks a revocation, which outranks every team
 * it was shared with having been deleted, which outranks an end.
 */
export type ShareStatus = "live" | "expired" | "revoked" | "team-deleted";

export const SHARE_STATUS_WORDS: Record<ShareStatus, { label: string; meaning: string }> = {
  live: { label: "Live", meaning: "The teams it names, or anyone with its link, can open it now." },
  expired: { label: "Expired", meaning: "Its end time has passed, so nobody outside its team can open it." },
  revoked: { label: "Revoked", meaning: "Its team revoked it, so nobody outside its team can open it." },
  "team-deleted": {
    label: "Team deleted",
    meaning: "The team that made it, or every team it was shared with, was deleted, so no other team can open it.",
  },
};

export type StatusFilter = "all" | ShareStatus;
export type AudienceFilter = "all" | Share["audience"];

export interface ShareFilters {
  status: StatusFilter;
  audience: AudienceFilter;
  /** Matched against the number and name of the owner team and of every team the share names. */
  search: string;
}

export const NO_FILTERS: ShareFilters = { status: "all", audience: "all", search: "" };

/** The teams the list names, by id; null for a team that no longer exists. */
export type TeamsById = ReadonlyMap<string, Team | null>;

export interface ShareRow {
  id: string;
  /** Who the share is for, as stored: specific teams, or anyone with the link. */
  audienceKind: Share["audience"];
  status: ShareStatus;
  /** "36596 Horizon", or "A team that no longer exists". */
  owner: string;
  /** The owner team's verification status, or null when the team is gone. */
  ownerStatus: TeamStatus | null;
  /** "Share 3fQx9a": the first six characters of the share's id. */
  shortId: string;
  /** "Teams 12345 Partner, 23456 Other", "Team 12345 Partner and a deleted team", "A deleted team", or "Anyone with the link". */
  audience: string;
  level: string;
  /** "Pinned to revision 2", or "Follows the latest version, now revision 4". */
  version: string;
  /** "Ends" while the end time is ahead, "Ended" once it has passed. */
  expiryLabel: "Ends" | "Ended";
  /** The end time as a calendar time: "Sat 4 Oct, 18:30". */
  expiry: string;
  created: string;
  updated: string;
  /** Lower-case text the search box looks in. */
  searchText: string;
}

/**
 * Where a share stands at `nowMs`, given whether its owner team still exists and whether every team
 * it was shared with was deleted.
 */
export function shareStatus(
  share: Pick<Share, "revokedAt" | "expiresAt">,
  ownerExists: boolean,
  nowMs: number,
  everyNamedTeamDeleted = false,
): ShareStatus {
  if (!ownerExists) return "team-deleted";
  if (share.revokedAt !== null) return "revoked";
  if (everyNamedTeamDeleted) return "team-deleted";
  return share.expiresAt.getTime() > nowMs ? "live" : "expired";
}

/** Who a share to teams is for: the teams that still exist by name, and the deleted ones as such. */
function namedTeamsWords(existing: readonly string[], deleted: number): string {
  const gone = deleted === 1 ? "a deleted team" : `${String(deleted)} deleted teams`;
  if (existing.length === 0) return deleted === 0 ? "No team" : gone.charAt(0).toUpperCase() + gone.slice(1);
  const named = `${existing.length === 1 ? "Team" : "Teams"} ${existing.join(", ")}`;
  return deleted === 0 ? named : `${named} and ${gone}`;
}

/** "Share 3fQx9a": the first six characters of a share's id, which names it in the list. */
export const shortShareId = (shareId: string): string => `Share ${shareId.slice(0, 6)}`;

/** "revision 4" from a revision id such as `000004-q8Yx…`, or the id itself if it has no number. */
function revisionWords(revision: string): string {
  const n = revisionNumber(revision);
  return Number.isInteger(n) && n > 0 ? `revision ${String(n)}` : `revision ${revision}`;
}

/** One share as a row. It reads the share's metadata only, never its projection. */
export function shareRow(share: Share, teams: TeamsById, nowMs: number): ShareRow {
  const ownerTeam = teams.get(share.ownerTeamId) ?? null;
  const named = share.teamIds.flatMap((id) => {
    const team = teams.get(id) ?? null;
    return team === null ? [] : [teamLabel(team)];
  });
  const deleted = share.teamIds.length - named.length;
  const everyNamedTeamDeleted = share.audience === "teams" && share.teamIds.length > 0 && named.length === 0;
  const status = shareStatus(share, ownerTeam !== null, nowMs, everyNamedTeamDeleted);
  const audience = share.audience === "link" ? "Anyone with the link" : namedTeamsWords(named, deleted);
  const ended = share.expiresAt.getTime() <= nowMs;
  const owner = teamLabel(ownerTeam);
  return {
    id: share.id,
    audienceKind: share.audience,
    status,
    owner,
    ownerStatus: ownerTeam === null ? null : ownerTeam.status,
    shortId: shortShareId(share.id),
    audience,
    level: share.audience === "teams" && share.level === "propose" ? "View and propose" : "View only",
    version:
      share.mode === "follow"
        ? `Follows the latest version, now ${revisionWords(share.revision)}`
        : `Pinned to ${revisionWords(share.revision)}`,
    expiryLabel: ended ? "Ended" : "Ends",
    expiry: whenWords(share.expiresAt),
    created: whenWords(share.createdAt),
    updated: whenWords(share.updatedAt),
    searchText: [owner, audience].join("\n").toLowerCase(),
  };
}

/** Every share as a row, newest first (by when it was made, then by id so the order is stable). */
export function shareRows(shares: readonly Share[], teams: TeamsById, nowMs: number): ShareRow[] {
  return [...shares]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((share) => shareRow(share, teams, nowMs));
}

/** The rows the filters keep, in the same order. The search ignores case and surrounding spaces. */
export function filterShareRows(rows: readonly ShareRow[], filters: ShareFilters): ShareRow[] {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filters.status === "all" || row.status === filters.status) &&
      (filters.audience === "all" || row.audienceKind === filters.audience) &&
      (needle === "" || row.searchText.includes(needle)),
  );
}

/** Every team id a list of shares names, owners first, each once. */
export function shareTeamIds(shares: readonly Share[]): string[] {
  const ids = new Set<string>();
  for (const share of shares) ids.add(share.ownerTeamId);
  for (const share of shares) for (const id of share.teamIds) ids.add(id);
  return [...ids];
}

/** "3 of 12 shares", or "12 shares" when nothing is filtered out. */
export function countWords(shown: number, total: number): string {
  const noun = total === 1 ? "share" : "shares";
  return shown === total ? `${String(total)} ${noun}` : `${String(shown)} of ${String(total)} ${noun}`;
}
