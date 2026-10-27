/**
 * The outbox (spec 13 section 6): every write the client makes is listed here from the moment it is
 * applied locally until the server acknowledges or refuses it. Offline, entries stay queued; the
 * store sends them in order when the connection returns.
 *
 * The Firestore SDK keeps queued writes in IndexedDB across restarts, but this list lives in memory:
 * after a reload, writes still queued from the last session are sent by the SDK without appearing
 * here.
 *
 * Signing out drops whatever is still queued: the offline cache that holds those writes is cleared
 * (spec 13 section 6). Those entries become "dropped", not "failed", because the server did not refuse
 * them; it may never have seen them (issue #319). Online, a queued write may already be on its way, so
 * "dropped" means unconfirmed, not certainly unsent, and a later acknowledgement still turns it "sent".
 */
import { CloudError } from "./errors.js";

export type OutboxKind =
  | "profile"
  | "team"
  | "member"
  | "settings"
  | "invite"
  | "auto"
  | "publish"
  | "share"
  | "proposal"
  | "dispute"
  | "admin"
  | "report";

/** "failed": the server refused it. "dropped": signing out on this computer dropped it before the server confirmed it. */
export type OutboxState = "queued" | "sent" | "failed" | "dropped";

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  /** One sentence the Outbox panel shows, such as "Publish revision 4 of an auto." */
  summary: string;
  state: OutboxState;
  queuedAt: Date;
  settledAt: Date | null;
  /** Why the server refused it, or why it was dropped, as a sentence, when `state` is "failed" or "dropped". */
  error: string | null;
}

export interface OutboxStatus {
  online: boolean;
  queued: number;
  failed: number;
  /** Changes dropped by a sign-out before they were sent. */
  dropped: number;
  /** Oldest first. */
  entries: readonly OutboxEntry[];
}

/** What a write call returns: the value as it stands locally, and the outbox entry that sends it. */
export interface Queued<T> {
  value: T;
  outboxId: string;
  /** Settles when the server acknowledges (resolves) or refuses (rejects with a CloudError). */
  sent: Promise<void>;
}

/** The note on an entry that a sign-out dropped. */
export const SIGNED_OUT_NOTE = "Signing out dropped this before the server confirmed it. It may not have reached the server.";

/** A sign-out's drop of the queued entries, which the backend finishes or undoes. */
export interface OutboxDrop {
  /** The sign-out finished: a later rejection of a dropped write changes nothing. */
  done(): void;
  /** The sign-out failed: the entries are queued again, or take what the server said meanwhile. */
  restore(): void;
}

interface Settlement {
  state: OutboxState;
  error: string | null;
}

export type OutboxListener = (status: OutboxStatus) => void;

export class Outbox {
  private readonly entries: OutboxEntry[] = [];
  private readonly listeners = new Set<OutboxListener>();
  /** Entries dropped by a sign-out still in progress, with what the server said about each meanwhile. */
  private readonly dropping = new Map<OutboxEntry, Settlement | null>();
  private counter = 0;

  constructor(
    private readonly now: () => Date,
    private readonly online: () => boolean,
  ) {}

  /** Lists a write and follows its `sent` promise. The promise returned is the same one. */
  track(kind: OutboxKind, summary: string, sent: Promise<void>): { outboxId: string; sent: Promise<void> } {
    this.counter += 1;
    const entry: OutboxEntry = {
      id: `w${String(this.counter)}`,
      kind,
      summary,
      state: "queued",
      queuedAt: this.now(),
      settledAt: null,
      error: null,
    };
    this.entries.push(entry);
    this.notify();
    // Attaching both handlers here also means a caller that ignores `sent` never causes an
    // unhandled rejection.
    sent.then(
      () => this.settle(entry, "sent", null),
      // A "signed-out" rejection stays "failed" with its own words: Firestore says "unauthenticated" for an
      // expired token too, with nobody signing out. Only `dropQueued` marks an entry dropped.
      (error: unknown) =>
        this.settle(entry, "failed", error instanceof CloudError || error instanceof Error ? error.message : String(error)),
    );
    return { outboxId: entry.id, sent };
  }

  status(): OutboxStatus {
    return {
      online: this.online(),
      queued: this.entries.filter((e) => e.state === "queued").length,
      failed: this.entries.filter((e) => e.state === "failed").length,
      dropped: this.entries.filter((e) => e.state === "dropped").length,
      entries: this.entries.map((e) => ({ ...e })),
    };
  }

  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops entries that have been sent. Failed entries stay until the user dismisses them. */
  clearSent(): void {
    this.removeWhere((e) => e.state === "sent");
  }

  dismiss(outboxId: string): void {
    this.removeWhere((e) => e.id === outboxId && e.state !== "queued");
  }

  /**
   * Marks every queued entry as dropped, for a sign-out that clears the writes they stand for. Called
   * before the backend clears them, so a write the SDK rejects while clearing, or never settles, reads
   * as dropped, not refused. The backend calls `done` once the sign-out has finished, or `restore` when
   * it failed and the person is still signed in.
   */
  dropQueued(): OutboxDrop {
    const batch = this.entries.filter((e) => e.state === "queued");
    for (const entry of batch) {
      entry.state = "dropped";
      entry.error = SIGNED_OUT_NOTE;
      entry.settledAt = this.now();
      this.dropping.set(entry, null);
    }
    if (batch.length > 0) this.notify();
    return {
      done: () => {
        for (const entry of batch) this.dropping.delete(entry);
      },
      restore: () => {
        for (const entry of batch) {
          const said = this.dropping.get(entry);
          this.dropping.delete(entry);
          if (entry.state !== "dropped" || said === undefined) continue;
          entry.state = said?.state ?? "queued";
          entry.error = said?.error ?? null;
          entry.settledAt = said === null ? null : this.now();
        }
        if (batch.length > 0) this.notify();
      },
    };
  }

  /** Tells listeners that something about the outbox changed, such as the connection. */
  notify(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  private settle(entry: OutboxEntry, state: OutboxState, error: string | null): void {
    if (entry.state === "dropped" && state !== "sent") {
      // A rejection of a dropped write says nothing new, unless the sign-out fails and `restore` needs it.
      if (this.dropping.has(entry)) this.dropping.set(entry, { state, error });
      return;
    }
    // Acknowledged after all: a write already on its way when the sign-out came did reach the server.
    if (entry.state !== "queued" && entry.state !== "dropped") return;
    this.dropping.delete(entry);
    entry.state = state;
    entry.error = error;
    entry.settledAt = this.now();
    this.notify();
  }

  private removeWhere(test: (entry: OutboxEntry) => boolean): void {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry !== undefined && test(entry)) this.entries.splice(i, 1);
    }
    this.notify();
  }
}
