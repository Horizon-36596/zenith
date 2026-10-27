/**
 * Team keys (spec 14 sections 4.1, 4.2 and 4.5). A team has a versioned 256-bit AES-GCM team key
 * and, with each version, a P-256 ECDH team key pair whose public half other teams wrap share keys
 * to, and a P-256 ECDSA team signing pair. `teams/{teamId}/teamKeys/{n}` holds key n-1 sealed under
 * key n and both pairs' private halves sealed under key n, so the newest key opens every older one.
 * Each approved device holds the newest key in `teams/{teamId}/keyGrants/{deviceId}`, wrapped to its
 * encryption key and signed by the device that approved it. No team key is ever stored in the clear.
 *
 * The signing pairs make a chain other teams can check without any team key: version n's public keys
 * are signed with version n-1's signing key (`teamKeySignedBytes`). A partner team that pinned
 * version m accepts version n > m only when every step from m to n verifies, so a public key the
 * server made up is never taken as a rotation.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { bytesEqual, concatBytes, toBytes, utf8Encode } from "./bytes.js";
import { aadFor, idPart, isKeyVersion, uidPart, versionPart } from "./aad.js";
import { checkDeviceRecord, sign, SIGNATURE_BYTES, verify, type DeviceKeys, type DeviceRecord } from "./device.js";
import { assertEnvelope, openBytes, sealBytes, type Envelope, type VersionedKey } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { AES_KEY_BYTES, exportAesKey, importAesKey, isBytes, sha256, subtle, take } from "./primitives.js";
import { assertPublicKeyWrap, importEcdhPublicKey, P256_SPKI_BYTES, unwrapWithPrivateKey, wrapToPublicKey, type PublicKeyWrap } from "./wrap.js";

/** A team key: AES-256-GCM, with its version n (from 1). Held in memory only. */
export type TeamKey = VersionedKey;

/**
 * Team key pairs n, opened: the ECDH pair other teams wrap to, and the ECDSA pair that signs version
 * n+1. Both private halves are non-extractable; the first can only `deriveBits`, the second only `sign`.
 */
export interface TeamKeyPair {
  /** The same n as the team key it belongs to. */
  version: number;
  /** 91-byte SPKI of the ECDH public half. */
  spki: Uint8Array;
  /** 32 bytes, `teamKeyFingerprint(spki)`. */
  fingerprint: Uint8Array;
  privateKey: CryptoKey;
  /** 91-byte SPKI of the ECDSA signing public half. */
  signSpki: Uint8Array;
  /** The ECDSA signing private half. */
  signingKey: CryptoKey;
  /** 64 bytes: version n-1's signing key over `teamKeySignedBytes` of version n, or null when n is 1. */
  sig: Uint8Array | null;
}

/**
 * `encKey` on `teams/{teamId}`: the public halves of the newest team key pairs, which any signed-in
 * user can read and wrap share keys to. `v` is the team key version n it belongs to.
 */
export interface TeamEncKey {
  v: number;
  /** 91-byte SPKI of the ECDH public half. */
  spki: Uint8Array;
  /** 32 bytes, SHA-256 of `spki`. */
  fingerprint: Uint8Array;
  /** 91-byte SPKI of the ECDSA signing public half. */
  signSpki: Uint8Array;
  /** 64 bytes: version n-1's signing key over `teamKeySignedBytes` of this version, or null when `v` is 1. */
  sig: Uint8Array | null;
}

/** `teams/{teamId}/teamKeys/{kv}`. */
export interface TeamKeyRecord {
  v: 1;
  /** This record's version n, which is also its document id. */
  kv: number;
  /** Team key n-1's 32 raw bytes sealed under team key n (`aadFor.teamKeyChain`), or null when n is 1. */
  prev: Envelope | null;
  /** 91-byte SPKI of team key pair n's public half. */
  pairSpki: Uint8Array;
  /** Team key pair n's private half as PKCS#8, sealed under team key n (`aadFor.teamKeyPair`). */
  pairPrivate: Envelope;
  /** 91-byte SPKI of team signing pair n's public half. */
  signSpki: Uint8Array;
  /** Team signing pair n's private half as PKCS#8, sealed under team key n (`aadFor.teamSigningKey`). */
  signPrivate: Envelope;
  /** The same signature as `encKey.sig` of version n: by signing pair n-1, or null when n is 1. */
  sig: Uint8Array | null;
}

