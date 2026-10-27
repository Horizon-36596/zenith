/**
 * The proposals received for one share, under its row on the Sharing page (spec 13 section 14):
 * each one's status (open, accepted, rejected, withdrawn), the team it came from, when, and the
 * revision it was made against, with Review, which opens it in the owner's review against that
 * revision. A proposal its sender withdrew shows Withdrawn, and Review says there is nothing left
 * to review. A share at the view level lists nothing unless proposals arrived while it allowed them.
 */
import { useEffect } from "react";
import { Tooltip } from "../components/Tooltip";
import { useAccount } from "../account/store";
import { openProposalBlockedReason } from "../proposals/ownerActions";
import { openCloudProposal } from "../proposals/cloudReview";
import { useEditor } from "../state/store";
import { SheetButton } from "./controls";
import { libraryAutoIdOf, useOpenAutoStatus } from "./openAuto";
import { openCount, proposalWords, proposalsOfShare, reviewBlockedReason, PROPOSAL_STATUS_DOES } from "./proposalsModel";
import { refreshProposals, useProposals } from "./proposalsStore";
import type { Share } from "./types";
import { autoLabelOf } from "./words";
import styles from "./cloud.module.css";
import own from "./receivedProposals.module.css";

/** Reads the proposals again whenever the Sharing page opens, or the team changes. */
export function useRefreshProposals(): void {
  const { teamId } = useProposals();
  useEffect(() => {
    if (teamId !== null) void refreshProposals();
  }, [teamId]);
}

export function ReceivedProposals({ share, nowMs }: { share: Share; nowMs: number }) {
  const { received, error } = useProposals();
  const editor = useEditor();
  const library = useAccount().library;
  const openAutoId = libraryAutoIdOf(useOpenAutoStatus());
  const proposals = proposalsOfShare(received, share.id);
  if (share.level !== "propose" && proposals.length === 0) return null;
  const testId = `share-proposals-${share.id}`;
  const autoLabel = autoLabelOf(share.autoId, library.autos);
  const editorBlocked = openProposalBlockedReason(editor);
  const waiting = openCount(proposals);

  return (
    <div className={own.block} data-testid={testId}>
      <span className={own.head}>
        {proposals.length === 0
          ? "No proposals received for this share yet."
          : `Proposals received: ${String(proposals.length)}${waiting > 0 ? `, ${String(waiting)} open` : ""}`}
      </span>
      {error === null ? null : <span className={styles.error}>{error}</span>}
      {proposals.length === 0 ? null : (
        <ul className={own.list}>
          {proposals.map((proposal) => {
            const words = proposalWords(proposal, "received", nowMs);
            const blocked = reviewBlockedReason({ proposal, editorBlocked, openAutoId, share, autoLabel });
            const rowId = `received-proposal-${proposal.id}`;
            return (
              <li key={proposal.id} className={own.row} data-testid={rowId} data-status={proposal.status}>
                <Tooltip label={words.status} hint={PROPOSAL_STATUS_DOES[proposal.status]}>
                  <span className={own.chip} data-status={proposal.status} tabIndex={0} data-testid={`${rowId}-status`}>
                    {words.status}
                  </span>
                </Tooltip>
                <span className={own.meta}>
                  <span data-testid={`${rowId}-from`}>{words.who}</span>
                  <span aria-hidden>·</span>
                  {words.changes === null ? null : <span data-testid={`${rowId}-changes`}>{words.changes}</span>}
                  {words.changes === null ? null : <span aria-hidden>·</span>}
                  <span>{words.when}</span>
                  <span aria-hidden>·</span>
                  <span className={styles.mono}>{words.against}</span>
                </span>
                <SheetButton
                  kind="text"
                  tooltip="Review this proposal"
                  hint={`Opens it change by change against revision ${String(proposal.revision)}, the version it was made against. Nothing changes in your auto until you apply.`}
                  whyDisabled={blocked}
                  onClick={() => void openCloudProposal(proposal, share)}
                  testId={`${rowId}-review`}
                >
                  Review
                </SheetButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
