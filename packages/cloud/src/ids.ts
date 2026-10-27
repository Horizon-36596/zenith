/**
 * Ids made on the client. Invite codes, share ids, team ids and dispute ids carry 128 random bits
 * (spec 13 sections 8.5 and 13), written as 22 base64url characters, which is what the rules require.
 */

/** Fills a byte array with random bytes. Injected so tests can be deterministic. */
export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `bits` random bits as base64url without padding. 128 bits gives 22 characters. */
export function randomId(random: RandomBytes, bits = 128): string {
  const bytes = random(Math.ceil(bits / 8));
  let out = "";
  let buffer = 0;
  let held = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    held += 8;
    while (held >= 6) {
      held -= 6;
      out += BASE64URL[(buffer >> held) & 63];
    }
  }
  if (held > 0) out += BASE64URL[(buffer << (6 - held)) & 63];
  return out;
}

/** A revision's document id: `n` zero-padded to six digits, a hyphen and 64 random bits. */
export function revisionId(n: number, random: RandomBytes): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) {
    throw new RangeError(`A revision number must be a whole number from 1 to 999999, not ${String(n)}.`);
  }
  return `${String(n).padStart(6, "0")}-${randomId(random, 64)}`;
}

/** The revision number written in a revision id. */
export function revisionNumber(id: string): number {
  return Number.parseInt(id.slice(0, 6), 10);
}