/** `teams/{teamId}/keyGrants/{deviceId}`: team key `kv` for one device, from the device that approved it. */
export interface KeyGrant {
  v: 1;
  teamId: string;
  /** The device the key is for; also the document id. */
  deviceId: string;
  /** The member the device belongs to. The approver's signature covers it, so a grant cannot be moved to another member's name. */
  uid: string;
  /** The team key version wrapped. */
  kv: number;
  /** Team key `kv` wrapped to the device's encryption key (`aadFor.keyGrant`); 125 bytes in all. */
  wrap: PublicKeyWrap;
  /** The device that made the grant: the approver, or the device itself after recovery or at team creation. */
  approverDeviceId: string;
  /** 64-byte ECDSA P-256 SHA-256 signature by the approver's signing key over `keyGrantSignedBytes`. */
  signature: Uint8Array;
}

/** One opened version of a team's keys. */
export interface TeamKeyVersion {
  key: TeamKey;
  pair: TeamKeyPair;
}

/** A new team key version, as `createTeamKeys` and `rotateTeamKeys` return it. */
export interface NewTeamKeys {
  /** Extractable, so this device can wrap it into grants and the recovery record. Keep it in memory only. */
  key: TeamKey;
  pair: TeamKeyPair;
  /** Write to `teams/{teamId}/teamKeys/{key.version}`. */
  record: TeamKeyRecord;
  /** Write to `encKey` on `teams/{teamId}`. */
  encKey: TeamEncKey;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

/** 32 bytes: SHA-256 of a team key pair's 91-byte SPKI. */
export async function teamKeyFingerprint(spki: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBytes(spki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-key", "A team public key must be a 91-byte P-256 SPKI.");
  return sha256(spki);
}

/** The `encKey` to publish for an opened team key pair. */
export function teamEncKeyFor(pair: TeamKeyPair): TeamEncKey {
  return {
    v: pair.version,
    spki: toBytes(pair.spki),
    fingerprint: toBytes(pair.fingerprint),
    signSpki: toBytes(pair.signSpki),
    sig: pair.sig === null ? null : toBytes(pair.sig),
  };
}

/**
 * Checks an `encKey` read from the server: a valid version, a fingerprint that is the SHA-256 of its
 * key, a 91-byte signing key, and a signature of 64 bytes (none at version 1). Whether the signature
 * verifies is `checkTeamKeyStep`'s question, which needs the previous version's signing key.
 */
export async function checkTeamEncKey(encKey: TeamEncKey): Promise<void> {
  if (typeof encKey !== "object" || encKey === null || !isKeyVersion(encKey.v)) throw new CryptoError("bad-key", "The team's public key has no valid version.");
  const fingerprint = await teamKeyFingerprint(encKey.spki);
  if (!isBytes(encKey.fingerprint, { exactly: 32 }) || !bytesEqual(fingerprint, encKey.fingerprint)) {
    throw new CryptoError("bad-key", "The team's public key does not match its fingerprint.");
  }
  if (!isBytes(encKey.signSpki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-key", "The team's signing key is not a 91-byte P-256 SPKI.");
  if (encKey.v === 1 ? encKey.sig !== null : !isBytes(encKey.sig, { exactly: SIGNATURE_BYTES })) {
    throw new CryptoError("bad-key", "The team's public key has a signature where it should have none, or none where it needs one.");
  }
}

/**
 * The exact bytes version n-1's signing key signs for version n: the text
 * `zenith/v1/team-key-signature|team=|kv=`, a zero byte, then version n's ECDH fingerprint (32 bytes)
 * and signing SPKI (91 bytes).
 */
export function teamKeySignedBytes(teamId: string, kv: number, fingerprint: Uint8Array, signSpki: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(fingerprint, { exactly: 32 }) || !isBytes(signSpki, { exactly: P256_SPKI_BYTES })) {
    throw new CryptoError("bad-key", "A team key step needs a 32-byte fingerprint and a 91-byte signing key.");
  }
  const label = ["zenith/v1/team-key-signature", idPart("team", teamId), versionPart("kv", kv)].join("|");
  return concatBytes(utf8Encode(label), new Uint8Array([0]), fingerprint, signSpki);
}

/**
 * True when `next` (version n > 1, from an `encKey` or a `teamKeys` record) is signed by the signing
 * key `previousSignSpki` of version n-1. A partner walks this from the version it pinned up to the
 * one it is shown.
 */
export async function checkTeamKeyStep(
  teamId: string,
  previousSignSpki: Uint8Array,
  next: { v: number; fingerprint: Uint8Array; signSpki: Uint8Array; sig: Uint8Array | null },
): Promise<boolean> {
  if (!isKeyVersion(next.v) || next.v < 2 || next.sig === null || !isBytes(next.sig, { exactly: SIGNATURE_BYTES })) return false;
  return verify(previousSignSpki, next.sig, teamKeySignedBytes(teamId, next.v, next.fingerprint, next.signSpki));
}

async function newTeamKeys(teamId: string, version: number, previous: TeamKeyVersion | null, random: RandomBytes): Promise<NewTeamKeys> {
  const raw = take(random, AES_KEY_BYTES);
  let key: TeamKey;
  try {
    key = { version, key: await importAesKey(raw, true) };
  } finally {
    raw.fill(0);
  }
  // Each pair is made extractable only long enough to seal its PKCS#8, then imported again as non-extractable.
  const generated = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  const spki = new Uint8Array(await subtle().exportKey("spki", generated.publicKey));
  const fingerprint = await teamKeyFingerprint(spki);
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", generated.privateKey));
  let pairPrivate: Envelope;
  let privateKey: CryptoKey;
  try {
    pairPrivate = await sealBytes(key, pkcs8, aadFor.teamKeyPair({ teamId, kv: version, fingerprint }), random);
    privateKey = await subtle().importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
  } finally {
    pkcs8.fill(0);
  }
  const signing = await subtle().generateKey(ECDSA, true, ["sign", "verify"]);
  const signSpki = new Uint8Array(await subtle().exportKey("spki", signing.publicKey));
  const signPkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", signing.privateKey));
  let signPrivate: Envelope;
  let signingKey: CryptoKey;
  try {
    signPrivate = await sealBytes(key, signPkcs8, aadFor.teamSigningKey({ teamId, kv: version, fingerprint: await sha256(signSpki) }), random);
    signingKey = await subtle().importKey("pkcs8", signPkcs8, ECDSA, false, ["sign"]);
  } finally {
    signPkcs8.fill(0);
  }
  let prev: Envelope | null = null;
  let sig: Uint8Array<ArrayBuffer> | null = null;
  if (previous !== null) {
    const previousRaw = await exportAesKey(previous.key.key);
    try {
      prev = await sealBytes(key, previousRaw, aadFor.teamKeyChain({ teamId, kv: version }), random);
    } finally {
      previousRaw.fill(0);
    }
    sig = await sign(previous.pair.signingKey, teamKeySignedBytes(teamId, version, fingerprint, signSpki));
  }
  const pair: TeamKeyPair = { version, spki, fingerprint, privateKey, signSpki, signingKey, sig };
  return {
    key,
    pair,
    record: { v: 1, kv: version, prev, pairSpki: toBytes(spki), pairPrivate, signSpki: toBytes(signSpki), signPrivate, sig: sig === null ? null : toBytes(sig) },
    encKey: teamEncKeyFor(pair),
  };
}

/** Team key 1 and team key pair 1 for a new team (spec 14 section 4.2). `random` supplies the key and the IVs. */
export async function createTeamKeys(teamId: string, random: RandomBytes = cryptoRandomBytes): Promise<NewTeamKeys> {
  idPart("team", teamId);
  return newTeamKeys(teamId, 1, null, random);
}

/**
 * Team key n+1 and team key pairs n+1, whose record holds `current.key` (key n) sealed under key n+1
 * (spec 14 section 4.5), and whose public keys `current.pair`'s signing key signs. `current` must be
 * the newest version, its key opened as extractable.
 */
export async function rotateTeamKeys(teamId: string, current: TeamKeyVersion, random: RandomBytes = cryptoRandomBytes): Promise<NewTeamKeys> {
  idPart("team", teamId);
  const version = current.key.version;
  if (!isKeyVersion(version) || !isKeyVersion(version + 1)) throw new CryptoError("bad-input", "The current team key has no valid version.");
  if (current.pair.version !== version) throw new CryptoError("bad-input", "The current team key and its key pairs are of different versions.");
  return newTeamKeys(teamId, version + 1, current, random);
}

function assertTeamKeyRecord(record: unknown): asserts record is TeamKeyRecord {
  if (typeof record !== "object" || record === null) throw new CryptoError("bad-envelope", "The team key record is missing.");
  const value = record as Partial<TeamKeyRecord>;
  if (value.v !== 1 || !isKeyVersion(value.kv)) throw new CryptoError("bad-envelope", "The team key record has a version this app does not know.");
  if (!isBytes(value.pairSpki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-envelope", "The team key record's public key is not a 91-byte SPKI.");
  assertEnvelope(value.pairPrivate);
  if (!isBytes(value.signSpki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-envelope", "The team key record's signing key is not a 91-byte SPKI.");
  assertEnvelope(value.signPrivate);
  if (value.kv === 1 ? value.sig !== null : !isBytes(value.sig, { exactly: SIGNATURE_BYTES })) {
    throw new CryptoError("bad-envelope", "The team key record's signature is missing or should not be there.");
  }
  if (value.kv === 1 ? value.prev !== null : value.prev === null || value.prev === undefined) {
    throw new CryptoError("bad-envelope", "The team key record's link to the previous version is missing or should not be there.");
  }
  if (value.prev !== null) assertEnvelope(value.prev);
}

/**
 * Throws `bad-key` unless `privateKey` is the private half of the P-256 key `spki`: a fresh probe key
 * pair derives the same ECDH secret with each half. Opening a record checks this, so a record whose
 * sealed private key belongs to another pair (one made by whoever wrote the record) is refused even
 * though its public key is the team's, and a device that pinned the team's public key can trust the
 * private key that comes with it.
 */
async function assertPairMatches(privateKey: CryptoKey, spki: Uint8Array): Promise<void> {
  const publicKey = await importEcdhPublicKey(spki);
  const probe = await subtle().generateKey(ECDH, false, ["deriveBits"]);
  const mine = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: probe.publicKey }, privateKey, 256));
  const theirs = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: publicKey }, probe.privateKey, 256));
  const same = bytesEqual(mine, theirs);
  mine.fill(0);
  theirs.fill(0);
  if (!same) throw new CryptoError("bad-key", "The team's private key in its record does not belong to the team's public key.");
}

/** Throws `bad-key` unless `signingKey` is the private half of the ECDSA key `spki`: it signs a probe that `spki` verifies. */
async function assertSigningPairMatches(signingKey: CryptoKey, spki: Uint8Array): Promise<void> {
  const probe = utf8Encode("zenith/v1/team-signing-probe");
  if (!(await verify(spki, await sign(signingKey, probe), probe))) {
    throw new CryptoError("bad-key", "The team's signing key in its record does not belong to the team's signing public key.");
  }
}

/**
 * Opens team key pair `key.version` from its record, and checks that the private key belongs to the
 * record's public key. Throws `wrong-key-version`, `bad-envelope`, `decrypt-failed` or `bad-key`.
 */
export async function openTeamKeyRecord(teamId: string, key: TeamKey, record: TeamKeyRecord): Promise<TeamKeyPair> {
  assertTeamKeyRecord(record);
  if (record.kv !== key.version) throw new CryptoError("wrong-key-version", `This is the record for team key ${String(record.kv)}, not ${String(key.version)}.`);
  const fingerprint = await teamKeyFingerprint(record.pairSpki);
  const pkcs8 = await openBytes(key, record.pairPrivate, aadFor.teamKeyPair({ teamId, kv: record.kv, fingerprint }));
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle().importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
  } catch (error) {
    throw new CryptoError("bad-key", "The team's private key in its record is not a P-256 key.", { cause: error });
  } finally {
    pkcs8.fill(0);
  }
  await assertPairMatches(privateKey, record.pairSpki);
  const signPkcs8 = await openBytes(key, record.signPrivate, aadFor.teamSigningKey({ teamId, kv: record.kv, fingerprint: await sha256(record.signSpki) }));
  let signingKey: CryptoKey;
  try {
    signingKey = await subtle().importKey("pkcs8", signPkcs8, ECDSA, false, ["sign"]);
  } catch (error) {
    throw new CryptoError("bad-key", "The team's signing key in its record is not a P-256 key.", { cause: error });
  } finally {
    signPkcs8.fill(0);
  }
  await assertSigningPairMatches(signingKey, record.signSpki);
  return {
    version: record.kv,
    spki: toBytes(record.pairSpki),
    fingerprint,
    privateKey,
    signSpki: toBytes(record.signSpki),
    signingKey,
    sig: record.sig === null ? null : toBytes(record.sig),
  };
}

