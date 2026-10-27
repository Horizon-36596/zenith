/**
 * The signed device roster of each team key version (spec 14 section 4.5). `teams/{t}/teamKeys/{n}`
 * holds, sealed under team key n, the list of devices that were given key n (each with its member's
 * uid and its two public keys, which its device id is made from), every member's role at that
 * moment, whether members may approve each other's devices, the recovery record's keys, and the
 * device that made the version. That device signs a digest of the sealed roster together with the
 * version's public keys (`rosterSig`).
 *
 * Roles and the setting are authority, so they come from signed state only: roster n+1 copies
 * them from roster n, lowered where the member documents or the sharing setting say less, and
 * raised only by the rotator's own user, an owner or admin of roster n, in the write that makes the
 * change (`RotationOptions` in keys/keyring.ts). A member new since roster n is at most an editor.
 * `checkRosterStep` refuses a roster that raises anything when its rotator's authority comes from
 * the recovery code alone, whichever member that rotator claims to be, and one in which such a
 * rotator gives the key to a device that the links it carries do not show was approved.
 *
 * The roster is what a rotation keeps. A grant is only a document the server holds, so it never
 * decides who gets the next key on its own: the next roster is the devices of this one that stay,
 * plus the grants made since whose approving device reaches this roster through approvals made with
 * authority, each link's signature checked with keys this roster, or an earlier link, vouches for.
 * A grant the server made up, one a device made for itself, and one approved by a device with no
 * grant or by the member being removed never reach it.
 *
 * Checking a roster needs the one before it. A device that opened the team before keeps the digest
 * of the roster it saw in its pin, and walks each newer roster from there: roster n+1 must be signed
 * by a device of an owner or admin of roster n, or by a device that the recovery code, or approvals
 * with authority from roster n, vouch for (`via`); a roster the recovery code alone vouches for
 * carries, in `via` too, the approvals of every other device it adds. A device opening its first grant takes the roster
 * whose digest the approval MAC covers (crypto/approval.ts), and the founder's device made roster 1.
 * A device that uses the recovery code with no pin starts from the roster made with that code: it
 * carries `recoveryAnchor`, the recovery signing key's signature over that version's public keys,
 * and over the signing key of the device that made that version, which only someone holding the
 * code could make, so a key chain the server made up has no start, and a roster sealed again under
 * that version's key by someone who holds it is not signed by the device the anchor names.
 * A roster carries every public key its checks need, so no step depends on a device record the
 * server still holds: a member who deleted their account leaves the rosters they signed checkable.
 *
 * The roster is sealed because any signed-in user may get a `teamKeys` record by id, so that a
 * partner team can walk the public signatures (`sig`); a partner needs nothing from the roster. The
 * roster's signature covers a digest of the plaintext too, which holds a random nonce, so nobody
 * without the team key can tell whose device signed it. The plaintext is padded with spaces to a
 * fixed size bucket (`paddedRosterLength`), so the ciphertext's length says only roughly how big the
 * team is, to within a factor of two, and nothing finer.
 */
import { base64urlDecode, base64urlEncode, bytesEqual, concatBytes, utf8Decode, utf8Encode } from "../crypto/bytes.js";
import { aadFor, idPart, isKeyVersion, uidPart, versionPart } from "../crypto/aad.js";
import { deviceFingerprint, deviceIdFor, sign, SIGNATURE_BYTES, verify, type DeviceRecord } from "../crypto/device.js";
import { assertEnvelope, openBytes, sealBytes, type Envelope } from "../crypto/envelope.js";
import { CryptoError, isCryptoError } from "../crypto/errors.js";
import { isBytes, sha256, take } from "../crypto/primitives.js";
import { recoveryFingerprint } from "../crypto/recovery.js";
import { keyGrantSignedBytes, teamKeyFingerprint, type TeamKey } from "../crypto/team.js";
import { assertPublicKeyWrap, P256_SPKI_BYTES, type PublicKeyWrap } from "../crypto/wrap.js";
import type { RandomBytes } from "../ids.js";
import { MAX_ROSTER_BYTES, type ActiveRole } from "../types.js";

/** The roles a roster records. */
const ROLES: readonly ActiveRole[] = ["owner", "admin", "editor", "viewer"];

/** How much a role may do, from 0 for a viewer to 3 for an owner, so that two roles compare. */
export function roleRank(role: ActiveRole): number {
  return 3 - ROLES.indexOf(role);
}

/** The lower of two roles. */
export function lowerRole(a: ActiveRole, b: ActiveRole): ActiveRole {
  return roleRank(a) <= roleRank(b) ? a : b;
}

/** The highest role a member new since the previous roster starts with in the next one. */
export const NEW_MEMBER_ROLE_CAP: ActiveRole = "editor";

/** The roles whose devices may sign the next roster, and approve any member's device. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The most members, and the most devices, one roster holds. SET BY HAND: one write holds at most 500
 * documents, so no rotation can give more devices the key than that.
 */
export const MAX_ROSTER_ENTRIES = 500;

/**
 * The most links one roster's `via` holds. SET BY HAND: the links are the grants from a device of
 * the previous roster down to the rotating device, one per device approved from another since the
 * last rotation; a real chain is one or two long, and 50 keeps the roster far below its size cap.
 */
export const MAX_ROSTER_LINKS = 50;

