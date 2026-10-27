/**
 * A TypeScript copy of cloud/firestore.rules, applied by the in-memory store so the web app's tests
 * and other agents' UI work see the same permissions as the real database.
 *
 * It follows the rules file function by function, with the same names. The permission suite in
 * packages/cloud/test/permissions.suite.ts runs unchanged against this copy and against the Firestore
 * emulator, which is what keeps the two in step: a case that passes against one and fails against
 * the other is a bug in this file.
 *
 * Like the rules engine, an evaluation that hits an error (a missing document, a missing field) is a
 * refusal, and each side of an `||` is evaluated on its own, so an error on one side does not hide a
 * `true` on the other.
 */
import type { DocData, Filter, Query } from "../store.js";
import {
  ADMIN_ACTIONS,
  BUG_REPORT_STATUSES,
  MAX_BUG_AUTO_FILE,
  MAX_BUG_EXPECTED,
  MAX_BUG_PROBLEMS,
  MAX_BUG_RECENT_ACTIONS,
  MAX_BUG_SETUP_TEXT,
  MAX_BUG_STEPS,
  MAX_BUG_WHAT_HAPPENED,
  MAX_BUG_WINDOW_PX,
  MAX_ACTIVITY_DETAIL,
  MAX_ACTIVITY_TARGET,
  MAX_OWNER_CHOICE_BYTES,
  MAX_BETA_NAME,
  MAX_PREVIOUS_SHARE_KEYS,
  MAX_PRIVATE_KEY_BYTES,
  MAX_ROSTER_BYTES,
  MAX_PROPOSAL_DIFF_BYTES,
  MAX_REVISION_FIELD_BYTES,
  MAX_SHARE_MANIFEST_BYTES,
  MAX_SHARE_PROJECTION_BYTES,
  MAX_TITLE_CIPHERTEXT_BYTES,
  TIME_REQUEST_REASONS,
} from "../types.js";
import { sha256Sync } from "./sha256.js";

export interface RuleContext {
  /** The signed-in user's uid, or null for an unauthenticated caller. */
  uid: string | null;
  /** `request.time`: the moment the request is evaluated. */
  now: Date;
  /** A document as it is before this request (`get`). */
  get(path: string): DocData | null;
  /** A document as it will be after this whole request (`getAfter`). */
  getAfter(path: string): DocData | null;
}

type Condition = () => boolean;

/** Evaluates a condition the way the rules engine does: any error means false. */
function holds(condition: Condition): boolean {
  try {
    return condition() === true;
  } catch {
    return false;
  }
}

/** `a || b || …` with the engine's error handling: each side is evaluated on its own. */
function any(...conditions: Condition[]): boolean {
  return conditions.some(holds);
}

class RuleError extends Error {}

function fail(): never {
  throw new RuleError("rule evaluation error");
}

/** The fields of a document that must exist; a missing document is an evaluation error. */
function fields(doc: DocData | null): DocData {
  return doc ?? fail();
}

// ------------------------------------------------------------------------ value helpers

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isTimestamp(value: unknown): value is Date {
  return value instanceof Date;
}

function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * `string.size()`, which counts UTF-16 code units exactly as `length` does: measured on the Firestore
 * emulator, 40 emoji outside the Basic Multilingual Plane fill a limit of 80 and one more letter
 * passes it (the permission suite pins it on both backends). Not code points, and not bytes, which
 * `toUtf8().size()` counts.
 */
function size(value: unknown): number {
  return asString(value).length;
}

/** `text(value, max)`: a string of 1 to `max` UTF-16 code units, as `size()` counts. */
function text(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isRandomId(id: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(id);
}

// ------------------------------------------------------------------------ ciphertext

/** `value is bytes`. */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** `bytesOf(value, n)`: Bytes of exactly `n` bytes. */
function bytesOf(value: unknown, n: number): boolean {
  return isBytes(value) && value.byteLength === n;
}

/** `value is map`: a plain object, not a list, a timestamp or bytes. */
function isMap(value: unknown): value is DocData {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !isBytes(value);
}

function isKeyVersion(value: unknown): value is number {
  return isInt(value) && value >= 1 && value <= 0x7fffffff;
}

function isDeviceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{22}$/.test(id);
}

function isEnvelope(value: unknown, maxCt: number): value is DocData {
  return (
    isMap(value) &&
    hasExactly(value, ["v", "alg", "kv", "iv", "ct"], []) &&
    value.v === 1 &&
    value.alg === "A256GCM" &&
    isKeyVersion(value.kv) &&
    bytesOf(value.iv, 12) &&
    isBytes(value.ct) &&
    value.ct.byteLength >= 16 &&
    value.ct.byteLength <= maxCt
  );
}

/** `isEnvelopeUnder(value, kv, maxCt)`: `isEnvelope` with its key version given, which the caller has checked. */
function isEnvelopeUnder(value: unknown, kv: unknown, maxCt: number): value is DocData {
  return (
    isMap(value) &&
    hasExactly(value, ["v", "alg", "kv", "iv", "ct"], []) &&
    value.v === 1 &&
    value.alg === "A256GCM" &&
    value.kv === kv &&
    bytesOf(value.iv, 12) &&
    isBytes(value.ct) &&
    value.ct.byteLength >= 16 &&
    value.ct.byteLength <= maxCt
  );
}

function isSealedKey(value: unknown): value is DocData {
  return isEnvelope(value, 48) && (value.ct as Uint8Array).byteLength === 48;
}

/** `isSealedKeyUnder(value, kv)`: `isSealedKey` with its key version given, which the caller has checked. */
function isSealedKeyUnder(value: unknown, kv: unknown): value is DocData {
  return isEnvelopeUnder(value, kv, 48) && (value.ct as Uint8Array).byteLength === 48;
}

function isKeyWrap(value: unknown): boolean {
  return isMap(value) && hasExactly(value, ["v", "epk", "iv", "ct"], []) && value.v === 1 && bytesOf(value.epk, 65) && bytesOf(value.iv, 12) && bytesOf(value.ct, 48);
}

function isShareKeyWrap(value: unknown): boolean {
  return (
    isMap(value) &&
    hasExactly(value, ["v", "epk", "iv", "ct", "ekv"], []) &&
    value.v === 1 &&
    bytesOf(value.epk, 65) &&
    bytesOf(value.iv, 12) &&
    bytesOf(value.ct, 48) &&
    isKeyVersion(value.ekv)
  );
}

/** `areShareKeyWraps(wraps)`: each of one to 8 wraps is a share key wrap; the rules unroll it to 8. */
function areShareKeyWraps(wraps: unknown[]): boolean {
  if (wraps.length === 0) fail();
  return wraps.slice(0, 8).every(isShareKeyWrap);
}

/**
 * `isShareManifest(value)`: `{ v: 5, body, sig, dsig, dkeys, tsig, tkeys }`, a body of at most 2,560
 * bytes, three 64-byte signatures, and the 182 bytes of public keys of the device that signed the
 * manifest and of the device that signed its terms.
 */
function isShareManifest(value: unknown): boolean {
  return (
    isMap(value) &&
    hasExactly(value, ["v", "body", "sig", "dsig", "dkeys", "tsig", "tkeys"], []) &&
    value.v === 5 &&
    isBytes(value.body) &&
    value.body.byteLength <= MAX_SHARE_MANIFEST_BYTES &&
    bytesOf(value.sig, 64) &&
    bytesOf(value.dsig, 64) &&
    bytesOf(value.dkeys, 182) &&
    bytesOf(value.tsig, 64) &&
    bytesOf(value.tkeys, 182)
  );
}

/** The fields a share update may change, as `updatesShare` lists them; every other field stays. */
const SHARE_UPDATE_FIELDS = ["teamIds", "level", "mode", "revision", "expiresAt", "revokedAt", "updatedAt", "projection", "keyWraps", "ownerWrap", "prevKeys", "manifest"];

/** `validEncKey(key)`, with `hashing.sha256(key.spki) == key.fingerprint`, a signing key, and a signature past version 1. */
function validEncKey(key: unknown): key is DocData {
  return (
    isMap(key) &&
    hasExactly(key, ["v", "spki", "fingerprint", "signSpki", "sig"], []) &&
    isKeyVersion(key.v) &&
    bytesOf(key.spki, 91) &&
    bytesOf(key.fingerprint, 32) &&
    valuesEqual(sha256Sync(key.spki as Uint8Array), key.fingerprint) &&
    bytesOf(key.signSpki, 91) &&
    (key.v === 1 ? key.sig === null : bytesOf(key.sig, 64))
  );
}

/** `validApproval(approval, grantKv)`: `{ v: 1, kv, mac }`, a 32-byte MAC over the key version the grant gives. */
function validApproval(approval: unknown, grantKv: unknown): boolean {
  return (
    isMap(approval) &&
    hasExactly(approval, ["v", "kv", "mac"], []) &&
    approval.v === 1 &&
    isKeyVersion(approval.kv) &&
    isInt(grantKv) &&
    approval.kv === grantKv &&
    bytesOf(approval.mac, 32)
  );
}

/** `map.get(key, {})` for a map field. */
function mapOr(data: DocData, key: string): DocData {
  const value = getOr(data, key, {});
  return isMap(value) ? value : fail();
}

/** A revision id as the rules match it: six digits, a hyphen and a random suffix. */
const REVISION_ID = /^[0-9]{6}-[A-Za-z0-9_-]{8,64}$/;

/** Deep equality in the sense of the rules language, with timestamps compared by instant and bytes byte by byte. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b as object, k) && valuesEqual((a as DocData)[k], (b as DocData)[k]))
    );
  }
  return a === b;
}

function sameTime(value: unknown, now: Date): boolean {
  return isTimestamp(value) && value.getTime() === now.getTime();
}

function before(a: Date, b: unknown): boolean {
  return isTimestamp(b) && a.getTime() < b.getTime();
}

function hasExactly(data: DocData, required: string[], optional: string[]): boolean {
  const keys = Object.keys(data);
  const allowed = new Set([...required, ...optional]);
  return required.every((k) => Object.hasOwn(data, k)) && keys.every((k) => allowed.has(k));
}

function affectedKeys(after: DocData, before: DocData): Set<string> {
  const out = new Set<string>();
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    if (!Object.hasOwn(after, key) || !Object.hasOwn(before, key) || !valuesEqual(after[key], before[key])) out.add(key);
  }
  return out;
}

function onlyChanged(after: DocData, before: DocData, keys: string[]): boolean {
  return [...affectedKeys(after, before)].every((k) => keys.includes(k));
}

function unchanged(after: DocData, before: DocData, keys: string[]): boolean {
  const affected = affectedKeys(after, before);
  return keys.every((k) => !affected.has(k));
}

function appendsOne(before: unknown, after: unknown): boolean {
  return (
    Array.isArray(before) &&
    Array.isArray(after) &&
    after.length === before.length + 1 &&
    valuesEqual(after.slice(0, before.length), before)
  );
}

function evidenceUrl(value: unknown): boolean {
  return typeof value === "string" && value.length <= 500 && /^https:\/\/[^ ]+$/.test(value);
}

/** `text(reason, 300) && reason.matches('^.*[.!?]$')`: in RE2 `.` stops at a line break. */
function oneSentence(value: unknown): boolean {
  return text(value, 300) && /^[^\n]*[.!?]$/.test(value as string);
}

function stringOrAbsent(data: DocData, key: string): boolean {
  return !Object.hasOwn(data, key) || typeof data[key] === "string";
}

function boolOrAbsent(data: DocData, key: string): boolean {
  return !Object.hasOwn(data, key) || isBool(data[key]);
}

function field(data: DocData | null, key: string): unknown {
  const value = fields(data)[key];
  if (value === undefined) fail();
  return value;
}

/** `map.get(key, fallback)`: the field, or the fallback when it is absent. */
function getOr(data: DocData, key: string, fallback: unknown): unknown {
  return Object.hasOwn(data, key) ? data[key] : fallback;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : fail();
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : fail();
}

// ------------------------------------------------------------------------ the rules

type Op = "create" | "update" | "delete";

/**
 * One evaluation of the rules for one request. Methods are named after the functions in
 * cloud/firestore.rules.
 */
