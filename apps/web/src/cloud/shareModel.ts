/**
 * The share dialog's state and the arithmetic behind it, with no React in it so it is tested in
 * node (spec 13 section 8).
 *
 * A `ShareDraft` is what the dialog's controls hold. `draftSettings` turns it into the settings
 * `shareSentence` describes, `draftProjectionChoice` into the choices the projection is built with,
 * and `draftToRequest` into the request `createShare` stores; all three read the same draft, so the
 * sentence and the preview the dialog showed are the sentence and the projection the stored share
 * gets.
 */
import { effectiveShareLevel, type ShareSettings } from "@horizon36596/zenith-core";
import type { Role, TeamSettings } from "@horizon36596/zenith-cloud";
import type { AccountState } from "../account/model";
import { isAdminRole, isEditorRole, whyCannotOpenLibrary, whyCannotShare as whyRoleCannotShare } from "../account/permissions";
import { extendedMs, localDateTimeMs, parseJoinHash, type InviteExpiryChoice } from "../account/invites";
import { readTeamNumber } from "../lib/teamNumber";
import { SHARE_TEAM_LIMIT, teamLimitProblem } from "./cloudSharingApi";
import { projectionTitle, type ProjectionChoice } from "./projectionModel";
import type { Audience, Level, Mode, Share, ShareRequest } from "./types";

/**
 * The expiry choices the dialog offers. Every expiry is calendar time (owner ruling 2026-09-27): a
 * number of days from now, or a date and, when one is given, a time.
 */
export type ExpiryChoice =
  | { kind: "days"; days: 1 | 7 | 30 }
  /**
   * A calendar date in the viewer's time zone, as `YYYY-MM-DD`, and optionally a time on it as
   * `HH:MM`. With no time the share works to the end of that day.
   */
  | { kind: "date"; date: string; time?: string };

export interface ShareDraft {
  audience: Audience;
  teamNumbers: number[];
  level: Level;
  mode: Mode;
  expiry: ExpiryChoice;
  /**
   * The Coarsen checkbox (spec 13 section 8.2): round what they see to 2 in, 5 degrees and 0.25 s.
   * Off by default.
   */
  coarsen: boolean;
  /**
   * The "Include command names" checkbox (owner ruling 2026-09-27): the partner also sees what each
   * command is called and the settings it is given, never the code behind it. Off by default.
   */
  includeCommands: boolean;
  /**
   * The "Include the auto's name" checkbox (spec 13 section 8.2): the projection keeps the auto's
   * name, so the partner sees it by that name rather than only by the sharing team's. Off by
   * default, since the name is the sharer's own words.
   */
  includeTitle: boolean;
}

/**
 * Defaults (section 1 and 8.1): specific teams, view only, pinned to this version, for 7 days.
 * SPEC: spec 13 section 1, "view only, pinned to the version it was made
 * from, for 7 days".
 */
export const DEFAULT_DRAFT: ShareDraft = {
  audience: "teams",
  teamNumbers: [],
  level: "view",
  mode: "pinned",
  expiry: { kind: "days", days: 7 },
  coarsen: false,
  includeCommands: false,
  includeTitle: false,
};

const MS_PER_DAY = 86_400_000;

/** The instant a choice expires at, as an ISO string, or null when the date given is not a date. */
export function expiryInstant(choice: ExpiryChoice, nowMs: number): string | null {
  if (choice.kind === "days") return new Date(nowMs + choice.days * MS_PER_DAY).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(choice.date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = choice.time === undefined || choice.time === "" ? null : /^(\d{2}):(\d{2})$/.exec(choice.time);
  if (time === null && choice.time !== undefined && choice.time !== "") return null;
  const [hour, minute] = time === null ? [23, 59] : [Number(time[1]), Number(time[2])];
  if (hour > 23 || minute > 59) return null;
  // With no time, the last millisecond of that day on this computer's clock, so "until Sat 4 Oct"
  // includes Sat 4 Oct. With a time, that minute exactly.
  const end =
    time === null ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day, hour, minute, 0, 0);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) return null;
  return end.toISOString();
}

/** The viewer's offset from UTC at an instant, in minutes east, for `shareSentence`. */
export function utcOffsetAt(at: string | number | null, nowMs: number): number {
  const when = at === null ? nowMs : typeof at === "number" ? at : Date.parse(at);
  return -new Date(Number.isFinite(when) ? when : nowMs).getTimezoneOffset();
}