/**
 * The smallest padded roster plaintext, bytes, with the 16-byte GCM tag it makes 4,096 bytes of
 * ciphertext. SET BY HAND: a small team's roster, a few members and devices, fits.
 */
export const MIN_ROSTER_BUCKET_BYTES = 4096 - 16;

/**
 * The length a roster plaintext of `length` bytes is padded to: the smallest of 4,096, 8,192, 16,384
 * and so on up to MAX_ROSTER_BYTES, less the 16-byte tag, that holds it; null when none does.
 */
export function paddedRosterLength(length: number): number | null {
  for (let bucket = MIN_ROSTER_BUCKET_BYTES + 16; bucket <= MAX_ROSTER_BYTES; bucket *= 2) {
    if (length <= bucket - 16) return bucket - 16;
  }
  return null;
}

/**
 * The most shares one roster lists (`Roster.shares`). SET BY HAND: 1,500 entries with 64-character
 * ids, the longest the rules allow, are about 172 KB of JSON, which with the largest roster of
 * members, devices and links (about 342 KB) still fits the last size bucket, 524,272 bytes. A team
 * with more shares that are not revoked keeps the ones changed most recently in the list at a
 * rotation, and must share the others again.
 */
export const MAX_ROSTER_SHARES = 1500;

/** The random nonce in each roster, bytes. SET BY HAND: 128 bits. */
export const ROSTER_NONCE_BYTES = 16;

/** A member of the team when the roster was made, with the role the rosters gave them. */
export interface RosterMember {
  uid: string;
  role: ActiveRole;
}

/** A device's public keys, as a roster holds them. Its id is `deviceIdFor` of their fingerprint. */
export interface RosterKeys {
  deviceId: string;
  /** The member it belongs to. */
  uid: string;
  /** 91-byte SPKI of its ECDH key, which team keys are wrapped to. */
  encSpki: Uint8Array;
  /** 91-byte SPKI of its ECDSA key, which signs what it approves. */
  signSpki: Uint8Array;
  /** 32 bytes: SHA-256 of the two, worked out when the roster is opened, never stored. */
  fingerprint: Uint8Array;
}

/** A device given the roster's key version. */
export type RosterDevice = RosterKeys;

/**
 * A grant of the previous version made since the previous roster: the evidence, kept in the next
 * roster, that the device which signs it was approved by a device the previous roster vouches for.
 */
export interface GrantLink extends RosterKeys {
  kind: "grant";
  kv: number;
  approverDeviceId: string;
  wrap: PublicKeyWrap;
  /** The approver's signature over `keyGrantSignedBytes`. */
  signature: Uint8Array;
}

/** The recovery signing key's endorsement of a device that used the recovery code (`recoveryEndorsementBytes`). */
export interface RecoveryLink extends RosterKeys {
  kind: "recovery";
  kv: number;
  /** The recovery record's two public keys, which the previous roster's `recovery` must name. */
  recoverySpki: Uint8Array;
  recoverySignSpki: Uint8Array;
  signature: Uint8Array;
}

export type RosterLink = GrantLink | RecoveryLink;

/**
 * A share of the team that the device which made this roster found live: not revoked, keyed and
 * signed by the team, vouched for by the roster before (or signed at that roster's key version),
 * signed by a device this roster holds, and with terms signed only by devices this roster holds.
 * `digest` is `shareManifestDigest` of the manifest it had then. A key a member removed at this
 * rotation, or a device revoked at it, still holds can sign any manifest of the version before, so
 * after the rotation a share is sealed into only when its manifest is signed at the newest key
 * version, or is the one listed here.
 */
export interface RosterShare {
  shareId: string;
  /** 32 bytes: SHA-256 of the manifest's body. */
  digest: Uint8Array;
}

/** The plaintext of a roster. */
export interface Roster {
  v: 1;
  teamId: string;
  kv: number;
  /** The device that made this version and signs the roster; it is one of `devices`. */
  rotator: string;
  /** 16 random bytes, so the plaintext cannot be guessed from what it names. */
  nonce: Uint8Array;
  /**
   * The members when the roster was made: those of the previous roster who stay, and those new since
   * whom a kept device's approval, or the rotator's own user, adds.
   */
  members: RosterMember[];
  /**
   * Whether any member of this roster may approve another member's device, as the sharing setting
   * `membersMayApproveDevices` said when an owner or admin last changed it from a device that rotated.
   * False in a roster made before the field existed.
   */
  membersMayApprove: boolean;
  /** Every device given this version. */
  devices: RosterDevice[];
  /** 32 bytes: `recoveryFingerprint` of the recovery record that holds this version. */
  recovery: Uint8Array;
  /**
   * Empty unless the rotator has no authority from its place in the previous roster: then the links
   * that show a device of the previous roster, or the recovery code, vouches for it. When it is the
   * recovery code, also the grant links that root every other device new since the previous roster
   * in it (`rootedNewDevices`). Empty in roster 1.
   */
  via: RosterLink[];
  /**
   * 64 bytes in the roster of the version a recovery code was made with (roster 1, and the roster of
   * each new code), null in every other: the recovery signing key's signature over
   * `recoveryAnchorBytes` for this version and its rotator. A device with no pin that uses the code
   * walks from here, once the roster's signature checks with the rotator's key.
   */
  recoveryAnchor: Uint8Array | null;
  /**
   * The team's live shares when this roster was made, sorted by id, each with the digest of its
   * manifest then (`RosterShare`). Empty in a roster made before the field existed, and in roster 1.
   */
  shares: RosterShare[];
}

