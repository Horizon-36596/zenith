/**
 * The editor's view of the cloud sharing service (spec 13 section 8).
 *
 * These are the types the sharing UI is written against. `cloudSharingApi.ts` implements them on
 * top of `packages/cloud`'s `CloudBackend`, whichever backend the account session runs on (Firebase,
 * or the in-memory one with `?cloud=fake`), so the sharing UI and the account share one sign-in.
 *
 * Here teams are named by their FTC numbers and every instant is an ISO 8601 string; the adapter
 * turns them into the cloud's team ids and `Date`s.
 */

import type { TeamStatus } from "@horizon36596/zenith-cloud";

/** What the other team may do: look, or look and propose changes. */
export type Level = "view" | "propose";
/** Who a share is for: named teams, or anyone with the link. */
export type Audience = "teams" | "link";
/** Whether a share stays on the version it was made from, or follows each publish. */
export type Mode = "pinned" | "follow";

/**
 * The options in the share dialog that shape a share's projection, as the sharer chose them. The
 * cloud keeps them sealed under the sharing team's own key, where no team the share is made to can
 * change them, and every rebuild of the share's projection reads them from there.
 */
export interface SharerChoice {
  /** The Coarsen checkbox. */
  coarsen: boolean;
  /** The "Include command names" checkbox. */
  includeCommands: boolean;
  /** The auto's name when "Include the auto's name" was ticked, or null when it was left out. */
  title: string | null;
}

export interface Share {
  id: string;
  /** The team library's id for the auto (`AutoRecord.id`), which the share was made from. */
  autoId: string;
  audience: Audience;
  /** FTC team numbers; empty for an anyone-with-the-link share. */
  teamNumbers: number[];
  /**
   * Each named team's number status, by team number, as the cloud has it (spec 13 section 4.2).
   * Absent for a team this viewer cannot read, and for a request not yet stored.
   */
  teamStatuses?: Partial<Record<number, TeamStatus>>;
  /**
   * How many of the teams the share names were deleted since it was made; absent when none was.
   * A deleted team is not in `teamNumbers`.
   */
  deletedTeams?: number;
  /**
   * True when every team the share names was deleted: nobody outside the sharing team can open it,
   * so the Sharing page lists it as ended although its end time has not come.
   */
  everyTeamDeleted?: true;
  level: Level;
  mode: Mode;
  /**
   * The number of the team library revision the share was made from (pinned) or last followed:
   * what "revision 4" says. Two diverged revisions can share a number, so `revisionId` is the one
   * that names it.
   */
  revision: number;
  /** The team library revision's id (`000004-q8Yx…`), which the cloud stores on the share. */
  revisionId: string;
  /**
   * What the other team gets: the projection (spec 13 section 8.2) in canonical form, built on this
   * computer by `buildProjection` in `projectionModel.ts`. It is the only part of the auto a share
   * carries.
   */
  projection: string;
  /**
   * An anyone-with-the-link share's secret: the 22 characters after `#/s/` in its link, which
   * derive both the share's id and the key its projection is encrypted with (spec 14). Only the
   * team that made the share holds it; absent on a share to teams.
   */
  linkSecret?: string;
  /**
   * The options the sharer chose, read back from the cloud by the sharing team only. Absent on a
   * share made before the cloud kept them, and on one whose sealed choices could not be read; a
   * rebuild of such a share uses the most private options (coarse, no command names, no title).
   */
  choice?: SharerChoice;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /**
   * The uid of the member who made the share. The rules let an editor change only the shares they
   * made, and owners and admins change any (spec 13 section 4.3), so the Sharing page reads it to
   * offer only the changes the rules allow.
   */
  createdBy: string;
  /**
   * True only on the share `createShare` returns while this computer is offline: the share is
   * saved here and waits in the Outbox, and the other team cannot see it until it is sent (spec 13
   * section 6). A share read from the cloud never carries it.
   */
  queued?: true;
  /** The Outbox entry that sends a queued share, so the dialog can say how it went. */
  outboxId?: string;
  /**
   * True only on a queued share to teams this computer could not look up while offline: it is held
   * on this page, not yet in the Outbox, and made and sent once the connection is back and the
   * teams are found (`createShare` then reports how it went on the status line).
   */
  waitsForConnection?: true;
}

/**
 * A share the team made that stopped when the team key changed (a member removed, or a device the
 * team took the key from): it was made, or its terms last changed, on a device the team no longer
 * keeps, so the team's devices seal nothing new into it. The terms are the ones the team's own key
 * signed; "Share again" makes a new share with them.
 */
export interface StoppedShare {
  id: string;
  autoId: string;
  audience: Audience;
  /** The FTC numbers of the teams it names; empty for a link share. */
  teamNumbers: number[];
  /**
   * How many of the teams it names have no number, or were deleted, so a new share cannot name
   * them; absent when none.
   */
  unnamedTeams?: number;
  level: Level;
  mode: Mode;
  /** The team library revision it showed, by number and id. */
  revision: number;
  revisionId: string;
  expiresAt: string;
  createdAt: string;
  /**
   * `device-removed`: made or last changed on a device the team then removed. `not-listed`: the
   * device that changed the key did not list it, though every device that signed it is kept.
   */
  reason: "device-removed" | "not-listed";
}