/** Options for opening older team keys. */
export interface OpenKeyOptions {
  /** Open the keys as extractable, which only an approving or rotating device needs. Default false. */
  extractable?: boolean;
}

/**
 * Every team key version from the newest down to the oldest record given, opened from the newest
 * key: version n from `newest`, and each older one from the `prev` of the record above it.
 * `records` must run without gaps from `newest.version` down to the oldest version wanted (pass all
 * of them to reach version 1). Older keys are non-extractable unless `options.extractable`. Returns
 * a map from version to key and pair. Throws `missing-key-version` for a gap.
 */
export async function openChain(teamId: string, newest: TeamKey, records: readonly TeamKeyRecord[], options: OpenKeyOptions = {}): Promise<Map<number, TeamKeyVersion>> {
  const byVersion = new Map<number, TeamKeyRecord>();
  for (const record of records) {
    assertTeamKeyRecord(record);
    if (byVersion.has(record.kv)) throw new CryptoError("bad-input", `Two team key records claim version ${String(record.kv)}.`);
    byVersion.set(record.kv, record);
  }
  const oldest = Math.min(...byVersion.keys());
  const out = new Map<number, TeamKeyVersion>();
  let key: TeamKey = newest;
  for (let version = newest.version; ; version--) {
    const record = byVersion.get(version);
    if (record === undefined) throw new CryptoError("missing-key-version", `Team key record ${String(version)} is missing, so the key chain cannot be opened.`);
    out.set(version, { key, pair: await openTeamKeyRecord(teamId, key, record) });
    if (version === oldest || record.prev === null) break;
    const raw = await openBytes(key, record.prev, aadFor.teamKeyChain({ teamId, kv: version }));
    try {
      key = { version: version - 1, key: await importAesKey(raw, options.extractable ?? false) };
    } finally {
      raw.fill(0);
    }
  }
  // Each version's public keys must carry the signature of the version below, as partners check them.
  for (const [version, opened] of out) {
    const below = out.get(version - 1);
    if (below !== undefined && !(await checkTeamKeyStep(teamId, below.pair.signSpki, { ...opened.pair, v: version }))) {
      throw new CryptoError("bad-signature", `Team key version ${String(version)} is not signed by version ${String(version - 1)}.`);
    }
  }
  return out;
}

