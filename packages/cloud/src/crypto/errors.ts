/**
 * The one error the crypto layer throws. Every failure to open, unwrap, verify or parse comes out as a
 * `CryptoError` with a `code`, so a caller never mistakes garbage for plaintext. Messages never
 * contain plaintext, key material or ciphertext.
 */
export type CryptoErrorCode =
  /** The key, the associated data, the IV or the ciphertext is wrong: authentication failed. */
  | "decrypt-failed"
  /** The envelope or wrap has an unknown version or algorithm, or a field of the wrong type or length. */
  | "bad-envelope"
  /** The envelope names a key version other than the key it was given. */
  | "wrong-key-version"
  /** A signature did not verify against the public key it should come from. */
  | "bad-signature"
  /** A public key, fingerprint or key record is malformed, or a key cannot be used the way asked. */
  | "bad-key"
  /** An argument is not in the shape the call takes, for example an id with a `|` in it. */
  | "bad-input"
  /** A typed recovery code is the wrong length, has a character outside the alphabet, or fails its check. */
  | "bad-recovery-code"
  /** A key chain is missing a version it needs to reach the one asked for. */
  | "missing-key-version"
  /** Decompressed plaintext is larger than the limit the caller allows. */
  | "too-large"
  /** A platform feature the call needs, such as IndexedDB, is not there. */
  | "unavailable";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
    this.code = code;
  }
}

/** True when `value` is a `CryptoError`, and, when `code` is given, one with that code. */
export function isCryptoError(value: unknown, code?: CryptoErrorCode): value is CryptoError {
  return value instanceof CryptoError && (code === undefined || value.code === code);
}
