/**
 * What this device remembers (spec 14 section 4.6: trust on first use). The first time a device opens
 * its own team's keys, wraps a share key to a partner team, or checks a share manifest a partner
 * team signed, it keeps that team's `encKey` version,
 * fingerprint and signing key. Later it refuses a key that is older, or different under the same
 * version, and takes a newer one from a partner only when the signatures from the pinned version up
 * to it check, because anything else is what a server trying to read the team's data would show.
 * When a partner pin moves to a newer version, the pin it replaces is kept among a few earlier ones,
 * so a proposal that partner signed under an older version can still be checked. Each partner pin
 * also says whether this device checked it (`writePartnerPin`) or only trusted it on first use, as
 * it does for the team a received share claims to come from, which the server alone can make.
 *
 * It also keeps, per share, the newest share key version it has used, the newest owner team key
 * version it has seen sign the share's manifest, and the highest manifest and terms counts it has
 * seen, and per auto the newest title
 * generation it has read, so the server cannot put an older one back; and, while this device waits
 * for a team key, the random part of its approval code.
 *
 * Everything is kept per signed-in user, in storage the app passes in: `localStorage` in the browser,
 * so it lasts between sessions, or memory on a shared computer and in tests. None of it is ever sent
 * anywhere.
 */
import { base64urlDecode, base64urlEncode, bytesEqual } from "../crypto/bytes.js";
import type { TeamEncKey } from "../crypto/team.js";

/** Where pins are kept. Values are short JSON texts; keys start with `zenith.pin.`. */
export interface TrustStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /**
   * True once a value could not be saved, so the store keeps it for this session only. A store
   * that never saves between sessions by design (memory on a shared computer) leaves it out.
   */
  failedToSave?(): boolean;
}

/** Pins in memory only, gone when the page closes: for a shared computer and for tests. */
export class MemoryTrustStore implements TrustStore {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** The part of the Web Storage interface a `StorageTrustStore` uses; `localStorage` has it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Pins in a Web Storage object such as `localStorage`. When the storage throws on a save (it is full,
 * or turned off in a private window), the value is kept in memory for this session instead, and
 * `failedToSave` says so: a waiting device then keeps its approval code until the page closes,
 * though it needs approving again in a later session.
 */
export class StorageTrustStore implements TrustStore {
  /** Values the storage refused, newer than anything it holds under the same key. */
  private readonly unsaved = new Map<string, string>();
  private failed = false;

  constructor(private readonly storage: StorageLike) {}

  get(key: string): string | null {
    const held = this.unsaved.get(key);
    if (held !== undefined) return held;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
      this.unsaved.delete(key);
    } catch {
      this.unsaved.set(key, value);
      this.failed = true;
    }
  }

  failedToSave(): boolean {
    return this.failed;
  }
}

/**
 * A remembered key: its version, its 32-byte fingerprint and its 91-byte signing key. A pin for the
 * device's own team also keeps the 32-byte digest of that version's device roster (`rh`), which the
 * next open walks the newer rosters from (keys/roster.ts); a partner pin has none.
 */
export interface Pin {
  v: number;
  fingerprint: Uint8Array;
  signSpki: Uint8Array;
  rosterDigest?: Uint8Array;
  /**
   * Set on a partner pin this device trusted on first use and never checked (`PartnerPinTrust`),
   * such as the key of the team a received share claims to come from. Such a pin still catches a
   * key that changes later, but vouches for nothing on its own. Never set on a team pin.
   */
  firstUse?: true;
}

/**
 * How this device came to trust a partner pin's key:
 * - `checked`: the person was shown the key's safety code and shared to that exact key, or accepted
 *   it as a changed key; or the key is the one this team's own verified share manifest names for
 *   that team, or a newer one the team signed from it; or it was reached by the team's signed
 *   rotations from a pin that was `checked` itself, or from this device's pin of its own team.
 * - `first-use`: anything else, which is the key the server showed the first time this device met
 *   the team, or a key reached by signed rotations from such a key. Opening a received share pins
 *   its owner team this way, since the server alone can make a share "from" any team.
 * Stored as `ck: true` on a checked pin; a partner pin stored without it reads as `first-use`, pins
 * from before this was recorded included.
 */
export type PartnerPinTrust = "checked" | "first-use";

