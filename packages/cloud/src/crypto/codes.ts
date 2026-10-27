/**
 * Verification codes people compare by eye (spec 14 sections 4.3 and 4.6): five groups of four
 * digits, such as `0417 2958 3361 7720 5164`. A device's code comes from its fingerprint, the SHA-256
 * of its two public keys; a team's safety code from both of its `encKey` public keys, the ECDH key
 * other teams wrap to and the signing key that vouches for the next version. Both are deterministic:
 * the same keys always give the same code, on every device.
 *
 * A code must be expensive to match on purpose. The keys behind it are ones an attacker can make as
 * many of as they like, so a server that wants a key of its own to show the same code as a real one
 * simply tries key pairs until one does. Twenty digits are about 66 bits, and each code is
 * PBKDF2-SHA-256 with 2^18 iterations (about 18 bits more), so a match costs about 2^84 hash runs.
 * The 20 digits are the first 16 bytes of the PBKDF2 output read as a big-endian unsigned number,
 * taken modulo 10^20 and written with leading zeros; the bias from the modulo is negligible.
 *
 * Codes are never stored: a pin keeps the fingerprint and the signing key, and the code is worked out
 * again whenever it is shown, so a change to how codes are made never breaks a pin.
 */
import { base64urlEncode, concatBytes, utf8Encode } from "./bytes.js";
import { deviceFingerprint } from "./device.js";
import { CryptoError } from "./errors.js";
import { subtle } from "./primitives.js";
import { checkTeamEncKey, type TeamEncKey } from "./team.js";

/** Digits in a code. SET BY HAND: 20, about 66 bits, still short enough to read out in five groups. */
export const CODE_DIGITS = 20;
const GROUP = 4;

/**
 * PBKDF2-SHA-256 iterations behind every code. SET BY HAND: 2^18, about 18 bits of work added to every
 * guess. MEASURED 16 to 29 ms per derivation at 2^17 in headless Chromium on an Intel Core Ultra 7 258V
 * (2026-10-25), so about 35 to 60 ms at 2^18 there and a few times that on a slow laptop or phone.
 */
export const CODE_KDF_ITERATIONS = 262_144;

/** The fixed salt of each kind of code, so a key ground for one kind is no use for the other. */
const SALT = {
  device: utf8Encode("zenith/v2/device-verification-code"),
  team: utf8Encode("zenith/v2/team-safety-code"),
} as const;

/** Twenty digits from the first 16 bytes of a 32-byte hash, in five groups of four. */
export function codeFromHash(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) throw new CryptoError("bad-key", "A code is made from 32 bytes.");
  let value = 0n;
  for (const byte of hash.subarray(0, 16)) value = (value << 8n) | BigInt(byte);
  const digits = (value % 10n ** BigInt(CODE_DIGITS)).toString().padStart(CODE_DIGITS, "0");
  const groups: string[] = [];
  for (let at = 0; at < CODE_DIGITS; at += GROUP) groups.push(digits.slice(at, at + GROUP));
  return groups.join(" ");
}

/**
 * Codes already worked out on this page, by kind and input. Each one costs a slow derivation, and a
 * list of a team's devices shows the same codes on every refresh. Kept small; a miss only costs time.
 */
const known = new Map<string, Promise<string>>();
const KNOWN_LIMIT = 256;

async function slowCode(kind: keyof typeof SALT, input: Uint8Array): Promise<string> {
  const id = `${kind}:${base64urlEncode(input)}`;
  const cached = known.get(id);
  if (cached !== undefined) return cached;
  const made = (async () => {
    const base = await subtle().importKey("raw", input as Uint8Array<ArrayBuffer>, "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: SALT[kind], iterations: CODE_KDF_ITERATIONS }, base, 256);
    return codeFromHash(new Uint8Array(bits));
  })();
  if (known.size >= KNOWN_LIMIT) known.clear();
  known.set(id, made);
  made.catch(() => known.delete(id));
  return made;
}

/** The code shown for a device on the approver's sheet and on the device itself. */
export async function deviceVerificationCode(encSpki: Uint8Array, signSpki: Uint8Array): Promise<string> {
  return slowCode("device", await deviceFingerprint(encSpki, signSpki));
}

/**
 * The team safety code two teams compare, from the team's `encKey` (checked first): twenty digits of
 * PBKDF2-SHA-256 of the ECDH fingerprint and the signing SPKI. Covering the signing key matters: a
 * partner that trusted a signing key the server made up would then take any "rotation" the server
 * signs. Changes when the key rotates.
 */
export async function teamSafetyCode(encKey: TeamEncKey): Promise<string> {
  await checkTeamEncKey(encKey);
  return safetyCodeOfKeys(encKey.fingerprint, encKey.signSpki);
}

/**
 * The same code from the two parts it covers alone: the 32-byte ECDH fingerprint and the signing
 * SPKI. For a key this device pinned earlier, which keeps only those, so it can show the code of the
 * key it trusts rather than of the key the server shows now. The caller checked the key when it
 * pinned it.
 */
export async function safetyCodeOfKeys(fingerprint: Uint8Array, signSpki: Uint8Array): Promise<string> {
  return slowCode("team", concatBytes(fingerprint, signSpki));
}
