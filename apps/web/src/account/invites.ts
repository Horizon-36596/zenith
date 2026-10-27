/**
 * Invite expiry and the join link, with no React in it so it is tested in node.
 *
 * Expiries are calendar times only (the owner's ruling of 2026-09-27 on teams and sharing): 1 day,
 * 7 days, 30 days, or a date and time the sender picks. There is no "end of the season": nothing
 * records when a season ends.
 */
import type { Invite } from "@horizon36596/zenith-cloud";

export type InviteExpiryChoice =
  | { kind: "days"; days: 1 | 7 | 30 }
  /** A local date and time as an `<input type="datetime-local">` gives it: `YYYY-MM-DDTHH:MM`. */
  | { kind: "at"; local: string };

export const MS_PER_DAY = 86_400_000;

/** SPEC: spec 13 section 2, answer 3: invites last 7 days by default. */
export const DEFAULT_INVITE_EXPIRY: InviteExpiryChoice = { kind: "days", days: 7 };

export const EXPIRY_PRESETS: ReadonlyArray<{ days: 1 | 7 | 30; label: string; does: string }> = [
  { days: 1, label: "1 day", does: "The invite stops working 24 hours from now." },
  { days: 7, label: "7 days", does: "The invite stops working a week from now. The default." },
  { days: 30, label: "30 days", does: "The invite stops working 30 days from now." },
];

/** A `datetime-local` value as epoch milliseconds on this computer's clock, or null. */
export function localDateTimeMs(local: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour) {
    return null;
  }
  return at.getTime();
}

/** The instant a choice ends at, in epoch milliseconds, or null when the date and time is not one. */
export function expiryMs(choice: InviteExpiryChoice, nowMs: number): number | null {
  if (choice.kind === "days") return nowMs + choice.days * MS_PER_DAY;
  return localDateTimeMs(choice.local);
}

/** Why an invite with these settings cannot be made, or null. */
export function whyCannotCreateInvite(choice: InviteExpiryChoice, maxUses: number, nowMs: number): string | null {
  const ends = expiryMs(choice, nowMs);
  if (ends === null) return "Pick the date and time the invite ends.";
  if (ends <= nowMs) return "That time has already passed. Pick a later one.";
  if (!Number.isInteger(maxUses) || maxUses < 1) return "An invite needs at least one use.";
  return null;
}

/** The seconds from now `CloudBackend.createInvite` takes. */
export function expiresInSeconds(choice: InviteExpiryChoice, nowMs: number): number | null {
  const ends = expiryMs(choice, nowMs);
  return ends === null ? null : Math.round((ends - nowMs) / 1000);
}

/**
 * The new end of an invite after Extend. More days count from its current end, or from now when that
 * has passed, so extending never shortens it; a picked time must be later than both.
 */
export function extendedMs(currentMs: number, choice: InviteExpiryChoice, nowMs: number): number | null {
  if (choice.kind === "days") return Math.max(currentMs, nowMs) + choice.days * MS_PER_DAY;
  const at = localDateTimeMs(choice.local);
  if (at === null || at <= Math.max(currentMs, nowMs)) return null;
  return at;
}

export type InviteState = "live" | "expired" | "revoked" | "usedUp";

export function inviteState(
  invite: Pick<Invite, "revoked" | "expiresAt" | "uses" | "maxUses">,
  nowMs: number,
): InviteState {
  if (invite.revoked) return "revoked";
  if (invite.uses >= invite.maxUses) return "usedUp";
  if (invite.expiresAt.getTime() <= nowMs) return "expired";
  return "live";
}

const plural = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? "" : "s"}`;

/** "3 days left", "5 hours left", "12 minutes left", "Less than a minute left", or "Ended". */
export function timeLeftWords(endsMs: number, nowMs: number): string {
  const left = endsMs - nowMs;
  if (left <= 0) return "Ended";
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return "Less than a minute left";
  if (minutes < 60) return `${plural(minutes, "minute")} left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} left`;
  // Rounded, so an invite made for 7 days says "7 days left" rather than "6" a moment later.
  return `${plural(Math.round(minutes / (60 * 24)), "day")} left`;
}

/** What an invite row says about its state. */
export function inviteStateWords(invite: Invite, nowMs: number): string {
  switch (inviteState(invite, nowMs)) {
    case "revoked":
      return "Revoked";
    case "usedUp":
      return "Used up";
    case "expired":
      return "Ended";
    case "live":
      return timeLeftWords(invite.expiresAt.getTime(), nowMs);
  }
}

/**
 * The address an invite opens at: `…/#/join/<code>`. A page running the fake cloud from its address
 * keeps `?cloud=fake`, so the link opens in the same fake cloud; every other query is dropped. A
 * release build has no fake cloud, so its links never carry it.
 */
export function joinLink(code: string, pageUrl: string): string {
  const withoutHash = pageUrl.replace(/#.*$/, "");
  const query = withoutHash.indexOf("?");
  const base = query < 0 ? withoutHash : withoutHash.slice(0, query);
  const fake = import.meta.env.DEV && query >= 0 && new URLSearchParams(withoutHash.slice(query)).get("cloud") === "fake";
  return `${base}${fake ? "?cloud=fake" : ""}#/join/${code}`;
}

/** The invite code in `#/join/<code>`, or null for any other address. */
export function parseJoinHash(hash: string): string | null {
  const match = /^#\/join\/([A-Za-z0-9_-]{8,64})$/.exec(hash.trim());
  return match === null ? null : (match[1] ?? null);
}

/** A local `datetime-local` value for an instant, for prefilling the picker. */
export function toLocalInput(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