/**
 * One public key of a team named exactly, as text: its version, its 32-byte fingerprint and its
 * signing key, such as `3.<43 characters>.<122 characters>`. A safety code covers the fingerprint
 * and the signing key in about 66 bits; this names them whole. The share dialog hands it back with
 * the send, so the key a share is wrapped to is the key whose safety code the person was shown, byte
 * for byte, and not merely one with the same code.
 */
export function teamKeyId(encKey: Pick<TeamEncKey, "v" | "fingerprint" | "signSpki">): string {
  return `${String(encKey.v)}.${base64urlEncode(encKey.fingerprint)}.${base64urlEncode(encKey.signSpki)}`;
}

/** Which of a team's keys a pin is for: the device's own team, or a partner the device shares with. */
export type PinKind = "team" | "partner";

function pinKey(uid: string, kind: PinKind, teamId: string): string {
  return `zenith.pin.${kind}.${encodeURIComponent(uid)}.${teamId}`;
}

/**
 * The pin for `teamId`, or null when there is none or it cannot be read. A pin for the device's own
 * team with no roster digest counts as none: the device then needs an approval or the recovery code
 * again, as a new device does.
 */
export function readPin(store: TrustStore, uid: string, kind: PinKind, teamId: string): Pin | null {
  const text = store.get(pinKey(uid, kind, teamId));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as { v?: unknown; fp?: unknown; sk?: unknown; rh?: unknown; ck?: unknown };
    if (typeof value.v !== "number" || !Number.isInteger(value.v) || value.v < 1 || typeof value.fp !== "string" || typeof value.sk !== "string") return null;
    const fingerprint = base64urlDecode(value.fp);
    const signSpki = base64urlDecode(value.sk);
    if (fingerprint.byteLength !== 32 || signSpki.byteLength !== 91) return null;
    if (kind === "partner") return partnerPin(value.v, fingerprint, signSpki, value.ck);
    if (value.rh === undefined) return null;
    if (typeof value.rh !== "string") return null;
    const rosterDigest = base64urlDecode(value.rh);
    return rosterDigest.byteLength === 32 ? { v: value.v, fingerprint, signSpki, rosterDigest } : null;
  } catch {
    return null;
  }
}

/** A partner pin as read back: `firstUse` unless it was stored as checked. */
function partnerPin(v: number, fingerprint: Uint8Array, signSpki: Uint8Array, checked: unknown): Pin {
  return checked === true ? { v, fingerprint, signSpki } : { v, fingerprint, signSpki, firstUse: true };
}

/** A partner pin as stored, with `ck: true` when it was checked. */
function storedPartnerPin(pin: Pick<Pin, "v" | "fingerprint" | "signSpki">, trust: PartnerPinTrust): Record<string, unknown> {
  const value: Record<string, unknown> = { v: pin.v, fp: base64urlEncode(pin.fingerprint), sk: base64urlEncode(pin.signSpki) };
  if (trust === "checked") value.ck = true;
  return value;
}

const sameKey = (a: Pick<Pin, "v" | "fingerprint" | "signSpki">, b: Pick<Pin, "v" | "fingerprint" | "signSpki">): boolean =>
  a.v === b.v && bytesEqual(a.fingerprint, b.fingerprint) && bytesEqual(a.signSpki, b.signSpki);

/**
 * Remembers `encKey` for the device's own team `teamId`, with the digest of that version's roster.
 * A team pin is never lowered, and never replaced by a different key under the same version.
 * Partner pins are written with `writePartnerPin`, which records how the key came to be trusted.
 */
export function writePin(
  store: TrustStore,
  uid: string,
  kind: "team",
  teamId: string,
  encKey: Pick<TeamEncKey, "v" | "fingerprint" | "signSpki">,
  rosterDigest?: Uint8Array,
): void {
  // A team pin only moves forward: a lower version is never written over a higher one, and a team
  // never makes two keys under one version, so a different one there is never written either. Every
  // caller refuses both before it gets here; this keeps the pin if one ever does not.
  const current = readPin(store, uid, kind, teamId);
  if (current !== null && current.v > encKey.v) return;
  if (current !== null && current.v === encKey.v && !sameKey(current, encKey)) return;
  const value: Record<string, unknown> = { v: encKey.v, fp: base64urlEncode(encKey.fingerprint), sk: base64urlEncode(encKey.signSpki) };
  if (rosterDigest !== undefined) value.rh = base64urlEncode(rosterDigest);
  store.set(pinKey(uid, kind, teamId), JSON.stringify(value));
}

