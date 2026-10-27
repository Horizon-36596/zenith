/**
 * What a partner loaded from a received cloud share remembers about that share (spec 13 sections
 * 8.3, 9 and 14): its id and the revision it was loaded at, its level and mode, the team that made
 * it, the teams it was made to, and when it last changed. A partner loaded from a file has none of
 * this, and carries no `PartnerShare` at all.
 *
 * It is what lets the alliance view say "updated 3 hours ago" and notice a newer version, and what a
 * proposal to the partner is sent against. Pure: no DOM, no clock, no store.
 */
import { timeAgo } from "../account/words";
import type { Level, Mode, ReceivedShare } from "./types";
import { fromTeamWords } from "./words";

export interface PartnerShare {
  shareId: string;
  /** The team library revision number the projection was built from, as the share showed it. */
  revision: number;
  /** That revision's id, which a proposal names as its base. */
  revisionId: string;
  level: Level;
  mode: Mode;
  /** The sharing team's cloud id. */
  fromTeamId: string;
  /** The sharing team in words: "Team 36596", or "Shared link" when the viewer cannot read it. */
  fromTeam: string;
  /** The cloud ids of the teams the share was made to; empty for a link. */
  teamIds: string[];
  /** When the share last changed, as an ISO 8601 instant. */
  updatedAt: string;
}

/** What a partner loaded from `share` remembers of it. */
export function partnerShareOf(share: ReceivedShare): PartnerShare {
  return {
    shareId: share.id,
    revision: share.revision,
    revisionId: share.revisionId,
    level: share.level,
    mode: share.mode,
    fromTeamId: share.fromTeamId,
    fromTeam: fromTeamWords(share),
    teamIds: [...share.teamIds],
    updatedAt: share.updatedAt,
  };
}

/**
 * Why the viewer's team cannot propose changes to this share, or null when it can: only a share
 * at the propose level, made to the viewer's own team, takes proposals (section 14, first bullet).
 */
export function shareProposeBlockedReason(share: PartnerShare, viewerTeamId: string | null): string | null {
  if (share.level !== "propose") {
    return `${share.fromTeam} shared this auto view only, so it takes no proposals. They can allow proposing changes from their Sharing page.`;
  }
  if (viewerTeamId === null) return "Sign in with your team to propose changes to a share made to it.";
  if (viewerTeamId === share.fromTeamId) return "This is your own team's share. Edit the auto itself instead.";
  if (!share.teamIds.includes(viewerTeamId)) {
    return `${share.fromTeam} did not share this auto with the team you are signed in with, so that team cannot propose changes to it.`;
  }
  return null;
}

/** "updated 3 hours ago", from the share's last change and the device clock. */
export const partnerUpdatedWords = (share: Pick<PartnerShare, "updatedAt">, nowMs: number): string =>
  `updated ${timeAgo(new Date(share.updatedAt), nowMs)}`;

/**
 * The share as the cloud has it now, when it has moved on since the partner was loaded: another
 * revision (a follow-latest share moves on each publish, or the sharer pressed Update share) or
 * another level. Null when it has not, or when the viewer's latest list does not hold it (it may
 * have ended; the list says so where it is shown).
 */
export function newerShareOf(share: PartnerShare, latest: readonly ReceivedShare[]): ReceivedShare | null {
  const now = latest.find((entry) => entry.id === share.shareId);
  if (now === undefined) return null;
  return now.revisionId !== share.revisionId || now.level !== share.level ? now : null;
}
