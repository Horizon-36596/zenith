/**
 * The approval code a new device shows while it waits for the team key, and the approver types
 * (spec 14, sections 4.3 and 4.4). It is 18 Crockford base32 characters in three groups of six, such
 * as `7K2QXD-M9A1RT-4ZC8PW`, and has two parts:
 *
 * - the last 8 characters (40 bits) are random, the code's secret, made on the new device and never
 *   sent anywhere. The approver's device derives a key from them with PBKDF2-SHA-256
 *   (`APPROVAL_KDF_ITERATIONS`) and puts an HMAC-SHA-256 under that key on the grant. The new device
 *   accepts its first grant for a team only when that MAC checks, so a team key the server made up,
 *   which it could otherwise grant to a new device, is refused;
 * - the first 10 characters (50 bits), the device part, are a hash of the team, the member's uid,
 *   the secret and the device's fingerprint (the SHA-256 of its two public keys). The approving
 *   device recomputes them from the device record it is about to grant to and the secret that was
 *   typed, and refuses the code when they differ. Because the secret is in the hash and the server
 *   never sees it, the server cannot search for a device record of its own that matches a code: a
 *   record it slips in is accepted only by chance, once in 2^50, and each try needs someone to type
 *   a code. Because the team and uid are in it too, one code never matches another team's or
 *   member's request. A typo anywhere in the code is caught the same way.
 *
 * The MAC covers a commitment to the raw team key (a SHA-256 of it), so only a holder of the team key
 * can test a guess of the secret against a grant, and each guess costs one PBKDF2 run. It also covers
 * the digest of that key version's device roster, so a new device takes the roster the approver
 * checked, not one a member who holds the key made up with the server. The device
 * part is never stored or sent, so nobody can test a guess against it who has not seen the whole
 * code. The code is used once: the new device forgets it when a grant is accepted or its request is
 * withdrawn.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { base64urlEncode, concatBytes, toBytes, utf8Encode } from "./bytes.js";
import { idPart, uidPart, versionPart } from "./aad.js";
import { CryptoError } from "./errors.js";
import { exportAesKey, isBytes, sha256, subtle, take } from "./primitives.js";
import type { TeamKey } from "./team.js";

/** Crockford's base32 alphabet, as the recovery code uses: digits and capitals without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The characters in an approval code, not counting the dashes between groups. SPEC: 18, three groups of 6. */
export const APPROVAL_CODE_CHARACTERS = 18;
/**
 * The device part: 10 characters, 50 bits, hashed from the team, the uid, the secret and the
 * device's fingerprint. (Named "public" before the secret was hashed into it.) SPEC.
 */
export const APPROVAL_PUBLIC_CHARACTERS = 10;
/** The random characters only the new device knows: 8, which is 40 bits. SPEC. */
export const APPROVAL_SECRET_CHARACTERS = 8;
/** The random part as bytes: 40 bits. */
export const APPROVAL_SECRET_BYTES = 5;
/**
 * PBKDF2-SHA-256 iterations for the key the MAC is made with. SET BY HAND: 600,000 is OWASP's 2023
 * figure for PBKDF2-HMAC-SHA256. MEASURED 298 to 384 ms per derivation, median 343 ms over 7 runs, in
 * Node 22.22.2 on a 4-core Intel Xeon at 2.80 GHz (2026-09-28); the approver and the new device each
 * derive it once per approval.
 */
export const APPROVAL_KDF_ITERATIONS = 600_000;
/** An approval MAC, bytes: HMAC-SHA-256. */
export const APPROVAL_MAC_BYTES = 32;

const GROUP = 6;
const READ_AS: Record<string, string> = { O: "0", I: "1", L: "1" };

/**
 * A typed approval code with case, spaces and dashes sorted out: capitals only, every space, dash,
 * underscore and full stop removed, and O, I and L read as 0, 1 and 1. Tolerant: it never throws, and
 * the result is only a valid code when it has 18 characters, all in the alphabet.
 */
