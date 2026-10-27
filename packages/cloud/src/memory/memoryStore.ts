/**
 * An in-memory stand-in for Firestore: `MemoryDatabase` is the server, with the security rules of
 * `rules.ts`; `MemoryStore` is one client's connection to it, with a local cache, an online switch
 * and a queue of writes made offline, sent in order when it comes back online.
 *
 * It copies the Firestore behaviour the client relies on (ADR 0009 section 3): a write applies
 * locally at once and is sent later; reads offline come from what the device has already read or
 * written; a read offline of a document never seen fails as "unavailable"; the server evaluates each
 * write against the rules when it arrives, with `request.time` the arrival time.
 */
import { CloudError, OFFLINE_NOT_SAVED, RULES_REFUSED } from "../errors.js";
import { DELETE_FIELD, lastSegment, SERVER_TIME, type CommitHandle, type DocData, type DocRead, type DocStore, type Query, type StoredDoc, type Write } from "../store.js";
import { allowGet, allowList, allowWrite, valuesEqual, type RuleContext } from "./rules.js";

function resolveServerTime(value: unknown, now: Date): unknown {
  if (value === SERVER_TIME) return new Date(now.getTime());
  if (value instanceof Date) return new Date(value.getTime());
  // Before the object case, which would turn the bytes into a map of their indices.
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map((v) => resolveServerTime(v, now));
  if (value !== null && typeof value === "object") {
    const out: DocData = {};
    for (const [k, v] of Object.entries(value as DocData)) {
      if (v !== undefined) out[k] = resolveServerTime(v, now);
    }
    return out;
  }
  return value;
}

function clone(data: DocData): DocData {
  return structuredClone(data);
}

