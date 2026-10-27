/**
 * The words that say what a share does (spec 13 section 8.4): the one
 * sentence the share dialog leads with, the sharing chip on every auto, and the time left on a row
 * of the Sharing page.
 *
 * The share dialog and the Sharing page both build their sentence here from the same settings the
 * share is stored with, so what the dialog promised and what was stored can never read differently
 * (the M-C3 contract in section 16).
 *
 * Pure, like the rest of core: there is no clock here. Every function that needs the time takes
 * `now`, and every instant is an ISO 8601 string or epoch milliseconds. Calendar dates are shown in
 * the viewer's time zone only when the caller passes its offset, because core cannot read one.
 */

/** What the other team may do: look, or look and propose changes (section 8.1). */
export type ShareLevel = "view" | "propose";
/** Who the share is for: named teams, or anyone who has the link (section 8.1). */
export type ShareAudience = "teams" | "link";
/** Whether the share stays on the version it was made from, or follows each publish (section 8.3). */
export type ShareMode = "pinned" | "follow";
/** An instant, as an ISO 8601 string or epoch milliseconds. */
export type Instant = string | number;

/** The settings a share sentence describes: exactly the fields the stored share carries. */
export interface ShareSettings {
  audience: ShareAudience;
  /** The FTC team numbers the share is for. Ignored when `audience` is `"link"`. */
  teamNumbers: readonly number[];
  level: ShareLevel;
  mode: ShareMode;
  /** When the share stops working, or null for a share with no end date. */
  expiresAt: Instant | null;
  /**
   * Whether the projection names each command and its arguments ("Include command names", owner
   * ruling 2026-09-27). Absent means off, which is the default.
   */
  includeCommands?: boolean;
  /**
   * Whether the projection keeps the auto's own name ("Include the auto's name", spec 13 section
   * 8.2: "the auto's title if the sharer keeps it"). Absent means off, which is the default.
   */
  includeTitle?: boolean;
}

/** A share as the chip and the Sharing page see it: its settings and whether it was revoked. */
export interface ShareRecord extends ShareSettings {
  revokedAt: Instant | null;
}

/** Options for the calendar words in a sentence. */
export interface DateWordsOptions {
  /**
   * The viewer's offset from UTC in minutes, east positive (UTC+1 is 60), at the instant being
   * shown. Defaults to 0, so dates read in UTC unless the caller says otherwise.
   */
  utcOffsetMinutes?: number;
}

/**
 * How long before its expiry a share or invite is flagged as ending soon, in days. SPEC: section 8.4,
 * "Expiry warnings two days before a share or invite expires".
 */
export const EXPIRY_WARNING_DAYS = 2;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Epoch milliseconds for an instant. Throws on a string that is not a date. */
export function instantMs(at: Instant): number {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`"${String(at)}" is not a date and time.`);
  return ms;
}

/**
 * The level a share really has. Anyone-with-the-link shares are view only (section 8.1), so a link
 * that somehow carries `"propose"` is described, and must be treated, as view.
 */
export function effectiveShareLevel(settings: Pick<ShareSettings, "audience" | "level">): ShareLevel {
  return settings.audience === "link" ? "view" : settings.level;
}

/** The distinct team numbers of a share, in the order they were added. */
function distinctTeams(numbers: readonly number[]): number[] {
  return numbers.filter((number, index) => numbers.indexOf(number) === index);
}

/** "12345", "12345 and 23456", "12345, 23456 and 34567". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

function calendar(ms: number, utcOffsetMinutes: number): CalendarParts {
  const shifted = new Date(ms + utcOffsetMinutes * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * A calendar date the way the share dialog says it: "Sat 4 Oct", with the year only when it is not
 * the year of `now` ("Mon 3 May 2027").
 */