/** The roster fields of a `teamKeys/{kv}` record. */
export interface RosterFields {
  kv: number;
  /** The roster sealed under team key `kv` (`aadFor.teamRoster`). */
  roster: Envelope;
  /** 64 bytes: the rotator's signature over `rosterSignedBytes`. */
  rosterSig: Uint8Array;
  /** The version's public keys, which the signature binds the roster to. */
  pairSpki: Uint8Array;
  signSpki: Uint8Array;
}

/** A roster as opened and parsed, with the digests its signature covers. */
export interface OpenedRoster {
  roster: Roster;
  /** `rosterDigest` of the sealed roster: what pins and approval MACs hold. */
  digest: Uint8Array;
  /** SHA-256 of the plaintext. */
  plainDigest: Uint8Array;
}

/** The role of `uid` in `roster`, or null when the roster names no such member. */
export function roleIn(roster: Roster, uid: string): ActiveRole | null {
  return roster.members.find((member) => member.uid === uid)?.role ?? null;
}

/** The roster's entry for `deviceId`, or null. */
export function deviceIn(roster: Roster, deviceId: string): RosterDevice | null {
  return roster.devices.find((device) => device.deviceId === deviceId) ?? null;
}

/** A roster entry's keys as a device record. */
export function recordOfKeys(keys: Pick<RosterKeys, "encSpki" | "signSpki" | "fingerprint">): DeviceRecord {
  return { v: 1, encSpki: keys.encSpki, signSpki: keys.signSpki, fingerprint: keys.fingerprint };
}

/** True when two entries are the same device of the same member with the same keys. */
export function sameDevice(a: Pick<RosterKeys, "deviceId" | "uid" | "fingerprint">, b: Pick<RosterKeys, "deviceId" | "uid" | "fingerprint">): boolean {
  return a.deviceId === b.deviceId && a.uid === b.uid && bytesEqual(a.fingerprint, b.fingerprint);
}

// ---------------------------------------------------------------------------- bytes

/**
 * The 32 bytes that name a sealed roster: SHA-256 of `zenith/v1/team-roster-digest|team=|kv=`, a zero
 * byte, then the envelope's IV and ciphertext. A device's pin and a new device's approval MAC hold it.
 */
export async function rosterDigest(teamId: string, kv: number, roster: Envelope): Promise<Uint8Array<ArrayBuffer>> {
  assertEnvelope(roster);
  const label = ["zenith/v1/team-roster-digest", idPart("team", teamId), versionPart("kv", kv)].join("|");
  return sha256(concatBytes(utf8Encode(label), new Uint8Array([0]), roster.iv, roster.ct));
}

/**
 * The exact bytes a rotator signs for a roster: `zenith/v1/team-roster-signature|team=|kv=`, a zero
 * byte, the roster digest (32 bytes), the SHA-256 of the plaintext (32), the version's ECDH
 * fingerprint (32) and its signing key (91).
 */
export function rosterSignedBytes(teamId: string, kv: number, digest: Uint8Array, plainDigest: Uint8Array, pairFingerprint: Uint8Array, signSpki: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(digest, { exactly: 32 }) || !isBytes(plainDigest, { exactly: 32 }) || !isBytes(pairFingerprint, { exactly: 32 }) || !isBytes(signSpki, { exactly: P256_SPKI_BYTES })) {
    throw new CryptoError("bad-input", "A roster signature needs three 32-byte digests and a 91-byte signing key.");
  }
  const label = ["zenith/v1/team-roster-signature", idPart("team", teamId), versionPart("kv", kv)].join("|");
  return concatBytes(utf8Encode(label), new Uint8Array([0]), digest, plainDigest, pairFingerprint, signSpki);
}

/**
 * The exact bytes the recovery signing key signs for a device that used the recovery code at team
 * key version `kv`: `zenith/v1/recovery-endorsement|team=|device=|uid=|kv=`, a zero byte, then the
 * device's 32-byte fingerprint.
 */
export function recoveryEndorsementBytes(teamId: string, kv: number, deviceId: string, uid: string, fingerprint: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(fingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  const label = ["zenith/v1/recovery-endorsement", idPart("team", teamId), idPart("device", deviceId), uidPart(uid), versionPart("kv", kv)].join("|");
  return concatBytes(utf8Encode(label), new Uint8Array([0]), fingerprint);
}

/**
 * The exact bytes the recovery signing key signs when its code is made at team key version `kv`:
 * `zenith/v1/recovery-anchor|team=|kv=`, a zero byte, then that version's ECDH fingerprint (32
 * bytes), its signing key (91), the new recovery record's `recoveryFingerprint` (32) and the signing
 * key (91) of the device that makes the version and signs its roster. The anchor covers the rotator
 * because it cannot cover the roster itself, which holds it: whoever holds key `kv` could seal the
 * roster again with other contents, but not sign it as the rotator.
 */
export function recoveryAnchorBytes(teamId: string, kv: number, pairFingerprint: Uint8Array, signSpki: Uint8Array, recovery: Uint8Array, rotatorSignSpki: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    !isBytes(pairFingerprint, { exactly: 32 }) ||
    !isBytes(signSpki, { exactly: P256_SPKI_BYTES }) ||
    !isBytes(recovery, { exactly: 32 }) ||
    !isBytes(rotatorSignSpki, { exactly: P256_SPKI_BYTES })
  ) {
    throw new CryptoError("bad-input", "A recovery anchor needs two 32-byte fingerprints and two 91-byte signing keys.");
  }
  const label = ["zenith/v1/recovery-anchor", idPart("team", teamId), versionPart("kv", kv)].join("|");
  return concatBytes(utf8Encode(label), new Uint8Array([0]), pairFingerprint, signSpki, recovery, rotatorSignSpki);
}