class Evaluation {
  constructor(private readonly ctx: RuleContext) {}

  signedIn(): boolean {
    return this.ctx.uid !== null;
  }

  me(): string {
    return this.ctx.uid ?? fail();
  }

  isHorizonAdmin(): boolean {
    return this.signedIn() && this.ctx.get(`admins/${this.me()}`) !== null;
  }

  // ---------------------------------------------------------------- the private beta

  /** `betaIsOpen()`: config/access says `betaOpen: true`; missing, or any other value, is closed. */
  betaIsOpen(): boolean {
    const access = this.ctx.get("config/access");
    return access !== null && getOr(access, "betaOpen", false) === true;
  }

  /** `hasBetaAccess()`: a named beta tester, a Horizon admin, or anyone while the beta is open. */
  hasBetaAccess(): boolean {
    return this.signedIn() && (this.ctx.get(`betaTesters/${this.me()}`) !== null || this.isHorizonAdmin() || this.betaIsOpen());
  }

  roleIn(teamId: unknown): string | null {
    const member = this.ctx.get(`teams/${asString(teamId)}/members/${this.me()}`);
    return member === null ? null : (member.role as string);
  }

  roleAfter(teamId: unknown): string | null {
    const member = this.ctx.getAfter(`teams/${asString(teamId)}/members/${this.me()}`);
    return member === null ? null : (member.role as string);
  }

  hasRole(teamId: unknown, roles: string[]): boolean {
    if (!this.signedIn()) return false;
    const role = this.roleIn(teamId);
    return role !== null && roles.includes(role);
  }

  isActive(teamId: unknown): boolean {
    return this.hasRole(teamId, ["owner", "admin", "editor", "viewer"]);
  }

  isEditor(teamId: unknown): boolean {
    return this.hasRole(teamId, ["owner", "admin", "editor"]);
  }

  isTeamAdmin(teamId: unknown): boolean {
    return this.hasRole(teamId, ["owner", "admin"]);
  }

  isOwner(teamId: unknown): boolean {
    return this.hasRole(teamId, ["owner"]);
  }

  // ---------------------------------------------------------------- deleted teams

  teamExists(teamId: unknown): boolean {
    return this.ctx.get(`teams/${asString(teamId)}`) !== null;
  }

  /** An active member of a team that still exists: what every read by membership asks. */
  readsAsMember(teamId: unknown): boolean {
    return this.isActive(teamId) && this.teamExists(teamId);
  }

  /** `getAfter(tombstonePath(teamId)) != null`. */
  beingDeleted(teamId: unknown): boolean {
    return this.ctx.getAfter(`deletedTeams/${asString(teamId)}`) !== null;
  }

  /** `get(tombstonePath(teamId)) == null`. */
  neverDeleted(teamId: unknown): boolean {
    return this.ctx.get(`deletedTeams/${asString(teamId)}`) === null;
  }

  purges(teamId: unknown): boolean {
    return this.isOwner(teamId) && this.beingDeleted(teamId);
  }

  tombstone(op: Op | "get", teamId: string, after: DocData | null): boolean {
    if (op === "get") return any(() => this.isHorizonAdmin(), () => this.isOwner(teamId));
    if (op !== "create") return false;
    const d = fields(after);
    return holds(
      () =>
        any(
          () => this.isOwner(teamId),
          () => this.isHorizonAdmin(),
        ) &&
        this.teamExists(teamId) &&
        hasExactly(d, ["deletedBy", "deletedAt"], []) &&
        d.deletedBy === this.me() &&
        sameTime(d.deletedAt, this.ctx.now),
    );
  }

  teamAllows(teamId: unknown, key: string): boolean {
    const settings = this.ctx.get(`teams/${asString(teamId)}/settings/sharing`);
    return settings !== null && settings[key] === true;
  }

  // ---------------------------------------------------------------- ciphertext

  /** The team's newest key version, from its `encKey` after this write. */
  teamKeyVersionAfter(teamId: unknown): unknown {
    return field(field(this.ctx.getAfter(`teams/${asString(teamId)}`), "encKey") as DocData, "v");
  }

  /** This write founds the team: it did not exist before, and the caller owns it after. */
  foundsInThisWrite(teamId: string): boolean {
    return (
      this.ctx.get(`teams/${teamId}`) === null &&
      field(this.ctx.getAfter(`teams/${teamId}`), "createdBy") === this.me() &&
      this.roleAfter(teamId) === "owner"
    );
  }

  // ---------------------------------------------------------------- users

  user(op: Op | "get", uid: string, before: DocData | null, after: DocData | null): boolean {
    const self = () => this.signedIn() && this.me() === uid;
    if (op === "get") return holds(self);
    if (op === "create") {
      const d = fields(after);
      return holds(
        () =>
          self() &&
          hasExactly(d, ["displayName", "createdAt"], []) &&
          text(d.displayName, 80) &&
          sameTime(d.createdAt, this.ctx.now) &&
          this.hasBetaAccess(),
      );
    }
    if (op === "update") {
      return holds(
        () => self() && onlyChanged(fields(after), fields(before), ["displayName"]) && text(fields(after).displayName, 80),
      );
    }
    return holds(self);
  }

  /** `users/{uid}/devices/{deviceId}`: a device's public keys, read by anyone signed in, written only by its user. */
  device(op: Op | "get" | "list", uid: string, deviceId: string, after: DocData | null): boolean {
    const self = () => this.signedIn() && this.me() === uid;
    if (op === "get") return this.signedIn();
    if (op === "list" || op === "delete") return holds(self);
    if (op === "update") return false;
    const d = fields(after);
    return holds(
      () =>
        self() &&
        isDeviceId(deviceId) &&
        hasExactly(d, ["v", "encSpki", "signSpki", "fingerprint", "createdAt"], []) &&
        d.v === 1 &&
        bytesOf(d.encSpki, 91) &&
        bytesOf(d.signSpki, 91) &&
        bytesOf(d.fingerprint, 32) &&
        sameTime(d.createdAt, this.ctx.now),
    );
  }

  /** `admins/{uid}`: read by that admin and other Horizon admins; added and removed by Horizon admins, never removing themselves. */
  admin(op: Op | "get", uid: string, after: DocData | null): boolean {
    if (op === "get") return any(() => this.signedIn() && this.me() === uid, () => this.isHorizonAdmin());
    if (op === "create") {
      const d = fields(after);
      return holds(() => this.isHorizonAdmin() && hasExactly(d, ["name"], []) && text(d.name, MAX_BETA_NAME));
    }
    if (op === "delete") return holds(() => this.isHorizonAdmin() && uid !== this.me());
    return false;
  }

  /** `betaTesters/{uid}`: read by the tester and by Horizon admins; added and removed by Horizon admins. */
  betaTester(op: Op | "get", uid: string, after: DocData | null): boolean {
    if (op === "get") return any(() => this.signedIn() && this.me() === uid, () => this.isHorizonAdmin());
    if (op === "create") {
      const d = fields(after);
      return holds(() => this.isHorizonAdmin() && hasExactly(d, ["name"], []) && text(d.name, MAX_BETA_NAME));
    }
    if (op === "delete") return holds(() => this.isHorizonAdmin());
    return false;
  }

  /**
   * `betaRequests/{uid}`: the requests left from before 2026-10-03, when asking for access was
   * removed (issue #99). Nobody creates or changes one; read and deleted by their sender and by
   * Horizon admins.
   */
  betaRequest(op: Op | "get", uid: string): boolean {
    const self = () => this.signedIn() && this.me() === uid;
    if (op === "get" || op === "delete") return any(self, () => this.isHorizonAdmin());
    return false;
  }

  /** `config/access`: read by anyone signed in; written only from the console. */
  accessConfig(op: Op | "get"): boolean {
    return op === "get" && this.signedIn();
  }

  // ---------------------------------------------------------------- the admin access log

