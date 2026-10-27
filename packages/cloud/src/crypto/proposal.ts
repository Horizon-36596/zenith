/**
 * Proposal keys. Every proposal's diff is sealed under a key of its own, a random 256-bit AES-GCM key
 * made for that one proposal, never under the share key: a share to several teams gives the share key
 * to each of them, and a proposal is for the team that owns the share alone. The proposal key is
 * wrapped twice: to the owner team's `encKey`, so the owner team opens it with its team key pair of
 * that version (`ownerWrap`), and under the proposing team's own team key, so the proposing team reads
 * what it sent (`fromWrap`). The diff and both wraps are bound to the same `ProposalBinding`.
 *
 * Anyone can wrap a key to a team's public `encKey`, so `ownerWrap` says nothing about who made a
 * proposal. The proposing device therefore signs each one with its team's signing key of version
 * `fkv` (`signProposal`), over the binding, the auto and base revision, and a digest of the sealed
 * diff and both wraps (`proposalSignedBytes`), and the owner team checks it (`verifyProposal`).
 */
import { cryptoRandomBytes, type RandomBytes } from "../ids.js";
import { aadFor, idPart, isKeyVersion, versionPart, type ProposalBinding } from "./aad.js";
import { concatBytes, utf8Encode } from "./bytes.js";
import { sign, SIGNATURE_BYTES, verify } from "./device.js";
import { assertEnvelope, openBytes, openText, sealBytes, sealText, type Envelope, type OpenOptions, type VersionedKey } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { AES_KEY_BYTES, importAesKey, isBytes, sha256, take } from "./primitives.js";
import { checkTeamEncKey, type TeamEncKey, type TeamKey, type TeamKeyPair } from "./team.js";
import { assertPublicKeyWrap, unwrapWithPrivateKey, wrapToPublicKey, type PublicKeyWrap } from "./wrap.js";

/** A proposal key's version. Each proposal has one key, never replaced, so it is always 1. */
export const PROPOSAL_KEY_VERSION = 1;

/**
 * `ownerWrap` on a proposal: its key wrapped to the owner team's `encKey`. `ekv` is that `encKey`'s
 * version, the `okv` of the proposal's binding, so the owner team knows which key pair opens it.
 */
export interface ProposalKeyWrap extends PublicKeyWrap {
  ekv: number;
}

/** A proposal's sealed fields: the diff and the two wraps of the key it is sealed under. */
export interface SealedProposal {
  /** The diff, under the proposal key (`aadFor.proposalDiff`). */
  diff: Envelope;
  /** The proposal key wrapped to the owner team's `encKey` of version `okv` (`aadFor.proposalOwnerWrap`). */
  ownerWrap: ProposalKeyWrap;
  /** The proposal key sealed under the proposing team's key of version `fkv` (`aadFor.proposalFromWrap`). */
  fromWrap: Envelope;
}

function assertBinding(binding: ProposalBinding): void {
  if (!isKeyVersion(binding.okv) || !isKeyVersion(binding.fkv)) throw new CryptoError("bad-input", "A proposal's key versions must be whole numbers from 1.");
  // The builders check the ids; building one AAD here refuses a bad binding before anything is sealed.
  aadFor.proposalDiff(binding);
}

/**
 * `diffText` sealed under a new proposal key, with that key wrapped to `ownerEncKey` (checked first,
 * and of version `binding.okv`) and sealed under `fromTeamKey` (of version `binding.fkv`). `random`
 * supplies the proposal key and the IVs.
 */
export async function sealProposal(input: {
  binding: ProposalBinding;
  diffText: string;
  ownerEncKey: TeamEncKey;
  fromTeamKey: TeamKey;
  random?: RandomBytes;
}): Promise<SealedProposal> {
  const { binding } = input;
  const random = input.random ?? cryptoRandomBytes;
  assertBinding(binding);
  if (input.ownerEncKey.v !== binding.okv) throw new CryptoError("bad-input", "A proposal key is wrapped only to the owner team key version its binding names.");
  if (input.fromTeamKey.version !== binding.fkv) throw new CryptoError("bad-input", "A proposal key is sealed only under the proposing team key version its binding names.");
  await checkTeamEncKey(input.ownerEncKey);
  const raw = take(random, AES_KEY_BYTES);
  try {
    const key: VersionedKey = { version: PROPOSAL_KEY_VERSION, key: await importAesKey(raw, false) };
    const diff = await sealText(key, input.diffText, aadFor.proposalDiff(binding), random);
    const ownerWrap: ProposalKeyWrap = { ...(await wrapToPublicKey(input.ownerEncKey.spki, raw, aadFor.proposalOwnerWrap(binding), random)), ekv: binding.okv };
    const fromWrap = await sealBytes(input.fromTeamKey, raw, aadFor.proposalFromWrap(binding), random);
    return { diff, ownerWrap, fromWrap };
  } finally {
    raw.fill(0);
  }
}

async function openDiff(binding: ProposalBinding, raw: Uint8Array, diff: Envelope, options?: OpenOptions): Promise<string> {
  try {
    if (raw.byteLength !== AES_KEY_BYTES) throw new CryptoError("bad-key", "This proposal's key is not 32 bytes.");
    const key: VersionedKey = { version: PROPOSAL_KEY_VERSION, key: await importAesKey(raw, false) };
    return await openText(key, diff, aadFor.proposalDiff(binding), options);
  } finally {
    raw.fill(0);
  }
}

/**
 * The diff, for the owner team: the proposal key from `ownerWrap` with the owner team's key pair of
 * version `ownerWrap.ekv`, which `binding.okv` must equal. Throws `wrong-key-version` for another
 * pair, and `decrypt-failed` for anything changed or moved.
 */