/** The recovery signing key's anchor for team key version `kv`, 64 bytes (`recoveryAnchorBytes`). */
export async function anchorRecovery(
  signer: CryptoKey,
  input: { teamId: string; kv: number; pairSpki: Uint8Array; signSpki: Uint8Array; recovery: Uint8Array; rotatorSignSpki: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  return sign(signer, recoveryAnchorBytes(input.teamId, input.kv, await teamKeyFingerprint(input.pairSpki), input.signSpki, input.recovery, input.rotatorSignSpki));
}

/**
 * True when `opened`, the roster of the key record `record`, carries the anchor of the recovery
 * record whose signing key is `recoverySignSpki` and whose fingerprint is `recovery`, names that
 * record, and is signed by its rotator, whose signing key the anchor covers. A roster someone sealed
 * again under the same key, with the anchor copied in, fails the last check.
 */
export async function checkRecoveryAnchor(teamId: string, record: RosterFields, opened: OpenedRoster, recoverySignSpki: Uint8Array, recovery: Uint8Array): Promise<boolean> {
  const roster = opened.roster;
  if (roster.recoveryAnchor === null || roster.kv !== record.kv || !bytesEqual(roster.recovery, recovery)) return false;
  const rotator = deviceIn(roster, roster.rotator);
  if (rotator === null) return false;
  const signed = recoveryAnchorBytes(teamId, record.kv, await teamKeyFingerprint(record.pairSpki), record.signSpki, recovery, rotator.signSpki);
  if (!(await verify(recoverySignSpki, roster.recoveryAnchor, signed))) return false;
  return checkRosterSignature(teamId, record, opened, rotator.signSpki);
}

/** The recovery signing key's endorsement of a device, 64 bytes. */
export async function endorseRecoveredDevice(signer: CryptoKey, input: { teamId: string; kv: number; deviceId: string; uid: string; fingerprint: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  return sign(signer, recoveryEndorsementBytes(input.teamId, input.kv, input.deviceId, input.uid, input.fingerprint));
}

// ---------------------------------------------------------------------------- encoding

const b64 = (bytes: Uint8Array): string => base64urlEncode(bytes);

function keysToJson(keys: RosterKeys): Record<string, unknown> {
  return { deviceId: keys.deviceId, uid: keys.uid, encSpki: b64(keys.encSpki), signSpki: b64(keys.signSpki) };
}

function linkToJson(link: RosterLink): Record<string, unknown> {
  const common = { kind: link.kind, ...keysToJson(link), kv: link.kv };
  if (link.kind === "grant") {
    const wrap = { v: link.wrap.v, epk: b64(link.wrap.epk), iv: b64(link.wrap.iv), ct: b64(link.wrap.ct) };
    return { ...common, approverDeviceId: link.approverDeviceId, wrap, signature: b64(link.signature) };
  }
  return { ...common, recoverySpki: b64(link.recoverySpki), recoverySignSpki: b64(link.recoverySignSpki), signature: b64(link.signature) };
}

/** A roster as the UTF-8 JSON that is sealed. Fingerprints are left out: they come from the keys. */
export function encodeRoster(roster: Roster): Uint8Array<ArrayBuffer> {
  return utf8Encode(
    JSON.stringify({
      v: roster.v,
      teamId: roster.teamId,
      kv: roster.kv,
      rotator: roster.rotator,
      nonce: b64(roster.nonce),
      recovery: b64(roster.recovery),
      members: roster.members.map((member) => ({ uid: member.uid, role: member.role })),
      membersMayApprove: roster.membersMayApprove === true,
      devices: roster.devices.map(keysToJson),
      via: roster.via.map(linkToJson),
      recoveryAnchor: roster.recoveryAnchor instanceof Uint8Array ? b64(roster.recoveryAnchor) : null,
      shares: (roster.shares ?? []).map((share) => [share.shareId, b64(share.digest)]),
    }),
  );
}

function bad(message: string): never {
  throw new CryptoError("bad-envelope", `The team's device roster ${message}.`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`has ${what} that is not an object`);
  return value as Record<string, unknown>;
}

function asUid(value: unknown): string {
  if (typeof value !== "string" || !/^[^/]{1,128}$/.test(value)) bad("names a member whose uid is not 1 to 128 characters");
  return value;
}

function asDeviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) bad("names a device whose id is not 22 base64url characters");
  return value;
}

function asBytes(value: unknown, length: number, what: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") bad(`has ${what} that is not base64url`);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64urlDecode(value);
  } catch {
    bad(`has ${what} that is not base64url`);
  }
  if (bytes.byteLength !== length) bad(`has ${what} of the wrong length`);
  return bytes;
}

function asList(value: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) bad(`has a list of ${what} that is missing or too long`);
  return value;
}

function asVersion(value: unknown): number {
  if (!isKeyVersion(value)) bad("has a key version that is not a whole number from 1");
  return value;
}

