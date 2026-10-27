/**
 * `DocStore` over the Firestore web SDK. Reads use the SDK's default source (the server when it can
 * be reached, the local cache when it cannot), and writes are batches, which the SDK persists and
 * sends in order when offline (ADR 0009 section 3).
 */
import {
  Bytes,
  Timestamp,
  collection,
  collectionGroup,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
} from "firebase/firestore";
import { CloudError, NOT_FOUND, OFFLINE_NOT_SAVED, RULES_REFUSED, type CloudErrorCode } from "../errors.js";
import { DELETE_FIELD, SERVER_TIME, type CommitHandle, type DocData, type DocRead, type DocStore, type Query, type StoredDoc, type Write } from "../store.js";

/**
 * Client values to Firestore values: `SERVER_TIME` to `serverTimestamp()`, `DELETE_FIELD` to
 * `deleteField()` (which Firestore takes only as a top-level value of an update), `Date` to `Timestamp`, and
 * `Uint8Array` to `Bytes`. The bytes case comes before the object case: the SDK refuses a raw
 * `Uint8Array` ("Unsupported field value: a custom Uint8Array object"), and treating it as an object
 * would store a map of its indices.
 */
export function toFirestore(value: unknown): unknown {
  if (value === SERVER_TIME) return serverTimestamp();
  if (value === DELETE_FIELD) return deleteField();
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (value instanceof Uint8Array) return Bytes.fromUint8Array(value);
  if (Array.isArray(value)) return value.map(toFirestore);
  if (value !== null && typeof value === "object") {
    const out: DocumentData = {};
    for (const [k, v] of Object.entries(value as DocData)) if (v !== undefined) out[k] = toFirestore(v);
    return out;
  }
  return value;
}

/** Firestore values to client values: `Timestamp` to `Date`, and `Bytes` to `Uint8Array`. */
export function fromFirestore(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Bytes) return value.toUint8Array();
  if (Array.isArray(value)) return value.map(fromFirestore);
  if (value !== null && typeof value === "object") {
    const out: DocData = {};
    for (const [k, v] of Object.entries(value as DocData)) out[k] = fromFirestore(v);
    return out;
  }
  return value;
}

/**
 * The sentence for each code. Firestore's own message is never kept: it is written for developers
 * ("Missing or insufficient permissions.") and the app shows a `CloudError`'s message as it is. The
 * original error stays in `cause`.
 */
const SENTENCES = {
  "permission-denied": RULES_REFUSED,
  "not-found": NOT_FOUND,
  unavailable: OFFLINE_NOT_SAVED,
  "signed-out": "Sign in, then try again.",
  conflict: "That changed on the cloud while this was being sent. Try again.",
  invalid: "The cloud could not take that request. Try again in a moment.",
} as const satisfies Partial<Record<CloudErrorCode, string>>;

/**
 * A Firestore error as a `CloudError`. A call that timed out or was cut off is "unavailable", read
 * as the connection; one the server was too busy for, or failed inside it, is "invalid", which says
 * to try again in a moment and is reported rather than kept waiting for the connection. Only
 * "aborted", a transaction that lost to another write, says something changed on the cloud.
 */
export function toCloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const mapped: keyof typeof SENTENCES =
    code === "permission-denied" || code === "not-found" || code === "unavailable"
      ? code
      : code === "deadline-exceeded" || code === "cancelled"
        ? "unavailable"
        : code === "unauthenticated"
          ? "signed-out"
          : code === "already-exists" || code === "aborted"
            ? "conflict"
            : "invalid";
  return new CloudError(mapped, SENTENCES[mapped], { cause: error });
}

export class FirestoreStore implements DocStore {
  constructor(private readonly db: Firestore) {}

  async get(path: string): Promise<DocData | null> {
    return (await this.getWithPending(path)).data;
  }

  /**
   * The SDK applies every write still in its queue to what it reads, until the server answers, and
   * says so in the snapshot's `hasPendingWrites`.
   */
  async getWithPending(path: string): Promise<DocRead> {
    try {
      const snap = await getDoc(doc(this.db, path));
      const data = snap.exists() ? (fromFirestore(snap.data({ serverTimestamps: "estimate" })) as DocData) : null;
      return { data, pendingWrites: snap.metadata.hasPendingWrites };
    } catch (error) {
      throw toCloudError(error);
    }
  }

  async list(q: Query): Promise<StoredDoc[]> {
    try {
      const ref = q.group === true ? collectionGroup(this.db, q.collection) : collection(this.db, q.collection);
      const filters = (q.where ?? []).map((f) => where(f.field, "==", toFirestore(f.value)));
      const snap = await getDocs(query(ref, ...filters));
      return snap.docs.map((d) => ({
        path: d.ref.path,
        id: d.id,
        data: fromFirestore(d.data({ serverTimestamps: "estimate" })) as DocData,
      }));
    } catch (error) {
      throw toCloudError(error);
    }
  }

  commit(writes: Write[]): CommitHandle {
    const batch = writeBatch(this.db);
    for (const w of writes) {
      const ref = doc(this.db, w.path);
      if (w.op === "delete") batch.delete(ref);
      else if (w.op === "set") batch.set(ref, toFirestore(w.data) as DocumentData);
      else batch.update(ref, toFirestore(w.data) as DocumentData);
    }
    const sent = batch.commit().catch((error: unknown) => {
      throw toCloudError(error);
    });
    sent.catch(() => undefined);
    return { sent };
  }
}