/**
 * The exact bytes an approver signs for a grant: the text
 * `zenith/v1/key-grant-signature|team=|device=|uid=|kv=|approver=` (the uid as base64url of its
 * UTF-8), a zero byte, the recipient device's 32-byte fingerprint, then the wrap's `epk` (65 bytes),
 * `iv` (12 bytes) and `ct`. Everything a grant says is covered, and so are whose device it is and
 * that device's keys, so a member who holds the key cannot make a grant an approver signed for one
 * member or device count for another. `fingerprint` comes from the recipient's device record.
 */
export function keyGrantSignedBytes(grant: Omit<KeyGrant, "signature">, fingerprint: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(fingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  const label = [
    "zenith/v1/key-grant-signature",
    idPart("team", grant.teamId),
    idPart("device", grant.deviceId),
    uidPart(grant.uid),
    versionPart("kv", grant.kv),
    idPart("approver", grant.approverDeviceId),
  ].join("|");
  return concatBytes(utf8Encode(label), new Uint8Array([0]), fingerprint, grant.wrap.epk, grant.wrap.iv, grant.wrap.ct);
}

/**
 * A grant of `teamKey` (opened as extractable) to the device `recipient`, signed by `approver`
 * (spec 14 section 4.3). The recipient's record is checked against its id first.
 */
export async function makeKeyGrant(input: {
  teamId: string;
  teamKey: TeamKey;
  recipient: { deviceId: string; uid: string; record: DeviceRecord };
  approver: Pick<DeviceKeys, "deviceId" | "signing">;
  random?: RandomBytes;
}): Promise<KeyGrant> {
  await checkDeviceRecord(input.recipient.deviceId, input.recipient.record);
  const raw = await exportAesKey(input.teamKey.key);
  let wrap: PublicKeyWrap;
  try {
    const aad = aadFor.keyGrant({ teamId: input.teamId, deviceId: input.recipient.deviceId, kv: input.teamKey.version });
    wrap = await wrapToPublicKey(input.recipient.record.encSpki, raw, aad, input.random ?? cryptoRandomBytes);
  } finally {
    raw.fill(0);
  }
  const unsigned = {
    v: 1 as const,
    teamId: input.teamId,
    deviceId: input.recipient.deviceId,
    uid: input.recipient.uid,
    kv: input.teamKey.version,
    wrap,
    approverDeviceId: input.approver.deviceId,
  };
  const signature = await sign(input.approver.signing.privateKey, keyGrantSignedBytes(unsigned, input.recipient.record.fingerprint));
  return { ...unsigned, signature };
}

/**
 * The team key in a grant to this device. Checks, in order: the grant's shape; that it is for
 * `teamId` and this device; that it names `approver` and that approver's record matches its id; the
 * signature (`bad-signature`); then unwraps (`decrypt-failed`). Which approvers to trust (one of
 * the member's own devices, or an owner's or admin's) is the caller's decision.
 */
export async function openKeyGrant(input: {
  teamId: string;
  grant: KeyGrant;
  device: Pick<DeviceKeys, "deviceId" | "encryption" | "fingerprint">;
  approver: { deviceId: string; record: DeviceRecord };
  extractable?: boolean;
}): Promise<TeamKey> {
  const { grant } = input;
  if (typeof grant !== "object" || grant === null || grant.v !== 1 || !isKeyVersion(grant.kv) || !isBytes(grant.signature)) {
    throw new CryptoError("bad-envelope", "The key grant has a version this app does not know.");
  }
  assertPublicKeyWrap(grant.wrap);
  if (grant.teamId !== input.teamId || grant.deviceId !== input.device.deviceId) throw new CryptoError("bad-input", "This key grant is for another team or another device.");
  if (grant.approverDeviceId !== input.approver.deviceId) throw new CryptoError("bad-input", "This key grant was made by a different device from the one given.");
  await checkDeviceRecord(input.approver.deviceId, input.approver.record);
  if (!(await verify(input.approver.record.signSpki, grant.signature, keyGrantSignedBytes(grant, input.device.fingerprint)))) {
    throw new CryptoError("bad-signature", "The key grant's signature does not match the device that is said to have approved it.");
  }
  const raw = await unwrapWithPrivateKey(input.device.encryption.privateKey, grant.wrap, aadFor.keyGrant({ teamId: grant.teamId, deviceId: grant.deviceId, kv: grant.kv }));
  try {
    return { version: grant.kv, key: await importAesKey(raw, input.extractable ?? false) };
  } finally {
    raw.fill(0);
  }
}

/**
 * The proof a grant carries: the recipient device's 32-byte fingerprint sealed under the team key the
 * grant holds (`aadFor.keyGrantProof`, which binds the member's `uid` too). Only a holder of that key can make it, and any holder can check
 * it, so a device that rotates the team key re-grants only devices that a key holder approved: a
 * grant the server wrote for a device of its own has no valid proof.
 */
export async function makeGrantProof(input: { teamId: string; deviceId: string; uid: string; fingerprint: Uint8Array; teamKey: TeamKey; random?: RandomBytes }): Promise<Envelope> {
  if (!isBytes(input.fingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  const aad = aadFor.keyGrantProof({ teamId: input.teamId, deviceId: input.deviceId, uid: input.uid, kv: input.teamKey.version });
  return sealBytes(input.teamKey, input.fingerprint, aad, input.random ?? cryptoRandomBytes);
}

/**
 * Checks a grant's proof with team key `teamKey` (the version the proof names): the device record
 * must match its id, and the proof must open to that record's fingerprint. Throws `bad-key` for a
 * record or proof that does not match, `wrong-key-version` for another key, and `decrypt-failed` for a
 * proof no holder of the key made.
 */
export async function checkGrantProof(input: { teamId: string; deviceId: string; uid: string; record: DeviceRecord; teamKey: TeamKey; proof: Envelope }): Promise<void> {
  await checkDeviceRecord(input.deviceId, input.record);
  const aad = aadFor.keyGrantProof({ teamId: input.teamId, deviceId: input.deviceId, uid: input.uid, kv: input.teamKey.version });
  const fingerprint = await openBytes(input.teamKey, input.proof, aad);
  if (!bytesEqual(fingerprint, input.record.fingerprint)) throw new CryptoError("bad-key", "The grant's proof names a different device.");
}
