/**
 * The shares this device keeps for offline use, and the link shares opened on it (spec 13 section
 * 6: "Save for offline on a library or a share fetches all of it ahead of an event").
 *
 * The share itself is never copied here. Opening a share reads it through the cloud backend, whose
 * offline cache (Firestore's own, in IndexedDB) then holds it, so a kept share opens again with no
 * connection. What this list adds is the part the cache cannot: which shares the team wants to be
 * sure of at an event, and the address of a link share someone opened, which is otherwise in no
 * list at all. Each entry is the share's id and the team label shown for it, and for a link share
 * its secret, which is what opens it (spec 14: the secret is the link, and the share's key is
 * derived from it).
 *
 * Signing out clears the cloud's cache, so it clears this list too (`AccountModel.signOut`); so
 * does marking the computer as shared, where nothing is kept offline. A visitor who is not signed in
 * keeps the list for the tab only (`keptSharesStorage`).
 *
 * No React and no DOM here: it runs in node against `memoryStorage`.
 */
import { KEYS, type DeviceStorage } from "../account/storage";

export interface KeptShare {
  /** The share's id. */
  id: string;
  /** A link share's secret, the whole of its `#/s/<secret>` link; absent on a share to the team. */
  secret?: string;
  /** Who it is from, as the Partners panel names it: "Team 12345", or "Shared link". */
  label: string;
  /** A share made to the team, or a link share opened on this device. */
  via: "team" | "link";
  /** True when the person asked to keep it for offline use; false for a link only opened. */
  kept: boolean;
}

/**
 * How many opened-but-not-kept links the list remembers, newest first. It is a list to reopen from,
 * not a history: a team at an event opens a handful. Kept entries never count against it.
 */
export const OPENED_LINK_LIMIT = 20;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{22}$/;
const LABEL_LIMIT = 80;

function parse(raw: string | null): KeptShare[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: KeptShare[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const { id, secret, label, via, kept } = item as Record<string, unknown>;
      if (typeof id !== "string" || !ID.test(id) || seen.has(id)) continue;
      if (typeof label !== "string" || (via !== "team" && via !== "link") || typeof kept !== "boolean") continue;
      // A link entry without its secret cannot be opened: it is from before shares were encrypted.
      if (via === "link" && (typeof secret !== "string" || !SECRET.test(secret))) continue;
      seen.add(id);
      out.push({ id, ...(via === "link" ? { secret: secret as string } : {}), label: label.slice(0, LABEL_LIMIT), via, kept });
    }
    return out;
  } catch {
    return [];
  }
}

/** Drops the oldest opened-only links beyond the limit; kept entries all stay. */
function trim(entries: readonly KeptShare[]): KeptShare[] {
  let opened = 0;
  return entries.filter((entry) => {
    if (entry.kept) return true;
    opened += 1;
    return opened <= OPENED_LINK_LIMIT;
  });
}

/**
 * The link shares the Partners panel lists as opened here: every opened or kept link that is not
 * already among the shares made to the team, and none with the cloud off, where nothing can open a
 * share again and the panel shows nothing of the cloud.
 */
export function openedLinksToList(kept: readonly KeptShare[], receivedIds: ReadonlySet<string>, cloudOn: boolean): KeptShare[] {
  if (!cloudOn) return [];
  return kept.filter((entry) => entry.via === "link" && !receivedIds.has(entry.id));
}

/**
 * Where the list is kept. A link's secret is the key to the share (spec 14), so it stays on the
 * device only while someone is signed in on their own device (`keepOnDevice`): then the list is in
 * `onDevice` (`localStorage`), cleared on sign-out. A visitor who is signed out, or on a shared
 * computer, gets `forSession` (`sessionStorage`), which the browser drops when the tab closes.
 */
export function keptSharesStorage(onDevice: DeviceStorage, forSession: DeviceStorage, keepOnDevice: () => boolean): DeviceStorage {
  const pick = (): DeviceStorage => (keepOnDevice() ? onDevice : forSession);
  return {
    get: (key) => pick().get(key),
    set: (key, value) => {
      pick().set(key, value);
    },
    remove: (key) => {
      pick().remove(key);
    },
  };
}

export class KeptShares {
  private readonly listeners = new Set<() => void>();
  private lastRaw: string | null | undefined = undefined;
  private lastList: KeptShare[] = [];

  constructor(private storage: DeviceStorage) {}

  /** Moves the list to other storage: how node tests give the page's instance a memory of its own. */
  useStorage(storage: DeviceStorage): void {
    this.storage = storage;
    this.lastRaw = undefined;
    this.notify();
  }

  /**
   * The list, newest first. The same array while the stored value is unchanged, so React can use
   * it as a snapshot; a value cleared by someone else (signing out) shows at the next read.
   */
  list = (): KeptShare[] => {
    const raw = this.storage.get(KEYS.keptShares);
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.lastList = parse(raw);
    }
    return this.lastList;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isKept(id: string): boolean {
    return this.list().some((entry) => entry.id === id && entry.kept);
  }

  /** A link share was opened here: list it to reopen, newest first, unless it is already listed. */
  recordOpenedLink(share: { id: string; secret: string; label: string }): void {
    const current = this.list();
    const existing = current.find((entry) => entry.id === share.id);
    const entry: KeptShare = existing ?? { id: share.id, secret: share.secret, label: share.label, via: "link", kept: false };
    this.write([{ ...entry, secret: share.secret, via: "link", label: share.label }, ...current.filter((other) => other.id !== share.id)]);
  }

  /**
   * Keeps a share for offline use, or stops keeping it. A team share that is no longer kept leaves
   * the list, since the Partners panel lists it anyway; a link share stays, as one opened here.
   */
  setKept(share: { id: string; secret?: string; label: string; via: "team" | "link" }, kept: boolean): void {
    const current = this.list();
    const rest = current.filter((entry) => entry.id !== share.id);
    const existing = current.find((entry) => entry.id === share.id);
    if (!kept && (existing?.via ?? share.via) === "team") {
      this.write(rest);
      return;
    }
    const secret = share.secret ?? existing?.secret;
    const via = existing?.via === "link" || secret !== undefined ? "link" : share.via;
    if (via === "link" && secret === undefined) return; // Nothing could open it again.
    this.write([{ id: share.id, ...(secret === undefined ? {} : { secret }), label: share.label, via, kept }, ...rest]);
  }

  /** Takes one entry out of the list. */
  forget(id: string): void {
    this.write(this.list().filter((entry) => entry.id !== id));
  }

  clear(): void {
    this.storage.remove(KEYS.keptShares);
    this.notify();
  }

  private write(entries: readonly KeptShare[]): void {
    const next = trim(entries.filter((entry) => ID.test(entry.id) && (entry.via === "team" || SECRET.test(entry.secret ?? ""))));
    if (next.length === 0) this.storage.remove(KEYS.keptShares);
    else this.storage.set(KEYS.keptShares, JSON.stringify(next));
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
