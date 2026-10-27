/**
 * The two proposal modes as the app shell sees them (spec 13 section 14):
 * the proposer's editor on a partner's share, and the owner's review of a proposal file. While
 * either is open it takes the editor's body, as the pull-request review does.
 */
import { useOwnerReview } from "./ownerStore";
import { useProposerSession } from "./proposerStore";
import { ProposalEditView } from "./ProposalEditView";
import { ProposalReviewView } from "./ProposalReviewView";

export type ProposalMode = "propose" | "review" | null;

/** Which proposal mode is open, if any. */
export function useProposalMode(): ProposalMode {
  const session = useProposerSession();
  const review = useOwnerReview();
  if (session !== null) return "propose";
  if (review !== null) return "review";
  return null;
}

/** The body of the open proposal mode. */
export function ProposalModeView({ mode }: { mode: Exclude<ProposalMode, null> }) {
  return mode === "propose" ? <ProposalEditView /> : <ProposalReviewView />;
}
