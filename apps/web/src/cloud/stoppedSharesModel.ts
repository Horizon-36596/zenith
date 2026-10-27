/**
 * The shares a team made that stopped when its key changed, and "Share again", as the owner decided:
 * which stopped shares the Sharing page lists, and the share dialog's settings for sharing one again.
 *
 * The cloud says which shares stopped, from the team's own signed device roster, and with the terms
 * the team's own key signed (`listStoppedShares`). What this file adds is only when to stop listing
 * one: once a live share made after it carries the same auto, audience, teams, level and version
 * mode, on any device, or once this device shared it again. Nothing here makes a share: "Share
 * again" opens the share dialog with these settings, so the person sees who it goes to and each new
 * team's safety code, as for any share.
 *
 * No React and no DOM here: it runs in node against `memoryStorage`.
 */
import { isShareActive } from "@horizon36596/zenith-core";
import { KEYS, type DeviceStorage } from "../account/storage";
import { DEFAULT_DRAFT, type ShareDraft } from "./shareModel";
import type { Share, StoppedShare } from "./types";

/** How many shared-again ids a team keeps on this device, newest last. */
const SHARED_AGAIN_LIMIT = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => {
  const left = [...new Set(a)].sort((x, y) => x - y);
  const right = [...new Set(b)].sort((x, y) => x - y);
  return left.length === right.length && left.every((number, index) => number === right[index]);
};

/**
 * True when `share` is a live share made after `stopped` that carries its auto, audience, teams,
 * level and version mode: the team already shared it again, here or on another device.
 */
export function sharesAgain(share: Share, stopped: StoppedShare, nowMs: number): boolean {
  return (
    share.id !== stopped.id &&
    isShareActive(share, nowMs) &&
    share.createdAt > stopped.createdAt &&
    share.autoId === stopped.autoId &&
    share.audience === stopped.audience &&
    share.mode === stopped.mode &&
    (share.audience === "link" || (share.level === stopped.level && sameNumbers(share.teamNumbers, stopped.teamNumbers)))
  );
}

/**
 * The stopped shares the Sharing page lists: those not shared again, by a live share (`sharesAgain`)
 * or on this device (`sharedAgainIds`), and not ended. `autoId` narrows them to one auto.
 */
export function stoppedToList(
  stopped: readonly StoppedShare[],
  shares: readonly Share[],
  sharedAgainIds: ReadonlySet<string>,
  nowMs: number,
  autoId: string | null = null,
): StoppedShare[] {
  return stopped.filter(
    (entry) =>
      (autoId === null || entry.autoId === autoId) &&
      Date.parse(entry.expiresAt) > nowMs &&
      !sharedAgainIds.has(entry.id) &&
      !shares.some((share) => sharesAgain(share, entry, nowMs)),
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The share dialog's settings for sharing `stopped` again: its audience, teams, level, version mode
 * and end, on this computer's clock (to the minute, or the end of the day when it ended then). The
 * projection options start at their most private defaults, since the stopped share's own choices
 * are sealed where the team no longer opens them.
 */
export function shareAgainDraft(stopped: StoppedShare): ShareDraft {
  const end = new Date(stopped.expiresAt);
  const date = `${String(end.getFullYear())}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
  const endOfDay = end.getHours() === 23 && end.getMinutes() === 59 && end.getSeconds() === 59;
  return {
    ...DEFAULT_DRAFT,
    audience: stopped.audience,
    teamNumbers: stopped.audience === "link" ? [] : [...stopped.teamNumbers],
    level: stopped.audience === "link" ? "view" : stopped.level,
    mode: stopped.mode,
    expiry: endOfDay ? { kind: "date", date } : { kind: "date", date, time: `${pad(end.getHours())}:${pad(end.getMinutes())}` },
  };
}

/** The ids of a team's stopped shares that this device shared again, kept in `storage`. */
export class SharedAgain {
  constructor(private readonly storage: DeviceStorage) {}

  private key(teamId: string): string {
    return `${KEYS.sharedAgainPrefix}${teamId}`;
  }

  ids(teamId: string): Set<string> {
    const raw = this.storage.get(this.key(teamId));
    if (raw === null) return new Set();
    try {
      const value: unknown = JSON.parse(raw);
      return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && ID.test(id)) : []);
    } catch {
      return new Set();
    }
  }

  add(teamId: string, id: string): void {
    if (!ID.test(id)) return;
    const ids = [...this.ids(teamId)].filter((kept) => kept !== id);
    ids.push(id);
    this.storage.set(this.key(teamId), JSON.stringify(ids.slice(-SHARED_AGAIN_LIMIT)));
  }
}