/** The settings the dialog's sentence describes. */
export function draftSettings(draft: ShareDraft, nowMs: number): ShareSettings {
  return {
    audience: draft.audience,
    teamNumbers: draft.audience === "link" ? [] : draft.teamNumbers,
    level: draft.audience === "link" ? "view" : draft.level,
    mode: draft.mode,
    expiresAt: expiryInstant(draft.expiry, nowMs),
    includeCommands: draft.includeCommands,
    includeTitle: draft.includeTitle,
  };
}

/**
 * The choices the projection is built with. The level is the one the share really has, so an
 * anyone-with-the-link share is always projected at the view level, whatever the draft once said.
 * `autoName` is the name the dialog calls the auto (`autoNameOf`), which the projection keeps only
 * when "Include the auto's name" is ticked.
 */
export function draftProjectionChoice(draft: ShareDraft, autoName?: string): ProjectionChoice {
  const title = autoName?.trim() ?? "";
  return {
    level: draft.audience === "link" ? "view" : draft.level,
    coarsen: draft.coarsen,
    ...(draft.includeCommands ? { includeCommands: true } : {}),
    ...(draft.includeTitle && title !== "" ? { title } : {}),
  };
}

/** The team library revision a share is made from: its id and its number. */
export interface SharedRevision {
  id: string;
  n: number;
}

/**
 * The request `createShare` stores for a draft. `autoId` and `revision` are the open auto's in the
 * team library; `projection` is the canonical text of the projection built with
 * `draftProjectionChoice(draft)`, the same one "See it as they will" shows. The request also
 * carries the draft's options as the sharer's choices, which the cloud keeps sealed for the sharing
 * team and every later rebuild of the projection reads; the name kept is the one the projection
 * carries.
 */
export function draftToRequest(
  draft: ShareDraft,
  autoId: string,
  revision: SharedRevision,
  nowMs: number,
  projection: string,
): ShareRequest {
  const settings = draftSettings(draft, nowMs);
  return {
    autoId,
    audience: settings.audience,
    teamNumbers: [...settings.teamNumbers],
    level: settings.level,
    mode: settings.mode,
    revision: revision.n,
    revisionId: revision.id,
    expiresAt: settings.expiresAt === null ? null : String(settings.expiresAt),
    projection,
    choice: {
      coarsen: draft.coarsen,
      includeCommands: draft.includeCommands,
      title: draft.includeTitle ? projectionTitle(projection) : null,
    },
  };
}

/** Why the draft cannot be shared yet, as a sentence, or null when it can. */
export function whyCannotShare(draft: ShareDraft, nowMs: number): string | null {
  if (draft.audience === "teams" && draft.teamNumbers.length === 0) {
    return "Add at least one team number first.";
  }
  if (draft.audience === "teams") {
    const tooMany = teamLimitProblem(draft.teamNumbers.length);
    if (tooMany !== null) return tooMany;
  }
  const expires = expiryInstant(draft.expiry, nowMs);
  if (expires === null) return "Pick the date the share ends.";
  if (Date.parse(expires) <= nowMs) return "The end date has already passed. Pick a later one.";
  return null;
}

/** A switch of audience. A link is view only, so switching to one takes the level back to view. */
export function withAudience(draft: ShareDraft, audience: Audience): ShareDraft {
  return { ...draft, audience, level: audience === "link" ? "view" : draft.level };
}

export type TeamNumberResult = { ok: true; teamNumber: number } | { ok: false; why: string };

/**
 * Reads a team number typed into the dialog with `readTeamNumber`, the app's one rule for one; the
 * sharer's own team already sees the auto, and a team already on the list is not added twice.
 */
export function parseTeamNumber(
  text: string,
  draft: ShareDraft,
  ownTeamNumber: number | null,
): TeamNumberResult {
  const read = readTeamNumber(text);
  if (!read.ok) return read;
  const { teamNumber } = read;
  if (teamNumber === ownTeamNumber) return { ok: false, why: "That is your own team, which already sees this auto." };
  if (draft.teamNumbers.includes(teamNumber)) return { ok: false, why: `Team ${String(teamNumber)} is already on the list.` };
  if (draft.teamNumbers.length >= SHARE_TEAM_LIMIT) {
    return {
      ok: false,
      why: `One share can name at most ${String(SHARE_TEAM_LIMIT)} teams. Share with these first, then make a second share for team ${String(teamNumber)}.`,
    };
  }
  return { ok: true, teamNumber };
}

