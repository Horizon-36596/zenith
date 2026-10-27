/** Helpers the crypto tests share. */
import { expect } from "vitest";
import {
  aadFor,
  isCryptoError,
  openProposalAsOwner,
  openProposalAsSender,
  openText,
  type Aad,
  type CryptoErrorCode,
  type Envelope,
  type ProposalBinding,
  type ProposalKeyWrap,
  type ShareKey,
  type TeamKeyVersion,
} from "../src/crypto/index.js";
import type { MemoryDatabase } from "../src/memory/memoryStore.js";

/** Who a read of the in-memory database comes from, as `MemoryDatabase.read` takes it. */
export type Caller = Parameters<MemoryDatabase["read"]>[0];

/** The uid a caller of the in-memory database signs in as, or null when signed out. */
export function uidOf(caller: Caller): string | null {
  return caller === null || typeof caller === "string" ? caller : caller.uid;
}

/** A copy of `bytes` with one bit flipped (bit 0 of byte `index`, counted from the end when negative). */
export function flip(bytes: Uint8Array, index = 0): Uint8Array {
  const out = new Uint8Array(bytes);
  const at = index < 0 ? out.length + index : index;
  out[at] = (out[at] ?? 0) ^ 1;
  return out;
}

/** A random source whose stream is 0, 1, 2, ... (mod 256) from `start`, so every call is reproducible. */
export function counting(start = 0): (length: number) => Uint8Array {
  let next = start;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = next++ & 0xff;
    return out;
  };
}

/** Awaits `promise` and asserts it rejected with a `CryptoError` of `code`. */
export async function rejectsWith(promise: Promise<unknown>, code: CryptoErrorCode): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a CryptoError "${code}"`).not.toBeNull();
  expect(isCryptoError(caught) ? caught.code : caught).toBe(code);
}

/** Asserts `run` throws a `CryptoError` of `code` synchronously. */
export function throwsWith(run: () => unknown, code: CryptoErrorCode): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a CryptoError "${code}"`).not.toBeNull();
  expect(isCryptoError(caught) ? caught.code : caught).toBe(code);
}

export const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A proposal document as a test reads it from the database. */
export interface StoredProposal {
  shareId: string;
  ownerTeamId: string;
  fromTeamId: string;
  diff: Envelope;
  ownerWrap?: ProposalKeyWrap;
  fromWrap?: Envelope;
}

/** What a stored proposal's diff and wraps are bound to, from its own fields. */
export function proposalBinding(proposalId: string, doc: StoredProposal): ProposalBinding {
  return { proposalId, shareId: doc.shareId, ownerTeamId: doc.ownerTeamId, fromTeamId: doc.fromTeamId, okv: doc.ownerWrap?.ekv ?? 1, fkv: doc.fromWrap?.kv ?? 1 };
}

/**
 * What someone reads of a stored proposal with the keys she holds, or null: `chain`, one team's key
 * versions as she kept them, tried on the owner wrap and on the proposing team's copy at the versions
 * they name, and `shareKey`, a share key she holds, tried on the diff itself, under the proposal's
 * binding and under the associated data a proposal had while the share key sealed it
 * (`zenith/v1/proposal|proposal=|share=|kv=`). Every way in is tried, so a null means none opens.
 */
export async function proposalWithKeys(
  proposalId: string,
  doc: StoredProposal,
  holds: { chain?: ReadonlyMap<number, TeamKeyVersion>; shareKey?: ShareKey },
): Promise<string | null> {
  const attempts: (() => Promise<string>)[] = [];
  const { chain, shareKey } = holds;
  if (chain !== undefined && doc.ownerWrap !== undefined) {
    const { ownerWrap } = doc;
    const version = chain.get(ownerWrap.ekv);
    if (version !== undefined) attempts.push(() => openProposalAsOwner({ binding: proposalBinding(proposalId, doc), diff: doc.diff, ownerWrap, pair: version.pair }));
  }
  if (chain !== undefined && doc.fromWrap !== undefined) {
    const { fromWrap } = doc;
    const version = chain.get(fromWrap.kv);
    if (version !== undefined) attempts.push(() => openProposalAsSender({ binding: proposalBinding(proposalId, doc), diff: doc.diff, fromWrap, teamKey: version.key }));
  }
  if (shareKey !== undefined) {
    const oldAad = `zenith/v1/proposal|proposal=${proposalId}|share=${doc.shareId}|kv=${String(shareKey.version)}` as Aad;
    attempts.push(() => openText(shareKey, { ...doc.diff, kv: shareKey.version }, oldAad));
    attempts.push(() => openText(shareKey, { ...doc.diff, kv: shareKey.version }, aadFor.proposalDiff(proposalBinding(proposalId, doc))));
  }
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // This way in does not open it; try the next.
    }
  }
  return null;
}
