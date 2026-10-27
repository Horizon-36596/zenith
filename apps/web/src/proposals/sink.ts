/**
 * Where a finished proposal goes (spec 13 section 14). There are two sinks:
 *
 * - **The file** (`downloadSink`): a download of the canonical proposal file, which the proposer
 *   sends to the team that shared the auto however they like, and which that team opens with "Open
 *   proposal…". It is always there, and it is the only one for a partner loaded from a file or
 *   while the cloud is off.
 * - **The share** (`cloudShareSink`): sends the same canonical text through the cloud, to the
 *   received share the partner was loaded from, where the rules take it only from a team the share
 *   grants propose to, and only while the share is live. Offline, the write waits in the Outbox and
 *   is sent when the connection comes back, as every other write does.
 *
 * `sendSinkFor` chooses: the share when the cloud is on, the partner came from a received cloud
 * share at the propose level, and the signed-in team is one it was made to; otherwise no send, and
 * the sentence saying why.
 */
import { canonicalize } from "@horizon36596/zenith-core";
import type { Proposal } from "@horizon36596/zenith-schema";
import { shareProposeBlockedReason, type PartnerShare } from "../cloud/partnerShare";
import { sendCloudProposal } from "../cloud/proposalsStore";
import { teamInSentence } from "../cloud/words";
import { downloadText } from "../project/fallback";

export interface ProposalSink {
  /** Where it goes, in words, for the button and the status line: "a file", "Team 36596's share". */
  readonly description: string;
  /** Hands the proposal over; resolves with the sentence for the status line and whether it waits. */
  send(proposal: Proposal, fileName: string): Promise<HandedOver>;
}

/**
 * How a hand-over went: the status line's sentence, and whether the proposal waits on this computer
 * for the connection, which the status line shows as information, never as done.
 */
export interface HandedOver {
  sentence: string;
  waiting: boolean;
}

/** The canonical text of a proposal, as every sink writes it. */
export const proposalText = (proposal: Proposal): string => canonicalize("proposal", proposal);

/** Saves the proposal as a file the browser downloads. */
export const downloadSink: ProposalSink = {
  description: "a file",
  send(proposal, fileName) {
    downloadText(fileName, proposalText(proposal));
    return Promise.resolve({
      sentence: `Saved ${fileName}. Send it to the team that shared the auto; they open it with Open proposal.`,
      waiting: false,
    });
  },
};

/** How a cloud sink hands a proposal to the cloud: `sendCloudProposal`, or a stand-in in tests. */
export type CloudSend = typeof sendCloudProposal;

/** Sends the proposal to the received share `share`, through the cloud. */
export function cloudShareSink(share: PartnerShare, send: CloudSend = sendCloudProposal): ProposalSink {
  const team = teamInSentence(share.fromTeam);
  return {
    description: `${team}'s share`,
    async send(proposal) {
      if (proposal.shareRef.shareId !== share.shareId || proposal.shareRef.revision !== share.revision) {
        throw new Error("This proposal names a different share or revision from the one it would be sent to, so it was not sent.");
      }
      const sent = await send({ shareId: share.shareId, baseRevisionId: share.revisionId, text: proposalText(proposal) });
      return sent.queued
        ? { sentence: `Waiting to send the proposal to ${team}. It goes from the Outbox when you are back online.`, waiting: true }
        : {
            sentence: `Sent the proposal to ${team}. They review it from their Sharing page; its status shows under the partner in your Partners panel.`,
            waiting: false,
          };
    },
  };
}

/** What the signed-in cloud session looks like to the sink choice. */
export interface SinkSession {
  signedIn: boolean;
  teamId: string | null;
}

/** Where "Send" goes for a partner: the share, or nowhere and why (the file is always there). */
export type SendChoice = { ok: true; sink: ProposalSink } | { ok: false; why: string };

/** Chooses the send sink for a proposal to a partner. Pure apart from the sink it returns. */
export function sendSinkFor(share: PartnerShare | undefined, session: SinkSession, send: CloudSend = sendCloudProposal): SendChoice {
  if (share === undefined) {
    return { ok: false, why: "This partner was loaded from a file, so the proposal goes back as a file: save it and send it to them." };
  }
  if (!session.signedIn) {
    return { ok: false, why: "Sign in to the cloud with your team to send the proposal to the share; until then, save it and send the file." };
  }
  const blocked = shareProposeBlockedReason(share, session.teamId);
  if (blocked !== null) return { ok: false, why: blocked };
  return { ok: true, sink: cloudShareSink(share, send) };
}

/** The file name a proposal is saved as: `<share>.proposal.json`. */
export const proposalFileName = (proposal: Proposal): string => `${proposal.shareRef.shareId}.proposal.json`;
