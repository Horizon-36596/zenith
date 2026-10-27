/**
 * The expiry warning (spec 13 section 8.4: "Expiry warnings two days before a share or invite
 * expires, to the team that made it"), with no email and no server job: Zenith runs on the free
 * plan, which sends neither, so the warning is shown in the app. When a signed-in member of the
 * sharing team opens Zenith, or switches to that team, the notice lists every live share and invite
 * of theirs that ends within `EXPIRY_NOTICE_HOURS`, with Extend, which opens the Sharing page.
 *
 * Each line can be dismissed on this device. A dismissal names the item and the end it had, so a
 * share that is extended and later nears its new end is warned about again. Dismissals live in
 * `localStorage` behind `DeviceStorage`, which survives a browser that refuses site data by keeping
 * nothing.
 *
 * Only what the member could act on is listed: a share is listed when they may change it
 * (`whyCannotChangeShare`), and invites are listed only for owners and admins, the only members who
 * can read them.
 */
import { useSyncExternalStore } from "react";
import { isShareActive, timeLeftWords } from "@horizon36596/zenith-core";
import { browserStorage, type DeviceStorage } from "../account/storage";
import type { Invite, ReceivedShare, Share } from "./types";

/**
 * How long before its end a share or invite is listed in the notice, in hours. SET BY HAND: spec 13
 * section 8.4 asks for a warning two days before, and 48 hours is those two days; it is the same
 * window as the Sharing page's "Ends soon" mark (`EXPIRY_WARNING_DAYS` in core), so the notice and
 * the mark never disagree about what is ending.
 */
export const EXPIRY_NOTICE_HOURS = 48;

const MS_PER_HOUR = 3_600_000;

/** Whether something ending at `expiresAt` ends within `EXPIRY_NOTICE_HOURS` of now and has not ended. */
export function endsWithinNotice(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const left = Date.parse(expiresAt) - nowMs;
  return Number.isFinite(left) && left > 0 && left <= EXPIRY_NOTICE_HOURS * MS_PER_HOUR;
}

/** One line of the notice. */
export interface ExpiringItem {
  kind: "share" | "invite";
  /** The share's id or the invite's code. */
  id: string;
  /** For a share, the team library auto it was made from, which Extend opens the Sharing page on. */
  autoId: string | null;
  expiresAt: string;
  /** What a dismissal of this line is stored as: the item and the end it had. */
  key: string;
  /** The line: what it is, and how long it has left. */
  words: string;
}

/** The dismissal key of an item at one end: a later end is a new warning. */
export const noticeKey = (kind: ExpiringItem["kind"], id: string, expiresAt: string): string => `${kind}:${id}@${expiresAt}`;

export interface ExpiringInput {
  shares: readonly Share[];
  invites: readonly Invite[];
  nowMs: number;
  /** Whether the member may change this share (extend it); a share they may not is not listed. */
  mayChange: (share: Share) => boolean;
  /** Whether the member may extend the team's invites. */
  mayExtendInvites: boolean;
  /** How the notice names a share's auto and who it is for. */
  shareLabel: (share: Share) => string;
  /** Dismissed keys on this device. */
  dismissed: ReadonlySet<string>;
}

/** How much of an invite's code a line shows when it has to tell two invites of one role apart. */
const INVITE_CODE_SHOWN = 6;

/** The notice's lines, soonest first: the live shares and invites ending within the window. */
export function expiringItems(input: ExpiringInput): ExpiringItem[] {
  const { nowMs } = input;
  const items: ExpiringItem[] = [];
  for (const share of input.shares) {
    if (share.expiresAt === null || !isShareActive(share, nowMs) || !endsWithinNotice(share.expiresAt, nowMs)) continue;
    // A share whose every team was deleted can no longer be opened, so there is nothing to extend.
    if (share.everyTeamDeleted === true) continue;
    if (!input.mayChange(share)) continue;
    items.push({
      kind: "share",
      id: share.id,
      autoId: share.autoId,
      expiresAt: share.expiresAt,
      key: noticeKey("share", share.id, share.expiresAt),
      words: `${input.shareLabel(share)}: ${timeLeftWords(share.expiresAt, nowMs).toLowerCase()}.`,
    });
  }
  if (input.mayExtendInvites) {
    const listed = input.invites.filter(
      (invite) =>
        !invite.revoked &&
        invite.uses < invite.maxUses &&
        endsWithinNotice(invite.expiresAt, nowMs) &&
        !input.dismissed.has(noticeKey("invite", invite.code, invite.expiresAt)),
    );
    for (const invite of listed) {
      // Two listed invites of one role would read the same: each then names the start of its code.
      const named = listed.some((other) => other !== invite && other.role === invite.role)
        ? ` ${invite.code.slice(0, INVITE_CODE_SHOWN)}…`
        : "";
      items.push({
        kind: "invite",
        id: invite.code,
        autoId: null,
        expiresAt: invite.expiresAt,
        key: noticeKey("invite", invite.code, invite.expiresAt),
        words: `The ${invite.role} invite${named}: ${timeLeftWords(invite.expiresAt, nowMs).toLowerCase()}.`,
      });
    }
  }
  return items
    .filter((item) => !input.dismissed.has(item.key))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.key.localeCompare(b.key));
}

/**
 * The Partners panel's line for a share this team received that ends within the window, so the
 * team can ask for more time; null when it does not end soon.
 */
export function receivedEndingWords(share: Pick<ReceivedShare, "expiresAt">, nowMs: number): string | null {
  if (!endsWithinNotice(share.expiresAt, nowMs)) return null;
  return `Ends soon: ${timeLeftWords(share.expiresAt, nowMs).toLowerCase()}. Ask them for more time if you still need it.`;
}

// ------------------------------------------------------------------------------------------------
// Dismissals on this device
// ------------------------------------------------------------------------------------------------

/** Where the dismissals are kept on this device. */
export const DISMISSED_KEY = "zenith.expiryNotice.dismissed";

/**
 * The most dismissals kept. SET BY HAND: a team rarely has more than a few shares and invites live,
 * so 200 is far more than one device needs, and it keeps the stored list from growing without end.
 */
export const MAX_DISMISSALS = 200;

export interface DismissalStore {
  get(): ReadonlySet<string>;
  dismiss(keys: readonly string[]): void;
  subscribe(listener: () => void): () => void;
}

/** Dismissals kept in `storage`, newest last; a list that cannot be read counts as none. */
export function createDismissals(storage: DeviceStorage): DismissalStore {
  const read = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(storage.get(DISMISSED_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  };
  let current: ReadonlySet<string> = new Set(read());
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    dismiss: (keys) => {
      // Built from this page's dismissals as well as the stored ones: storage that refused an
      // earlier write would otherwise drop that dismissal here and bring its notice back.
      const kept = [...new Set([...read(), ...current])].filter((key) => !keys.includes(key));
      const next = [...kept, ...keys].slice(-MAX_DISMISSALS);
      try {
        storage.set(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // Storage that refuses writes keeps the dismissal for this page only.
      }
      current = new Set(next);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** This page's dismissals, in the browser's storage. */
export const expiryDismissals = createDismissals(browserStorage());

export const useExpiryDismissals = (): ReadonlySet<string> =>
  useSyncExternalStore(expiryDismissals.subscribe, expiryDismissals.get, expiryDismissals.get);