  adminLog(op: Op | "get", entryId: string, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.isHorizonAdmin());
    if (op !== "create") return false;
    const d = fields(after);
    return holds(
      () =>
        this.isHorizonAdmin() &&
        isRandomId(entryId) &&
        hasExactly(d, ["by", "at", "action"], ["target"]) &&
        d.by === this.me() &&
        sameTime(d.at, this.ctx.now) &&
        (ADMIN_ACTIONS as readonly unknown[]).includes(d.action) &&
        (!Object.hasOwn(d, "target") || text(d.target, MAX_ACTIVITY_TARGET)),
    );
  }

  // ---------------------------------------------------------------- bug reports

  /** `validBugSetup(setup)`: the setup block has exactly its fields, each of the right type and size. */
  validBugSetup(setup: unknown): boolean {
    if (!isMap(setup)) return false;
    const keys = [
      "appVersion", "surface", "hostMode", "browser", "os", "windowWidthPx", "windowHeightPx", "theme", "cloudMode", "problems", "recentActions",
    ];
    const whole = (value: unknown) => isInt(value) && value >= 0 && value <= MAX_BUG_WINDOW_PX;
    return (
      hasExactly(setup, keys, []) &&
      text(setup.appVersion, MAX_BUG_SETUP_TEXT) &&
      ["web", "desktop"].includes(setup.surface as string) &&
      isBool(setup.hostMode) &&
      text(setup.browser, MAX_BUG_SETUP_TEXT) &&
      text(setup.os, MAX_BUG_SETUP_TEXT) &&
      whole(setup.windowWidthPx) &&
      whole(setup.windowHeightPx) &&
      ["dark", "light"].includes(setup.theme as string) &&
      ["off", "fake", "firebase"].includes(setup.cloudMode as string) &&
      size(setup.problems) <= MAX_BUG_PROBLEMS &&
      size(setup.recentActions) <= MAX_BUG_RECENT_ACTIONS
    );
  }

  /** `bugReports/{reportId}`: created by a reporter with a profile and beta access; read, marked and deleted by Horizon admins only. */
  bugReport(op: Op | "get", reportId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get" || op === "delete") return holds(() => this.isHorizonAdmin());
    const d = fields(after);
    const optionalText = (key: string, max: number) => !Object.hasOwn(d, key) || text(d[key], max);
    if (op === "create") {
      return holds(
        () =>
          this.signedIn() &&
          isRandomId(reportId) &&
          this.ctx.get(`users/${this.me()}`) !== null &&
          this.hasBetaAccess() &&
          hasExactly(d, ["reporter", "createdAt", "status", "whatHappened", "setup"], ["expected", "steps", "autoFile"]) &&
          d.reporter === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          d.status === "new" &&
          text(d.whatHappened, MAX_BUG_WHAT_HAPPENED) &&
          optionalText("expected", MAX_BUG_EXPECTED) &&
          optionalText("steps", MAX_BUG_STEPS) &&
          optionalText("autoFile", MAX_BUG_AUTO_FILE) &&
          this.validBugSetup(d.setup),
      );
    }
    return holds(
      () =>
        this.isHorizonAdmin() &&
        onlyChanged(d, fields(before), ["status", "updatedBy", "updatedAt"]) &&
        (BUG_REPORT_STATUSES as readonly unknown[]).includes(d.status) &&
        d.updatedBy === this.me() &&
        sameTime(d.updatedAt, this.ctx.now),
    );
  }

  // ---------------------------------------------------------------- teams

  claimsInSameWrite(teamId: string, teamNumber: unknown): boolean {
    if (!isInt(teamNumber) || teamNumber <= 0) return false;
    const claim = this.ctx.getAfter(`claims/${String(teamNumber)}`);
    return claim !== null && claim.teamId === teamId;
  }

  contestedInSameWrite(teamId: string, teamNumber: number): boolean {
    const before = fields(this.ctx.get(`claims/${String(teamNumber)}`));
    const after = fields(this.ctx.getAfter(`claims/${String(teamNumber)}`));
    return (
      before.teamId === teamId &&
      getOr(before, "disputeId", null) === null &&
      after.status === "contested" &&
      getOr(after, "disputeId", null) !== null
    );
  }

  /** This write opens the review `disputeId`, with this team as the challenger, of a number it makes contested. */
  opensReviewInSameWrite(teamId: string, disputeId: unknown): boolean {
    const id = asString(disputeId);
    const dispute = fields(this.ctx.getAfter(`disputes/${id}`));
    const claim = fields(this.ctx.getAfter(`claims/${String(field(dispute, "teamNumber"))}`));
    return this.ctx.get(`disputes/${id}`) === null && dispute.challengerTeamId === teamId && claim.status === "contested";
  }

  team(op: Op | "get", teamId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return this.signedIn();
    if (op === "create") {
      const d = fields(after);
      return holds(
        () =>
          this.signedIn() &&
          isRandomId(teamId) &&
          this.neverDeleted(teamId) &&
          this.ctx.getAfter(`users/${this.me()}`) !== null &&
          hasExactly(d, ["number", "name", "status", "createdBy", "createdAt", "encKey"], []) &&
          text(d.name, 100) &&
          d.status === "unverified" &&
          d.createdBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          (d.number === null || this.claimsInSameWrite(teamId, d.number)) &&
          validEncKey(d.encKey) &&
          d.encKey.v === 1 &&
          this.ctx.getAfter(`teams/${teamId}/teamKeys/1`) !== null &&
          this.ctx.getAfter(`teams/${teamId}/recovery/current`) !== null &&
          this.roleAfter(teamId) === "owner" &&
          this.hasBetaAccess(),
      );
    }
    if (op === "update") {
      const d = fields(after);
      const e = fields(before);
      return any(
        () =>
          this.isHorizonAdmin() &&
          onlyChanged(d, e, ["status", "number", "disputeId"]) &&
          ["unverified", "verified", "contested"].includes(d.status as string) &&
          (d.number === null || isInt(d.number)) &&
          (unchanged(d, e, ["disputeId"]) || getOr(d, "disputeId", null) === null),
        () => this.isTeamAdmin(teamId) && onlyChanged(d, e, ["name"]) && text(d.name, 100),
        () =>
          this.isTeamAdmin(teamId) &&
          onlyChanged(d, e, ["number"]) &&
          e.number === null &&
          this.claimsInSameWrite(teamId, d.number),
        () =>
          this.signedIn() &&
          onlyChanged(d, e, ["status"]) &&
          d.status === "contested" &&
          e.status === "unverified" &&
          isInt(e.number) &&
          this.contestedInSameWrite(teamId, e.number),
        () =>
          this.isTeamAdmin(teamId) &&
          onlyChanged(d, e, ["status", "disputeId"]) &&
          d.status === "contested" &&
          e.status === "unverified" &&
          e.number === null &&
          this.opensReviewInSameWrite(teamId, getOr(d, "disputeId", null)),
        () => this.isTeamAdmin(teamId) && this.rotatesTeamKey(teamId, d, e),
        () => this.isActive(teamId) && onlyChanged(d, e, ["rotationPending"]) && d.rotationPending === true && isMap(e.encKey),
      );
    }
    return holds(
      () =>
        any(
          () => this.isOwner(teamId),
          () => this.isHorizonAdmin(),
        ) && this.beingDeleted(teamId),
    );
  }

  /** Rotating the team key: encKey one version up, with teamKeys/{n+1} and the recovery record moved on. */
  rotatesTeamKey(teamId: string, d: DocData, e: DocData): boolean {
    const next = d.encKey;
    return (
      onlyChanged(d, e, ["encKey", "rotationPending"]) &&
      validEncKey(next) &&
      next.v === (field(e.encKey as DocData, "v") as number) + 1 &&
      this.ctx.getAfter(`teams/${teamId}/teamKeys/${String(next.v)}`) !== null &&
      field(this.ctx.getAfter(`teams/${teamId}/recovery/current`), "kv") === next.v &&
      getOr(d, "rotationPending", false) === false
    );
  }

  // ---------------------------------------------------------------- members

  foundsTeam(teamId: string, d: DocData): boolean {
    const team = this.ctx.getAfter(`teams/${teamId}`);
    return (
      d.role === "owner" &&
      !Object.hasOwn(d, "invite") &&
      !Object.hasOwn(d, "requestedRole") &&
      this.ctx.get(`teams/${teamId}`) === null &&
      this.neverDeleted(teamId) &&
      team !== null &&
      team.createdBy === this.me()
    );
  }

  redeemsInvite(teamId: string, d: DocData): boolean {
    const code = asString(d.invite);
    const invite = this.ctx.get(`invites/${code}`);
    const after = this.ctx.getAfter(`invites/${code}`);
    const inv = fields(invite);
    return (
      inv.teamId === teamId &&
      this.teamExists(teamId) &&
      this.neverDeleted(teamId) &&
      inv.revoked === false &&
      before(this.ctx.now, inv.expiresAt) &&
      (inv.uses as number) < (inv.maxUses as number) &&
      field(after, "uses") === (inv.uses as number) + 1 &&
      d.requestedRole === inv.role &&
      d.role === (inv.autoApprove === true && inv.role !== "admin" ? inv.role : "pending")
    );
  }

  assignsRole(teamId: string, d: DocData, e: DocData): boolean {
    const caller = this.roleIn(teamId);
    return (
      (caller === "owner" && ["owner", "admin", "editor", "viewer"].includes(d.role as string)) ||
      (caller === "admin" && e.role !== "owner" && ["admin", "editor", "viewer"].includes(d.role as string))
    );
  }

  member(op: Op | "get", teamId: string, uid: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return any(() => this.signedIn() && this.me() === uid, () => this.readsAsMember(teamId));
    if (op === "create") {
      const d = fields(after);
      return holds(
        () =>
          this.signedIn() &&
          this.me() === uid &&
          hasExactly(d, ["uid", "teamId", "role", "displayName", "joinedAt"], ["invite", "requestedRole"]) &&
          d.uid === uid &&
          d.teamId === teamId &&
          text(d.displayName, 80) &&
          sameTime(d.joinedAt, this.ctx.now) &&
          any(
            () => this.foundsTeam(teamId, d),
            () => this.redeemsInvite(teamId, d) && this.hasBetaAccess(),
          ),
      );
    }
    if (op === "update") {
      const d = fields(after);
      const e = fields(before);
      return any(
        () => this.signedIn() && this.me() === uid && onlyChanged(d, e, ["displayName"]) && text(d.displayName, 80),
        () => this.signedIn() && this.me() !== uid && onlyChanged(d, e, ["role"]) && this.assignsRole(teamId, d, e),
      );
    }
    const e = fields(before);
    return any(
      () =>
        this.signedIn() &&
        this.me() === uid &&
        (e.role !== "owner" || this.ctx.getAfter(`teams/${teamId}`) === null),
      () => this.signedIn() && this.me() !== uid && this.roleIn(teamId) === "owner",
      () => this.signedIn() && this.me() !== uid && this.roleIn(teamId) === "admin" && e.role !== "owner",
      () => this.signedIn() && this.me() !== uid && this.isHorizonAdmin() && this.beingDeleted(teamId),
    );
  }

  // ---------------------------------------------------------------- settings

  settings(op: Op | "get", teamId: string, settingId: string, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.readsAsMember(teamId));
    if (op === "delete") return holds(() => this.isTeamAdmin(teamId));
    const d = fields(after);
    return holds(
      () =>
        this.isTeamAdmin(teamId) &&
        settingId === "sharing" &&
        hasExactly(d, [], ["editorsMayProposeShare", "editorsMayLinkShare", "publishOnSave", "membersMayApproveDevices"]) &&
        boolOrAbsent(d, "editorsMayProposeShare") &&
        boolOrAbsent(d, "editorsMayLinkShare") &&
        boolOrAbsent(d, "publishOnSave") &&
        boolOrAbsent(d, "membersMayApproveDevices"),
    );
  }

  // ---------------------------------------------------------------- autos and revisions

  auto(op: Op | "get", teamId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.readsAsMember(teamId));
    if (op === "delete") return holds(() => this.purges(teamId));
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          this.isEditor(teamId) &&
          hasExactly(d, ["title", "titleGen", "createdBy", "createdAt", "updatedAt"], []) &&
          isEnvelope(d.title, MAX_TITLE_CIPHERTEXT_BYTES) &&
          d.title.kv === this.teamKeyVersionAfter(teamId) &&
          d.titleGen === 1 &&
          d.createdBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          sameTime(d.updatedAt, this.ctx.now),
      );
    }
    const e = fields(before);
    return holds(
      () =>
        this.isEditor(teamId) &&
        onlyChanged(d, e, ["title", "titleGen", "updatedAt"]) &&
        isEnvelope(d.title, MAX_TITLE_CIPHERTEXT_BYTES) &&
        d.title.kv === this.teamKeyVersionAfter(teamId) &&
        isInt(e.titleGen) &&
        d.titleGen === e.titleGen + 1 &&
        sameTime(d.updatedAt, this.ctx.now),
    );
  }

  followsBase(teamId: string, autoId: string, d: DocData): boolean {
    const base = d.baseRevision;
    if (base === null) return d.n === 1;
    const baseDoc = this.ctx.get(`teams/${teamId}/autos/${autoId}/revisions/${asString(base)}`);
    return (field(baseDoc, "n") as number) + 1 === d.n;
  }

  revision(op: Op | "get", teamId: string, autoId: string, revisionId: string, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.readsAsMember(teamId));
    if (op === "delete") return holds(() => this.purges(teamId));
    if (op !== "create") return false;
    const d = fields(after);
    return holds(
      () =>
        this.isEditor(teamId) &&
        this.ctx.getAfter(`teams/${teamId}/autos/${autoId}`) !== null &&
        /^[0-9]{6}-[A-Za-z0-9_-]{8,64}$/.test(revisionId) &&
        hasExactly(d, ["n", "baseRevision", "author", "createdAt", "content", "diverged"], [
          "gitSha",
          "robot",
          "field",
          "waypoints",
        ]) &&
        isInt(d.n) &&
        Number.parseInt(revisionId.split("-")[0] ?? "", 10) === d.n &&
        d.author === this.me() &&
        sameTime(d.createdAt, this.ctx.now) &&
        isEnvelope(d.content, MAX_REVISION_FIELD_BYTES) &&
        d.content.kv === this.teamKeyVersionAfter(teamId) &&
        isBool(d.diverged) &&
        ["robot", "field", "waypoints"].every(
          (key) => !Object.hasOwn(d, key) || (isEnvelope(d[key], MAX_REVISION_FIELD_BYTES) && d[key].kv === (d.content as DocData).kv),
        ) &&
        (!Object.hasOwn(d, "gitSha") || (isEnvelope(d.gitSha, MAX_TITLE_CIPHERTEXT_BYTES) && d.gitSha.kv === (d.content as DocData).kv)) &&
        this.followsBase(teamId, autoId, d),
    );
  }

  // ---------------------------------------------------------------- inbox and activity

  inbox(op: Op | "get", teamId: string, shareId: string, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.readsAsMember(teamId));
    if (op === "delete") return holds(() => this.isTeamAdmin(teamId));
    // `allow create, update`: putting a team back on a share rewrites its pointer with the same checks.
    const d = fields(after);
    return holds(() => {
      const share = this.ctx.getAfter(`shares/${shareId}`);
      return (
        this.signedIn() &&
        hasExactly(d, ["shareId", "ownerTeamId", "createdBy", "createdAt"], []) &&
        d.shareId === shareId &&
        d.createdBy === this.me() &&
        sameTime(d.createdAt, this.ctx.now) &&
        share !== null &&
        share.audience === "teams" &&
        (share.teamIds as unknown[]).includes(teamId) &&
        share.ownerTeamId === d.ownerTeamId &&
        this.isEditor(share.ownerTeamId)
      );
    });
  }

  activity(op: Op | "get", teamId: string, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.isTeamAdmin(teamId) && this.teamExists(teamId));
    if (op === "delete") return holds(() => this.purges(teamId));
    if (op !== "create") return false;
    const d = fields(after);
    return holds(
      () =>
        this.signedIn() &&
        this.writesActivity(teamId, d) &&
        hasExactly(d, ["at", "by", "kind"], ["target", "detail"]) &&
        sameTime(d.at, this.ctx.now) &&
        d.by === this.me() &&
        text(d.kind, 64) &&
        stringOrAbsent(d, "target") &&
        size(getOr(d, "target", "")) <= MAX_ACTIVITY_TARGET &&
        (d.kind === "auto.create"
          ? isEnvelope(getOr(d, "detail", null), MAX_TITLE_CIPHERTEXT_BYTES) && (d.detail as DocData).kv === this.teamKeyVersionAfter(teamId)
          : typeof getOr(d, "detail", "") === "string" && size(getOr(d, "detail", "")) <= MAX_ACTIVITY_DETAIL),
    );
  }

  /** An active member, one made active by this write, or a pending member joining or leaving in their own name. */
  writesActivity(teamId: string, d: DocData): boolean {
    const active = ["owner", "admin", "editor", "viewer"];
    const before = this.roleIn(teamId);
    const after = this.roleAfter(teamId);
    const own = getOr(d, "target", null) === this.me();
    return (
      (before !== null && active.includes(before)) ||
      (before === null && after !== null && active.includes(after)) ||
      (before === null && after === "pending" && d.kind === "member.join" && own) ||
      (before === "pending" && after === null && d.kind === "member.leave" && own)
    );
  }

  // ---------------------------------------------------------------- team keys (spec 14 section 4)

  teamKey(op: Op | "get", teamId: string, kv: string, after: DocData | null): boolean {
    // `allow get: if signedIn()`: public keys and ciphertext only, for partners walking the signatures.
    // Listing stays with active members (`allowList`).
    if (op === "get") return holds(() => this.signedIn());
    if (op === "delete") return holds(() => this.purges(teamId));
    if (op === "update") return false;
    const d = fields(after);
    return holds(() => {
      const team = fields(this.ctx.getAfter(`teams/${teamId}`));
      return (
        this.signedIn() &&
        hasExactly(d, ["v", "kv", "prev", "pairSpki", "pairPrivate", "signSpki", "signPrivate", "sig", "roster", "rosterSig"], []) &&
        d.v === 1 &&
        isKeyVersion(d.kv) &&
        kv === String(d.kv) &&
        bytesOf(d.pairSpki, 91) &&
        isEnvelope(d.pairPrivate, MAX_PRIVATE_KEY_BYTES) &&
        d.pairPrivate.kv === d.kv &&
        bytesOf(d.signSpki, 91) &&
        isEnvelope(d.signPrivate, MAX_PRIVATE_KEY_BYTES) &&
        d.signPrivate.kv === d.kv &&
        isEnvelope(d.roster, MAX_ROSTER_BYTES) &&
        d.roster.kv === d.kv &&
        bytesOf(d.rosterSig, 64) &&
        this.teamKeyVersionAfter(teamId) === d.kv &&
        valuesEqual(field(team.encKey as DocData, "spki"), d.pairSpki) &&
        valuesEqual(field(team.encKey as DocData, "signSpki"), d.signSpki) &&
        valuesEqual(field(team.encKey as DocData, "sig"), d.sig) &&
        any(
          () => d.kv === 1 && d.prev === null && this.foundsInThisWrite(teamId),
          () => (d.kv as number) > 1 && isSealedKey(d.prev) && d.prev.kv === d.kv && this.isTeamAdmin(teamId),
        )
      );
    });
  }

  validRecovery(teamId: string, d: DocData): boolean {
    return (
      hasExactly(d, ["v", "kv", "spki", "privateKey", "signSpki", "signPrivate", "teamKey", "check", "updatedBy", "updatedAt"], []) &&
      d.v === 1 &&
      d.kv === this.teamKeyVersionAfter(teamId) &&
      bytesOf(d.spki, 91) &&
      isEnvelope(d.privateKey, MAX_PRIVATE_KEY_BYTES) &&
      d.privateKey.kv === 1 &&
      bytesOf(d.signSpki, 91) &&
      isEnvelope(d.signPrivate, MAX_PRIVATE_KEY_BYTES) &&
      d.signPrivate.kv === 1 &&
      isKeyWrap(d.teamKey) &&
      isSealedKey(d.check) &&
      d.check.kv === d.kv &&
      d.updatedBy === this.me() &&
      sameTime(d.updatedAt, this.ctx.now)
    );
  }

  recovery(op: Op | "get", teamId: string, docId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return holds(() => this.readsAsMember(teamId));
    if (op === "delete") return holds(() => this.purges(teamId));
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          docId === "current" &&
          this.validRecovery(teamId, d) &&
          any(
            () => this.foundsInThisWrite(teamId),
            () => this.isOwner(teamId),
          ),
      );
    }
    const e = fields(before);
    return holds(
      () =>
        docId === "current" &&
        this.validRecovery(teamId, d) &&
        (d.kv as number) > (e.kv as number) &&
        any(
          () =>
            this.isTeamAdmin(teamId) &&
            valuesEqual(d.spki, e.spki) &&
            valuesEqual(d.privateKey, e.privateKey) &&
            valuesEqual(d.signSpki, e.signSpki) &&
            valuesEqual(d.signPrivate, e.signPrivate),
          () => this.isOwner(teamId),
        ),
    );
  }

  validGrant(teamId: string, deviceId: string, d: DocData): boolean {
    return (
      hasExactly(
        d,
        ["v", "teamId", "deviceId", "uid", "kv", "wrap", "proof", "approverDeviceId", "approverUid", "signature", "createdAt", "updatedAt"],
        ["approval", "recoverySig"],
      ) &&
      (!Object.hasOwn(d, "approval") || validApproval(d.approval, d.kv)) &&
      (!Object.hasOwn(d, "recoverySig") || (bytesOf(d.recoverySig, 64) && d.approverDeviceId === deviceId)) &&
      d.v === 1 &&
      d.teamId === teamId &&
      d.deviceId === deviceId &&
      isDeviceId(deviceId) &&
      typeof d.uid === "string" &&
      /^[^/]{1,128}$/.test(d.uid) &&
      d.kv === this.teamKeyVersionAfter(teamId) &&
      isKeyWrap(d.wrap) &&
      isSealedKey(d.proof) &&
      d.proof.kv === d.kv &&
      isDeviceId(d.approverDeviceId) &&
      d.approverUid === this.me() &&
      this.ctx.getAfter(`users/${this.me()}/devices/${d.approverDeviceId}`) !== null &&
      bytesOf(d.signature, 64) &&
      sameTime(d.updatedAt, this.ctx.now)
    );
  }

  /** A device granting itself the key is refused while a rotation is pending, unless this write rotates the key. */
  selfGrantAllowed(teamId: string, deviceId: string, d: DocData): boolean {
    const before = this.ctx.get(`teams/${teamId}`);
    return (
      d.approverDeviceId !== deviceId ||
      before === null ||
      getOr(before, "rotationPending", false) !== true ||
      (this.teamKeyVersionAfter(teamId) as number) > (field(before.encKey as DocData, "v") as number)
    );
  }

  /**
   * The approving device holds the caller's grant of the newest key: before this write, so two grants
   * made in one write cannot approve each other, or, in the write that rotates the key, after it.
   */
  holdsGrant(teamId: string, d: DocData): boolean {
    const path = `teams/${teamId}/keyGrants/${asString(d.approverDeviceId)}`;
    const held = this.rotatesInThisWrite(teamId) ? this.ctx.getAfter(path) : this.ctx.get(path);
    return held !== null && held.uid === this.me() && held.kv === d.kv;
  }

  /** `rotatesInThisWrite(teamId)`: this write moves the team's key on to a newer version. */
  rotatesInThisWrite(teamId: string): boolean {
    const before = this.ctx.get(`teams/${teamId}`);
    return before !== null && (this.teamKeyVersionAfter(teamId) as number) > (field(before.encKey as DocData, "v") as number);
  }

  ownGrant(teamId: string, deviceId: string, d: DocData): boolean {
    return (
      d.uid === this.me() &&
      this.isActive(teamId) &&
      any(
        () => d.approverDeviceId === deviceId,
        () => this.holdsGrant(teamId, d),
      )
    );
  }

  /**
   * `noRequestOfAnother`: no other member has asked for the key for this device id, after this write,
   * so an owner or admin can delete a squatting request and grant the real device in one write.
   */
  noRequestOfAnother(teamId: string, deviceId: string, d: DocData): boolean {
    const request = this.ctx.getAfter(`teams/${teamId}/keyRequests/${deviceId}`);
    return request === null || request.uid === d.uid;
  }

  /**
   * `adminMayDeleteGrant(teamId)`: in the write that rotates the key, when the member is not active
   * after the write, or when the write leaves the key marked "rotation pending", then an owner's
   * grant only by an owner.
   */
  adminMayDeleteGrant(teamId: string, e: DocData): boolean {
    const member = this.ctx.getAfter(`teams/${teamId}/members/${asString(e.uid)}`);
    return any(
      () => this.rotatesInThisWrite(teamId),
      () => member === null,
      () => !["owner", "admin", "editor", "viewer"].includes(field(member, "role") as string),
      () =>
        getOr(fields(this.ctx.getAfter(`teams/${teamId}`)), "rotationPending", false) === true &&
        (field(member, "role") !== "owner" || this.isOwner(teamId)),
    );
  }

  keyGrant(op: Op | "get" | "list", teamId: string, deviceId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get" || op === "list") {
      return any(
        () => this.signedIn() && fields(before).uid === this.me() && this.isActive(teamId),
        () => this.isTeamAdmin(teamId),
      );
    }
    if (op === "delete") {
      return any(
        () => this.signedIn() && fields(before).uid === this.me(),
        () => this.isTeamAdmin(teamId) && this.adminMayDeleteGrant(teamId, fields(before)),
        () => this.purges(teamId),
      );
    }
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          this.signedIn() &&
          this.validGrant(teamId, deviceId, d) &&
          sameTime(d.createdAt, this.ctx.now) &&
          this.ctx.getAfter(`users/${asString(d.uid)}/devices/${deviceId}`) !== null &&
          ["owner", "admin", "editor", "viewer"].includes(field(this.ctx.getAfter(`teams/${teamId}/members/${asString(d.uid)}`), "role") as string) &&
          this.selfGrantAllowed(teamId, deviceId, d) &&
          this.noRequestOfAnother(teamId, deviceId, d) &&
          any(
            () => d.uid === this.me() && d.approverDeviceId === deviceId && this.foundsInThisWrite(teamId),
            () => this.ownGrant(teamId, deviceId, d),
            () => this.isTeamAdmin(teamId) && this.holdsGrant(teamId, d),
            () =>
              this.teamAllows(teamId, "membersMayApproveDevices") &&
              this.isActive(teamId) &&
              ["owner", "admin", "editor", "viewer"].includes(field(this.ctx.get(`teams/${teamId}/members/${asString(d.uid)}`), "role") as string) &&
              this.holdsGrant(teamId, d),
          ),
      );
    }
    const e = fields(before);
    return holds(
      () =>
        this.signedIn() &&
        this.validGrant(teamId, deviceId, d) &&
        onlyChanged(d, e, ["kv", "wrap", "proof", "approverDeviceId", "approverUid", "signature", "updatedAt", "approval", "recoverySig"]) &&
        (d.kv as number) >= (e.kv as number) &&
        this.selfGrantAllowed(teamId, deviceId, d) &&
        any(
          () => this.isTeamAdmin(teamId) && this.holdsGrant(teamId, d),
          () => e.uid === this.me() && this.ownGrant(teamId, deviceId, d),
        ),
    );
  }

  keyRequest(op: Op | "get" | "list", teamId: string, deviceId: string, before: DocData | null, after: DocData | null): boolean {
    const granters = [
      () => this.isTeamAdmin(teamId),
      () => this.isActive(teamId) && this.teamAllows(teamId, "membersMayApproveDevices"),
    ];
    if (op === "get" || op === "list") return any(() => this.signedIn() && fields(before).uid === this.me(), ...granters);
    if (op === "delete") {
      return any(
        () => this.signedIn() && fields(before).uid === this.me(),
        () => this.isTeamAdmin(teamId),
        () => {
          // `grantedInThisWrite`: the grant after this write is for the member who asked, and names
          // the caller as approver, made now.
          const grant = this.ctx.getAfter(`teams/${teamId}/keyGrants/${deviceId}`);
          return (
            this.isActive(teamId) &&
            grant !== null &&
            grant.uid === fields(before).uid &&
            grant.approverUid === this.me() &&
            sameTime(grant.updatedAt, this.ctx.now)
          );
        },
        () => this.purges(teamId),
      );
    }
    const d = fields(after);
    return holds(
      () =>
        this.signedIn() &&
        hasExactly(d, ["uid", "deviceId", "createdAt"], []) &&
        d.uid === this.me() &&
        d.deviceId === deviceId &&
        isDeviceId(deviceId) &&
        sameTime(d.createdAt, this.ctx.now) &&
        (before === null || before.uid === this.me()) &&
        this.ctx.getAfter(`teams/${teamId}/members/${this.me()}`) !== null &&
        this.ctx.getAfter(`users/${this.me()}/devices/${deviceId}`) !== null,
    );
  }

  // ---------------------------------------------------------------- invites

  redeems(code: string, d: DocData, e: DocData): boolean {
    const joined = this.ctx.getAfter(`teams/${asString(e.teamId)}/members/${this.me()}`);
    return (
      this.signedIn() &&
      onlyChanged(d, e, ["uses"]) &&
      d.uses === (e.uses as number) + 1 &&
      e.revoked === false &&
      before(this.ctx.now, e.expiresAt) &&
      (e.uses as number) < (e.maxUses as number) &&
      this.ctx.get(`teams/${asString(e.teamId)}/members/${this.me()}`) === null &&
      joined !== null &&
      joined.invite === code
    );
  }

  invite(op: Op | "get", code: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return this.signedIn();
    if (op === "delete") return holds(() => this.purges(fields(before).teamId));
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          isRandomId(code) &&
          hasExactly(
            d,
            ["teamId", "role", "expiresAt", "maxUses", "uses", "autoApprove", "createdBy", "createdAt", "revoked"],
            [],
          ) &&
          this.isTeamAdmin(d.teamId) &&
          ["admin", "editor", "viewer"].includes(d.role as string) &&
          isTimestamp(d.expiresAt) &&
          d.expiresAt.getTime() > this.ctx.now.getTime() &&
          isInt(d.maxUses) &&
          d.maxUses >= 1 &&
          d.uses === 0 &&
          isBool(d.autoApprove) &&
          !(d.autoApprove === true && d.role === "admin") &&
          d.createdBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          d.revoked === false,
      );
    }
    const e = fields(before);
    return any(
      () =>
        this.isTeamAdmin(e.teamId) &&
        e.revoked === false &&
        onlyChanged(d, e, ["expiresAt", "maxUses", "autoApprove", "revoked"]) &&
        isTimestamp(d.expiresAt) &&
        isInt(d.maxUses) &&
        d.maxUses >= 1 &&
        isBool(d.autoApprove) &&
        !(d.autoApprove === true && e.role === "admin") &&
        isBool(d.revoked),
      () => this.redeems(code, d, e),
    );
  }

  // ---------------------------------------------------------------- shares

  isLive(share: DocData): boolean {
    return share.revokedAt === null && before(this.ctx.now, share.expiresAt);
  }

  isRecipient(teamIds: unknown): boolean {
    if (!Array.isArray(teamIds)) fail();
    return teamIds.slice(0, 8).some((teamId) => holds(() => this.isActive(teamId)));
  }

  validShare(s: DocData): boolean {
    const teamIds = s.teamIds;
    return (
      ["teams", "link"].includes(s.audience as string) &&
      ["view", "propose"].includes(s.level as string) &&
      ["pinned", "follow"].includes(s.mode as string) &&
      Array.isArray(teamIds) &&
      (s.audience === "link"
        ? teamIds.length === 0 && s.level === "view"
        : teamIds.length >= 1 && teamIds.length <= 8 && !teamIds.includes(s.ownerTeamId)) &&
      isTimestamp(s.expiresAt) &&
      (s.revokedAt === null || sameTime(s.revokedAt, this.ctx.now)) &&
      typeof s.revision === "string" &&
      isEnvelope(s.projection, MAX_SHARE_PROJECTION_BYTES) &&
      (s.audience === "link" ? this.validLinkKeys(s) : this.validTeamKeys(s))
    );
  }

  validLinkKeys(s: DocData): boolean {
    return (
      (s.projection as DocData).kv === 1 &&
      isEnvelope(s.linkWrap, 32) &&
      (s.linkWrap.ct as Uint8Array).byteLength === 32 &&
      isShareManifest(s.manifest) &&
      !["keyWraps", "ownerWrap", "prevKeys"].some((key) => Object.hasOwn(s, key))
    );
  }

  /** Only a new share is checked whole, and a new share has no `prevKeys`. */
  validTeamKeys(s: DocData): boolean {
    const teamIds = s.teamIds as unknown[];
    const wraps = s.keyWraps;
    return (
      isMap(wraps) &&
      teamIds.every((teamId) => typeof teamId === "string" && Object.hasOwn(wraps, teamId)) &&
      Object.keys(wraps).every((key) => teamIds.includes(key)) &&
      areShareKeyWraps(Object.values(wraps)) &&
      isSealedKey(s.ownerWrap) &&
      isShareManifest(s.manifest) &&
      !Object.hasOwn(s, "linkWrap")
    );
  }

  mayMakeShare(s: DocData): boolean {
    const role = this.roleIn(s.ownerTeamId);
    return role === "owner" || role === "admin" || (role === "editor" && this.editorMayMake(s));
  }

  editorMayMake(s: DocData): boolean {
    return (
      (s.audience === "teams" || this.teamAllows(s.ownerTeamId, "editorsMayLinkShare")) &&
      (s.level === "view" || this.teamAllows(s.ownerTeamId, "editorsMayProposeShare"))
    );
  }

  /**
   * `updatesShare(before, after, changed)`: an update checks only the fields it changes. The role is
   * read from the membership document itself, so a caller with none is an evaluation error.
   */
  updatesShare(e: DocData, d: DocData, changed: Set<string>): boolean {
    const role = field(this.ctx.get(`teams/${asString(e.ownerTeamId)}/members/${this.me()}`), "role");
    const has = (keys: string[]): boolean => keys.some((key) => changed.has(key));
    return (
      [...changed].every((key) => SHARE_UPDATE_FIELDS.includes(key)) &&
      changed.has("manifest") &&
      any(
        () => role === "owner" || role === "admin",
        () =>
          role === "editor" &&
          any(
            () => e.mode === "follow" && this.publishes(e, d, changed),
            () => e.createdBy === this.me() && this.editorMayMake(d),
          ),
      ) &&
      (!changed.has("revision") || (typeof d.revision === "string" && this.revisionExists(d))) &&
      (!has(["expiresAt", "revokedAt", "level", "mode"]) || this.shareTermsFit(e, d, changed)) &&
      (!has(["projection", "teamIds", "keyWraps", "ownerWrap", "prevKeys", "manifest"]) || this.shareKeyMoves(e, d, changed))
    );
  }

  /** `publishes(before, after, changed)`: the version, projection and manifest only, or a re-key for the same teams with them. */
  publishes(e: DocData, d: DocData, changed: Set<string>): boolean {
    const only = (keys: string[]): boolean => [...changed].every((key) => keys.includes(key));
    return (
      only(["revision", "projection", "updatedAt", "keyWraps", "ownerWrap", "prevKeys", "manifest"]) &&
      any(
        () => field(d.projection as DocData, "kv") === (field(e.projection as DocData, "kv") as number) + 1,
        () => only(["revision", "projection", "updatedAt", "manifest"]),
      )
    );
  }

  shareTermsFit(e: DocData, d: DocData, changed: Set<string>): boolean {
    return (
      (!changed.has("expiresAt") || isTimestamp(field(d, "expiresAt"))) &&
      (!changed.has("revokedAt") || sameTime(field(d, "revokedAt"), this.ctx.now)) &&
      (!changed.has("level") || (e.audience === "teams" && ["view", "propose"].includes(field(d, "level") as string))) &&
      (!changed.has("mode") || ["pinned", "follow"].includes(field(d, "mode") as string))
    );
  }

  /** `shareKeyMoves(before, after, changed)`: the key version never drops, and taking a team off needs a new key. */
  shareKeyMoves(e: DocData, d: DocData, changed: Set<string>): boolean {
    const was = field(e.projection as DocData, "kv") as number;
    const moves =
      field(d.projection as DocData, "kv") === was
        ? (!changed.has("projection") || isEnvelopeUnder(d.projection, was, MAX_SHARE_PROJECTION_BYTES)) &&
          !changed.has("prevKeys") &&
          (!changed.has("teamIds") || (e.teamIds as unknown[]).every((teamId) => asList(field(d, "teamIds")).includes(teamId)))
        : isEnvelopeUnder(d.projection, was + 1, MAX_SHARE_PROJECTION_BYTES) && this.replacesShareKey(e, d, String(was));
    return (
      moves &&
      (!(changed.has("teamIds") || changed.has("keyWraps")) || this.shareWrapsFit(e, d, changed)) &&
      (!changed.has("ownerWrap") || this.ownerWrapFits(d)) &&
      (!changed.has("manifest") || isShareManifest(field(d, "manifest")))
    );
  }

  /** `replacesShareKey(before, after, old)`: `old` is added to prevKeys sealed under the new key, and nothing else there changes. */
  replacesShareKey(e: DocData, d: DocData, old: string): boolean {
    const prevBefore = mapOr(e, "prevKeys");
    const prevAfter = field(d, "prevKeys");
    if (!isMap(prevAfter)) fail();
    return (
      e.audience === "teams" &&
      Object.keys(prevAfter).length <= MAX_PREVIOUS_SHARE_KEYS &&
      !Object.hasOwn(prevBefore, old) &&
      [...affectedKeys(prevAfter, prevBefore)].every((key) => key === old) &&
      isSealedKeyUnder(field(prevAfter, old), (field(e.projection as DocData, "kv") as number) + 1)
    );
  }

  /** `shareWrapsFit(before, after, changed)`: 1 to 8 teams, never its own, with a valid wrap for exactly each. */
  shareWrapsFit(e: DocData, d: DocData, changed: Set<string>): boolean {
    const ids = field(d, "teamIds");
    const wraps = field(d, "keyWraps");
    if (!Array.isArray(ids) || !isMap(wraps)) fail();
    const idSet = new Set(ids);
    return (
      e.audience === "teams" &&
      (!changed.has("teamIds") || (ids.length >= 1 && ids.length <= 8 && !ids.includes(e.ownerTeamId))) &&
      Object.keys(wraps).length === idSet.size &&
      Object.keys(wraps).every((key) => idSet.has(key)) &&
      areShareKeyWraps(Object.values(wraps))
    );
  }

  ownerWrapFits(s: DocData): boolean {
    return s.audience === "teams" && isSealedKeyUnder(s.ownerWrap, this.teamKeyVersionAfter(s.ownerTeamId));
  }

  revisionExists(s: DocData): boolean {
    return (
      this.ctx.getAfter(
        `teams/${asString(s.ownerTeamId)}/autos/${asString(s.autoId)}/revisions/${asString(s.revision)}`,
      ) !== null
    );
  }

  ownerTeamExists(share: DocData): boolean {
    return this.ctx.get(`teams/${asString(share.ownerTeamId)}`) !== null;
  }

  share(op: Op | "get", shareId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => e.audience === "link" && this.isLive(e) && this.ownerTeamExists(e),
        () => this.isActive(e.ownerTeamId) && this.ownerTeamExists(e),
        () => e.audience === "teams" && this.isLive(e) && this.isRecipient(e.teamIds) && this.ownerTeamExists(e),
        () => this.isHorizonAdmin(),
      );
    }
    if (op === "delete") return false;
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          this.signedIn() &&
          isRandomId(shareId) &&
          hasExactly(
            d,
            [
              "ownerTeamId",
              "autoId",
              "audience",
              "teamIds",
              "level",
              "mode",
              "revision",
              "expiresAt",
              "revokedAt",
              "createdBy",
              "createdAt",
              "updatedAt",
              "projection",
              "manifest",
            ],
            ["keyWraps", "ownerWrap", "linkWrap", "ownerChoice"],
          ) &&
          this.validShare(d) &&
          (d.projection as DocData).kv === 1 &&
          (d.audience === "link"
            ? (d.linkWrap as DocData).kv === this.teamKeyVersionAfter(d.ownerTeamId)
            : (d.ownerWrap as DocData).kv === this.teamKeyVersionAfter(d.ownerTeamId)) &&
          (!Object.hasOwn(d, "ownerChoice") || isEnvelopeUnder(d.ownerChoice, this.teamKeyVersionAfter(d.ownerTeamId), MAX_OWNER_CHOICE_BYTES)) &&
          d.revokedAt === null &&
          (d.expiresAt as Date).getTime() > this.ctx.now.getTime() &&
          d.createdBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          sameTime(d.updatedAt, this.ctx.now) &&
          this.mayMakeShare(d) &&
          this.revisionExists(d),
      );
    }
    const e = fields(before);
    return holds(
      () =>
        this.signedIn() &&
        e.revokedAt === null &&
        sameTime(d.updatedAt, this.ctx.now) &&
        this.updatesShare(e, d, affectedKeys(d, e)),
    );
  }

  // ---------------------------------------------------------------- requests for more time

  asksForMoreTime(shareId: string, teamId: string, d: DocData): boolean {
    const share = this.ctx.get(`shares/${shareId}`);
    return (
      this.isActive(teamId) &&
      share !== null &&
      share.audience === "teams" &&
      (share.teamIds as unknown[]).includes(teamId) &&
      share.revokedAt === null &&
      this.ownerTeamExists(share) &&
      hasExactly(d, ["shareId", "teamId", "ownerTeamId", "requestedBy", "requestedAt", "status"], ["reason", "wantedUntil"]) &&
      d.shareId === shareId &&
      d.teamId === teamId &&
      d.ownerTeamId === share.ownerTeamId &&
      d.requestedBy === this.me() &&
      sameTime(d.requestedAt, this.ctx.now) &&
      d.status === "open" &&
      (!Object.hasOwn(d, "reason") || (TIME_REQUEST_REASONS as readonly unknown[]).includes(d.reason)) &&
      (!Object.hasOwn(d, "wantedUntil") || (isTimestamp(d.wantedUntil) && d.wantedUntil.getTime() > this.ctx.now.getTime()))
    );
  }

  decidesTimeRequest(shareId: string, d: DocData, e: DocData): boolean {
    const shareBefore = fields(this.ctx.get(`shares/${shareId}`));
    const shareAfter = fields(this.ctx.getAfter(`shares/${shareId}`));
    return (
      e.status === "open" &&
      onlyChanged(d, e, ["status", "decidedBy", "decidedAt", "grantedUntil"]) &&
      d.decidedBy === this.me() &&
      sameTime(d.decidedAt, this.ctx.now) &&
      any(
        () => this.isTeamAdmin(e.ownerTeamId),
        () => shareBefore.createdBy === this.me() && this.isEditor(e.ownerTeamId),
      ) &&
      any(
        () => d.status === "declined" && !Object.hasOwn(d, "grantedUntil"),
        () =>
          d.status === "granted" &&
          shareAfter.revokedAt === null &&
          sameTime(shareAfter.updatedAt, this.ctx.now) &&
          isTimestamp(shareAfter.expiresAt) &&
          isTimestamp(shareBefore.expiresAt) &&
          shareAfter.expiresAt.getTime() > shareBefore.expiresAt.getTime() &&
          shareAfter.expiresAt.getTime() > this.ctx.now.getTime() &&
          valuesEqual(d.grantedUntil, shareAfter.expiresAt),
      )
    );
  }

  timeRequest(op: Op | "get", shareId: string, teamId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => this.readsAsMember(teamId),
        () => this.readsAsMember(e.ownerTeamId),
      );
    }
    if (op === "delete") return false;
    const d = fields(after);
    if (op === "create") return holds(() => this.asksForMoreTime(shareId, teamId, d));
    const e = fields(before);
    return any(
      () => ["granted", "declined"].includes(e.status as string) && this.asksForMoreTime(shareId, teamId, d),
      () => this.decidesTimeRequest(shareId, d, e),
    );
  }

  // ---------------------------------------------------------------- proposals

  grantsPropose(p: DocData): boolean {
    const share = this.ctx.get(`shares/${asString(p.shareId)}`);
    return (
      share !== null &&
      share.audience === "teams" &&
      share.level === "propose" &&
      this.isLive(share) &&
      (share.teamIds as unknown[]).includes(p.fromTeamId) &&
      p.ownerTeamId === share.ownerTeamId &&
      p.autoId === share.autoId &&
      this.ownerTeamExists(share) &&
      field(p.ownerWrap as DocData, "ekv") === field(this.ctx.get(`teams/${asString(share.ownerTeamId)}`)?.encKey as DocData, "v") &&
      this.baseRevisionFits(p, share)
    );
  }

  /** A pinned share takes a proposal on its own revision only; a following one on any of the auto's. */
  baseRevisionFits(p: DocData, share: DocData): boolean {
    const base = asString(p.baseRevision);
    return (
      REVISION_ID.test(base) &&
      any(
        () => base === share.revision,
        () =>
          share.mode === "follow" &&
          this.ctx.get(`teams/${asString(share.ownerTeamId)}/autos/${asString(share.autoId)}/revisions/${base}`) !== null,
      )
    );
  }

  proposal(op: Op | "get", proposalId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => this.readsAsMember(e.ownerTeamId),
        () => this.readsAsMember(e.fromTeamId),
      );
    }
    if (op === "delete") return false;
    const d = fields(after);
    if (op === "create") {
      return holds(
        () =>
          this.signedIn() &&
          isRandomId(proposalId) &&
          hasExactly(
            d,
            ["shareId", "ownerTeamId", "autoId", "fromTeamId", "baseRevision", "diff", "ownerWrap", "fromWrap", "sig", "status", "createdBy", "createdAt"],
            [],
          ) &&
          d.status === "open" &&
          d.createdBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          typeof d.baseRevision === "string" &&
          isEnvelopeUnder(d.diff, 1, MAX_PROPOSAL_DIFF_BYTES) &&
          isShareKeyWrap(d.ownerWrap) &&
          isSealedKey(d.fromWrap) &&
          bytesOf(d.sig, 64) &&
          this.isEditor(d.fromTeamId) &&
          this.grantsPropose(d),
      );
    }
    const e = fields(before);
    return holds(
      () =>
        this.signedIn() &&
        e.status === "open" &&
        onlyChanged(d, e, ["status", "decidedBy", "decidedAt"]) &&
        d.decidedBy === this.me() &&
        sameTime(d.decidedAt, this.ctx.now) &&
        any(
          () => ["accepted", "rejected"].includes(d.status as string) && this.isEditor(e.ownerTeamId),
          () => d.status === "withdrawn" && e.createdBy === this.me(),
        ),
    );
  }

  // ---------------------------------------------------------------- evidence and reasons

  evidenceBody(entry: DocData): boolean {
    return (
      ["kind", "summary", "by", "at"].every((k) => Object.hasOwn(entry, k)) &&
      ["photo", "event", "statement"].includes(entry.kind as string) &&
      text(entry.summary, 500) &&
      entry.by === this.me() &&
      isTimestamp(entry.at) &&
      (Object.hasOwn(entry, "url") ? evidenceUrl(entry.url) : entry.kind === "statement")
    );
  }

  requestEvidence(entry: unknown): boolean {
    const e = fields((entry ?? null) as DocData | null);
    return Object.keys(e).every((k) => ["kind", "summary", "url", "by", "at"].includes(k)) && this.evidenceBody(e);
  }

  requestEvidenceList(list: unknown): boolean {
    return Array.isArray(list) && list.length >= 1 && list.length <= 6 && list.every((entry) => this.requestEvidence(entry));
  }

  // ---------------------------------------------------------------- claims

  /** `getAfter(historyPath(teamNumber, index))`. */
  stepAfter(teamNumber: string, index: unknown): DocData | null {
    if (!isInt(index)) fail();
    return this.ctx.getAfter(`claims/${teamNumber}/history/${String(index)}`);
  }

  claimsFirst(teamNumber: string, d: DocData): boolean {
    const first = fields(this.stepAfter(teamNumber, 0));
    return first.kind === "claim" && first.teamId === d.teamId && first.otherTeamId === null && first.by === this.me();
  }

  newStep(teamNumber: string, e: DocData): DocData {
    return fields(this.stepAfter(teamNumber, e.historyCount));
  }

  appendsOwnStep(teamNumber: string, d: DocData, e: DocData): boolean {
    return isInt(e.historyCount) && d.historyCount === e.historyCount + 1 && this.newStep(teamNumber, e).by === this.me();
  }

  contests(teamNumber: string, d: DocData, e: DocData): boolean {
    const step = this.newStep(teamNumber, e);
    const dispute = this.ctx.getAfter(`disputes/${asString(step.disputeId)}`);
    return (
      e.teamId !== null &&
      ["unverified", "verified"].includes(e.status as string) &&
      getOr(e, "disputeId", null) === null &&
      onlyChanged(d, e, ["status", "historyCount", "disputeId"]) &&
      d.status === (e.status === "verified" ? "verified" : "contested") &&
      this.appendsOwnStep(teamNumber, d, e) &&
      step.kind === "contest" &&
      step.teamId !== e.teamId &&
      field(step, "otherTeamId") === e.teamId &&
      this.isTeamAdmin(step.teamId) &&
      valuesEqual(field(d, "disputeId"), step.disputeId) &&
      field(dispute, "challengerTeamId") === step.teamId &&
      field(dispute, "holderTeamId") === e.teamId &&
      field(dispute, "teamNumber") === Number.parseInt(teamNumber, 10)
    );
  }

  /** The team holding the claim is being deleted: the claim stays, detached, with a 'release' step. */
  releasesOnDelete(teamNumber: string, d: DocData, e: DocData): boolean {
    const step = this.newStep(teamNumber, e);
    return (
      e.teamId !== null &&
      this.purges(e.teamId) &&
      onlyChanged(d, e, ["teamId", "status", "historyCount"]) &&
      field(d, "teamId") === null &&
      d.status === (getOr(e, "disputeId", null) === null ? "unverified" : e.status) &&
      this.appendsOwnStep(teamNumber, d, e) &&
      step.kind === "release" &&
      step.teamId === e.teamId &&
      field(step, "otherTeamId") === null
    );
  }

  /** A team claims a number nobody holds, afresh, once no review or request is open on it. */
  claimsReleased(teamNumber: string, d: DocData, e: DocData): boolean {
    const step = this.newStep(teamNumber, e);
    const team = this.ctx.getAfter(`teams/${asString(d.teamId)}`);
    const role = this.roleAfter(d.teamId);
    return (
      field(e, "teamId") === null &&
      getOr(e, "disputeId", null) === null &&
      getOr(e, "requestId", null) === null &&
      onlyChanged(d, e, ["teamId", "status", "claimedAt", "historyCount"]) &&
      d.status === "unverified" &&
      sameTime(d.claimedAt, this.ctx.now) &&
      this.appendsOwnStep(teamNumber, d, e) &&
      step.kind === "claim" &&
      step.teamId === d.teamId &&
      field(step, "otherTeamId") === null &&
      field(team, "number") === Number.parseInt(teamNumber, 10) &&
      (role === "owner" || role === "admin")
    );
  }

  requestsVerification(teamNumber: string, d: DocData, e: DocData): boolean {
    const step = this.newStep(teamNumber, e);
    const pending = this.ctx.getAfter(`verifications/${asString(step.requestId)}`);
    return (
      e.status === "unverified" &&
      getOr(e, "requestId", null) === null &&
      onlyChanged(d, e, ["historyCount", "requestId"]) &&
      this.appendsOwnStep(teamNumber, d, e) &&
      step.kind === "request" &&
      step.teamId === e.teamId &&
      field(step, "otherTeamId") === null &&
      this.isTeamAdmin(e.teamId) &&
      valuesEqual(field(d, "requestId"), step.requestId) &&
      field(pending, "teamId") === e.teamId &&
      field(pending, "status") === "open"
    );
  }

  appealsDecision(teamNumber: string, d: DocData, e: DocData): boolean {
    const step = this.newStep(teamNumber, e);
    const dispute = fields(this.ctx.getAfter(`disputes/${asString(step.disputeId)}`));
    const appeal = fields(dispute.appeal as DocData | null);
    const decision = fields(dispute.decision as DocData | null);
    return (
      onlyChanged(d, e, ["historyCount"]) &&
      this.appendsOwnStep(teamNumber, d, e) &&
      step.kind === "appeal" &&
      this.isTeamAdmin(step.teamId) &&
      field(dispute, "teamNumber") === Number.parseInt(teamNumber, 10) &&
      field(step, "otherTeamId") === field(decision, "winner") &&
      field(appeal, "team") === step.teamId &&
      field(appeal, "by") === this.me() &&
      sameTime(field(appeal, "at"), this.ctx.now)
    );
  }

  /** The step names the winner, and the other team of the dispute as the team that lost. */
  namesBothTeams(step: DocData, dispute: DocData, winner: unknown): boolean {
    const other = field(step, "otherTeamId");
    return step.teamId === winner && [dispute.holderTeamId, dispute.challengerTeamId].includes(other) && other !== winner;
  }

  reviewerDecides(teamNumber: string, d: DocData, e: DocData): boolean {
    const n = Number.parseInt(teamNumber, 10);
    if (
      !(
        this.isHorizonAdmin() &&
        onlyChanged(d, e, ["teamId", "status", "historyCount", "disputeId", "requestId"]) &&
        this.appendsOwnStep(teamNumber, d, e)
      )
    ) {
      return false;
    }
    const step = this.newStep(teamNumber, e);
    return any(
      // decidesRequest
      () => {
        const decided = fields(this.ctx.getAfter(`verifications/${asString(step.requestId)}`));
        const decision = fields(decided.decision as DocData | null);
        return (
          ["verify", "decline"].includes(step.kind as string) &&
          field(step, "otherTeamId") === null &&
          valuesEqual(step.requestId, getOr(e, "requestId", null)) &&
          getOr(d, "requestId", null) === null &&
          unchanged(d, e, ["teamId", "disputeId"]) &&
          field(decided, "teamNumber") === n &&
          field(decision, "by") === this.me() &&
          sameTime(field(decision, "at"), this.ctx.now) &&
          (step.kind === "verify"
            ? decision.verdict === "verified" && e.status === "unverified" && d.status === "verified" && decided.teamId === e.teamId
            : decision.verdict === "declined" && unchanged(d, e, ["status"]))
        );
      },
      // decidesDispute
      () => {
        const dispute = fields(this.ctx.getAfter(`disputes/${asString(step.disputeId)}`));
        const decision = fields(dispute.decision as DocData | null);
        return (
          step.kind === "decision" &&
          valuesEqual(step.disputeId, getOr(e, "disputeId", null)) &&
          getOr(d, "disputeId", null) === null &&
          unchanged(d, e, ["requestId"]) &&
          field(dispute, "teamNumber") === n &&
          dispute.status === "decided" &&
          field(decision, "by") === this.me() &&
          sameTime(field(decision, "at"), this.ctx.now) &&
          this.namesBothTeams(step, dispute, decision.winner) &&
          d.teamId === decision.winner &&
          d.status === "verified"
        );
      },
      // decidesAppeal: by any Horizon admin, the one who made the first decision included
      () => {
        const dispute = fields(this.ctx.getAfter(`disputes/${asString(step.disputeId)}`));
        const decision = fields(dispute.appealDecision as DocData | null);
        return (
          step.kind === "appeal-decision" &&
          unchanged(d, e, ["requestId", "disputeId"]) &&
          field(dispute, "teamNumber") === n &&
          dispute.status === "final" &&
          field(decision, "by") === this.me() &&
          sameTime(field(decision, "at"), this.ctx.now) &&
          this.namesBothTeams(step, dispute, decision.winner) &&
          d.teamId === decision.winner &&
          d.status === "verified"
        );
      },
    );
  }

  claim(op: Op | "get", teamNumber: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") return this.signedIn();
    if (op === "delete") {
      return holds(() => {
        const e = fields(before);
        return this.isOwner(e.teamId) && e.historyCount === 1 && this.stepAfter(teamNumber, 0) === null;
      });
    }
    const d = fields(after);
    if (op === "create") {
      return holds(() => {
        const team = this.ctx.getAfter(`teams/${asString(d.teamId)}`);
        const role = this.roleAfter(d.teamId);
        return (
          this.signedIn() &&
          /^[1-9][0-9]{0,5}$/.test(teamNumber) &&
          hasExactly(d, ["teamId", "status", "claimedAt", "historyCount"], ["disputeId", "requestId"]) &&
          d.status === "unverified" &&
          sameTime(d.claimedAt, this.ctx.now) &&
          getOr(d, "disputeId", null) === null &&
          getOr(d, "requestId", null) === null &&
          d.historyCount === 1 &&
          this.claimsFirst(teamNumber, d) &&
          field(team, "number") === Number.parseInt(teamNumber, 10) &&
          (role === "owner" || role === "admin")
        );
      });
    }
    const e = fields(before);
    return any(
      () => this.contests(teamNumber, d, e),
      () => this.requestsVerification(teamNumber, d, e),
      () => this.appealsDecision(teamNumber, d, e),
      () => this.reviewerDecides(teamNumber, d, e),
      () => this.releasesOnDelete(teamNumber, d, e),
      () => this.claimsReleased(teamNumber, d, e),
    );
  }

  isNextStep(teamNumber: string, n: number): boolean {
    const claimBefore = this.ctx.get(`claims/${teamNumber}`);
    const claimAfter = this.ctx.getAfter(`claims/${teamNumber}`);
    return (
      claimAfter !== null &&
      claimAfter.historyCount === n + 1 &&
      (claimBefore === null ? n === 0 : claimBefore.historyCount === n)
    );
  }

  droppedWithClaim(teamNumber: string): boolean {
    const claimBefore = this.ctx.get(`claims/${teamNumber}`);
    return (
      claimBefore !== null &&
      this.ctx.getAfter(`claims/${teamNumber}`) === null &&
      claimBefore.historyCount === 1 &&
      this.isOwner(claimBefore.teamId)
    );
  }

  claimStep(op: Op | "get", teamNumber: string, index: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => this.isHorizonAdmin(),
        () => this.readsAsMember(e.teamId),
        () => this.readsAsMember(e.otherTeamId),
      );
    }
    if (op === "update") return false;
    if (op === "delete") return holds(() => index === "0" && this.droppedWithClaim(teamNumber));
    const d = fields(after);
    return holds(() => {
      const note = getOr(d, "note", "");
      return (
        this.signedIn() &&
        /^(0|[1-9][0-9]{0,3})$/.test(index) &&
        hasExactly(d, ["kind", "teamId", "otherTeamId", "by", "at"], ["disputeId", "requestId", "note"]) &&
        ["claim", "request", "verify", "decline", "contest", "decision", "appeal", "appeal-decision", "release"].includes(
          d.kind as string,
        ) &&
        text(d.teamId, 64) &&
        (d.otherTeamId === null || text(d.otherTeamId, 64)) &&
        d.by === this.me() &&
        sameTime(d.at, this.ctx.now) &&
        stringOrAbsent(d, "disputeId") &&
        stringOrAbsent(d, "requestId") &&
        typeof note === "string" &&
        note.length <= 500 &&
        this.isNextStep(teamNumber, Number.parseInt(index, 10))
      );
    });
  }

  // ---------------------------------------------------------------- verification requests

  verification(op: Op | "get", requestId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => this.isHorizonAdmin(),
        () => this.readsAsMember(e.teamId),
      );
    }
    if (op === "delete") return false;
    const d = fields(after);
    if (op === "create") {
      return holds(() => {
        const claimBefore = fields(this.ctx.get(`claims/${String(d.teamNumber)}`));
        const claimAfter = fields(this.ctx.getAfter(`claims/${String(d.teamNumber)}`));
        return (
          this.signedIn() &&
          isRandomId(requestId) &&
          hasExactly(d, ["teamNumber", "teamId", "requestedBy", "createdAt", "status", "evidence", "decision"], []) &&
          isInt(d.teamNumber) &&
          d.status === "open" &&
          d.decision === null &&
          d.requestedBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          this.isTeamAdmin(d.teamId) &&
          this.requestEvidenceList(d.evidence) &&
          claimBefore.teamId === d.teamId &&
          claimBefore.status === "unverified" &&
          getOr(claimBefore, "requestId", null) === null &&
          field(claimAfter, "requestId") === requestId
        );
      });
    }
    const e = fields(before);
    return holds(() => {
      const decision = fields(d.decision as DocData | null);
      return (
        this.isHorizonAdmin() &&
        e.status === "open" &&
        onlyChanged(d, e, ["status", "decision"]) &&
        d.status === "decided" &&
        hasExactly(decision, ["verdict", "reason", "by", "at"], []) &&
        ["verified", "declined"].includes(decision.verdict as string) &&
        oneSentence(decision.reason) &&
        decision.by === this.me() &&
        sameTime(decision.at, this.ctx.now)
      );
    });
  }

  // ---------------------------------------------------------------- disputes

  isParty(dispute: DocData): boolean {
    return any(
      () => this.readsAsMember(dispute.holderTeamId),
      () => this.readsAsMember(dispute.challengerTeamId),
    );
  }

  validDecision(decision: unknown, e: DocData): boolean {
    const x = fields((decision ?? null) as DocData | null);
    return (
      hasExactly(x, ["winner", "reason", "by", "at"], []) &&
      [e.holderTeamId, e.challengerTeamId].includes(x.winner) &&
      oneSentence(x.reason) &&
      x.by === this.me() &&
      sameTime(x.at, this.ctx.now)
    );
  }

  dispute(op: Op | "get", disputeId: string, before: DocData | null, after: DocData | null): boolean {
    if (op === "get") {
      const e = fields(before);
      return any(
        () => this.isHorizonAdmin(),
        () => this.isParty(e),
      );
    }
    if (op === "delete") return false;
    const d = fields(after);
    if (op === "create") {
      return holds(() => {
        const claim = this.ctx.get(`claims/${String(d.teamNumber)}`);
        const claimAfter = this.ctx.getAfter(`claims/${String(d.teamNumber)}`);
        const challenger = this.ctx.get(`teams/${asString(d.challengerTeamId)}`);
        return (
          this.signedIn() &&
          isRandomId(disputeId) &&
          hasExactly(
            d,
            [
              "teamNumber",
              "holderTeamId",
              "challengerTeamId",
              "openedBy",
              "createdAt",
              "status",
              "evidence",
              "decision",
              "appeal",
              "appealDecision",
            ],
            [],
          ) &&
          isInt(d.teamNumber) &&
          d.status === "open" &&
          Array.isArray(d.evidence) &&
          d.evidence.length === 0 &&
          d.decision === null &&
          d.appeal === null &&
          d.appealDecision === null &&
          d.openedBy === this.me() &&
          sameTime(d.createdAt, this.ctx.now) &&
          d.holderTeamId !== d.challengerTeamId &&
          this.isTeamAdmin(d.challengerTeamId) &&
          field(challenger, "number") === null &&
          field(claim, "teamId") === d.holderTeamId &&
          field(claimAfter, "disputeId") === disputeId
        );
      });
    }
    const e = fields(before);
    return any(
      // decides: by any Horizon admin, a member of either team included
      () =>
        this.isHorizonAdmin() &&
        e.status === "open" &&
        onlyChanged(d, e, ["status", "decision"]) &&
        d.status === "decided" &&
        this.validDecision(d.decision, e),
      // decidesAppeal: by any Horizon admin, the first decider and members included, and final
      () =>
        this.isHorizonAdmin() &&
        e.status === "appealed" &&
        onlyChanged(d, e, ["status", "appealDecision"]) &&
        d.status === "final" &&
        this.validDecision(d.appealDecision, e),
      // addsEvidence
      () => {
        const entry = fields(((d.evidence as DocData[])[(e.evidence as unknown[]).length] ?? null) as DocData | null);
        return (
          this.signedIn() &&
          ["open", "appealed"].includes(e.status as string) &&
          onlyChanged(d, e, ["evidence"]) &&
          appendsOne(e.evidence, d.evidence) &&
          (d.evidence as unknown[]).length <= 20 &&
          Object.keys(entry).every((k) => ["team", "kind", "summary", "url", "by", "at"].includes(k)) &&
          this.evidenceBody(entry) &&
          [e.holderTeamId, e.challengerTeamId].includes(entry.team) &&
          this.isTeamAdmin(entry.team)
        );
      },
      // appeals: once, by the team that lost, within 14 days of the decision
      () => {
        const appeal = fields(d.appeal as DocData | null);
        const decision = fields(e.decision as DocData | null);
        const decidedAt = field(decision, "at");
        const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
        return (
          this.signedIn() &&
          e.status === "decided" &&
          e.appeal === null &&
          onlyChanged(d, e, ["appeal", "status"]) &&
          d.status === "appealed" &&
          hasExactly(appeal, ["team", "by", "reason", "at"], []) &&
          [e.holderTeamId, e.challengerTeamId].includes(appeal.team) &&
          appeal.team !== decision.winner &&
          appeal.by === this.me() &&
          sameTime(appeal.at, this.ctx.now) &&
          text(appeal.reason, 500) &&
          this.isTeamAdmin(appeal.team) &&
          isTimestamp(decidedAt) &&
          this.ctx.now.getTime() < decidedAt.getTime() + fourteenDaysMs
        );
      },
    );
  }
}

