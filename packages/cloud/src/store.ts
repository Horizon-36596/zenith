/**
 * The small document-store surface the cloud client is written against. Two stores implement it: the
 * Firestore one (`firebase/firestoreStore.ts`) and the in-memory one (`memory/memoryStore.ts`), which
 * applies a TypeScript copy of the security rules. Because the client code is shared, the two
 * backends differ only in where documents live and who checks the rules.
 */

/** A placeholder the store replaces with the server's commit time (Firestore's `serverTimestamp()`). */
export const SERVER_TIME: unique symbol = Symbol("zenith.cloud.serverTime");
export type ServerTime = typeof SERVER_TIME;

/**
 * A placeholder that, as a top-level value in an `update`, removes that field from the document
 * (Firestore's `deleteField()`). It has no meaning in a `set`.
 */
export const DELETE_FIELD: unique symbol = Symbol("zenith.cloud.deleteField");

/** Document fields. Times are `Date` on the way out and `Date` or `SERVER_TIME` on the way in. */
export type DocData = Record<string, unknown>;

export interface StoredDoc {
  /** The full path, for example `teams/abc/members/uid1`. */
  path: string;
  /** The last path segment. */
  id: string;
  data: DocData;
}

export type Write =
  /** Create or replace the whole document. */
  | { op: "set"; path: string; data: DocData }
  /** Change the named top-level fields of an existing document. */
  | { op: "update"; path: string; data: DocData }
  | { op: "delete"; path: string };

/** An equality filter; the only kind the client uses, and the kind the list rules are written for. */
export interface Filter {
  field: string;
  value: unknown;
}

export interface Query {
  /** A collection path such as `teams/abc/autos`, or with `group` a collection id such as `members`. */
  collection: string;
  group?: boolean;
  where?: Filter[];
}

/**
 * A commit that has been accepted locally. `sent` settles when the server acknowledges or refuses it,
 * which offline may be much later: that is the outbox.
 */
export interface CommitHandle {
  sent: Promise<void>;
}

/** A document as `getWithPending` read it. */
export interface DocRead {
  /** The document, or null when it does not exist. */
  data: DocData | null;
  /**
   * True when `data` includes a write from this device that the server has not acknowledged yet
   * (Firestore's `metadata.hasPendingWrites`). Such a write may still be refused, so what it wrote is
   * this device's alone until then.
   */
  pendingWrites: boolean;
}

export interface DocStore {
  /** The document, or null when it does not exist. Throws `CloudError` "permission-denied". */
  get(path: string): Promise<DocData | null>;
  /** `get`, saying whether the document as read carries this device's unacknowledged writes. */
  getWithPending(path: string): Promise<DocRead>;
  /** Every document the query matches. Throws `CloudError` "permission-denied". */
  list(query: Query): Promise<StoredDoc[]>;
  /** Applies the writes atomically, locally at once and on the server when it can be reached. */
  commit(writes: Write[]): CommitHandle;
}

/** The last segment of a path. */
export function lastSegment(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
