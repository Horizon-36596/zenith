/**
 * The envelope every piece of Zenith ciphertext is stored in (spec 14 section 4.1):
 * `{ v: 1, alg: "A256GCM", kv, iv, ct }`, AES-256-GCM under a team or share key, with a fresh 12-byte
 * IV per seal and the document's path and purpose as associated data. `iv` and `ct` are `Uint8Array`;
 * the Firestore store turns them into `Bytes`.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { utf8Decode, utf8Encode } from "./bytes.js";
import { isKeyVersion, type Aad } from "./aad.js";
import { CryptoError } from "./errors.js";
import { aesOpen, aesSeal, isBytes, IV_BYTES, TAG_BYTES } from "./primitives.js";

/** The envelope format version this code writes and reads. */
export const ENVELOPE_VERSION = 1;
/** The one algorithm version 1 envelopes use: AES-256-GCM with a 12-byte IV and a 16-byte tag. */
export const ENVELOPE_ALG = "A256GCM";

/**
 * A sealed value. `kv` is the version of the key that sealed it (a team key version, or a share key
 * version, which is always 1 for a link share); `iv` is 12 bytes; `ct` is the ciphertext followed by
 * the 16-byte tag, so it is 16 bytes longer than the (compressed, for text and JSON) plaintext.
 */
export interface Envelope {
  v: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  kv: number;
  iv: Uint8Array;
  ct: Uint8Array;
}

/** A symmetric AES-256-GCM key and its version: a team key, a share key or a link key. */
export interface VersionedKey {
  /** Whole number from 1. */
  readonly version: number;
  readonly key: CryptoKey;
}

/**
 * The most bytes of plaintext `openText` and `openJson` will decompress to unless told otherwise:
 * 8 MiB. SET BY HAND: eight times the 1,000,000-byte cap on a stored projection or diff, well above
 * the three- to four-fold gzip ratio measured on real autos, so it only stops a compression bomb.
 */
export const DEFAULT_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

/** Checks the shape of an envelope read from the server, throwing `bad-envelope` for anything unknown. */
export function assertEnvelope(value: unknown): asserts value is Envelope {
  if (typeof value !== "object" || value === null) throw new CryptoError("bad-envelope", "The encrypted value is missing or is not an envelope.");
  const envelope = value as Partial<Record<keyof Envelope, unknown>>;
  if (envelope.v !== ENVELOPE_VERSION) throw new CryptoError("bad-envelope", "The encrypted value uses an envelope version this app does not know. Update Zenith.");
  if (envelope.alg !== ENVELOPE_ALG) throw new CryptoError("bad-envelope", "The encrypted value uses an algorithm this app does not know. Update Zenith.");
  if (!isKeyVersion(envelope.kv)) throw new CryptoError("bad-envelope", "The encrypted value names no valid key version.");
  if (!isBytes(envelope.iv, { exactly: IV_BYTES })) throw new CryptoError("bad-envelope", "The encrypted value's IV is not 12 bytes.");
  if (!isBytes(envelope.ct, { min: TAG_BYTES })) throw new CryptoError("bad-envelope", "The encrypted value's ciphertext is shorter than its tag.");
}

/** Seals `plaintext` under `key` with a fresh random IV; `kv` is `key.version`. */
export async function sealBytes(key: VersionedKey, plaintext: Uint8Array, aad: Aad, random: RandomBytes = cryptoRandomBytes): Promise<Envelope> {
  if (!isKeyVersion(key.version)) throw new CryptoError("bad-input", "A key version must be a whole number from 1.");
  const { iv, ct } = await aesSeal(key.key, plaintext, aad, random);
  return { v: ENVELOPE_VERSION, alg: ENVELOPE_ALG, kv: key.version, iv, ct };
}

/**
 * The plaintext of `envelope`. Throws `bad-envelope` for an unknown version or algorithm or a
 * malformed field, `wrong-key-version` when `envelope.kv` is not `key.version`, and
 * `decrypt-failed` for a wrong key, wrong AAD, or a changed IV or ciphertext.
 */
export async function openBytes(key: VersionedKey, envelope: Envelope, aad: Aad): Promise<Uint8Array<ArrayBuffer>> {
  assertEnvelope(envelope);
  if (envelope.kv !== key.version) {
    throw new CryptoError("wrong-key-version", `This was sealed with key version ${String(envelope.kv)}, not ${String(key.version)}.`);
  }
  return aesOpen(key.key, envelope.iv, envelope.ct, aad);
}

async function pipe(bytes: Uint8Array, transform: ReadableWritablePair<Uint8Array, Uint8Array>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CryptoError("too-large", `The decrypted data is larger than ${String(maxBytes)} bytes, the most this call accepts.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `bytes` compressed with gzip (CompressionStream). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return pipe(bytes, new CompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>, Number.MAX_SAFE_INTEGER);
}

/** `bytes` decompressed with gzip (DecompressionStream), stopping with `too-large` past `maxBytes`. */
export async function gunzip(bytes: Uint8Array, maxBytes = DEFAULT_MAX_PLAINTEXT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await pipe(bytes, new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>, maxBytes);
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError("bad-envelope", "The decrypted data is not gzip, which a sealed text or JSON value must be.", { cause: error });
  }
}

/** Options for opening text or JSON. */
export interface OpenOptions {
  /** The most bytes of decompressed plaintext to accept. Default `DEFAULT_MAX_PLAINTEXT_BYTES`. */
  maxBytes?: number;
}

/** Seals `text` as gzip-compressed UTF-8. Use this for values that are already JSON strings, such as a revision's `content`. */
export async function sealText(key: VersionedKey, text: string, aad: Aad, random: RandomBytes = cryptoRandomBytes): Promise<Envelope> {
  return sealBytes(key, await gzip(utf8Encode(text)), aad, random);
}

/** The text a `sealText` envelope holds. Throws as `openBytes` does, and `too-large` or `bad-envelope` for bad gzip. */
export async function openText(key: VersionedKey, envelope: Envelope, aad: Aad, options: OpenOptions = {}): Promise<string> {
  return utf8Decode(await gunzip(await openBytes(key, envelope, aad), options.maxBytes));
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` as JSON with every object's keys sorted and no whitespace, so one value always gives one
 * text. `undefined` object members are left out, as `JSON.stringify` does. Throws `bad-input` for a
 * number that is not finite, and for anything JSON cannot hold, including a `Date`, a
 * `Uint8Array` or any other object that is not a plain object or an array. This is not spec 02's canonical auto form;
 * seal an auto file's canonical text with `sealText`.
 */
export function sortedJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CryptoError("bad-input", "JSON cannot hold a number that is not finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => sortedJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(",")}}`;
  }
  throw new CryptoError("bad-input", "Only JSON values can be sealed as JSON.");
}

/** Seals `value` as gzip-compressed sorted JSON (`sortedJson`). */
export async function sealJson(key: VersionedKey, value: unknown, aad: Aad, random: RandomBytes = cryptoRandomBytes): Promise<Envelope> {
  return sealText(key, sortedJson(value), aad, random);
}

/** The value a `sealJson` envelope holds. Throws as `openText` does, and `bad-envelope` when the text is not JSON. */
export async function openJson<T = unknown>(key: VersionedKey, envelope: Envelope, aad: Aad, options: OpenOptions = {}): Promise<T> {
  const text = await openText(key, envelope, aad, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    // No cause: a SyntaxError's message quotes the text it failed on, which is plaintext.
    throw new CryptoError("bad-envelope", "The decrypted data is not JSON.");
  }
}