/** A device's keys from the JSON, with the fingerprint worked out and the id checked against it. */
async function keysFromJson(value: Record<string, unknown>): Promise<RosterKeys> {
  const deviceId = asDeviceId(value.deviceId);
  const encSpki = asBytes(value.encSpki, P256_SPKI_BYTES, "a device's encryption key");
  const signSpki = asBytes(value.signSpki, P256_SPKI_BYTES, "a device's signing key");
  const fingerprint = await deviceFingerprint(encSpki, signSpki);
  if (deviceIdFor(fingerprint) !== deviceId) bad("names a device whose keys do not match its id");
  return { deviceId, uid: asUid(value.uid), encSpki, signSpki, fingerprint };
}

async function linkFromJson(value: unknown): Promise<RosterLink> {
  const link = asObject(value, "a link");
  const keys = await keysFromJson(link);
  const kv = asVersion(link.kv);
  if (link.kind === "grant") {
    const wrap = asObject(link.wrap, "a wrap");
    const parsed: PublicKeyWrap = { v: wrap.v as 1, epk: asBytes(wrap.epk, 65, "a wrap key"), iv: asBytes(wrap.iv, 12, "a wrap IV"), ct: asBytes(wrap.ct, 48, "a wrap") };
    assertPublicKeyWrap(parsed);
    return { kind: "grant", ...keys, kv, approverDeviceId: asDeviceId(link.approverDeviceId), wrap: parsed, signature: asBytes(link.signature, SIGNATURE_BYTES, "a signature") };
  }
  if (link.kind === "recovery") {
    return {
      kind: "recovery",
      ...keys,
      kv,
      recoverySpki: asBytes(link.recoverySpki, P256_SPKI_BYTES, "a recovery key"),
      recoverySignSpki: asBytes(link.recoverySignSpki, P256_SPKI_BYTES, "a recovery signing key"),
      signature: asBytes(link.signature, SIGNATURE_BYTES, "a signature"),
    };
  }
  bad("has a link of a kind this app does not know");
}

/**
 * The roster in `bytes`, checked strictly: every field present and of its type, ids and uids of the
 * right shape, each device's id made from its keys, no member or device twice, every device a
 * member's, and the rotator among the devices. Throws `bad-envelope` for anything else.
 */
export async function decodeRoster(bytes: Uint8Array): Promise<Roster> {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    bad("is not JSON");
  }
  const raw = asObject(value, "a body");
  if (raw.v !== 1) bad("has a version this app does not know");
  if (typeof raw.teamId !== "string") bad("names no team");
  const members = asList(raw.members, "members", MAX_ROSTER_ENTRIES).map((entry) => {
    const member = asObject(entry, "a member");
    if (typeof member.role !== "string" || !(ROLES as readonly string[]).includes(member.role)) bad("gives a member a role this app does not know");
    return { uid: asUid(member.uid), role: member.role as ActiveRole };
  });
  const devices: RosterDevice[] = [];
  for (const entry of asList(raw.devices, "devices", MAX_ROSTER_ENTRIES)) devices.push(await keysFromJson(asObject(entry, "a device")));
  const via: RosterLink[] = [];
  for (const entry of asList(raw.via, "links", MAX_ROSTER_LINKS)) via.push(await linkFromJson(entry));
  // A roster made before shares were listed has no field, and vouches for none.
  const shares: RosterShare[] = asList(raw.shares ?? [], "shares", MAX_ROSTER_SHARES).map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(entry[0])) bad("lists a share in a form this app does not know");
    return { shareId: entry[0] as string, digest: asBytes(entry[1], 32, "a share's manifest digest") };
  });
  for (let i = 1; i < shares.length; i++) {
    if (!((shares[i - 1] as RosterShare).shareId < (shares[i] as RosterShare).shareId)) bad("lists its shares out of order or twice");
  }
  // A roster made before the setting was recorded has no field, and lets nobody but owners and admins approve.
  if (raw.membersMayApprove !== undefined && typeof raw.membersMayApprove !== "boolean") bad("has a sharing setting that is not true or false");
  const roster: Roster = {
    v: 1,
    teamId: raw.teamId,
    kv: asVersion(raw.kv),
    rotator: asDeviceId(raw.rotator),
    nonce: asBytes(raw.nonce, ROSTER_NONCE_BYTES, "a nonce"),
    recovery: asBytes(raw.recovery, 32, "a recovery fingerprint"),
    members,
    membersMayApprove: raw.membersMayApprove === true,
    devices,
    via,
    recoveryAnchor: raw.recoveryAnchor === undefined || raw.recoveryAnchor === null ? null : asBytes(raw.recoveryAnchor, SIGNATURE_BYTES, "a recovery anchor"),
    shares,
  };
  const uids = new Set(members.map((member) => member.uid));
  if (uids.size !== members.length) bad("names a member twice");
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) bad("names a device twice");
  if (devices.some((device) => !uids.has(device.uid))) bad("gives a device to someone who is not a member");
  if (deviceIn(roster, roster.rotator) === null) bad("was made by a device it does not hold");
  return roster;
}

// ---------------------------------------------------------------------------- sealing and opening

/** A new roster's nonce. */
export function rosterNonce(random: RandomBytes): Uint8Array<ArrayBuffer> {
  return take(random, ROSTER_NONCE_BYTES);
}

/**
 * `roster` sealed under `key` (its version) and signed with `signer`, the rotating device's signing
 * key, together with that version's public keys.
 */
