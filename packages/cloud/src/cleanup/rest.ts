/**
 * The two Google APIs the retention clean-up calls, over plain `fetch`: Cloud Firestore's REST API
 * (`runQuery` and `batchGet` to read, `commit` to delete and to mark a team "rotation pending") and
 * the Identity Toolkit API's `accounts:lookup`, which
 * says which sign-in accounts still exist. With a service account's access token both act as the
 * project's administrator, outside the security rules; against the emulators the token is `owner`.
 *
 * Nothing here prints anything, and nothing a response carries is returned except document paths,
 * the fields a query selected, and account ids. `accounts:lookup` answers with each account's email
 * and provider details; only `localId` is read from it.
 */
import type { SnapshotDoc } from "./plan.js";

export interface RestTarget {
  projectId: string;
  /** `https://firestore.googleapis.com`, or `http://<FIRESTORE_EMULATOR_HOST>`. */
  firestoreOrigin: string;
  /** `https://identitytoolkit.googleapis.com`, or `http://<FIREBASE_AUTH_EMULATOR_HOST>/identitytoolkit.googleapis.com`. */
  identityOrigin: string;
  /** An OAuth 2.0 access token for each request. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

/** An equality or less-than filter, the only two the clean-up needs. */
export interface FieldFilter {
  field: string;
  op: "EQUAL" | "LESS_THAN";
  value: Date | string | boolean;
}

export interface RestQuery {
  /** The document the collection is under, such as `shares/abc`; empty for a top-level collection. */
  parent: string;
  collection: string;
  /** A collection-group query: every collection with this id under `parent`. */
  allDescendants?: boolean;
  where?: FieldFilter[];
  /** The fields to read. Empty reads only the path. */
  select: string[];
}

/** An error from one of the APIs: the HTTP status and the API's own message, never a request body. */
export class RestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RestError";
  }
}

/**
 * Account ids per `accounts:lookup` request. SET BY HAND: a small request; the API's own maximum
 * could not be read from here, and the Firebase Admin SDK's `getUsers` is commonly given 100 at once.
 */
export const ACCOUNTS_PER_LOOKUP = 100;

/** Document paths per `batchGet` request. SET BY HAND: a small request, well inside one commit's 500. */
export const DOCUMENTS_PER_GET = 100;

type Value = Record<string, unknown>;

function encode(value: Date | string | boolean): Value {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  return { booleanValue: value };
}

/** Firestore's typed JSON value to a plain one. Kinds the clean-up never selects come back undefined. */
export function decodeValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Value;
  if ("nullValue" in v) return null;
  if (typeof v.timestampValue === "string") return new Date(v.timestampValue);
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.booleanValue === "boolean") return v.booleanValue;
  if (typeof v.integerValue === "string") return Number(v.integerValue);
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return undefined;
}

/** Firestore and sign-in, as the project's administrator. */
export class AdminRest {
  private readonly fetcher: typeof fetch;

  constructor(private readonly target: RestTarget) {
    this.fetcher = target.fetch ?? fetch;
  }

  /** `projects/<id>/databases/(default)/documents`, the prefix of every document's full name. */
  get root(): string {
    return `projects/${this.target.projectId}/databases/(default)/documents`;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.target.token()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${String(response.status)}`;
      try {
        const error = (JSON.parse(text) as { error?: { status?: string; message?: string } }).error;
        if (error !== undefined) message = `${error.status ?? message}: ${error.message ?? ""}`.trim();
      } catch {
        // Not JSON: the status alone.
      }
      throw new RestError(response.status, message);
    }
    return JSON.parse(text) as unknown;
  }

  /** Every document the query matches, with only the selected fields. */
  async query(query: RestQuery): Promise<SnapshotDoc[]> {
    const parent = query.parent === "" ? this.root : `${this.root}/${query.parent}`;
    const filters = (query.where ?? []).map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encode(f.value) } }));
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: query.collection, allDescendants: query.allDescendants === true }],
      // An empty projection means "every field" to the API; `__name__` alone reads only the path.
      select: { fields: (query.select.length === 0 ? ["__name__"] : query.select).map((fieldPath) => ({ fieldPath })) },
    };
    if (filters.length === 1) structuredQuery.where = filters[0];
    else if (filters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    const results = await this.post(`${this.target.firestoreOrigin}/v1/${parent}:runQuery`, { structuredQuery });
    if (!Array.isArray(results)) throw new RestError(200, "runQuery did not answer with a list.");
    const prefix = `${this.root}/`;
    const docs: SnapshotDoc[] = [];
    for (const result of results as { document?: { name?: string; fields?: Record<string, unknown> } }[]) {
      const name = result.document?.name;
      if (typeof name !== "string") continue;
      if (!name.startsWith(prefix)) throw new RestError(200, "runQuery answered with a document of another database.");
      const data: Record<string, unknown> = {};
      for (const field of query.select) {
        const value = result.document?.fields?.[field];
        if (value !== undefined) data[field] = decodeValue(value);
      }
      docs.push({ path: name.slice(prefix.length), data });
    }
    return docs;
  }

  /**
   * Deletes the documents, and sets `rotationPending: true` on each team in `rotations`, in one atomic
   * commit. A path to delete that does not exist is not an error; each rotation mark carries the
   * precondition that its team exists, so it never creates one, and a missing team fails the commit.
   */
  async deleteAll(paths: readonly string[], rotations: readonly string[] = []): Promise<void> {
    if (paths.length + rotations.length === 0) return;
    if (paths.length + rotations.length > 500) throw new RestError(400, "A Firestore commit takes at most 500 writes.");
    await this.post(`${this.target.firestoreOrigin}/v1/${this.root}:commit`, {
      writes: [
        ...paths.map((path) => ({ delete: `${this.root}/${path}` })),
        ...rotations.map((path) => ({
          update: { name: `${this.root}/${path}`, fields: { rotationPending: { booleanValue: true } } },
          updateMask: { fieldPaths: ["rotationPending"] },
          currentDocument: { exists: true },
        })),
      ],
    });
  }

  /** Which of the documents exist, read by path with no fields (`batchGet` with an empty mask). */
  async existingDocuments(paths: readonly string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    const prefix = `${this.root}/`;
    for (let start = 0; start < paths.length; start += DOCUMENTS_PER_GET) {
      const batch = paths.slice(start, start + DOCUMENTS_PER_GET);
      const answer = await this.post(`${this.target.firestoreOrigin}/v1/${this.root}:batchGet`, {
        documents: batch.map((path) => `${prefix}${path}`),
        mask: { fieldPaths: ["__name__"] },
      });
      if (!Array.isArray(answer)) throw new RestError(200, "batchGet did not answer with a list.");
      for (const result of answer as { found?: { name?: unknown } }[]) {
        const name = result.found?.name;
        if (typeof name === "string" && name.startsWith(prefix) && batch.includes(name.slice(prefix.length))) existing.add(name.slice(prefix.length));
      }
    }
    return existing;
  }

  /** Which of the account ids still have a sign-in account. */
  async existingAccounts(uids: readonly string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    for (let start = 0; start < uids.length; start += ACCOUNTS_PER_LOOKUP) {
      const batch = uids.slice(start, start + ACCOUNTS_PER_LOOKUP);
      const answer = (await this.post(`${this.target.identityOrigin}/v1/projects/${this.target.projectId}/accounts:lookup`, { localId: batch })) as { users?: { localId?: unknown }[] };
      // No `users` at all is the API's answer when none of the ids exists.
      for (const user of answer.users ?? []) {
        if (typeof user.localId === "string" && batch.includes(user.localId)) existing.add(user.localId);
      }
    }
    return existing;
  }
}