export function shareDateWords(at: Instant, now: Instant, options: DateWordsOptions = {}): string {
  const offset = options.utcOffsetMinutes ?? 0;
  const date = calendar(instantMs(at), offset);
  const today = calendar(instantMs(now), offset);
  const words = `${WEEKDAYS[date.weekday] ?? ""} ${String(date.day)} ${MONTHS[date.month] ?? ""}`;
  return date.year === today.year ? words : `${words} ${String(date.year)}`;
}

/** "until Sat 4 Oct", or "until 17:30 today" for a share that ends later the same day. */
function untilWords(expiresMs: number, nowMs: number, options: DateWordsOptions): string {
  const offset = options.utcOffsetMinutes ?? 0;
  const end = calendar(expiresMs, offset);
  const today = calendar(nowMs, offset);
  if (end.year === today.year && end.month === today.month && end.day === today.day) {
    const clock = `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`;
    return `until ${clock} today`;
  }
  return `until ${shareDateWords(expiresMs, nowMs, options)}`;
}

/**
 * The one sentence the share dialog leads with (section 8.4): who can do what with this auto, until
 * when, which version they see, what they never see, and whether they can propose changes. It
 * changes as the settings change, and the Sharing page shows the same sentence for a stored share.
 *
 * "Team 12345 can view this auto until Sat 4 Oct. They will see this version: where your robot
 * drives and when. They will not see command names, notes or any robot settings. They cannot
 * propose changes."
 *
 * With `includeCommands` the third sentence says the opposite, plainly: "They will see command
 * names and their settings, but not your code, notes or any robot settings."
 *
 * With `includeTitle` the third sentence names the auto's name first: "They will see this auto's
 * name, but not command names, notes or any robot settings.", or with both options on, "They will
 * see this auto's name, command names and their settings, but not your code, notes or any robot
 * settings." With it off the sentence is exactly what it was before the option existed.
 *
 * A share to no teams yet, and a share whose expiry has passed, get their own sentence rather
 * than a misleading one. An anyone-with-the-link share is always described at the view level
 * (`effectiveShareLevel`).
 */
export function shareSentence(settings: ShareSettings, now: Instant, options: DateWordsOptions = {}): string {
  const nowMs = instantMs(now);
  const teams = distinctTeams(settings.teamNumbers);
  if (settings.audience === "teams" && teams.length === 0) {
    return "Nobody outside your team can see this auto yet. Add a team number to share it with that team.";
  }

  const level = effectiveShareLevel(settings);
  const who =
    settings.audience === "link"
      ? "Anyone with the link"
      : `${teams.length === 1 ? "Team" : "Teams"} ${listWords(teams.map(String))}`;
  const does = level === "propose" ? "view this auto and propose changes to it" : "view this auto";
  const noSignIn = settings.audience === "link" ? ", without signing in" : "";

  const expiresMs = settings.expiresAt === null ? null : instantMs(settings.expiresAt);
  if (expiresMs !== null && expiresMs <= nowMs) {
    return `This share has ended: ${who} could ${does} until ${shareDateWords(expiresMs, nowMs, options)}, and no longer can. Extend it to share this auto again.`;
  }
  const until = expiresMs === null ? "until you stop sharing it" : untilWords(expiresMs, nowMs, options);

  const version =
    settings.mode === "pinned"
      ? "this version"
      : "the latest version, updated each time you publish";
  const what =
    level === "propose"
      ? "where your robot drives and when, and the order and shape of its steps"
      : "where your robot drives and when";
  const propose =
    level === "propose"
      ? "They can propose changes, and none is kept until you accept it."
      : "They cannot propose changes.";

  const names = namesSentence(settings.includeCommands === true, settings.includeTitle === true);

  return [`${who} can ${does} ${until}${noSignIn}.`, `They will see ${version}: ${what}.`, names, propose].join(" ");
}