export async function sealRoster(input: {
  teamId: string;
  key: TeamKey;
  pairSpki: Uint8Array;
  signSpki: Uint8Array;
  roster: Roster;
  signer: CryptoKey;
  random: RandomBytes;
}): Promise<{ roster: Envelope; rosterSig: Uint8Array<ArrayBuffer>; digest: Uint8Array<ArrayBuffer> }> {
  const { teamId, key, roster } = input;
  if (roster.kv !== key.version || roster.teamId !== teamId) throw new CryptoError("bad-input", "A roster must be sealed under the key version it lists.");
  if (roster.members.length > MAX_ROSTER_ENTRIES || roster.devices.length > MAX_ROSTER_ENTRIES || roster.via.length > MAX_ROSTER_LINKS) {
    throw new CryptoError("too-large", "The team has more members, devices or approvals than one device roster holds.");
  }
  const encoded = encodeRoster(roster);
  const padded = paddedRosterLength(encoded.byteLength);
  if (padded === null) throw new CryptoError("too-large", "The team has more members, devices or approvals than one device roster holds.");
  // JSON ignores trailing whitespace, so the padding needs no marker.
  const plaintext = new Uint8Array(padded).fill(0x20);
  plaintext.set(encoded);
  const sealed = await sealBytes(key, plaintext, aadFor.teamRoster({ teamId, kv: key.version }), input.random);
  const digest = await rosterDigest(teamId, key.version, sealed);
  const signed = rosterSignedBytes(teamId, key.version, digest, await sha256(plaintext), await teamKeyFingerprint(input.pairSpki), input.signSpki);
  return { roster: sealed, rosterSig: await sign(input.signer, signed), digest };
}

/** Opens and parses the roster of `record` with team key `key` of the same version. Throws a `CryptoError` for anything that does not check. */
export async function openRoster(teamId: string, key: TeamKey, record: Pick<RosterFields, "kv" | "roster">): Promise<OpenedRoster> {
  if (record.kv !== key.version) throw new CryptoError("wrong-key-version", `This is the roster of team key ${String(record.kv)}, not ${String(key.version)}.`);
  if (typeof record.roster !== "object" || record.roster === null) throw new CryptoError("bad-envelope", "The team key record holds no device roster.");
  assertEnvelope(record.roster);
  if (record.roster.kv !== record.kv) throw new CryptoError("wrong-key-version", "The device roster is sealed under another key version.");
  const plaintext = await openBytes(key, record.roster, aadFor.teamRoster({ teamId, kv: record.kv }));
  const roster = await decodeRoster(plaintext);
  if (roster.teamId !== teamId || roster.kv !== record.kv) throw new CryptoError("bad-envelope", "The device roster is for another team or key version.");
  return { roster, digest: await rosterDigest(teamId, record.kv, record.roster), plainDigest: await sha256(plaintext) };
}

/** True when `record.rosterSig` is `signerSpki`'s signature over `opened`. */
export async function checkRosterSignature(teamId: string, record: RosterFields, opened: OpenedRoster, signerSpki: Uint8Array): Promise<boolean> {
  if (!isBytes(record.rosterSig, { exactly: SIGNATURE_BYTES })) return false;
  const signed = rosterSignedBytes(teamId, record.kv, opened.digest, opened.plainDigest, await teamKeyFingerprint(record.pairSpki), record.signSpki);
  return verify(signerSpki, record.rosterSig, signed);
}

// ---------------------------------------------------------------------------- approval chains

/** A device that may approve others: its member and its device record, checked against its id. */
export interface Approver {
  deviceId: string;
  uid: string;
  record: DeviceRecord;
}

/** What a grant, or a `GrantLink`, says: enough to check its approver's signature. */
export interface GrantEvidence {
  deviceId: string;
  uid: string;
  kv: number;
  approverDeviceId: string;
  wrap: PublicKeyWrap;
  signature: Uint8Array;
}

/** A grant that reaches the roster, with the device record it was checked against. */
export interface RootedGrant extends Approver {
  grant: GrantEvidence;
}

/**
 * The grants of version `kv` that reach an anchor (a device of the roster that may approve), each
 * through approvals whose signatures check and that `mayApprove` allows, one link at a time: a grant
 * is taken once its approver is an anchor or a grant already taken. A grant a device made for
 * itself, one whose approver never becomes known (a device with no grant, or one dropped, or two
 * grants approving each other with no anchor behind them) and one `mayApprove` refuses are left
 * out, and so are both grants when two name the same device. The order the grants come in does not
 * matter.
 *
 * `anchorOf` gives an anchor, or null; `recordOf` gives a device's record checked against its id,
 * or null for none or one that does not check.
 */