// ------------------------------------------------------------------------ routing

type Route =
  | { kind: "user"; uid: string }
  | { kind: "device"; uid: string; deviceId: string }
  | { kind: "teamKey"; teamId: string; kv: string }
  | { kind: "recovery"; teamId: string; docId: string }
  | { kind: "keyGrant"; teamId: string; deviceId: string }
  | { kind: "keyRequest"; teamId: string; deviceId: string }
  | { kind: "admin"; uid: string }
  | { kind: "betaTester"; uid: string }
  | { kind: "betaRequest"; uid: string }
  | { kind: "accessConfig" }
  | { kind: "team"; teamId: string }
  | { kind: "tombstone"; teamId: string }
  | { kind: "adminLog"; entryId: string }
  | { kind: "bugReport"; reportId: string }
  | { kind: "member"; teamId: string; uid: string }
  | { kind: "settings"; teamId: string; settingId: string }
  | { kind: "auto"; teamId: string; autoId: string }
  | { kind: "revision"; teamId: string; autoId: string; revisionId: string }
  | { kind: "inbox"; teamId: string; shareId: string }
  | { kind: "activity"; teamId: string; entryId: string }
  | { kind: "invite"; code: string }
  | { kind: "share"; shareId: string }
  | { kind: "timeRequest"; shareId: string; teamId: string }
  | { kind: "proposal"; proposalId: string }
  | { kind: "claim"; teamNumber: string }
  | { kind: "claimStep"; teamNumber: string; index: string }
  | { kind: "dispute"; disputeId: string }
  | { kind: "verification"; requestId: string };