/** Applies writes to a document map, in order, the way a Firestore batch does. */
function applyWrites(docs: Map<string, DocData>, writes: Write[], now: Date): Set<string> {
  const touched = new Set<string>();
  for (const w of writes) {
    touched.add(w.path);
    if (w.op === "delete") {
      docs.delete(w.path);
    } else if (w.op === "set") {
      docs.set(w.path, resolveServerTime(w.data, now) as DocData);
    } else {
      const current = docs.get(w.path);
      if (current === undefined) throw new CloudError("not-found", `There is no document at ${w.path} to update.`);
      const next: DocData = { ...current, ...(resolveServerTime(w.data, now) as DocData) };
      for (const [k, v] of Object.entries(w.data)) if (v === DELETE_FIELD) delete next[k];
      docs.set(w.path, next);
    }
  }
  return touched;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function collectionIdOf(path: string): string {
  return lastSegment(parentOf(path));
}

function matches(path: string, data: DocData, query: Query): boolean {
  const inCollection = query.group === true ? collectionIdOf(path) === query.collection : parentOf(path) === query.collection;
  return inCollection && (query.where ?? []).every((f) => valuesEqual(data[f.field], f.value));
}

function run(docs: Map<string, DocData>, query: Query): StoredDoc[] {
  const out: StoredDoc[] = [];
  for (const [path, data] of docs) {
    if (matches(path, data, query)) out.push({ path, id: lastSegment(path), data: clone(data) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Who a request comes from: a uid, or null for an unauthenticated caller. */
export type Caller = string | null;

/** A refusal by the rules, worded as the real cloud's (`RULES_REFUSED`). `what` is kept for a debugger, in `cause`. */
const denied = (what: string) =>
  new CloudError("permission-denied", RULES_REFUSED, { cause: new Error(`The rules do not allow this ${what}.`) });

export interface MemoryDatabaseOptions {
  /**
   * The server clock, `request.time`. Tests move it to expire invites and shares. The default is the
   * system clock made strictly increasing, because Firestore stamps commits in microseconds and two
   * commits in one millisecond must still have an order.
   */
  now?: () => Date;
  /**
   * Key-stretching iterations every simulated device on this database derives an approval code's key with.
   * The default is the app's `APPROVAL_KDF_ITERATIONS`, about a third of a second a derivation. A
   * test that approves many devices passes fewer, since the approver and the new device must use
   * the same count; the known-answer test in `crypto.vectors.test.ts` keeps the real one.
   */
  approvalKdfIterations?: number;
  /**
   * The private beta's gate in a new database. "open", the default, seeds `config/access` with
   * `betaOpen: true`, as the owner's console would to open Zenith to everyone, so the web app's fake
   * cloud and every test that does not care about the beta work with no setup. "closed" seeds
   * nothing, like a real project before the owner opens it: only users seeded in
   * `betaTesters/{uid}` or `admins/{uid}` may then create a profile or redeem an invite. `clear()`
   * removes the seeded document with everything else, which leaves the gate closed.
   */
  betaGate?: "open" | "closed";
}

/** What the "open" beta gate seeds: the console's switch, set to open Zenith to everyone. */
const OPEN_BETA: DocData = { betaOpen: true };

function increasingClock(): () => Date {
  let last = 0;
  return () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last);
  };
}

/** The server: every document, and the rules. */
export class MemoryDatabase {
  private readonly docs = new Map<string, DocData>();
  readonly now: () => Date;
  readonly approvalKdfIterations: number | undefined;

  constructor(options: MemoryDatabaseOptions = {}) {
    this.now = options.now ?? increasingClock();
    this.approvalKdfIterations = options.approvalKdfIterations;
    if ((options.betaGate ?? "open") === "open") this.docs.set("config/access", clone(OPEN_BETA));
  }

  /** Writes a document without the rules, like the Firebase console. */
  seed(path: string, data: DocData): void {
    this.docs.set(path, resolveServerTime(data, this.now()) as DocData);
  }

  /** Reads a document without the rules, for test assertions. */
  peek(path: string): DocData | null {
    const data = this.docs.get(path);
    return data === undefined ? null : clone(data);
  }

  /** Every path, sorted, for test assertions. */
  paths(): string[] {
    return [...this.docs.keys()].sort();
  }

  clear(): void {
    this.docs.clear();
  }

  private context(caller: Caller, now: Date, after?: Map<string, DocData>): RuleContext {
    return {
      uid: caller,
      now,
      get: (path) => this.peek(path),
      getAfter: (path) => {
        const data = (after ?? this.docs).get(path);
        return data === undefined ? null : clone(data);
      },
    };
  }

  read(caller: Caller, path: string): DocData | null {
    const doc = this.peek(path);
    if (!allowGet(this.context(caller, this.now()), path, doc)) throw denied("read");
    return doc;
  }

  query(caller: Caller, query: Query): StoredDoc[] {
    if (!allowList(this.context(caller, this.now()), query)) throw denied("list");
    return run(this.docs, query);
  }

  commit(caller: Caller, writes: Write[]): void {
    const now = this.now();
    const after = new Map(this.docs);
    const touched = applyWrites(after, writes, now);
    const ctx = this.context(caller, now, after);
    for (const path of touched) {
      const before = this.peek(path);
      const next = after.get(path) ?? null;
      if (!allowWrite(ctx, path, before, next === null ? null : clone(next))) throw denied(`write to ${path}`);
    }
    this.docs.clear();
    for (const [path, data] of after) this.docs.set(path, data);
  }
}

interface PendingCommit {
  caller: Caller;
  writes: Write[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** One device's connection: a cache of what it has read, and the writes it has not yet sent. */
export class MemoryStore implements DocStore {
  private online = true;
  /** Documents as this device last saw them on the server; null records a missing document. */
  private readonly cache = new Map<string, DocData | null>();
  private readonly pending: PendingCommit[] = [];

  constructor(
    readonly database: MemoryDatabase,
    private readonly auth: () => Caller,
    private readonly localNow: () => Date = () => new Date(),
  ) {}

  isOnline(): boolean {
    return this.online;
  }

  /** Going online sends every queued write, oldest first, and waits until they have settled. */
  async setOnline(online: boolean): Promise<void> {
    this.online = online;
    if (online) await this.flush();
  }

  /** Forgets everything cached and queued, as signing out does. */
  clear(): void {
    this.cache.clear();
    for (const p of this.pending.splice(0)) p.reject(new CloudError("signed-out", "Signed out before this change was sent."));
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** The cache with every queued write applied: what the device shows while offline. */
  private localView(): Map<string, DocData> {
    const view = new Map<string, DocData>();
    for (const [path, data] of this.cache) if (data !== null) view.set(path, data);
    const now = this.localNow();
    for (const p of this.pending) {
      try {
        applyWrites(view, p.writes, now);
      } catch {
        // An update to a document this device never saw; the server will decide.
      }
    }
    return view;
  }

  private remember(path: string, data: DocData | null): void {
    this.cache.set(path, data === null ? null : clone(data));
  }

  async get(path: string): Promise<DocData | null> {
    return (await this.getWithPending(path)).data;
  }

  /** Like the Firestore SDK, a document counts as pending while any queued write touches it. */
  async getWithPending(path: string): Promise<DocRead> {
    const pendingWrites = this.pending.some((p) => p.writes.some((w) => w.path === path));
    if (this.online && this.pending.length === 0) {
      const data = this.database.read(this.auth(), path);
      this.remember(path, data);
      return { data, pendingWrites };
    }
    const view = this.localView();
    const local = view.get(path);
    if (local !== undefined) return { data: clone(local), pendingWrites };
    // A document deleted by a queued write is known to be missing. One the server said was missing
    // is not: like the Firestore SDK, a get offline of a document it never held fails.
    if (this.pending.some((p) => p.writes.some((w) => w.path === path && w.op === "delete"))) return { data: null, pendingWrites };
    if (this.online) {
      const data = this.database.read(this.auth(), path);
      this.remember(path, data);
      return { data, pendingWrites };
    }
    throw new CloudError("unavailable", OFFLINE_NOT_SAVED);
  }

  async list(query: Query): Promise<StoredDoc[]> {
    if (this.online && this.pending.length === 0) {
      const docs = this.database.query(this.auth(), query);
      for (const doc of docs) this.remember(doc.path, doc.data);
      return docs;
    }
    return run(this.localView(), query);
  }

  commit(writes: Write[]): CommitHandle {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const sent = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    sent.catch(() => undefined);
    this.pending.push({ caller: this.auth(), writes: structuredCloneWrites(writes), resolve, reject });
    if (this.online) void this.flush();
    return { sent };
  }

  private flushing: Promise<void> | null = null;

  private flush(): Promise<void> {
    if (this.flushing !== null) return this.flushing;
    // With nothing to send, the loop below finishes before `async` returns, so its `finally` runs
    // before the promise is stored. `done` catches that case; without it a finished flush stayed
    // stored and every later commit waited on it forever.
    let done = false;
    const running = (async () => {
      try {
        while (this.online && this.pending.length > 0) {
          const next = this.pending[0];
          if (next === undefined) break;
          try {
            this.database.commit(next.caller, next.writes);
            for (const w of next.writes) this.remember(w.path, this.database.peek(w.path));
            this.pending.shift();
            next.resolve();
          } catch (error) {
            this.pending.shift();
            next.reject(error);
          }
          await Promise.resolve();
        }
      } finally {
        done = true;
        this.flushing = null;
      }
    })();
    this.flushing = done ? null : running;
    return running;
  }
}

function structuredCloneWrites(writes: Write[]): Write[] {
  // SERVER_TIME and DELETE_FIELD are symbols, which structuredClone cannot copy, so copy by hand.
  const copy = (value: unknown): unknown => {
    if (value === SERVER_TIME) return SERVER_TIME;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as DocData).map(([k, v]) => [k, copy(v)]));
    }
    return value;
  };
  return writes.map((w) => (w.op === "delete" ? { ...w } : { ...w, data: copy(w.data) as DocData }));
}