export async function rootGrants(input: {
  teamId: string;
  kv: number;
  grants: readonly GrantEvidence[];
  anchorOf: (deviceId: string) => Approver | null;
  mayApprove: (approverUid: string, grantUid: string) => boolean;
  recordOf: (uid: string, deviceId: string) => Promise<DeviceRecord | null>;
}): Promise<Map<string, RootedGrant>> {
  const waiting = new Map<string, GrantEvidence>();
  const twice = new Set<string>();
  for (const grant of input.grants) {
    if (grant.kv !== input.kv || grant.approverDeviceId === grant.deviceId || input.anchorOf(grant.deviceId) !== null) continue;
    if (waiting.has(grant.deviceId)) twice.add(grant.deviceId);
    waiting.set(grant.deviceId, grant);
  }
  for (const deviceId of twice) waiting.delete(deviceId);
  const rooted = new Map<string, RootedGrant>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const [deviceId, grant] of [...waiting]) {
      const approver = rooted.get(grant.approverDeviceId) ?? input.anchorOf(grant.approverDeviceId);
      if (approver === null || approver === undefined) continue;
      waiting.delete(deviceId);
      if (!input.mayApprove(approver.uid, grant.uid)) continue;
      const record = await input.recordOf(grant.uid, deviceId);
      if (record === null) continue;
      let signed = false;
      try {
        const bytes = keyGrantSignedBytes(
          { v: 1, teamId: input.teamId, deviceId, uid: grant.uid, kv: grant.kv, wrap: grant.wrap, approverDeviceId: grant.approverDeviceId },
          record.fingerprint,
        );
        signed = isBytes(grant.signature, { exactly: SIGNATURE_BYTES }) && (await verify(approver.record.signSpki, grant.signature, bytes));
      } catch (error) {
        if (!isCryptoError(error)) throw error;
      }
      if (!signed) continue;
      rooted.set(deviceId, { deviceId, uid: grant.uid, record, grant });
      progress = true;
    }
  }
  return rooted;
}

/**
 * Checks roster `kv + 1` (`record`, opened with its key) against the checked roster `previous`
 * before it, and returns it opened. It must be signed by its rotator, and the rotator must be one of:
 *
 * - a device of `previous` whose member was an owner or admin in it;
 * - a device the links in its `via` root in `previous`, through approvals by a device of the same
 *   member or of an owner or admin of `previous`, whose member was an owner or admin in `previous`;
 * - a device the recovery code vouches for: a recovery link signed by the recovery key `previous`
 *   names, over this device and version `kv`. Whoever holds the code already holds every key.
 *
 * A rotator whose authority comes from the recovery code alone (`rotationAuthority`) may not raise
 * anything: no member's role above what `previous` gave them, no new member above an editor, and not
 * the sharing setting from off to on. That holds whatever member it claims to be, since the recovery
 * key endorses a device in any member's name. Nor may it give the key to a device `previous` does
 * not hold, other than its own, unless the grant links in its `via` root that device in `previous`
 * through approvals with authority (`rootedNewDevices`): the code is on paper where a member who is
 * not an owner or admin may have seen it, and a device it planted, under an owner's name above all,
 * would outlive a new code.
 *
 * Every key it checks with is in `previous` or in the new roster's links. Throws a `CryptoError`.
 */
export async function checkRosterStep(input: { teamId: string; previous: Roster; record: RosterFields; key: TeamKey }): Promise<OpenedRoster> {
  const { teamId, previous, record } = input;
  const opened = await openRoster(teamId, input.key, record);
  const roster = opened.roster;
  if (roster.kv !== previous.kv + 1) throw new CryptoError("bad-input", "The device roster does not follow the one before it.");
  const entry = deviceIn(roster, roster.rotator);
  if (entry === null) throw new CryptoError("bad-envelope", "The device roster was made by a device it does not hold.");
  const authority = await rotationAuthority({ teamId, previous, rotator: entry, via: roster.via });
  if (authority === null) {
    throw new CryptoError("bad-signature", `Team key version ${String(roster.kv)} was made by a device that could not make it.`);
  }
  if (!(await checkRosterSignature(teamId, record, opened, entry.signSpki))) {
    throw new CryptoError("bad-signature", `The device roster of team key version ${String(roster.kv)} is not signed by the device that made it.`);
  }
  if (authority === "recovery") {
    if (raisesAuthority(previous, roster)) throw new CryptoError("bad-signature", `Team key version ${String(roster.kv)} ${ROSTER_RAISES_AUTHORITY}.`);
    if (!(await rootedNewDevices({ teamId, previous, roster }))) {
      throw new CryptoError("bad-signature", `Team key version ${String(roster.kv)} ${ROSTER_UNAPPROVED_DEVICE}.`);
    }
  }
  return opened;
}

/** Why `checkRosterStep` refuses a roster the recovery code alone vouches for that raises a role or the sharing setting. */
export const ROSTER_RAISES_AUTHORITY = "gives members a say that nobody who could give it did";

/** Why `checkRosterStep` refuses a roster the recovery code alone vouches for that adds a device no approval roots. */
export const ROSTER_UNAPPROVED_DEVICE = "gives the key to a device that nobody who could approve it approved";

/**
 * True when `next` gives more authority than `previous`: a member a higher role than `previous`
 * gave them, a member new since `previous` a role above an editor, or the sharing setting on where it
 * was off.
 */
export function raisesAuthority(previous: Roster, next: Roster): boolean {
  if (next.membersMayApprove && !previous.membersMayApprove) return true;
  return next.members.some((member) => roleRank(member.role) > roleRank(roleIn(previous, member.uid) ?? NEW_MEMBER_ROLE_CAP));
}

/**
 * True when roster n's `membersMayApprove` lets `approverUid` approve a device of `grantUid`: both are
 * members of roster n, and `grantUid` is not an owner or admin there. A device approved this way for
 * an owner or admin would be kept as a device that may make the next roster, and a member who holds
 * the key could approve one the server made under an admin's name; so only an owner or admin of
 * roster n, or that member's own device, approves an owner's or admin's device.
 */
