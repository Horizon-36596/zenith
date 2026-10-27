/**
 * Share keys and link secrets (spec 14 sections 4.6 and 4.7). A share to teams has a random 256-bit
 * share key, wrapped to each recipient team's `encKey` in `keyWraps` and sealed under the owner
 * team's key in `ownerWrap`. A link share has one 128-bit secret S, carried in the link's `#`
 * fragment as 22 base64url characters; the stored share id and the share key are both derived from
 * S with HKDF, so the server, which sees only the id, can never get the key.
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { base64urlDecode, base64urlEncode, bytesEqual } from "./bytes.js";
import { aadFor, isKeyVersion } from "./aad.js";
import { openBytes, sealBytes, type Envelope, type VersionedKey } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { shareKeyCommitment } from "./manifest.js";
import { AES_KEY_BYTES, exportAesKey, hkdfAesKey, hkdfBits, importAesKey, isBytes, take } from "./primitives.js";
import { checkTeamEncKey, type TeamEncKey, type TeamKey, type TeamKeyPair } from "./team.js";
import { assertPublicKeyWrap, unwrapWithPrivateKey, wrapToPublicKey, type PublicKeyWrap } from "./wrap.js";

/** A share key: AES-256-GCM and its version (from 1; a new one is made when a team is taken off the share). */
export type ShareKey = VersionedKey;

/**
 * `keyWraps.<teamId>` on a share: the share key wrapped to that team's `encKey`. `ekv` is the
 * `encKey` version it was wrapped to, so the recipient knows which of its team key pairs opens it.
 */
export interface ShareKeyWrap extends PublicKeyWrap {
  ekv: number;
}

/** A new share key of `version` (default 1), extractable so it can be wrapped. `random` supplies the key. */
export async function newShareKey(version = 1, random: RandomBytes = cryptoRandomBytes): Promise<ShareKey> {
  if (!isKeyVersion(version)) throw new CryptoError("bad-input", "A share key version must be a whole number from 1.");
  const raw = take(random, AES_KEY_BYTES);
  try {
    return { version, key: await importAesKey(raw, true) };
  } finally {
    raw.fill(0);
  }
}

/** `shareKey` (extractable) wrapped to recipient team `teamId`'s `encKey`, checked first. */
export async function wrapShareKeyToTeam(input: { shareId: string; teamId: string; shareKey: ShareKey; encKey: TeamEncKey; random?: RandomBytes }): Promise<ShareKeyWrap> {
  await checkTeamEncKey(input.encKey);
  const raw = await exportAesKey(input.shareKey.key);
  try {
    const aad = aadFor.shareWrap({ shareId: input.shareId, teamId: input.teamId, kv: input.shareKey.version, ekv: input.encKey.v });
    return { ...(await wrapToPublicKey(input.encKey.spki, raw, aad, input.random ?? cryptoRandomBytes)), ekv: input.encKey.v };
  } finally {
    raw.fill(0);
  }
}

/**
 * Throws `bad-key` unless `raw` is the share key `commit` (from the share's signed manifest) commits
 * to. Anyone can wrap a key to a team's public key, so a wrap that opens proves only that someone
 * made it; the commitment, signed by the owner team, proves which key the owner team made.
 */
async function assertCommitted(shareId: string, skv: number, raw: Uint8Array, commit: Uint8Array | undefined): Promise<void> {
  if (commit === undefined) return;
  if (!bytesEqual(await shareKeyCommitment({ shareId, skv, raw }), commit)) {
    throw new CryptoError("bad-key", "This share key is not the one the share's signed manifest names.");
  }
}

/**
 * Share key `shareKeyVersion` (the `kv` of the projection it opens) from `keyWraps.<teamId>`, with
 * the team's key pair of version `wrap.ekv` (from `openChain`). With `commit`, the commitment in the
 * share's verified manifest, the key must be the one it names (`bad-key` otherwise); every device
 * that trusts the key passes it. Throws `wrong-key-version` for another pair, `decrypt-failed` for
 * anything changed.
 */