/** The third sentence of `shareSentence`: what they will and will not see of the auto's words. */
function namesSentence(commands: boolean, title: boolean): string {
  if (commands && title) {
    return "They will see this auto's name, command names and their settings, but not your code, notes or any robot settings.";
  }
  if (commands) return "They will see command names and their settings, but not your code, notes or any robot settings.";
  if (title) return "They will see this auto's name, but not command names, notes or any robot settings.";
  return "They will not see command names, notes or any robot settings.";
}

/** Whether a share is in force at `now`: not revoked, and not past its expiry. */
export function isShareActive(share: ShareRecord, now: Instant): boolean {
  if (share.revokedAt !== null) return false;
  return share.expiresAt === null || instantMs(share.expiresAt) > instantMs(now);
}

/**
 * Whether something that expires at `expiresAt` ends within `EXPIRY_WARNING_DAYS` of `now` and has
 * not ended yet: the Sharing page's expiry warning (section 8.4). Never true for no end date.
 */
export function expiresSoon(expiresAt: Instant | null, now: Instant): boolean {
  if (expiresAt === null) return false;
  const left = instantMs(expiresAt) - instantMs(now);
  return left > 0 && left <= EXPIRY_WARNING_DAYS * MS_PER_DAY;
}

/**
 * Time left before an expiry, in the Sharing page's words: "No end date", "Ended", "Under an hour
 * left", "5 hours left", "1 day left", "12 days left". Whole units, rounded down, so it never says
 * more time is left than there is.
 */
export function timeLeftWords(expiresAt: Instant | null, now: Instant): string {
  if (expiresAt === null) return "No end date";
  const left = instantMs(expiresAt) - instantMs(now);
  if (left <= 0) return "Ended";
  if (left < MS_PER_HOUR) return "Under an hour left";
  if (left < MS_PER_DAY) {
    const hours = Math.floor(left / MS_PER_HOUR);
    return `${String(hours)} ${hours === 1 ? "hour" : "hours"} left`;
  }
  const days = Math.floor(left / MS_PER_DAY);
  return `${String(days)} ${days === 1 ? "day" : "days"} left`;
}

/** The chip's three states, which the editor gives a colour and an icon each (section 8.4). */
export type SharingTone = "team" | "teams" | "link";

export interface SharingChip {
  /** "Team only", "Shared with 1 team", "Shared with 2 teams", "Anyone with the link". */
  label: string;
  tone: SharingTone;
  /**
   * One line per share in force, for the chip's tooltip: who, what and until when. "Team 12345
   * can view until Sat 4 Oct." Empty for team only.
   */
  lines: string[];
}

/**
 * The sharing chip for one auto (section 8.4), from every share it has ever had: revoked and
 * expired shares do not count. Anyone with the link wins over specific teams, because it is the
 * wider audience and the one a sharer must never overlook; the specific teams are still listed in
 * the tooltip.
 */
export function sharingChip(
  shares: readonly ShareRecord[],
  now: Instant,
  options: DateWordsOptions = {},
): SharingChip {
  const nowMs = instantMs(now);
  const active = shares.filter((share) => isShareActive(share, nowMs));
  const lines = active.map((share) => {
    const teams = distinctTeams(share.teamNumbers);
    const who =
      share.audience === "link"
        ? "Anyone with the link"
        : `${teams.length === 1 ? "Team" : "Teams"} ${listWords(teams.map(String))}`;
    const level = effectiveShareLevel(share) === "propose" ? "view and propose" : "view";
    const until =
      share.expiresAt === null ? "with no end date" : untilWords(instantMs(share.expiresAt), nowMs, options);
    return `${who} can ${level} ${until}.`;
  });

  if (active.some((share) => share.audience === "link")) {
    return { label: "Anyone with the link", tone: "link", lines };
  }
  const teams = distinctTeams(active.flatMap((share) => share.teamNumbers));
  if (teams.length === 0) return { label: "Team only", tone: "team", lines: [] };
  return {
    label: `Shared with ${String(teams.length)} ${teams.length === 1 ? "team" : "teams"}`,
    tone: "teams",
    lines,
  };
}