export function mayApproveUnderSetting(roster: Roster, approverUid: string, grantUid: string): boolean {
  if (!roster.membersMayApprove || roleIn(roster, approverUid) === null) return false;
  const grantRole = roleIn(roster, grantUid);
  return grantRole !== null && !isAdminRole(grantRole);
}

/**
 * Whether roster n lets a device of `approverUid` approve one of `grantUid` that the rotation to n+1
 * keeps: a device of the same member, of an owner or admin of roster n, or of a member under the
 * sharing setting (`mayApproveUnderSetting`).
 */
export function mayApproveAt(roster: Roster, approverUid: string, grantUid: string): boolean {
  return approverUid === grantUid || isAdminRole(roleIn(roster, approverUid)) || mayApproveUnderSetting(roster, approverUid, grantUid);
}

/** True when `rooted` holds `device`, in its member's name and with its keys. */
function reaches(rooted: ReadonlyMap<string, RootedGrant>, device: RosterKeys): boolean {
  const reached = rooted.get(device.deviceId);
  return reached !== undefined && reached.uid === device.uid && bytesEqual(reached.record.fingerprint, device.fingerprint);
}

/** The grant links in `via` that reach a device of `previous` through approvals `mayApprove` allows (`rootGrants`), checked with the keys the links hold. */
function rootedLinks(teamId: string, previous: Roster, via: readonly RosterLink[], mayApprove: (approverUid: string, grantUid: string) => boolean): Promise<Map<string, RootedGrant>> {
  const links = via.filter((link): link is GrantLink => link.kind === "grant");
  const linked = new Map(links.map((link) => [link.deviceId, link]));
  return rootGrants({
    teamId,
    kv: previous.kv,
    grants: links,
    anchorOf: (deviceId) => {
      const device = deviceIn(previous, deviceId);
      return device === null ? null : { deviceId, uid: device.uid, record: recordOfKeys(device) };
    },
    mayApprove,
    recordOf: async (uid, deviceId) => {
      const link = linked.get(deviceId);
      return link === undefined || link.uid !== uid ? null : recordOfKeys(link);
    },
  });
}

/**
 * True when every device of `roster` that `previous` does not hold with the same member and keys,
 * other than its rotator, is reached from a device of `previous` by the grant links in `roster.via`,
 * each approved with the authority `previous` gives (`mayApproveAt`). What a roster whose rotator has
 * only the recovery code's authority must show for the devices it adds (`checkRosterStep`).
 */
export async function rootedNewDevices(input: { teamId: string; previous: Roster; roster: Roster }): Promise<boolean> {
  const { teamId, previous, roster } = input;
  const added = roster.devices.filter((device) => {
    if (device.deviceId === roster.rotator) return false;
    const before = deviceIn(previous, device.deviceId);
    return before === null || !sameDevice(before, device);
  });
  if (added.length === 0) return true;
  const rooted = await rootedLinks(teamId, previous, roster.via, (approverUid, grantUid) => mayApproveAt(previous, approverUid, grantUid));
  return added.every((device) => reaches(rooted, device));
}

/**
 * Where a rotator's authority to make the next roster comes from (see `checkRosterStep`): `roster`
 * for a device of the previous roster whose member was an owner or admin in it, `grants` for one the
 * grant links in its roster's `via` root in the previous roster in the name of such a member, and
 * `recovery` for any other device the recovery code vouches for. A device with authority from its
 * place or its approvals is never counted as the recovery code's.
 */
export type RotationAuthority = "roster" | "grants" | "recovery";

/** Where `previous`, with the links in `via`, gives `rotator` the authority to make the next roster from (`RotationAuthority`), or null for nowhere. */
export async function rotationAuthority(input: { teamId: string; previous: Roster; rotator: RosterKeys; via: readonly RosterLink[] }): Promise<RotationAuthority | null> {
  const { teamId, previous, rotator } = input;
  const before = deviceIn(previous, rotator.deviceId);
  if (before !== null && !sameDevice(before, rotator)) return null;
  if (isAdminRole(roleIn(previous, rotator.uid))) {
    if (before !== null) return "roster";
    const rooted = await rootedLinks(teamId, previous, input.via, (approverUid, grantUid) => approverUid === grantUid || isAdminRole(roleIn(previous, approverUid)));
    if (reaches(rooted, rotator)) return "grants";
  }
  // The recovery code vouches for any device, one of the roster's included, in any member's name.
  for (const link of input.via) {
    if (link.kind !== "recovery" || !sameDevice(link, rotator) || link.kv !== previous.kv) continue;
    let named: boolean;
    try {
      named = bytesEqual(await recoveryFingerprint({ spki: link.recoverySpki, signSpki: link.recoverySignSpki }), previous.recovery);
    } catch (error) {
      if (!isCryptoError(error)) throw error;
      named = false;
    }
    if (named && (await verify(link.recoverySignSpki, link.signature, recoveryEndorsementBytes(teamId, previous.kv, link.deviceId, link.uid, link.fingerprint)))) return "recovery";
  }
  return null;
}

/** True when `previous`, with the links in `via`, gives `rotator` the authority to make the next roster (see `checkRosterStep`). */
export async function mayRotate(input: { teamId: string; previous: Roster; rotator: RosterKeys; via: readonly RosterLink[] }): Promise<boolean> {
  return (await rotationAuthority(input)) !== null;
}