function route(path: string): Route | null {
  const s = path.split("/");
  const [a, b, c, d, e, f] = s;
  if (s.some((segment) => segment === "")) return null;
  if (s.length === 2 && b !== undefined) {
    switch (a) {
      case "users":
        return { kind: "user", uid: b };
      case "admins":
        return { kind: "admin", uid: b };
      case "betaTesters":
        return { kind: "betaTester", uid: b };
      case "betaRequests":
        return { kind: "betaRequest", uid: b };
      case "config":
        return b === "access" ? { kind: "accessConfig" } : null;
      case "teams":
        return { kind: "team", teamId: b };
      case "deletedTeams":
        return { kind: "tombstone", teamId: b };
      case "adminLog":
        return { kind: "adminLog", entryId: b };
      case "bugReports":
        return { kind: "bugReport", reportId: b };
      case "invites":
        return { kind: "invite", code: b };
      case "shares":
        return { kind: "share", shareId: b };
      case "proposals":
        return { kind: "proposal", proposalId: b };
      case "claims":
        return { kind: "claim", teamNumber: b };
      case "disputes":
        return { kind: "dispute", disputeId: b };
      case "verifications":
        return { kind: "verification", requestId: b };
    }
    return null;
  }
  if (a === "claims" && b !== undefined && s.length === 4 && c === "history" && d !== undefined) {
    return { kind: "claimStep", teamNumber: b, index: d };
  }
  if (s.length === 4 && a === "shares" && b !== undefined && c === "timeRequests" && d !== undefined) {
    return { kind: "timeRequest", shareId: b, teamId: d };
  }
  if (s.length === 4 && a === "users" && b !== undefined && c === "devices" && d !== undefined) {
    return { kind: "device", uid: b, deviceId: d };
  }
  if (a !== "teams" || b === undefined) return null;
  if (s.length === 4 && d !== undefined) {
    switch (c) {
      case "members":
        return { kind: "member", teamId: b, uid: d };
      case "settings":
        return { kind: "settings", teamId: b, settingId: d };
      case "autos":
        return { kind: "auto", teamId: b, autoId: d };
      case "inbox":
        return { kind: "inbox", teamId: b, shareId: d };
      case "activity":
        return { kind: "activity", teamId: b, entryId: d };
      case "teamKeys":
        return { kind: "teamKey", teamId: b, kv: d };
      case "recovery":
        return { kind: "recovery", teamId: b, docId: d };
      case "keyGrants":
        return { kind: "keyGrant", teamId: b, deviceId: d };
      case "keyRequests":
        return { kind: "keyRequest", teamId: b, deviceId: d };
    }
    return null;
  }
  if (s.length === 6 && c === "autos" && d !== undefined && e === "revisions" && f !== undefined) {
    return { kind: "revision", teamId: b, autoId: d, revisionId: f };
  }
  return null;
}

