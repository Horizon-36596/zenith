/**
 * The received-proposals model (spec 13 section 14): which proposals belong to which share, how
 * each is described on the Sharing page and in the Partners panel, and when one can be opened for
 * review. Pure: no DOM, no clock, no store.
 */
import type { ShareStatus } from "@horizon36596/zenith-core";
import { timeAgo } from "../account/words";
import type { CloudProposal, ProposalStatus } from "./proposalsApi";
import type { Share } from "./types";

export const PROPOSAL_STATUS_WORDS: Record<ProposalStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const PROPOSAL_STATUS_DOES: Record<ProposalStatus, string> = {
  open: "Waiting for the team that shared the auto to review it.",
  accepted: "The team that shared the auto applied changes from it.",
  rejected: "The team that shared the auto decided not to take it.",
  withdrawn: "The team that sent it took it back.",
};

/** The proposals made to one share, newest first. */
export function proposalsOfShare(proposals: readonly CloudProposal[], shareId: string): CloudProposal[] {
  return proposals.filter((proposal) => proposal.shareId === shareId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How many of them still wait for a decision. */
export const openCount = (proposals: readonly CloudProposal[]): number => proposals.filter((proposal) => proposal.status === "open").length;

/** One proposal's line, in words. */
export interface ProposalWords {
  status: string;
  /** "From team 12345" on the owner's side, "To team 36596" on the proposer's. */
  who: string;
  /** "sent 5 minutes ago", or "accepted 2 hours ago" once decided. */
  when: string;
  /** "against revision 2" */
  against: string;
  /** "2 changes", so proposals sent alike can be told apart, or null when the file cannot be read. */
  changes: string | null;
}

/** How many changes a proposal file holds, or null when its text is not a proposal's JSON. */
export function proposalChangeCount(text: string): number | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const changes = (json as { changes?: unknown }).changes;
  return Array.isArray(changes) ? changes.length : null;
}

/** "1 change", "2 changes", or null when the count is unknown. */
export function changeCountWords(count: number | null): string | null {
  if (count === null) return null;
  return `${String(count)} ${count === 1 ? "change" : "changes"}`;
}

export function proposalWords(proposal: CloudProposal, side: "received" | "sent", nowMs: number): ProposalWords {
  const team = side === "received" ? proposal.fromTeam : proposal.ownerTeam;
  const decided = proposal.decidedAt !== null && proposal.status !== "open";
  const at = decided && proposal.decidedAt !== null ? proposal.decidedAt : proposal.createdAt;
  return {
    status: PROPOSAL_STATUS_WORDS[proposal.status],
    who: `${side === "received" ? "From" : "To"} ${team.charAt(0).toLowerCase()}${team.slice(1)}`,
    when: `${decided ? proposal.status : "sent"} ${timeAgo(new Date(at), nowMs)}`,
    against: `against revision ${String(proposal.revision)}`,
    changes: changeCountWords(proposalChangeCount(proposal.text)),
  };
}

/**
 * Why the signed-in member cannot withdraw a proposal they see among those sent, or null when they
 * may. The rules take a withdrawal only of an open proposal and only from the member who sent it.
 */
export function whyCannotWithdraw(proposal: Pick<CloudProposal, "status" | "sentByMe">): string | null {
  if (proposal.status !== "open") return `It is already ${PROPOSAL_STATUS_WORDS[proposal.status].toLowerCase()}, so there is nothing to take back.`;
  if (!proposal.sentByMe) return "Only the member of your team who sent it can withdraw it.";
  return null;
}

/** The confirmation Withdraw asks for first, naming the team that would stop seeing it as open. */
export function withdrawConfirmSentence(proposal: Pick<CloudProposal, "ownerTeam">): string {
  return `Withdraw this proposal? ${proposal.ownerTeam} can then no longer accept it. This cannot be undone.`;
}

/** What Withdraw says once done: sent, or saved on this computer until it is back online. */
export function withdrawnSentence(proposal: Pick<CloudProposal, "ownerTeam">, queued: boolean): string {
  return queued
    ? `Withdrawn on this computer. ${proposal.ownerTeam} sees it withdrawn when this computer is back online.`
    : `Withdrew the proposal. ${proposal.ownerTeam} now sees it as withdrawn.`;
}

/** Whether a share is live, revoked or ended, as core's proposal checks read it. */
export function shareStatusOf(share: Pick<Share, "revokedAt" | "expiresAt">, nowMs: number): ShareStatus {
  if (share.revokedAt !== null) return "revoked";
  return share.expiresAt === null || Date.parse(share.expiresAt) > nowMs ? "live" : "expired";
}

/**
 * Why a received proposal cannot be opened for review just now, or null when it can: the review is
 * read against the auto the share was made from, so that auto must be the one open.
 */
export function reviewBlockedReason(input: {
  /** The proposal to open; a withdrawn one has nothing left to review. */
  proposal?: Pick<CloudProposal, "status" | "fromTeam">;
  /** Why the editor cannot open any proposal now (no auto open, a pull request review running). */
  editorBlocked: string | null;
  /** The library auto the open auto is, or null. */
  openAutoId: string | null;
  share: Pick<Share, "autoId">;
  /** How the Sharing page names that auto. */
  autoLabel: string;
}): string | null {
  if (input.proposal?.status === "withdrawn") return `${input.proposal.fromTeam} withdrew it, so there is nothing to review.`;
  if (input.editorBlocked !== null) return input.editorBlocked;
  if (input.openAutoId !== input.share.autoId) return `Open ${input.autoLabel} first: the proposal is reviewed against it.`;
  return null;
}