/**
 * How a share that waited on this page for the connection went: the sentence to show, whether it
 * was made, the id the dialog was given for it (`waiting-…`), and the share once it was made.
 */
export interface PendingShareResult {
  ok: boolean;
  sentence: string;
  waitingId: string;
  share?: Share;
}

/** What `createShare` is asked to store: a share without what the cloud gives it. */
export type ShareRequest = Omit<
  Share,
  "id" | "createdAt" | "revokedAt" | "createdBy" | "teamStatuses" | "deletedTeams" | "everyTeamDeleted" | "queued" | "outboxId" | "waitsForConnection"
>;

/**
 * What the share dialog asks about before sending to a team, one team number at a time:
 * - `key-changed`: the team's public key is not the one this device used for it before (spec 14
 *   section 4.6), and the team did not make a new key version;
 * - `number-changed`: the number now leads to a different team from the one this device shared with
 *   under it before, which only the server's claim record can make happen;
 * - `first-use`: this device and user have not shared with the team the number leads to, or were
 *   never shown its safety code, so the dialog shows it once before sending.
 */
export interface PartnerKeyWarning {
  kind: "key-changed" | "number-changed" | "first-use";
  teamNumber: number;
  teamName: string | null;
  /** The team's safety code for the key it shows now, to compare with that team. */
  safetyCode: string;
  /** The cloud id of the team the number leads to now, whose code `safetyCode` is. */
  teamId: string;
  /**
   * The key `safetyCode` is of, named exactly. The answer to this warning carries it back
   * (`CreateShareOptions.shownKeys`), so the share is wrapped to this key or not made.
   */
  keyId: string;
  /**
   * `number-changed` only: the safety code of the team this device shared with under the number
   * before, or null when that team can no longer be read.
   */
  previousSafetyCode?: string | null;
  /** `number-changed` only: that earlier team's name, or null when it can no longer be read. */
  previousTeamName?: string | null;
}

export interface CreateShareOptions {
  /** Team numbers whose changed key the person chose to trust after comparing safety codes. */
  acceptKeyChanges?: number[];
  /**
   * Team numbers that now lead to a different team, which the person chose to share with after
   * comparing both teams' safety codes.
   */
  acceptNumberChanges?: number[];
  /** Team numbers whose safety code the person was shown for the first time, and shared anyway. */
  safetyCodesSeen?: number[];
  /**
   * For each number answered above, the team and key the answer was about: the `teamId` and `keyId`
   * of the warning the person was shown. An answer counts only for that team and that key. A share
   * finding another key for the team is not made, and nothing records that the person saw it.
   */
  shownKeys?: Partial<Record<number, ShownKey>>;
}

/** The team and key a warning's safety code was of, as the answer to it carries them back. */
export interface ShownKey {
  teamId: string;
  keyId: string;
}

/**
 * How the team a received share is from compares with the team this device knows under its number,
 * the one it pinned when it shared with that number (the server writes a team's number, name and
 * status, so they alone say nothing):
 * - `known`: it is that team;
 * - `first-use`: this device has not shared with the number yet, so the panel shows the team's
 *   safety code once to compare, or null when it cannot be read;
 * - `no-number`: the team holds no number, so only its safety code says who it is, and the panel
 *   always shows it (null when it cannot be read): the key this device pinned for the team, or with
 *   no pin, the key the server shows now, as for `first-use`;
 * - `mismatch`: this device knows the number as a different team, so the share only claims it. A
 *   team with no number claims a number by a name that reads as one ("36596", "Team 36596").
 * `keyReplaced` on `first-use` and `no-number` says the code is of a newer key than the first one
 * this device trusted for the team, one the team signed from it (`KnownSafetyCode.keyReplaced`): the
 * code changed, and that is when a person should compare it again.
 */
export type FromTeamCheck =
  | { kind: "known" }
  | { kind: "first-use"; safetyCode: string | null; keyReplaced?: true }
  | { kind: "no-number"; safetyCode: string | null; keyReplaced?: true }
  | { kind: "mismatch" };

export interface Invite {
  code: string;
  role: "admin" | "editor" | "viewer";
  expiresAt: string;
  maxUses: number;
  uses: number;
  autoApprove: boolean;
  revoked: boolean;
}

/**
 * A share made to this team, or opened by its link: what the Partners panel lists and loads. It
 * carries the projection and nothing else of the other team's auto (spec 13 section 8.2).
 */