/**
 * Remembers `encKey` as partner team `teamId`'s key, trusted as `trust` says (`PartnerPinTrust`).
 * The caller says `checked` only for a key it checked itself, or reached by signed rotations from a
 * pin that was checked; a key reached from a `first-use` pin stays `first-use`.
 *
 * The same key already pinned keeps its pin, and becomes `checked` when this write is `checked`; a
 * `first-use` write never makes a checked pin first-use again. A different key replaces the pin, as
 * `trust` says. A pin that moves to a newer version keeps the pin it replaces among the earlier ones
 * (`readEarlierPartnerPins`), with its own trust, however the newer key was reached: by the
 * partner's signed rotation, or as a changed key the person accepted after comparing safety codes.
 * Only a key written under the same version as the pin, or an older one, which only a person
 * accepting a changed key does, forgets the earlier pins.
 */
export function writePartnerPin(
  store: TrustStore,
  uid: string,
  teamId: string,
  encKey: Pick<TeamEncKey, "v" | "fingerprint" | "signSpki">,
  trust: PartnerPinTrust,
): void {
  const current = readPin(store, uid, "partner", teamId);
  if (current !== null && sameKey(current, encKey)) {
    if (current.firstUse === true && trust === "checked") store.set(pinKey(uid, "partner", teamId), JSON.stringify(storedPartnerPin(encKey, "checked")));
    return;
  }
  if (current !== null) keepEarlierPartnerPin(store, uid, teamId, current, encKey);
  store.set(pinKey(uid, "partner", teamId), JSON.stringify(storedPartnerPin(encKey, trust)));
}

/** The most earlier partner pins kept per team: the newest ones, the oldest dropped first. SET BY HAND. */
export const MAX_EARLIER_PARTNER_PINS = 16;

function earlierPinsKey(uid: string, teamId: string): string {
  return `zenith.pin.partner-was.${encodeURIComponent(uid)}.${teamId}`;
}

/**
 * The partner pins this device held for `teamId` before its current one, oldest first, each a key
 * this device trusted for that team at its version. A partner's proposals are signed with its team
 * signing key of the version they were sealed under, and signatures only reach forward, so a
 * proposal sent before the partner rotated is checked with the pin of that version, or one below it
 * walked forward. Each keeps the trust it had as the current pin (`firstUse` when it was never
 * checked). Empty when there are none or they cannot be read.
 */
export function readEarlierPartnerPins(store: TrustStore, uid: string, teamId: string): Pin[] {
  const text = store.get(earlierPinsKey(uid, teamId));
  if (text === null) return [];
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list)) return [];
    const pins: Pin[] = [];
    for (const entry of list as Array<{ v?: unknown; fp?: unknown; sk?: unknown; ck?: unknown }>) {
      if (typeof entry.v !== "number" || !Number.isInteger(entry.v) || entry.v < 1 || typeof entry.fp !== "string" || typeof entry.sk !== "string") return [];
      const fingerprint = base64urlDecode(entry.fp);
      const signSpki = base64urlDecode(entry.sk);
      if (fingerprint.byteLength !== 32 || signSpki.byteLength !== 91) return [];
      pins.push(partnerPin(entry.v, fingerprint, signSpki, entry.ck));
    }
    return pins.sort((a, b) => a.v - b.v);
  } catch {
    return [];
  }
}

/**
 * Before a partner pin is replaced: a newer version keeps the pin it replaces among the earlier
 * pins, whether the newer key came by a signed rotation or was a changed key the person accepted; the
 * same version under another key, or an older version, is a key the person chose to trust after
 * comparing safety codes in place of the one pinned, so the earlier pins are forgotten with it.
 */
function keepEarlierPartnerPin(store: TrustStore, uid: string, teamId: string, current: Pin, next: Pick<TeamEncKey, "v" | "fingerprint" | "signSpki">): void {
  if (next.v <= current.v) {
    store.set(earlierPinsKey(uid, teamId), "[]");
    return;
  }
  const kept = [...readEarlierPartnerPins(store, uid, teamId).filter((pin) => pin.v < current.v), current].slice(-MAX_EARLIER_PARTNER_PINS);
  store.set(earlierPinsKey(uid, teamId), JSON.stringify(kept.map((pin) => storedPartnerPin(pin, pin.firstUse === true ? "first-use" : "checked"))));
}