export async function unwrapShareKeyAsTeam(input: { shareId: string; teamId: string; shareKeyVersion: number; wrap: ShareKeyWrap; pair: TeamKeyPair; extractable?: boolean; commit?: Uint8Array }): Promise<ShareKey> {
  assertPublicKeyWrap(input.wrap);
  if (!isKeyVersion(input.wrap.ekv)) throw new CryptoError("bad-envelope", "The share key wrap names no valid team key version.");
  if (input.wrap.ekv !== input.pair.version) {
    throw new CryptoError("wrong-key-version", `This share key was wrapped to team key ${String(input.wrap.ekv)}, not ${String(input.pair.version)}.`);
  }
  const aad = aadFor.shareWrap({ shareId: input.shareId, teamId: input.teamId, kv: input.shareKeyVersion, ekv: input.wrap.ekv });
  const raw = await unwrapWithPrivateKey(input.pair.privateKey, input.wrap, aad);
  try {
    await assertCommitted(input.shareId, input.shareKeyVersion, raw, input.commit);
    return { version: input.shareKeyVersion, key: await importAesKey(raw, input.extractable ?? false) };
  } finally {
    raw.fill(0);
  }
}

/** `ownerWrap` for a share to teams: `shareKey` (extractable) sealed under owner team `teamId`'s `teamKey`. */
export async function wrapShareKeyForOwner(input: { shareId: string; teamId: string; shareKey: ShareKey; teamKey: TeamKey; random?: RandomBytes }): Promise<Envelope> {
  const raw = await exportAesKey(input.shareKey.key);
  try {
    const aad = aadFor.ownerWrap({ shareId: input.shareId, teamId: input.teamId, kv: input.teamKey.version, skv: input.shareKey.version });
    return await sealBytes(input.teamKey, raw, aad, input.random ?? cryptoRandomBytes);
  } finally {
    raw.fill(0);
  }
}

/**
 * Share key `shareKeyVersion` from `ownerWrap`, with the owner team's key of version `wrap.kv`. With
 * `commit`, the key must be the one the share's verified manifest names (`bad-key` otherwise).
 */
export async function unwrapShareKeyAsOwner(input: { shareId: string; teamId: string; shareKeyVersion: number; wrap: Envelope; teamKey: TeamKey; extractable?: boolean; commit?: Uint8Array }): Promise<ShareKey> {
  const aad = aadFor.ownerWrap({ shareId: input.shareId, teamId: input.teamId, kv: input.teamKey.version, skv: input.shareKeyVersion });
  const raw = await openBytes(input.teamKey, input.wrap, aad);
  try {
    await assertCommitted(input.shareId, input.shareKeyVersion, raw, input.commit);
    return { version: input.shareKeyVersion, key: await importAesKey(raw, input.extractable ?? false) };
  } finally {
    raw.fill(0);
  }
}

/** A link secret S, bytes (128 bits). */
export const LINK_SECRET_BYTES = 16;
/** S as text in the link, characters: base64url without padding. */
export const LINK_SECRET_TEXT_LENGTH = 22;
/** A link share's key version. S never changes for a link, so it is always 1. */
export const LINK_KEY_VERSION = 1;

/** A new link secret S: 16 random bytes. */
export function newLinkSecret(random: RandomBytes = cryptoRandomBytes): Uint8Array<ArrayBuffer> {
  return take(random, LINK_SECRET_BYTES);
}

function assertLinkSecret(secret: Uint8Array): void {
  if (!isBytes(secret, { exactly: LINK_SECRET_BYTES })) throw new CryptoError("bad-input", "A link secret must be exactly 16 bytes.");
}

/** S as the 22 base64url characters that follow `#/s/` in the link. */
export function linkSecretToText(secret: Uint8Array): string {
  assertLinkSecret(secret);
  return base64urlEncode(secret);
}

/** S from the 22 characters after `#/s/`. Anything but exactly 22 canonical base64url characters throws `bad-input`. */
export function linkSecretFromText(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length !== LINK_SECRET_TEXT_LENGTH) throw new CryptoError("bad-input", "A link secret is exactly 22 characters.");
  return base64urlDecode(text);
}

const NO_SALT = new Uint8Array(0);

/**
 * The share id stored for a link share: HKDF-SHA-256 of S with an empty salt and the info
 * `zenith/v1/link-id`, truncated to 128 bits, as 22 base64url characters. That is the shape of every
 * other 128-bit client-made id (`randomId`), so the rules' random-id check accepts it.
 */
