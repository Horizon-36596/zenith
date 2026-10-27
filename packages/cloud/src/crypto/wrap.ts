/**
 * Wrapping a secret to a P-256 public key, the ECIES of spec 14 section 4.1: a fresh ephemeral P-256
 * key pair, ECDH with the recipient's public key, HKDF-SHA-256 with the ephemeral public key as the
 * salt and the AAD text as the info, then AES-256-GCM with the same AAD. Used for key grants to
 * devices, share keys to teams and the team key to the recovery key.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { toBytes } from "./bytes.js";
import type { Aad } from "./aad.js";
import { CryptoError } from "./errors.js";
import { aesOpen, aesSeal, hkdfAesKey, isBytes, IV_BYTES, subtle, TAG_BYTES } from "./primitives.js";

/** The wrap format version this code writes and reads: P-256 ECDH, HKDF-SHA-256, AES-256-GCM. */
export const WRAP_VERSION = 1;
/** An uncompressed P-256 public point, bytes: 0x04, then x and y of 32 bytes each. */
export const P256_POINT_BYTES = 65;
/** A P-256 public key in SPKI form as WebCrypto exports it, bytes. */
export const P256_SPKI_BYTES = 91;

/**
 * A secret wrapped to one public key. `epk` is the ephemeral public key as a 65-byte uncompressed
 * point; `iv` is 12 bytes; `ct` is the secret plus a 16-byte tag. A 32-byte key wraps to 125 bytes.
 */
export interface PublicKeyWrap {
  v: typeof WRAP_VERSION;
  epk: Uint8Array;
  iv: Uint8Array;
  ct: Uint8Array;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** Imports a P-256 SPKI as an ECDH public key, throwing `bad-key` when it is not one. */
export async function importEcdhPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  if (!isBytes(spki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-key", "A P-256 public key must be a 91-byte SPKI.");
  try {
    return await subtle().importKey("spki", toBytes(spki), ECDH, true, []);
  } catch (error) {
    throw new CryptoError("bad-key", "That public key is not a valid P-256 key.", { cause: error });
  }
}

async function wrapKey(privateKey: CryptoKey, publicKey: CryptoKey, epk: Uint8Array, aad: Aad): Promise<CryptoKey> {
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    return await hkdfAesKey(shared, epk, aad);
  } finally {
    shared.fill(0);
  }
}

/** Checks the shape of a wrap read from the server, throwing `bad-envelope` for anything unknown. */
export function assertPublicKeyWrap(value: unknown): asserts value is PublicKeyWrap {
  if (typeof value !== "object" || value === null) throw new CryptoError("bad-envelope", "The wrapped key is missing.");
  const wrap = value as Partial<Record<keyof PublicKeyWrap, unknown>>;
  if (wrap.v !== WRAP_VERSION) throw new CryptoError("bad-envelope", "The wrapped key uses a version this app does not know. Update Zenith.");
  if (!isBytes(wrap.epk, { exactly: P256_POINT_BYTES })) throw new CryptoError("bad-envelope", "The wrapped key's ephemeral public key is not 65 bytes.");
  if (!isBytes(wrap.iv, { exactly: IV_BYTES })) throw new CryptoError("bad-envelope", "The wrapped key's IV is not 12 bytes.");
  if (!isBytes(wrap.ct, { min: TAG_BYTES })) throw new CryptoError("bad-envelope", "The wrapped key's ciphertext is shorter than its tag.");
}

/**
 * `secret` wrapped to the P-256 public key `recipientSpki` (91-byte SPKI), bound to `aad`. A new
 * ephemeral key pair is made for every wrap. `random` supplies only the IV.
 */
export async function wrapToPublicKey(recipientSpki: Uint8Array, secret: Uint8Array, aad: Aad, random: RandomBytes = cryptoRandomBytes): Promise<PublicKeyWrap> {
  const recipient = await importEcdhPublicKey(recipientSpki);
  const ephemeral = await subtle().generateKey(ECDH, false, ["deriveBits"]);
  const epk = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey));
  const key = await wrapKey(ephemeral.privateKey, recipient, epk, aad);
  const { iv, ct } = await aesSeal(key, secret, aad, random);
  return { v: WRAP_VERSION, epk, iv, ct };
}

/**
 * The secret in `wrap`, unwrapped with the recipient's ECDH private key. Throws `bad-envelope` for
 * an unknown version or a malformed field, and `decrypt-failed` for the wrong private key, the wrong
 * AAD, or a changed ephemeral key, IV or ciphertext.
 */
export async function unwrapWithPrivateKey(privateKey: CryptoKey, wrap: PublicKeyWrap, aad: Aad): Promise<Uint8Array<ArrayBuffer>> {
  assertPublicKeyWrap(wrap);
  let key: CryptoKey;
  try {
    const ephemeral = await subtle().importKey("raw", toBytes(wrap.epk), ECDH, false, []);
    key = await wrapKey(privateKey, ephemeral, wrap.epk, aad);
  } catch (error) {
    throw new CryptoError("decrypt-failed", "The wrapped key could not be opened: it was changed, or it is for another key.", { cause: error });
  }
  return aesOpen(key, wrap.iv, wrap.ct, aad);
}
