/**
 * The team recovery code (spec 14 sections 4.1 and 5.3): 128 random bits printed once as
 * `ZNTH-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`, and never stored anywhere but on paper.
 *
 * Spec 14 says `recovery/current` holds the newest team key wrapped under the recovery key and that
 * each rotation re-wraps it "under the same recovery key". A rotating device does not have the code,
 * so the record uses a recovery key pair instead: its public half is stored in the clear, each
 * rotation wraps the new team key to it (as a grant is wrapped to a device), and its private half is
 * sealed under a key derived from the code. Only the code opens it, so the paper never goes out of
 * date and a removed member who never saw the code cannot open a later team key.
 *
 * The record also holds a recovery signing pair (P-256 ECDSA), its private half sealed under the same
 * code key. A device that used the code signs with it to show that it did: that is what lets such a
 * device, which no teammate approved, make the team's next key roster (keys/roster.ts). Each roster
 * names the recovery record by `recoveryFingerprint`, the SHA-256 of both public halves, so a rotating
 * device wraps the next key only to the recovery key the signed roster names.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { bytesEqual, concatBytes, utf8Encode } from "./bytes.js";
import { aadFor, isKeyVersion } from "./aad.js";
import { assertEnvelope, openBytes, sealBytes, type Envelope, type VersionedKey } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { sign, verify } from "./device.js";
import { exportAesKey, hkdfAesKey, importAesKey, isBytes, sha256, subtle, take } from "./primitives.js";
import type { TeamKey } from "./team.js";
import { assertPublicKeyWrap, P256_SPKI_BYTES, unwrapWithPrivateKey, wrapToPublicKey, type PublicKeyWrap } from "./wrap.js";

/** A recovery code, bytes (128 bits). */
export const RECOVERY_CODE_BYTES = 16;

/**
 * `teams/{teamId}/recovery/current`.
 */