export async function deriveLinkId(secret: Uint8Array): Promise<string> {
  assertLinkSecret(secret);
  return base64urlEncode(await hkdfBits(secret, NO_SALT, "zenith/v1/link-id", 128));
}

/**
 * The raw bytes of the link share's key, for its commitment in the share's manifest only: the key
 * `deriveLinkKey` imports is never extractable.
 */
export async function deriveLinkKeyBytes(secret: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  assertLinkSecret(secret);
  return hkdfBits(secret, NO_SALT, "zenith/v1/link-key", AES_KEY_BYTES * 8);
}

/**
 * The link share's key: HKDF-SHA-256 of S with an empty salt and the info `zenith/v1/link-key`,
 * 256 bits, as a non-extractable AES-256-GCM key of version `LINK_KEY_VERSION`.
 */
export async function deriveLinkKey(secret: Uint8Array): Promise<ShareKey> {
  assertLinkSecret(secret);
  return { version: LINK_KEY_VERSION, key: await hkdfAesKey(secret, NO_SALT, "zenith/v1/link-key") };
}

/** `linkWrap` for a link share of auto `autoId`: S sealed under owner team `teamId`'s `teamKey`, so a teammate can copy the link again. */
export async function wrapLinkSecretForOwner(input: { shareId: string; teamId: string; autoId: string; secret: Uint8Array; teamKey: TeamKey; random?: RandomBytes }): Promise<Envelope> {
  assertLinkSecret(input.secret);
  return sealBytes(
    input.teamKey,
    input.secret,
    aadFor.linkWrap({ shareId: input.shareId, teamId: input.teamId, autoId: input.autoId, kv: input.teamKey.version }),
    input.random ?? cryptoRandomBytes,
  );
}

/** S from a link share's `linkWrap`, with the owner team's key of version `wrap.kv`. */
export async function unwrapLinkSecretAsOwner(input: { shareId: string; teamId: string; autoId: string; wrap: Envelope; teamKey: TeamKey }): Promise<Uint8Array<ArrayBuffer>> {
  const secret = await openBytes(input.teamKey, input.wrap, aadFor.linkWrap({ shareId: input.shareId, teamId: input.teamId, autoId: input.autoId, kv: input.teamKey.version }));
  assertLinkSecret(secret);
  return secret;
}

/**
 * Share key `previous` sealed under share key `next` (`aadFor.shareKeyChain`), for `prevKeys` on the
 * share when a team is taken off it. Both must be of one share, `next` one version above `previous`,
 * and `previous` extractable. Holding the newest share key then opens every older one, so proposals
 * made under an older key stay readable (spec 14 section 4.6).
 */
export async function sealPreviousShareKey(input: { shareId: string; previous: ShareKey; next: ShareKey; random?: RandomBytes }): Promise<Envelope> {
  if (input.next.version !== input.previous.version + 1) throw new CryptoError("bad-input", "A share key is sealed only under the version just above it.");
  const raw = await exportAesKey(input.previous.key);
  try {
    return await sealBytes(input.next, raw, aadFor.shareKeyChain({ shareId: input.shareId, kv: input.next.version }), input.random ?? cryptoRandomBytes);
  } finally {
    raw.fill(0);
  }
}

/**
 * Every share key version from `newest` down, opened through `prevKeys` (a map from each older
 * version, as decimal text, to that key sealed under the version above it). Stops at version 1 or at
 * the first version the map does not hold. Older keys are non-extractable unless `extractable`.
 * Throws `decrypt-failed` or `wrong-key-version` for an entry that was changed or moved.
 */
export async function openShareKeyChain(input: { shareId: string; newest: ShareKey; prevKeys: Readonly<Record<string, Envelope>>; extractable?: boolean }): Promise<Map<number, ShareKey>> {
  const out = new Map<number, ShareKey>([[input.newest.version, input.newest]]);
  let key = input.newest;
  while (key.version > 1) {
    const sealed = input.prevKeys[String(key.version - 1)];
    if (sealed === undefined) break;
    const raw = await openBytes(key, sealed, aadFor.shareKeyChain({ shareId: input.shareId, kv: key.version }));
    try {
      key = { version: key.version - 1, key: await importAesKey(raw, input.extractable ?? false) };
    } finally {
      raw.fill(0);
    }
    out.set(key.version, key);
  }
  return out;
}