function evaluate(ev: Evaluation, op: Op | "get", r: Route, before: DocData | null, after: DocData | null): boolean {
  switch (r.kind) {
    case "user":
      return ev.user(op, r.uid, before, after);
    case "device":
      return ev.device(op, r.uid, r.deviceId, after);
    case "teamKey":
      return ev.teamKey(op, r.teamId, r.kv, after);
    case "recovery":
      return ev.recovery(op, r.teamId, r.docId, before, after);
    case "keyGrant":
      return ev.keyGrant(op, r.teamId, r.deviceId, before, after);
    case "keyRequest":
      return ev.keyRequest(op, r.teamId, r.deviceId, before, after);
    case "admin":
      return ev.admin(op, r.uid, after);
    case "betaTester":
      return ev.betaTester(op, r.uid, after);
    case "betaRequest":
      return ev.betaRequest(op, r.uid);
    case "accessConfig":
      return ev.accessConfig(op);
    case "team":
      return ev.team(op, r.teamId, before, after);
    case "tombstone":
      return ev.tombstone(op, r.teamId, after);
    case "adminLog":
      return ev.adminLog(op, r.entryId, after);
    case "bugReport":
      return ev.bugReport(op, r.reportId, before, after);
    case "member":
      return ev.member(op, r.teamId, r.uid, before, after);
    case "settings":
      return ev.settings(op, r.teamId, r.settingId, after);
    case "auto":
      return ev.auto(op, r.teamId, before, after);
    case "revision":
      return ev.revision(op, r.teamId, r.autoId, r.revisionId, after);
    case "inbox":
      return ev.inbox(op, r.teamId, r.shareId, after);
    case "activity":
      return ev.activity(op, r.teamId, after);
    case "invite":
      return ev.invite(op, r.code, before, after);
    case "share":
      return ev.share(op, r.shareId, before, after);
    case "timeRequest":
      return ev.timeRequest(op, r.shareId, r.teamId, before, after);
    case "proposal":
      return ev.proposal(op, r.proposalId, before, after);
    case "claim":
      return ev.claim(op, r.teamNumber, before, after);
    case "claimStep":
      return ev.claimStep(op, r.teamNumber, r.index, before, after);
    case "dispute":
      return ev.dispute(op, r.disputeId, before, after);
    case "verification":
      return ev.verification(op, r.requestId, before, after);
  }
}

