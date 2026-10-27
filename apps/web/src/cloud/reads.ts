/**
 * Counting the cloud's document reads by the screen that asked for them, in development only (spec
 * 13 sections 7.2 and 13): the free plan allows 50,000 document reads a day, so every screen should
 * read what it needs and no more, and this is how a developer sees what each one costs.
 *
 * What counts as a read, close to how Firestore counts them against the quota:
 *
 * - a get is one read;
 * - a list (a query) is one read per document it returns;
 * - a listener snapshot is one read per document that changed. The cloud client has no listeners
 *   today, so nothing records one yet; `recordSnapshot` is here for the first that does.
 *
 * Only reads the rules allowed are counted: a refused call throws before it returns documents.
 * Writes are not reads and are not counted.
 *
 * Pure: no DOM, no clock and no store. The screen comes from a function the page passes in
 * (`devReadsBackend.ts`), and the store wrapper wraps any `DocStore`. Nothing here reaches a production
 * bundle, because the only module that imports it is loaded behind `import.meta.env.DEV`.
 */
import type { DocStore } from "@horizon36596/zenith-cloud";

export type ReadKind = "get" | "list" | "snapshot";

/** The reads one screen made, by kind; `reads` is their sum. */
export interface ScreenReads {
  screen: string;
  reads: number;
  gets: number;
  lists: number;
  snapshots: number;
}

/** Every read so far: the total, and each screen's share, most reads first. */
export interface ReadsSnapshot {
  total: number;
  byScreen: ScreenReads[];
}

/** How many billed reads one call makes: a get is one, a list or a snapshot one per document. */
export function readsOf(kind: ReadKind, documents: number): number {
  if (kind === "get") return 1;
  if (!Number.isInteger(documents) || documents < 0) throw new Error(`A ${kind} returns a whole number of documents, not ${String(documents)}.`);
  return documents;
}

export class ReadCounter {
  private readonly screens = new Map<string, ScreenReads>();
  private readonly listeners = new Set<() => void>();
  private cached: ReadsSnapshot | null = null;

  /** `screen` names what the app shows at the moment a read is made, such as "Sharing page". */
  constructor(private readonly screen: () => string) {}

  /** Records one call: a get, a list that returned `documents` documents, or a snapshot of that many changes. */
  record(kind: ReadKind, documents = 1): void {
    const reads = readsOf(kind, documents);
    const name = this.screen();
    const entry = this.screens.get(name) ?? { screen: name, reads: 0, gets: 0, lists: 0, snapshots: 0 };
    entry.reads += reads;
    if (kind === "get") entry.gets += reads;
    else if (kind === "list") entry.lists += reads;
    else entry.snapshots += reads;
    this.screens.set(name, entry);
    this.changed();
  }

  /** A listener's snapshot: one read per document added, changed or removed in it. */
  recordSnapshot(changedDocuments: number): void {
    this.record("snapshot", changedDocuments);
  }

  /** The counts so far. The same object until the next read or reset, so React can subscribe to it. */
  snapshot(): ReadsSnapshot {
    if (this.cached === null) {
      const byScreen = [...this.screens.values()]
        .map((entry) => ({ ...entry }))
        .sort((a, b) => b.reads - a.reads || a.screen.localeCompare(b.screen));
      this.cached = { total: byScreen.reduce((sum, entry) => sum + entry.reads, 0), byScreen };
    }
    return this.cached;
  }

  /** Starts counting again from nothing. */
  reset(): void {
    this.screens.clear();
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }
}

/**
 * `inner`, with every successful get and list recorded on `counter`. Commits pass straight through.
 * The wrapper holds no state of its own, so wrapping the same store twice only counts twice.
 */
export function countingStore(inner: DocStore, counter: ReadCounter): DocStore {
  return {
    async get(path) {
      const data = await inner.get(path);
      counter.record("get");
      return data;
    },
    async getWithPending(path) {
      const read = await inner.getWithPending(path);
      counter.record("get");
      return read;
    },
    async list(query) {
      const docs = await inner.list(query);
      counter.record("list", docs.length);
      return docs;
    },
    commit(writes) {
      return inner.commit(writes);
    },
  };
}

/** What the app shows, as the page's stores see it, for naming the screen a read came from. */
export interface ScreenInput {
  /** `window.location.hash`. */
  hash: string;
  /** The sharing sheet that is open, if any. */
  sharingSheet: "share" | "sharing" | "viewer" | null;
  /** The account sheet that is open, if any. */
  accountPanel: "signIn" | "teams" | "library" | "outbox" | null;
  /** Whether the Settings window is open; it covers whatever is under it. */
  settingsOpen?: boolean;
}

const SHARING_SHEET_NAMES = { share: "Share dialog", sharing: "Sharing page", viewer: "Shared auto viewer" } as const;
const ACCOUNT_PANEL_NAMES = {
  signIn: "Sign-in sheet",
  teams: "Teams sheet",
  library: "Team library",
  outbox: "Outbox",
} as const;

/**
 * The screen a read is counted against: the admin page or a share link when the address names one,
 * else the sheet that is open, else the editor itself (where the Partners panel and the toolbar live).
 */
export function screenLabel(input: ScreenInput): string {
  const hash = input.hash.trim();
  if (/^#\/admin\/?$/.test(hash)) return "Admin page";
  if (/^#\/s\//.test(hash)) return "Share link";
  if (input.settingsOpen === true) return "Settings";
  if (input.sharingSheet !== null) return SHARING_SHEET_NAMES[input.sharingSheet];
  if (input.accountPanel !== null) return ACCOUNT_PANEL_NAMES[input.accountPanel];
  return "Editor";
}