export async function openProposalAsOwner(input: { binding: ProposalBinding; diff: Envelope; ownerWrap: ProposalKeyWrap; pair: TeamKeyPair; options?: OpenOptions }): Promise<string> {
  assertBinding(input.binding);
  assertPublicKeyWrap(input.ownerWrap);
  if (input.ownerWrap.ekv !== input.binding.okv) throw new CryptoError("bad-envelope", "This proposal's key is not wrapped to the owner team key version it is bound to.");
  if (input.pair.version !== input.ownerWrap.ekv) {
    throw new CryptoError("wrong-key-version", `This proposal's key was wrapped to team key ${String(input.ownerWrap.ekv)}, not ${String(input.pair.version)}.`);
  }
  const raw = await unwrapWithPrivateKey(input.pair.privateKey, input.ownerWrap, aadFor.proposalOwnerWrap(input.binding));
  return openDiff(input.binding, raw, input.diff, input.options);
}

/**
 * The diff, for the team that sent it: the proposal key from `fromWrap` with that team's key of
 * version `fromWrap.kv`, which `binding.fkv` must equal. Throws `wrong-key-version` for another key,
 * and `decrypt-failed` for anything changed or moved.
 */
export async function openProposalAsSender(input: { binding: ProposalBinding; diff: Envelope; fromWrap: Envelope; teamKey: TeamKey; options?: OpenOptions }): Promise<string> {
  assertBinding(input.binding);
  assertEnvelope(input.fromWrap);
  if (input.fromWrap.kv !== input.binding.fkv) throw new CryptoError("bad-envelope", "This proposal's key is not sealed under the team key version it is bound to.");
  const raw = await openBytes(input.teamKey, input.fromWrap, aadFor.proposalFromWrap(input.binding));
  return openDiff(input.binding, raw, input.diff, input.options);
}

/** The length of a proposal's signature (`sig` on the proposal): ECDSA P-256 SHA-256, r then s. */
export const PROPOSAL_SIGNATURE_BYTES = SIGNATURE_BYTES;

/**
 * What a proposal's signature covers beyond its binding: the auto it was made on and the revision it
 * was made against, both plain fields on the proposal that the owner team applies it by.
 */
export interface ProposalSignedContext {
  autoId: string;
  baseRevision: string;
}

/** Four bytes, big-endian: the length that goes in front of each part of the sealed digest. */
function lengthOf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, bytes.byteLength);
  return out;
}

/**
 * The exact bytes a proposal's signature is over: the text
 * `zenith/v1/proposal-signature|proposal=|share=|owner=|from=|okv=|fkv=|auto=|base=`, a zero byte,
 * then the SHA-256 (32 bytes) of the sealed fields, each part with its length in front as four
 * big-endian bytes, in this order: the diff's IV and ciphertext, the owner wrap's ephemeral key, IV
 * and ciphertext, and the proposing team's copy's IV and ciphertext. The key versions each of them
 * names are in the binding (`okv` is `ownerWrap.ekv`, `fkv` is `fromWrap.kv`), and the diff is always
 * under key version 1, which opening it checks.
 */
export async function proposalSignedBytes(input: { binding: ProposalBinding; context: ProposalSignedContext; sealed: SealedProposal }): Promise<Uint8Array<ArrayBuffer>> {
  const { binding, context, sealed } = input;
  assertBinding(binding);
  assertEnvelope(sealed.diff);
  assertPublicKeyWrap(sealed.ownerWrap);
  assertEnvelope(sealed.fromWrap);
  const label = [
    "zenith/v1/proposal-signature",
    idPart("proposal", binding.proposalId),
    idPart("share", binding.shareId),
    idPart("owner", binding.ownerTeamId),
    idPart("from", binding.fromTeamId),
    versionPart("okv", binding.okv),
    versionPart("fkv", binding.fkv),
    idPart("auto", context.autoId),
    idPart("base", context.baseRevision),
  ].join("|");
  const parts = [sealed.diff.iv, sealed.diff.ct, sealed.ownerWrap.epk, sealed.ownerWrap.iv, sealed.ownerWrap.ct, sealed.fromWrap.iv, sealed.fromWrap.ct];
  const digest = await sha256(concatBytes(...parts.flatMap((part) => [lengthOf(part), part])));
  return concatBytes(utf8Encode(label), new Uint8Array([0]), digest);
}

/**
 * The proposing team's signature over a proposal it sealed (`proposalSignedBytes`), with its team
 * signing key of version `binding.fkv`, the private half of `signSpki` on that version's key pair.
 */
export async function signProposal(input: { binding: ProposalBinding; context: ProposalSignedContext; sealed: SealedProposal; signingKey: CryptoKey }): Promise<Uint8Array<ArrayBuffer>> {
  return sign(input.signingKey, await proposalSignedBytes(input));
}

/**
 * True when `sig` is the proposing team's signature over the proposal, by the signing key whose SPKI
 * is `signSpki`: the one of version `binding.fkv` that the checking device trusts for that team. A
 * signature of the wrong length or type is false, as is any change to the binding, the context or
 * the sealed fields.
 */
export async function verifyProposal(input: {
  binding: ProposalBinding;
  context: ProposalSignedContext;
  sealed: SealedProposal;
  sig: unknown;
  signSpki: Uint8Array;
}): Promise<boolean> {
  if (!isBytes(input.sig, { exactly: PROPOSAL_SIGNATURE_BYTES })) return false;
  return verify(input.signSpki, input.sig, await proposalSignedBytes(input));
}
