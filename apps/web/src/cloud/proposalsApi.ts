/**
 * Proposals through the cloud (spec 13 section 14), on top of `packages/cloud`'s `CloudBackend`:
 * sending one to a share, listing those a team received or sent, deciding one, withdrawing one the
 * signed-in member sent, and reading the library revision a received one is reviewed against.
 *
 * What it translates, as the sharing adapter does for shares:
 *
 * - **Teams.** The cloud stores team ids; the UI says "Team 12345". Each id is looked up once.
 * - **Instants.** ISO 8601 strings here, `Date`s in the cloud.
 * - **The proposal.** Stored in the cloud's `diff` field as the proposal file's canonical text, the
 *   same text "Save proposal…" downloads, so a proposal reads the same whichever way it travelled.
 * - **The outbox.** While the device is online a write returns once the server has it, so a refusal
 *   by the rules is reported where it was asked for. Offline it returns at once, marked `queued`,
 *   and the Outbox lists it until it is sent (section 6), as for every other write.
 *
 * Only types come from the cloud package's main entry, which carries the Firebase SDK.
 */
import type { CloudBackend, Proposal as StoredProposal, ProposalStatus, Queued, Team } from "@horizon36596/zenith-cloud";
import { revisionNumber } from "@horizon36596/zenith-cloud/sharing";
import { sharingErrorSentence } from "./cloudSharingApi";
import { isRulesRefusal, ownSentence } from "./errorSentence";
import { cloudErrorCode } from "../account/keys/errors";
import { teamReader, type TeamLookup } from "./teams";
import type { RevisionFiles } from "./types";
import { withTeamStatus } from "../account/words";
import { claimingNumberWords, noNumberTeamWords } from "./words";

export type { ProposalStatus };

/** One proposal, as the Sharing page and the Partners panel show it. */
export interface CloudProposal {
  id: string;
  shareId: string;
  /** The owning team's library auto the share was made from. */
  autoId: string;
  ownerTeamId: string;
  /**
   * The owning team in words: "Team 36596", or "A team claiming to be 36596" when this device knows
   * that number as another team.
   */
  ownerTeam: string;
  fromTeamId: string;
  /**
   * The proposing team in words: "Team 12345", or "A team claiming to be 12345" when this device
   * knows that number as another team.
   */
  fromTeam: string;
  /** The library revision id the proposal was made against. */
  baseRevisionId: string;
  /** That revision's number, as the share showed it. */
  revision: number;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  /**
   * True when the signed-in member sent it. Only its author may withdraw a proposal (the rules
   * check `createdBy`), so another member of the same team sees it without Withdraw.
   */
  sentByMe: boolean;
  /** The proposal file in canonical form. */
  text: string;
}

/** A write's value, and whether it is still waiting in the outbox because the device is offline. */
export interface Sent<T> {
  value: T;
  queued: boolean;
}

/** How the adapters tell whether a write waits in the Outbox. */
export interface CloudWriteOptions {
  /**
   * Whether the page is online as well as the backend: the account's `online`, which also follows
   * the browser's own connection. A write sent while either says offline waits in the Outbox, and
   * its confirmation says so.
   */
  online?: () => boolean;
}

export interface SendProposalRequest {
  shareId: string;
  /** The proposing team: the signed-in team, which the share must name. */
  fromTeamId: string;
  baseRevisionId: string;
  /** The proposal file in canonical form. */
  text: string;
}

export interface ProposalsApi {
  send(request: SendProposalRequest): Promise<Sent<CloudProposal>>;
  /** Newest first. */
  list(teamId: string, direction: "received" | "sent"): Promise<CloudProposal[]>;
  decide(proposalId: string, decision: "accepted" | "rejected"): Promise<Sent<void>>;
  /** Takes back an open proposal the signed-in member sent; the sharing team then sees it withdrawn. */
  withdraw(proposalId: string): Promise<Sent<void>>;
  /** One revision of the team's own library, or null when it is not there. */
  revisionFiles(teamId: string, autoId: string, revisionId: string): Promise<RevisionFiles | null>;
}

/**
 * "Team 12345 (unverified)", "A team with no number that calls itself “Horizon”" for a team with
 * no number, "A deleted team" for one that no longer exists, or "Another team" when it cannot be
 * read. A number carries its status (spec 13 section 4.2), as everywhere a team is named; a team
 * with no number carries none, and its name never reads as a number.
 */