/** May the caller read the document at `path`, whose current value is `doc` (null when missing)? */
export function allowGet(ctx: RuleContext, path: string, doc: DocData | null): boolean {
  const r = route(path);
  if (r === null) return false;
  return holds(() => evaluate(new Evaluation(ctx), "get", r, doc, null));
}

/**
 * May the caller write `path` from `before` to `after` (null means missing)? Create, update and
 * delete are told apart the way Firestore does: by whether the document exists before and after.
 */
export function allowWrite(ctx: RuleContext, path: string, before: DocData | null, after: DocData | null): boolean {
  const r = route(path);
  if (r === null) return false;
  const op: Op = after === null ? "delete" : before === null ? "create" : "update";
  return holds(() => evaluate(new Evaluation(ctx), op, r, before, after));
}

function equalityOn(where: Filter[] | undefined, fieldName: string): unknown {
  const filter = (where ?? []).find((f) => f.field === fieldName);
  return filter === undefined ? undefined : filter.value;
}

/**
 * May the caller run this query? Like Firestore, the answer depends on the query, not on the
 * documents it would return: each list rule holds only when the query carries the equality filter
 * the rule is written for.
 */
export function allowList(ctx: RuleContext, query: Query): boolean {
  const ev = new Evaluation(ctx);
  const owns = (fieldName: string) => {
    const value = equalityOn(query.where, fieldName);
    return value !== undefined && holds(() => ev.readsAsMember(value));
  };
  const ownMembership = () => ctx.uid !== null && equalityOn(query.where, "uid") === ctx.uid;

  if (query.group === true) {
    if (query.collection === "timeRequests") return owns("teamId") || owns("ownerTeamId");
    return query.collection === "members" && ownMembership();
  }

  const s = query.collection.split("/");
  if (s.length === 1) {
    switch (s[0]) {
      case "shares":
        return holds(() => ev.isHorizonAdmin()) || owns("ownerTeamId");
      case "proposals":
        return owns("ownerTeamId") || owns("fromTeamId");
      case "disputes":
        return holds(() => ev.isHorizonAdmin()) || owns("holderTeamId") || owns("challengerTeamId");
      case "verifications":
        return holds(() => ev.isHorizonAdmin()) || owns("teamId");
      case "claims":
      case "admins":
      case "betaTesters":
      case "betaRequests":
      case "deletedTeams":
      case "adminLog":
      case "bugReports":
        return holds(() => ev.isHorizonAdmin());
      default:
        return false;
    }
  }
  const [root, teamId, sub, , leaf] = s;
  // A user lists their own devices.
  if (root === "users" && s.length === 3 && sub === "devices") return ctx.uid !== null && teamId === ctx.uid;
  if (root === "claims" && s.length === 3 && sub === "history") {
    return holds(() => ev.isHorizonAdmin()) || owns("teamId") || owns("otherTeamId");
  }
  // One share's requests for more time, under the same collection group rule.
  if (s.length === 3 && root === "shares" && sub === "timeRequests") return owns("teamId") || owns("ownerTeamId");
  if (root !== "teams" || teamId === undefined) return false;
  if (s.length === 3) {
    switch (sub) {
      case "members":
        return holds(() => ev.readsAsMember(teamId)) || ownMembership() || holds(() => ev.isHorizonAdmin() && !ev.neverDeleted(teamId));
      case "settings":
      case "autos":
      case "inbox":
        return holds(() => ev.readsAsMember(teamId));
      case "activity":
        return holds(() => ev.isTeamAdmin(teamId) && ev.teamExists(teamId));
      case "teamKeys":
      case "recovery":
        return holds(() => ev.readsAsMember(teamId));
      // Grants: a member's own, filtered on uid, while active; every one for owners and admins.
      case "keyGrants":
        return (ownMembership() && holds(() => ev.isActive(teamId))) || holds(() => ev.isTeamAdmin(teamId));
      // Requests: a member's own, filtered on uid; every one for whoever may grant them.
      case "keyRequests":
        return (
          ownMembership() ||
          holds(() => ev.isTeamAdmin(teamId)) ||
          holds(() => ev.isActive(teamId) && ev.teamAllows(teamId, "membersMayApproveDevices"))
        );
      default:
        return false;
    }
  }
  if (s.length === 5 && sub === "autos" && leaf === "revisions") return holds(() => ev.readsAsMember(teamId));
  return false;
}