export interface ReceivedShare {
  id: string;
  audience: Audience;
  /** The sharing team's FTC number, or null when it has none or this viewer cannot read it. */
  fromTeamNumber: number | null;
  /** The sharing team's name, or null when this viewer cannot read it (a link opened signed out). */
  fromTeamName: string | null;
  /**
   * Whether a Horizon admin has checked the sharing team's number (spec 13 section 4.2: a team is
   * labelled unverified wherever its name appears), or null when this viewer cannot read the team.
   */
  fromTeamStatus: TeamStatus | null;
  /** The sharing team's cloud id, which a proposal to the share names as the owning team. */
  fromTeamId: string;
  /**
   * Whether the sharing team is the team this device knows under `fromTeamNumber`, or for a team
   * with no number, its safety code and whether its name claims a number this device knows as
   * another team. Absent when this viewer cannot read the team, or nobody is signed in to have pins.
   */
  fromTeamCheck?: FromTeamCheck;
  /**
   * The cloud ids of the teams the share was made to; empty for an anyone-with-the-link share. Only
   * a team listed here may propose changes to a propose-level share (spec 13 section 14).
   */
  teamIds: string[];
  level: Level;
  mode: Mode;
  revision: number;
  /** The team library revision's id the projection was built from, which a proposal is based on. */
  revisionId: string;
  expiresAt: string;
  /** When the share last changed: a follow-latest share moves on each publish (section 8.3). */
  updatedAt: string;
  projection: string;
  /** The link's secret, when the share was opened by its link: what the list of opened links keeps. */
  linkSecret?: string;
}

/** The files a team library revision holds, as canonical text: what a projection is rebuilt from. */
export interface RevisionFiles {
  content: string;
  robot?: string;
  field?: string;
  waypoints?: string;
}

/**
 * A share made to the team that this device cannot open yet: it was signed with an older key of the
 * sharing team than one this device has seen, so it waits for that team to sign it again with its
 * newer key, which the sharing team's app does after the key change. Nothing of it is opened, so
 * all it shows is who it is from, as the server names them, checked like a received share's.
 */
export interface WaitingShare {
  id: string;
  /** The sharing team's cloud id, as the server gives it. */
  fromTeamId: string;
  /** The sharing team's FTC number, or null when it has none or this viewer cannot read it. */
  fromTeamNumber: number | null;
  /** The sharing team's name, or null when this viewer cannot read it. */
  fromTeamName: string | null;
  /** Whether a Horizon admin has checked the sharing team's number, or null when this viewer cannot read the team. */
  fromTeamStatus: TeamStatus | null;
  /** As for `ReceivedShare`: whether the sharing team is the one this device knows under its number. */
  fromTeamCheck?: FromTeamCheck;
}

export interface SharingApi {
  listShares(teamId: string): Promise<Share[]>;
  /**
   * The team's shares that stopped when its key changed, newest first, and not revoked or ended.
   * `listShares` leaves them out. Empty on a device still waiting for the team key.
   */
  listStopped(teamId: string): Promise<StoppedShare[]>;
  /**
   * What to ask about before sharing with the teams named: a key that changed since this device
   * last shared with the team, a number that now leads to another team, or a team whose safety code
   * this device never showed. Empty when every team is one this device shared with before, under the
   * same number, with the same key or a newer version; also empty while offline for teams not looked
   * up yet, whose share then waits and is refused unless the team was shared with before. Fails,
   * with a sentence naming it, for a number no team has claimed, and while online for one that
   * cannot be looked up.
   */
  checkPartnerKeys(teamNumbers: readonly number[]): Promise<PartnerKeyWarning[]>;
  /**
   * Makes a share. Online, a share to teams is refused with a `SafetyCodeNotShownError` (in the
   * error's causes) when it names a number whose safety code this device has not shown for the team
   * it leads to, in this send or an earlier one; the dialog then checks the numbers again.
   */
  createShare(teamId: string, s: ShareRequest, options?: CreateShareOptions): Promise<Share>;
  extendShare(id: string, expiresAt: string | null): Promise<Share>;
  setLevel(id: string, level: Level): Promise<Share>;
  setMode(id: string, mode: Mode): Promise<Share>;
  revokeShare(id: string): Promise<void>;
  /**
   * Moves a share to a revision with the projection built from it: what "Update share", a
   * follow-latest share on publish (section 8.3) and a change of level do. The same shape as
   * `updateShare` in `packages/cloud`.
   */
  updateShare(id: string, input: { revisionId: string; projection: string }): Promise<Share>;
  listInvites(teamId: string): Promise<Invite[]>;
  extendInvite(code: string, expiresAt: string): Promise<Invite>;
  revokeInvite(code: string): Promise<void>;
  /** The live shares made to the team, newest change first. */
  listReceived(teamId: string): Promise<ReceivedShare[]>;
  /** The live shares made to the team that wait for the sharing team to sign them with its newer key. */
  listWaiting(teamId: string): Promise<WaitingShare[]>;
  /**
   * One share made to the signed-in team, by its id: how a kept share opens again. Null when it
   * does not exist, has ended, was revoked, or this viewer may not open it.
   */
  openShare(id: string): Promise<ReceivedShare | null>;
  /**
   * An anyone-with-the-link share by its secret, the whole of a `#/s/<secret>` link (section 8.5).
   * Needs no sign-in. Null when it does not exist, has ended or was revoked.
   */
  openLink(secret: string): Promise<ReceivedShare | null>;
  /** One revision of the team's library, or null when it is not there. */
  revisionFiles(teamId: string, autoId: string, revisionId: string): Promise<RevisionFiles | null>;
}
