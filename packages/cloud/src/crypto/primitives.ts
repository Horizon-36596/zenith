/**
 * The WebCrypto calls the rest of the layer shares, kept in one place so each is spelled once:
 * random bytes, AES-256-GCM, HKDF-SHA-256 and SHA-256. Internal; the entry point does not export it.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { toBytes, utf8Encode } from "./bytes.js";
import { CryptoError } from "./errors.js";

export { cryptoRandomBytes, type RandomBytes };

/** AES-GCM IV length, bytes (96 bits, the length MDN and NIST recommend). */
export const IV_BYTES = 12;
/** AES-GCM authentication tag length, bytes. */
export const TAG_BYTES = 16;
/** An AES-256 key, bytes. */
export const AES_KEY_BYTES = 32;

export function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (value === undefined) throw new CryptoError("unavailable", "This platform has no WebCrypto (crypto.subtle), which Zenith needs to encrypt.");
  return value;
}

/** Exactly `length` bytes from `random`, copied, so an injected source cannot hand back a short or shared array. */
export function take(random: RandomBytes, length: number): Uint8Array<ArrayBuffer> {
  const bytes = random(length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new CryptoError("bad-input", `The random source must return exactly ${String(length)} bytes.`);
  }
  return toBytes(bytes);
}

/** Imports 32 raw bytes as an AES-256-GCM key for encrypt and decrypt. */
export async function importAesKey(raw: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  if (raw.byteLength !== AES_KEY_BYTES) throw new CryptoError("bad-key", "An AES-256 key must be exactly 32 bytes.");
  return subtle().importKey("raw", toBytes(raw), { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}

/** The 32 raw bytes of an extractable AES key. Throws `bad-key` when the key is not extractable. */
export async function exportAesKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  if (!key.extractable) {
    throw new CryptoError("bad-key", "This key was opened for everyday use and cannot be wrapped again; open it as extractable to approve or rotate.");
  }
  return new Uint8Array(await subtle().exportKey("raw", key));
}

/** AES-256-GCM encryption with a fresh random IV. Returns the IV and the ciphertext with its 16-byte tag. */
export async function aesSeal(key: CryptoKey, plaintext: Uint8Array, aad: string, random: RandomBytes): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const iv = take(random, IV_BYTES);
  try {
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: utf8Encode(aad), tagLength: TAG_BYTES * 8 }, key, toBytes(plaintext)));
    return { iv, ct };
  } catch (error) {
    throw new CryptoError("bad-key", "That key cannot encrypt with AES-GCM.", { cause: error });
  }
}

/** AES-256-GCM decryption. Any authentication failure throws `decrypt-failed`, never returns bytes. */
export async function aesOpen(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: toBytes(iv), additionalData: utf8Encode(aad), tagLength: TAG_BYTES * 8 }, key, toBytes(ct)));
  } catch (error) {
    throw new CryptoError("decrypt-failed", "The data could not be decrypted: the key is wrong, or the data was changed or moved.", { cause: error });
  }
}

/** HKDF-SHA-256 (RFC 5869) of `ikm` with `salt` and `info`, `bits` long. */
export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await subtle().importKey("raw", toBytes(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: toBytes(salt), info: utf8Encode(info) }, base, bits));
}

/**
 * An AES-256-GCM key from HKDF-SHA-256 of `ikm`, with `salt` as the salt and `info` as the info. The
 * key is never extractable. Derived with deriveBits and imported, which every engine spec 14 section
 * 3 lists supports (Firefox only derives into an HKDF key from 119, which this avoids).
 */
export async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const raw = await hkdfBits(ikm, salt, info, AES_KEY_BYTES * 8);
  try {
    return await importAesKey(raw, false);
  } finally {
    raw.fill(0);
  }
}

/** SHA-256 of `bytes`, 32 bytes. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().digest("SHA-256", toBytes(bytes)));
}

/** True when `value` is a `Uint8Array` of exactly `length` bytes, or of at least `min` bytes. */
export function isBytes(value: unknown, length?: { exactly?: number; min?: number }): value is Uint8Array {
  if (!(value instanceof Uint8Array)) return false;
  if (length?.exactly !== undefined && value.byteLength !== length.exactly) return false;
  if (length?.min !== undefined && value.byteLength < length.min) return false;
  return true;
}
