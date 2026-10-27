import type { ProposalChangeOp } from "@horizon36596/zenith-schema";
import type { Finding } from "../types.js";

/**
 * Whether the share a proposal was made against still takes proposals. The share itself lives in
 * the cloud library, not in any file core reads, so the caller says what state it is in; a share
 * that is not said to be revoked or expired is taken to be live.
 */
export type ShareStatus = "live" | "revoked" | "expired";

/** A finding about a proposal, and which of its changes it is about (0-based) when it is about one. */
export interface ProposalFinding extends Finding {
  changeIndex?: number;
}

/**
 * What became of one change when the owner applied a proposal:
 *
 * - `applied`: accepted, and made through the edit primitives;
 * - `notAccepted`: the owner did not accept it, so nothing was done;
 * - `conflict`: the step it is about has changed since the share, so it can only be rejected;
 * - `invalid`: it does not fit the share, or not without a change the owner did not accept;
 * - `refused`: the whole proposal was refused (a view or dead share, or a stale structure).
 */
export type ProposalChangeStatus = "applied" | "notAccepted" | "conflict" | "invalid" | "refused";

/** One change of a proposal as review mode lists it. */
export interface ProposalChangeReport {
  /** Its place in the proposal's `changes`, from 0; what `acceptedChangeIndexes` names. */
  index: number;
  /** The same place counted from 1, as the sentences and the CLI name a change. */
  number: number;
  op: ProposalChangeOp;
  /** The real id of the step the change is about, or it goes after; null for a step added at the start. */
  stepId: string | null;
  status: ProposalChangeStatus;
  /** One sentence saying what the change does, in the owner's step names. */
  summary: string;
  /** The proposer's one-line comment, when there is one. */
  comment?: string;
}
