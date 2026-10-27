/** How the account UI names teams, times and activity, in one place. */
import type { ActivityEntry, Team, TeamStatus } from "@horizon36596/zenith-cloud";
import { shareDateWords } from "@horizon36596/zenith-core";

/** "36596 Horizon", or just the name for a team without a number. */
export function teamLabel(team: Pick<Team, "number" | "name"> | null | undefined): string {
  if (team === null || team === undefined) return "A team that no longer exists";
  return team.number === null ? team.name : `${String(team.number)} ${team.name}`;
}

/**
 * What the Teams sheet says when this account is no longer in a team this device saw it in (`removedFrom` in
 * model.ts). The app cannot tell a removal from leaving on another device or the team being deleted,
 * so it says what it knows.
 */
export function removedFromWords(team: { number: number | null; name: string | null }): string {
  const which = team.name === null ? "a team you were in" : teamLabel({ number: team.number, name: team.name });
  return `You are no longer a member of ${which}. If you did not leave it, an owner or admin removed you or deleted the team. To come back, ask an owner or admin for a new invite.`;
}

/** Spec 13 section 4.2: a number is "unverified" wherever the team's name appears, until checked. */
export const STATUS_WORDS: Record<TeamStatus, string> = {
  unverified: "Unverified",
  verified: "Verified",
  contested: "Contested",
};

/**
 * A team's number status as it reads after the team's name in running text, where the badge
 * (`StatusChip`) does not fit: "Team 12345 (unverified)", "Team 12345 (verified)", and, so that a
 * disputed number cannot be mistaken for a checked one, "Team 12345 (number contested)".
 */
export const STATUS_INLINE: Record<TeamStatus, string> = {
  unverified: "unverified",
  verified: "verified",
  contested: "number contested",
};

/** A team's name with its number status after it, or the name alone when the status is not known. */
export function withTeamStatus(name: string, status: TeamStatus | null | undefined): string {
  return status === null || status === undefined ? name : `${name} (${STATUS_INLINE[status]})`;
}

export const STATUS_DOES: Record<TeamStatus, string> = {
  unverified: "Nobody has checked yet that this team really holds this number. Every feature still works.",
  verified: "A Horizon admin checked that this team holds this number.",
  contested: "Two teams claim this number. A Horizon admin reviews it.",
};

/** "1 change", "3 changes". */
export function waitingChanges(count: number): string {
  return `${String(count)} change${count === 1 ? "" : "s"}`;
}

/**
 * The Outbox's one-line summary. Changes a sign-out dropped are said apart from the sent ones, so
 * "Everything is sent" is never said over a change the server did not confirm (issue #319).
 */
export function outboxSummary(online: boolean, queued: number, dropped: number): string {
  const waiting = online
    ? queued === 0
      ? dropped === 0
        ? "Online. Everything is sent."
        : "Online. Nothing is waiting."
      : `Online. Sending ${waitingChanges(queued)}.`
    : `Offline. ${queued === 0 ? "Nothing is" : `${waitingChanges(queued)} ${queued === 1 ? "is" : "are"}`} waiting to be sent.`;
  return dropped === 0
    ? waiting
    : `${waiting} ${waitingChanges(dropped)} dropped by signing out may not have reached the server.`;
}

/**
 * What Settings says before signing out with changes still in the Outbox: signing out clears the
 * offline cache that holds them (spec 13 section 6). Online, one may already be on its way, so the
 * words say "may", and only an offline person is told to wait for the connection.
 */
export function signOutDropsWords(queued: number, online: boolean): string {
  const one = queued === 1;
  const it = one ? "it" : "them";
  const wait = online
    ? `stay signed in until the Outbox has sent ${it}`
    : `stay signed in until this computer is back online and the Outbox has sent ${it}`;
  return `${waitingChanges(queued)} in the Outbox ${one ? "is" : "are"} not confirmed by the server yet. Signing out clears ${it} from this computer, so ${one ? "it" : "they"} may never reach the server. Your saved auto files stay where they are. To keep ${it}, ${wait}.`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", or the date. */
export function timeAgo(at: Date, nowMs: number): string {
  const seconds = Math.round((nowMs - at.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${String(days)} day${days === 1 ? "" : "s"} ago`;
  return dayWords(at, nowMs);
}

/**
 * The one date format (UI_GUIDE 9.13), in the viewer's own zone, the same words the share sentence
 * uses: "Sat 3 Oct", with the year only when it is not this year ("Mon 3 May 2027"), or always with
 * `year: "always"`, for a page that is kept, such as a printed recovery code.
 */
export function dayWords(at: Date, nowMs: number = Date.now(), options: { year?: "always" } = {}): string {
  const offset = { utcOffsetMinutes: -at.getTimezoneOffset() };
  if (options.year !== "always") return shareDateWords(at.getTime(), nowMs, offset);
  return `${shareDateWords(at.getTime(), at.getTime(), offset)} ${String(at.getFullYear())}`;
}

/** A calendar time in the viewer's own zone: "Sat 3 Oct, 18:30", with the year when it is not this year. */
export function whenWords(at: Date, nowMs: number = Date.now()): string {
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${dayWords(at, nowMs)}, ${clock}`;
}

const ACTIVITY_WORDS: Record<ActivityEntry["kind"], string> = {
  "team.create": "created the team",
  "team.rename": "renamed the team",
  "member.join": "joined",
  "member.approve": "approved a member",
  "member.role": "changed a member's role",
  "member.remove": "removed a member",
  "member.leave": "left the team",
  "invite.create": "made an invite",
  "invite.extend": "extended an invite",
  "invite.revoke": "withdrew an invite",
  "auto.create": "added an auto to the library",
  "revision.publish": "published a revision",
  "share.create": "shared an auto",
  "share.extend": "extended a share",
  "share.revoke": "revoked a share",
  "share.level": "changed a share's level",
  "share.mode": "changed a share's version setting",
  "share.update": "updated a share",
  "proposal.send": "sent a proposal",
  "proposal.decide": "decided a proposal",
  "time.request": "asked another team for more time on a share",
  "time.grant": "gave another team more time on a share",
  "time.decline": "declined another team's request for more time",
  "settings.change": "changed the team's settings",
  "dispute.open": "opened a review of a team number",
  "team.claim": "claimed a team number",
  "dispute.evidence": "added evidence to a team-number review",
  "dispute.appeal": "appealed a team-number decision",
  "verification.request": "asked for the team number to be verified",
  "key.grant": "gave a device the team key",
  "key.rotate": "changed the team key",
  "key.revoke": "took the team key from a device",
  "share.teams": "changed the teams a share goes to",
  "recovery.use": "opened the team with its recovery code",
  "recovery.replace": "made a new recovery code",
};

/** "Ada made an invite" and its detail, for the activity log. */
export function activityWords(entry: ActivityEntry, names: ReadonlyMap<string, string>): string {
  const who = names.get(entry.by) ?? "A former member";
  const what = ACTIVITY_WORDS[entry.kind] ?? entry.kind;
  const detail =
    entry.kind === "member.role" || entry.kind === "member.approve" || entry.kind === "member.join"
      ? entry.detail === undefined
        ? ""
        : ` (${entry.detail})`
      : "";
  return `${who} ${what}${detail}`;
}
