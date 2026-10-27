/**
 * Byte helpers the crypto layer shares: base64url without padding, UTF-8, and copying any buffer view
 * into a plain `Uint8Array`. Nothing here knows about Firestore; the store converts its own `Bytes`
 * type to and from `Uint8Array` at its edge.
 */
import { CryptoError } from "./errors.js";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUE = new Map<string, number>([...BASE64URL].map((char, index) => [char, index]));

/**
 * A fresh `Uint8Array` backed by its own `ArrayBuffer`, copied from any buffer or view. WebCrypto
 * takes this type, and copying means a caller who later changes its array cannot change ours.
 */
export function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/** `bytes` as base64url (RFC 4648 section 5) without `=` padding. 16 bytes give 22 characters. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let held = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    held += 8;
    while (held >= 6) {
      held -= 6;
      out += BASE64URL[(buffer >> held) & 63];
    }
  }
  if (held > 0) out += BASE64URL[(buffer << (6 - held)) & 63];
  return out;
}

/**
 * The bytes a base64url string holds. Strict, so each byte string has exactly one text: padding,
 * whitespace, characters outside the alphabet, a length that cannot come from whole bytes (a
 * remainder of 1 after dividing by 4), and unused low bits that are not zero all throw `bad-input`.
 */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 4 === 1) throw new CryptoError("bad-input", "That base64url text has a length no bytes can have.");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let held = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE64URL_VALUE.get(char);
    if (value === undefined) throw new CryptoError("bad-input", "That text has a character that is not base64url.");
    buffer = ((buffer << 6) | value) & 0xffff;
    held += 6;
    if (held >= 8) {
      held -= 8;
      out[index++] = (buffer >> held) & 0xff;
    }
  }
  if ((buffer & ((1 << held) - 1)) !== 0) {
    throw new CryptoError("bad-input", "That base64url text is not in its one canonical form: its last character has unused bits set.");
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** `text` as UTF-8 bytes. */
export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** UTF-8 `bytes` as text. Invalid UTF-8 throws `bad-input` rather than turning into replacement characters. */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new CryptoError("bad-input", "Those bytes are not valid UTF-8 text.", { cause: error });
  }
}

/** The parts one after another, in a new array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** True when the two arrays hold the same bytes. Takes the same time for any two arrays of one length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