export function teamWords(team: (Pick<Team, "number" | "name"> & { status?: Team["status"] }) | "deleted" | null): string {
  if (team === "deleted") return "A deleted team";
  if (team === null) return "Another team";
  return team.number === null ? noNumberTeamWords(team.name) : withTeamStatus(`Team ${String(team.number)}`, team.status);
}

/**
 * Why a proposal call failed, as one sentence. The client's own checks say exactly what is wrong
 * ("That share is view only, …") and are kept; a refusal by the cloud's rules says only that it
 * was refused, so it is told in the terms of what the rules allow for proposals.
 */
export function proposalErrorSentence(error: unknown): string {
  if (cloudErrorCode(error) === "permission-denied") {
    if (!isRulesRefusal(error)) return ownSentence(error) ?? sharingErrorSentence(error);
    return "The cloud refused that. A proposal is taken only from an editor of a team the share was made to, while the share is live; only the sharing team's editors can accept or reject one, and only the member who sent it can withdraw it, while it is open.";
  }
  return sharingErrorSentence(error);
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(proposalErrorSentence(error), { cause: error });
  }
}

export function createCloudProposalsApi(backend: CloudBackend, options: CloudWriteOptions = {}): ProposalsApi {
  const teams = teamReader(backend);
  const team = (teamId: string): Promise<TeamLookup> => teams.read(teamId);

  async function settle<T>(queued: Queued<T>): Promise<Sent<T>> {
    // Online only when the backend and the page both say so: either one offline means the write waits.
    const online = backend.isOnline() && (options.online?.() ?? true);
    if (online) await queued.sent;
    return { value: queued.value, queued: !online };
  }

  /**
   * Team `teamId` in words, as `teamWords` names it, except that a team whose number this device and
   * user pinned to a different team is "A team claiming to be 12345": the server writes a team's
   * number, so it could otherwise label one partner's proposal with another partner's number. The
   * same check names the team a received share is from.
   */
  async function namedTeam(teamId: string): Promise<string> {
    const found = await team(teamId);
    if (found !== null && found !== "deleted" && found.number !== null && backend.currentUser() !== null) {
      const pin = backend.teamNumberPin(found.number);
      if (pin !== null && pin.teamId !== teamId) return claimingNumberWords(found.number);
    }
    return teamWords(found);
  }

  async function toProposal(stored: StoredProposal): Promise<CloudProposal> {
    return {
      id: stored.id,
      shareId: stored.shareId,
      autoId: stored.autoId,
      ownerTeamId: stored.ownerTeamId,
      ownerTeam: await namedTeam(stored.ownerTeamId),
      fromTeamId: stored.fromTeamId,
      fromTeam: await namedTeam(stored.fromTeamId),
      baseRevisionId: stored.baseRevision,
      revision: revisionNumber(stored.baseRevision),
      status: stored.status,
      createdAt: stored.createdAt.toISOString(),
      decidedAt: stored.decidedAt === undefined ? null : stored.decidedAt.toISOString(),
      sentByMe: stored.createdBy === backend.currentUser()?.uid,
      text: stored.diff,
    };
  }

  return {
    send: (request) =>
      guard(async () => {
        const sent = await settle(
          await backend.sendProposal({
            shareId: request.shareId,
            fromTeamId: request.fromTeamId,
            baseRevision: request.baseRevisionId,
            diff: request.text,
          }),
        );
        return { value: await toProposal(sent.value), queued: sent.queued };
      }),

    list: (teamId, direction) =>
      guard(async () => Promise.all((await backend.listProposals(teamId, direction)).map((stored) => toProposal(stored)))),

    decide: (proposalId, decision) => guard(async () => settle(await backend.decideProposal(proposalId, decision))),

    withdraw: (proposalId) => guard(async () => settle(await backend.withdrawProposal(proposalId))),

    revisionFiles: (teamId, autoId, revisionId) =>
      guard(async () => {
        const revision = await backend.openRevision(teamId, autoId, revisionId);
        if (revision === null) return null;
        const files: RevisionFiles = { content: revision.content };
        if (revision.robot !== undefined) files.robot = revision.robot;
        if (revision.field !== undefined) files.field = revision.field;
        if (revision.waypoints !== undefined) files.waypoints = revision.waypoints;
        return files;
      }),
  };
}