export const addTeam = (draft: ShareDraft, teamNumber: number): ShareDraft =>
  draft.teamNumbers.includes(teamNumber) ? draft : { ...draft, teamNumbers: [...draft.teamNumbers, teamNumber] };

export const removeTeam = (draft: ShareDraft, teamNumber: number): ShareDraft => ({
  ...draft,
  teamNumbers: draft.teamNumbers.filter((number) => number !== teamNumber),
});

/**
 * The Extend choices on a Sharing page row, the same ones the team's invites offer
 * (`account/ExpiryPicker.tsx`): more calendar days, or a date and time on this computer's clock.
 */
export type ExtendChoice = InviteExpiryChoice;

/** The more-days choices, as one-click presets. */
export const EXTEND_CHOICES: ReadonlyArray<{ id: string; label: string; choice: ExtendChoice }> = [
  { id: "1", label: "1 more day", choice: { kind: "days", days: 1 } },
  { id: "7", label: "7 more days", choice: { kind: "days", days: 7 } },
  { id: "30", label: "30 more days", choice: { kind: "days", days: 30 } },
];

/**
 * The new expiry after an extension, or null when there is none to give. More days count from the
 * current expiry, or from now when it has already passed, so extending never shortens a share. A
 * picked date and time must be later than both the current expiry and now (`extendedMs`, which the
 * team's invites use too); one that is not, or is not a date and time, gives null. A share with no
 * end date keeps none. The rules set no longest time a share or invite may run.
 */
export function extendedExpiry(current: string | null, choice: ExtendChoice, nowMs: number): string | null {
  if (current === null) return null;
  const next = extendedMs(Date.parse(current), choice, nowMs);
  return next === null ? null : new Date(next).toISOString();
}

/** Why an extension cannot be applied, as a sentence for the Apply button, or null when it can. */
export function whyCannotExtend(current: string | null, choice: ExtendChoice, nowMs: number): string | null {
  if (current === null) return "This has no end date, so there is nothing to extend.";
  if (choice.kind === "days") return null;
  const at = localDateTimeMs(choice.local);
  if (at === null) return "Pick the date and time it should end.";
  if (at <= nowMs) return "That time has already passed. Pick a later one.";
  if (at <= Date.parse(current)) return "That is not later than when it ends now. Pick a later time.";
  return null;
}

/** A team library revision as "newer version not shared" compares it: its id, number and time. */
export interface LibraryRevisionLike {
  id: string;
  n: number;
  createdAt: Date;
}

/**
 * The newest revision of a share's auto in the team library, when the share is pinned, still in
 * force and on an older one (spec 13 section 8.3): what "A newer version is not shared" and Update
 * share offer. Newer means a higher number, or the same number published later (a diverged
 * sibling). Null when the share is up to date, follows the latest version, was revoked or has
 * ended, or the library holds no revision of the auto.
 */
export function newerRevisionFor<R extends LibraryRevisionLike>(
  share: Pick<Share, "mode" | "revision" | "revisionId" | "revokedAt" | "expiresAt">,
  revisions: readonly R[],
  nowMs: number,
): R | null {
  if (share.mode !== "pinned" || share.revokedAt !== null) return null;
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= nowMs) return null;
  let latest: R | null = null;
  for (const revision of revisions) {
    if (latest === null || revision.n > latest.n || (revision.n === latest.n && revision.createdAt.getTime() > latest.createdAt.getTime())) {
      latest = revision;
    }
  }
  if (latest === null || latest.id === share.revisionId) return null;
  const shared = revisions.find((revision) => revision.id === share.revisionId);
  if (shared === undefined) return latest.n > share.revision ? latest : null;
  const newer = latest.n > shared.n || (latest.n === shared.n && latest.createdAt.getTime() > shared.createdAt.getTime());
  return newer ? latest : null;
}

/**
 * The address an anyone-with-the-link share opens at: `…/#/s/<secret>` (section 8.5). The share's
 * key is derived from the secret (spec 14), so it goes after the `#`, which a browser never sends.
 */
