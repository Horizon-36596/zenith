/**
 * Under a partner loaded from a received cloud share, in the Partners panel (spec 13 sections 8.3,
 * 9 and 14): when the share last changed ("updated 3 hours ago"), whether a newer version arrived
 * since it was loaded, with Reload, and the status of the proposals the team sent to it, with
 * Withdraw on an open one its sender may take back. Withdraw asks first; offline, the withdrawal
 * waits in the Outbox, and the line under it says so.
 */
import { useState } from "react";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { SheetButton } from "../cloud/controls";
import { OutboxNotice } from "../cloud/OutboxNotice";
import { newerShareOf, partnerUpdatedWords, type PartnerShare } from "../cloud/partnerShare";
import { cloudNow, useCloud } from "../cloud/store";
import type { CloudProposal } from "../cloud/proposalsApi";
import {
  proposalWords,
  proposalsOfShare,
  whyCannotWithdraw,
  withdrawConfirmSentence,
  withdrawnSentence,
  PROPOSAL_STATUS_DOES,
} from "../cloud/proposalsModel";
import { useProposals, withdrawCloudProposal } from "../cloud/proposalsStore";
import { reloadSharePartner } from "./cloudSource";
import type { PartnerEntry } from "./model";
import styles from "./alliance.module.css";

export function PartnerShareInfo({ partner, share }: { partner: PartnerEntry; share: PartnerShare }) {
  const { received } = useCloud();
  const { sent } = useProposals();
  const nowMs = cloudNow();
  const newer = newerShareOf(share, received);
  const mine = proposalsOfShare(sent, share.shareId);
  const testId = `partner-share-${partner.id}`;

  return (
    <div className={styles.partnerShare} data-testid={testId}>
      <span className={styles.partnerShareLine}>
        <span>{share.mode === "follow" ? "Follows their latest version" : `Stays on version ${String(share.revision)}`}</span>
        <span aria-hidden>·</span>
        <span data-testid={`${testId}-updated`}>{partnerUpdatedWords(share, nowMs)}</span>
      </span>
      {newer === null ? null : (
        <span className={styles.partnerShareLine} data-testid={`${testId}-newer`}>
          <span className={styles.newer}>
            {newer.revisionId === share.revisionId
              ? `${share.fromTeam} changed what this share allows since you loaded it.`
              : `A newer version arrived: revision ${String(newer.revision)}.`}
          </span>
          <Tooltip
            label="Reload"
            hint={`Loads the share as ${share.fromTeam} has it now, keeping this partner's colour and start offset.`}
          >
            <button
              type="button"
              className={styles.textButton}
              data-testid={`${testId}-reload`}
              onClick={() => {
                reloadSharePartner(partner.id, newer);
              }}
            >
              Reload
            </button>
          </Tooltip>
        </span>
      )}
      {mine.length === 0 ? null : (
        <ul className={styles.sentList} aria-label="Proposals you sent to this share" data-testid={`${testId}-sent`}>
          {mine.map((proposal) => (
            <SentProposal key={proposal.id} proposal={proposal} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** What Withdraw said, and whether the write still waits on this computer. */
interface Outcome {
  text: string;
  queued: boolean;
}

/** One proposal the team sent, with its status and, while it is open, Withdraw. */
function SentProposal({ proposal, nowMs }: { proposal: CloudProposal; nowMs: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = proposalWords(proposal, "sent", nowMs);
  const rowId = `sent-proposal-${proposal.id}`;
  const cannot = whyCannotWithdraw(proposal);

  const withdraw = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const sent = await withdrawCloudProposal(proposal.id);
      setOutcome({ text: withdrawnSentence(proposal, sent.queued), queued: sent.queued });
      setConfirming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.sentItem} data-testid={rowId} data-status={proposal.status}>
      <span className={styles.partnerShareLine}>
        <span>Your proposal</span>
        <span aria-hidden>·</span>
        <Tooltip label={words.status} hint={PROPOSAL_STATUS_DOES[proposal.status]}>
          <span className={styles.statusChip} data-status={proposal.status} tabIndex={0} data-testid={`${rowId}-status`}>
            {words.status}
          </span>
        </Tooltip>
        {words.changes === null ? null : <span data-testid={`${rowId}-changes`}>{words.changes}</span>}
        {words.changes === null ? null : <span aria-hidden>·</span>}
        <span>{words.when}</span>
        {proposal.status !== "open" || confirming ? null : (
          <SheetButton
            kind="text"
            tooltip="Withdraw this proposal"
            hint={`Takes it back, so ${proposal.ownerTeam} can no longer accept it. Asks you first.`}
            whyDisabled={cannot ?? (busy ? "Withdrawing it already." : null)}
            onClick={() => {
              setOutcome(null);
              setConfirming(true);
            }}
            testId={`${rowId}-withdraw`}
          >
            Withdraw
          </SheetButton>
        )}
      </span>
      {confirming && proposal.status === "open" ? (
        <ConfirmRow
          inline
          testId={`${rowId}-confirm`}
          sentence={withdrawConfirmSentence(proposal)}
          verb="Withdraw"
          verbHint="This cannot be undone."
          whyDisabled={cannot ?? (busy ? "Withdrawing it already." : null)}
          onConfirm={() => {
            void withdraw();
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : null}
      {outcome === null ? null : outcome.queued ? (
        <OutboxNotice text={outcome.text} testId={`${rowId}-outcome`} />
      ) : (
        <span className={styles.partnerShareLine} role="status" data-testid={`${rowId}-outcome`}>
          {outcome.text}
        </span>
      )}
      {error === null ? null : (
        <span className={styles.sentError} role="alert" data-testid={`${rowId}-error`}>
          {error}
        </span>
      )}
    </li>
  );
}