export interface RecoveryRecord {
  v: 1;
  /** The team key version `teamKey` holds: the newest. */
  kv: number;
  /** 91-byte SPKI of the recovery public key (P-256 ECDH). */
  spki: Uint8Array;
  /**
   * The recovery private key as PKCS#8, sealed under the key derived from the code
   * (`aadFor.recoveryKeyPair`). Its `kv` is always 1: a code has no versions, a new code makes a new record.
   */
  privateKey: Envelope;
  /** 91-byte SPKI of the recovery signing key (P-256 ECDSA). */
  signSpki: Uint8Array;
  /** The recovery signing key's private half as PKCS#8, sealed under the code's key (`aadFor.recoverySigningKey`), `kv` 1. */
  signPrivate: Envelope;
  /** Team key `kv` wrapped to `spki` (`aadFor.recovery`). */
  teamKey: PublicKeyWrap;
  /**
   * SHA-256 of `spki`, sealed under team key `kv` (`aadFor.recoveryCheck`). A rotating device opens it
   * with the key it already holds before wrapping the next key to `spki`, so a server cannot swap in a
   * public key of its own.
   */
  check: Envelope;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const NO_SALT = new Uint8Array(0);

/** A new recovery code: 16 random bytes. */
export function newRecoveryCode(random: RandomBytes = cryptoRandomBytes): Uint8Array<ArrayBuffer> {
  return take(random, RECOVERY_CODE_BYTES);
}

function assertCode(code: Uint8Array): void {
  if (!isBytes(code, { exactly: RECOVERY_CODE_BYTES })) throw new CryptoError("bad-input", "A recovery code must be exactly 16 bytes.");
}

/** The AES-256-GCM key a code opens its record with: HKDF-SHA-256, empty salt, info `zenith/v1/recovery-key`. */
async function codeKey(code: Uint8Array): Promise<VersionedKey> {
  assertCode(code);
  return { version: 1, key: await hkdfAesKey(code, NO_SALT, "zenith/v1/recovery-key") };
}

async function sealCheck(teamId: string, teamKey: TeamKey, spki: Uint8Array, random: RandomBytes): Promise<Envelope> {
  return sealBytes(teamKey, await sha256(spki), aadFor.recoveryCheck({ teamId, kv: teamKey.version }), random);
}

async function openCheck(teamId: string, teamKey: TeamKey, record: RecoveryRecord): Promise<void> {
  const fingerprint = await openBytes(teamKey, record.check, aadFor.recoveryCheck({ teamId, kv: teamKey.version }));
  if (!bytesEqual(fingerprint, await sha256(record.spki))) throw new CryptoError("bad-key", "The recovery record's public key is not the one the team set.");
}

async function wrapTeamKey(teamId: string, spki: Uint8Array, teamKey: TeamKey, random: RandomBytes): Promise<PublicKeyWrap> {
  const raw = await exportAesKey(teamKey.key);
  try {
    return await wrapToPublicKey(spki, raw, aadFor.recovery({ teamId, kv: teamKey.version }), random);
  } finally {
    raw.fill(0);
  }
}

function assertRecoveryRecord(record: unknown): asserts record is RecoveryRecord {
  if (typeof record !== "object" || record === null) throw new CryptoError("bad-envelope", "The recovery record is missing.");
  const value = record as Partial<RecoveryRecord>;
  if (value.v !== 1 || !isKeyVersion(value.kv)) throw new CryptoError("bad-envelope", "The recovery record has a version this app does not know.");
  if (!isBytes(value.spki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-envelope", "The recovery record's public key is not a 91-byte SPKI.");
  assertEnvelope(value.privateKey);
  if (!isBytes(value.signSpki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-envelope", "The recovery record's signing key is not a 91-byte SPKI.");
  assertEnvelope(value.signPrivate);
  assertPublicKeyWrap(value.teamKey);
  assertEnvelope(value.check);
}

/**
 * A new `recovery/current` for `code`, holding `teamKey` (opened as extractable). Used when a team is
 * created and whenever an owner makes a new code.
 */
export async function createRecovery(input: { teamId: string; teamKey: TeamKey; code: Uint8Array; random?: RandomBytes }): Promise<RecoveryRecord> {
  const random = input.random ?? cryptoRandomBytes;
  const sealer = await codeKey(input.code);
  const generated = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  const spki = new Uint8Array(await subtle().exportKey("spki", generated.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", generated.privateKey));
  let privateKey: Envelope;
  try {
    privateKey = await sealBytes(sealer, pkcs8, aadFor.recoveryKeyPair({ teamId: input.teamId }), random);
  } finally {
    pkcs8.fill(0);
  }
  const signing = await subtle().generateKey(ECDSA, true, ["sign", "verify"]);
  const signSpki = new Uint8Array(await subtle().exportKey("spki", signing.publicKey));
  const signPkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", signing.privateKey));
  let signPrivate: Envelope;
  try {
    signPrivate = await sealBytes(sealer, signPkcs8, aadFor.recoverySigningKey({ teamId: input.teamId }), random);
  } finally {
    signPkcs8.fill(0);
  }
  return {
    v: 1,
    kv: input.teamKey.version,
    spki,
    privateKey,
    signSpki,
    signPrivate,
    teamKey: await wrapTeamKey(input.teamId, spki, input.teamKey, random),
    check: await sealCheck(input.teamId, input.teamKey, spki, random),
  };
}

/**
 * `record` moved on to `newKey` at a rotation, without the code: `currentKey` (the version the record
 * holds) confirms the recovery public key, then `newKey` (extractable) is wrapped to it.
 */
export async function rewrapRecovery(input: { teamId: string; record: RecoveryRecord; currentKey: TeamKey; newKey: TeamKey; random?: RandomBytes }): Promise<RecoveryRecord> {
  const random = input.random ?? cryptoRandomBytes;
  assertRecoveryRecord(input.record);
  if (input.record.kv !== input.currentKey.version) {
    throw new CryptoError("wrong-key-version", `The recovery record holds team key ${String(input.record.kv)}, not ${String(input.currentKey.version)}.`);
  }
  await openCheck(input.teamId, input.currentKey, input.record);
  return {
    v: 1,
    kv: input.newKey.version,
    spki: input.record.spki,
    privateKey: input.record.privateKey,
    signSpki: input.record.signSpki,
    signPrivate: input.record.signPrivate,
    teamKey: await wrapTeamKey(input.teamId, input.record.spki, input.newKey, random),
    check: await sealCheck(input.teamId, input.newKey, input.record.spki, random),
  };
}

/**
 * The newest team key, opened with the printed code. A wrong code, or a record that was changed,
 * throws `decrypt-failed`. `extractable` defaults to false; a device recovering the team passes true
 * so it can then grant the key to itself.
 */
export async function openRecovery(input: { teamId: string; record: RecoveryRecord; code: Uint8Array; extractable?: boolean }): Promise<TeamKey> {
  assertRecoveryRecord(input.record);
  const sealer = await codeKey(input.code);
  const pkcs8 = await openBytes(sealer, input.record.privateKey, aadFor.recoveryKeyPair({ teamId: input.teamId }));
  let privateKey: CryptoKey;
  try {
    privateKey = await subtle().importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
  } catch (error) {
    throw new CryptoError("bad-key", "The recovery private key in the record is not a P-256 key.", { cause: error });
  } finally {
    pkcs8.fill(0);
  }
  const raw = await unwrapWithPrivateKey(privateKey, input.record.teamKey, aadFor.recovery({ teamId: input.teamId, kv: input.record.kv }));
  let teamKey: TeamKey;
  try {
    teamKey = { version: input.record.kv, key: await importAesKey(raw, input.extractable ?? false) };
  } finally {
    raw.fill(0);
  }
  await openCheck(input.teamId, teamKey, input.record);
  return teamKey;
}

/**
 * 32 bytes that name a recovery record's keys: SHA-256 of its 91-byte ECDH public key followed by its
 * 91-byte signing public key. A key roster holds it, so a rotating device can tell the team's own
 * recovery record from one that anyone holding the team key made.
 */
export async function recoveryFingerprint(record: Pick<RecoveryRecord, "spki" | "signSpki">): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBytes(record.spki, { exactly: P256_SPKI_BYTES }) || !isBytes(record.signSpki, { exactly: P256_SPKI_BYTES })) {
    throw new CryptoError("bad-key", "A recovery record's public keys must each be a 91-byte P-256 SPKI.");
  }
  return sha256(concatBytes(record.spki, record.signSpki));
}

/**
 * The recovery signing key, opened with the printed code: a non-extractable ECDSA key that can only
 * sign. It is checked against `record.signSpki` before it is returned. A wrong code throws
 * `decrypt-failed`.
 */
export async function openRecoverySigner(input: { teamId: string; record: RecoveryRecord; code: Uint8Array }): Promise<CryptoKey> {
  assertRecoveryRecord(input.record);
  const sealer = await codeKey(input.code);
  const pkcs8 = await openBytes(sealer, input.record.signPrivate, aadFor.recoverySigningKey({ teamId: input.teamId }));
  let signingKey: CryptoKey;
  try {
    signingKey = await subtle().importKey("pkcs8", pkcs8, ECDSA, false, ["sign"]);
  } catch (error) {
    throw new CryptoError("bad-key", "The recovery signing key in the record is not a P-256 key.", { cause: error });
  } finally {
    pkcs8.fill(0);
  }
  const probe = utf8Encode("zenith/v1/recovery-signing-probe");
  if (!(await verify(input.record.signSpki, await sign(signingKey, probe), probe))) {
    throw new CryptoError("bad-key", "The recovery signing key in the record does not belong to its public key.");
  }
  return signingKey;
}

// ---------------------------------------------------------------------------- printed form

/**
 * Crockford's base32 alphabet: digits and capital letters without I, L, O and U. When reading, I and
 * L are taken as 1 and O as 0, and letters may be in either case.
 */
export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The characters after `ZNTH-`, not counting dashes: 26 base32 characters carry 130 bits. */
export const RECOVERY_CODE_CHARACTERS = 26;
/** How the 26 characters are grouped when printed. */
const GROUPS = [5, 5, 5, 5, 6] as const;
const PREFIX = "ZNTH";

/**
 * The 2 check bits that fill the 130 bits 26 characters carry: the top two bits of SHA-256 of
 * `zenith/v1/recovery-code` followed by the code. They catch about three typing mistakes in four
 * before the app even tries the code; a longer check would lengthen the printed code past the spec.
 */
async function checkBits(code: Uint8Array): Promise<number> {
  const digest = await sha256(concatBytes(utf8Encode("zenith/v1/recovery-code"), code));
  return (digest[0] ?? 0) >> 6;
}

/** The printed form of a code: `ZNTH-` then 26 Crockford base32 characters in groups of 5, 5, 5, 5 and 6. */
export async function recoveryCodeToText(code: Uint8Array): Promise<string> {
  assertCode(code);
  let value = 0n;
  for (const byte of code) value = (value << 8n) | BigInt(byte);
  value = (value << 2n) | BigInt(await checkBits(code));
  let chars = "";
  for (let i = 0; i < RECOVERY_CODE_CHARACTERS; i++) {
    chars = RECOVERY_ALPHABET[Number(value & 31n)] + chars;
    value >>= 5n;
  }
  const groups: string[] = [];
  let offset = 0;
  for (const size of GROUPS) {
    groups.push(chars.slice(offset, offset + size));
    offset += size;
  }
  return [PREFIX, ...groups].join("-");
}

const READ_AS: Record<string, string> = { O: "0", I: "1", L: "1" };

/**
 * The code in a typed or scanned recovery code. Tolerant: case does not matter, spaces, tabs and
 * dashes anywhere are ignored, the `ZNTH` prefix may be left off, and I, L and O are read as 1, 1 and
 * 0. Throws `bad-recovery-code` for the wrong number of characters, a character outside the
 * alphabet (U, for example), or check bits that do not match (a typing mistake).
 */
export async function recoveryCodeFromText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  let chars = text.toUpperCase().replace(/[\s\-‐-―]/g, "");
  if (chars.length === PREFIX.length + RECOVERY_CODE_CHARACTERS && chars.startsWith(PREFIX)) chars = chars.slice(PREFIX.length);
  if (chars.length !== RECOVERY_CODE_CHARACTERS) {
    throw new CryptoError("bad-recovery-code", `A recovery code has 26 characters after ZNTH, and this one has ${String(chars.length)}.`);
  }
  let value = 0n;
  for (const char of chars) {
    const index = RECOVERY_ALPHABET.indexOf(READ_AS[char] ?? char);
    if (index < 0) throw new CryptoError("bad-recovery-code", "A recovery code has only digits and the letters A to Z without U. Check the printed sheet again.");
    value = (value << 5n) | BigInt(index);
  }
  const check = Number(value & 3n);
  value >>= 2n;
  const code = new Uint8Array(RECOVERY_CODE_BYTES);
  for (let i = RECOVERY_CODE_BYTES - 1; i >= 0; i--) {
    code[i] = Number(value & 255n);
    value >>= 8n;
  }
  if (check !== (await checkBits(code))) throw new CryptoError("bad-recovery-code", "That recovery code has a typing mistake in it. Check each character against the printed sheet.");
  return code;
}