export function normaliseApprovalCode(text: string): string {
  return String(text)
    .toUpperCase()
    .replace(/[\s\-‐-―_.]/g, "")
    .replace(/[OIL]/g, (char) => READ_AS[char] ?? char);
}

/** An approval code in the groups a screen shows it in: `XXXXXX-XXXXXX-XXXXXX`. Normalises first. */
export function formatApprovalCode(text: string): string {
  const clean = normaliseApprovalCode(text);
  const groups: string[] = [];
  for (let offset = 0; offset < clean.length; offset += GROUP) groups.push(clean.slice(offset, offset + GROUP));
  return groups.join("-");
}

/** True when `normalised` (from `normaliseApprovalCode`) is 18 characters of the alphabet. */
function isApprovalCode(normalised: string): boolean {
  if (normalised.length !== APPROVAL_CODE_CHARACTERS) return false;
  for (const char of normalised) if (!ALPHABET.includes(char)) return false;
  return true;
}

/** `bits` from the start of `bytes`, big-endian, as base32 characters (`bits` a multiple of 5). */
function base32(bytes: Uint8Array, bits: number): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value >>= BigInt(bytes.byteLength * 8 - bits);
  let out = "";
  for (let i = 0; i < bits / 5; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Whom a code is for: one device of one member, waiting in one team. */
export interface ApprovalCodeSubject {
  teamId: string;
  uid: string;
  /** The device's 32-byte fingerprint. */
  fingerprint: Uint8Array;
}

/**
 * The device part of an approval code, its first 10 characters: the top 50 bits of SHA-256 of the
 * text `zenith/v1/approval-code|team=<teamId>|uid=<uid as base64url of its UTF-8>`, a zero byte, the
 * 5-byte secret and the device's 32-byte fingerprint.
 */
export async function approvalPublicPart(subject: ApprovalCodeSubject, secret: Uint8Array): Promise<string> {
  if (!isBytes(subject.fingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  if (!isBytes(secret, { exactly: APPROVAL_SECRET_BYTES })) throw new CryptoError("bad-input", "An approval code's random part must be 5 bytes.");
  const label = ["zenith/v1/approval-code", idPart("team", subject.teamId), uidPart(subject.uid)].join("|");
  const digest = await sha256(concatBytes(utf8Encode(label), new Uint8Array([0]), secret, subject.fingerprint));
  return base32(digest, APPROVAL_PUBLIC_CHARACTERS * 5);
}

/** A new random part: 5 bytes. */
export function newApprovalSecret(random: RandomBytes = cryptoRandomBytes): Uint8Array<ArrayBuffer> {
  return take(random, APPROVAL_SECRET_BYTES);
}

/** The code a waiting device shows: its device part and `secret`, formatted. */
export async function approvalCodeFor(subject: ApprovalCodeSubject, secret: Uint8Array): Promise<string> {
  return formatApprovalCode((await approvalPublicPart(subject, secret)) + base32(secret, APPROVAL_SECRET_CHARACTERS * 5));
}

/**
 * The random part of a typed code, when the code is well formed and its device part is the one
 * `subject` and that random part give; otherwise null. The approving device calls it with the team,
 * the uid and the fingerprint of the device record it is about to grant to.
 */
export async function approvalSecretFrom(text: string, subject: ApprovalCodeSubject): Promise<Uint8Array<ArrayBuffer> | null> {
  const clean = normaliseApprovalCode(text);
  if (!isApprovalCode(clean)) return null;
  let value = 0n;
  for (const char of clean.slice(APPROVAL_PUBLIC_CHARACTERS)) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  const secret = new Uint8Array(APPROVAL_SECRET_BYTES);
  for (let i = APPROVAL_SECRET_BYTES - 1; i >= 0; i--) {
    secret[i] = Number(value & 255n);
    value >>= 8n;
  }
  if (clean.slice(0, APPROVAL_PUBLIC_CHARACTERS) !== (await approvalPublicPart(subject, secret))) return null;
  return secret;
}

/**
 * The HMAC-SHA-256 key for one device's approval into one team: PBKDF2-SHA-256 of the random part,
 * salted with `zenith/v1/approval-salt|team=|device=`, `iterations` times. Tests may pass fewer
 * iterations; the app always uses `APPROVAL_KDF_ITERATIONS`.
 */
export async function approvalKey(input: { teamId: string; deviceId: string; secret: Uint8Array; iterations?: number }): Promise<CryptoKey> {
  if (!isBytes(input.secret, { exactly: APPROVAL_SECRET_BYTES })) throw new CryptoError("bad-input", "An approval code's random part must be 5 bytes.");
  const iterations = input.iterations ?? APPROVAL_KDF_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new CryptoError("bad-input", "PBKDF2 needs a whole number of iterations.");
  const salt = utf8Encode(["zenith/v1/approval-salt", idPart("team", input.teamId), idPart("device", input.deviceId)].join("|"));
  const base = await subtle().importKey("raw", toBytes(input.secret), "PBKDF2", false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
  try {
    return await subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  } finally {
    raw.fill(0);
  }
}

/** What an approval MAC covers: who is approved into which team, and which team keys they get. */
export interface ApprovalSubject {
  teamId: string;
  deviceId: string;
  uid: string;
  /** Team key `kv`, opened as extractable: its commitment is covered. */
  teamKey: TeamKey;
  /** The fingerprint of team key pair `kv`'s public half (its `encKey` fingerprint). */
  encFingerprint: Uint8Array;
  /** Team key version `kv`'s 91-byte signing public key. */
  signSpki: Uint8Array;
  /**
   * The 32-byte digest of team key version `kv`'s sealed device roster (`rosterDigest` in
   * keys/roster.ts), which the approver checked. The new device has no roster of its own to check
   * it against, so this is how it knows the roster it is shown is the approver's.
   */
  rosterDigest: Uint8Array;
}

/**
 * The exact bytes an approval MAC is made over: the text
 * `zenith/v1/approval-mac|team=|device=|uid=|kv=`, a zero byte, the pair's fingerprint (32 bytes), the
 * signing key (91 bytes), SHA-256 of `zenith/v1/team-key-commitment`, a zero byte and the raw team key
 * (32 bytes), then the roster digest (32 bytes).
 */
async function approvalMacBytes(subject: ApprovalSubject): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBytes(subject.encFingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  if (!isBytes(subject.signSpki, { min: 1 })) throw new CryptoError("bad-key", "A team signing key is missing.");
  if (!isBytes(subject.rosterDigest, { exactly: 32 })) throw new CryptoError("bad-key", "A roster digest must be 32 bytes.");
  if (typeof subject.uid !== "string" || subject.uid.length === 0 || subject.uid.length > 128) throw new CryptoError("bad-input", "A uid must have 1 to 128 characters.");
  const label = [
    "zenith/v1/approval-mac",
    idPart("team", subject.teamId),
    idPart("device", subject.deviceId),
    `uid=${base64urlEncode(utf8Encode(subject.uid))}`,
    versionPart("kv", subject.teamKey.version),
  ].join("|");
  const raw = await exportAesKey(subject.teamKey.key);
  let commitment: Uint8Array;
  try {
    commitment = await sha256(concatBytes(utf8Encode("zenith/v1/team-key-commitment"), new Uint8Array([0]), raw));
  } finally {
    raw.fill(0);
  }
  return concatBytes(utf8Encode(label), new Uint8Array([0]), subject.encFingerprint, subject.signSpki, commitment, subject.rosterDigest);
}

/** The approval MAC for `subject` under `key` (from `approvalKey`): 32 bytes. */
export async function makeApprovalMac(key: CryptoKey, subject: ApprovalSubject): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().sign("HMAC", key, await approvalMacBytes(subject)));
}

/** True when `mac` is the approval MAC for `subject` under `key`. Compared in constant time by WebCrypto. */
export async function checkApprovalMac(key: CryptoKey, subject: ApprovalSubject, mac: Uint8Array): Promise<boolean> {
  if (!isBytes(mac, { exactly: APPROVAL_MAC_BYTES })) return false;
  return subtle().verify("HMAC", key, toBytes(mac), await approvalMacBytes(subject));
}