export function shareLink(secret: string, appBase: string): string {
  const url = appBase.replace(/#.*$/, "");
  const query = url.indexOf("?");
  const path = query < 0 ? url : url.slice(0, query);
  const search = query < 0 ? "" : url.slice(query);
  return `${path.replace(/\/?$/, "/")}${search}#/s/${secret}`;
}

/**
 * Where the app's links point: its own address, and `?cloud=fake` when the page runs the fake
 * cloud from its address, so a link opened in the same browser opens in the same fake cloud. The
 * real cloud's links carry no query at all, and a release build, which has no fake cloud, never does.
 */
export function shareLinkBase(location: { origin: string; search: string }, baseUrl: string): string {
  const fake = import.meta.env.DEV && new URLSearchParams(location.search).get("cloud") === "fake";
  return `${location.origin}${baseUrl}${fake ? "?cloud=fake" : ""}`;
}

/**
 * The link secret in a `#/s/<secret>` address, or null for any other. A secret is 128 random bits
 * as 22 base64url characters.
 */
export function parseShareHash(hash: string): string | null {
  const match = /^#\/s\/([A-Za-z0-9_-]{22})$/.exec(hash.trim());
  return match === null ? null : (match[1] ?? null);
}

/** What the app says when it is opened at an invite or share link that is not a whole one. */
export const BROKEN_LINK = "That link is not complete. Check it, or ask for a new one.";

/**
 * True for an address that starts like an invite (`#/join/`) or a share link (`#/s/`) but is not a
 * whole one, most often because it was cut short when it was copied. Such an address opens nothing,
 * so the app says so (`BROKEN_LINK`) rather than nothing at all.
 */
export function isBrokenLinkHash(hash: string): boolean {
  const trimmed = hash.trim();
  if (trimmed.startsWith("#/join/")) return parseJoinHash(trimmed) === null;
  if (trimmed.startsWith("#/s/")) return parseShareHash(trimmed) === null;
  return false;
}

// ------------------------------------------------------------------------------------------------
// Who may make and change a share
// ------------------------------------------------------------------------------------------------

/** Who is acting on a share: their role in the team, their uid and the team's sharing settings. */
export interface ShareActor {
  role: Role | null;
  uid: string | null;
  settings: Pick<TeamSettings, "editorsMayProposeShare" | "editorsMayLinkShare">;
}

/** The team settings a share is checked against before the team has been read: every default. */
export const DEFAULT_SHARE_SETTINGS: ShareActor["settings"] = { editorsMayProposeShare: false, editorsMayLinkShare: false };

/** The acting member, from the account's state: the role in the selected team, the uid and settings. */
export function shareActorOf(state: Pick<AccountState, "user" | "memberships" | "teamId" | "team">): ShareActor {
  return {
    role: state.memberships.find((membership) => membership.teamId === state.teamId)?.role ?? null,
    uid: state.user?.uid ?? null,
    settings: state.team?.settings ?? DEFAULT_SHARE_SETTINGS,
  };
}

/**
 * Why this member cannot make a share with these settings, or null (spec 13 section 4.3 and its
 * two team settings): the share dialog's check, and the last step of `whyCannotChangeShare`.
 */
export function whyCannotMakeShare(actor: ShareActor, share: { audience: Audience; level: Level }): string | null {
  return whyRoleCannotShare(actor.role, actor.settings, {
    audience: share.audience,
    level: effectiveShareLevel(share),
  });
}

/**
 * Why this member cannot change a share the team made (extend, change its level, pin or follow,
 * update it to a newer version, revoke), or null. The database's rules say: owners and admins change
 * any share; an editor changes only the shares they made; and the share as it would be afterwards
 * must be one this member may make, so an editor cannot raise a share to the propose level, or
 * change an anyone-with-the-link share, unless the team's settings let editors make one. `next` is
 * the level the change would leave the share at, for Allow proposing changes.
 */
export function whyCannotChangeShare(
  actor: ShareActor,
  share: Pick<Share, "audience" | "level" | "createdBy">,
  next: { level?: Level } = {},
): string | null {
  const closed = whyCannotOpenLibrary(actor.role);
  if (closed !== null) return closed;
  if (!isEditorRole(actor.role)) return "Viewers cannot change shares. Ask an admin to make you an editor.";
  if (!isAdminRole(actor.role) && share.createdBy !== actor.uid) {
    return "Only the team's owners and admins, or the editor who made this share, can change it.";
  }
  return whyCannotMakeShare(actor, { audience: share.audience, level: next.level ?? share.level });
}