/** A whole number from 1 kept under `key`, or null. */
function readCount(store: TrustStore, key: string): number | null {
  const text = store.get(key);
  if (text === null) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** Keeps `value` under `key` unless a larger number is already kept there. */
function raiseCount(store: TrustStore, key: string, value: number): void {
  const kept = readCount(store, key);
  if (kept === null || value > kept) store.set(key, String(value));
}

const shareKeyPin = (uid: string, shareId: string) => `zenith.pin.share.${encodeURIComponent(uid)}.${shareId}`;
const shareSignerPin = (uid: string, shareId: string) => `zenith.pin.share-signer.${encodeURIComponent(uid)}.${shareId}`;
const shareSeqPin = (uid: string, shareId: string) => `zenith.pin.share-seq.${encodeURIComponent(uid)}.${shareId}`;
const shareTermsPin = (uid: string, shareId: string) => `zenith.pin.share-terms.${encodeURIComponent(uid)}.${shareId}`;
const titlePin = (uid: string, teamId: string, autoId: string) => `zenith.pin.title.${encodeURIComponent(uid)}.${teamId}.${autoId}`;

/** The newest share key version this device has used for `shareId`, or null for none. */
export function readShareKeyPin(store: TrustStore, uid: string, shareId: string): number | null {
  return readCount(store, shareKeyPin(uid, shareId));
}

/** Remembers that this device used share key `kv` of `shareId`; an older version never replaces a newer one. */
export function writeShareKeyPin(store: TrustStore, uid: string, shareId: string, kv: number): void {
  raiseCount(store, shareKeyPin(uid, shareId), kv);
}

/**
 * The newest owner team key version this device has seen sign `shareId`'s manifest, or null for none.
 * An honest owner device always signs with its team's newest key, so a share's signer never goes back.
 */
export function readShareSignerPin(store: TrustStore, uid: string, shareId: string): number | null {
  return readCount(store, shareSignerPin(uid, shareId));
}

/** Remembers that owner team key `okv` signed a manifest of `shareId` this device used; never lowered. */
export function writeShareSignerPin(store: TrustStore, uid: string, shareId: string, okv: number): void {
  raiseCount(store, shareSignerPin(uid, shareId), okv);
}

/**
 * The highest manifest sequence number (`seq`) this device has seen for `shareId`, or null for none,
 * kept beside the signer pin. Every change to a share's terms or keys signs a manifest one higher, so
 * a lower one is the server putting back a share from before, such as before it was revoked.
 */
export function readShareSeqPin(store: TrustStore, uid: string, shareId: string): number | null {
  return readCount(store, shareSeqPin(uid, shareId));
}

/** Remembers that this device saw manifest `seq` of `shareId`; never lowered. */
export function writeShareSeqPin(store: TrustStore, uid: string, shareId: string, seq: number): void {
  raiseCount(store, shareSeqPin(uid, shareId), seq);
}

/**
 * The highest count of signatures of a share's terms (`tseq`) this device has seen for `shareId`,
 * or null for none, kept beside the sequence pin. Every signature of new terms counts one higher, so
 * a lower one is someone putting back terms from before, such as a team since taken off the share,
 * in a manifest whose own `seq` they raised.
 */
export function readShareTermsPin(store: TrustStore, uid: string, shareId: string): number | null {
  return readCount(store, shareTermsPin(uid, shareId));
}

/** Remembers that this device saw terms count `tseq` of `shareId`; never lowered. */
export function writeShareTermsPin(store: TrustStore, uid: string, shareId: string, tseq: number): void {
  raiseCount(store, shareTermsPin(uid, shareId), tseq);
}

/** The newest title generation this device has read for an auto, or null for none. */
export function readTitlePin(store: TrustStore, uid: string, teamId: string, autoId: string): number | null {
  return readCount(store, titlePin(uid, teamId, autoId));
}

/** Remembers that this device read title generation `gen` of an auto. */
export function writeTitlePin(store: TrustStore, uid: string, teamId: string, autoId: string, gen: number): void {
  raiseCount(store, titlePin(uid, teamId, autoId), gen);
}

/**
 * Which team this device shared with under an FTC number. The server writes the claim that turns a
 * number into a team, and a verified claim is no different, so a number that later leads to another
 * team is treated as a changed key: the person compares both teams' safety codes before anything is
 * sent. `seen` is true once the person was shown that team's safety code and chose to share.
 */
export interface TeamNumberPin {
  teamId: string;
  seen: boolean;
}

const teamNumberPin = (uid: string, teamNumber: number) => `zenith.pin.number.${encodeURIComponent(uid)}.${String(teamNumber)}`;

/** The team this device shared with under `teamNumber`, or null when there is none or it cannot be read. */
export function readTeamNumberPin(store: TrustStore, uid: string, teamNumber: number): TeamNumberPin | null {
  const text = store.get(teamNumberPin(uid, teamNumber));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as { t?: unknown; seen?: unknown };
    if (typeof value.t !== "string" || value.t === "") return null;
    return { teamId: value.t, seen: value.seen === true };
  } catch {
    return null;
  }
}

/**
 * Remembers that this device shared with `pin.teamId` under `teamNumber`. For the same team, `seen`
 * is never lowered: once the person saw the team's safety code, a share made without showing it again
 * keeps that record. A different team replaces the pin; every caller asks the person first.
 */
export function writeTeamNumberPin(store: TrustStore, uid: string, teamNumber: number, pin: TeamNumberPin): void {
  const current = readTeamNumberPin(store, uid, teamNumber);
  const seen = pin.seen || (current !== null && current.teamId === pin.teamId && current.seen);
  store.set(teamNumberPin(uid, teamNumber), JSON.stringify({ t: pin.teamId, seen }));
}

/** The random part of the approval code this device shows for a team, and the device it is for. */
export interface ApprovalSecret {
  deviceId: string;
  secret: Uint8Array;
}

const approvalKey = (uid: string, teamId: string) => `zenith.approval.${encodeURIComponent(uid)}.${teamId}`;

/** The approval secret kept for `teamId`, or null when there is none or it cannot be read. */
export function readApprovalSecret(store: TrustStore, uid: string, teamId: string): ApprovalSecret | null {
  const text = store.get(approvalKey(uid, teamId));
  if (text === null || text === "") return null;
  try {
    const value = JSON.parse(text) as { d?: unknown; s?: unknown };
    if (typeof value.d !== "string" || typeof value.s !== "string") return null;
    const secret = base64urlDecode(value.s);
    return secret.byteLength === 5 ? { deviceId: value.d, secret } : null;
  } catch {
    return null;
  }
}

/** Keeps the approval secret for `teamId`. */
export function writeApprovalSecret(store: TrustStore, uid: string, teamId: string, value: ApprovalSecret): void {
  store.set(approvalKey(uid, teamId), JSON.stringify({ d: value.deviceId, s: base64urlEncode(value.secret) }));
}

/** Forgets the approval secret for `teamId`: the code was used, or the request withdrawn. */
export function clearApprovalSecret(store: TrustStore, uid: string, teamId: string): void {
  store.set(approvalKey(uid, teamId), "");
}

/**
 * How a partner team's key compares with the one this device pinned:
 * - `first-use`: this device has not wrapped to the team before, so it trusts the key it sees; the
 *   caller also says this for a key that matches, or was signed from, a pin that was only trusted
 *   on first use (`Pin.firstUse`), since nobody on this device has checked that key either;
 * - `same`: the same version, fingerprint and signing key;
 * - `rotated`: a newer version, which a team makes when it removes someone, signed step by step from
 *   the pinned version (the caller checks the signatures and says `changed` when they do not hold);
 * - `changed`: a different key under the same version, which a team never makes, or a newer one
 *   whose signatures do not reach back to the pinned one;
 * - `older`: an older version than one already seen, which a team never goes back to;
 * - `member-key-differs`: said only by the caller, when this user is a member of the team and this
 *   device's team pin is at the version shown with a different key. The device holds that team's
 *   real key at that version, so the key shown is not the team's, and no answer accepts it.
 * `changed`, `older` and `member-key-differs` are what a server trying to read the share would show.
 */
export type PartnerKeyStatus = "first-use" | "same" | "rotated" | "changed" | "older" | "member-key-differs";

/**
 * Compares `encKey` with `pin` by version and keys alone. A `rotated` answer here still needs its
 * signatures checked (`checkTeamKeyStep` from the pinned version up) before it can be believed.
 */
export function comparePin(pin: Pin | null, encKey: Pick<TeamEncKey, "v" | "fingerprint" | "signSpki">): PartnerKeyStatus {
  if (pin === null) return "first-use";
  if (encKey.v < pin.v) return "older";
  if (encKey.v > pin.v) return "rotated";
  return bytesEqual(encKey.fingerprint, pin.fingerprint) && bytesEqual(encKey.signSpki, pin.signSpki) ? "same" : "changed";
}
